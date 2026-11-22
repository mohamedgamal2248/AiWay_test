import {
  META_CHAT_MODEL_ID,
  META_LONG_CONTEXT_THRESHOLD,
  META_PRICING,
} from "./meta-models.js";
import { appError } from "../core/http.js";

const META_WEB_SEARCH_USD = META_PRICING.chat.web_search;

export const TOKEN_USD = 0.00001;

export const PROVIDER_BUDGET_SHARE = 0.5;

export const MARKUP = 1 / PROVIDER_BUDGET_SHARE;

export const TRIAL_MESSAGE_LIMIT = 10;

export const TRIAL_TOKENS = 10;

export const PI_PRICE_BUFFER = 0.05;

export const TRIAL_MODEL_FALLBACK = META_CHAT_MODEL_ID;

export const tokensForUsd = (usd) =>
  Math.round((Number(usd) * PROVIDER_BUDGET_SHARE) / TOKEN_USD);

// Meta reports prompt/completion token counts but no USD cost, so every charge is computed
// from the fixed price table. Reasoning tokens are billed as output and are already
// included in completion_tokens; cached prompt tokens are charged at the full rate
// (conservative). Input above the long-context threshold uses the higher tier.
export function chargeTokens(price, usage = {}, webSearch = false) {
  const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const output = Number(usage.completion_tokens || usage.output_tokens || 0);
  const long = input > META_LONG_CONTEXT_THRESHOLD;
  const promptRate = Number((long && price?.longPrompt) || price?.prompt || 0);
  const completionRate = Number(
    (long && price?.longCompletion) || price?.completion || 0,
  );
  const searches = Math.max(
    0,
    Number(
      usage.web_search_requests ??
        usage.server_tool_use?.web_search_requests ??
        (webSearch ? 1 : 0),
    ),
  );
  const webUsd = searches * Number(price?.web_search ?? price?.webSearch ?? 0);
  const providerUsd = input * promptRate + output * completionRate + webUsd;
  return {
    input,
    output,
    webUsd,
    providerUsd,
    costSource: "meta_usage_tokens",
    tokenUsd: TOKEN_USD,
    markup: MARKUP,
    chargedTokens: Math.max(1, Math.ceil(providerUsd / TOKEN_USD)),
  };
}

export function estimateTextTokens(value = "") {
  const text = String(value || "").trim();
  if (!text) return 0;
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latinWords = (text.match(/[A-Za-z0-9]+(?:['_-][A-Za-z0-9]+)*/g) || [])
    .length;
  const arabicWords = (text.match(/[\u0600-\u06FF]+/g) || []).length;
  const punctuation = (text.match(/[^\s\p{L}\p{N}]/gu) || []).length;
  const codeLines = (
    text.match(
      /```|[{}[\]();<>_=+*/\\|`~]|\b(?:const|let|var|function|class|import|export|SELECT|FROM|WHERE)\b/g,
    ) || []
  ).length;
  const urls = (text.match(/https?:\/\/\S+/g) || []).reduce(
    (sum, url) => sum + Math.ceil(url.length / 3),
    0,
  );
  const wordEstimate = arabicWords * 1.35 + latinWords * 1.12;
  const characterFloor =
    text.length / (arabic > text.length * 0.2 ? 2.55 : 3.85);
  return Math.max(
    1,
    Math.ceil(
      Math.max(wordEstimate, characterFloor) +
        punctuation * 0.18 +
        codeLines * 0.42 +
        urls,
    ),
  );
}

export function attachmentTokenEstimate(attachment = {}) {
  const type = String(
    attachment.type || attachment.mime_type || "",
  ).toLowerCase();
  const size = Math.max(
    0,
    Number(attachment.size || attachment.size_bytes || 0),
  );
  if (type.startsWith("image/")) {
    // The provider reports native multimodal token usage afterwards. Before sending,
    // dimensions are not always available, so use a conservative size-based band.
    if (!size) return 1050;
    if (size <= 350_000) return 750;
    if (size <= 1_500_000) return 1250;
    if (size <= 4_000_000) return 1900;
    return 2600;
  }
  if (type.includes("pdf"))
    return Math.max(900, Math.min(16000, Math.ceil(size / 155)));
  if (
    type.startsWith("text/") ||
    /json|xml|javascript|typescript|csv|markdown/.test(type)
  )
    return Math.max(220, Math.min(14000, Math.ceil(size / 3.2)));
  return Math.max(500, Math.min(9000, Math.ceil(size / 230)));
}

export function estimatedContentTokens(value) {
  if (typeof value === "string") {
    if (value.startsWith("data:")) return 0;
    return estimateTextTokens(value);
  }
  if (Array.isArray(value))
    return value.reduce((sum, item) => sum + estimatedContentTokens(item), 0);
  if (!value || typeof value !== "object") return 0;
  if (value.type === "image_url") return 1050;
  if (value.type === "file") return 1500;
  if (value.name || value.mime_type || value.size || value.size_bytes)
    return attachmentTokenEstimate(value);
  return Object.entries(value).reduce((sum, [key, item]) => {
    if (key === "file_data" || key === "url" || key === "dataUrl") return sum;
    return sum + estimatedContentTokens(item);
  }, 0);
}

export function latestUserText(messages = []) {
  const latest = [...messages]
    .reverse()
    .find((message) => message?.role === "user");
  return typeof latest?.content === "string" ? latest.content : "";
}

export function expectedOutputTokens(
  text,
  inputTokens,
  attachmentCount,
  imageCount,
  webSearch,
) {
  const value = String(text || "");
  const latestTokens = Math.max(1, estimateTextTokens(value));
  const asksForCode =
    /```|\b(code|كود|برمج|برنامج|function|api|html|javascript|python|sql)\b/i.test(
      value,
    );
  const asksForLong =
    /\b(explain|detailed|complete|full|report|article|essay|حلل|اشرح|بالتفصيل|كامل|تقرير|مقال)\b/i.test(
      value,
    );
  const asksForShort =
    /\b(short|brief|one word|مختصر|باختصار|كلمة واحدة)\b/i.test(value);
  let ratio = asksForCode
    ? 1.35
    : asksForLong
      ? 1.05
      : asksForShort
        ? 0.3
        : 0.72;
  let predicted =
    48 + latestTokens * ratio + Math.sqrt(Math.max(1, inputTokens)) * 5.5;
  predicted += attachmentCount * 45 + imageCount * 75 + (webSearch ? 120 : 0);
  return Math.max(64, Math.min(32768, Math.ceil(predicted)));
}

export function fitMessagesToModelContext(
  messages = [],
  contextLength = 0,
  outputReserve = 4096,
  locale = "en",
) {
  const source = Array.isArray(messages) ? messages : [];
  const context = Math.max(0, Number(contextLength || 0));
  if (!context)
    return {
      messages: source,
      omittedMessages: 0,
      inputTokens: Math.max(
        1,
        estimatedContentTokens(source) + 14 * source.length + 8,
      ),
    };
  const reserve = Math.max(512, Math.min(32768, Number(outputReserve || 4096)));
  const maxInput = Math.max(1024, context - reserve - 256);
  const system = source.filter((message) => message?.role === "system");
  const conversational = source.filter((message) => message?.role !== "system");
  const systemTokens = estimatedContentTokens(system) + 14 * system.length + 8;
  let used = systemTokens;
  const kept = [];
  for (let i = conversational.length - 1; i >= 0; i--) {
    const message = conversational[i];
    const cost = estimatedContentTokens(message) + 14;
    // Always keep the newest conversational message. If it alone is too large, fail explicitly upstream.
    if (!kept.length || used + cost <= maxInput) {
      kept.unshift(message);
      used += cost;
    } else break;
  }
  const omittedMessages = Math.max(0, conversational.length - kept.length);
  if (used > maxInput && kept.length <= 1)
    return {
      messages: [...system, ...kept],
      omittedMessages,
      inputTokens: used,
      tooLarge: true,
      maxInputTokens: maxInput,
    };
  const notice = omittedMessages
    ? {
        role: "system",
        content:
          locale === "ar"
            ? `ملاحظة نقل سياق: تم استبعاد ${omittedMessages} رسالة أقدم من هذا الطلب فقط للحفاظ على سعة سياق النموذج. لم يتم حذفها من المحادثة المحفوظة. إذا احتجت تفاصيل منها فاطلبها من المستخدم بوضوح.`
            : `Context transport note: ${omittedMessages} older message(s) were excluded from this request only to stay within the model context window. They remain saved in the conversation. Ask the user clearly if details from them are needed.`,
      }
    : null;
  const fitted = notice ? [...system, notice, ...kept] : [...system, ...kept];
  return {
    messages: fitted,
    omittedMessages,
    inputTokens: Math.max(
      1,
      estimatedContentTokens(fitted) + 14 * fitted.length + 8,
    ),
    maxInputTokens: maxInput,
  };
}

export function estimateChatCharge(
  price,
  messages = [],
  webSearch = false,
  outputReserve = 0,
) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  // Message framing differs by native tokenizer; 14 tokens/message plus a small
  // conversation header is a closer preflight approximation than word count alone.
  const inputTokens = Math.max(
    1,
    estimatedContentTokens(safeMessages) + 14 * safeMessages.length + 8,
  );
  const attachmentCount = safeMessages.reduce(
    (sum, message) =>
      sum +
      (Array.isArray(message?.attachments) ? message.attachments.length : 0),
    0,
  );
  const imageCount = safeMessages.reduce(
    (sum, message) =>
      sum +
      (Array.isArray(message?.attachments)
        ? message.attachments.filter((item) =>
            String(item?.type || "").startsWith("image/"),
          ).length
        : 0),
    0,
  );
  const automaticOutput = expectedOutputTokens(
    latestUserText(safeMessages),
    inputTokens,
    attachmentCount,
    imageCount,
    webSearch,
  );
  const requestedReserve = Number(outputReserve || 0);
  const reservedOutputTokens = Math.max(
    64,
    Math.min(
      32768,
      Math.ceil(requestedReserve > 0 ? requestedReserve : automaticOutput),
    ),
  );
  const promptRate = Math.max(0, Number(price?.prompt || 0));
  const completionRate = Math.max(0, Number(price?.completion || 0));
  const requestUsd = Math.max(0, Number(price?.request || 0));
  const inputUsd = inputTokens * promptRate;
  const outputUsd = reservedOutputTokens * completionRate;
  // Built-in search is billed per query; reserve one query up front.
  const webUsd = webSearch
    ? Math.max(0, Number(price?.web_search ?? price?.webSearch ?? 0.0025))
    : 0;
  const providerUsd = inputUsd + outputUsd + requestUsd + webUsd;
  return {
    inputTokens,
    reservedOutputTokens,
    attachmentCount,
    imageCount,
    webSearch: Boolean(webSearch),
    inputUsd,
    outputUsd,
    requestUsd,
    webUsd,
    providerUsd,
    chargedTokens: Math.max(1, Math.ceil(providerUsd / TOKEN_USD)),
  };
}

export function reservationTokens(estimatedTokens, kind = "chat") {
  const estimate = Math.max(1, Math.ceil(Number(estimatedTokens) || 1));
  const multiplier = kind === "image" ? 1.3 : 1.25;
  const minimumBuffer = kind === "image" ? 250 : 50;
  return Math.max(
    estimate,
    Math.ceil(estimate * multiplier),
    estimate + minimumBuffer,
  );
}

// Final charge for a whole agent run: the run's provider USD (model tokens of every
// step plus tool costs such as searches and images) converted to AiWay tokens.
export function chargeFromProviderUsd(providerUsd, usage = {}) {
  const usd = Math.max(0, Number(providerUsd) || 0);
  return {
    input: Number(usage.prompt_tokens || 0),
    output: Number(usage.completion_tokens || 0),
    webUsd: Number(usage.webSearches || 0) * META_WEB_SEARCH_USD,
    providerUsd: usd,
    costSource: "meta_usage_tokens",
    tokenUsd: TOKEN_USD,
    markup: MARKUP,
    chargedTokens: Math.max(1, Math.ceil(usd / TOKEN_USD)),
  };
}

export function resolveMetaCharge({
  usage = {},
  price = {},
  webSearch = false,
  fallbackUsd = 0,
} = {}) {
  const result = chargeTokens(price, usage, webSearch);
  const hasUsage = result.input > 0 || result.output > 0;
  if (!hasUsage && fallbackUsd > 0)
    return {
      ...result,
      providerUsd: fallbackUsd,
      chargedTokens: Math.max(1, Math.ceil(fallbackUsd / TOKEN_USD)),
      pricingBasis: "estimate",
    };
  return result;
}

export function affordableOutputLimit(
  price,
  availableTokens,
  estimate,
  cap = 16384,
) {
  const completionPrice = Number(price?.completion || 0);
  if (!(completionPrice > 0)) return Math.max(128, cap);
  const availableUsd = Math.max(
    0,
    Number(availableTokens || 0) * TOKEN_USD * 0.9,
  );
  const fixedUsd = Math.max(
    0,
    Number(estimate?.inputUsd || 0) + Number(estimate?.webUsd || 0),
  );
  const affordable = Math.floor((availableUsd - fixedUsd) / completionPrice);
  return Math.max(0, Math.min(cap, affordable));
}

export function isLowBalance(remainingTokens, lastCharge = 0) {
  const remaining = Math.max(0, Number(remainingTokens || 0));
  return (
    remaining > 0 &&
    remaining < Math.max(1000, Math.ceil(Number(lastCharge || 0) * 2))
  );
}

export async function classifyTokenChargeFailure(
  supabase,
  userId,
  requiredTokens,
  cause = null,
) {
  const required = Math.max(1, Math.ceil(Number(requiredTokens) || 1));
  const { data: profile, error } = await supabase
    .from("users")
    .select("ai_tokens,trial_messages_remaining,has_purchased")
    .eq("id", userId)
    .single();
  if (error || !profile) return appError("DATABASE_ERROR", {}, error || cause);
  const availableTokens = Math.max(0, Number(profile.ai_tokens || 0));
  if (
    !profile.has_purchased &&
    Number(profile.trial_messages_remaining || 0) <= 0
  ) {
    return appError("TRIAL_ENDED", { availableTokens }, cause);
  }
  if (availableTokens < required) {
    return appError(
      "INSUFFICIENT_TOKENS_FOR_REQUEST",
      {
        availableTokens,
        requiredTokens: required,
        shortfall: required - availableTokens,
      },
      cause,
    );
  }
  return appError("DATABASE_ERROR", {}, cause);
}
