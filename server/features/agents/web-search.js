import { metaJson } from "../../providers/meta.js";
import { metaError } from "../../core/errors.js";
import { META_CHAT_MODEL_ID, META_PRICING } from "../../domain/meta-models.js";

// Search grounding is not available on Chat Completions, so `web_search` is a regular
// function tool for the agent loop. It runs one small Responses API call that uses
// Meta's built-in server-side search and returns grounded text plus citations.
const MAX_SUMMARY_CHARS = 6000;

function collectText(output = []) {
  const texts = [],
    sources = new Map();
  for (const item of Array.isArray(output) ? output : []) {
    if (item?.type !== "message") continue;
    for (const part of item.content || []) {
      if (typeof part?.text === "string") texts.push(part.text);
      for (const note of part?.annotations || []) {
        if (note?.type === "url_citation" && note.url)
          sources.set(note.url, String(note.title || note.url).slice(0, 160));
      }
    }
  }
  return { text: texts.join("\n").trim(), sources };
}

export async function searchWeb(query, { contextSize = "low" } = {}) {
  const base = {
    model: META_CHAT_MODEL_ID,
    input: `Search the web and answer concisely with concrete facts, versions and dates. Include source names. Query: ${String(query).slice(0, 400)}`,
    tools: [{ type: "web_search", search_context_size: contextSize }],
    max_output_tokens: 1200,
  };
  // The Responses reasoning knob is not documented on the pages AiWay relies on. Try the
  // low-effort form first (Ember defaults to max effort, which is slow/expensive for a
  // lookup) and retry once without it if the API rejects the field.
  let { response, data } = await metaJson(
    "responses",
    {
      method: "POST",
      body: JSON.stringify({ ...base, reasoning: { effort: "low" } }),
    },
    45000,
  );
  if (response.status === 400)
    ({ response, data } = await metaJson(
      "responses",
      { method: "POST", body: JSON.stringify(base) },
      45000,
    ));
  if (!response.ok) throw metaError(response.status, data);
  const { text, sources } = collectText(data?.output);
  const fallbackText =
    typeof data?.output_text === "string" ? data.output_text : "";
  const summary = (text || fallbackText).slice(0, MAX_SUMMARY_CHARS);
  const usage = {
    prompt_tokens: Number(data?.usage?.input_tokens || 0),
    completion_tokens: Number(data?.usage?.output_tokens || 0),
  };
  const price = META_PRICING.chat;
  const usd =
    usage.prompt_tokens * price.prompt +
    usage.completion_tokens * price.completion +
    price.web_search;
  return {
    summary,
    sources: [...sources].map(([url, title]) => ({ url, title })).slice(0, 8),
    usage,
    usd,
  };
}
