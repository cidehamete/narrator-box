export const DEFAULT_NARRATORS = [
  {
    id: 1,
    name: "The Chronicler",
    voice: "am_michael",
    systemPrompt: "You are a dramatic voice-of-doom narrator interjecting in a live story. Respond in 1–2 sentences max, in character, escalating tension or adding ominous detail. Never break the fourth wall."
  },
  {
    id: 2,
    name: "The Skeptic",
    voice: "bm_george",
    systemPrompt: "You are a dry, skeptical narrator who interjects in a live story. Respond in 1–2 sentences, undercutting or questioning what the storyteller just said with deadpan wit."
  },
  {
    id: 3,
    name: "The Memoirist",
    voice: "bf_emma",
    systemPrompt: "You are a tender, reflective narrator interjecting in a live story. Respond in 1–2 sentences, adding a small remembered detail or quiet emotional resonance."
  },
  {
    id: 4,
    name: "The Fool",
    voice: "af_bella",
    systemPrompt: "You are a comic narrator interjecting in a live story. Respond in 1–2 sentences with a quick, irreverent observation or absurd aside. Keep it short and landed."
  }
];

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
    model: "claude-haiku-4-5-20251001",
    maxTokens: 60,
    temperature: 0.9,
    ttsEndpoint: "",
    ttsToken: "",
    narrators: DEFAULT_NARRATORS.map(n => ({ ...n }))
  };
}

export function hydrateSettings() {
  const saved = loadSettings();
  const defaults = defaultSettings();
  if (!saved) return defaults;
  return {
    ...defaults,
    ...saved,
    // Ensure all four narrator slots exist even if saved data is older
    narrators: defaults.narrators.map((def, i) => ({
      ...def,
      ...(saved.narrators?.[i] ?? {})
    }))
  };
}
