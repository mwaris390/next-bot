/* eslint-disable @typescript-eslint/no-explicit-any */
// Shared Binance USDT-M futures client. Every scanner page imports this
// instead of hitting fapi directly so they share one rate-limit budget —
// Binance's 2400 request-weight/min cap is per IP, not per page.

export const FAPI = "https://fapi.binance.com/fapi/v1";

export const MIN_VOLUME = 5_000_000; // USDT 24h quote volume floor (liquidity)

const PAIRS_CACHE_TTL_MS = 60_000;
export const CANDLE_CACHE_GRACE_MS = 5_000; // let Binance publish the close first
const WEIGHT_SOFT_LIMIT = 1500; // of 2400/min — start idling past this
const WEIGHT_HARD_LIMIT = 2100; // stop issuing new requests this scan
const WEIGHT_COOLDOWN_MS = 5_000;
const DEFAULT_BAN_COOLDOWN_MS = 60_000;

export class RateLimitedError extends Error {}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let usedWeight = 0;
let cooldownUntil = 0;

/** Every Binance call goes through here so weight accounting stays honest. */
export async function binanceFetch(url: string): Promise<any> {
  if (Date.now() < cooldownUntil) {
    throw new RateLimitedError("in rate-limit cooldown");
  }

  const res = await fetch(url, { cache: "no-store" });

  const weightHeader = res.headers.get("x-mbx-used-weight-1m");
  if (weightHeader) usedWeight = parseInt(weightHeader, 10) || usedWeight;

  if (res.status === 429 || res.status === 418) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
    cooldownUntil =
      Date.now() +
      (Number.isFinite(retryAfter) ? retryAfter * 1000 : DEFAULT_BAN_COOLDOWN_MS);
    throw new RateLimitedError(`Binance returned ${res.status}`);
  }

  if (!res.ok) throw new Error(`Binance request failed (${res.status}): ${url}`);
  return res.json();
}

/** True once the shared weight/cooldown state says a scan should hold off. */
export function isThrottled(): boolean {
  return Date.now() < cooldownUntil;
}

export function isNearWeightCap(): boolean {
  return usedWeight >= WEIGHT_HARD_LIMIT;
}

export function isPastWeightSoftCap(): boolean {
  return usedWeight >= WEIGHT_SOFT_LIMIT;
}

export const weightCooldownMs = WEIGHT_COOLDOWN_MS;

export function formatPrice(price: number | string, tickSize: string): string {
  const ts = parseFloat(tickSize);
  const decimals = ts >= 1 ? 0 : Math.abs(Math.floor(Math.log10(ts))) || 2;
  return Number(price).toFixed(decimals);
}

interface Ticker {
  symbol: string;
  quoteVolume: string;
  priceChangePercent: string;
  lastPrice: string;
}

export interface PairData {
  symbol: string;
  changePercent: number;
  volume: number;
  tickSize: string;
  lastPrice: number;
}

let pairsCache: { data: PairData[]; timestamp: number } | null = null;

export async function getFilteredPairs(
  minVolume: number = MIN_VOLUME,
): Promise<PairData[]> {
  if (pairsCache && Date.now() - pairsCache.timestamp < PAIRS_CACHE_TTL_MS) {
    return pairsCache.data;
  }

  try {
    const [exchange, tickers] = await Promise.all([
      binanceFetch(`${FAPI}/exchangeInfo`),
      binanceFetch(`${FAPI}/ticker/24hr`) as Promise<Ticker[]>,
    ]);

    const tickerMap = new Map(tickers.map((t) => [t.symbol, t]));
    const precisionMap = new Map<string, string>();

    const pairs = exchange.symbols
      .filter(
        (s: any) =>
          s.contractType === "PERPETUAL" &&
          s.quoteAsset === "USDT" &&
          s.status === "TRADING",
      )
      .map((s: any) => {
        const priceFilter = s.filters?.find(
          (f: any) => f.filterType === "PRICE_FILTER",
        );
        precisionMap.set(s.symbol, priceFilter?.tickSize ?? "0.01");
        return s.symbol as string;
      })
      .map((symbol: string) => {
        const ticker = tickerMap.get(symbol);
        if (!ticker) return null;

        const volume = parseFloat(ticker.quoteVolume);

        // Filter by minimum 24h quote volume before analysis
        if (volume < minVolume) return null;

        return {
          symbol,
          changePercent: parseFloat(ticker.priceChangePercent || "0"),
          volume,
          tickSize: precisionMap.get(symbol) || "0.01",
          lastPrice: parseFloat(ticker.lastPrice),
        };
      })
      .filter(Boolean) as PairData[];

    pairsCache = { data: pairs, timestamp: Date.now() };
    return pairs;
  } catch (error) {
    // Rate limited mid-refresh: keep the page alive on the previous snapshot.
    if (pairsCache) return pairsCache.data;
    throw error;
  }
}

// Cache key includes the limit — different callers (e.g. two scanners on the
// same interval) may need different amounts of history, and a short cached
// series must never be handed to a caller that asked for more of it.
const klinesCache = new Map<string, { data: any[]; expiresAt: number }>();

/**
 * `ttlMs` is the caller's call because it depends on WHICH candle they read.
 * A scanner that only judges CLOSED candles can hold a series until the next
 * close and spend nothing in between. One that reads the LIVE, still-forming
 * candle must use a short TTL instead, or its indicators freeze at whatever they happened to be when
 * the hour turned.
 */
export async function getKlines(
  symbol: string,
  interval: string,
  limit: number,
  ttlMs: number,
): Promise<any[]> {
  const key = `${symbol}:${interval}:${limit}`;
  const cached = klinesCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const data = await binanceFetch(
      `${FAPI}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    );
    klinesCache.set(key, { data, expiresAt: Date.now() + ttlMs });
    return data;
  } catch (error) {
    // Stale candles beat no candles while we're backing off.
    if (cached) return cached.data;
    throw error;
  }
}

/** True when the given symbol/interval/limit combo isn't already cached. */
export function klinesNeedNetwork(
  symbol: string,
  interval: string,
  limit: number,
): boolean {
  const cached = klinesCache.get(`${symbol}:${interval}:${limit}`);
  return !cached || Date.now() >= cached.expiresAt;
}

// ─────────────────────────── FUNDING ───────────────────────────
// `premiumIndex` with no symbol returns every perp in one call (weight 10), so
// the whole universe's funding costs one request per candle.

let fundingCache: { data: Map<string, number>; expiresAt: number } | null = null;

/** Last funding rate (fraction per 8h) by symbol, or null if unavailable. */
export async function getFundingRates(ttlMs: number): Promise<Map<string, number> | null> {
  if (fundingCache && Date.now() < fundingCache.expiresAt) return fundingCache.data;
  try {
    const rows = (await binanceFetch(`${FAPI}/premiumIndex`)) as {
      symbol: string;
      lastFundingRate: string;
    }[];
    const data = new Map<string, number>();
    for (const row of rows) {
      const rate = parseFloat(row.lastFundingRate);
      if (Number.isFinite(rate)) data.set(row.symbol, rate);
    }
    fundingCache = { data, expiresAt: Date.now() + ttlMs };
    return data;
  } catch {
    // Context, not content: a stale map beats none, none beats a broken page.
    return fundingCache?.data ?? null;
  }
}

// ─────────────────────────── OPEN INTEREST ───────────────────────────
// Per-symbol only, so it is fetched for the rows on screen and nothing else.
// These `/futures/data` endpoints sit outside the 2400-weight budget (their own
// 1000 requests / 5 min), but they still go through binanceFetch so a 429
// puts the whole client into cooldown.

const OI_URL = "https://fapi.binance.com/futures/data/openInterestHist";
const OI_BARS = 24;
const oiCache = new Map<string, { change: number; expiresAt: number }>();

/** % change in open interest (contracts) over the last 24 hourly snapshots. */
async function getOpenInterestChange(symbol: string, ttlMs: number): Promise<number | null> {
  const cached = oiCache.get(symbol);
  if (cached && Date.now() < cached.expiresAt) return cached.change;
  try {
    const rows = (await binanceFetch(
      `${OI_URL}?symbol=${symbol}&period=1h&limit=${OI_BARS + 1}`,
    )) as { sumOpenInterest: string; timestamp: number }[];
    if (rows.length < 2) return null;
    const sorted = [...rows].sort((a, b) => a.timestamp - b.timestamp);
    const first = parseFloat(sorted[0].sumOpenInterest);
    const last = parseFloat(sorted[sorted.length - 1].sumOpenInterest);
    if (!(first > 0) || !Number.isFinite(last)) return null;
    const change = ((last - first) / first) * 100;
    oiCache.set(symbol, { change, expiresAt: Date.now() + ttlMs });
    return change;
  } catch {
    return cached?.change ?? null;
  }
}

/** Open-interest change for a handful of symbols; missing ones are skipped. */
export async function getOpenInterestChanges(
  symbols: string[],
  ttlMs: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(symbols)];
  for (let i = 0; i < unique.length; i += 10) {
    if (isThrottled()) break;
    const chunk = unique.slice(i, i + 10);
    const values = await Promise.all(chunk.map((s) => getOpenInterestChange(s, ttlMs)));
    chunk.forEach((s, j) => {
      if (values[j] != null) out.set(s, values[j]!);
    });
  }
  return out;
}
