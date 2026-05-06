import { hydrateSettings, saveSettings, defaultSettings, VOICE_OPTIONS } from "./narrators.js";
import { respondStream } from "./llm.js";
import { createSTT } from "./stt.js";
import { configureTTS, warmupTTS, isConfigured, unlockAudio, synthesize, playBlob, cancelPlayback, AudioQueue } from "./tts.js";
import { dbg, initDebugPanel } from "./debug.js";

// ─── State ───────────────────────────────────────────────────────────────────

let settings = hydrateSettings();

const pedalState = [null, null, null, null];
let activeIndex = null;
let activeStt   = null;
let activeQueue = null;

// ─── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  renderPedals();
  renderSettings();

  configureTTS({ endpointUrl: settings.ttsEndpoint, authToken: settings.ttsToken });

  if (!isConfigured()) {
    // No endpoint set — skip loader, show pedals, they'll error on tap with a clear message
    hideLoader();
    setPedalsEnabled(true);
    dbg("boot: no TTS endpoint configured — skipping warm-up");
    return;
  }

  // Warm up with a 60s timeout so a sleeping HF Space has time to wake
  setLoaderText("Waking voices…");
  setPedalsEnabled(false);
  dbg("boot: starting warm-up");

  const WARMUP_TIMEOUT_MS = 60_000;
  try {
    await Promise.race([
      warmupTTS(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("warm-up timed out after 60s")), WARMUP_TIMEOUT_MS)
      )
    ]);
    dbg("boot: warm-up done — ready");
    setWakeDot("green");
  } catch (err) {
    dbg(`boot: warm-up failed — ${err.message}`);
    setWakeDot("red");
    // Still enable pedals — user can retry with 🔥 Wake or just try a tap
  }

  hideLoader();
  setPedalsEnabled(true);
}

// ─── Wake button ─────────────────────────────────────────────────────────────

function wireWakeButton() {
  const btn = document.getElementById("wake-btn");
  btn.addEventListener("click", async () => {
    if (!isConfigured()) {
      dbg("wake: no endpoint configured");
      setWakeDot("red");
      return;
    }
    btn.disabled = true;
    setWakeDot("checking");
    dbg("wake: pinging /health…");
    try {
      await Promise.race([
        warmupTTS(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 60_000))
      ]);
      dbg("wake: server warm");
      setWakeDot("green");
    } catch (err) {
      dbg(`wake: failed — ${err.message}`);
      setWakeDot("red");
    } finally {
      btn.disabled = false;
    }
  });
}

function setWakeDot(state) {
  // state: "" | "checking" | "green" | "red"
  const dot = document.getElementById("wake-dot");
  if (dot) dot.dataset.state = state;
}

// ─── Pedal rendering ─────────────────────────────────────────────────────────

function renderPedals() {
  const grid = document.getElementById("pedal-grid");
  grid.innerHTML = "";
  settings.narrators.forEach((narrator, i) => {
    const btn = document.createElement("button");
    btn.className = "pedal";
    btn.id = `pedal-${i}`;
    btn.dataset.index = i;
    btn.innerHTML = `
      <span class="pedal-name">${escHtml(narrator.name)}</span>
      <span class="pedal-voice">${escHtml(narrator.voice)}</span>
      <span class="pedal-status-label">idle</span>
      <span class="pedal-indicator"></span>
    `;
    btn.addEventListener("click", () => handlePedalTap(i));
    grid.appendChild(btn);
    setPedalState(i, "idle");
  });
}

function setPedalState(index, state) {
  pedalState[index] = state;
  const btn = document.getElementById(`pedal-${index}`);
  if (!btn) return;
  btn.dataset.state = state;
  btn.querySelector(".pedal-status-label").textContent = state;
}

function setPedalsEnabled(enabled) {
  document.querySelectorAll(".pedal").forEach(btn => { btn.disabled = !enabled; });
}

function setOtherPedalsDisabled(activeIdx, disabled) {
  document.querySelectorAll(".pedal").forEach(btn => {
    if (parseInt(btn.dataset.index, 10) !== activeIdx) btn.disabled = disabled;
  });
}

// ─── Pedal tap handler (state machine) ───────────────────────────────────────

async function handlePedalTap(index) {
  const state = pedalState[index];

  if (state === "speaking" || state === "thinking") {
    activeQueue?.abort();
    activeQueue = null;
    setPedalState(index, "idle");
    setOtherPedalsDisabled(index, false);
    activeIndex = null;
    dbg(`pedal ${index}: cancelled by tap`);
    return;
  }

  if (state === "listening") {
    // Show thinking immediately so the user sees a response to their tap.
    // iOS sometimes fires onEnd without onResult after stop() — handle both.
    setPedalState(index, "thinking");
    if (activeStt) activeStt.stop();
    return;
  }

  if (state === "idle") {
    if (!settings.apiKey) {
      flashError(index, "Set your Anthropic API key in ⚙️ settings.");
      return;
    }
    if (!isConfigured()) {
      flashError(index, "Set your TTS endpoint + token in ⚙️ settings.");
      return;
    }
    // Unlock audio synchronously inside the tap gesture before any async work.
    // iOS Safari blocks play() calls that arrive after the gesture stack unwinds.
    unlockAudio();
    activeIndex = index;
    setOtherPedalsDisabled(index, true);
    setPedalState(index, "listening");
    startListening(index);
  }
}

function startListening(index) {
  activeStt = createSTT({
    onResult: (transcript) => {
      activeStt = null;
      runNarrator(index, transcript);
    },
    onError: (err) => {
      activeStt = null;
      dbg(`STT error: ${err.message}`);
      if (pedalState[index] === "listening" || pedalState[index] === "thinking") {
        resetPedal(index);
      }
    },
    onEnd: () => {
      activeStt = null;
      if (pedalState[index] === "listening" || pedalState[index] === "thinking") {
        resetPedal(index);
      }
    }
  });

  if (activeStt) {
    try {
      activeStt.start();
    } catch (err) {
      dbg(`STT start failed: ${err.message}`);
      activeStt = null;
      resetPedal(index);
    }
  }
}

// ─── Narrator run — streaming LLM + sentence-by-sentence TTS ─────────────────

function flushSentences(buf, queue, isFinal) {
  while (true) {
    const m = buf.match(/^(.{8,}?[.!?]['")\]]?)(\s+|$)/s);
    if (!m) break;
    const sentence = m[1].trim();
    dbg(`sentence: "${sentence.slice(0, 60)}"`);
    queue.push(sentence);
    buf = buf.slice(m[0].length);
  }
  if (isFinal && buf.trim()) {
    dbg(`sentence (final): "${buf.trim().slice(0, 60)}"`);
    queue.push(buf.trim());
    buf = "";
  }
  return buf;
}

async function runNarrator(index, userText) {
  if (activeIndex !== index) return;

  setPedalState(index, "thinking");
  dbg(`pedal ${index}: thinking — "${userText.slice(0, 60)}"`);

  const narrator = settings.narrators[index];
  const queue = new AudioQueue(narrator.voice);
  activeQueue = queue;

  let buf = "";
  let firstChunk = true;

  try {
    for await (const chunk of respondStream({
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt: narrator.systemPrompt,
      userText,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature
    })) {
      if (queue.aborted || activeIndex !== index) break;
      buf += chunk;
      if (firstChunk) {
        firstChunk = false;
        dbg(`pedal ${index}: first token — switching to speaking`);
        setPedalState(index, "speaking");
      }
      buf = flushSentences(buf, queue, false);
    }

    if (!queue.aborted && activeIndex === index) {
      flushSentences(buf, queue, true);
    }

    await queue.drain();

  } catch (err) {
    dbg(`pedal ${index}: error — ${err.message}`);
    flashError(index, err.message);
    setWakeDot("red");
  }

  if (activeIndex === index) {
    activeQueue = null;
    setPedalState(index, "idle");
    setOtherPedalsDisabled(index, false);
    activeIndex = null;
    dbg(`pedal ${index}: back to idle`);
  }
}

function resetPedal(index) {
  setPedalState(index, "idle");
  setOtherPedalsDisabled(index, false);
  activeIndex = null;
}

// ─── Settings panel ──────────────────────────────────────────────────────────

function renderSettings() {
  document.getElementById("settings-tts-endpoint").value = settings.ttsEndpoint ?? "";
  document.getElementById("settings-tts-token").value    = settings.ttsToken ?? "";
  document.getElementById("settings-apikey").value       = settings.apiKey;
  document.getElementById("settings-model").value        = settings.model;
  document.getElementById("settings-max-tokens").value   = settings.maxTokens;
  document.getElementById("settings-temperature").value  = settings.temperature;
  document.getElementById("settings-temperature-display").textContent = settings.temperature;

  settings.narrators.forEach((narrator, i) => {
    document.getElementById(`narrator-${i}-name`).value  = narrator.name;
    document.getElementById(`narrator-${i}-prompt`).value = narrator.systemPrompt;
    document.getElementById(`narrator-${i}-voice`).value  = narrator.voice;
  });
}

function buildSettingsVoiceDropdowns() {
  for (let i = 0; i < 4; i++) {
    const sel = document.getElementById(`narrator-${i}-voice`);
    sel.innerHTML = VOICE_OPTIONS.map(v =>
      `<option value="${v.value}">${escHtml(v.label)}</option>`
    ).join("");
  }
}

function collectSettings() {
  return {
    ttsEndpoint: document.getElementById("settings-tts-endpoint").value.trim(),
    ttsToken:    document.getElementById("settings-tts-token").value.trim(),
    apiKey:      document.getElementById("settings-apikey").value.trim(),
    model:       document.getElementById("settings-model").value,
    maxTokens:   parseInt(document.getElementById("settings-max-tokens").value, 10),
    temperature: parseFloat(document.getElementById("settings-temperature").value),
    narrators:   settings.narrators.map((_, i) => ({
      id: i + 1,
      name:         document.getElementById(`narrator-${i}-name`).value.trim() || `Narrator ${i + 1}`,
      voice:        document.getElementById(`narrator-${i}-voice`).value,
      systemPrompt: document.getElementById(`narrator-${i}-prompt`).value.trim()
    }))
  };
}

function wireSettings() {
  buildSettingsVoiceDropdowns();

  document.getElementById("settings-btn").addEventListener("click", () => {
    document.getElementById("settings-overlay").classList.remove("hidden");
  });

  document.getElementById("settings-close").addEventListener("click", () => {
    settings = collectSettings();
    saveSettings(settings);
    configureTTS({ endpointUrl: settings.ttsEndpoint, authToken: settings.ttsToken });
    renderPedals();
    document.getElementById("settings-overlay").classList.add("hidden");
    setWakeDot("");  // reset dot so user knows to re-test after changing endpoint
  });

  document.getElementById("settings-reset").addEventListener("click", () => {
    if (!confirm("Reset all settings to defaults?")) return;
    settings = defaultSettings();
    saveSettings(settings);
    renderSettings();
    renderPedals();
  });

  document.getElementById("settings-temperature").addEventListener("input", (e) => {
    document.getElementById("settings-temperature-display").textContent =
      parseFloat(e.target.value).toFixed(1);
  });

  const makeToggle = (inputId, btnId) => {
    document.getElementById(btnId).addEventListener("click", () => {
      const input = document.getElementById(inputId);
      input.type = input.type === "password" ? "text" : "password";
    });
  };
  makeToggle("settings-apikey",   "settings-apikey-toggle");
  makeToggle("settings-tts-token", "settings-tts-token-toggle");

  for (let i = 0; i < 4; i++) {
    document.getElementById(`narrator-${i}-test`).addEventListener("click", async () => {
      const name  = document.getElementById(`narrator-${i}-name`).value.trim() || `Narrator ${i + 1}`;
      const voice = document.getElementById(`narrator-${i}-voice`).value;
      const btn   = document.getElementById(`narrator-${i}-test`);
      btn.disabled = true;
      btn.textContent = "…";
      try {
        const blob = await synthesize(`Hello, I am ${name}.`, voice);
        await playBlob(blob);
      } catch (err) {
        dbg(`test voice error: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = "Test";
      }
    });
  }
}

// ─── Loader helpers ───────────────────────────────────────────────────────────

function hideLoader() {
  document.getElementById("loader").classList.add("hidden");
}

function setLoaderText(text) {
  const el = document.getElementById("loader-text");
  if (el) el.textContent = text;
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

function flashError(index, message) {
  const btn = document.getElementById(`pedal-${index}`);
  if (!btn) return;
  btn.classList.add("error-flash");
  setTimeout(() => btn.classList.remove("error-flash"), 1500);
  dbg(`pedal ${index} error: ${message}`);
}

function escHtml(str) {
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Entry point ──────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initDebugPanel();
  wireSettings();
  wireWakeButton();
  boot();
});
