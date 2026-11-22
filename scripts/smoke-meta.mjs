// Live smoke test of the code paths AiWay relies on, using YOUR Meta key:
//   META_API_KEY=... node scripts/smoke-meta.mjs [--images]
// Chat/tool/search checks cost a fraction of a cent; --images adds two images (~$0.02).
import { runCompletion } from "../server/features/agents/llm.js";
import { searchWeb } from "../server/features/agents/web-search.js";
import { museImage } from "../server/features/images/muse.js";
import { metaConfigured } from "../server/providers/meta.js";

if (!metaConfigured()) {
  console.error("Set META_API_KEY first.");
  process.exit(2);
}
const withImages = process.argv.includes("--images");
let failed = 0;
async function check(name, work) {
  const started = Date.now();
  try {
    const note = await work();
    console.log(
      `PASS ${name} (${Date.now() - started} ms)${note ? ` — ${note}` : ""}`,
    );
  } catch (error) {
    failed++;
    console.log(
      `FAIL ${name}: [${error.code || error.name}] ${error.message}`,
      error.meta?.internalMessage || "",
    );
  }
}

await check("streaming chat + reasoning_effort + usage", async () => {
  let streamed = "";
  const r = await runCompletion({
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
    maxTokens: 200,
    reasoningEffort: "minimal",
    onDelta: (t) => (streamed += t),
  });
  if (!streamed.trim()) throw new Error("no streamed text");
  if (!r.usage.prompt_tokens) throw new Error("no usage on the final chunk");
  return `"${streamed.trim().slice(0, 40)}", ${r.usage.prompt_tokens}+${r.usage.completion_tokens} tokens`;
});

await check("streamed tool call round trip", async () => {
  const tool = {
    name: "get_weather",
    description: "Get the weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  };
  const messages = [
    { role: "user", content: "What is the weather in Cairo? Use the tool." },
  ];
  const first = await runCompletion({
    messages,
    tools: [tool],
    maxTokens: 400,
    reasoningEffort: "low",
  });
  if (!first.toolCalls.length)
    throw new Error(
      `model did not call the tool (finish: ${first.finishReason})`,
    );
  const args = JSON.parse(first.toolCalls[0].arguments);
  const second = await runCompletion({
    messages: [
      ...messages,
      {
        role: "assistant",
        content: first.text || null,
        tool_calls: first.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      },
      {
        role: "tool",
        tool_call_id: first.toolCalls[0].id,
        content: JSON.stringify({ temp_c: 24 }),
      },
    ],
    tools: [tool],
    maxTokens: 400,
    reasoningEffort: "low",
  });
  if (!/24/.test(second.text))
    throw new Error(
      `answer did not use the tool result: ${second.text.slice(0, 80)}`,
    );
  return `called ${first.toolCalls[0].name}(${JSON.stringify(args)})`;
});

await check("web_search via the Responses API", async () => {
  const r = await searchWeb(
    "Pi Network hackathon Pi Next final submission deadline",
  );
  if (!r.summary) throw new Error("empty summary");
  return `${r.sources.length} source(s), ~$${r.usd.toFixed(4)}`;
});

if (withImages) {
  let first;
  await check("image generation", async () => {
    first = await museImage({
      prompt: "A flat purple logo of a compass on white",
      aspectRatio: "1:1",
    });
    return `${first.mediaType}, ${first.bytes.length} bytes`;
  });
  await check("image edit (JSON images array)", async () => {
    if (!first) throw new Error("needs the generation step");
    const ref = `data:${first.mediaType};base64,${first.bytes.toString("base64")}`;
    const r = await museImage({
      prompt: "Make the logo green",
      aspectRatio: null,
      references: [ref],
    });
    return `${r.mediaType}, ${r.bytes.length} bytes`;
  });
}
console.log(
  failed
    ? `\n${failed} check(s) failed — see docs/AGENTS.md "Verification status".`
    : "\nAll checks passed.",
);
process.exit(failed ? 1 : 0);
