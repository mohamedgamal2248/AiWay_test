import { TOKEN_USD } from "../../domain/credits.js";

// A user-facing cost receipt for one run, in AiWay tokens (never provider USD).
// Components are rounded up individually and then reconciled so the lines always add
// up to the amount actually charged, even when the charge was clamped to the reservation.
export function buildReceipt({
  usage,
  chargedTokens,
  steps,
  toolCalls,
  elapsedMs,
}) {
  const toTokens = (usd) =>
    Math.max(0, Math.ceil((Number(usd) || 0) / TOKEN_USD));
  const search = toTokens(usage.searchUsd);
  const images = toTokens(usage.imageUsd);
  const otherTools = toTokens(
    Math.max(0, usage.extraUsd - usage.searchUsd - usage.imageUsd),
  );
  let ai = toTokens(usage.modelUsd) + otherTools;
  let parts = { ai, search, images };
  const sum = ai + search + images;
  const total = Math.max(0, Math.floor(chargedTokens));
  if (sum !== total) {
    // Keep the specific lines, put the difference on the AI-work line; if that would go
    // negative (charge clamped below the tool costs) scale everything down.
    const adjusted = total - search - images;
    if (adjusted >= 0) parts.ai = adjusted;
    else {
      const k = sum ? total / sum : 0;
      parts = {
        search: Math.floor(search * k),
        images: Math.floor(images * k),
        ai: 0,
      };
      parts.ai = total - parts.search - parts.images;
    }
  }
  const lines = [{ key: "ai", tokens: parts.ai, steps }];
  if (usage.webSearches)
    lines.push({
      key: "search",
      tokens: parts.search,
      count: usage.webSearches,
    });
  if (usage.images)
    lines.push({ key: "images", tokens: parts.images, count: usage.images });
  return {
    total,
    steps,
    toolCalls,
    elapsedMs,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    reasoningTokens: usage.reasoning_tokens || 0,
    lines,
  };
}
