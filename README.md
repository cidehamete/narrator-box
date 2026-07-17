# Grace

A live-storytelling companion built around one character: Grace, a four-wheeled delivery robot from Los Angeles who dreams of writing famous books. Two faces, one character:

- **Stage** — one pedal. Tap, speak a line, and Grace answers in her own voice through the speaker. Built for live readings; the round-trip targets under 4 seconds.
- **Street** — her experience layer. Hand her glimpses of the world (photos, spoken words, notes, places) and she writes journal pages and tends a persistent memory in a GitHub repo — which her stage voice draws on live. See [GRACE.md](GRACE.md).

Built for iPhone 15 Pro + Safari. No backend, no build step. Deploys straight to GitHub Pages. (Grew out of the four-pedal Narrator Box; the app is now hers alone.)

---

## Setup

### 1. Get your Anthropic API key

Sign up at [console.anthropic.com](https://console.anthropic.com) and create an API key. Keep it handy.

### 2. Deploy to GitHub Pages

1. Fork or clone this repo
2. Go to **Settings → Pages** in your GitHub repo
3. Set source to **Deploy from branch → main → / (root)**
4. Wait ~60 seconds, then visit `https://<your-username>.github.io/<repo-name>/`

### 3. Enter your API key in the app

1. Open the deployed URL on your iPhone
2. Tap ⚙️ in the top-right corner
3. Paste your Anthropic API key in the **API Key** field
4. Tap **Save & Close**

Your key is stored only in your browser's `localStorage`. It is sent directly from your device to `api.anthropic.com` — never to GitHub or anywhere else.

### 4. First load

The first time you open the app, it will download the Kokoro voice model (~80 MB). This takes 30–60 seconds on a good connection and is cached automatically. Subsequent loads are nearly instant.

---

## Security note

**Your API key lives only in your browser.** It is stored in `localStorage` on your device and sent directly to `api.anthropic.com` when you use a pedal. No third party ever sees it.

However: if you hand your phone to someone with this app open, they could read or use the key. Treat it like a saved password on the device — the same level of trust.

---

## Available voices

| Voice | Label |
|-------|-------|
| `af_bella` | Bella (American F) |
| `af_nicole` | Nicole (American F) |
| `af_sarah` | Sarah (American F) |
| `af_sky` | Sky (American F) |
| `bf_emma` | Emma (British F) |
| `bf_isabella` | Isabella (British F) |
| `am_michael` | Michael (American M) |
| `am_adam` | Adam (American M) |
| `am_echo` | Echo (American M) |
| `bm_george` | George (British M) |
| `bm_daniel` | Daniel (British M) |

Use the **Test** button next to each voice dropdown in settings to audition before a show.

---

## Customizing Grace

Open ⚙️ settings → Grace:
- **Her voice** — Kokoro voice ID (see table above), used on stage and for reading her journal pages
- **Reflection model** — the model that writes her journal pages (Sonnet recommended)
- **Her voice (system prompt)** — her core persona, editable; stage responses and journal reflections both build on it

Notes:
- The app appends a two-sentence brevity limit to stage responses automatically; journal pages are exempt and run 120–250 words
- Her stage responses automatically include her current memory from the Street, so what she has seen informs what she says

---

## Settings reference

| Setting | Default | Range |
|---------|---------|-------|
| Model | `claude-haiku-4-5-20251001` | Haiku 4.5, Sonnet 4.6 |
| Her stage length | 2 sentences | 1–6 sentences |
| Temperature | 0.9 | 0.0–1.5 |

Stage length is enforced by instruction, not truncation — whatever the setting, she always finishes her sentence. (Tokens are capped only as a generous safety net; if it were ever hit, the app drops the unfinished tail so she ends on a complete thought.)

Higher temperature = more creative/unpredictable responses. For stage use, 0.8–1.1 works well.

---

## If Web Speech API is unavailable

Some network environments or browser configurations block the microphone. If the mic fails, a **Type instead** input will appear — type your story line and tap Narrate. The rest of the flow (LLM + TTS) is identical.

---

## Local development

No build step needed. Serve from any static file server:

```bash
cd narrator-box
npx serve .
# or
python3 -m http.server 8000
```

Open `http://localhost:8000` in Chrome or Safari. Note: Web Speech API requires HTTPS in production (GitHub Pages provides this automatically).
