// Wraps kokoro-js for client-side TTS.
// The model (~80 MB quantized) is downloaded once and cached by the browser in IndexedDB.
import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";

let tts = null;
let audioEl = null;

export async function initTTS(onProgress) {
  tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
    dtype: "q8",
    device: "webgpu",       // falls back to wasm automatically on unsupported devices
    progress_callback: onProgress
  });
  return tts;
}

export async function synthesize(text, voice) {
  if (!tts) throw new Error("TTS not initialized");
  const audio = await tts.generate(text, { voice });
  return audio.toBlob();   // returns a Blob of type audio/wav
}

// Play a blob through a shared <audio> element with playsInline for iOS.
// The element must be appended to the DOM — iOS Safari won't fire onended otherwise.
export function playBlob(blob) {
  return new Promise((resolve, reject) => {
    if (audioEl) {
      audioEl.pause();
      URL.revokeObjectURL(audioEl.src);
      audioEl.remove();
    }
    audioEl = document.createElement("audio");
    audioEl.setAttribute("playsinline", "");
    audioEl.style.display = "none";
    audioEl.src = URL.createObjectURL(blob);

    const cleanup = () => {
      URL.revokeObjectURL(audioEl.src);
      audioEl.remove();
      audioEl = null;
    };

    audioEl.onended = () => { cleanup(); resolve(); };
    audioEl.onerror = () => { cleanup(); reject(new Error("Audio playback error")); };

    document.body.appendChild(audioEl);
    audioEl.play().catch((err) => { cleanup(); reject(err); });
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
