import { hydrateSettings, saveSettings, defaultSettings, VOICE_OPTIONS } from "./narrators.js";
import { respondStream } from "./llm.js";
import { createSTT } from "./stt.js";
import { initTTS, synthesize, playBlob, cancelPlayback, AudioQueue } from "./tts.js";
import { dbg, initDebugPanel } from "./debug.js";

// ─── State ───────────────────────────────────────────────────────────────────

let settings = hydrateSettings();

// Per-pedal state: "idle" | "listening" | "thinking" | "speaking"
const pedalState = [null, null, null, null];
let activeIndex = null;
let activeStt   = null;
let activeQueue = null; // AudioQueue for the current pedal

// ─── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  renderPedals();
  renderSettings();
  setPedalsEnabled(false);

  dbg(`crossOriginIsolated: ${window.crossOriginIsolated}`);
  if (!window.crossOriginIsolated) {
    dbg("WARNING: SharedArrayBuffer unavailable — TTS will be single-threaded");
  }

  dbg("boot: starting TTS init");
  try {
    await initTTS(onTTSProgress);
    hideLoader();
    setPedalsEnabled(true);
    dbg("boot: ready");
  } catch (err) {
    dbg(`boot: TTS init failed — ${err.message}`);
    showLoaderError(`Failed to load voice engine: ${err.message}`);
  }
}

function onTTSProgress(progress) {
  const loaderText = document.getElementById("loader-text");
  if (!loaderText) return;
  if (progress.status === "progress") {
    loaderText.textContent = `Loading voice engine… ${progress.pct}%`;
  } else if (progress.status === "done") {
    loaderText.textContent = "Warming up voices…";
  }
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
    if (activeStt) activeStt.stop();
    return; // STT onEnd drives the transition to thinking
  }

  if (state === "idle") {
    if (!settings.apiKey) {
      flashError(index, "Set your Anthropic API key in ⚙️ settings first.");
      return;
    }
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
      showTypeInstead(index);
    },
    onEnd: () => {
      if (pedalState[index] === "listening") {
        activeStt = null;
        showTypeInstead(index);
      }
    }
  });

  if (activeStt) {
    try {
      activeStt.start();
    } catch (err) {
      dbg(`STT start failed: ${err.message}`);
      activeStt = null;
      showTypeInstead(index);
    }
  }
}

// ─── Narrator run — streaming LLM + sentence-by-sentence TTS ─────────────────

// Flush the audio queue when a sentence boundary is detected in the accumulated buffer.
function flushSentences(buf, queue, isFinal) {
  while (true) {
    // Require at least 8 chars before a sentence-ending punctuation + optional quote/paren
    const m = buf.match(/^(.{8,}?[.!?]['")\]]?)(\s+|$)/s);
    if (!m) break;
    const sentence = m[1].trim();
    dbg(`sentence: "${sentence.slice(0, 60)}"`);
    queue.push(sentence);
    buf = buf.slice(m[0].length);
  }
  // On final flush, push whatever remains
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
        dbg(`pedal ${index}: first LLM token received — switching to speaking`);
        setPedalState(index, "speaking");
      }

      buf = flushSentences(buf, queue, false);
    }

    // Flush any trailing text
    if (!queue.aborted && activeIndex === index) {
      flushSentences(buf, queue, true);
    }

    await queue.drain();

  } catch (err) {
    dbg(`pedal ${index}: error — ${err.message}`);
    flashError(index, err.message);
  }

  if (activeIndex === index) {
    activeQueue = null;
    setPedalState(index, "idle");
    setOtherPedalsDisabled(index, false);
    activeIndex = null;
    dbg(`pedal ${index}: back to idle`);
  }
}

// ─── Type-instead fallback ────────────────────────────────────────────────────

function showTypeInstead(index) {
  if (pedalState[index] !== "listening") return;
  setPedalState(index, "idle");

  const overlay = document.getElementById("type-instead-overlay");
  const input   = document.getElementById("type-instead-input");
  const form    = document.getElementById("type-instead-form");

  overlay.classList.remove("hidden");
  input.value = "";
  input.focus();

  const submit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    overlay.classList.add("hidden");
    form.removeEventListener("submit", submit);
    if (text) {
      runNarrator(index, text);
    } else {
      setPedalState(index, "idle");
      setOtherPedalsDisabled(index, false);
      activeIndex = null;
    }
  };

  form.addEventListener("submit", submit);

  document.getElementById("type-instead-cancel").onclick = () => {
    overlay.classList.add("hidden");
    form.removeEventListener("submit", submit);
    setPedalState(index, "idle");
    setOtherPedalsDisabled(index, false);
    activeIndex = null;
  };
}

// ─── Settings panel ──────────────────────────────────────────────────────────

function renderSettings() {
  document.getElementById("settings-apikey").value = settings.apiKey;
  document.getElementById("settings-model").value = settings.model;
  document.getElementById("settings-max-tokens").value = settings.maxTokens;
  document.getElementById("settings-temperature").value = settings.temperature;
  document.getElementById("settings-temperature-display").textContent = settings.temperature;

  settings.narrators.forEach((narrator, i) => {
    document.getElementById(`narrator-${i}-name`).value = narrator.name;
    document.getElementById(`narrator-${i}-prompt`).value = narrator.systemPrompt;
    document.getElementById(`narrator-${i}-voice`).value = narrator.voice;
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
    apiKey: document.getElementById("settings-apikey").value.trim(),
    model: document.getElementById("settings-model").value,
    maxTokens: parseInt(document.getElementById("settings-max-tokens").value, 10),
    temperature: parseFloat(document.getElementById("settings-temperature").value),
    narrators: settings.narrators.map((_, i) => ({
      id: i + 1,
      name: document.getElementById(`narrator-${i}-name`).value.trim() || `Narrator ${i + 1}`,
      voice: document.getElementById(`narrator-${i}-voice`).value,
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
    renderPedals();
    document.getElementById("settings-overlay").classList.add("hidden");
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

  document.getElementById("settings-apikey-toggle").addEventListener("click", () => {
    const input = document.getElementById("settings-apikey");
    input.type = input.type === "password" ? "text" : "password";
  });

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

function showLoaderError(msg) {
  const el = document.getElementById("loader-text");
  if (el) { el.textContent = msg; el.classList.add("error"); }
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

function flashError(index, message) {
  const btn = document.getElementById(`pedal-${index}`);
  if (!btn) return;
  btn.classList.add("error-flash");
  setTimeout(() => btn.classList.remove("error-flash"), 1500);
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
  boot();
});
