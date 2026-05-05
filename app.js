import { hydrateSettings, saveSettings, defaultSettings, VOICE_OPTIONS } from "./narrators.js";
import { respond } from "./llm.js";
import { createSTT } from "./stt.js";
import { initTTS, synthesize, playBlob, cancelPlayback } from "./tts.js";
import { dbg, initDebugPanel } from "./debug.js";

// ─── State ───────────────────────────────────────────────────────────────────

let settings = hydrateSettings();

// Per-pedal state: "idle" | "listening" | "thinking" | "speaking"
const pedalState = [null, null, null, null];
let activeIndex = null;   // index of the currently active pedal (0-based)
let activeStt = null;     // current STT handle

// ─── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  renderPedals();
  renderSettings();
  setPedalsEnabled(false);
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
  // progress = { status, name, file, progress (0-1), loaded, total }
  if (progress.status === "progress") {
    const pct = Math.round((progress.progress ?? 0) * 100);
    const loaderText = document.getElementById("loader-text");
    if (loaderText) loaderText.textContent = `Loading voice engine… ${pct}%`;
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
  document.querySelectorAll(".pedal").forEach(btn => {
    btn.disabled = !enabled;
  });
}

function setOtherPedalsDisabled(activeIdx, disabled) {
  document.querySelectorAll(".pedal").forEach(btn => {
    const i = parseInt(btn.dataset.index, 10);
    if (i !== activeIdx) btn.disabled = disabled;
  });
}

// ─── Pedal tap handler (state machine) ───────────────────────────────────────

async function handlePedalTap(index) {
  const state = pedalState[index];

  if (state === "speaking") {
    // Cancel playback → idle
    cancelPlayback();
    setPedalState(index, "idle");
    setOtherPedalsDisabled(index, false);
    activeIndex = null;
    return;
  }

  if (state === "thinking") {
    // Can't easily cancel an in-flight fetch + TTS, so just mark cancelled
    // and ignore the result when it arrives via the guard below
    cancelPlayback();
    setPedalState(index, "idle");
    setOtherPedalsDisabled(index, false);
    activeIndex = null;
    return;
  }

  if (state === "listening") {
    // User tapped to stop listening → move to thinking
    if (activeStt) activeStt.stop();
    return; // STT onEnd will drive the transition to "thinking"
  }

  if (state === "idle") {
    // Check API key first
    if (!settings.apiKey) {
      flashError(index, "Set your Anthropic API key in ⚙️ settings first.");
      return;
    }

    activeIndex = index;
    setOtherPedalsDisabled(index, true);
    setPedalState(index, "listening");

    // Try STT; fall back to text input if unavailable
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
      console.warn("STT error:", err.message);
      // Surface the type-instead fallback
      showTypeInstead(index);
    },
    onEnd: () => {
      // If no result fired yet (e.g. no-speech), show type-instead
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
      console.warn("STT start failed:", err.message);
      activeStt = null;
      showTypeInstead(index);
    }
  }
}

async function runNarrator(index, userText) {
  if (activeIndex !== index) return;

  setPedalState(index, "thinking");
  dbg(`pedal ${index}: thinking — "${userText.slice(0, 60)}"`);

  const narrator = settings.narrators[index];
  let responseText;

  try {
    responseText = await respond({
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt: narrator.systemPrompt,
      userText,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature
    });
    dbg(`pedal ${index}: LLM response — "${responseText.slice(0, 80)}"`);
  } catch (err) {
    dbg(`pedal ${index}: LLM error — ${err.message}`);
    flashError(index, err.message);
    setPedalState(index, "idle");
    setOtherPedalsDisabled(index, false);
    activeIndex = null;
    return;
  }

  if (activeIndex !== index) { dbg(`pedal ${index}: cancelled after LLM`); return; }

  setPedalState(index, "speaking");
  dbg(`pedal ${index}: speaking`);

  try {
    const blob = await synthesize(responseText, narrator.voice);
    if (activeIndex !== index) { dbg(`pedal ${index}: cancelled after synthesize`); return; }
    await playBlob(blob);
    dbg(`pedal ${index}: playback complete`);
  } catch (err) {
    dbg(`pedal ${index}: TTS/playback error — ${err.message}`);
    flashError(index, err.message);
  }

  if (activeIndex === index) {
    setPedalState(index, "idle");
    setOtherPedalsDisabled(index, false);
    activeIndex = null;
    dbg(`pedal ${index}: back to idle`);
  }
}

// ─── Type-instead fallback ────────────────────────────────────────────────────

function showTypeInstead(index) {
  if (pedalState[index] !== "listening") return;
  setPedalState(index, "idle"); // visually idle while text input is open

  const overlay = document.getElementById("type-instead-overlay");
  const input = document.getElementById("type-instead-input");
  const form = document.getElementById("type-instead-form");

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
    const voiceSelect = document.getElementById(`narrator-${i}-voice`);
    voiceSelect.value = narrator.voice;
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

  // Test voice buttons
  for (let i = 0; i < 4; i++) {
    document.getElementById(`narrator-${i}-test`).addEventListener("click", async () => {
      const name = document.getElementById(`narrator-${i}-name`).value.trim() || `Narrator ${i + 1}`;
      const voice = document.getElementById(`narrator-${i}-voice`).value;
      const btn = document.getElementById(`narrator-${i}-test`);
      btn.disabled = true;
      btn.textContent = "…";
      try {
        const blob = await synthesize(`Hello, I am ${name}.`, voice);
        await playBlob(blob);
      } catch (err) {
        console.error("Test voice error:", err);
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
  if (el) {
    el.textContent = msg;
    el.classList.add("error");
  }
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

function flashError(index, message) {
  const btn = document.getElementById(`pedal-${index}`);
  if (!btn) return;
  btn.classList.add("error-flash");
  setTimeout(() => btn.classList.remove("error-flash"), 1500);
  console.error(`Pedal ${index} error:`, message);
}

function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Entry point ──────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initDebugPanel();
  wireSettings();
  boot();
});
