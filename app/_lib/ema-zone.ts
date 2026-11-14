/* eslint-disable @typescript-eslint/no-explicit-any */
// EMA Zone scanner: the 6 strategies from strategy-discovery.md §13, on 1h.
//
// A line-for-line port of EMA-Zone-6-Strategies.pine (same defaults), so a
// coin listed here shows the same entry marker on the chart:
//
//   1 EMA200 TOUCH     a candle touched EMA200 within the last 3 bars
//   2 RECLAIM/REJECT   EMA50 or EMA200 touched within 3 bars, and the close is
//                      back on the trade side of that EMA
//   3 RANGE EDGE       EMAs converged (spread ≤ 2%), EMA50 touched within 3
//                      bars, close still inside the prior 24-bar range
//   4 TREND PULLBACK   EMAs spread ≥ 2% in the trade direction, an EMA touched
//                      within 3 bars, close on the trend side of EMA200
//
// The touch windows are 3 bars, not the doc's 12/6/12: a touch half a day old
// means the move off the level has already happened.
//   5 EXHAUSTION FADE  ≥ 2.5 ATR from EMA50 with stretched RSI, fading back
//
// Direction is always the colour of the entry candle. Strategies 1–4 must also
// pass the filters (RSI ≤ 65 long / ≥ 35 short; no long into ADX ≥ 25 with
// −DI > +DI; the 10-bar-extreme stop no more than 1 ATR inside EMA200). The
// fade is exempt. "Combined" (6) = any of them passing.
//
// The stop is computed only for that last filter. It is never shown: stops and
// targets are read off the chart.
//
// ─────────────────────────── ONE CLOCK ───────────────────────────
// Everything reads the LAST CLOSED candle. Callers pass the full Binance kline
// array; the forming candle (always last) is dropped here and nowhere else.

import {
  atrSeries,
  barsSinceCross,
  barsSinceSeries,
  dmiSeries,
  emaSeries,
  highestSeries,
  kstSeries,
  lowestSeries,
  rsiSeries,
} from "./indicators";

// ─────────────────────────── PARAMETERS ───────────────────────────

export const INTERVAL = "1h";
export const CANDLE_MS = 60 * 60_000;
export const INTERVAL_LABEL = "1H";

export const EMA_FAST = 50;
export const EMA_SLOW = 200;
export const ATR_LENGTH = 14;
export const RSI_LENGTH = 14;
export const ADX_LENGTH = 14;

/** Setup thresholds. Touch windows kept tight so the level is still in play. */
export const TOUCH200_BARS = 3;
export const RECLAIM_BARS = 3;
export const ZONE_BARS = 3;
export const SPREAD_MAX = 2.0;
export const RANGE_BARS = 24;
export const SPREAD_MIN = 2.0;
export const EXH_ATR = 2.5;
export const EXH_RSI_LONG = 35;
export const EXH_RSI_SHORT = 60;

/** Filters. */
export const RSI_LONG_MAX = 65;
export const RSI_SHORT_MIN = 35;
export const ADX_MAX = 25;
export const SL_ZONE_ATR = 1.0;
export const SL_BARS = 10;
export const SL_BUF_ATR = 0.75;

/** A signal stays listed for this many closed candles (1 = last close only). */
export const FRESH_BARS = 3;

/** KST is not a strategy input: it is shown for context and feeds the market-bias card. */
export const KST_ROC = [8, 12, 18, 24] as const;
export const KST_SMA = [8, 8, 8, 12] as const;
export const KST_SIGNAL = 7;
/** A KST cross this recent is shown as a fresh cross. */
export const KST_CROSS_BARS = 3;

const MIN_CANDLES = 220;
const DAY_BARS = (24 * 60 * 60_000) / CANDLE_MS;

export type Side = "LONG" | "SHORT";
export const STRATEGIES = [1, 2, 3, 4, 5] as const;
export type Strategy = (typeof STRATEGIES)[number];

export interface Signal {
  side: Side;
  /** Closed candles ago (0 = the last closed one). */
  barsAgo: number;
  /** Close of the signal candle. */
  price: number;
  /** Strategies whose setup matched AND passed their filters. */
  passed: Strategy[];
}

export interface EmaZoneReading {
  /** Latest candle in the last FRESH_BARS where Combined fired. */
  signal: Signal | null;
  /** Closed candles since a candle touched EMA200 (null = not in history). */
  ema200TouchAgo: number | null;
  ema50TouchAgo: number | null;
  /** Close − EMA in ATRs, signed. */
  distEma50Atr: number;
  distEma200Atr: number;
  spreadPct: number;
  rsi: number;
  adx: number;
  plusDi: number;
  minusDi: number;
  ema50: number;
  ema200: number;
  closedPrice: number;
  atrPercent: number;
  volume24h: number;
  change24h: number;
  /** KST(8 12 18 24 / 8 8 8 12 / 7) and its signal on the last close. */
  kst: number;
  kstSignal: number;
  kstAbove: boolean;
  /** Direction of a KST/signal cross within KST_CROSS_BARS, else null. */
  kstCross: Side | null;
  /** Closed candles since the latest KST cross (any age). */
  kstCrossAgo: number | null;
}

export function evaluateEmaZone(klines: any[]): EmaZoneReading | null {
  const bars = klines.slice(0, -1);
  if (bars.length < MIN_CANDLES) return null;

  const opens = bars.map((k: any) => parseFloat(k[1]));
  const highs = bars.map((k: any) => parseFloat(k[2]));
  const lows = bars.map((k: any) => parseFloat(k[3]));
  const closes = bars.map((k: any) => parseFloat(k[4]));
  const last = bars.length - 1;

  const ema50 = emaSeries(closes, EMA_FAST);
  const ema200 = emaSeries(closes, EMA_SLOW);
  const atr = atrSeries(highs, lows, closes, ATR_LENGTH);
  const rsi = rsiSeries(closes, RSI_LENGTH);
  const dmi = dmiSeries(highs, lows, closes, ADX_LENGTH, ADX_LENGTH);
  const bs50 = barsSinceSeries(highs.map((h, i) => lows[i] <= ema50[i] && h >= ema50[i]));
  const bs200 = barsSinceSeries(highs.map((h, i) => lows[i] <= ema200[i] && h >= ema200[i]));
  const rangeHi = highestSeries(highs, RANGE_BARS);
  const rangeLo = lowestSeries(lows, RANGE_BARS);
  const slLow = lowestSeries(lows, SL_BARS);
  const slHigh = highestSeries(highs, SL_BARS);

  const touched = (bs: number[], i: number, n: number) => Number.isFinite(bs[i]) && bs[i] <= n;

  /** All six strategies on candle i, exactly as the Pine script reads them. */
  function at(i: number): Signal | null {
    const c = closes[i];
    const e50 = ema50[i];
    const e200 = ema200[i];
    const a = atr[i];
    if (![e50, e200, a, rsi[i], dmi.adx[i], rangeHi[i - 1], rangeLo[i - 1]].every(Number.isFinite) || a <= 0) {
      return null;
    }
    const dir = c > opens[i] ? 1 : c < opens[i] ? -1 : 0;
    if (dir === 0) return null;

    const spread = (Math.abs(e50 - e200) / e200) * 100;
    const inside = c <= rangeHi[i - 1] && c >= rangeLo[i - 1];
    const distA = (c - e50) / a;

    const setup: Record<Strategy, boolean> = {
      1: touched(bs200, i, TOUCH200_BARS),
      2:
        (touched(bs50, i, RECLAIM_BARS) && Math.sign(c - e50) === dir) ||
        (touched(bs200, i, RECLAIM_BARS) && Math.sign(c - e200) === dir),
      3: spread <= SPREAD_MAX && touched(bs50, i, ZONE_BARS) && inside,
      4:
        Math.sign(e50 - e200) === dir &&
        spread >= SPREAD_MIN &&
        (touched(bs50, i, ZONE_BARS) || touched(bs200, i, ZONE_BARS)) &&
        Math.sign(c - e200) === dir,
      5:
        (dir === 1 && distA <= -EXH_ATR && rsi[i] <= EXH_RSI_LONG) ||
        (dir === -1 && distA >= EXH_ATR && rsi[i] >= EXH_RSI_SHORT),
    };

    const sl = dir === 1 ? slLow[i] - SL_BUF_ATR * a : slHigh[i] + SL_BUF_ATR * a;
    const filtersPass =
      (dir === 1 ? rsi[i] <= RSI_LONG_MAX : rsi[i] >= RSI_SHORT_MIN) &&
      !(dir === 1 && dmi.adx[i] >= ADX_MAX && dmi.minus[i] > dmi.plus[i]) &&
      (dir === 1 ? e200 - sl : sl - e200) / a >= -SL_ZONE_ATR;

    // The exhaustion fade (5) is exempt from the filters.
    const passed = STRATEGIES.filter((s) => setup[s] && (s === 5 || filtersPass));
    if (passed.length === 0) return null;
    return { side: dir === 1 ? "LONG" : "SHORT", barsAgo: last - i, price: c, passed };
  }

  let signal: Signal | null = null;
  for (let i = last; i > last - FRESH_BARS && i > 0; i--) {
    const s = at(i);
    if (s) {
      signal = s;
      break;
    }
  }

  const c = closes[last];
  const a = atr[last];
  if (![ema50[last], ema200[last], a, rsi[last], dmi.adx[last]].every(Number.isFinite) || a <= 0) {
    return null;
  }

  const { kst, signal: kstSig } = kstSeries(closes, KST_ROC, KST_SMA, KST_SIGNAL);
  const kstCross = barsSinceCross(kst, kstSig, last);
  const dayAgo = closes[last - DAY_BARS];

  return {
    signal,
    ema200TouchAgo: Number.isFinite(bs200[last]) ? bs200[last] : null,
    ema50TouchAgo: Number.isFinite(bs50[last]) ? bs50[last] : null,
    distEma50Atr: (c - ema50[last]) / a,
    distEma200Atr: (c - ema200[last]) / a,
    spreadPct: (Math.abs(ema50[last] - ema200[last]) / ema200[last]) * 100,
    rsi: rsi[last],
    adx: dmi.adx[last],
    plusDi: dmi.plus[last],
    minusDi: dmi.minus[last],
    ema50: ema50[last],
    ema200: ema200[last],
    closedPrice: c,
    atrPercent: (a / c) * 100,
    volume24h: bars.slice(-DAY_BARS).reduce((sum: number, k: any) => sum + parseFloat(k[7]), 0),
    change24h: ((c - dayAgo) / dayAgo) * 100,
    kst: kst[last],
    kstSignal: kstSig[last],
    kstCrossAgo: kstCross.barsSince,
    kstAbove: kst[last] > kstSig[last],
    kstCross:
      kstCross.barsSince != null && kstCross.barsSince < KST_CROSS_BARS
        ? kstCross.side === "UP"
          ? "LONG"
          : kstCross.side === "DOWN"
            ? "SHORT"
            : null
        : null,
  };
}
