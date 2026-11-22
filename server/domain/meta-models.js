// Fixed Meta model catalog. AiWay deliberately hides model choice from users: every text
// request runs on one model and every image request on one image model, so pricing is a
// small static table instead of a live marketplace catalog.
// Prices are USD per token / per unit (Meta Model API pricing page, standard tier).

export const META_CHAT_MODEL_ID = "muse-ember-1.0";
export const META_IMAGE_MODEL_ID = "muse-image-1.0";

// Ember supports 1M tokens, but input above 200K tokens is billed at roughly 3x and
// long contexts degrade quality. AiWay keeps requests inside the cheaper tier.
export const META_WORKING_CONTEXT_TOKENS = 200_000;
export const META_LONG_CONTEXT_THRESHOLD = 200_000;

export const META_PRICING = Object.freeze({
  chat: {
    prompt: 0.1 / 1e6,
    cachedPrompt: 0.004 / 1e6,
    completion: 0.5 / 1e6,
    // Meta bills built-in web search at $2.50 per 1,000 queries.
    web_search: 2.5 / 1000,
    longPrompt: 0.3 / 1e6,
    longCompletion: 1.5 / 1e6,
  },
  image: { image: 0.01 },
});

export const META_IMAGE_ASPECT_SIZES = Object.freeze({
  "1:1": "1024x1024",
  "16:9": "1792x1024",
  "9:16": "1024x1792",
  "4:3": "1365x1024",
  "3:4": "1024x1365",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
});

const CHAT_MODEL = Object.freeze({
  id: META_CHAT_MODEL_ID,
  name: "AiWay AI",
  shortName: "AiWay AI",
  description: "Fast, low-cost assistant for chat, files, code and research.",
  contextLength: META_WORKING_CONTEXT_TOKENS,
  pricing: META_PRICING.chat,
  inputModalities: ["text", "image", "file"],
  outputModalities: ["text"],
  architecture: {
    input_modalities: ["text", "image", "file"],
    output_modalities: ["text"],
  },
  provider: "meta",
  providerLabel: "AiWay",
});

const IMAGE_MODEL = Object.freeze({
  id: META_IMAGE_MODEL_ID,
  name: "AiWay Image",
  shortName: "AiWay Image",
  description: "Text-to-image generation and image editing.",
  contextLength: 0,
  pricing: META_PRICING.image,
  inputModalities: ["text", "image"],
  outputModalities: ["image"],
  architecture: {
    input_modalities: ["text", "image"],
    output_modalities: ["image"],
  },
  supported_parameters: {
    aspect_ratio: {
      type: "enum",
      values: Object.keys(META_IMAGE_ASPECT_SIZES),
    },
    resolution: { type: "enum", values: ["1K"] },
  },
  provider: "meta",
  providerLabel: "AiWay",
});

export const getChatModel = () => CHAT_MODEL;
export const getImageModel = () => IMAGE_MODEL;
export const getAvailableModels = async () => [CHAT_MODEL];
export const getImageModels = async () => [IMAGE_MODEL];
// Any requested id (including ids stored by older clients) resolves to the fixed model.
export async function getModel(modelId) {
  return modelId === META_IMAGE_MODEL_ID ? IMAGE_MODEL : CHAT_MODEL;
}

export function imageSizeForAspect(aspectRatio) {
  return (
    META_IMAGE_ASPECT_SIZES[String(aspectRatio || "").trim()] ||
    META_IMAGE_ASPECT_SIZES["1:1"]
  );
}
