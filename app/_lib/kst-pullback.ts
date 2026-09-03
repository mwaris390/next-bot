/* eslint-disable @typescript-eslint/no-explicit-any */
// KST + StochRSI + EMA50 pullback, ported from kst-pullback.pine.
//
//  LONG  : KST crossed above its signal within the last few bars, StochRSI %K
//          <= 65, and a GREEN candle closed above EMA 50 that is either hugging
//          the EMA (pullback) or has just crossed above it.
//  SHORT : mirror image (%K >= 35, red candle below/crossing below EMA 50).
//
//  Bollinger squeeze is NOT a gate here — see ./squeeze. In the Pine it only
//  colours the chart, and the scanner keeps it that way: a bonus badge on a
//  signal, and one of the two qualifying rules on the watchlist.
//
// ─────────────────────────── TWO CLOCKS ───────────────────────────
// The Pine runs on two clocks by design, and so does this. `Indicators Read =
// Live candle` is its default and the one worth reproducing:
//
//   INDICATORS — KST, its signal, StochRSI %K and the cross age — read the
//   LIVE, still-forming candle, so they agree with TradingView's built-ins
//   tick for tick and give the freshest read.
//
//   PRICE STRUCTURE — candle colour, close vs EMA 50, the pullback distance,
//   the EMA cross and the ATR that sizes it — stays on the LAST CLOSED candle,
//   because a forming candle's colour and close are not decided yet: a green
//   candle hugging the EMA can end the bar red and below it.
//
// The cost is finality: live indicator values move, so a signal can appear and
// vanish before the bar closes. That is the same trade the chart makes.
//
// Binance returns the forming candle last, so callers pass the FULL kline
// array and this module indexes it at `live = n-1` and `prev = n-2`. Nothing
// may strip the forming candle up front — that would collapse both clocks
// into one and put every indicator a bar behind the chart.

import {
  atrSeries,
  barsSinceCross,
  emaSeries,
  rocSeries,
  rsiSeries,
  smaSeries,
  stochSeries,
} from "./indicators";

// ─────────────────────────── PARAMETERS ───────────────────────────
// These mirror the `input.*` defaults in kst-pullback.pine one for one.

export const EMA_LENGTH = 50;

/** Pine's default "ATR" proximity mode: how close to the EMA still counts. */
export const ATR_LENGTH = 14;
export const PROX_ATR = 0.5;

export const KST_ROC = [10, 13, 15, 25] as const;
export const KST_SMA = [10, 13, 15, 25] as const;
export const KST_SIGNAL = 7;
/** A cross stays valid this many closed bars, letting the pullback develop. */
export const CROSS_LOOKBACK = 3;

export const STOCH_RSI_LENGTH = 14;
export const STOCH_LENGTH = 14;
export const STOCH_SMOOTH_K = 3;
export const K_MAX_LONG = 65;
export const K_MIN_SHORT = 35;

/** KST's slowest leg is ROC 25 smoothed by SMA 25, then a 7-bar signal. */
export const MIN_CANDLES = 60;

export type Side = "LONG" | "SHORT";

export interface KstPullbackState {
  /** The complete Pine rule on the last closed candle, or null. */
  signal: Side | null;

  // ── Live candle ──
  kst: number;
  kstSignal: number;
  /** Direction of the most recent KST cross. */
  crossSide: "UP" | "DOWN" | null;
  /** Bars since that cross; 0 = it happened on the live bar. */
  barsSinceCross: number | null;
  /** Pine `kstLong`/`kstShort`: cross fresh AND still on the right side. */
  kstLong: boolean;
  kstShort: boolean;
  stochK: number;
  stochLong: boolean;
  stochShort: boolean;

  // ── Last closed candle ──
  ema: number;
  /** Close of the candle the structure was judged on. */
  closedPrice: number;
  candle: "GREEN" | "RED" | "FLAT";
  aboveEma: boolean;
  /** Gap from the EMA to the candle's near edge, as a percent of price. */
  emaDistancePercent: number;
  /** Pine's `distX <= prox` on its own — the candle is hugging the EMA. */
  withinProx: boolean;
  /** That test OR a fresh EMA cross: either way price is AT the EMA. */
  nearEma: boolean;
  emaCross: "UP" | "DOWN" | null;
  atr: number;
  longStruct: boolean;
  shortStruct: boolean;
}

// ──────────────────────────── KST ─────────────────────────────
// Same construction as TradingView's built-in "Know Sure Thing"; only the
// defaults differ (ours 10/13/15/25, 10/13/15/25, signal 7 — the built-in
// ships 10/15/20/30, 10/10/10/15, signal 9).
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

// ───────────────────── STOCHASTIC RSI (3, 3, 14, 14) ─────────────────
// Identical to TradingView's built-in, defaults included. Only %K is gated on;
// %D never enters the rule, so it is not computed.
function stochRsiK(closes: number[]): number[] {
  const rsi = rsiSeries(closes, STOCH_RSI_LENGTH);
  return smaSeries(stochSeries(rsi, rsi, rsi, STOCH_LENGTH), STOCH_SMOOTH_K);
}

// ─────────────────────── THE RULE ────────────────────────

/**
 * Evaluates the Pine rules over a FULL kline series — forming candle included,
 * exactly as Binance returns it. See the two-clocks note at the top of the
 * file for why the forming candle must not be stripped before it gets here.
 */
export function evaluateKstPullback(klines: any[]): KstPullbackState | null {
  if (klines.length < MIN_CANDLES) return null;

  const opens = klines.map((k: any) => parseFloat(k[1]));
  const highs = klines.map((k: any) => parseFloat(k[2]));
  const lows = klines.map((k: any) => parseFloat(k[3]));
  const closes = klines.map((k: any) => parseFloat(k[4]));

  const live = klines.length - 1; // the still-forming candle
  const prev = live - 1; // the last CLOSED candle — Pine's [1]
  const before = prev - 1; // the one before it — Pine's [2]
  if (before < 0) return null;

  // ── Indicators, on the live candle ──
  const { kst, signal } = kstSeries(closes);
  const stochK = stochRsiK(closes);

  const kstNow = kst[live];
  const signalNow = signal[live];
  const kNow = stochK[live];
  if (
    !Number.isFinite(kstNow) ||
    !Number.isFinite(signalNow) ||
    !Number.isFinite(kNow)
  ) {
    return null;
  }

  const { side: crossSide, barsSince } = barsSinceCross(kst, signal, live);
  // Pine: `kst > sig and nz(barssince, huge) <= crossLb - 1`. Both halves
  // matter — the cross has to be recent AND still standing.
  const freshCross = barsSince != null && barsSince <= CROSS_LOOKBACK - 1;
  const kstLong = kstNow > signalNow && freshCross && crossSide === "UP";
  const kstShort = kstNow < signalNow && freshCross && crossSide === "DOWN";

  const stochLong = kNow <= K_MAX_LONG;
  const stochShort = kNow >= K_MIN_SHORT;

  // ── Price structure, on the last closed candle ──
  const ema = emaSeries(closes, EMA_LENGTH);
  const atr = atrSeries(highs, lows, closes, ATR_LENGTH);

  const emaPrev = ema[prev];
  const emaBefore = ema[before];
  const atrPrev = atr[prev];
  if (
    !Number.isFinite(emaPrev) ||
    !Number.isFinite(emaBefore) ||
    !Number.isFinite(atrPrev)
  ) {
    return null;
  }

  const closedPrice = closes[prev];
  const aboveEma = closedPrice > emaPrev;

  // Distance from the EMA to the candle's NEAR edge — its low when price sits
  // above, its high when below — and 0 once the candle tags or pierces it.
  const distance = aboveEma
    ? Math.max(0, lows[prev] - emaPrev)
    : Math.max(0, emaPrev - highs[prev]);
  const prox = PROX_ATR * atrPrev;

  const emaCross =
    closedPrice > emaPrev && closes[before] <= emaBefore
      ? "UP"
      : closedPrice < emaPrev && closes[before] >= emaBefore
        ? "DOWN"
        : null;

  // Pine's `(distX <= prox or emaCrossX)` clause on its own, without the
  // candle-colour and side requirements that belong to the full signal. This
  // is what the watchlist anchors on.
  const withinProx = distance <= prox;
  const nearEma = withinProx || emaCross !== null;

  const candle =
    closedPrice > opens[prev] ? "GREEN" : closedPrice < opens[prev] ? "RED" : "FLAT";

  const longStruct =
    candle === "GREEN" && aboveEma && (withinProx || emaCross === "UP");
  const shortStruct =
    candle === "RED" && !aboveEma && (withinProx || emaCross === "DOWN");

  const signalSide: Side | null =
    kstLong && stochLong && longStruct
      ? "LONG"
      : kstShort && stochShort && shortStruct
        ? "SHORT"
        : null;

  return {
    signal: signalSide,
    kst: kstNow,
    kstSignal: signalNow,
    crossSide,
    barsSinceCross: barsSince,
    kstLong,
    kstShort,
    stochK: kNow,
    stochLong,
    stochShort,
    ema: emaPrev,
    closedPrice,
    candle,
    aboveEma,
    emaDistancePercent: (distance / closedPrice) * 100,
    withinProx,
    nearEma,
    emaCross,
    atr: atrPrev,
    longStruct,
    shortStruct,
  };
}
