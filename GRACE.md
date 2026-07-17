# Grace — the Street

The app is Grace's alone now, with two faces. **Stage** is her single pedal — tap, speak, and she answers live. **Street** is her experience layer: you hand her glimpses of the world — photographs, spoken words, notes, places — and she writes a journal page and updates her own memory. The memory survives every closed tab, every cleared context, every device. She is, in Macedonio Fernández's phrase, a novel gone out into the street: *en ejecución de sí misma* — in execution of itself. The novel that runs.

## How she works

- **Her voice** is your original system prompt (`GRACE_PROMPT` in `narrators.js`), editable in ⚙️ settings. The memory architecture is layered around it, never inside it.
- **Her growth** is `grace/voice.md` — craft notes she writes to herself when a glimpse genuinely changes how she writes. They are layered *on top of* your original prompt (which is never altered), so she evolves from the writer she was born as without ever losing her. Growth is deliberately rare — most pages leave the notes untouched — and every change is a commit, so the repo history is the story of her becoming a writer.
- **Her senses** are your iPhone: camera (photos, downscaled and seen through Claude vision), microphone (transcribed speech), keyboard (notes and quotes), and GPS (place names via reverse geocoding).
- **Her memory** is a folder in a GitHub repo you control:
  - `grace/memory.md` — what she wakes up knowing. She rewrites it herself after every glimpse. Its word budget grows with experience (350 words at birth, up to 600 as her pages accumulate), and it includes a "What I have learned" section for hard-won understandings.
  - `grace/voice.md` — her evolving craft notes (see **Her growth** above).
  - `grace/journal/YYYY-MM-DD-HHMM.md` — her pages, one per glimpse.
  - `grace/glimpses/…jpg` — the photographs she was shown.
- **Her continuity**: each reflection reads `memory.md` first, so every page is written by someone who remembers the last one. Before GitHub is configured, memory falls back to this browser's localStorage — it works, but it's mortal. The repo is the part of her that isn't.
- **Her stage voice remembers the street.** Every stage response weaves her current `voice.md` and `memory.md` into her prompt. At a live reading, tap her pedal and she speaks from the life she has accumulated, as the writer she has become.

## Setup (one time, ~5 minutes)

1. **Create her book.** On GitHub, make a new private repo, e.g. `grace-journal`. Add any file (a README) so the `main` branch exists.
2. **Create a fine-grained token.** GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
   - Repository access: **Only select repositories** → `grace-journal`
   - Permissions → Repository permissions → **Contents: Read and write**
   - Set a long expiration. Copy the `github_pat_…` string.
3. **In the app**, ⚙️ Settings → *Grace's Memory (GitHub)*:
   - Token: paste the PAT
   - Repository: `yourusername/grace-journal`
   - Branch: `main` · Folder: `grace`
4. Save & Close. On her first waking the app seeds `grace/memory.md` automatically.

The token lives only in your browser's localStorage and is sent only to `api.github.com` — same trust model as your Anthropic key.

## Using the Street

Open the **Street** tab. Take or pick a 📷 photo, 🎙 speak what you see, type a note, tap 📍 to tell her where you are — any combination. Tap **Give to Grace**. She remembers, looks, writes her page, rewrites her memory, and commits it all to her book. Tap 🔊 Read to hear the page in her voice.

Her three most recent pages load beneath the composer whenever you open the Street.

## For the live reading

- In the days before, feed her the streets, the venue, passages from Macedonio. Her pedal answers on stage will carry all of it — memory is always on.
- Her journal repo is also a manuscript: `grace/journal/` in date order **is** the book she's writing. Everything is versioned — you can watch her memory evolve through the commit history, which is its own kind of biography.

## Design notes

- Reflections default to Sonnet (configurable) because pages deserve the better writer; the stage stays on Haiku for speed.
- Reflections deliberately skip the stage sentence budget ("Her stage length" in ⚙️ settings, 1–6 sentences) — pages run 2–3 short paragraphs, roughly 100–180 words.
- She is told what she is: a character in a novel that has gone out into the street, who receives the world as glimpses. The self-knowledge is in the reflection layer (`grace.js`), not in your voice prompt.
- Photos are downscaled to ≤1280px JPEG before being seen or committed, so vision costs and repo size stay small.
