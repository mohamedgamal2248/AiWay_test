// Prints AiWay's unit economics from the real constants and the live OKX Pi price:
//   node scripts/pricing-report.mjs [piUsd]
// Package prices in your database (payment_packages) override the defaults shown here;
// edit them in the admin panel and re-run with the numbers you use.
import {
  TOKEN_USD,
  MARKUP,
  PI_PRICE_BUFFER,
  chargeTokens,
} from "../server/domain/credits.js";
import { PACKAGES } from "../server/domain/settings.js";
import { META_PRICING } from "../server/domain/meta-models.js";
import { AGENTS } from "../server/features/agents/registry.js";
import { fetchPiPriceSource } from "../server/providers/pi-price.js";

let piUsd = Number(process.argv[2]) || 0,
  source = "argument";
if (!piUsd) {
  try {
    ({ price: piUsd, source } = await fetchPiPriceSource("OKX"));
  } catch {
    piUsd = 0.055;
    source = "fallback guess (OKX unreachable)";
  }
}
const usd = (n, d = 4) => `$${n.toFixed(d)}`;
console.log(
  `Pi price: ${usd(piUsd, 5)} (${source}); price buffer ${PI_PRICE_BUFFER * 100}%`,
);
console.log(
  `1 token = ${usd(TOKEN_USD, 5)} of Meta cost; users pay ${MARKUP}x (${usd(TOKEN_USD * MARKUP, 5)} per token)\n`,
);

console.log("PACKAGES (default catalog)");
console.log(
  "name     price   tokens   Pi to pay   revenue*  Meta cost  gross profit",
);
for (const p of Object.values(PACKAGES)) {
  const pi = (p.usd / piUsd) * (1 + PI_PRICE_BUFFER);
  const revenue = p.usd * (1 + PI_PRICE_BUFFER);
  const cost = p.tokens * TOKEN_USD;
  console.log(
    `${p.name_en.padEnd(8)} ${("$" + p.usd).padEnd(7)} ${String(p.tokens).padEnd(8)} ${(pi.toFixed(2) + " Pi").padEnd(11)} ${usd(revenue, 2).padEnd(9)} ${usd(cost, 2).padEnd(10)} ${usd(revenue - cost, 2)} (${(((revenue - cost) / revenue) * 100).toFixed(0)}%)`,
  );
}
console.log(
  "* what you receive at quote time, if every token is used. Unused tokens are pure profit.\n",
);

const row = (label, p, c, extra = 0) => {
  const providerUsd =
    chargeTokens(META_PRICING.chat, { prompt_tokens: p, completion_tokens: c })
      .providerUsd + extra;
  const tokens = Math.ceil(providerUsd / TOKEN_USD);
  const userPays = tokens * TOKEN_USD * MARKUP;
  console.log(
    `${label.padEnd(34)} Meta ${usd(providerUsd).padEnd(9)} ${String(tokens).padStart(5)} tokens  user pays ${usd(userPays).padEnd(8)} (${(userPays / piUsd).toFixed(3)} Pi)  profit ${usd(userPays - providerUsd)}`,
  );
};
console.log("TYPICAL ACTIONS");
row("Chat: short question", 1500, 400);
row("Chat: long answer / code", 6000, 4000);
row("Chat + web search", 2500, 600, META_PRICING.chat.web_search + 0.0007);
row("Image (1)", 0, 0, META_PRICING.image.image);
row("Image Agent: 4 images + prompt", 4000, 500, 4 * META_PRICING.image.image);
row(
  "Pi App Builder: small app",
  35000,
  9000,
  META_PRICING.chat.web_search + 0.0007,
);
row("General Agent: file -> xlsx + pdf", 30000, 4000, 0.0007);

console.log("\nFREE TRIAL (absorbed by you)");
for (const id of ["chat", "pi-app-builder", "general-agent"]) {
  const l = AGENTS[id].limits;
  console.log(`${id.padEnd(16)} up to ${usd(l.trialUsd)} per run`);
}
console.log(
  `10 free uses, worst case: ${usd(10 * AGENTS["pi-app-builder"].limits.trialUsd, 2)} per new user (typical: far less)\n`,
);

const breakEven = 1 - 0.5 / (1 + PI_PRICE_BUFFER);
console.log(
  `PRICE RISK: if you keep the Pi you receive and it falls more than ${(breakEven * 100).toFixed(0)}% before you sell, a fully used package loses money.`,
);
console.log(
  "Selling Pi soon after purchases removes this risk; the 5% buffer only covers the quote window (5 min).",
);
