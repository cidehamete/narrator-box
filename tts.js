// Server-backed Kokoro TTS client.
// Sends text to a hosted /synthesize endpoint; returns audio/wav blobs.
// AudioQueue and playBlob are unchanged from the streaming-perf pass.
import { dbg } from "./debug.js";

let endpoint    = null;
let token       = null;
let audioCtx    = null;  // Web Audio API context — once created in a gesture it stays unlocked
let currentNode = null;  // currently playing AudioBufferSourceNode

// Create (or resume) an AudioContext during the tap gesture.
// Unlike HTMLAudioElement.play(), a running AudioContext stays unlocked for the whole session —
// subsequent playback calls work even seconds later without needing another gesture.
export function unlockAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    dbg("TTS: AudioContext created");
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().then(() => dbg("TTS: AudioContext resumed"));
  }
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

// Decode a WAV blob and play it through the Web Audio API.
// AudioContext stays unlocked for the full session after unlockAudio() is called once.
export async function playBlob(blob) {
  if (!audioCtx) throw new Error("AudioContext not initialised — call unlockAudio() first");

  const arrayBuf = await blob.arrayBuffer();
  const decoded  = await audioCtx.decodeAudioData(arrayBuf);

  return new Promise((resolve, reject) => {
    const source = audioCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(audioCtx.destination);
    currentNode = source;

    source.onended = () => {
      dbg("TTS: audio ended");
      if (currentNode === source) currentNode = null;
      resolve();
    };

    dbg("TTS: audio playing");
    source.start(0);
  });
}

export function cancelPlayback() {
  if (currentNode) {
    try { currentNode.stop(); } catch {}
    currentNode = null;
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
