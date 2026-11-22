import { appError } from "../../core/http.js";
import { metaError } from "../../core/errors.js";
import { streamChat } from "../../providers/meta.js";
import { META_CHAT_MODEL_ID } from "../../domain/meta-models.js";

const IDLE_TIMEOUT_MS = 60_000;

async function readFailure(response) {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// One streamed Chat Completions call. Text deltas are forwarded to `onDelta` as they
// arrive; tool-call deltas are accumulated by `index` (the API may omit id/name on
// continuation chunks). Usage arrives on the final chunk (stream_options.include_usage).
export async function runCompletion({
  messages,
  tools = [],
  maxTokens = 4096,
  reasoningEffort = "low",
  temperature,
  onDelta,
  timeoutMs = 120_000,
  signal,
  model = META_CHAT_MODEL_ID,
}) {
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: Math.max(64, Math.floor(maxTokens)),
    reasoning_effort: reasoningEffort,
  };
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (tools.length)
    body.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

  const response = await streamChat(body, { timeoutMs, signal });
  if (!response.ok)
    throw metaError(response.status, await readFailure(response));
  if (!response.body) throw appError("EMPTY_RESPONSE");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map();
  let buffer = "",
    text = "",
    finishReason = "",
    id = "";
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const readChunk = async () => {
    let timer;
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("Meta stream timed out");
            error.code = "REQUEST_TIMEOUT";
            reject(error);
          }, IDLE_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (error?.code === "REQUEST_TIMEOUT")
        await reader.cancel("idle-timeout").catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk?.error) throw metaError(Number(chunk.error?.code) || 500, chunk);
    id = chunk.id || id;
    if (chunk.usage) {
      const prompt = Number(chunk.usage.prompt_tokens || 0);
      const reasoning = Number(
        chunk.usage.completion_tokens_details?.reasoning_tokens || 0,
      );
      let completion = Number(chunk.usage.completion_tokens || 0);
      const total = Number(chunk.usage.total_tokens || 0);
      // Reasoning tokens are billed as output. Providers differ on whether
      // completion_tokens already includes them, so never bill less than the
      // total implies or than the visible + reasoning parts add up to.
      if (total > prompt + completion) completion = total - prompt;
      else if (reasoning > completion) completion += reasoning;
      usage = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total || prompt + completion,
        reasoning_tokens: reasoning,
        cached_tokens: Number(
          chunk.usage.prompt_tokens_details?.cached_tokens || 0,
        ),
      };
    }
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = String(choice.finish_reason);
    const delta = choice.delta || {};
    const piece =
      typeof delta.content === "string"
        ? delta.content
        : Array.isArray(delta.content)
          ? delta.content.map((part) => part?.text || "").join("")
          : "";
    if (piece) {
      text += piece;
      onDelta?.(piece);
    }
    for (const part of delta.tool_calls || []) {
      const index = Number(part.index ?? 0);
      const call = calls.get(index) || { id: "", name: "", arguments: "" };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name += part.function.name;
      if (part.function?.arguments) call.arguments += part.function.arguments;
      calls.set(index, call);
    }
  };

  while (true) {
    const { done, value } = await readChunk();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) handleLine(line);
  }
  if (buffer.trim()) handleLine(buffer);

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call], i) => ({
      id: call.id || `call_${Date.now().toString(36)}_${i}`,
      name: call.name,
      arguments: call.arguments,
    }))
    .filter((call) => call.name);
  return { id, text, toolCalls, finishReason, usage };
}
