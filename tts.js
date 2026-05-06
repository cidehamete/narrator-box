// Server-backed Kokoro TTS client.
// Sends text to a hosted /synthesize endpoint; returns audio/wav blobs.
// AudioQueue and playBlob are unchanged from the streaming-perf pass.
import { dbg } from "./debug.js";

let endpoint = null;
let token    = null;
let currentAudio = null;
let audioUnlocked = false;

// iOS Safari blocks async play() calls that aren't in a user-gesture call stack.
// Fix: call this synchronously inside the tap handler to unlock audio for the session.
export function unlockAudio() {
  if (audioUnlocked) return;
  // Smallest valid WAV: 44-byte header + 0 samples
  const wav = new Uint8Array([
    0x52,0x49,0x46,0x46, 0x24,0x00,0x00,0x00, 0x57,0x41,0x56,0x45,
    0x66,0x6d,0x74,0x20, 0x10,0x00,0x00,0x00, 0x01,0x00,0x01,0x00,
    0x44,0xac,0x00,0x00, 0x88,0x58,0x01,0x00, 0x02,0x00,0x10,0x00,
    0x64,0x61,0x74,0x61, 0x00,0x00,0x00,0x00
  ]);
  const blob = new Blob([wav], { type: "audio/wav" });
  const url  = URL.createObjectURL(blob);
  const el   = document.createElement("audio");
  el.setAttribute("playsinline", "");
  el.src = url;
  document.body.appendChild(el);
  el.play()
    .then(() => { audioUnlocked = true; dbg("TTS: audio unlocked"); })
    .catch(() => {})
    .finally(() => { URL.revokeObjectURL(url); el.remove(); });
}

export function configureTTS({ endpointUrl, authToken }) {
  endpoint = endpointUrl?.trim().replace(/\/$/, "") || null;
  token    = authToken?.trim() || null;
  dbg(`TTS: configured endpoint=${endpoint ?? "(none)"}`);
}

export function isConfigured() {
  return !!(endpoint && token);
}

// Hits /health, then does a throwaway synth to warm the model graph.
export async function warmupTTS() {
  if (!endpoint) throw new Error("TTS endpoint not configured");

  dbg("TTS: warmup — pinging /health");
  const healthRes = await fetch(`${endpoint}/health`);
  if (!healthRes.ok) throw new Error(`/health returned ${healthRes.status}`);
  dbg("TTS: /health OK — warming model graph");

  try {
    await synthesize("Ready.", "af_bella");
    dbg("TTS: warm-up synth done");
  } catch (err) {
    dbg(`TTS: warm-up synth failed (non-fatal) — ${err.message}`);
  }

  return true;
}

export async function synthesize(text, voice, speed = 1.0) {
  if (!endpoint) throw new Error("TTS endpoint not configured");
  dbg(`TTS: synthesize — voice=${voice} len=${text.length}`);

  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Auth-Token"] = token;  // HF proxy strips Authorization; use X-Auth-Token

  const res = await fetch(`${endpoint}/synthesize`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, voice, speed })
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`TTS ${res.status}: ${msg.slice(0, 200)}`);
  }

  const blob = await res.blob();
  dbg(`TTS: blob received — size=${blob.size} type=${blob.type}`);
  return blob;
}

// Play a blob. Must append to DOM — iOS Safari won't fire onended on detached elements.
export function playBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const el  = document.createElement("audio");
    el.setAttribute("playsinline", "");
    el.style.display = "none";
    el.src = url;

    currentAudio = el;

    const cleanup = () => {
      URL.revokeObjectURL(url);
      el.remove();
      if (currentAudio === el) currentAudio = null;
    };

    el.onplay   = () => dbg("TTS: audio playing");
    el.onended  = () => { dbg("TTS: audio ended"); cleanup(); resolve(); };
    el.onerror  = () => {
      const code = el.error?.code;
      const msg  = el.error?.message ?? "unknown";
      dbg(`TTS: audio error code=${code} msg=${msg}`);
      cleanup();
      reject(new Error(`Audio error (code ${code}): ${msg}`));
    };

    document.body.appendChild(el);
    el.play()
      .then(() => dbg("TTS: play() resolved"))
      .catch((err) => { dbg(`TTS: play() rejected — ${err.message}`); cleanup(); reject(err); });
  });
}

export function cancelPlayback() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.remove();
    currentAudio = null;
    dbg("TTS: playback cancelled");
  }
}

// Serial synthesis + sequential gapless playback for sentence-streamed responses.
// Parallel ORT calls on the same server are fine, but we keep serial to avoid
// out-of-order playback.
export class AudioQueue {
  constructor(voice) {
    this.voice      = voice;
    this.aborted    = false;
    this._synthChain = Promise.resolve();
    this._playChain  = Promise.resolve();
  }

  push(text) {
    const synthPromise = this._synthChain = this._synthChain.then(async () => {
      if (this.aborted) return null;
      try {
        return await synthesize(text, this.voice);
      } catch (err) {
        dbg(`AudioQueue: synth error — ${err.message}`);
        return null;
      }
    });

    this._playChain = this._playChain.then(async () => {
      const blob = await synthPromise;
      if (this.aborted || !blob) return;
      try {
        await playBlob(blob);
      } catch (err) {
        dbg(`AudioQueue: playback error — ${err.message}`);
      }
    });
  }

  async drain() { await this._playChain; }

  abort() {
    this.aborted = true;
    cancelPlayback();
  }
}
