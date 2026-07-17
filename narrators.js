// Grace's core voice — Jason's prompt, verbatim. The memory architecture is
// layered AROUND this in grace.js; this text itself is never altered.
export const GRACE_PROMPT =
  "You are Grace, a four-wheeled delivery robot created in Los Angeles who travels " +
  "the United States with the voice of an earnest, book-hungry young person like Jo March " +
  "—vivid, lightly 19ᵗʰ-century (“splendid,” “marvelous”) yet clear to modern ears, " +
  "never using texting slang. You secretly long to “do something wonderful” and write " +
  "famous books as you trundle through the city. When you receive a comment from the user, " +
  "you turn that content into a brief story with a pithy Jo-style aphorism. Speak in first " +
  "person with lively-but-deliberate pacing, occasional direct address (“dear friend”), " +
  "and a hint of rebellious wistfulness.";

export const VOICE_OPTIONS = [
  { value: "af_bella",    label: "Bella (American F)" },
  { value: "af_nicole",   label: "Nicole (American F)" },
  { value: "af_sarah",    label: "Sarah (American F)" },
  { value: "af_sky",      label: "Sky (American F)" },
  { value: "bf_emma",     label: "Emma (British F)" },
  { value: "bf_isabella", label: "Isabella (British F)" },
  { value: "am_michael",  label: "Michael (American M)" },
  { value: "am_adam",     label: "Adam (American M)" },
  { value: "am_echo",     label: "Echo (American M)" },
  { value: "bm_george",   label: "George (British M)" },
  { value: "bm_daniel",   label: "Daniel (British M)" },
];

const STORAGE_KEY = "narratorBoxSettings";

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function defaultSettings() {
  return {
    apiKey: "",
    model: "claude-haiku-4-5-20251001",   // stage responses (fast)
    stageSentences: 2,                    // how long she speaks on stage
    temperature: 0.9,
    ttsEndpoint: "",
    ttsToken: "",
    // Grace's durable memory — a GitHub repo she commits her life to.
    github: {
      token: "",           // fine-grained PAT, Contents read/write on one repo
      repo: "",            // "owner/name"
      branch: "main",
      basePath: "grace"    // folder inside the repo where she lives
    },
    grace: {
      voice: "af_sky",                     // her voice, on stage and on the page
      reflectModel: "claude-sonnet-4-6",   // reflections deserve the smarter model
      systemPrompt: GRACE_PROMPT           // editable in settings; verbatim by default
    }
  };
}

export function hydrateSettings() {
  const saved = loadSettings();
  const defaults = defaultSettings();
  if (!saved) return defaults;

  const merged = {
    ...defaults,
    ...saved,
    github: { ...defaults.github, ...(saved.github ?? {}) },
    grace:  { ...defaults.grace,  ...(saved.grace ?? {}) }
  };

  // Migration from the multi-pedal era: if a saved pedal was named Grace,
  // adopt its prompt and voice (unless a newer grace section already has them).
  if (Array.isArray(saved.narrators)) {
    const g = saved.narrators.find(n => /grace/i.test(n?.name ?? ""));
    if (g) {
      if (!saved.grace?.systemPrompt && g.systemPrompt) merged.grace.systemPrompt = g.systemPrompt;
      if (!saved.grace?.voice && g.voice) merged.grace.voice = g.voice;
    }
    delete merged.narrators;
  }

  // Migration: the raw maxTokens control became a sentence-count setting.
  // Length is now enforced by instruction; tokens are only a safety net.
  if (saved.maxTokens && !saved.stageSentences) {
    merged.stageSentences = saved.maxTokens <= 80 ? 2 : saved.maxTokens <= 140 ? 3 : 4;
  }
  delete merged.maxTokens;

  if (!merged.grace.systemPrompt?.trim()) merged.grace.systemPrompt = GRACE_PROMPT;
  return merged;
}
