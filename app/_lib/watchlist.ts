/* eslint-disable @typescript-eslint/no-explicit-any */
// EMA proximity + confluence scanner, on INTERVAL (1h) candles.
//
//  ONE GATE — the last closed candle's close sits within NEAR_ATR × ATR of
//  EMA 50 or EMA 200, either side of it. Nothing else filters.
//
//  Everything that passed is then RANKED by how many of five confirmations
//  the previous (last closed) candle prints for its side:
//
//    KST CROSS  — KST crossed its signal on that candle (up = long, down = short)
//    RSI        — RSI rose on it (long) / fell on it (short)
//    ADX        — ADX rose on it: the trend, whichever way, is strengthening
//    OI         — open interest rose over it: new positions opening (fetched
//                 by the page, see ./binance)
//    ENGULF     — a bullish (long) / bearish (short) engulfing candle
//
//  Short is the exact mirror of long. ADX and OI are directionless, so they
//  count for whichever side the directional three pick.
//
// ─────────────────────────── ONE CLOCK ───────────────────────────
// Everything reads the LAST CLOSED candle, so a reading is final and holds
// until the next close. Callers pass the full Binance kline array; the forming
// candle (always last) is dropped here and nowhere else.

import {
  atrSeries,
  barsSinceCross,
  dmiSeries,
  emaSeries,
  rocSeries,
  rsiSeries,
  smaSeries,
} from "./indicators";

// ─────────────────────────── PARAMETERS ───────────────────────────

/** The scanner's timeframe. Every indicator and OI read it. */
export const INTERVAL = "1h";
export const CANDLE_MS = 60 * 60_000;
export const INTERVAL_LABEL = "1H";

export const EMAS = [50, 200] as const;
export type EmaLength = (typeof EMAS)[number];
export const ATR_LENGTH = 14;
/** "Near" an EMA: the closed candle's close within this many ATRs of it. */
export const NEAR_ATR = 1.0;

/** KST 8 12 18 24 / 8 8 8 12 / signal 7. */
export const KST_ROC = [8, 12, 18, 24] as const;
export const KST_SMA = [8, 8, 8, 12] as const;
export const KST_SIGNAL = 7;

export const RSI_LENGTH = 14;

/** ADX(14, 14) — Wilder's, as TradingView's built-in DMI. */
export const ADX_LENGTH = 14;
export const ADX_SMOOTHING = 14;

/** Open interest change window: the previous candle alone. */
export const OI_BARS = 1;

/** The five confirmations, in column order. */
export const CHECKS = ["kst", "rsi", "adx", "oi", "engulf"] as const;
export type Check = (typeof CHECKS)[number];
export const MAX_SCORE = CHECKS.length;

/**
 * EMA 200 is the slowest series. A coin listed less than 499 hours ago comes
 * back with its whole history — the same series TradingView seeds from — and
 * only needs enough bars for EMA 200 to exist at all.
 */
export const MIN_CANDLES = 220;

/** 24 × 1h = the 24h window for volume and change, on closed candles only. */
export const DAY_BARS = (24 * 60 * 60_000) / CANDLE_MS;

/** Breadth reads the universe against the 1h EMA 50. */
export const EMA_BREADTH = 50;

export type Side = "LONG" | "SHORT";

export interface EmaTouch {
  length: EmaLength;
  value: number;
  /** Close − EMA in ATRs, signed: positive above, negative below. */
  distanceAtr: number;
}

export interface SetupState {
  side: Side;
  /** Candle confirmations for `side` — OI is added by the page. */
  checks: Omit<Record<Check, boolean>, "oi">;
  kst: number;
  kstSignal: number;
  rsi: number;
  rsiPrev: number;
  adx: number;
  adxPrev: number;
  closedPrice: number;
  /** Close time of the last closed candle, on the candle boundary. */
  closedAt: number;
  atrPercent: number;
  /** Quote volume of the last DAY_BARS closed candles — 24h, without the forming one. */
  volume24h: number;
  /** Close-to-close % over the last DAY_BARS closed candles. */
  change24h: number;
  /** The EMAs the close sits near, nearest first. */
  touches: EmaTouch[];
}

export interface Evaluation {
  /** Set only when the close is near EMA 50 or 200. */
  setup: SetupState | null;
  atrPercent: number;
  aboveEma50: boolean;
}

function kstSeries(closes: number[]): { kst: number[]; signal: number[] } {
  const legs = KST_ROC.map((rocLength, index) =>
    smaSeries(rocSeries(closes, rocLength), KST_SMA[index]),
  );

  const kst = new Array<number>(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    let total = 0;
    let complete = true;
    for (let leg = 0; leg < legs.length; leg++) {
      const value = legs[leg][i];
      if (!Number.isFinite(value)) {
        complete = false;
        break;
      }
      total += (leg + 1) * value; // weights 1, 2, 3, 4
    }
    if (complete) kst[i] = total;
  }

  return { kst, signal: smaSeries(kst, KST_SIGNAL) };
}

/**
 * Engulfing on bar `i` against bar `i - 1`: the opposite-coloured previous
 * body is wholly covered by this one. Null when there's no engulf.
 */
function engulfSide(
  opens: number[],
  closes: number[],
  i: number,
): Side | null {
  const [o, c, po, pc] = [opens[i], closes[i], opens[i - 1], closes[i - 1]];
  if (pc < po && c > o && o <= pc && c >= po && c - o > po - pc) return "LONG";
  if (pc > po && c < o && o >= pc && c <= po && o - c > pc - po) return "SHORT";
  return null;
}

/**
 * Evaluates the last closed candle of a FULL kline series, as Binance returns
 * it — the forming candle is dropped here.
 */
export function evaluateSetup(klines: any[]): Evaluation | null {
  const bars = klines.slice(0, -1);
  if (bars.length < MIN_CANDLES) return null;

  const opens = bars.map((k: any) => parseFloat(k[1]));
  const highs = bars.map((k: any) => parseFloat(k[2]));
  const lows = bars.map((k: any) => parseFloat(k[3]));
  const closes = bars.map((k: any) => parseFloat(k[4]));

  const last = bars.length - 1;
  const closedPrice = closes[last];
  const volume24h = bars
    .slice(-DAY_BARS)
    .reduce((sum: number, k: any) => sum + parseFloat(k[7]), 0);
  const dayAgo = closes[last - DAY_BARS];

  const emaValues = EMAS.map((length) => emaSeries(closes, length)[last]);
  const [ema50] = emaValues;
  const atr = atrSeries(highs, lows, closes, ATR_LENGTH)[last];
  if (![...emaValues, atr].every(Number.isFinite) || atr <= 0) return null;

  const atrPercent = (atr / closedPrice) * 100;
  const evaluation: Evaluation = {
    setup: null,
    atrPercent,
    aboveEma50: closedPrice > ema50,
  };

  // The gate: near EMA 50 or 200, on either side of it.
  const touches = EMAS.map((length, i) => ({
    length,
    value: emaValues[i],
    distanceAtr: (closedPrice - emaValues[i]) / atr,
  }))
    .filter(({ distanceAtr }) => Math.abs(distanceAtr) <= NEAR_ATR)
    .sort((a, b) => Math.abs(a.distanceAtr) - Math.abs(b.distanceAtr));
  if (touches.length === 0) return evaluation;

  const rsiAll = rsiSeries(closes, RSI_LENGTH);
  const { adx: adxAll } = dmiSeries(highs, lows, closes, ADX_LENGTH, ADX_SMOOTHING);
  const { kst, signal } = kstSeries(closes);
  const [rsi, rsiPrev, adx, adxPrev] = [
    rsiAll[last],
    rsiAll[last - 1],
    adxAll[last],
    adxAll[last - 1],
  ];
  if (![rsi, rsiPrev, adx, adxPrev].every(Number.isFinite)) return evaluation;

  // The three directional reads, each voting for a side (or abstaining).
  const cross = barsSinceCross(kst, signal, last);
  const kstSide: Side | null =
    cross.barsSince === 0 ? (cross.side === "UP" ? "LONG" : "SHORT") : null;
  const rsiSide: Side | null =
    rsi > rsiPrev ? "LONG" : rsi < rsiPrev ? "SHORT" : null;
  const engulf = engulfSide(opens, closes, last);

  // Side = the majority of those votes. A split (KST one way, RSI the other)
  // goes to the stronger signal: KST cross, then engulfing, then RSI.
  const votes = [kstSide, engulf, rsiSide];
  const longs = votes.filter((v) => v === "LONG").length;
  const shorts = votes.filter((v) => v === "SHORT").length;
  const side: Side | null =
    longs > shorts
      ? "LONG"
      : shorts > longs
        ? "SHORT"
        : (votes.find((v) => v != null) ?? null);
  if (!side) return evaluation;

  evaluation.setup = {
    side,
    checks: {
      kst: kstSide === side,
      rsi: rsiSide === side,
      adx: adx > adxPrev,
      engulf: engulf === side,
    },
    kst: kst[last],
    kstSignal: signal[last],
    rsi,
    rsiPrev,
    adx,
    adxPrev,
    closedPrice,
    closedAt: bars[last][6] + 1,
    atrPercent,
    volume24h,
    change24h: ((closedPrice - dayAgo) / dayAgo) * 100,
    touches,
  };
  return evaluation;
}
