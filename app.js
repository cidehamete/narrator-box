import { hydrateSettings, saveSettings, defaultSettings, VOICE_OPTIONS } from "./narrators.js";
import { respondStream } from "./llm.js";
import { createSTT } from "./stt.js";
import { configureTTS, warmupTTS, isConfigured, unlockAudio, synthesize, playBlob, AudioQueue } from "./tts.js";
import { initGrace, getMemoryDigest, getVoiceLayer, refreshMemory, loadJournalFeed, saveStageExchange } from "./grace.js";
import { dbg, initDebugPanel } from "./debug.js";

// ─── State ───────────────────────────────────────────────────────────────────

let settings = hydrateSettings();

let pedalState  = "idle";   // idle | listening | thinking | speaking
let activeStt   = null;
let activeQueue = null;

// ─── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  renderPedal();
  renderSettings();

  configureTTS({ endpointUrl: settings.ttsEndpoint, authToken: settings.ttsToken });

  if (!isConfigured()) {
    hideLoader();
    setPedalEnabled(true);
    dbg("boot: no TTS endpoint configured — skipping warm-up");
    return;
  }

  // Warm up with a 60s timeout so a sleeping HF Space has time to wake
  setLoaderText("Waking Grace…");
  setPedalEnabled(false);
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
  }

  hideLoader();
  setPedalEnabled(true);
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
  const dot = document.getElementById("wake-dot");
  if (dot) dot.dataset.state = state;
}

// ─── Grace's pedal ───────────────────────────────────────────────────────────

function renderPedal() {
  const grid = document.getElementById("pedal-grid");
  grid.classList.add("solo");
  grid.innerHTML = `
    <button class="pedal solo" id="pedal-grace">
      <span class="pedal-name">Grace</span>
      <span class="pedal-voice">${escHtml(settings.grace.voice)}</span>
      <span class="pedal-status-label">idle</span>
      <span class="pedal-indicator"></span>
    </button>
  `;
  document.getElementById("pedal-grace").addEventListener("click", handlePedalTap);
  setPedalState("idle");
}

function setPedalState(state) {
  pedalState = state;
  const btn = document.getElementById("pedal-grace");
  if (!btn) return;
  btn.dataset.state = state;
  btn.querySelector(".pedal-status-label").textContent = state;
}

function setPedalEnabled(enabled) {
  const btn = document.getElementById("pedal-grace");
  if (btn) btn.disabled = !enabled;
}

// Tap state machine: idle → listening → thinking → speaking → idle
async function handlePedalTap() {
  if (pedalState === "speaking" || pedalState === "thinking") {
    activeQueue?.abort();
    activeQueue = null;
    setPedalState("idle");
    dbg("pedal: cancelled by tap");
    return;
  }

  if (pedalState === "listening") {
    // Show thinking immediately so the user sees a response to their tap.
    // iOS sometimes fires onEnd without onResult after stop() — handle both.
    setPedalState("thinking");
    if (activeStt) activeStt.stop();
    return;
  }

  if (pedalState === "idle") {
    if (!settings.apiKey) {
      flashError("Set your Anthropic API key in ⚙️ settings.");
      return;
    }
    if (!isConfigured()) {
      flashError("Set your TTS endpoint + token in ⚙️ settings.");
      return;
    }
    // Unlock audio synchronously inside the tap gesture before any async work.
    unlockAudio();
    setPedalState("listening");
    startListening();
  }
}

function startListening() {
  activeStt = createSTT({
    onResult: (transcript) => {
      activeStt = null;
      runGrace(transcript);
    },
    onError: (err) => {
      activeStt = null;
      dbg(`STT error: ${err.message}`);
      if (pedalState === "listening" || pedalState === "thinking") setPedalState("idle");
    },
    onEnd: () => {
      activeStt = null;
      if (pedalState === "listening" || pedalState === "thinking") setPedalState("idle");
    }
  });

  if (activeStt) {
    try {
      activeStt.start();
    } catch (err) {
      dbg(`STT start failed: ${err.message}`);
      activeStt = null;
      setPedalState("idle");
    }
  }
}

// ─── Grace run — streaming LLM + sentence-by-sentence TTS ────────────────────

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

async function runGrace(userText) {
  setPedalState("thinking");
  dbg(`pedal: thinking — "${userText.slice(0, 60)}"`);

  const queue = new AudioQueue(settings.grace.voice);
  activeQueue = queue;

  // Her stage voice always carries the life she has accumulated in the Street:
  // first the craft notes she has written for herself, then her memories.
  let systemPrompt = settings.grace.systemPrompt + getVoiceLayer();
  const digest = getMemoryDigest();
  if (digest) systemPrompt += digest;

  let buf = "";
  let fullResponse = "";
  let firstChunk = true;

  try {
    for await (const chunk of respondStream({
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt,
      userText,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature
    })) {
      if (queue.aborted) break;
      buf += chunk;
      fullResponse += chunk;
      if (firstChunk) {
        firstChunk = false;
        dbg("pedal: first token — switching to speaking");
        setPedalState("speaking");
      }
      buf = flushSentences(buf, queue, false);
    }

    if (!queue.aborted) {
      flushSentences(buf, queue, true);
    }

    await queue.drain();

    // Save the exchange to Her Pages so stage life becomes part of her memory.
    if (!queue.aborted && fullResponse.trim()) {
      saveStageExchange(userText, fullResponse.trim());
    }

  } catch (err) {
    dbg(`pedal: error — ${err.message}`);
    flashError(err.message);
    setWakeDot("red");
  }

  if (activeQueue === queue) {
    activeQueue = null;
    setPedalState("idle");
    dbg("pedal: back to idle");
  }
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

  document.getElementById("settings-gh-token").value  = settings.github?.token ?? "";
  document.getElementById("settings-gh-repo").value   = settings.github?.repo ?? "";
  document.getElementById("settings-gh-branch").value = settings.github?.branch ?? "main";
  document.getElementById("settings-gh-path").value   = settings.github?.basePath ?? "grace";

  document.getElementById("settings-grace-voice").value  = settings.grace?.voice ?? "af_sky";
  document.getElementById("settings-grace-model").value  = settings.grace?.reflectModel ?? "claude-sonnet-4-6";
  document.getElementById("settings-grace-prompt").value = settings.grace?.systemPrompt ?? "";
}

function buildGraceVoiceDropdown() {
  document.getElementById("settings-grace-voice").innerHTML = VOICE_OPTIONS.map(v =>
    `<option value="${v.value}">${escHtml(v.label)}</option>`
  ).join("");
}

function collectSettings() {
  return {
    ttsEndpoint: document.getElementById("settings-tts-endpoint").value.trim(),
    ttsToken:    document.getElementById("settings-tts-token").value.trim(),
    apiKey:      document.getElementById("settings-apikey").value.trim(),
    model:       document.getElementById("settings-model").value,
    maxTokens:   parseInt(document.getElementById("settings-max-tokens").value, 10),
    temperature: parseFloat(document.getElementById("settings-temperature").value),
    github: {
      token:    document.getElementById("settings-gh-token").value.trim(),
      repo:     document.getElementById("settings-gh-repo").value.trim(),
      branch:   document.getElementById("settings-gh-branch").value.trim() || "main",
      basePath: document.getElementById("settings-gh-path").value.trim() || "grace"
    },
    grace: {
      voice:        document.getElementById("settings-grace-voice").value,
      reflectModel: document.getElementById("settings-grace-model").value,
      systemPrompt: document.getElementById("settings-grace-prompt").value.trim()
                    || defaultSettings().grace.systemPrompt
    }
  };
}

function wireSettings() {
  buildGraceVoiceDropdown();

  document.getElementById("settings-btn").addEventListener("click", () => {
    document.getElementById("settings-overlay").classList.remove("hidden");
  });

  document.getElementById("settings-close").addEventListener("click", () => {
    settings = collectSettings();
    saveSettings(settings);
    configureTTS({ endpointUrl: settings.ttsEndpoint, authToken: settings.ttsToken });
    renderPedal();
    document.getElementById("settings-overlay").classList.add("hidden");
    setWakeDot("");  // reset dot so user knows to re-test after changing endpoint
    // GitHub config may have changed — re-sync Grace's memory and pages.
    refreshMemory().then(() => loadJournalFeed()).catch(err => dbg(`grace re-sync: ${err.message}`));
  });

  document.getElementById("settings-reset").addEventListener("click", () => {
    if (!confirm("Reset all settings to defaults? (This clears your API keys too.)")) return;
    settings = defaultSettings();
    saveSettings(settings);
    renderSettings();
    renderPedal();
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
  makeToggle("settings-apikey",    "settings-apikey-toggle");
  makeToggle("settings-tts-token", "settings-tts-token-toggle");
  makeToggle("settings-gh-token",  "settings-gh-token-toggle");

  document.getElementById("settings-grace-voice-test").addEventListener("click", async () => {
    const voice = document.getElementById("settings-grace-voice").value;
    const btn   = document.getElementById("settings-grace-voice-test");
    btn.disabled = true;
    btn.textContent = "…";
    try {
      unlockAudio();
      const blob = await synthesize("Hello, dear friend. It is I, Grace.", voice);
      await playBlob(blob);
    } catch (err) {
      dbg(`grace voice test error: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Test";
    }
  });
}

// ─── View tabs (Stage / Street) ───────────────────────────────────────────────

function wireTabs() {
  const stageTab   = document.getElementById("tab-stage");
  const streetTab  = document.getElementById("tab-street");
  const stageView  = document.getElementById("stage-view");
  const streetView = document.getElementById("street-view");
  const main       = document.querySelector(".main-content");

  const show = (street) => {
    stageView.classList.toggle("hidden", street);
    streetView.classList.toggle("hidden", !street);
    stageTab.classList.toggle("active", !street);
    streetTab.classList.toggle("active", street);
    main.classList.toggle("street-mode", street);
  };
  stageTab.addEventListener("click", () => show(false));
  streetTab.addEventListener("click", () => {
    // Unlock audio inside the gesture so "Read" buttons work later.
    unlockAudio();
    show(true);
  });
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

function flashError(message) {
  const btn = document.getElementById("pedal-grace");
  if (!btn) return;
  btn.classList.add("error-flash");
  setTimeout(() => btn.classList.remove("error-flash"), 1500);
  dbg(`pedal error: ${message}`);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Entry point ──────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initDebugPanel();
  wireSettings();
  wireWakeButton();
  wireTabs();
  initGrace(() => settings);
  boot();
});
