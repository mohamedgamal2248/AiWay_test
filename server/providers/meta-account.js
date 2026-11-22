import { metaConfigured } from "./meta.js";

// Meta Model API exposes no balance endpoint in its public docs, so the control center
// shows configuration status and AiWay's own tracked usage instead of provider credit.
export async function metaProviderInfo() {
  const configured = metaConfigured();
  return {
    configured,
    status: configured ? "ok" : "missing",
    credits: null,
    key: { label: "Meta Model API" },
    modelsApi: false,
    errors: [],
    error: "",
    billingNote: configured
      ? "رصيد Meta غير متاح عبر API؛ راجع dev.meta.ai للرصيد. الاستخدام المعروض محسوب من قاعدة بيانات AiWay."
      : "أضف META_API_KEY في متغيرات البيئة.",
  };
}
