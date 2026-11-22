import "./setup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { buildReceipt } from "../server/features/agents/receipt.js";
import { runAgent } from "../server/features/agents/runner.js";
import {
  TEMPLATES,
  templateBlueprint,
  templateCatalog,
} from "../server/features/agents/templates.js";
import { piAppBuilderPrompt } from "../server/features/agents/prompts.js";
import {
  safeProjectPath,
  PREVIEW_CSP,
} from "../server/features/agents/preview.js";
import { setDatabaseClientForTests } from "../server/core/runtime.js";
import { signAppToken } from "../server/features/auth/service.js";
import chatHandler from "../api/chat.js";
import modelsHandler from "../api/models.js";
import {
  fakeClient,
  memoryStorage,
  sse,
  textChunks,
} from "./helpers/agents.mjs";

const usage = (p = 100, c = 50) => ({
  prompt_tokens: p,
  completion_tokens: c,
  total_tokens: p + c,
});
function res() {
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
    write(v) {
      this.chunks.push(v);
    },
    end(v) {
      if (v) this.chunks.push(v);
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
async function withFetch(fake, work) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}
const OWNER = "11111111-1111-4111-8111-111111111111";
function setup(profile, messages) {
  const user = {
    id: OWNER,
    pi_uid: "o",
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
                ? 1
                : true,
          error: null,
        };
      },
      storage,
    ),
  );
  return { user, calls, inserts, storage };
}

test("the receipt lines always add up to the amount charged", () => {
  const u = {
    prompt_tokens: 9000,
    completion_tokens: 2000,
    reasoning_tokens: 0,
    webSearches: 2,
    images: 1,
    modelUsd: 0.0019,
    extraUsd: 0.0075 + 0.01,
    searchUsd: 0.0075,
    imageUsd: 0.01,
  };
  const r = buildReceipt({
    usage: u,
    chargedTokens: 1894,
    steps: 3,
    toolCalls: 4,
    elapsedMs: 9000,
  });
  assert.equal(
    r.lines.reduce((n, l) => n + l.tokens, 0),
    1894,
  );
  assert.deepEqual(
    r.lines.map((l) => l.key),
    ["ai", "search", "images"],
  );
  assert.equal(r.lines[1].count, 2);
  // Clamped charge below the tool costs: scaled down, still reconciled, never negative.
  const clamped = buildReceipt({
    usage: u,
    chargedTokens: 500,
    steps: 3,
    toolCalls: 4,
    elapsedMs: 1,
  });
  assert.equal(
    clamped.lines.reduce((n, l) => n + l.tokens, 0),
    500,
  );
  assert.ok(clamped.lines.every((l) => l.tokens >= 0));
});

test("the runner reports search and image spend separately for the receipt", async () => {
  let n = 0;
  const run = await runAgent({
    messages: [{ role: "user", content: "go" }],
    tools: [
      {
        name: "s",
        description: "",
        parameters: {},
        run: async () => ({ content: "r", usd: 0.003, webSearches: 1 }),
      },
      {
        name: "i",
        description: "",
        parameters: {},
        run: async () => ({ content: "r", usd: 0.01, images: 1 }),
      },
    ],
    budget: { usd: 1 },
    complete: async ({ tools, onDelta }) => {
      n++;
      if (n === 1)
        return {
          text: "",
          toolCalls: [
            { id: "a", name: "s", arguments: "{}" },
            { id: "b", name: "i", arguments: "{}" },
          ],
          finishReason: "tool_calls",
          usage: usage(),
        };
      onDelta("done");
      return {
        text: "done",
        toolCalls: [],
        finishReason: "stop",
        usage: usage(),
      };
    },
  });
  assert.ok(Math.abs(run.usage.searchUsd - 0.003) < 1e-9);
  assert.ok(Math.abs(run.usage.imageUsd - 0.01) < 1e-9);
  assert.ok(Math.abs(run.usage.extraUsd - 0.013) < 1e-9);
});

test("templates: six blueprints, public catalog hides them, prompt receives the chosen one", () => {
  assert.equal(Object.keys(TEMPLATES).length, 6);
  for (const t of Object.values(TEMPLATES)) {
    assert.match(t.blueprint, /privacy-policy\.html/);
    assert.ok(t.name_ar && t.name_en && t.example_ar && t.example_en);
  }
  assert.ok(templateCatalog().every((t) => !("blueprint" in t)));
  assert.equal(templateBlueprint("nope"), "");
  assert.match(templateBlueprint("shop"), /server\/approve\.js/);
  assert.match(
    piAppBuilderPrompt({ language: "en", template: templateBlueprint("shop") }),
    /TEMPLATE BLUEPRINT/,
  );
  assert.doesNotMatch(
    piAppBuilderPrompt({ language: "en" }),
    /TEMPLATE BLUEPRINT/,
  );
  assert.match(piAppBuilderPrompt({ language: "en" }), /RESUMING/);
});

test("/api/models exposes the template catalog and a lower upper bound for a user-chosen cap", async () => {
  setup({ has_purchased: true, ai_tokens: 100000 });
  const out = res();
  await modelsHandler({ method: "GET", query: {}, headers: {} }, out);
  assert.equal(out.json.templates.length, 6);
  const token = await signAppToken({
    id: OWNER,
    pi_uid: "o",
    username: "owner",
    role: "user",
  });
  const est = res();
  await modelsHandler(
    {
      method: "POST",
      query: {},
      headers: { authorization: "Bearer " + token },
      body: {
        action: "estimate-message",
        taskId: "pi-app-builder",
        runCapTokens: 1500,
      },
    },
    est,
  );
  assert.equal(est.json.chargedTokens, 1500);
  const full = res();
  await modelsHandler(
    {
      method: "POST",
      query: {},
      headers: { authorization: "Bearer " + token },
      body: { action: "estimate-message", taskId: "pi-app-builder" },
    },
    full,
  );
  assert.equal(full.json.chargedTokens, 6000);
});

test("a per-run cap lowers the reservation, a template reaches the model, and the receipt is saved and sent", async () => {
  const { user, calls, inserts } = setup({
    has_purchased: true,
    ai_tokens: 100000,
  });
  const token = await signAppToken(user);
  const out = res();
  let system = "";
  await withFetch(
    async (_u, o) => {
      system = JSON.parse(o.body).messages[0].content;
      return sse(...textChunks("Done.", usage(800, 120)));
    },
    async () => {
      await chatHandler(
        {
          method: "POST",
          query: {},
          headers: { authorization: "Bearer " + token },
          body: {
            conversationId: "conversation",
            taskId: "pi-app-builder",
            requestId: "req-cap-1",
            templateId: "donations",
            runCapTokens: 1000,
            messages: [{ role: "user", content: "A campaign for a library" }],
          },
        },
        out,
      );
    },
  );
  const reserve = calls.find(([n]) => n === "reserve_ai_tokens")[1];
  assert.equal(reserve.p_amount, 1000);
  assert.match(system, /TEMPLATE BLUEPRINT/);
  assert.match(system, /goal progress bar/);
  const done = out.events.find((e) => e.type === "done");
  assert.ok(done.receipt.total >= 1);
  assert.equal(
    done.receipt.lines.reduce((n, l) => n + l.tokens, 0),
    done.receipt.total,
  );
  assert.equal(done.capTokens, 1000);
  const saved = inserts.find((m) => m.role === "assistant").token_usage;
  assert.equal(saved.billing, "paid");
  assert.equal(saved.templateId, "donations");
  assert.deepEqual(saved.receipt, done.receipt);
  // An unknown template id adds nothing.
  const out2 = res();
  await withFetch(
    async (_u, o) => {
      system = JSON.parse(o.body).messages[0].content;
      return sse(...textChunks("ok", usage()));
    },
    async () => {
      await chatHandler(
        {
          method: "POST",
          query: {},
          headers: { authorization: "Bearer " + token },
          body: {
            conversationId: "conversation",
            taskId: "pi-app-builder",
            requestId: "req-cap-2",
            templateId: "evil",
            messages: [{ role: "user", content: "x" }],
          },
        },
        out2,
      );
    },
  );
  assert.doesNotMatch(system, /TEMPLATE BLUEPRINT/);
});

test("trial runs ignore the cap and are labelled as trial", async () => {
  const { user, calls, inserts } = setup({
    has_purchased: false,
    free_trial_tokens: 5,
    ai_tokens: 0,
  });
  const token = await signAppToken(user);
  const out = res();
  await withFetch(
    async () => sse(...textChunks("ok", usage())),
    async () => {
      await chatHandler(
        {
          method: "POST",
          query: {},
          headers: { authorization: "Bearer " + token },
          body: {
            conversationId: "conversation",
            taskId: "pi-app-builder",
            requestId: "req-trial-cap",
            runCapTokens: 100,
            messages: [{ role: "user", content: "x" }],
          },
        },
        out,
      );
    },
  );
  assert.equal(calls.filter(([n]) => n === "reserve_ai_tokens").length, 0);
  assert.equal(
    inserts.find((m) => m.role === "assistant").token_usage.billing,
    "trial",
  );
});

async function projectFixture() {
  const zip = new JSZip();
  zip.file(
    "shop/index.html",
    '<!doctype html><link rel="stylesheet" href="css/style.css"><script src="js/app.js"></script><h1>Shop</h1>',
  );
  zip.file("shop/css/style.css", "body{color:#111}");
  zip.file("shop/js/app.js", "document.title='x'");
  const bytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
  const artifact = {
    id: "art-zip",
    name: "shop.zip",
    mime: "application/zip",
    size: bytes.length,
    path: `${OWNER}/c/art-zip/shop.zip`,
    kind: "project",
  };
  return { bytes, artifact };
}

test("preview: ticketed URL serves project files under a sandbox CSP and nothing outside the project", async () => {
  const { bytes, artifact } = await projectFixture();
  const { user, storage } = setup(
    { has_purchased: true, ai_tokens: 1000 },
    () => ({
      data: {
        id: "m1",
        role: "assistant",
        token_usage: { artifacts: [artifact] },
      },
      error: null,
    }),
  );
  storage.objects.set(`agent-files/${artifact.path}`, bytes);
  const token = await signAppToken(user);
  const prep = res();
  await chatHandler(
    {
      method: "POST",
      query: {},
      headers: { authorization: "Bearer " + token },
      body: {
        action: "prepare-preview",
        messageId: "m1",
        artifactId: "art-zip",
      },
    },
    prep,
  );
  const url = prep.json.url;
  assert.match(url, /^\/preview\/[^/]+\/start$/);
  const ticket = decodeURIComponent(url.split("/")[2]);
  const get = async (path) => {
    const r = res();
    await chatHandler(
      {
        method: "GET",
        query: { action: "preview", ticket, path },
        headers: {},
      },
      r,
    );
    return r;
  };
  const start = await get("start");
  assert.equal(start.statusCode, 200);
  const index = await get("index.html");
  assert.equal(index.statusCode, 200);
  assert.match(index.headers["Content-Type"], /text\/html/);
  assert.equal(index.headers["Content-Security-Policy"], PREVIEW_CSP);
  assert.match(PREVIEW_CSP, /^sandbox allow-scripts allow-forms allow-modals;/);
  assert.doesNotMatch(PREVIEW_CSP, /allow-same-origin/);
  assert.match(index.chunks.join(""), /<h1>Shop<\/h1>/);
  assert.equal(
    (await get(["css", "style.css"])).headers["Content-Type"].split(";")[0],
    "text/css",
  );
  assert.equal((await get("js/app.js")).statusCode, 200);
  assert.equal((await get("missing.js")).statusCode, 404);
  assert.ok((await get("../../etc/passwd")).statusCode >= 400);
  // A download ticket is not a preview ticket.
  const dl = res();
  await chatHandler(
    {
      method: "POST",
      query: {},
      headers: { authorization: "Bearer " + token },
      body: {
        action: "prepare-artifact",
        messageId: "m1",
        artifactId: "art-zip",
      },
    },
    dl,
  );
  const dlTicket = decodeURIComponent(dl.json.url.split("ticket=")[1]);
  const bad = res();
  await chatHandler(
    {
      method: "GET",
      query: { action: "preview", ticket: dlTicket, path: "index.html" },
      headers: {},
    },
    bad,
  );
  assert.ok(bad.statusCode >= 400);
});

test("preview refuses artifacts that are not projects or pages", async () => {
  const pdf = {
    id: "a",
    name: "r.pdf",
    mime: "application/pdf",
    size: 1,
    path: `${OWNER}/c/a/r.pdf`,
    kind: "file",
  };
  const { user } = setup({ has_purchased: true, ai_tokens: 10 }, () => ({
    data: { id: "m1", role: "assistant", token_usage: { artifacts: [pdf] } },
    error: null,
  }));
  const token = await signAppToken(user);
  const out = res();
  await chatHandler(
    {
      method: "POST",
      query: {},
      headers: { authorization: "Bearer " + token },
      body: { action: "prepare-preview", messageId: "m1", artifactId: "a" },
    },
    out,
  );
  assert.ok(out.statusCode >= 400);
  assert.equal(safeProjectPath(""), "index.html");
  assert.equal(safeProjectPath("css/"), "css/index.html");
  assert.throws(() => safeProjectPath("a/../b"));
});

test("library lists only agent artifacts with their conversation titles", async () => {
  const rows = [
    {
      id: "m2",
      conversation_id: "c1",
      created_at: "2026-11-22T10:00:00Z",
      token_usage: {
        agentId: "pi-app-builder",
        artifacts: [
          {
            id: "z",
            name: "shop.zip",
            mime: "application/zip",
            size: 10,
            kind: "project",
            path: "secret/path",
          },
        ],
      },
    },
    {
      id: "m1",
      conversation_id: "c2",
      created_at: "2026-11-21T10:00:00Z",
      token_usage: {
        agentId: "image-agent",
        artifacts: [
          {
            id: "i",
            name: "a.png",
            mime: "image/png",
            size: 5,
            kind: "image",
            path: "secret/p2",
          },
        ],
      },
    },
  ];
  const { user } = setup({ has_purchased: true, ai_tokens: 10 }, () => ({
    data: rows,
    error: null,
  }));
  setDatabaseClientForTests(
    fakeClient({
      users: { data: user, error: null },
      messages: { data: rows, error: null },
      conversations: {
        data: [
          { id: "c1", title: "Sticker shop" },
          { id: "c2", title: "Logo" },
        ],
        error: null,
      },
    }),
  );
  const token = await signAppToken(user);
  const out = res();
  await chatHandler(
    {
      method: "POST",
      query: {},
      headers: { authorization: "Bearer " + token },
      body: { action: "library" },
    },
    out,
  );
  const items = out.json.items;
  assert.deepEqual(
    items.map((i) => i.name),
    ["shop.zip", "a.png"],
  );
  assert.equal(items[0].previewable, true);
  assert.equal(items[1].previewable, false);
  assert.equal(items[0].conversationTitle, "Sticker shop");
  assert.ok(
    items.every((i) => !("path" in i)),
    "storage paths never reach the browser",
  );
});

import { aggregateAgentQuality } from "../server/features/admin/agent-quality.js";
import adminStats from "../api/admin-stats.js";

test("agent quality aggregates runs, stop reasons, trial cost and failures per agent", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  const msg = (agentId, u, date = "2026-11-22T10:00:00Z") => ({
    created_at: date,
    token_usage: { agentId, ...u },
  });
  const out = aggregateAgentQuality(
    [
      msg("pi-app-builder", {
        billing: "paid",
        steps: 6,
        toolCalls: 12,
        elapsedMs: 40000,
        chargedTokens: 1000,
        providerUsd: 0.01,
        stopReason: "complete",
        artifacts: [{}],
        templateId: "shop",
      }),
      msg("pi-app-builder", {
        billing: "paid",
        steps: 14,
        toolCalls: 30,
        elapsedMs: 120000,
        chargedTokens: 3000,
        providerUsd: 0.03,
        stopReason: "time",
        artifacts: [{}, {}],
      }),
      msg(
        "pi-app-builder",
        {
          billing: "trial",
          steps: 4,
          toolCalls: 6,
          elapsedMs: 20000,
          chargedTokens: 1,
          providerUsd: 0.008,
          stopReason: "cost",
        },
        "2026-11-21T10:00:00Z",
      ),
      msg("general-agent", {
        billing: "paid",
        steps: 3,
        toolCalls: 4,
        elapsedMs: 15000,
        chargedTokens: 500,
        providerUsd: 0.005,
      }),
    ],
    [
      {
        status: "released",
        created_at: "2026-11-22T09:00:00Z",
        metadata: { code: "RATE_LIMITED" },
      },
      {
        status: "released",
        created_at: "2026-11-22T09:30:00Z",
        metadata: { code: "RATE_LIMITED" },
      },
      { status: "completed", created_at: "2026-11-22T09:40:00Z" },
    ],
    7,
    now,
  );
  assert.equal(out.totals.runs, 4);
  assert.equal(out.totals.failures, 2);
  assert.equal(out.totals.successRate, 66.7);
  const builder = out.agents.find((a) => a.agentId === "pi-app-builder");
  assert.equal(builder.runs, 3);
  assert.equal(builder.trialRuns, 1);
  assert.deepEqual(builder.stop, {
    complete: 1,
    steps: 0,
    time: 1,
    cost: 1,
    other: 0,
  });
  assert.equal(builder.completionRate, 33.3);
  assert.equal(builder.p95Seconds, 120);
  assert.equal(builder.trialCostUsd, 0.008);
  assert.deepEqual(builder.templates, { shop: 1 });
  assert.equal(out.totals.trialCostUsd, 0.008);
  assert.deepEqual(out.errorCodes, [{ code: "RATE_LIMITED", count: 2 }]);
  assert.equal(out.daily.length, 7);
  assert.equal(out.daily.at(-1).runs, 3);
  assert.equal(out.daily.at(-1).failures, 2);
  // Agents with the most runs come first; an empty window is safe.
  assert.equal(out.agents[0].agentId, "pi-app-builder");
  assert.equal(aggregateAgentQuality([], [], 30).totals.successRate, 100);
});

test("the quality endpoint is admin-only", async () => {
  const user = { id: OWNER, pi_uid: "o", username: "u", role: "user" };
  setDatabaseClientForTests(fakeClient({ users: { data: user, error: null } }));
  const token = await signAppToken(user);
  const out = res();
  await adminStats(
    {
      method: "GET",
      query: { mode: "agents-quality" },
      headers: { authorization: "Bearer " + token },
    },
    out,
  );
  assert.ok(
    out.statusCode === 403 || out.statusCode === 401,
    `status ${out.statusCode}`,
  );
  const admin = { ...user, role: "admin" };
  setDatabaseClientForTests(
    fakeClient({
      users: { data: admin, error: null },
      messages: { data: [], error: null },
      ai_token_reservations: { data: [], error: null },
    }),
  );
  const out2 = res();
  await adminStats(
    {
      method: "GET",
      query: { mode: "agents-quality", days: "7" },
      headers: { authorization: "Bearer " + (await signAppToken(admin)) },
    },
    out2,
  );
  assert.equal(out2.statusCode, 200);
  assert.equal(out2.json.days, 7);
});

test("pptxgenjs is only loaded lazily through its CommonJS build (a static import crashed /api/chat on Vercel)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(
    new URL("../server/features/agents/documents/pptx.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(src, /^import .* from "pptxgenjs"/m);
  assert.match(src, /createRequire/);
});
