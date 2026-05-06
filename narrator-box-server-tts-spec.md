# Narrator Box — Server-Hosted Kokoro Spec

Move TTS off the phone and onto a small server so we keep Kokoro voices and stop fighting iOS Safari's WASM ceiling. The web app calls a single HTTPS endpoint that returns a WAV. Web app changes are minimal because the existing `AudioQueue` already chunks audio at the sentence level — we're just swapping the synthesizer.

This spec covers both backends (Modal primary, Hugging Face Space alternative). Identical API contract, so the web app doesn't care which is deployed.

## Architecture

```
[iPhone Safari]
   │  user taps pedal, speaks
   │  STT (Web Speech API) → text
   │  Anthropic streaming → sentence buffer
   │  per sentence:
   │     POST /synthesize { text, voice }  ─────►  [Modal or HF Space]
   │                                                │
   │     audio/wav  ◄─────────────────────────────  │  (Kokoro-onnx CPU inference)
   │  AudioQueue plays sequentially
```

## API contract (both backends implement this exactly)

**Endpoint:** `POST {BASE_URL}/synthesize`

**Headers:**
- `Content-Type: application/json`
- `X-Auth-Token: <token>` (token is BYO, set in web app settings, validated by server). Note: `Authorization: Bearer <token>` is also accepted as a fallback, but Hugging Face's reverse proxy strips `Authorization` headers, so prefer `X-Auth-Token` for portability.

**Request body:**
```json
{
  "text": "Oh, what a splendid sight.",
  "voice": "af_bella",
  "speed": 1.0
}
```
- `text` (required): string, ≤ 500 chars (server should reject longer)
- `voice` (required): one of Kokoro's voice ids
- `speed` (optional, default 1.0): 0.5–2.0

**Response (success):**
- `200 OK`
- `Content-Type: audio/wav`
- Body: WAV bytes, 24kHz mono int16

**Response (errors):**
- `400` for bad input (with JSON body `{ "error": "..." }`)
- `401` for missing/invalid token
- `429` if you want to rate-limit
- `500` on synth failure

**CORS:** must allow `https://*.github.io` (or whatever your Pages origin is) on `POST` and `OPTIONS`. Easiest: `allow_origins=["*"]` and rely on the bearer token for auth.

**Wake/health endpoint:** `GET {BASE_URL}/health` returns `200 OK` with body `{"ok": true, "warm": true}`. The web app uses this to pre-warm the container.

## Web app changes

Goal: drop kokoro-js entirely, replace with a fetch to the configured endpoint. Keep the existing `AudioQueue`, sentence buffer, and streaming-LLM logic from the perf spec.

### 1. Settings additions

In `narrators.js` / settings UI:
- **TTS endpoint URL** (text input, e.g. `https://you--narrator-tts.modal.run`)
- **TTS auth token** (password input, masked)
- Voice list stays the same (it's still Kokoro voices, just synthesized server-side)

Both stored in `localStorage` alongside existing settings. The Anthropic key stays where it is.

### 2. Replace `tts.js`

```js
// tts.js — server-backed Kokoro client.
let endpoint = null;
let token = null;
let warmed = false;

export function configureTTS({ endpointUrl, authToken }) {
  endpoint = endpointUrl?.replace(/\/$/, "");
  token = authToken;
  warmed = false;
}

export async function warmupTTS() {
  if (!endpoint) throw new Error("TTS endpoint not configured");
  try {
    const res = await fetch(`${endpoint}/health`);
    warmed = res.ok;
  } catch {
    warmed = false;
  }
  // Do a tiny throwaway synth to warm the model graph too.
  if (warmed) {
    try {
      await synthesize("Ready.", "af_bella");
    } catch { /* ignore */ }
  }
  return warmed;
}

export async function synthesize(text, voice, speed = 1.0) {
  if (!endpoint) throw new Error("TTS endpoint not configured");
  const res = await fetch(`${endpoint}/synthesize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Auth-Token": token } : {})
    },
    body: JSON.stringify({ text, voice, speed })
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`TTS ${res.status}: ${msg.slice(0, 200)}`);
  }
  return await res.blob();   // audio/wav blob
}
```

The existing `AudioQueue` continues to work unchanged — it just gets blobs from this `synthesize` instead of the in-browser one.

### 3. Boot sequence

Replace the "Loading voice engine…" download progress with a much simpler:
1. On page load: read settings. If endpoint+token set, kick off `warmupTTS()` in background and show "Waking voices…" indicator.
2. When `warmupTTS()` resolves (or 30s elapses), enable pedals.
3. If `warmed === false` after timeout, show a "Tap to retry" affordance with the error.

Add a manual **🔥 Wake** button next to the settings gear so the user can ping the endpoint before a show without having to tap a pedal.

### 4. Remove kokoro-js dependency

- Strip the `<script type="module">` import of `kokoro-js` from `index.html`
- Remove the COI service worker if you added it (not needed anymore)
- Drop the q4/q8 model download UI
- Keep all the streaming-LLM + sentence-buffer + AudioQueue plumbing

This is a net simplification of the front-end.

### 5. Failure handling

Live performance failure modes worth handling:
- **Cold start (5–60s):** show a clear "Waking…" state on the pedal; don't time out for 90s
- **Endpoint down:** flash red on pedal, surface error in a toast, keep app usable
- **Rate limit:** treat as transient, retry once with 500ms backoff
- **Network drop mid-stream:** abort gracefully, return pedal to idle

---

## Backend Option A: Modal (recommended)

### Why Modal for stage use
- Cold start ~5–15s for a CPU container with kokoro-onnx pre-baked into the image
- Hot inference ~1–2s per sentence on a small CPU
- HTTPS endpoint, CORS, and bearer auth all trivial
- Scale-to-zero with configurable idle timeout — won't burn through credits between gigs
- Free tier: $30/mo compute credits, plenty for occasional shows

### Single-file deploy

Create `server/modal_app.py`:

```python
import modal
import os

app = modal.App("narrator-box-tts")

# Bake everything into the image so cold start is just container boot, not pip install.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("espeak-ng")
    .pip_install(
        "kokoro-onnx==0.4.7",     # pin a version
        "soundfile==0.12.1",
        "fastapi[standard]==0.115.0",
        )
    .run_commands(
        # Pre-download model + voices into the image so first call has nothing to fetch.
        "mkdir -p /models && cd /models && "
        "wget -q https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx && "
        "wget -q https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
    )
)

# Token check: set via `modal secret create narrator-box-tts AUTH_TOKEN=...`
auth_secret = modal.Secret.from_name("narrator-box-tts")

@app.cls(
    image=image,
    secrets=[auth_secret],
    cpu=2,
    memory=2048,
    min_containers=0,           # scale to zero
    scaledown_window=300,       # stay warm 5 min after last request (covers a set)
    timeout=120,
)
class TTS:
    @modal.enter()
    def load(self):
        from kokoro_onnx import Kokoro
        self.kokoro = Kokoro("/models/kokoro-v1.0.onnx", "/models/voices-v1.0.bin")
        # Warm the graph with a one-char synth.
        self.kokoro.create("a", voice="af_bella", lang="en-us")

    @modal.fastapi_endpoint(method="GET", label="health")
    def health(self):
        from fastapi.responses import JSONResponse
        return JSONResponse({"ok": True, "warm": True})

    @modal.fastapi_endpoint(method="POST", label="synthesize")
    def synthesize(self, item: dict, authorization: str = ""):
        from fastapi import HTTPException
        from fastapi.responses import Response
        import io, soundfile as sf

        expected = os.environ.get("AUTH_TOKEN")
        if expected and authorization != f"Bearer {expected}":
            raise HTTPException(401, "bad token")

        text = (item.get("text") or "").strip()
        voice = item.get("voice") or "af_bella"
        speed = float(item.get("speed") or 1.0)
        if not text:
            raise HTTPException(400, "text required")
        if len(text) > 500:
            raise HTTPException(400, "text too long")

        audio, sr = self.kokoro.create(text, voice=voice, speed=speed, lang="en-us")
        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
        return Response(
            content=buf.getvalue(),
            media_type="audio/wav",
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
                "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            },
        )
```

### Deploy steps

```bash
pip install modal
modal token new                                            # one-time auth
modal secret create narrator-box-tts AUTH_TOKEN=<your-secret-here>
modal deploy server/modal_app.py
# → prints two URLs like:
#   https://YOURNAME--narrator-box-tts-tts-health.modal.run
#   https://YOURNAME--narrator-box-tts-tts-synthesize.modal.run
```

Both URLs share a `BASE_URL` prefix per `app.cls`. If Modal's URL shape doesn't match the exact `/synthesize` and `/health` paths the web app expects, either:
- Adapt the web app to use Modal's literal endpoint URLs (cleaner), or
- Wrap with a single FastAPI app exposed via `@app.function` + `@modal.asgi_app()` so the routes are clean

The cleaner version using `@modal.asgi_app()`:

```python
@app.function(image=image, secrets=[auth_secret], cpu=2, memory=2048,
              min_containers=0, scaledown_window=300, timeout=120)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, HTTPException, Header
    from fastapi.responses import Response, JSONResponse
    from fastapi.middleware.cors import CORSMiddleware
    from kokoro_onnx import Kokoro
    import io, soundfile as sf, os

    api = FastAPI()
    api.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    kokoro = Kokoro("/models/kokoro-v1.0.onnx", "/models/voices-v1.0.bin")
    kokoro.create("a", voice="af_bella", lang="en-us")  # warm
    expected = os.environ.get("AUTH_TOKEN")

    @api.get("/health")
    def health():
        return JSONResponse({"ok": True, "warm": True})

    @api.post("/synthesize")
    async def synth(item: dict, authorization: str = Header(default="")):
        if expected and authorization != f"Bearer {expected}":
            raise HTTPException(401, "bad token")
        text = (item.get("text") or "").strip()
        if not text or len(text) > 500:
            raise HTTPException(400, "bad text")
        audio, sr = kokoro.create(
            text,
            voice=item.get("voice") or "af_bella",
            speed=float(item.get("speed") or 1.0),
            lang="en-us",
        )
        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
        return Response(content=buf.getvalue(), media_type="audio/wav")

    return api
```

Use this version. Single URL like `https://yourname--narrator-box-tts-web.modal.run` with clean `/health` and `/synthesize` paths.

### Modal cost notes

- Scale-to-zero: pay only for time you're using it
- Per-request: ~2s CPU × $0.000038/CPU-sec × 2 CPUs ≈ $0.00015/request — fractions of a cent
- Idle warm period (5 min after last request): consumes credit. ~$0.011 per 5-min idle window
- Pre-warm a show with one tap, then use freely; expect $0.50–2 per gig depending on length
- Free $30/mo credit covers many gigs

### Pre-show ritual
1. Open Narrator Box on phone 2 minutes before stepping on stage
2. Tap the 🔥 Wake button → confirms green
3. Tap each pedal once with a throwaway phrase (forces graph warm + audio permission grant)
4. Walk on stage with everything hot

---

## Backend Option B: Hugging Face Space (FastAPI Docker)

### When to choose this
- Budget = 0, accept 30–60s cold start as the cost
- Public exposure of the endpoint is OK (anyone with the URL can hit it; auth token mitigates)
- Don't need 24/7 uptime — Spaces sleep after extended idle and have to be woken

### Repo layout

Create a separate repo (e.g. `narrator-box-tts`) with:

```
narrator-box-tts/
├── Dockerfile
├── app.py
├── requirements.txt
└── README.md
```

**`requirements.txt`:**
```
kokoro-onnx==0.4.7
soundfile==0.12.1
fastapi==0.115.0
uvicorn[standard]==0.30.0
```

**`Dockerfile`** (uses HF Spaces' required non-root user pattern, models live at `/app/models/`):
```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y espeak-ng wget && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 user
USER user
ENV PATH="/home/user/.local/bin:$PATH"

WORKDIR /app

COPY --chown=user requirements.txt requirements.txt
RUN pip install --no-cache-dir --upgrade -r requirements.txt

RUN mkdir -p /app/models && cd /app/models && \
    wget -q https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx && \
    wget -q https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

COPY --chown=user app.py app.py

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
```

**`app.py`:**
```python
import io, os
import soundfile as sf
from fastapi import FastAPI, HTTPException, Header
from fastapi.responses import Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from kokoro_onnx import Kokoro

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

kokoro = Kokoro("/app/models/kokoro-v1.0.onnx", "/app/models/voices-v1.0.bin")
# Warm the graph
kokoro.create("a", voice="af_bella", lang="en-us")

EXPECTED_TOKEN = os.environ.get("AUTH_TOKEN")

@app.get("/health")
def health():
    return JSONResponse({"ok": True, "warm": True})

@app.post("/synthesize")
async def synthesize(item: dict, authorization: str = Header(default="")):
    if EXPECTED_TOKEN and authorization != f"Bearer {EXPECTED_TOKEN}":
        raise HTTPException(401, "bad token")
    text = (item.get("text") or "").strip()
    if not text or len(text) > 500:
        raise HTTPException(400, "bad text")
    audio, sr = kokoro.create(
        text,
        voice=item.get("voice") or "af_bella",
        speed=float(item.get("speed") or 1.0),
        lang="en-us",
    )
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return Response(content=buf.getvalue(), media_type="audio/wav")
```

### Deploy steps

1. Create a new Space at huggingface.co/new-space, SDK = "Docker"
2. Clone, drop in the three files above, push
3. In the Space's Settings → Variables and secrets, add `AUTH_TOKEN` as a secret
4. Wait for the build (5–10 min first time)
5. Endpoint URL is `https://YOUR-USERNAME-narrator-box-tts.hf.space`

### HF Space gotchas

- **Sleep:** Free Spaces sleep after extended idle. The "Waking voices…" state in the web app needs to tolerate up to 60s
- **Public:** Free Spaces are publicly visible. The bearer token in `AUTH_TOKEN` is the only thing preventing strangers from running up your "rate limit." Use a long random token
- **Resources:** Free CPU is 2 vCPU / 16GB RAM, shared. Inference is reliable but not as snappy as Modal
- **Persistence:** Model files are baked into the Docker image, not stored separately, so cold start doesn't re-download them. Build is slower (one-time) but cold runtime start is faster

### Pre-show ritual for HF
1. Open the HF Space URL in a browser tab ~5 min before stage time (this can also be done by the web app pinging `/health`)
2. Wait for the green "Running" indicator
3. Then proceed as with Modal

---

## Acceptance criteria

- [ ] `POST /synthesize` returns `audio/wav` for valid input on both backends
- [ ] `GET /health` returns 200 within 1s when warm
- [ ] Bearer token auth enforced; missing/wrong token returns 401
- [ ] CORS allows the web app's origin
- [ ] Web app's "Wake" button measurably reduces first-tap latency
- [ ] First-tap latency on a warm container: under 4s end-to-end (STT + LLM + TTS) for a 1-sentence response
- [ ] Sentence-by-sentence streaming continues to work; no audible gaps between chunks
- [ ] No regressions to settings, narrator config, Anthropic LLM call, or text-input fallback
- [ ] Web app degrades gracefully when endpoint is unreachable (clear error, app remains responsive)

## Suggested rollout order

1. Deploy Modal backend, verify `/health` and `/synthesize` work via `curl`
2. Update web app `tts.js` and settings UI; test against Modal endpoint
3. Strip kokoro-js and the COI service worker from the front-end
4. Deploy HF Space backend as a fallback (optional)
5. Document both endpoint URLs in the web app README, and which one is configured by default

## Things explicitly not in scope

- Streaming WAV from server (unnecessary; sentence chunks are small)
- Multiple languages
- Voice cloning or custom voice training
- Authentication beyond a static bearer token
- Front-end voice activity detection or push-to-talk improvements (those live in their own spec)
