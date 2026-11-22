import "./setup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAgent,
  compactToolResults,
} from "../server/features/agents/runner.js";
import { runCompletion } from "../server/features/agents/llm.js";
import { buildZip } from "../server/features/agents/zip.js";
import { requireSafePath } from "../server/features/agents/artifacts.js";
import { validateProject } from "../server/features/agents/tools/project-check.js";
import { piBuilderTools } from "../server/features/agents/tools/workspace.js";
import { imageTools } from "../server/features/agents/tools/image.js";
import {
  resolveAgent,
  isAgentTask,
  agentTools,
} from "../server/features/agents/registry.js";
import { setDatabaseClientForTests } from "../server/core/runtime.js";
import { signAppToken } from "../server/features/auth/service.js";
import chatHandler from "../api/chat.js";
import {
  fakeClient,
  memoryStorage,
  sse,
  textChunks,
  toolCallChunks,
  readZip,
} from "./helpers/agents.mjs";

async function withFetch(fake, work) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}
const usage = (p = 100, c = 50) => ({
  prompt_tokens: p,
  completion_tokens: c,
  total_tokens: p + c,
});
const scripted = (steps) => {
  let i = 0;
  return async (_url, options) => {
    const step = steps[Math.min(i++, steps.length - 1)];
    return typeof step === "function" ? step(options) : step;
  };
};

test("completion parser accumulates streamed tool calls by index and reads final usage", async () => {
  const deltas = [];
  await withFetch(
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, "muse-ember-1.0");
      assert.equal(body.stream_options.include_usage, true);
      assert.equal(body.reasoning_effort, "low");
      assert.ok(body.max_completion_tokens >= 64);
      assert.equal(body.tools[0].function.name, "write_file");
      return sse(
        ...toolCallChunks(
          [
            { name: "write_file", args: { path: "a.txt", content: "hello" } },
            { name: "list_files", args: {} },
          ],
          usage(10, 5),
        ),
      );
    },
    async () => {
      const result = await runCompletion({
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "write_file",
            description: "d",
            parameters: { type: "object" },
          },
        ],
        onDelta: (t) => deltas.push(t),
      });
      assert.equal(result.toolCalls.length, 2);
      assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), {
        path: "a.txt",
        content: "hello",
      });
      assert.equal(result.toolCalls[1].name, "list_files");
      assert.equal(result.finishReason, "tool_calls");
      assert.equal(result.usage.prompt_tokens, 10);
    },
  );
});

test("provider errors surface as controlled error codes", async () => {
  await withFetch(
    async () =>
      Response.json(
        { error: { message: "Rate limit exceeded" } },
        { status: 429 },
      ),
    async () => {
      await assert.rejects(
        runCompletion({ messages: [] }),
        (e) => e.code === "RATE_LIMITED",
      );
    },
  );
});

test("agent loop runs tools, feeds results back and returns the final answer with summed usage", async () => {
  const seen = [];
  const tool = {
    name: "echo",
    description: "echo",
    parameters: { type: "object" },
    async run(args) {
      seen.push(args);
      return { content: `echo:${args.text}`, usd: 0.001 };
    },
  };
  let call = 0;
  const complete = async ({ messages, tools, onDelta }) => {
    call++;
    if (call === 1) {
      assert.equal(tools.length, 1);
      return {
        text: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: '{"text":"x"}' }],
        finishReason: "tool_calls",
        usage: usage(1000, 100),
      };
    }
    const last = messages.at(-1);
    assert.equal(last.role, "tool");
    assert.equal(last.content, "echo:x");
    assert.equal(last.tool_call_id, "c1");
    onDelta("done");
    return {
      text: "done",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(1200, 20),
    };
  };
  const events = [];
  const run = await runAgent({
    messages: [{ role: "user", content: "go" }],
    tools: [tool],
    budget: { usd: 1 },
    emit: (e) => events.push(e.type),
    complete,
  });
  assert.equal(run.answer, "done");
  assert.equal(run.steps, 2);
  assert.equal(run.toolCalls, 1);
  assert.equal(run.usage.prompt_tokens, 2200);
  assert.equal(run.usage.extraUsd, 0.001);
  assert.ok(run.providerUsd > 0.001);
  assert.deepEqual(seen, [{ text: "x" }]);
  assert.ok(events.includes("agent_tool") && events.includes("delta"));
});

test("unknown tools and malformed arguments are reported to the model, not thrown", async () => {
  const results = [];
  let call = 0;
  const run = await runAgent({
    messages: [{ role: "user", content: "go" }],
    tools: [
      {
        name: "ok",
        description: "",
        parameters: {},
        run: async () => ({ content: "fine" }),
      },
    ],
    budget: { usd: 1 },
    complete: async ({ messages, onDelta }) => {
      call++;
      if (call === 1)
        return {
          text: "",
          toolCalls: [
            { id: "a", name: "nope", arguments: "{}" },
            { id: "b", name: "ok", arguments: "{broken" },
          ],
          finishReason: "tool_calls",
          usage: usage(),
        };
      results.push(
        ...messages.filter((m) => m.role === "tool").map((m) => m.content),
      );
      onDelta("ok");
      return {
        text: "ok",
        toolCalls: [],
        finishReason: "stop",
        usage: usage(),
      };
    },
  });
  assert.equal(run.answer, "ok");
  assert.match(results[0], /unknown tool/);
  assert.match(results[1], /valid JSON/);
});

test("a looping model is forced to a final tool-free answer when steps run out", async () => {
  let toolsOffered = [];
  let call = 0;
  const run = await runAgent({
    messages: [{ role: "user", content: "go" }],
    tools: [
      {
        name: "t",
        description: "",
        parameters: {},
        run: async () => ({ content: "r" }),
      },
    ],
    budget: { usd: 1, maxSteps: 3 },
    complete: async ({ tools, onDelta }) => {
      call++;
      toolsOffered.push(tools.length);
      if (tools.length)
        return {
          text: "",
          toolCalls: [{ id: `c${call}`, name: "t", arguments: "{}" }],
          finishReason: "tool_calls",
          usage: usage(),
        };
      onDelta("final");
      return {
        text: "final",
        toolCalls: [],
        finishReason: "stop",
        usage: usage(),
      };
    },
  });
  assert.equal(run.answer, "final");
  assert.equal(run.stopReason, "steps");
  assert.deepEqual(toolsOffered, [1, 1, 1, 0]);
});

test("the cost budget stops a run before it can overspend", async () => {
  let call = 0;
  const run = await runAgent({
    messages: [{ role: "user", content: "go" }],
    tools: [
      {
        name: "t",
        description: "",
        parameters: {},
        run: async () => ({ content: "r", usd: 0.004 }),
      },
    ],
    budget: { usd: 0.005, maxSteps: 10 },
    complete: async ({ tools, onDelta }) => {
      call++;
      if (tools.length)
        return {
          text: "",
          toolCalls: [{ id: `c${call}`, name: "t", arguments: "{}" }],
          finishReason: "tool_calls",
          usage: usage(100, 10),
        };
      onDelta("wrapped up");
      return {
        text: "wrapped up",
        toolCalls: [],
        finishReason: "stop",
        usage: usage(100, 10),
      };
    },
  });
  assert.equal(run.stopReason, "cost");
  assert.ok(run.providerUsd <= 0.005 + 0.0001, `spent ${run.providerUsd}`);
});

test("old tool outputs are compacted once the context grows large", () => {
  const big = "x".repeat(60_000);
  const messages = [
    { role: "system", content: "s" },
    ...Array.from({ length: 6 }, (_, i) => ({
      role: "tool",
      tool_call_id: String(i),
      content: big,
    })),
  ];
  const out = compactToolResults(messages);
  assert.match(out[1].content, /compacted/);
  assert.equal(out.at(-1).content.length, 60_000);
});

test("unsafe file paths are rejected", () => {
  for (const bad of ["../x", "/etc/passwd", "a/../../b", "C:\\x", "a\0b", ""])
    assert.throws(
      () => requireSafePath(bad),
      (e) => e.code === "INVALID_REQUEST",
    );
  assert.equal(requireSafePath("./css/style.css"), "css/style.css");
});

test("ZIP keeps folder structure and compresses text", () => {
  const files = [
    { path: "index.html", content: "<h1>مرحبا</h1>".repeat(50) },
    { path: "css/style.css", content: "body{margin:0}" },
    { path: "js/app.js", content: "console.log(1)" },
  ];
  const read = readZip(buildZip(files));
  assert.deepEqual(Object.keys(read).sort(), [
    "css/style.css",
    "index.html",
    "js/app.js",
  ]);
  assert.equal(read["index.html"], files[0].content);
  assert.throws(() => buildZip([{ path: "../evil", content: "x" }]));
});

test("project validation flags broken links, syntax errors and client-side secrets", () => {
  const files = new Map([
    [
      "index.html",
      '<!doctype html><html lang="en"><head><meta name="viewport" content="x"><title>t</title></head><body><script src="js/app.js"></script><script src="missing.js"></script><a href="privacy-policy.html">p</a></body></html>',
    ],
    ["privacy-policy.html", "<html></html>"],
    [
      "js/app.js",
      'fetch("https://api.minepi.com/v2/payments/1/approve",{headers:{Authorization:"Key abcdefghijklmnop1234"}}',
    ],
  ]);
  const { errors } = validateProject(files);
  const text = errors.join("\n");
  assert.match(text, /missing file "missing.js"/);
  assert.match(text, /syntax error/);
  assert.match(text, /payments server API from client code/);
  assert.match(text, /hard-coded Pi API key/);
});

test("a clean Pi project validates without errors", () => {
  const html =
    '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>App</title><script src="https://sdk.minepi.com/pi-sdk.js"></script></head><body><script src="app.js"></script></body></html>';
  const files = new Map([
    ["index.html", html],
    ["privacy-policy.html", "<html lang='en'></html>"],
    ["app.js", 'Pi.init({version:"2.0"});'],
  ]);
  assert.deepEqual(validateProject(files).errors, []);
});

test("builder tools write, edit, validate and package a project; the workspace persists", async () => {
  const storage = memoryStorage();
  const ctx = {
    supabase: fakeClient({}, undefined, storage),
    userId: "u1",
    conversationId: "c1",
    finalizers: [],
    artifacts: [],
    remainingUsd: 1,
    usage: { webSearches: 0 },
  };
  const tools = Object.fromEntries(
    (await piBuilderTools(ctx)).map((t) => [t.name, t]),
  );
  assert.deepEqual(Object.keys(tools).sort(), [
    "delete_file",
    "edit_file",
    "list_files",
    "package_project",
    "read_file",
    "validate_project",
    "web_search",
    "write_file",
  ]);
  await tools.write_file.run(
    {
      path: "index.html",
      content:
        '<html lang="en"><head><meta name="viewport" content="x"><title>t</title></head><body>hi</body></html>',
    },
    ctx,
  );
  await tools.write_file.run({ path: "css/a.css", content: "body{}" }, ctx);
  await tools.edit_file.run(
    { path: "css/a.css", old_string: "body{}", new_string: "body{margin:0}" },
    ctx,
  );
  await assert.rejects(
    tools.write_file.run({ path: "../x", content: "" }, ctx),
  );
  await assert.rejects(
    tools.edit_file.run(
      { path: "css/a.css", old_string: "nope", new_string: "" },
      ctx,
    ),
  );
  assert.match(
    (await tools.read_file.run({ path: "css/a.css" }, ctx)).content,
    /margin:0/,
  );
  const packed = await tools.package_project.run({ name: "My Pi App!" }, ctx);
  assert.equal(packed.artifacts[0].name, "my-pi-app.zip");
  assert.equal(packed.artifacts[0].kind, "project");
  const zipBytes = storage.objects.get(
    `agent-files/${packed.artifacts[0].path}`,
  );
  assert.deepEqual(Object.keys(readZip(zipBytes)).sort(), [
    "css/a.css",
    "index.html",
  ]);
  for (const finalize of ctx.finalizers) await finalize();
  // A later request in the same conversation continues the same project.
  const next = { ...ctx, finalizers: [], artifacts: [] };
  const tools2 = Object.fromEntries(
    (await piBuilderTools(next)).map((t) => [t.name, t]),
  );
  assert.match((await tools2.list_files.run({}, next)).content, /index\.html/);
});

test("package_project refuses while validation errors remain unless forced", async () => {
  const ctx = {
    supabase: fakeClient({}, undefined, memoryStorage()),
    userId: "u1",
    conversationId: "c2",
    finalizers: [],
    artifacts: [],
  };
  const tools = Object.fromEntries(
    (await piBuilderTools(ctx)).map((t) => [t.name, t]),
  );
  await tools.write_file.run({ path: "app.js", content: "function (" }, ctx);
  await assert.rejects(tools.package_project.run({}, ctx), /fix these errors/);
  const forced = await tools.package_project.run({ force: true }, ctx);
  assert.equal(forced.artifacts.length, 1);
});

test("image tool bills per image, skips blocked results and stores private artifacts", async () => {
  const storage = memoryStorage();
  const ctx = {
    supabase: fakeClient({}, undefined, storage),
    userId: "u1",
    conversationId: "c1",
    artifacts: [],
    remainingUsd: 0.05,
  };
  const png = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4,
  ]).toString("base64");
  let n = 0;
  const [generate] = imageTools();
  await withFetch(
    async (url, options) => {
      assert.ok(String(url).endsWith("/images/generations"));
      const body = JSON.parse(options.body);
      assert.equal(body.model, "muse-image-1.0");
      assert.equal(body.size, "1792x1024");
      return ++n === 2
        ? Response.json(
            {
              error: {
                message: "blocked by content policy",
                code: "content_policy_violation",
              },
            },
            { status: 400 },
          )
        : Response.json({
            data: [{ b64_json: png }],
            usage: { input_tokens: 5, output_tokens: 0 },
          });
    },
    async () => {
      const out = await generate.run(
        { prompt: "a cat", aspect_ratio: "16:9", count: 3 },
        ctx,
      );
      assert.equal(out.images, 2);
      assert.ok(Math.abs(out.usd - 0.02) < 1e-9);
      assert.equal(out.artifacts.length, 2);
      assert.match(out.content, /not billed/);
      assert.equal(storage.objects.size, 2);
    },
  );
});

test("image tool never generates more images than the remaining budget allows", async () => {
  const [generate] = imageTools();
  await assert.rejects(
    generate.run(
      { prompt: "x", count: 4 },
      {
        supabase: fakeClient(),
        userId: "u",
        conversationId: "c",
        artifacts: [],
        remainingUsd: 0.005,
      },
    ),
    /not enough balance/,
  );
});

test("agent registry exposes three agents and treats everything else as chat", () => {
  assert.equal(isAgentTask("pi-app-builder"), true);
  assert.equal(isAgentTask("all-models"), false);
  assert.equal(resolveAgent("coding").id, "chat");
  assert.deepEqual(
    agentTools()
      .map((a) => a.id)
      .sort(),
    ["general-agent", "image-agent", "pi-app-builder"],
  );
  assert.equal(resolveAgent("image-agent").allowTrial, false);
});

function streamResponse() {
  return {
    headers: {},
    chunks: [],
    status(n) {
      this.statusCode = n;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
      return this;
    },
    getHeader(k) {
      return this.headers[k];
    },
    flushHeaders() {
      this.headersSent = true;
    },
    write(value) {
      this.chunks.push(value);
    },
    end(value) {
      if (value) this.chunks.push(value);
      this.writableEnded = true;
    },
    get events() {
      return this.chunks
        .join("")
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)));
    },
    get json() {
      return JSON.parse(this.chunks.join(""));
    },
  };
}

function agentFixture(profile, { messages } = {}) {
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    pi_uid: "owner",
    username: "owner",
    role: "user",
    ...profile,
  };
  const calls = [],
    inserts = [],
    storage = memoryStorage();
  setDatabaseClientForTests(
    fakeClient(
      {
        users: { data: user, error: null },
        conversations: { data: { id: "conversation" }, error: null },
        ai_tools: { data: [], error: null },
        messages: (q) => {
          if (q.operation === "insert") inserts.push(q.patch);
          return messages
            ? messages(q)
            : { data: { id: "assistant-one" }, error: null };
        },
      },
      async (name, args) => {
        calls.push([name, args]);
        return {
          data:
            name === "reserve_ai_tokens"
              ? { status: "reserved" }
              : name === "finalize_ai_tokens"
                ? 1234
                : true,
          error: null,
        };
      },
      storage,
    ),
  );
  return { user, calls, inserts, storage };
}

const body = (taskId, extra = {}) => ({
  conversationId: "conversation",
  taskId,
  requestId: `req-${taskId}-${Math.random().toString(36).slice(2, 8)}`,
  messages: [{ role: "user", content: "Build a Pi app" }],
  ...extra,
});

const goodIndex =
  '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>App</title></head><body>Hi</body></html>';

test("Pi App Builder run: tools, ZIP artifact, capped reservation and one finalize", async () => {
  const { user, calls, inserts, storage } = agentFixture({
    has_purchased: true,
    ai_tokens: 100000,
  });
  const token = await signAppToken(user);
  const res = streamResponse();
  const requests = [];
  await withFetch(
    scripted([
      (r) => {
        requests.push(JSON.parse(r.body));
        return sse(
          { choices: [{ delta: { content: "Planning. " } }] },
          ...toolCallChunks(
            [
              {
                name: "write_file",
                args: { path: "index.html", content: goodIndex },
              },
              {
                name: "write_file",
                args: { path: "privacy-policy.html", content: goodIndex },
              },
              { name: "package_project", args: { name: "demo" } },
            ],
            usage(2000, 800),
          ),
        );
      },
      (r) => {
        requests.push(JSON.parse(r.body));
        return sse(...textChunks("Your app is ready.", usage(3000, 100)));
      },
    ]),
    async () => {
      await chatHandler(
        {
          method: "POST",
          query: {},
          headers: { authorization: "Bearer " + token },
          body: body("pi-app-builder"),
        },
        res,
      );
    },
  );
  const events = res.events;
  assert.equal(res.statusCode, 200, JSON.stringify(events));
  const done = events.find((e) => e.type === "done");
  assert.ok(done, JSON.stringify(events));
  assert.equal(done.agentId, "pi-app-builder");
  assert.equal(done.artifacts.length, 1);
  assert.equal(done.artifacts[0].name, "demo.zip");
  assert.equal(
    done.artifacts[0].path,
    undefined,
    "storage path must not reach the browser",
  );
  assert.ok(events.some((e) => e.type === "artifact"));
  assert.ok(
    events.some((e) => e.type === "agent_tool" && e.tool === "package_project"),
  );

  const reserve = calls.find(([n]) => n === "reserve_ai_tokens");
  assert.equal(reserve[1].p_kind, "other");
  assert.equal(reserve[1].p_amount, 6000);
  const finalize = calls.filter(([n]) => n === "finalize_ai_tokens");
  assert.equal(finalize.length, 1);
  assert.ok(finalize[0][1].p_actual >= 1 && finalize[0][1].p_actual <= 6000);
  assert.equal(calls.filter(([n]) => n === "release_ai_tokens").length, 0);

  const assistant = inserts.find((m) => m.role === "assistant");
  assert.equal(assistant.token_usage.artifacts.length, 1);
  assert.ok(assistant.token_usage.artifacts[0].path.startsWith(user.id));
  assert.equal(assistant.token_usage.agentId, "pi-app-builder");
  assert.equal(assistant.content, "Planning. \n\nYour app is ready.");
  assert.equal(
    storage.objects.size >= 2,
    true,
    "zip + workspace snapshot stored",
  );
  // The model saw the tool definitions and the tool results on the second call.
  assert.ok(requests[0].tools.some((t) => t.function.name === "write_file"));
  assert.equal(requests[1].messages.filter((m) => m.role === "tool").length, 3);
});

test("agent run failure releases the reservation and bills nothing", async () => {
  const { user, calls } = agentFixture({
    has_purchased: true,
    ai_tokens: 100000,
  });
  const token = await signAppToken(user);
  const res = streamResponse();
  await withFetch(
    async () =>
      Response.json({ error: { message: "overloaded" } }, { status: 503 }),
    async () => {
      await chatHandler(
        {
          method: "POST",
          query: {},
          headers: { authorization: "Bearer " + token },
          body: body("general-agent"),
        },
        res,
      );
    },
  );
  assert.ok(
    res.statusCode >= 500 || res.events.some((e) => e.type === "error"),
  );
  assert.equal(calls.filter(([n]) => n === "release_ai_tokens").length, 1);
  assert.equal(calls.filter(([n]) => n === "finalize_ai_tokens").length, 0);
});

test("low balances get a smaller loop budget instead of being refused", async () => {
  const { user, calls } = agentFixture({ has_purchased: true, ai_tokens: 800 });
  const token = await signAppToken(user);
  const res = streamResponse();
  await withFetch(
    async () => sse(...textChunks("ok", usage(200, 20))),
    async () => {
      await chatHandler(
        {
          method: "POST",
          query: {},
          headers: { authorization: "Bearer " + token },
          body: body("general-agent"),
        },
        res,
      );
    },
  );
  assert.ok(
    res.events.some((e) => e.type === "done"),
    JSON.stringify(res.events),
  );
  const reserve = calls.find(([n]) => n === "reserve_ai_tokens")[1].p_amount;
  assert.equal(reserve, 784);
});

test("balances below the agent minimum are refused before anything is reserved", async () => {
  const { user, calls } = agentFixture({ has_purchased: true, ai_tokens: 100 });
  const token = await signAppToken(user);
  const res = streamResponse();
  await chatHandler(
    {
      method: "POST",
      query: {},
      headers: { authorization: "Bearer " + token },
      body: body("pi-app-builder"),
    },
    res,
  );
  assert.equal(res.statusCode, 402, JSON.stringify(res.chunks));
  assert.equal(calls.filter(([n]) => n === "reserve_ai_tokens").length, 0);
});

test("free-trial users can try agents with a capped budget and no paid tools", async () => {
  const { user, calls } = agentFixture({
    has_purchased: false,
    free_trial_tokens: 5,
    ai_tokens: 0,
  });
  const token = await signAppToken(user);
  const res = streamResponse();
  const requests = [];
  await withFetch(
    async (_u, o) => {
      requests.push(JSON.parse(o.body));
      return sse(...textChunks("Trial answer", usage(500, 50)));
    },
    async () => {
      await chatHandler(
        {
          method: "POST",
          query: {},
          headers: { authorization: "Bearer " + token },
          body: body("pi-app-builder"),
        },
        res,
      );
    },
  );
  assert.ok(
    res.events.some((e) => e.type === "done"),
    JSON.stringify(res.events),
  );
  assert.equal(
    calls.filter(([n]) => n === "claim_aiway_free_trial_token").length,
    1,
  );
  assert.equal(calls.filter(([n]) => n === "reserve_ai_tokens").length, 0);
  const names = requests[0].tools.map((t) => t.function.name);
  assert.ok(
    !names.includes("web_search"),
    "trial runs get no paid search tool",
  );
  assert.ok(names.includes("write_file"));
});

test("the Image Agent stays locked until the first purchase", async () => {
  const { user, calls } = agentFixture({
    has_purchased: false,
    free_trial_tokens: 5,
    ai_tokens: 0,
  });
  const token = await signAppToken(user);
  const res = streamResponse();
  await chatHandler(
    {
      method: "POST",
      query: {},
      headers: { authorization: "Bearer " + token },
      body: body("image-agent"),
    },
    res,
  );
  assert.ok(res.statusCode >= 400, JSON.stringify(res.chunks));
  assert.equal(
    calls.filter(([n]) => /reserve|claim|finalize/.test(n)).length,
    0,
  );
});

test("artifact tickets only serve files owned by the ticket user", async () => {
  const artifact = {
    id: "art-1",
    name: "demo.zip",
    mime: "application/zip",
    size: 3,
    path: "u/c/art-1/demo.zip",
    kind: "project",
  };
  const { user, storage } = agentFixture(
    { has_purchased: true, ai_tokens: 1000 },
    {
      messages: () => ({
        data: {
          id: "m1",
          role: "assistant",
          token_usage: { artifacts: [artifact] },
        },
        error: null,
      }),
    },
  );
  storage.objects.set(`agent-files/${artifact.path}`, Buffer.from("zip"));
  const token = await signAppToken(user);
  const prep = streamResponse();
  await chatHandler(
    {
      method: "POST",
      query: {},
      headers: { authorization: "Bearer " + token },
      body: {
        action: "prepare-artifact",
        messageId: "m1",
        artifactId: "art-1",
      },
    },
    prep,
  );
  const { url } = prep.json;
  assert.match(url, /action=artifact-download&ticket=/);
  const ticket = decodeURIComponent(url.split("ticket=")[1]);
  const file = streamResponse();
  await chatHandler(
    {
      method: "GET",
      query: { action: "artifact-download", ticket },
      headers: {},
    },
    file,
  );
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers["Content-Type"], "application/zip");
  assert.match(file.headers["Content-Disposition"], /^attachment;/);
  assert.equal(
    file.headers["Content-Security-Policy"].includes("sandbox"),
    true,
  );
  // A view ticket cannot be used as a download ticket and non-images cannot be viewed inline.
  const wrong = streamResponse();
  await chatHandler(
    { method: "GET", query: { action: "artifact-view", ticket }, headers: {} },
    wrong,
  );
  assert.ok(wrong.statusCode >= 400);
});

// ---- General Agent: documents, ingestion, bounded reading ----------------------
import { renderPdf } from "../server/features/agents/documents/pdf.js";
import { renderDocx } from "../server/features/agents/documents/docx.js";
import { renderPptx } from "../server/features/agents/documents/pptx.js";
import { renderXlsx } from "../server/features/agents/documents/xlsx.js";
import {
  normalizeDocument,
  normalizeDeck,
  normalizeWorkbook,
  cleanFilename,
} from "../server/features/agents/documents/spec.js";
import {
  extractDocument,
  detectKind,
} from "../server/features/agents/files/extract.js";
import { ingestAttachments } from "../server/features/agents/files/ingest.js";
import { generalAgentTools } from "../server/features/agents/tools/files.js";
import {
  reorderVisual,
  firstStrongRtl,
} from "../server/features/agents/documents/pdf.js";

const sampleSections = [
  {
    heading: "Overview",
    paragraphs: ["AiWay agents create files. Needle-alpha lives here."],
    bullets: ["Pay with Pi", "عربي أولًا"],
    table: { headers: ["Item", "Value"], rows: [["Users", "1,200"]] },
  },
];

test("every document renderer produces a valid file that can be read back", async () => {
  const doc = normalizeDocument({ title: "Report", sections: sampleSections });
  const pdf = await renderPdf(doc);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const pdfDoc = await extractDocument({
    name: "r.pdf",
    mime: "application/pdf",
    bytes: pdf,
  });
  assert.match(pdfDoc.pages[0].text, /Needle-alpha/);

  const docx = await renderDocx(doc);
  assert.equal(docx.subarray(0, 2).toString(), "PK");
  const docxDoc = await extractDocument({
    name: "r.docx",
    mime: "",
    bytes: docx,
  });
  assert.equal(docxDoc.kind, "docx");
  assert.match(docxDoc.pages[0].text, /Needle-alpha/);

  const deck = await renderPptx(
    normalizeDeck({
      title: "Deck",
      slides: [
        { title: "One", bullets: ["alpha"], notes: "note-beta" },
        { title: "Two", text: "gamma" },
      ],
    }),
  );
  const deckDoc = await extractDocument({
    name: "d.pptx",
    mime: "",
    bytes: deck,
  });
  assert.equal(deckDoc.pages.length, 3);
  assert.match(deckDoc.pages[1].text, /alpha/);
  assert.match(deckDoc.pages[1].text, /note-beta/);

  const xlsx = await renderXlsx(
    normalizeWorkbook({
      sheets: [
        {
          name: "S",
          headers: ["a", "b"],
          rows: [
            ["x", 1],
            ["total", "=SUM(B2:B2)"],
          ],
        },
      ],
    }),
  );
  const xlsxDoc = await extractDocument({
    name: "w.xlsx",
    mime: "",
    bytes: xlsx,
  });
  assert.match(xlsxDoc.pages[0].text, /total \| =SUM\(B2:B2\)/);
});

test("renderers reject oversized or empty specs", () => {
  assert.throws(() => normalizeDocument({ sections: [] }), /no content/);
  assert.throws(() => normalizeDeck({ slides: [] }), /no slides/);
  assert.throws(() => normalizeWorkbook({ sheets: [] }), /no sheets/);
  const huge = { sections: [{ paragraphs: Array(60).fill("x".repeat(6000)) }] };
  assert.throws(() => normalizeDocument(huge), /too long/);
  assert.equal(cleanFilename("../../etc/passwd", "pdf"), "etc-passwd.pdf");
  assert.equal(cleanFilename("", "docx"), "document.docx");
  assert.equal(cleanFilename("تقرير", "pdf"), "تقرير.pdf");
});

test("RTL line layout reorders by Unicode levels and picks direction from the first strong letter", () => {
  const items = [
    { t: "ar1", level: 1 },
    { t: "ar2", level: 1 },
    { t: "en1", level: 2 },
    { t: "en2", level: 2 },
    { t: "ar3", level: 1 },
  ];
  assert.deepEqual(
    reorderVisual(items).map((i) => i.t),
    ["ar3", "en1", "en2", "ar2", "ar1"],
  );
  assert.equal(firstStrongRtl("مرحبا Hello"), true);
  assert.equal(firstStrongRtl("Hello مرحبا"), false);
  assert.equal(firstStrongRtl("123 !?"), null);
  assert.equal(detectKind("a.xlsx"), "xlsx");
  assert.equal(detectKind("x", "application/pdf"), "pdf");
});

function generalCtx(storage, extra = {}) {
  return {
    supabase: fakeClient(
      { messages: { data: [], error: null } },
      undefined,
      storage,
    ),
    userId: "u1",
    conversationId: "c1",
    artifacts: [],
    storedFiles: [],
    remainingUsd: 1,
    usage: { webSearches: 0 },
    ...extra,
  };
}

test("large attachments reach the model as a compact manifest and are read in bounded slices", async () => {
  const storage = memoryStorage();
  const paragraphs = Array.from({ length: 400 }, (_, i) =>
    i === 321
      ? "The secret launch codename is Zanzibar-77 and appears only here."
      : `Paragraph ${i}: ${"lorem ipsum dolor ".repeat(12)}`,
  );
  const big = paragraphs.join("\n\n");
  assert.ok(big.length > 80_000);
  const prepared = await ingestAttachments({
    supabase: fakeClient({}, undefined, storage),
    userId: "u1",
    conversationId: "c1",
    attachments: [{ name: "big.txt", type: "text/plain", text: big }],
    baseText: "Summarize",
    locale: "en",
  });
  assert.ok(
    prepared.text.length < 4000,
    `manifest is ${prepared.text.length} chars`,
  );
  assert.match(prepared.text, /file_id: /);
  assert.doesNotMatch(prepared.text, /Zanzibar/);
  const stored = prepared.storedFiles[0];
  assert.ok(stored.textPath && stored.path && stored.pages > 20);
  assert.equal(storage.objects.size, 2, "original + extracted text sidecar");

  const ctx = generalCtx(storage, { storedFiles: prepared.storedFiles });
  const tools = Object.fromEntries(
    (await generalAgentTools(ctx)).map((t) => [t.name, t]),
  );
  assert.deepEqual(Object.keys(tools).sort(), [
    "create_docx",
    "create_pdf",
    "create_pptx",
    "create_text_file",
    "create_xlsx",
    "list_files",
    "read_file",
    "search_in_file",
    "web_search",
  ]);

  const found = await tools.search_in_file.run(
    { query: "Zanzibar launch codename", file_id: stored.id },
    ctx,
  );
  assert.match(found.content, /Zanzibar-77/);
  const part = Number(found.content.match(/\[part (\d+)\]/)[1]);
  const read = await tools.read_file.run({ file_id: stored.id, part }, ctx);
  assert.match(read.content, /Zanzibar-77/);
  assert.ok(
    read.content.length <= 9400,
    `read returned ${read.content.length} chars`,
  );
  const first = await tools.read_file.run({ file_id: stored.id }, ctx);
  assert.match(first.content, /next: part=/);
  await assert.rejects(
    tools.read_file.run({ file_id: "nope" }, ctx),
    /unknown file_id/,
  );
  await assert.rejects(
    tools.read_file.run({ file_id: stored.id, part: 9999 }, ctx),
    /only \d+ parts/,
  );
  const listed = await tools.list_files.run({}, ctx);
  assert.match(listed.content, /big\.txt/);
});

test("the agent can read back a document it created earlier in the same run", async () => {
  const storage = memoryStorage();
  const ctx = generalCtx(storage);
  const tools = Object.fromEntries(
    (await generalAgentTools(ctx)).map((t) => [t.name, t]),
  );
  const made = await tools.create_docx.run(
    { filename: "plan", title: "Plan", sections: sampleSections },
    ctx,
  );
  const id = made.artifacts[0].id;
  const found = await tools.search_in_file.run({ query: "needle-alpha" }, ctx);
  assert.match(found.content, new RegExp(id));
  const read = await tools.read_file.run({ file_id: id }, ctx);
  assert.match(read.content, /Needle-alpha/);
});

test("Arabic search ignores diacritics and alef variants", async () => {
  const storage = memoryStorage();
  const prepared = await ingestAttachments({
    supabase: fakeClient({}, undefined, storage),
    userId: "u1",
    conversationId: "c1",
    attachments: [
      {
        name: "ar.txt",
        type: "text/plain",
        text: "أُحِبُّ منصة أيواي للذكاء الاصطناعي",
      },
    ],
    baseText: "x",
    locale: "ar",
  });
  const ctx = generalCtx(storage, { storedFiles: prepared.storedFiles });
  const tools = Object.fromEntries(
    (await generalAgentTools(ctx)).map((t) => [t.name, t]),
  );
  const found = await tools.search_in_file.run({ query: "احب ايواي" }, ctx);
  assert.match(found.content, /ar\.txt/);
});

test("General Agent request: attachment is stored and never pasted; document tools are offered", async () => {
  const { user, inserts } = agentFixture({
    has_purchased: true,
    ai_tokens: 100000,
  });
  const token = await signAppToken(user);
  const res = streamResponse();
  const big = "Very long document line.\n\n".repeat(8000);
  let sent;
  await withFetch(
    async (_u, o) => {
      sent = JSON.parse(o.body);
      return sse(...textChunks("Summary ready", usage(900, 30)));
    },
    async () => {
      await chatHandler(
        {
          method: "POST",
          query: {},
          headers: { authorization: "Bearer " + token },
          body: body("general-agent", {
            attachments: [
              {
                name: "report.txt",
                type: "text/plain",
                size: big.length,
                text: big,
              },
            ],
          }),
        },
        res,
      );
    },
  );
  assert.ok(
    res.events.some((e) => e.type === "done"),
    JSON.stringify(res.events),
  );
  const userMessage = sent.messages.find((m) => m.role === "user");
  assert.ok(
    String(userMessage.content).length < 5000,
    "the file must not be pasted into the prompt",
  );
  assert.match(String(userMessage.content), /file_id:/);
  const names = sent.tools.map((t) => t.function.name);
  for (const expected of [
    "read_file",
    "search_in_file",
    "create_pdf",
    "create_docx",
    "create_xlsx",
    "create_pptx",
    "web_search",
  ])
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  const saved = inserts.find((m) => m.role === "user");
  assert.ok(
    saved.token_usage.attachments[0].fileId,
    "the stored file id is kept on the user message",
  );
});

test("preview URLs are issued only for the owner's image artifacts", async () => {
  const artifacts = [
    {
      id: "img-1",
      name: "a.png",
      mime: "image/png",
      size: 1,
      path: "u/c/img-1/a.png",
      kind: "image",
    },
    {
      id: "zip-1",
      name: "p.zip",
      mime: "application/zip",
      size: 1,
      path: "u/c/zip-1/p.zip",
      kind: "project",
    },
  ];
  const { user } = agentFixture(
    { has_purchased: true, ai_tokens: 1000 },
    {
      messages: () => ({
        data: { id: "m1", role: "assistant", token_usage: { artifacts } },
        error: null,
      }),
    },
  );
  const token = await signAppToken(user);
  const res = streamResponse();
  await chatHandler(
    {
      method: "POST",
      query: {},
      headers: { authorization: "Bearer " + token },
      body: { action: "prepare-artifact-views", messageId: "m1" },
    },
    res,
  );
  assert.deepEqual(Object.keys(res.json.urls), ["img-1"]);
  assert.match(res.json.urls["img-1"], /action=artifact-view&ticket=/);
});

test("deleting a conversation removes its agent files from storage", async () => {
  const { removeConversationFiles } = await import(
    "../server/features/agents/artifacts.js"
  );
  const removed = [];
  const tree = {
    "u1/c1": [
      { name: "art1", id: null },
      { name: "uploads", id: null },
      { name: "_workspace.json", id: "x" },
    ],
    "u1/c1/art1": [{ name: "report.pdf", id: "y" }],
    "u1/c1/uploads": [{ name: "f1", id: null }],
    "u1/c1/uploads/f1": [
      { name: "doc.docx", id: "z" },
      { name: "text.json", id: "w" },
    ],
  };
  const client = {
    storage: {
      from: () => ({
        list: async (prefix) => ({ data: tree[prefix] || [], error: null }),
        remove: async (paths) => {
          removed.push(...paths);
          return { error: null };
        },
      }),
    },
  };
  const count = await removeConversationFiles(client, "u1", "c1");
  assert.equal(count, 4);
  assert.deepEqual(removed.sort(), [
    "u1/c1/_workspace.json",
    "u1/c1/art1/report.pdf",
    "u1/c1/uploads/f1/doc.docx",
    "u1/c1/uploads/f1/text.json",
  ]);
  // A storage failure never blocks deleting the conversation.
  const broken = {
    storage: {
      from: () => ({
        list: async () => {
          throw new Error("down");
        },
      }),
    },
  };
  assert.equal(await removeConversationFiles(broken, "u1", "c1"), 0);
});
