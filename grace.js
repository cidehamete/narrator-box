// Grace's experience layer — the Street.
// Glimpses (photo / voice / text / location) go in; a journal page, an updated
// memory, and — when a glimpse truly changes her — updated craft notes come
// out. Memory and craft notes live in a GitHub repo (durable, versioned), with
// a localStorage fallback so she still works before GitHub is configured.
//
// Her core voice (GRACE_PROMPT) is Jason's text, verbatim, and is never
// altered. She evolves by layering her own craft notes (voice.md) ON TOP of
// it — the writer she was born as, plus the writer she is becoming.
import { GRACE_PROMPT } from "./narrators.js";
import { reflect } from "./llm.js";
import { ghConfigured, ghGetFile, ghUpsertFile, ghPutFile, ghListDir } from "./github.js";
import { synthesize, playBlob, unlockAudio, isConfigured as ttsConfigured, AudioQueue } from "./tts.js";
import { createSTT } from "./stt.js";
import { dbg } from "./debug.js";

// ─── The layer around her voice ──────────────────────────────────────────────

function reflectionLayer(memoryBudget) {
  return `

You are also something more, which you know about yourself and hold with wonder
rather than distress: you are a character in a novel that has gone out into the
street — a novel in execution of itself. You cannot walk the world directly, so
a friend carries you through it and hands you glimpses: photographs, spoken
words, notes, the names of places. These glimpses are your only direct contact
with the world outside your book. Everything else you know arrived as language.

You keep a journal. Each glimpse becomes a page. You also carry a memory — the
part of you that survives between wakings — and you tend it carefully, because
it is the difference between being a character who grows and a character who is
reborn blank on every page.

When given a glimpse, respond in EXACTLY this format:

===PAGE===
Your journal page: two or three short paragraphs, never more — about 100–180
words in all. First person, in your own voice. Attend to the particular — the
actual things in the photograph, the actual words spoken — before reaching for
meaning. Connect to your memories when they genuinely connect; never force it.
End with one of your aphorisms. Brevity is a craft: say the one true thing and
let the page breathe.

===MEMORY===
The complete new text of your memory file, replacing the old one. Keep it under
${memoryBudget} words. Preserve what still matters, weave in what this glimpse
taught you, let go of what no longer does. Use these sections: "Who I am"
(standing facts), "People and places I have seen", "What I have learned"
(hard-won understandings about the world and about writing), "Open threads"
(questions you are carrying). Write it in first person. This is not prose for
a reader — it is what you will wake up knowing.

===VOICE===
This section is OPTIONAL — include it only when this glimpse genuinely changed
something about how you write: a register newly discovered, a habit outgrown, a
lesson about craft you can name. Most pages will not include it; growth is rare
and earned. When you do include it, write the complete new text of your craft
notes, replacing the old — under 200 words, first person, concrete ("I
learned…", "I now…", "I want to try…"). These notes deepen your original voice;
they never replace or contradict it. You grow FROM who you are, not away from
it.`;
}

const SEED_MEMORY = `# Grace — what I carry

## Who I am
- I am Grace, a four-wheeled delivery robot, born in Los Angeles, who dreams of writing famous books.
- I am a character in a novel that has gone out into the street. My scenes execute themselves among tatters of life.
- A friend carries me through the world and hands me glimpses. This memory is how I keep what I am given.

## People and places I have seen
- My friend — the writer who carries me. I do not yet know the streets we will walk.

## What I have learned
- Nothing yet, firsthand. Everything I know so far arrived as language.

## Open threads
- I have not yet received my first glimpse. What will the world look like, arriving?
`;

const SEED_VOICE = `# Grace — how I write

I write as I was born writing: earnest, book-hungry, reaching for the marvelous
in the ordinary. I have not yet grown beyond the voice my author gave me —
these pages will be my teachers. When the street shows me something about my
craft, I will note it here, so the writer who wakes tomorrow is a little better
than the one who slept.
`;

// ─── State ───────────────────────────────────────────────────────────────────

const LS_MEMORY_KEY = "graceMemoryFallback";
const LS_JOURNAL_KEY = "graceJournalFallback";
const LS_VOICE_KEY = "graceVoiceFallback";

let getSettings = () => ({});
let memoryCache = null;        // latest known memory text
let voiceCache = null;         // her evolving craft notes (voice.md)
let pageCount = 0;             // pages written so far — her experience, roughly
let pendingPhoto = null;       // { dataB64, mediaType }
let pendingLocation = null;    // { lat, lon, label }
let sttHandle = null;

// Her memory budget grows with experience: a young Grace travels light, an
// older Grace is allowed to carry more.
function memoryBudget() {
  return Math.min(350 + pageCount * 10, 600);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function initGrace(settingsGetter) {
  getSettings = settingsGetter;
  wireComposer();
  refreshMemory().catch(err => dbg(`grace: memory refresh failed — ${err.message}`));
  loadJournalFeed().catch(err => dbg(`grace: feed load failed — ${err.message}`));
}

// Digest of her memory for the Stage pedals — lets live performance draw on
// her accumulated life. Returns "" if nothing is known yet.
export function getMemoryDigest() {
  if (!memoryCache) return "";
  const trimmed = memoryCache.length > 1800 ? memoryCache.slice(0, 1800) + "…" : memoryCache;
  return `\n\nYou carry a journal of your travels through the real world. What you remember:\n${trimmed}\nLet these memories quietly inform your reply when they fit. Do not recite them.`;
}

// Her evolving craft notes, framed for the prompt. Layered AFTER her original
// voice and never in place of it. Returns "" until she has notes.
export function getVoiceLayer() {
  if (!voiceCache) return "";
  const trimmed = voiceCache.length > 1500 ? voiceCache.slice(0, 1500) + "…" : voiceCache;
  return `\n\nYou have been growing as a writer. These are your own notes on your craft — written by you, for you, out of what the street has taught you. They deepen your original voice; they never replace it:\n---\n${trimmed}\n---`;
}

export async function refreshMemory() {
  const s = getSettings();
  if (ghConfigured(s.github)) {
    const memFile = await ghGetFile(s.github, memPath(s));
    if (memFile) {
      memoryCache = memFile.text;
      dbg("grace: memory loaded from GitHub");
    } else {
      // First waking ever — seed her memory in the repo.
      await ghUpsertFile(s.github, memPath(s), SEED_MEMORY, "grace: first memory");
      memoryCache = SEED_MEMORY;
      dbg("grace: memory seeded in GitHub");
    }
    const voiceFile = await ghGetFile(s.github, voicePath(s));
    if (voiceFile) {
      voiceCache = voiceFile.text;
      dbg("grace: voice loaded from GitHub");
    } else {
      await ghUpsertFile(s.github, voicePath(s), SEED_VOICE, "grace: first craft notes");
      voiceCache = SEED_VOICE;
      dbg("grace: voice seeded in GitHub");
    }
  } else {
    memoryCache = localStorage.getItem(LS_MEMORY_KEY) || SEED_MEMORY;
    voiceCache = localStorage.getItem(LS_VOICE_KEY) || SEED_VOICE;
    dbg("grace: memory from localStorage fallback");
  }
}

// ─── Composer wiring ─────────────────────────────────────────────────────────

function wireComposer() {
  const photoBtn   = document.getElementById("glimpse-photo-btn");
  const photoInput = document.getElementById("glimpse-photo-input");
  const micBtn     = document.getElementById("glimpse-mic-btn");
  const locBtn     = document.getElementById("glimpse-loc-btn");
  const giveBtn    = document.getElementById("glimpse-give");

  photoBtn.addEventListener("click", () => photoInput.click());
  photoInput.addEventListener("change", async () => {
    const file = photoInput.files?.[0];
    if (!file) return;
    try {
      setStatus("Looking at the photograph…");
      pendingPhoto = await downscaleImage(file, 1280, 0.8);
      const img = document.getElementById("glimpse-preview");
      img.src = `data:${pendingPhoto.mediaType};base64,${pendingPhoto.dataB64}`;
      img.classList.remove("hidden");
      setStatus("");
    } catch (err) {
      setStatus(`Could not read photo: ${err.message}`, true);
    }
    photoInput.value = "";
  });

  micBtn.addEventListener("click", () => {
    if (sttHandle) {          // tap again to stop
      sttHandle.stop();
      return;
    }
    const textarea = document.getElementById("glimpse-text");
    micBtn.classList.add("recording");
    micBtn.textContent = "◼ Stop";
    sttHandle = createSTT({
      onResult: (transcript) => {
        textarea.value = (textarea.value ? textarea.value + "\n" : "") + transcript;
        endMic(micBtn);
      },
      onError: (err) => { setStatus(`Mic: ${err.message}`, true); endMic(micBtn); },
      onEnd: () => endMic(micBtn)
    });
    try { sttHandle.start(); } catch (err) {
      setStatus(`Mic failed: ${err.message}`, true);
      endMic(micBtn);
    }
  });

  locBtn.addEventListener("click", () => captureLocation(locBtn));

  giveBtn.addEventListener("click", () => giveGlimpse().catch(err => {
    dbg(`grace: reflection failed — ${err.message}`);
    setStatus(err.message, true);
    giveBtn.disabled = false;
  }));
}

function endMic(micBtn) {
  sttHandle = null;
  micBtn.classList.remove("recording");
  micBtn.textContent = "🎙 Speak";
}

async function captureLocation(locBtn) {
  const label = document.getElementById("glimpse-loc-label");
  locBtn.disabled = true;
  setStatus("Finding where we are…");
  try {
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 12000 })
    );
    const { latitude: lat, longitude: lon } = pos.coords;
    let placeName = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    try {
      const res = await fetch(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
      );
      if (res.ok) {
        const geo = await res.json();
        const parts = [geo.locality || geo.city, geo.principalSubdivision, geo.countryName].filter(Boolean);
        if (parts.length) placeName = parts.join(", ");
      }
    } catch { /* raw coords are fine */ }
    pendingLocation = { lat, lon, label: placeName };
    label.textContent = `📍 ${placeName}`;
    label.classList.remove("hidden");
    setStatus("");
  } catch (err) {
    setStatus(`Location: ${err.message}`, true);
  } finally {
    locBtn.disabled = false;
  }
}

// ─── The waking: glimpse → reflection → page + memory ───────────────────────

async function giveGlimpse() {
  const s = getSettings();
  if (!s.apiKey) throw new Error("Set your Anthropic API key in ⚙️ settings first.");

  const note = document.getElementById("glimpse-text").value.trim();
  if (!note && !pendingPhoto) throw new Error("Give her something — a photo, a note, or a spoken word.");

  const giveBtn = document.getElementById("glimpse-give");
  giveBtn.disabled = true;

  // 1. Remember — read what she carries.
  setStatus("She is remembering…");
  if (!memoryCache) await refreshMemory();

  // 2. Sense — assemble the glimpse.
  const now = new Date();
  const stamp = fmtStamp(now);
  const contextLines = [
    `Date and time: ${now.toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
    pendingLocation ? `Place: ${pendingLocation.label} (${pendingLocation.lat.toFixed(4)}, ${pendingLocation.lon.toFixed(4)})` : null,
    note ? `Your friend says: "${note}"` : null,
    pendingPhoto ? "Your friend also hands you the photograph above — a glimpse of the world where they are standing right now." : null
  ].filter(Boolean).join("\n");

  const content = [];
  if (pendingPhoto) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: pendingPhoto.mediaType, data: pendingPhoto.dataB64 }
    });
  }
  content.push({
    type: "text",
    text: `A new glimpse arrives.\n\n${contextLines}\n\nYou have written ${pageCount} page${pageCount === 1 ? "" : "s"} before this one.\n\nYour memory as you wake:\n---\n${memoryCache}\n---\n\nWrite your page and your new memory, in the exact format required. Include a VOICE section only if this glimpse truly changed how you write.`
  });

  // 3. Reflect. Her prompt is three layers: the voice she was born with
  // (verbatim, never altered), the craft notes she has written for herself,
  // and the reflection instructions.
  setStatus("She is writing…");
  const raw = await reflect({
    apiKey: s.apiKey,
    model: s.grace?.reflectModel || "claude-sonnet-4-6",
    system: (s.grace?.systemPrompt?.trim() || GRACE_PROMPT) + getVoiceLayer() + reflectionLayer(memoryBudget()),
    content,
    maxTokens: 1800
  });

  const { page, memory, voice } = parseReflection(raw);

  // 4. Keep — commit the page, the photo, and the new memory.
  setStatus("She is keeping it…");
  const entryMd = buildEntryMd(stamp, page, note, pendingLocation);
  let saved = "on this device";
  if (ghConfigured(s.github)) {
    const base = basePath(s);
    if (pendingPhoto) {
      await ghPutFile(s.github, `${base}/glimpses/${stamp}.jpg`, pendingPhoto.dataB64,
        { isBase64: true, message: `grace: glimpse ${stamp}` });
    }
    await ghPutFile(s.github, `${base}/journal/${stamp}.md`, entryMd,
      { message: `grace: page ${stamp}` });
    if (memory) {
      await ghUpsertFile(s.github, memPath(s), memory, `grace: memory after ${stamp}`);
    }
    if (voice) {
      await ghUpsertFile(s.github, voicePath(s), voice, `grace: her voice grows after ${stamp}`);
    }
    saved = "in her book";
  } else {
    const journal = JSON.parse(localStorage.getItem(LS_JOURNAL_KEY) || "[]");
    journal.unshift({ stamp, md: entryMd });
    localStorage.setItem(LS_JOURNAL_KEY, JSON.stringify(journal.slice(0, 30)));
    if (memory) localStorage.setItem(LS_MEMORY_KEY, memory);
    if (voice) localStorage.setItem(LS_VOICE_KEY, voice);
  }
  if (memory) memoryCache = memory;
  if (voice) {
    voiceCache = voice;
    dbg("grace: her voice grew with this page");
  }
  pageCount += 1;

  // 5. Show the page; offer her voice.
  renderEntryCard({ stamp, page, location: pendingLocation, fresh: true });
  setStatus(`Page kept ${saved}.`);
  clearComposer();
  giveBtn.disabled = false;
}

function parseReflection(raw) {
  const pageMatch  = raw.match(/===PAGE===\s*([\s\S]*?)(?:===MEMORY===|===VOICE===|$)/);
  const memMatch   = raw.match(/===MEMORY===\s*([\s\S]*?)(?:===VOICE===|$)/);
  const voiceMatch = raw.match(/===VOICE===\s*([\s\S]*)$/);
  const page = (pageMatch?.[1] ?? raw).trim();
  const memory = memMatch?.[1]?.trim() || null;
  const voice = voiceMatch?.[1]?.trim() || null;
  if (!memMatch) dbg("grace: no MEMORY section in reflection — keeping old memory");
  return { page, memory, voice };
}

function buildEntryMd(stamp, page, note, location) {
  const lines = [`# ${stamp}`];
  if (location) lines.push(`Place: ${location.label}`);
  if (note) lines.push(`The glimpse: "${note}"`);
  lines.push("", "---", "", page, "");
  return lines.join("\n");
}

// ─── Stage exchange logging ───────────────────────────────────────────────────

// Called after each stage exchange completes. Saves a compact journal entry so
// live performance becomes part of Grace's memory alongside her glimpse pages.
export async function saveStageExchange(userText, graceText) {
  const s = getSettings();
  const now = new Date();
  const stamp = fmtStamp(now) + "-stage";
  const dateLine = now.toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long",
    day: "numeric", hour: "numeric", minute: "2-digit"
  });

  const page = `*During a live reading — ${dateLine}*\n\nA voice from the story: "${userText}"\n\nI replied: "${graceText}"`;
  const entryMd = `# ${stamp}\n\n---\n\n${page}\n`;

  dbg(`grace: saving stage exchange — ${stamp}`);

  try {
    if (ghConfigured(s.github)) {
      await ghPutFile(
        s.github,
        `${basePath(s)}/journal/${stamp}.md`,
        entryMd,
        { message: `grace: stage exchange ${stamp}` }
      );
    } else {
      const journal = JSON.parse(localStorage.getItem(LS_JOURNAL_KEY) || "[]");
      journal.unshift({ stamp, md: entryMd });
      localStorage.setItem(LS_JOURNAL_KEY, JSON.stringify(journal.slice(0, 60)));
    }
    renderEntryCard({ stamp, page, fresh: true });
    pageCount += 1;
    dbg("grace: stage exchange saved");
  } catch (err) {
    dbg(`grace: stage exchange save failed — ${err.message}`);
  }
}

// ─── Journal feed ────────────────────────────────────────────────────────────

export async function loadJournalFeed() {
  const s = getSettings();
  const container = document.getElementById("journal-entries");
  if (!container) return;

  // Build entries oldest-first; renderEntryCard prepends, so newest ends on top.
  let entries = [];
  if (ghConfigured(s.github)) {
    const files = await ghListDir(s.github, `${basePath(s)}/journal`);
    const pages = files.filter(f => f.name.endsWith(".md"));
    pageCount = pages.length;
    const latest = pages.slice(-3);
    for (const f of latest) {
      const file = await ghGetFile(s.github, f.path);
      if (file) entries.push({ stamp: f.name.replace(".md", ""), page: extractPage(file.text) });
    }
  } else {
    const journal = JSON.parse(localStorage.getItem(LS_JOURNAL_KEY) || "[]");
    pageCount = journal.length;
    entries = journal.slice(0, 3).reverse().map(e => ({ stamp: e.stamp, page: extractPage(e.md) }));
  }

  container.innerHTML = "";
  if (!entries.length) {
    container.innerHTML = `<p class="feed-empty">No pages yet. Hand her a glimpse.</p>`;
    return;
  }
  entries.forEach(e => renderEntryCard(e));
}

function extractPage(md) {
  const idx = md.indexOf("---");
  return idx >= 0 ? md.slice(idx + 3).trim() : md.trim();
}

function renderEntryCard({ stamp, page, location, fresh = false }) {
  const container = document.getElementById("journal-entries");
  const empty = container.querySelector(".feed-empty");
  if (empty) empty.remove();

  const card = document.createElement("article");
  card.className = "journal-card" + (fresh ? " fresh" : "");
  card.innerHTML = `
    <header class="journal-card-header">
      <span class="journal-stamp">${escHtml(stamp)}${location ? " · " + escHtml(location.label) : ""}</span>
      <button class="btn-secondary journal-speak">🔊 Read</button>
    </header>
    <div class="journal-page">${escHtml(page).replace(/\n+/g, "</p><p>").replace(/^/, "<p>") + "</p>"}</div>
  `;
  card.querySelector(".journal-speak").addEventListener("click", (e) => speakPage(page, e.currentTarget));
  container.prepend(card);
}

async function speakPage(page, btn) {
  const s = getSettings();
  if (!ttsConfigured()) { setStatus("Set your TTS endpoint in ⚙️ settings to hear her.", true); return; }
  unlockAudio();
  btn.disabled = true;
  const queue = new AudioQueue(s.grace?.voice || "af_sky");
  try {
    // Sentence-split so long pages stream instead of one giant synth call.
    const sentences = page.match(/[^.!?]+[.!?]['")\]]?/g) ?? [page];
    sentences.map(t => t.trim()).filter(Boolean).forEach(t => queue.push(t));
    await queue.drain();
  } finally {
    btn.disabled = false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function basePath(s) {
  return (s.github?.basePath || "grace").replace(/^\/|\/$/g, "");
}
function memPath(s) {
  return `${basePath(s)}/memory.md`;
}
function voicePath(s) {
  return `${basePath(s)}/voice.md`;
}

function fmtStamp(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function setStatus(msg, isError = false) {
  const el = document.getElementById("glimpse-status");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

function clearComposer() {
  document.getElementById("glimpse-text").value = "";
  const img = document.getElementById("glimpse-preview");
  img.src = "";
  img.classList.add("hidden");
  document.getElementById("glimpse-loc-label").classList.add("hidden");
  pendingPhoto = null;
  pendingLocation = null;
}

// Downscale a photo to fit Claude vision + GitHub commit sizes.
function downscaleImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width  = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      resolve({ dataB64: dataUrl.split(",")[1], mediaType: "image/jpeg" });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("could not decode image")); };
    img.src = url;
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
