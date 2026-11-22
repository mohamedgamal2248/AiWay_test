import { fetchWithTimeout, appError } from "../core/http.js";

export let piPriceCache = {
  price: 0,
  expires: 0,
  quotedAt: null,
  source: null,
};

export function validPiPrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0.001 && price < 100 ? price : 0;
}

export async function fetchPiPriceSource(source) {
  const headers = { Accept: "application/json", "User-Agent": "AiWay/1.0" };
  if (source === "OKX") {
    const response = await fetchWithTimeout(
      "https://www.okx.com/api/v5/market/ticker?instId=PI-USDT",
      { headers },
      4500,
    );
    if (!response.ok) throw new Error(`OKX ${response.status}`);
    const payload = await response.json();
    if (String(payload?.code || "0") !== "0")
      throw new Error(String(payload?.msg || "OKX ticker failed"));
    const ticker = payload?.data?.[0] || {};
    const last = validPiPrice(ticker.last),
      bid = validPiPrice(ticker.bidPx),
      ask = validPiPrice(ticker.askPx);
    const price = last || (bid && ask ? (bid + ask) / 2 : 0);
    if (!price) throw new Error("Invalid OKX PI price");
    return { price, source: "OKX PI-USDT spot ticker" };
  }
  if (source === "Gate.io") {
    const response = await fetchWithTimeout(
      "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=PI_USDT",
      { headers },
      4500,
    );
    if (!response.ok) throw new Error(`Gate.io ${response.status}`);
    const payload = await response.json();
    const ticker = Array.isArray(payload) ? payload[0] : payload || {};
    const last = validPiPrice(ticker.last),
      bid = validPiPrice(ticker.highest_bid),
      ask = validPiPrice(ticker.lowest_ask);
    const price = last || (bid && ask ? (bid + ask) / 2 : 0);
    if (!price) throw new Error("Invalid Gate.io PI price");
    return { price, source: "Gate.io PI_USDT spot ticker" };
  }
  const response = await fetchWithTimeout(
    "https://api.mexc.com/api/v3/ticker/price?symbol=PIUSDT",
    { headers },
    4500,
  );
  if (!response.ok) throw new Error(`MEXC ${response.status}`);
  const payload = await response.json();
  const price = validPiPrice(payload?.price);
  if (!price) throw new Error("Invalid MEXC PI price");
  return { price, source: "MEXC PIUSDT spot ticker" };
}

// OKX is the reference market. Gate.io and MEXC are only consulted, in that order, when
// OKX itself fails, so a quote never silently comes from a different venue while OKX is up.
const FALLBACK_SOURCES = ["OKX", "Gate.io", "MEXC"];
// A quote older than this is never reused when every market is down.
const MAX_STALE_MS = 10 * 60_000;

export async function getPiUsd() {
  if (piPriceCache.price > 0 && Date.now() < piPriceCache.expires)
    return piPriceCache.price;
  const failures = [];
  for (const source of FALLBACK_SOURCES) {
    try {
      const quote = await fetchPiPriceSource(source);
      piPriceCache = {
        price: quote.price,
        source: quote.source,
        expires: Date.now() + 60_000,
        quotedAt: new Date().toISOString(),
      };
      return quote.price;
    } catch (error) {
      failures.push(`${source}: ${error?.message || error}`);
    }
  }
  console.warn("All Pi price providers failed", failures);
  // Brief outage: the 5% price buffer covers a few minutes of drift.
  if (
    piPriceCache.price > 0 &&
    piPriceCache.quotedAt &&
    Date.now() - Date.parse(piPriceCache.quotedAt) < MAX_STALE_MS
  )
    return piPriceCache.price;
  throw appError("OKX_PRICE_UNAVAILABLE", {
    internalMessage: "All configured Pi price providers are unavailable",
  });
}
