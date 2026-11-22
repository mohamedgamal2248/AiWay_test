import { requestJson } from "./http.js";
import { fetchWithTimeout } from "../core/http.js";

// Meta Model API adapter (OpenAI-compatible). It owns transport only: auth, base URL,
// timeouts. Billing, routing and persistence stay in domain/ and features/.
export const META_API_BASE = "https://api.meta.ai/v1";

export function metaApiKey() {
  return String(
    process.env.META_API_KEY || process.env.MODEL_API_KEY || "",
  ).trim();
}

export function metaConfigured() {
  return Boolean(metaApiKey());
}

export function metaHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${metaApiKey()}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

export async function metaJson(path, options = {}, timeoutMs = 30000) {
  return requestJson(
    `${META_API_BASE}/${path}`,
    { ...options, headers: metaHeaders(options.headers) },
    timeoutMs,
  );
}

// Streaming (or tool-call) chat completion. Returns the raw fetch Response so callers
// can decide how to consume the SSE body.
export function streamChat(body, { timeoutMs = 240000, signal } = {}) {
  return fetchWithTimeout(
    `${META_API_BASE}/chat/completions`,
    {
      method: "POST",
      headers: metaHeaders(),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    },
    timeoutMs,
  );
}

export function generateImage(body, timeoutMs = 120000) {
  return metaJson(
    "images/generations",
    { method: "POST", body: JSON.stringify(body) },
    timeoutMs,
  );
}

export function editImage(body, timeoutMs = 120000) {
  return metaJson(
    "images/edits",
    { method: "POST", body: JSON.stringify(body) },
    timeoutMs,
  );
}
