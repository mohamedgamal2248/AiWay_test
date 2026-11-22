import {
  chatSystemPrompt,
  piAppBuilderPrompt,
  generalAgentPrompt,
  imageAgentPrompt,
} from "./prompts.js";

// Agents are configuration, not separate code paths: each one is a system prompt, a tool
// set (see tools/index.js) and hard limits enforced by the runner.
//   reserveUsd  provider USD held up front for a paid run (capped by the user's balance)
//   minUsd      smallest balance that lets a run start at all
//   trialUsd    provider USD AiWay absorbs for a free-trial run (strictly capped)
export const AGENTS = Object.freeze({
  chat: {
    id: "chat",
    prompt: chatSystemPrompt,
    reasoningEffort: "minimal",
    allowTrial: true,
    limits: {
      maxSteps: 3,
      maxToolCalls: 3,
      maxOutputTokens: 32768,
      minUsd: 0.0015,
      trialUsd: 0.008,
      trialMaxSteps: 1,
    },
  },
  "pi-app-builder": {
    id: "pi-app-builder",
    name_ar: "منشئ تطبيقات Pi",
    name_en: "Pi App Builder",
    description_ar:
      "يبحث ويكتب ملفات المشروع (HTML وCSS وJS وغيرها) ويفحصها ثم يسلّمك ZIP جاهزًا للتحميل داخل متصفح Pi.",
    description_en:
      "Researches, writes project files (HTML, CSS, JS and more), validates them and delivers a ready ZIP you can download in Pi Browser.",
    prompt: piAppBuilderPrompt,
    reasoningEffort: "low",
    allowTrial: true,
    limits: {
      maxSteps: 14,
      maxToolCalls: 40,
      maxOutputTokens: 24576,
      reserveUsd: 0.06,
      minUsd: 0.006,
      trialUsd: 0.012,
      trialMaxSteps: 8,
    },
  },
  "general-agent": {
    id: "general-agent",
    name_ar: "الوكيل العام",
    name_en: "General Agent",
    description_ar:
      "بحث وقراءة الملفات وإنشاء PDF وWord وExcel وPowerPoint قابلة للتنزيل.",
    description_en:
      "Research, read files and create downloadable PDF, Word, Excel and PowerPoint documents.",
    prompt: generalAgentPrompt,
    reasoningEffort: "low",
    allowTrial: true,
    limits: {
      maxSteps: 10,
      maxToolCalls: 24,
      maxOutputTokens: 16384,
      reserveUsd: 0.05,
      minUsd: 0.005,
      trialUsd: 0.01,
      trialMaxSteps: 6,
    },
  },
  "image-agent": {
    id: "image-agent",
    name_ar: "وكيل الصور",
    name_en: "Image Agent",
    description_ar:
      "يحسّن وصفك ويولّد الصور أو يعدّل صورك بنسب أبعاد مناسبة، ويعطيك خيارات متعددة عند الطلب.",
    description_en:
      "Improves your prompt, generates images or edits yours, with fitting aspect ratios and variations on request.",
    prompt: imageAgentPrompt,
    reasoningEffort: "minimal",
    // Images always cost real money, so they stay behind the first purchase.
    allowTrial: false,
    limits: {
      maxSteps: 5,
      maxToolCalls: 6,
      maxOutputTokens: 4096,
      reserveUsd: 0.05,
      minUsd: 0.012,
    },
  },
});

const AGENT_IDS = new Set(Object.keys(AGENTS).filter((id) => id !== "chat"));

export const isAgentTask = (taskId) => AGENT_IDS.has(String(taskId || ""));

// Any non-agent task id (including "all-models" and legacy tool ids) is plain chat.
export function resolveAgent(taskId) {
  const id = String(taskId || "");
  return AGENT_IDS.has(id) ? AGENTS[id] : AGENTS.chat;
}

// Agent entries appended to the /api/models tool list. They are code-defined so they
// exist even when the ai_tools table has no row for them.
export function agentTools() {
  return [...AGENT_IDS].map((id, i) => {
    const a = AGENTS[id];
    return {
      id: a.id,
      name_ar: a.name_ar,
      name_en: a.name_en,
      description_ar: a.description_ar,
      description_en: a.description_en,
      tool_type: "agent",
      is_agent: true,
      is_active: true,
      sort_order: 1 + i,
    };
  });
}
