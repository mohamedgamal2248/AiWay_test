import "./setup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as piPrice from "../server/providers/pi-price.js";
import { runCompletion } from "../server/features/agents/llm.js";
import {
  TOKEN_USD,
  MARKUP,
  PI_PRICE_BUFFER,
  tokensForUsd,
  chargeTokens,
} from "../server/domain/credits.js";
import { PACKAGES } from "../server/domain/settings.js";
import { META_PRICING } from "../server/domain/meta-models.js";
import { sse, textChunks } from "./helpers/agents.mjs";

async function withFetch(fake, work) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}
const okx = (last) =>
  Response.json({
    code: "0",
    data: [{ last: String(last), bidPx: String(last), askPx: String(last) }],
  });
const resetCache = () => {
  // The cache is a module-level object; expiring it forces a fresh lookup.
  piPrice.piPriceCache.price = 0;
  piPrice.piPriceCache.expires = 0;
  piPrice.piPriceCache.quotedAt = null;
};

test("Pi price comes from OKX and other markets are not even asked while OKX works", async () => {
  resetCache();
  const asked = [];
  await withFetch(
    async (url) => {
      asked.push(String(url));
      return okx(0.055);
    },
    async () => assert.equal(await piPrice.getPiUsd(), 0.055),
  );
  assert.equal(asked.length, 1);
  assert.match(asked[0], /okx\.com.*PI-USDT/);
  assert.match(piPrice.piPriceCache.source, /OKX/);
});

test("when OKX fails the next market is used in order, never the fastest", async () => {
  resetCache();
  const asked = [];
  await withFetch(
    async (url) => {
      asked.push(new URL(url).hostname);
      if (asked.length === 1) return new Response("down", { status: 503 });
      return Response.json([{ last: "0.0551" }]);
    },
    async () => assert.equal(await piPrice.getPiUsd(), 0.0551),
  );
  assert.deepEqual(asked, ["www.okx.com", "api.gateio.ws"]);
});

test("a very low but real Pi price is accepted, nonsense is rejected", () => {
  assert.equal(piPrice.validPiPrice(0.0042), 0.0042);
  assert.equal(piPrice.validPiPrice(0), 0);
  assert.equal(piPrice.validPiPrice(5000), 0);
  assert.equal(piPrice.validPiPrice("abc"), 0);
});

test("a recent quote survives a short outage but an old one does not", async () => {
  resetCache();
  await withFetch(
    async () => okx(0.06),
    () => piPrice.getPiUsd(),
  );
  piPrice.piPriceCache.expires = 0; // expired for caching purposes
  await withFetch(
    async () => new Response("x", { status: 500 }),
    async () => assert.equal(await piPrice.getPiUsd(), 0.06),
  );
  piPrice.piPriceCache.quotedAt = new Date(
    Date.now() - 11 * 60_000,
  ).toISOString();
  await withFetch(
    async () => new Response("x", { status: 500 }),
    async () =>
      assert.rejects(
        piPrice.getPiUsd(),
        (e) => e.code === "OKX_PRICE_UNAVAILABLE",
      ),
  );
});

test("default packages keep a 50% provider share and a Pi amount that includes the price buffer", () => {
  assert.equal(MARKUP, 2);
  for (const [id, pack] of Object.entries(PACKAGES)) {
    // tokens are sold so that provider cost of all tokens == half of the USD price
    assert.ok(
      Math.abs(pack.tokens * TOKEN_USD - pack.usd * 0.5) < 1e-6,
      `${id}: ${pack.tokens} tokens for $${pack.usd}`,
    );
  }
  assert.equal(tokensForUsd(10), 500000);
  assert.equal(PI_PRICE_BUFFER, 0.05);
});

test("a chat turn is billed at exactly Meta's price, so the 2x markup is the margin", () => {
  const { pricing } = { pricing: META_PRICING.chat };
  const charge = chargeTokens(pricing, {
    prompt_tokens: 3000,
    completion_tokens: 600,
  });
  const metaCost = 3000 * 0.1e-6 + 600 * 0.5e-6;
  assert.ok(Math.abs(charge.providerUsd - metaCost) < 1e-12);
  assert.equal(charge.chargedTokens, Math.ceil(metaCost / TOKEN_USD));
  // user paid $0.00002 per token: revenue is twice the provider cost
  const revenue = charge.chargedTokens * TOKEN_USD * MARKUP;
  assert.ok(revenue >= 2 * metaCost - 2e-5);
});

test("reasoning tokens are never under-billed whichever way the provider reports them", async () => {
  const stream = (usage) => sse(...textChunks("ok", usage));
  const cases = [
    // completion already includes reasoning (OpenAI style)
    [
      {
        prompt_tokens: 100,
        completion_tokens: 80,
        total_tokens: 180,
        completion_tokens_details: { reasoning_tokens: 50 },
      },
      80,
    ],
    // completion excludes reasoning; the total reveals it
    [
      {
        prompt_tokens: 100,
        completion_tokens: 30,
        total_tokens: 180,
        completion_tokens_details: { reasoning_tokens: 50 },
      },
      80,
    ],
    // no total, reasoning larger than completion
    [
      {
        prompt_tokens: 100,
        completion_tokens: 30,
        completion_tokens_details: { reasoning_tokens: 50 },
      },
      80,
    ],
  ];
  for (const [usage, expected] of cases) {
    const r = await withFetch(
      async () => stream(usage),
      () => runCompletion({ messages: [{ role: "user", content: "x" }] }),
    );
    assert.equal(r.usage.completion_tokens, expected, JSON.stringify(usage));
  }
});
