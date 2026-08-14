/* eslint-disable @typescript-eslint/no-explicit-any */
import { EMA, adx, rsi, atr, sma } from "technicalindicators";
import { unstable_rethrow } from "next/navigation";
import AutoRefresh from "./_components/auto-refresh";
import {
  CANDLE_CACHE_GRACE_MS,
  MIN_VOLUME,
  type PairData,
  RateLimitedError,
  formatPrice,
  getFilteredPairs,
  getKlines,
  isNearWeightCap,
  isPastWeightSoftCap,
  isThrottled,
  klinesNeedNetwork,
  sleep,
  weightCooldownMs,
} from "./_lib/binance";

// Entry timeframe: VWAP cross, DMI/ADX, RSI, RVOL and ATR all read from here.
const ENTRY_INTERVAL = "5m";
// 500 = weight 2 on fapi klines (101–500 bucket) and ~41h of 5m candles,
// which always reaches back past the last UTC midnight for the VWAP anchor.
const ENTRY_KLINE_LIMIT = 500;

// Trend timeframe: EMA50 is read from the 1H chart, not the 5m one.
const TREND_INTERVAL = "1h";
const TREND_KLINE_LIMIT = 200; // ~4x EMA50 period so the average is settled

const EMA_PERIOD = 50; // 1H trend, shown for context only — not a gate
const ADX_PERIOD = 14;
const MIN_ADX = 18; // DMI trend strength gate
const RSI_PERIOD = 14;
const RSI_LONG_MAX = 70; // 1H RSI must be below this for a LONG
const RSI_SHORT_MIN = 40; // 1H RSI must be above this for a SHORT

const ATR_PERIOD = 14;
const ATR_MULTIPLIER = 2.0;
const RISK_REWARD = 1.5;

// VWAP standard-deviation bands: upper/lower = vwap ± N × session stdDev
const VWAP_BAND_STDDEV = 1;

// Each pair now costs two klines calls (5m + 1h), so keep the burst small.
const MAX_CONCURRENT = 6;

// ==================== Rate-limit protection ====================
// Binance fapi allows 2400 request-weight/min per IP, shared across every
// scanner page (see ./_lib/binance). A fully cold scan here is ~150 eligible
// pairs x (2 + 2) weight + 41 for exchangeInfo/ticker, i.e. ~640 — so the
// danger isn't the total, it's bursting and repeated page loads while a scan
// is already in flight. Defences, in order:
//   1. each timeframe's klines are cached until that timeframe's candle
//      actually closes, so refreshing inside a candle costs zero requests and
//      the 1H series is re-fetched at most once an hour;
//   2. batches are staggered;
//   3. the X-MBX-USED-WEIGHT-1M header is read on every response and we idle
//      when it climbs toward the cap;
//   4. a 429/418 puts every caller into a cooldown that serves stale cache
//      instead of hammering the endpoint into an IP ban.
const ENTRY_CANDLE_MS = 5 * 60_000;
const TREND_CANDLE_MS = 60 * 60_000;
const BATCH_DELAY_MS = 120;

interface SignalRow {
  symbol: string;
  side: "LONG" | "SHORT";
  strength: number; // ADX, used for sorting
  price: string;
  ema50: string;
  vwap: string;
  vwapUpper: string;
  vwapLower: string;
  adx: string;
  plusDI: string;
  minusDI: string;
  rsi5m: string;
  rsi1h: string;
  volumeRatio: string;
  atrPercent: string;
  changePercent: string;
  stopLoss: string;
  takeProfit: string;
}

// ==================== Helpers ====================

/**
 * Session VWAP, re-anchored at every UTC midnight — the same line TradingView
 * draws by default — plus ±N standard-deviation bands computed from the same
 * cumulative session stats. Returns one value per candle, plus how many
 * candles deep into the session each one is (a cross is only meaningful once
 * the session has at least two candles behind it).
 */
function sessionVwap(
  klines: any[],
  bandStdDev: number,
): {
  vwap: number[];
  upperBand: number[];
  lowerBand: number[];
  sessionIndex: number[];
} {
  const vwap: number[] = [];
  const upperBand: number[] = [];
  const lowerBand: number[] = [];
  const sessionIndex: number[] = [];

  let cumulativePV = 0;
  let cumulativePV2 = 0;
  let cumulativeVolume = 0;
  let currentDay = -1;
  let index = 0;

  for (const k of klines) {
    const openTime = Number(k[0]);
    const day = Math.floor(openTime / 86_400_000);

    if (day !== currentDay) {
      currentDay = day;
      cumulativePV = 0;
      cumulativePV2 = 0;
      cumulativeVolume = 0;
      index = 0;
    }

    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const close = parseFloat(k[4]);
    const volume = parseFloat(k[5]);
    const typicalPrice = (high + low + close) / 3;

    cumulativePV += typicalPrice * volume;
    cumulativePV2 += typicalPrice * typicalPrice * volume;
    cumulativeVolume += volume;
    index += 1;

    const currentVwap =
      cumulativeVolume > 0 ? cumulativePV / cumulativeVolume : typicalPrice;
    const variance =
      cumulativeVolume > 0
        ? Math.max(cumulativePV2 / cumulativeVolume - currentVwap * currentVwap, 0)
        : 0;
    const stdDev = Math.sqrt(variance);

    vwap.push(currentVwap);
    upperBand.push(currentVwap + bandStdDev * stdDev);
    lowerBand.push(currentVwap - bandStdDev * stdDev);
    sessionIndex.push(index);
  }

  return { vwap, upperBand, lowerBand, sessionIndex };
}

// ==================== Data Fetching ====================

/** 5m entry series + 1H trend series for one pair. */
function getPairKlines(symbol: string): Promise<[any[], any[]]> {
  return Promise.all([
    getKlines(symbol, ENTRY_INTERVAL, ENTRY_KLINE_LIMIT, ENTRY_CANDLE_MS),
    getKlines(symbol, TREND_INTERVAL, TREND_KLINE_LIMIT, TREND_CANDLE_MS),
  ]);
}

/** True when neither timeframe for this pair is still cached. */
function needsNetwork(symbol: string): boolean {
  return (
    klinesNeedNetwork(symbol, ENTRY_INTERVAL, ENTRY_KLINE_LIMIT) ||
    klinesNeedNetwork(symbol, TREND_INTERVAL, TREND_KLINE_LIMIT)
  );
}

// ==================== Analysis ====================
// Candle alignment (both timeframes): the final kline (index -1) is the
// currently forming candle.
// Last CLOSED candle  => index -2   (the "previous candle" we trade off)
// The one before it   => index -3   (used to detect the VWAP cross)

function analyze(
  pair: PairData,
  klines: any[],
  trendKlines: any[],
): SignalRow | null {
  const closes = klines.map((k: any) => parseFloat(k[4]));
  const highs = klines.map((k: any) => parseFloat(k[2]));
  const lows = klines.map((k: any) => parseFloat(k[3]));
  const volumes = klines.map((k: any) => parseFloat(k[5]));

  // ADX needs roughly 2x its period to warm up on the 5m series.
  if (closes.length < ADX_PERIOD * 2 + 60) return null;

  const price = closes.at(-2)!;
  const prevPrice = closes.at(-3)!;
  const lastClosedVolume = volumes.at(-2)!;

  // EMA50 — display only, read from the 1H chart, last CLOSED 1H candle so
  // the value never repaints mid-hour.
  const trendCloses = trendKlines.map((k: any) => parseFloat(k[4]));
  if (trendCloses.length < EMA_PERIOD + 10) return null;
  const lastEMA = EMA.calculate({ period: EMA_PERIOD, values: trendCloses }).at(
    -2,
  );
  if (lastEMA == null) return null;

  // Session VWAP + bands (5m, resets each UTC day)
  const { vwap, upperBand, lowerBand, sessionIndex } = sessionVwap(
    klines,
    VWAP_BAND_STDDEV,
  );
  const lastVwap = vwap.at(-2);
  const prevVwap = vwap.at(-3);
  const lastUpperBand = upperBand.at(-2);
  const prevUpperBand = upperBand.at(-3);
  const lastLowerBand = lowerBand.at(-2);
  const prevLowerBand = lowerBand.at(-3);
  const candlesIntoSession = sessionIndex.at(-2) ?? 0;
  if (
    lastVwap == null ||
    prevVwap == null ||
    lastUpperBand == null ||
    prevUpperBand == null ||
    lastLowerBand == null ||
    prevLowerBand == null
  )
    return null;
  // Right after the UTC rollover VWAP is just the first candle's typical
  // price — no meaningful line to cross yet.
  if (candlesIntoSession < 2) return null;

  // DMI / ADX
  const dmi = adx({
    high: highs,
    low: lows,
    close: closes,
    period: ADX_PERIOD,
  });
  const lastDmi = dmi.at(-2);
  if (lastDmi == null || !Number.isFinite(lastDmi.adx)) return null;
  const { adx: adxValue, pdi: plusDI, mdi: minusDI } = lastDmi;

  // RSI on both timeframes. 5m is shown for context; 1H gates the signal.
  const lastRsi5m = rsi({ period: RSI_PERIOD, values: closes }).at(-2);
  const lastRsi1h = rsi({ period: RSI_PERIOD, values: trendCloses }).at(-2);
  if (lastRsi5m == null || lastRsi1h == null) return null;

  // ATR -> ATR% (SL/TP distance)
  const lastAtr = atr({
    period: ATR_PERIOD,
    high: highs,
    low: lows,
    close: closes,
  }).at(-2);
  if (lastAtr == null) return null;
  const atrPercent = (lastAtr / price) * 100;

  // Relative volume vs 20-candle average — display only
  const lastVolSma = sma({ values: volumes, period: 20 }).at(-2);
  const relativeVolume =
    lastVolSma != null && lastVolSma !== 0 ? lastClosedVolume / lastVolSma : 0;

  // ==================== Entry conditions ====================
  // LONG : 5m close crosses ABOVE session VWAP or its upper band, with
  //        +DI > -DI, ADX > 18, and 1H RSI < 70.
  // SHORT: 5m close crosses BELOW session VWAP or its lower band, with
  //        -DI > +DI, ADX > 18, and 1H RSI > 40.
  const crossedAboveVwap =
    (prevPrice <= prevVwap && price > lastVwap) ||
    (prevPrice <= prevUpperBand && price > lastUpperBand);
  const crossedBelowVwap =
    (prevPrice >= prevVwap && price < lastVwap) ||
    (prevPrice >= prevLowerBand && price < lastLowerBand);
  const bullDmi = plusDI > minusDI;
  const bearDmi = minusDI > plusDI;
  const strongTrend = adxValue > MIN_ADX;

  const shared = {
    symbol: pair.symbol,
    strength: adxValue,
    price: formatPrice(price, pair.tickSize),
    ema50: formatPrice(lastEMA, pair.tickSize),
    vwap: formatPrice(lastVwap, pair.tickSize),
    vwapUpper: formatPrice(lastUpperBand, pair.tickSize),
    vwapLower: formatPrice(lastLowerBand, pair.tickSize),
    adx: adxValue.toFixed(1),
    plusDI: plusDI.toFixed(1),
    minusDI: minusDI.toFixed(1),
    rsi5m: lastRsi5m.toFixed(1),
    rsi1h: lastRsi1h.toFixed(1),
    volumeRatio: relativeVolume.toFixed(2),
    atrPercent: atrPercent.toFixed(2),
    changePercent: pair.changePercent.toFixed(2),
  };

  if (crossedAboveVwap && bullDmi && strongTrend && lastRsi1h < RSI_LONG_MAX) {
    const slValue = price - lastAtr * ATR_MULTIPLIER;
    const risk = price - slValue;
    return {
      ...shared,
      side: "LONG",
      stopLoss: formatPrice(slValue, pair.tickSize),
      takeProfit: formatPrice(price + risk * RISK_REWARD, pair.tickSize),
    };
  }

  if (crossedBelowVwap && bearDmi && strongTrend && lastRsi1h > RSI_SHORT_MIN) {
    const slValue = price + lastAtr * ATR_MULTIPLIER;
    const risk = slValue - price;
    return {
      ...shared,
      side: "SHORT",
      stopLoss: formatPrice(slValue, pair.tickSize),
      takeProfit: formatPrice(price - risk * RISK_REWARD, pair.tickSize),
    };
  }

  return null;
}

// ==================== Scan (concurrent batches) ====================

async function scan(): Promise<{
  signals: SignalRow[];
  rateLimited: boolean;
  scannedAt: number;
}> {
  const pairs = await getFilteredPairs();
  const signals: SignalRow[] = [];
  let rateLimited = false;

  for (let i = 0; i < pairs.length; i += MAX_CONCURRENT) {
    const chunk = pairs.slice(i, i + MAX_CONCURRENT);

    // Everything already cached costs nothing — only throttle real traffic.
    const willHitNetwork = chunk.some((pair) => needsNetwork(pair.symbol));

    if (willHitNetwork && isThrottled()) {
      rateLimited = true;
    } else if (willHitNetwork && isNearWeightCap()) {
      // Too close to the cap to keep going this pass; report what we have.
      rateLimited = true;
      break;
    } else if (willHitNetwork && isPastWeightSoftCap()) {
      await sleep(weightCooldownMs);
    }

    const results = await Promise.all(
      chunk.map(async (pair) => {
        try {
          const [entryKlines, trendKlines] = await getPairKlines(pair.symbol);
          return analyze(pair, entryKlines, trendKlines);
        } catch (error) {
          if (error instanceof RateLimitedError) rateLimited = true;
          else console.log("scan error", pair.symbol, error);
          return null;
        }
      }),
    );

    for (const signal of results) {
      if (signal) signals.push(signal);
    }

    // Stagger batches so a cold cache doesn't burst-fire every klines request
    // at once and trip Binance's request-weight limiter.
    if (willHitNetwork && i + MAX_CONCURRENT < pairs.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return {
    signals: signals.sort((a, b) => b.strength - a.strength),
    rateLimited,
    scannedAt: Date.now(),
  };
}

// ==================== Page ====================

export default async function BinanceFuturesScanner() {
  let signals: SignalRow[] = [];
  let rateLimited = false;
  let scannedAt = 0;

  try {
    const data = await scan();
    signals = data.signals;
    rateLimited = data.rateLimited;
    scannedAt = data.scannedAt;
  } catch (error) {
    // Next signals "this route must render dynamically" by throwing — that's
    // control flow, not a scanner failure, so it has to pass straight through.
    unstable_rethrow(error);
    console.log("scanner error", error);
    return (
      <div className="min-h-screen bg-gray-950 text-red-400 flex items-center justify-center p-10">
        <div className="text-center">
          <h2 className="text-2xl mb-4">Failed to load scanner</h2>
          <p>Please refresh the page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-7xl mx-auto space-y-16">
        <div className="text-center">
          <h1 className="text-5xl font-bold tracking-tight mb-3">
            Binance Futures 5M VWAP Cross Scanner
          </h1>
          <p className="text-gray-400">
            5M VWAP/Band Cross • DMI (+DI/−DI) • ADX &gt; {MIN_ADX} • 1H RSI
            Filter
          </p>
          <AutoRefresh
            candleMs={ENTRY_CANDLE_MS}
            graceMs={CANDLE_CACHE_GRACE_MS}
            scannedAt={scannedAt}
          />
          {rateLimited && (
            <p className="mt-4 inline-block rounded-full bg-amber-500/15 px-4 py-2 text-sm text-amber-400">
              ⚠️ Binance rate limit reached — some pairs were served from cache
              or skipped. Refresh in a minute for a full scan.
            </p>
          )}
        </div>

        {/* Signals */}
        <div className="bg-gray-900 rounded-3xl shadow-2xl p-8">
          <h2 className="text-3xl font-semibold mb-6 text-white flex items-center gap-3">
            🔥 Signals
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-gray-400 border-b border-gray-700">
                <tr>
                  <th className="text-left py-4">Rank</th>
                  <th className="text-left py-4">Pair</th>
                  <th className="text-left py-4">Side</th>
                  <th className="text-left py-4">Price</th>
                  <th className="text-left py-4">1H EMA{EMA_PERIOD}</th>
                  <th className="text-left py-4">VWAP</th>
                  <th className="text-left py-4">VWAP Upper</th>
                  <th className="text-left py-4">VWAP Lower</th>
                  <th className="text-left py-4">ADX</th>
                  <th className="text-left py-4">+DI</th>
                  <th className="text-left py-4">−DI</th>
                  <th className="text-left py-4">RSI 5M</th>
                  <th className="text-left py-4">RSI 1H</th>
                  <th className="text-left py-4">RVOL</th>
                  <th className="text-left py-4">ATR%</th>
                  <th className="text-left py-4">24h %</th>
                  <th className="text-left py-4">SL</th>
                  <th className="text-left py-4">TP</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s, i) => (
                  <tr
                    key={s.symbol}
                    className="border-b border-gray-800 hover:bg-gray-800/70 transition-colors"
                  >
                    <td className="py-4">{i + 1}</td>
                    <td className="py-4 font-semibold">{s.symbol}</td>
                    <td className="py-4">
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-bold ${
                          s.side === "LONG"
                            ? "bg-green-500/20 text-green-400"
                            : "bg-red-500/20 text-red-400"
                        }`}
                      >
                        {s.side}
                      </span>
                    </td>
                    <td className="py-4 font-mono">{s.price}</td>
                    <td className="py-4 font-mono text-gray-300">{s.ema50}</td>
                    <td className="py-4 font-mono text-cyan-400">{s.vwap}</td>
                    <td className="py-4 font-mono text-cyan-300">
                      {s.vwapUpper}
                    </td>
                    <td className="py-4 font-mono text-cyan-300">
                      {s.vwapLower}
                    </td>
                    <td className="py-4 font-medium">{s.adx}</td>
                    <td className="py-4 text-green-400">{s.plusDI}</td>
                    <td className="py-4 text-red-400">{s.minusDI}</td>
                    <td className="py-4">{s.rsi5m}</td>
                    <td className="py-4 text-gray-300">{s.rsi1h}</td>
                    <td className="py-4 font-medium text-blue-400">
                      {s.volumeRatio}×
                    </td>
                    <td className="py-4 font-medium text-purple-400">
                      {s.atrPercent}%
                    </td>
                    <td
                      className={`py-4 font-medium ${
                        parseFloat(s.changePercent) >= 0
                          ? "text-green-400"
                          : "text-red-400"
                      }`}
                    >
                      {parseFloat(s.changePercent) >= 0 ? "+" : ""}
                      {s.changePercent}%
                    </td>
                    <td className="py-4 text-orange-400">{s.stopLoss}</td>
                    <td className="py-4 text-emerald-400">{s.takeProfit}</td>
                  </tr>
                ))}
                {signals.length === 0 && (
                  <tr>
                    <td colSpan={18} className="py-12 text-center text-gray-500">
                      No VWAP/band cross signals on the last closed 5m candle
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-center text-xs text-gray-500">
          Closed candles only, never the forming one • LONG = 5M close crosses
          ABOVE session VWAP or its upper band ({VWAP_BAND_STDDEV}σ) +
          &plus;DI &gt; &minus;DI + ADX &gt; {MIN_ADX} + 1H RSI &lt;{" "}
          {RSI_LONG_MAX} • SHORT = 5M close crosses BELOW session VWAP or its
          lower band ({VWAP_BAND_STDDEV}σ) + &minus;DI &gt; &plus;DI + ADX
          &gt; {MIN_ADX} + 1H RSI &gt; {RSI_SHORT_MIN} • Requires 24h quote
          volume ≥ ${(MIN_VOLUME / 1_000_000).toFixed(0)}M • DMI/ADX/ATR are
          5M; EMA{EMA_PERIOD} and gating RSI are 1H • VWAP re-anchors every
          UTC midnight • EMA{EMA_PERIOD}, RVOL, ATR% and 5M RSI are shown for
          context only
        </p>
      </div>
    </div>
  );
}
