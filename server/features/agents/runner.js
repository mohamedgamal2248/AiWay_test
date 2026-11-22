import { appError } from "../../core/http.js";
import { chargeTokens, estimateTextTokens } from "../../domain/credits.js";
import { META_PRICING } from "../../domain/meta-models.js";
import { runCompletion } from "./llm.js";

// Hobby-plan friendly defaults. The Vercel function is allowed 300s, but the loop only
// uses part of it so there is always time to deliver a final answer and persist results.
export const DEFAULT_TIME_BUDGET_MS = Number(
  process.env.AGENT_TIME_BUDGET_MS || 230_000,
);
const FINALIZE_RESERVE_MS = 40_000;
const MAX_TOOL_RESULT_CHARS = 24_000;
const KEEP_FULL_TOOL_RESULTS = 3;
const CONTEXT_COMPACT_TOKENS = 70_000;

const price = META_PRICING.chat;

export function truncateForModel(value, max = MAX_TOOL_RESULT_CHARS) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} characters; request a narrower range or use the next cursor]`;
}

function messageTokens(messages) {
  return messages.reduce(
    (sum, m) =>
      sum +
      estimateTextTokens(
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((p) => p?.text || "").join(" ")
            : "",
      ) +
      (m.tool_calls ? estimateTextTokens(JSON.stringify(m.tool_calls)) : 0) +
      14,
    0,
  );
}

// Old tool outputs are the main source of context growth in long loops. Keep the newest
// few intact and replace earlier ones with a short stub so the model keeps the thread
// without paying to re-read everything every step.
export function compactToolResults(messages) {
  if (messageTokens(messages) < CONTEXT_COMPACT_TOKENS) return messages;
  const toolIndexes = messages
    .map((m, i) => (m.role === "tool" ? i : -1))
    .filter((i) => i >= 0);
  const stale = new Set(toolIndexes.slice(0, -KEEP_FULL_TOOL_RESULTS));
  return messages.map((m, i) =>
    stale.has(i) && String(m.content || "").length > 400
      ? {
          ...m,
          content: `${String(m.content).slice(0, 300)}\n…[older tool output compacted]`,
        }
      : m,
  );
}

function parseArguments(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

export function emptyUsage() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    reasoning_tokens: 0,
    webSearches: 0,
    images: 0,
    extraUsd: 0,
    searchUsd: 0,
    imageUsd: 0,
    modelUsd: 0,
  };
}

// Runs the agent loop: model call -> tool execution -> model call ... within a hard
// budget of steps, tool calls, wall-clock time and provider USD. When any budget is
// reached the model is asked for a final tool-free answer so the user always gets a
// result instead of a half-finished loop.
export async function runAgent({
  messages,
  tools = [],
  toolContext = {},
  budget = {},
  reasoningEffort = "low",
  temperature,
  emit = () => {},
  signal,
  complete = runCompletion,
}) {
  const startedAt = Date.now();
  const deadline = startedAt + (budget.timeMs || DEFAULT_TIME_BUDGET_MS);
  const maxSteps = budget.maxSteps || 8;
  const maxToolCalls = budget.maxToolCalls || 16;
  const maxUsd = Number(budget.usd) > 0 ? Number(budget.usd) : Infinity;
  const maxOutputTokens = budget.maxOutputTokens || 16384;
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
  const convo = [...messages];
  const usage = emptyUsage();
  const artifacts = [];
  let answer = "",
    steps = 0,
    toolCallCount = 0,
    stopReason = "complete",
    finishReason = "";
  const spentUsd = () => usage.modelUsd + usage.extraUsd;

  while (true) {
    if (signal?.aborted) throw appError("REQUEST_TIMEOUT");
    steps++;
    const remainingMs = deadline - Date.now();
    const outOfBudget =
      steps > maxSteps ||
      toolCallCount >= maxToolCalls ||
      remainingMs < FINALIZE_RESERVE_MS ||
      spentUsd() >= maxUsd * 0.8;
    const final = outOfBudget || !tools.length;
    if (outOfBudget && steps > 1) {
      stopReason =
        remainingMs < FINALIZE_RESERVE_MS
          ? "time"
          : spentUsd() >= maxUsd * 0.8
            ? "cost"
            : "steps";
      convo.push({
        role: "system",
        content:
          "Tool budget is exhausted. Do not call tools. Give the best complete final answer now from what you already have, and clearly say what remains unfinished.",
      });
    }

    // Never let one completion outspend the remaining budget.
    const inputTokens = messageTokens(convo);
    const remainingUsd = maxUsd - spentUsd();
    const affordableOutput = Number.isFinite(remainingUsd)
      ? Math.floor(
          Math.max(0, remainingUsd - inputTokens * price.prompt) /
            price.completion,
        )
      : maxOutputTokens;
    const stepMax = Math.min(maxOutputTokens, affordableOutput);
    if (stepMax < 256) {
      stopReason = "cost";
      if (!answer.trim()) throw appError("INSUFFICIENT_TOKENS_FOR_REQUEST");
      break;
    }

    emit({ type: "agent_step", step: steps, final });
    const result = await complete({
      messages: compactToolResults(convo),
      tools: final ? [] : tools,
      maxTokens: stepMax,
      reasoningEffort,
      temperature,
      timeoutMs: Math.max(15_000, Math.min(150_000, remainingMs - 5_000)),
      signal,
      onDelta: (text) => {
        answer += text;
        emit({ type: "delta", text });
      },
    });
    finishReason = result.finishReason;
    usage.prompt_tokens += result.usage.prompt_tokens;
    usage.completion_tokens += result.usage.completion_tokens;
    usage.reasoning_tokens += result.usage.reasoning_tokens || 0;
    usage.modelUsd += chargeTokens(price, result.usage, false).providerUsd;

    if (!result.toolCalls.length || final) {
      if (result.toolCalls.length && !result.text.trim() && !answer.trim())
        throw appError("EMPTY_RESPONSE");
      break;
    }

    convo.push({
      role: "assistant",
      content: result.text || null,
      tool_calls: result.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    });
    if (answer && !/\n\s*$/.test(answer)) {
      answer += "\n\n";
      emit({ type: "delta", text: "\n\n" });
    }

    for (const call of result.toolCalls) {
      toolCallCount++;
      const tool = toolByName.get(call.name);
      const args = parseArguments(call.arguments);
      let content;
      if (!tool) content = `Error: unknown tool "${call.name}".`;
      else if (args === null)
        content = "Error: tool arguments must be a valid JSON object.";
      else if (toolCallCount > maxToolCalls)
        content = "Error: tool call limit reached; finish with what you have.";
      else {
        emit({
          type: "agent_tool",
          phase: "start",
          tool: call.name,
          label: tool.label?.(args) || call.name,
        });
        try {
          const out = await tool.run(args, {
            ...toolContext,
            usage,
            signal,
            deadline,
            remainingUsd: Math.max(0, maxUsd - spentUsd()),
          });
          content = truncateForModel(out?.content ?? "ok");
          if (Number(out?.usd) > 0) {
            usage.extraUsd += Number(out.usd);
            // Breakdown (subsets of extraUsd) used by the cost receipt.
            if (out.webSearches) usage.searchUsd += Number(out.usd);
            else if (out.images) usage.imageUsd += Number(out.usd);
          }
          if (out?.webSearches) usage.webSearches += out.webSearches;
          if (out?.images) usage.images += out.images;
          for (const artifact of out?.artifacts || []) {
            artifacts.push(artifact);
            emit({ type: "artifact", artifact });
          }
        } catch (error) {
          // Tool failures are reported to the model so it can adapt; provider/auth
          // failures that make continuing pointless are rethrown.
          if (error?.fatal) throw error;
          content = `Error: ${String(error?.message || "tool failed").slice(0, 400)}`;
        }
        emit({ type: "agent_tool", phase: "end", tool: call.name });
      }
      convo.push({ role: "tool", tool_call_id: call.id, content });
    }
  }

  return {
    answer,
    usage,
    artifacts,
    steps,
    toolCalls: toolCallCount,
    stopReason,
    finishReason,
    providerUsd: spentUsd(),
    elapsedMs: Date.now() - startedAt,
  };
}
