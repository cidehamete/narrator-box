// Wraps kokoro-js for client-side TTS.
// The model (~80 MB quantized) is downloaded once and cached by the browser in IndexedDB.
import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
import { dbg } from "./debug.js";

let tts = null;
let currentAudio = null; // currently playing HTMLAudioElement

export async function initTTS(onProgress) {
  dbg("TTS: loading model…");
  tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
    dtype: "q8",    // q8 > q4 on ARM: dequant overhead of int4 outweighs the smaller weight size
    device: "wasm", // explicit wasm — WebGPU on iOS Safari is unreliable (OOM, silent fallback)
    progress_callback: (info) => {
      if (info?.status === "progress" && typeof info.progress === "number") {
        // progress arrives as 0–1 per chunk, not cumulative 0–100
        const pct = Math.min(100, Math.round(info.progress * 100));
        onProgress({ status: "progress", file: info.file ?? "", pct });
      } else {
        onProgress(info);
      }
    }
  });
  dbg("TTS: model loaded — warming up inference graph…");
  // Pay the JIT/graph-compile cost now, not during the first live tap.
  await tts.generate("Ready.", { voice: "af_bella" });
  dbg("TTS: warm-up done — ready");
  return tts;
}

// Clean text before synthesis: strip wrapping quotes/markdown that the LLM sometimes adds.
function cleanText(text) {
  return text
    .replace(/^["'`*_‘’“”]+|["'`*_‘’“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function synthesize(text, voice) {
  if (!tts) throw new Error("TTS not initialized");
  const cleaned = cleanText(text);
  dbg(`TTS: synthesize — voice=${voice} len=${cleaned.length}`);

  const TIMEOUT_MS = 30_000;
  const audio = await Promise.race([
    tts.generate(cleaned, { voice }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`tts.generate() timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
    )
  ]);

  dbg("TTS: generate done — converting to blob");
  const blob = await Promise.resolve(audio.toBlob());
  dbg(`TTS: blob ready — size=${blob.size} type=${blob.type}`);
  return blob;
}

// Play a blob. Must append to DOM — iOS Safari won't fire onended on detached elements.
export function playBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const el = document.createElement("audio");
    el.setAttribute("playsinline", "");
    el.style.display = "none";
    el.src = url;

    currentAudio = el;

    const cleanup = () => {
      URL.revokeObjectURL(url);
      el.remove();
      if (currentAudio === el) currentAudio = null;
    };

    el.oncanplaythrough = () => dbg("TTS: audio canplaythrough");
    el.onplay           = () => dbg("TTS: audio playing");
    el.onended          = () => { dbg("TTS: audio ended"); cleanup(); resolve(); };
    el.onerror          = () => {
      const code = el.error?.code;
      const msg  = el.error?.message ?? "unknown";
      dbg(`TTS: audio error code=${code} msg=${msg}`);
      cleanup();
      reject(new Error(`Audio error (code ${code}): ${msg}`));
    };

    document.body.appendChild(el);
    dbg("TTS: calling play()");
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

// Manages serial synthesis + sequential gapless playback for streaming responses.
// Synth runs serially (parallel ORT calls on the same WASM instance are slower).
// Playback is chained so chunks play back-to-back without overlap.
export class AudioQueue {
  constructor(voice) {
    this.voice = voice;
    this.aborted = false;
    this._synthChain = Promise.resolve();
    this._playChain  = Promise.resolve();
  }

  push(text) {
    // Chain synthesis serially
    const synthPromise = this._synthChain = this._synthChain.then(async () => {
      if (this.aborted) return null;
      try {
        return await synthesize(text, this.voice);
      } catch (err) {
        dbg(`AudioQueue: synth error — ${err.message}`);
        return null;
      }
    });

    // Chain playback after previous chunk finishes
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

  async drain() {
    await this._playChain;
  }

  abort() {
    this.aborted = true;
    cancelPlayback();
  }
}

export function isReady() {
  return tts !== null;
}
