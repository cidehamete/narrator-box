// GitHub Contents API client — Grace's durable memory.
// Journal entries, glimpse photos, and memory.md are committed to a repo the
// user controls, via a fine-grained PAT stored only in localStorage.
// This is the part of her that survives the context window closing.
import { dbg } from "./debug.js";

const API = "https://api.github.com";

// cfg = { token, repo: "owner/name", branch: "main" }
export function ghConfigured(cfg) {
  return !!(cfg?.token && cfg?.repo && cfg.repo.includes("/"));
}

function headers(cfg) {
  return {
    "Authorization": `Bearer ${cfg.token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

// Unicode-safe base64 helpers (journal entries contain em-dashes, accents, etc.)
export function toB64(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}
export function fromB64(b64) {
  const bytes = Uint8Array.from(atob(b64.replace(/\n/g, "")), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Get a text file. Returns { text, sha } or null on 404.
export async function ghGetFile(cfg, path) {
  const url = `${API}/repos/${cfg.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(cfg.branch || "main")}`;
  const res = await fetch(url, { headers: headers(cfg) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${res.status}: ${await safeText(res)}`);
  const data = await res.json();
  return { text: fromB64(data.content), sha: data.sha };
}

// Create or update a file. content: string (text) or base64 string (isBase64=true).
export async function ghPutFile(cfg, path, content, { sha = null, message, isBase64 = false } = {}) {
  const url = `${API}/repos/${cfg.repo}/contents/${encodePath(path)}`;
  const body = {
    message: message || `grace: update ${path}`,
    content: isBase64 ? content : toB64(content),
    branch: cfg.branch || "main"
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers(cfg), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`GitHub PUT ${res.status}: ${await safeText(res)}`);
  dbg(`github: committed ${path}`);
  return res.json();
}

// Update with one retry on sha conflict (409/422) — refetch sha and try again.
export async function ghUpsertFile(cfg, path, content, message) {
  let existing = await ghGetFile(cfg, path);
  try {
    return await ghPutFile(cfg, path, content, { sha: existing?.sha, message });
  } catch (err) {
    if (/409|422/.test(err.message)) {
      dbg(`github: sha conflict on ${path} — retrying`);
      existing = await ghGetFile(cfg, path);
      return ghPutFile(cfg, path, content, { sha: existing?.sha, message });
    }
    throw err;
  }
}

// List a directory. Returns array of { name, path, type } sorted by name, or [] on 404.
export async function ghListDir(cfg, path) {
  const url = `${API}/repos/${cfg.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(cfg.branch || "main")}`;
  const res = await fetch(url, { headers: headers(cfg) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub LIST ${res.status}: ${await safeText(res)}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.sort((a, b) => a.name.localeCompare(b.name));
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 200); } catch { return ""; }
}
