// Calls Anthropic Messages API directly from the browser (BYOK).
// The apiKey is stored only in localStorage and sent only to api.anthropic.com.

const SYSTEM_SUFFIX =
  "\n\nIMPORTANT: Two sentences maximum. Each sentence ≤15 words. " +
  "Speak in character only — no preamble, no stage directions, no quotation marks.";

// Streaming generator — yields text delta chunks as they arrive.
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
      system: systemPrompt.trim() + SYSTEM_SUFFIX,
      messages: [{ role: "user", content: userText }]
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic ${res.status}: ${body}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete trailing line
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const evt = JSON.parse(data);
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          yield evt.delta.text;
        }
      } catch { /* ignore partial frames */ }
    }
  }
}

// Non-streaming convenience wrapper (used by test-voice button in settings).
export async function respond(params) {
  let text = "";
  for await (const chunk of respondStream(params)) text += chunk;
  return text.trim().replace(/^["'"']+|["'"']+$/gu, "");
}

// Reflection call for Grace's journal — longer form, supports image blocks,
// and deliberately does NOT append the two-sentence stage suffix.
// content: array of Anthropic content blocks, e.g.
//   [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
//    { type: "text", text: "..." }]
export async function reflect({ apiKey, model, system, content, maxTokens = 1200, temperature = 0.85 }) {
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
      system,
      messages: [{ role: "user", content }]
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return (data.content ?? [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("")
    .trim();
}
