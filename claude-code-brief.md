# Claude Code brief — server-TTS front-end swap

The Narrator Box repo currently uses `kokoro-js` for in-browser TTS. We've discovered iOS Safari can't run it fast enough for live stage use (single-threaded WASM ceiling), so we've moved Kokoro to a server. A Hugging Face Space is deployed and confirmed working at `https://cidehamete2-narratorbox.hf.space` — endpoints `/health`, `/whoami`, and `/synthesize` all respond correctly. Synth latency on warm container measured at ~3.5s for a short sentence.

Your job is the front-end swap. The full spec is already in the repo at `narrator-box-server-tts-spec.md` — read it first, follow it exactly, with these adjustments and reminders:

## Changes to make

1. Rewrite `tts.js` to fetch from the configured endpoint instead of running `kokoro-js`. Use the `synthesize`, `warmupTTS`, `configureTTS` shape in the spec.
2. **Auth header is `X-Auth-Token`, not `Authorization`.** Hugging Face's reverse proxy strips `Authorization`. The spec has been updated to reflect this — double-check your fetch calls use `X-Auth-Token`.
3. Add two fields to the settings drawer: **TTS endpoint URL** (text) and **TTS auth token** (password input). Persist alongside existing settings in `localStorage`.
4. Add a 🔥 **Wake** button to the main UI, near the ⚙️ settings icon. It calls `/health` on the configured endpoint and shows green/red status. Used to spin up a sleeping HF Space before a show.
5. On page load: if endpoint+token are configured, kick off `warmupTTS()` in background, show "Waking voices…" indicator until it resolves or 60s elapses.
6. Strip the in-browser TTS path completely: remove `kokoro-js` imports, the `coi-serviceworker` script and file, the model-download progress UI, and any q4/q8 dtype config.

## What to preserve unchanged

- Streaming Anthropic LLM call (`respondStream` generator)
- Sentence buffer / regex split logic
- `AudioQueue` class (serial synth, serial playback)
- Default narrator configs and editing UI
- Web Speech API STT path and "Type instead" fallback
- State machine: idle → listening → thinking → speaking → idle, with cancel transitions
- Settings persistence under `narratorBoxSettings`

## Acceptance

- Pasting `https://cidehamete2-narratorbox.hf.space` and the user's `AUTH_TOKEN` into settings, then tapping a pedal, results in Kokoro audio playing through the iPhone speaker
- Tapping 🔥 Wake hits `/health` and shows green/red within ~60s
- Two-sentence LLM responses play first sentence within ~4s of LLM stream starting; second sentence plays gaplessly after
- No `kokoro-js`, `transformers.js`, ONNX, or COI service worker references remain in the repo
- App degrades gracefully when endpoint is unreachable (clear error, app still responsive)

When done, summarize what changed in plain language and confirm a manual test against the live endpoint passed.
