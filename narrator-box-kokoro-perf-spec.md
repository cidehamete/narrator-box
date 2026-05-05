# Narrator Box — Kokoro Performance Spec (Option 3)

A focused upgrade pass for the existing Narrator Box repo. Goal: make Kokoro-82M synthesis usable on iPhone 15 Pro Safari served from GitHub Pages, getting per-response latency from "30s timeout" down to under 10s on average and ideally start-of-audio under 4s. No other behavior changes.

## Why this is needed

Current symptoms in production:
- `tts.generate()` times out after 30s on a ~340-char input
- Model is downloading and initializing fine (model_q4.onnx in ~6s, ready at ~9s after page load)
- The bottleneck is inference, not loading

Root cause: ONNX Runtime Web is silently falling back to **single-threaded WASM** on iOS Safari because:
1. Safari's WebGPU backend for ORT-Web is incomplete and unreliable
2. Multi-threaded WASM requires `SharedArrayBuffer`, which requires the `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` HTTP headers, which GitHub Pages does not send

Single-threaded WASM running an 82M-param model on iPhone is the cause of the multi-second-per-token synthesis. The fixes below address that ceiling, plus several smaller wins that compound.

## Changes

### 1. Enable cross-origin isolation via service worker

Add the [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker) shim to fake the COOP/COEP headers on GitHub Pages. This unlocks `SharedArrayBuffer` and lets ORT-Web spin up multi-threaded WASM with SIMD. Realistic speedup: 2–4×.

**Steps:**
1. Add `coi-serviceworker.js` to the repo root. Either:
   - Download from `https://cdn.jsdelivr.net/npm/coi-serviceworker@latest/coi-serviceworker.min.js` and commit it, or
   - `npm install coi-serviceworker` and copy `dist/coi-serviceworker.min.js` to the repo root
2. In `index.html`, add this **as the very first script tag in `<head>`**, before any other scripts or modules:
   ```html
   <script src="coi-serviceworker.js"></script>
   ```
3. On first visit the page reloads itself once to install the service worker. After reload, `window.crossOriginIsolated === true` and `SharedArrayBuffer` is available.
4. In `app.js` boot sequence, log and surface this:
   ```js
   console.log("crossOriginIsolated:", window.crossOriginIsolated);
   if (!window.crossOriginIsolated) {
     console.warn("Cross-origin isolation NOT active — TTS will be single-threaded and slow.");
   }
   ```
5. Verify in iOS Safari Web Inspector that after the second load, `crossOriginIsolated` is `true`.

GitHub Pages quirk: make sure `coi-serviceworker.js` is fetched from the same origin (i.e., your own repo path), not jsdelivr — service workers can only be registered from same-origin scripts.

### 2. Switch quantization from q4 to q8

Counterintuitive but consistently true on Apple Silicon and ARM: dequantization overhead from int4 dominates the tiny weight-fetch savings. q8 ends up faster on iPhone.

In `tts.js`:

```diff
  tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
-   dtype: "q4",
+   dtype: "q8",
    device: "wasm",
    progress_callback: onProgress
  });
```

Force `device: "wasm"` explicitly rather than letting it auto-detect WebGPU on iOS — the WebGPU path on Safari is currently unreliable and the failure mode is "looks fine, runs slow." We'd rather take a known-good WASM path with all 4–6 cores.

If the user is on a non-iOS device later, this can become:
```js
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const device = isIOS ? "wasm" : "webgpu";
```

### 3. Pre-warm the inference graph after init

The first `tts.generate()` call always pays a JIT/graph-compile cost (~2–4s). Pay it during boot, not during a performance.

In `tts.js`, after `from_pretrained()` resolves, before resolving `initTTS()`:

```js
// Warm up: force ORT to compile the graph and allocate buffers.
// We discard the audio. ~2–4s cost paid here, not in the user's first tap.
await tts.generate("Ready.", { voice: "af_bella" });
```

In `app.js`, change the boot status text from "Loading voice engine…" to "Loading voice engine…" → "Warming up voices…" (during this step) → "Ready" so the user knows what's happening.

### 4. Stream LLM response and synthesize sentence-by-sentence

Today: wait for full LLM response, then synth the whole thing, then play. Total wall time = LLM_total + TTS_total + audio_duration.

Target: stream LLM tokens, accumulate into sentences, synth each sentence as soon as it's complete, queue audio chunks for sequential playback. Wall time becomes roughly `max(LLM_first_sentence + TTS_first_sentence, LLM_total)`, which can shave 2–4s off perceived latency.

#### 4a. Convert LLM call to streaming

In `llm.js`, replace the single-shot fetch with a streaming reader:

```js
export async function* respondStream({ apiKey, model, systemPrompt, userText, maxTokens, temperature }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      stream: true,
      system: systemPrompt + "\n\nIMPORTANT: Two sentences maximum. Each sentence ≤15 words. Speak in character only — no preamble, no stage directions, no quotation marks.",
      messages: [{ role: "user", content: userText }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic error: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "" || data === "[DONE]") continue;
      try {
        const evt = JSON.parse(data);
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          yield evt.delta.text;
        }
      } catch { /* ignore parse errors on partial frames */ }
    }
  }
}
```

#### 4b. Sentence buffer

In `app.js`, wrap the stream with a sentence detector:

```js
function* sentencize(textStream) {
  // not literally a generator over a generator — pseudocode for the pattern.
  // Implement as: accumulate chars, flush on /[.!?]["')\]]?\s/ when buffer ≥ 8 chars.
}

async function pedalRespond(narrator, userText) {
  const audioQueue = new AudioQueue(narrator.voice);
  let buf = "";
  for await (const chunk of respondStream({ ...config, systemPrompt: narrator.systemPrompt, userText })) {
    buf += chunk;
    while (true) {
      const m = buf.match(/^(.{8,}?[.!?]["')\]]?)(\s+|$)/s);
      if (!m) break;
      audioQueue.push(m[1]);                  // start synth + queue playback
      buf = buf.slice(m[0].length);
    }
  }
  if (buf.trim()) audioQueue.push(buf.trim()); // flush trailing fragment
  await audioQueue.drain();
}
```

#### 4c. Audio queue

New file or section in `tts.js`:

```js
import { synthesize } from "./tts.js";

export class AudioQueue {
  constructor(voice) {
    this.voice = voice;
    this.synthQueue = Promise.resolve();   // serial synth
    this.playQueue = Promise.resolve();    // serial playback
    this.aborted = false;
  }
  push(text) {
    // Kick off synth in serial order, then chain playback after the previous chunk finishes.
    this.synthQueue = this.synthQueue.then(async () => {
      if (this.aborted) return null;
      return await synthesize(text, this.voice);
    });
    const synthPromise = this.synthQueue;
    this.playQueue = this.playQueue.then(async () => {
      const blob = await synthPromise;
      if (this.aborted || !blob) return;
      await playBlob(blob);
    });
  }
  async drain() { await this.playQueue; }
  abort() {
    this.aborted = true;
    // Stop currently playing audio (held by playBlob); see below.
  }
}

function playBlob(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.playsInline = true;
    audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
    audio.play().catch(() => resolve());
    // Hook for abort: store `audio` on a class field if you want true cancel.
  });
}
```

Important: serial synth (not parallel) — running two ORT inferences at once on the same WASM instance contends and ends up slower. Parallel between LLM and TTS is fine; parallel TTS calls are not.

### 5. Fix the progress callback and tighten generation params

#### 5a. Progress percentage going past 100%

The current callback is summing per-chunk progress without normalizing. In `tts.js`:

```js
progress_callback: (info) => {
  if (info?.status === "progress" && typeof info.progress === "number") {
    const pct = Math.min(100, Math.round(info.progress));
    onProgress({ file: info.file, pct });
  }
}
```

Or replace with a determinate spinner — the model loads in ~6s, the percentage isn't earning its keep.

#### 5b. Cap response length more aggressively

In `narrators.js` defaults / settings defaults:
- `maxTokens` default: drop from 80 → 60
- Add explicit reinforcement in the system-prompt suffix (already done in §4a above): "Two sentences maximum. Each sentence ≤15 words."

#### 5c. Strip junk before TTS

Before pushing each sentence to the audio queue, run:
```js
sentence
  .replace(/^["'`*_]+|["'`*_]+$/g, "")    // wrapping quotes/markdown
  .replace(/\s+/g, " ")
  .trim();
```

The 339-char `len` in your log suggests something is being prepended somewhere — verify that the LLM response is what's being passed to TTS, and not e.g. systemPrompt + response.

## Acceptance criteria

- [ ] `window.crossOriginIsolated === true` after the first reload on iOS Safari
- [ ] Boot sequence: download → init → warm-up → ready, all visible to user, completes in <15s on first cold load and <3s on cached load
- [ ] First-audio latency for a 1-sentence response: under 4s on iPhone 15 Pro on broadband
- [ ] Two-sentence response: starts playing first sentence within 4s; second sentence plays gaplessly after
- [ ] Tapping the active pedal during `speaking` aborts both pending synth and current playback
- [ ] Progress callback never displays > 100%
- [ ] No regressions to settings, narrator config, or fallback text-input flow

## Things to verify with iOS Safari Web Inspector

While debugging, attach Safari on a Mac to the iPhone (Develop menu) and check:
1. Service worker registered: Storage tab → Service Workers
2. `crossOriginIsolated` true: Console
3. ORT thread count: search console for "WASM threads" or check `ort.env.wasm.numThreads` after init — should be ≥ 2
4. Memory: keep an eye on memory pressure. iPhone Safari may kill the tab if model + buffers exceed ~500MB.

## What to do if it's still too slow after all this

If the realistic ceiling on iPhone WASM (~5–10s per response) is still unworkable for stage use, fall back to **Option 1** (iOS `speechSynthesis`) as the default and keep this Kokoro path as an opt-in "studio mode" toggle in settings. Don't rip Kokoro out — keep it behind a switch.

## Out of scope for this pass

- Server-hosted Kokoro (Option 2) — separate spec if needed
- Switching to Piper or another TTS engine
- Multi-turn memory or "set the scene" preamble
- UI redesign

Keep the diff small. The win comes from compounding: SAB-enabled multi-thread + q8 + warm-up + streaming each gives 1.5–3×; together they should comfortably move you under the timeout and probably under 5s start-of-audio.
