// Wraps kokoro-js for client-side TTS.
// The model (~80 MB quantized) is downloaded once and cached by the browser in IndexedDB.
import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
import { dbg } from "./debug.js";

let tts = null;
let audioEl = null;

export async function initTTS(onProgress) {
  dbg("TTS: loading model…");
  tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
    dtype: "q8",
    device: "webgpu",
    progress_callback: (p) => {
      if (p.status === "progress") {
        dbg(`TTS: download ${Math.round((p.progress ?? 0) * 100)}% — ${p.file ?? ""}`);
      } else {
        dbg(`TTS: ${p.status} ${p.file ?? ""}`);
      }
      onProgress(p);
    }
  });
  dbg("TTS: model ready");
  return tts;
}

export async function synthesize(text, voice) {
  if (!tts) throw new Error("TTS not initialized");
  dbg(`TTS: synthesize start — voice=${voice} len=${text.length}`);
  const audio = await tts.generate(text, { voice });
  dbg(`TTS: generate done — converting to blob`);
  const blob = await Promise.resolve(audio.toBlob());
  dbg(`TTS: blob ready — size=${blob.size} type=${blob.type}`);
  return blob;
}

// Play a blob through a shared <audio> element with playsInline for iOS.
// The element must be appended to the DOM — iOS Safari won't fire onended otherwise.
export function playBlob(blob) {
  return new Promise((resolve, reject) => {
    if (audioEl) {
      dbg("TTS: cancelling previous audio element");
      audioEl.pause();
      URL.revokeObjectURL(audioEl.src);
      audioEl.remove();
    }

    dbg(`TTS: creating audio element — blob size=${blob.size}`);
    audioEl = document.createElement("audio");
    audioEl.setAttribute("playsinline", "");
    audioEl.style.display = "none";
    audioEl.src = URL.createObjectURL(blob);

    const cleanup = () => {
      URL.revokeObjectURL(audioEl?.src);
      audioEl?.remove();
      audioEl = null;
    };

    audioEl.oncanplaythrough = () => dbg("TTS: audio canplaythrough");
    audioEl.onplay           = () => dbg("TTS: audio playing");
    audioEl.onended          = () => { dbg("TTS: audio ended"); cleanup(); resolve(); };
    audioEl.onerror          = (e) => {
      const code = audioEl?.error?.code;
      const msg  = audioEl?.error?.message ?? "unknown";
      dbg(`TTS: audio error — code=${code} msg=${msg}`);
      cleanup();
      reject(new Error(`Audio playback error (code ${code}): ${msg}`));
    };

    document.body.appendChild(audioEl);
    dbg("TTS: calling play()");
    audioEl.play()
      .then(() => dbg("TTS: play() promise resolved"))
      .catch((err) => { dbg(`TTS: play() rejected — ${err.message}`); cleanup(); reject(err); });
  });
}

export function cancelPlayback() {
  if (audioEl) {
    audioEl.pause();
    URL.revokeObjectURL(audioEl.src);
    audioEl.remove();
    audioEl = null;
  }
}

export function isReady() {
  return tts !== null;
}
