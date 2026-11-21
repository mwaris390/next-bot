/* eslint-disable @typescript-eslint/no-explicit-any */
// EMA + KST + RSI trend-pullback scanner, on INTERVAL (1h) candles.
//
// Four criteria, all read off the last closed candle:
//
//   KST       — KST on the trade's side of its signal: aligned, or just
//               crossed (within KST_CROSS_BARS closed candles). Up = long,
//               down = short.
//   EMA TREND — EMA 50 above EMA 200 (long) / below it (short): the trend the
//               trade leans on.
//   RSI       — RSI sits in the neutral band: room to run, not yet stretched.
//   NEAR EMA  — the close is within NEAR_ATR × ATR of EMA 50 or EMA 200, so
//               the entry is on the line, not after the move.
//
// A coin's side is the recent KST cross when there is one, otherwise the
// direction its EMAs are stacked in. The page puts coins meeting all four in
// the first table. The second lists the coins where KST and the EMAs disagree:
// a fresh KST cross against the EMA stack, or a fresh EMA 50/200 cross with
// KST on the other side of its signal (see `conflict`).
//
// 15M GATE: a 1h row is only shown when the 15m chart agrees with its side —
// EMA 8 > 12 > 21 and KST above its signal for a long, the mirror for a short
// (see `evaluateTrigger`). The 1h compression and CEB-X read (./hourly-context)
// ride along as badges.
//
// Volume and volatility are filters here, not ranking hints: a coin has to be
// liquid and actually moving (against the scan's own median ATR%) to be shown
// at all, because the quiet ones that tick every box are the ones drifting
// sideways. That cut is made by the page, which has the median.
//
// ─────────────────────────── ONE CLOCK ───────────────────────────
// Everything reads the LAST CLOSED candle, so a reading is final and holds
// until the next close. Callers pass the full Binance kline array; the forming
// candle (always last) is dropped here and nowhere else.

import { type CebX, type Compression, cebX, compression } from "./hourly-context";
import {
  atrSeries,
  barsSinceCross,
  emaSeries,
  rocSeries,
  rsiSeries,
  smaSeries,
} from "./indicators";

// ─────────────────────────── PARAMETERS ───────────────────────────

/** The scanner's timeframe. */
export const INTERVAL = "1h";
export const CANDLE_MS = 60 * 60_000;
export const INTERVAL_LABEL = "1H";

/** The 15m gate's timeframe and EMA ribbon. */
export const TRIGGER_INTERVAL = "15m";
export const TRIGGER_CANDLE_MS = 15 * 60_000;
export const TRIGGER_INTERVAL_LABEL = "15M";
export const TRIGGER_EMAS = [8, 12, 21] as const;

export const EMA_FAST = 50;
export const EMA_SLOW = 200;
export const EMAS = [EMA_FAST, EMA_SLOW] as const;
export type EmaLength = (typeof EMAS)[number];

/** ATR is only a ruler here — for "near" and for the volatility filter. */
export const ATR_LENGTH = 14;
/** "Near" an EMA: the closed candle's close within this many ATRs of it. */
export const NEAR_ATR = 1.0;

/** KST 8 12 18 24 / 8 8 8 12 / signal 7. */
export const KST_ROC = [8, 12, 18, 24] as const;
export const KST_SMA = [8, 8, 8, 12] as const;
export const KST_SIGNAL = 7;
/** A cross counts if it landed on one of the last this-many closed candles. */
export const KST_CROSS_BARS = 5;
/**
 * An EMA 50/200 cross counts as fresh within this many closed candles, so the
 * badge tops out at "9c ago". Older than that the cross is history, not a
 * signal, and isn't flagged.
 */
export const EMA_CROSS_BARS = 9;

export const RSI_LENGTH = 14;
/** Neutral RSI band, inclusive. */
export const RSI_NEUTRAL_LO = 40;
export const RSI_NEUTRAL_HI = 60;

/** The four criteria, in column order. */
export const CRITERIA = ["kst", "ema", "rsi", "near"] as const;
export type Criterion = (typeof CRITERIA)[number];

/** Enough bars for EMA 200 to exist at all. */
export const MIN_CANDLES = 220;

/** 24 × 1h = the 24h window for volume and change, on closed candles only. */
export const DAY_BARS = (24 * 60 * 60_000) / CANDLE_MS;

export type Side = "LONG" | "SHORT";

export interface EmaTouch {
  length: EmaLength;
  value: number;
  /** Close − EMA in ATRs, signed: positive above, negative below. */
  distanceAtr: number;
}

export interface Reading {
  side: Side;
  criteria: Record<Criterion, boolean>;
  /** Closed candles since the latest KST cross (0 = the last closed one). */
  kstBarsAgo: number | null;
  kstCrossSide: Side | null;
  /** KST above its signal right now (its state, not a fresh cross). */
  kstAbove: boolean;
  /** Closed candles since the latest EMA 50/200 cross. */
  emaCrossBarsAgo: number | null;
  emaCrossSide: Side | null;
  /**
   * The two disagreements the Partial table lists:
   *  kstVsEma — fresh KST cross, but the EMA stack points the other way
   *  emaVsKst — fresh EMA 50/200 cross, but KST sits on the other side of its signal
   */
  conflict: { kstVsEma: boolean; emaVsKst: boolean };
  kst: number;
  kstSignal: number;
  rsi: number;
  ema50: number;
  ema200: number;
  /** Both EMAs, nearest to the close first. */
  touches: EmaTouch[];
  closedPrice: number;
  atrPercent: number;
  /** Quote volume of the last DAY_BARS closed candles. */
  volume24h: number;
  /** Close-to-close % over the last DAY_BARS closed candles. */
  change24h: number;
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
 * Reads the last closed candle of a FULL kline series, as Binance returns it —
 * the forming candle is dropped here. Null when there isn't enough history.
 */
export function evaluate(klines: any[]): Reading | null {
  const bars = klines.slice(0, -1);
  if (bars.length < MIN_CANDLES) return null;

  const highs = bars.map((k: any) => parseFloat(k[2]));
  const lows = bars.map((k: any) => parseFloat(k[3]));
  const closes = bars.map((k: any) => parseFloat(k[4]));

  const last = bars.length - 1;
  const closedPrice = closes[last];
  const volume24h = bars
    .slice(-DAY_BARS)
    .reduce((sum: number, k: any) => sum + parseFloat(k[7]), 0);
  const dayAgo = closes[last - DAY_BARS];

  const ema50All = emaSeries(closes, EMA_FAST);
  const ema200All = emaSeries(closes, EMA_SLOW);
  const ema50 = ema50All[last];
  const ema200 = ema200All[last];
  const atr = atrSeries(highs, lows, closes, ATR_LENGTH)[last];
  const rsi = rsiSeries(closes, RSI_LENGTH)[last];
  const { kst, signal } = kstSeries(closes);
  if (
    ![ema50, ema200, atr, rsi, kst[last], signal[last]].every(Number.isFinite) ||
    atr <= 0
  ) {
    return null;
  }

  const cross = barsSinceCross(kst, signal, last);
  const kstCrossSide: Side | null =
    cross.side === "UP" ? "LONG" : cross.side === "DOWN" ? "SHORT" : null;
  const recentCross =
    cross.barsSince != null && cross.barsSince < KST_CROSS_BARS;

  const emaSide: Side = ema50 >= ema200 ? "LONG" : "SHORT";
  const kstAbove = kst[last] > signal[last];

  const emaCross = barsSinceCross(ema50All, ema200All, last);
  const emaCrossSide: Side | null =
    emaCross.side === "UP" ? "LONG" : emaCross.side === "DOWN" ? "SHORT" : null;
  const recentEmaCross =
    emaCross.barsSince != null && emaCross.barsSince < EMA_CROSS_BARS;
  const side: Side = recentCross && kstCrossSide ? kstCrossSide : emaSide;

  const touches = EMAS.map((length, i) => {
    const value = i === 0 ? ema50 : ema200;
    return { length, value, distanceAtr: (closedPrice - value) / atr };
  }).sort((a, b) => Math.abs(a.distanceAtr) - Math.abs(b.distanceAtr));

  return {
    side,
    criteria: {
      kst: kstAbove === (side === "LONG"),
      ema: emaSide === side,
      rsi: rsi >= RSI_NEUTRAL_LO && rsi <= RSI_NEUTRAL_HI,
      near: Math.abs(touches[0].distanceAtr) <= NEAR_ATR,
    },
    kstBarsAgo: cross.barsSince,
    kstCrossSide,
    kstAbove,
    emaCrossBarsAgo: emaCross.barsSince,
    emaCrossSide,
    conflict: {
      kstVsEma: recentCross && kstCrossSide != null && kstCrossSide !== emaSide,
      emaVsKst:
        recentEmaCross &&
        emaCrossSide != null &&
        (emaCrossSide === "LONG") !== kstAbove,
    },
    kst: kst[last],
    kstSignal: signal[last],
    rsi,
    ema50,
    ema200,
    touches,
    closedPrice,
    atrPercent: (atr / closedPrice) * 100,
    volume24h,
    change24h: ((closedPrice - dayAgo) / dayAgo) * 100,
  };
}

// ─────────────────────────── 1H CONTEXT ───────────────────────────

export interface HourlyContext {
  /** 1h compression on the last closed bar (badge only). */
  compression: Compression;
  /** 1h CEB-X breakout / fakeout events (badge only). */
  ceb: CebX;
}

/**
 * Compression + CEB-X off a FULL 1h kline series (forming candle dropped
 * here). Heavier than `evaluate`, so the page only runs it on shown rows.
 */
export function hourlyContext(klines: any[]): HourlyContext {
  const bars = klines.slice(0, -1);
  const highs = bars.map((k: any) => parseFloat(k[2]));
  const lows = bars.map((k: any) => parseFloat(k[3]));
  const closes = bars.map((k: any) => parseFloat(k[4]));
  return {
    compression: compression(highs, lows, closes),
    ceb: cebX(highs, lows, closes),
  };
}

// ─────────────────────────── 15M GATE ───────────────────────────

export interface Trigger {
  /** LONG when EMA 8 > 12 > 21 and KST > signal, SHORT for the mirror, else null. */
  side: Side | null;
  emas: number[];
  kstAbove: boolean;
}

/** Reads the last closed 15m candle of a FULL kline series. */
export function evaluateTrigger(klines: any[]): Trigger | null {
  const closes = klines.slice(0, -1).map((k: any) => parseFloat(k[4]));
  const last = closes.length - 1;
  const emas = TRIGGER_EMAS.map((length) => emaSeries(closes, length)[last]);
  const { kst, signal } = kstSeries(closes);
  if (![...emas, kst[last], signal[last]].every(Number.isFinite)) return null;

  const kstAbove = kst[last] > signal[last];
  const [fast, mid, slow] = emas;
  const side: Side | null =
    fast > mid && mid > slow && kstAbove
      ? "LONG"
      : fast < mid && mid < slow && !kstAbove
        ? "SHORT"
        : null;
  return { side, emas, kstAbove };
}
