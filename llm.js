// Calls Anthropic Messages API directly from the browser (BYOK).
// The apiKey is stored only in localStorage and sent only to api.anthropic.com.
export async function respond({ apiKey, model, systemPrompt, userText, maxTokens, temperature }) {
  const guardedSystem =
    systemPrompt.trim() +
    "\n\nIMPORTANT: Respond with no more than two sentences. Speak in character only — no preamble, no stage directions, no quotation marks.";

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
      system: guardedSystem,
      messages: [{ role: "user", content: userText }]
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic ${res.status}: ${body}`);
  }

  const data = await res.json();
  // Strip any leading/trailing quotation marks the model sometimes adds
  return data.content[0].text.trim().replace(/^["'"']+|["'"']+$/gu, "");
}
