/* eslint-disable @typescript-eslint/no-explicit-any */
// Bollinger squeeze detection, ported from strategy.pine ("BBSQZ P20", tuned
// for 30-minute charts).
//
// The Pine original is a three-stage state machine, not a per-bar formula:
//   1. COMPRESS — Bollinger bandwidth is ranked against the previous N bars.
//                 A low percentile means volatility has coiled.
//   2. ARM      — when the squeeze releases after enough bars, the high/low
//                 accumulated during the coil become breakout levels, live for
//                 a fixed window of bars.
//   3. FIRE     — a close beyond one of those levels, with momentum agreeing.
//
// Pine carries that state across bars natively; the scanner cannot, because it
// re-renders from scratch on every request. That turns out not to matter: the
// machine is a pure function of the kline series, so replaying it from a single
// fetch on each scan reproduces exactly what the Pine indicator shows.

// ─────────────────────────── PARAMETERS ───────────────────────────
// These mirror the `input.*` defaults in strategy.pine one for one.
export const BB_LENGTH = 20;
export const BB_STDDEV = 2.0;
export const PERCENTILE_LOOKBACK = 240; // 240 bars on 30m ~ 5 days
export const SQUEEZE_PERCENTILE = 20;
export const EXTREME_PERCENTILE = SQUEEZE_PERCENTILE / 2;
export const MIN_SQUEEZE_BARS = 6; // 3h on 30m — filters one-bar flukes
export const BREAKOUT_WINDOW = 10; // 5h on 30m to resolve, then the setup dies
export const REQUIRE_MOMENTUM = true;

// Pine gates every squeeze on `bar_index > lookback + bbLen`; the +2 leaves at
// least one qualifying bar plus the bar before it to compare against.
export const MIN_CANDLES = PERCENTILE_LOOKBACK + BB_LENGTH + 2;

export type SqueezePhase = "FIRED" | "ARMED" | "EXTREME" | "SQUEEZE" | "NEUTRAL";

export interface SqueezeState {
  phase: SqueezePhase;
  /** FIRED only — which side of the coil the close broke through. */
  side?: "LONG" | "SHORT";
  /** Bandwidth percentile on the last closed bar. Lower = tighter. */
  rank: number;
  /** BB bandwidth as a percent of the basis. */
  bandwidth: number;
  /** TTM-style linear-regression momentum, in price units. */
  momentum: number;
  /** Bars the current (or most recent, for ARMED/FIRED) coil has lasted. */
  squeezeBars: number;
  /** ARMED only — bars remaining before the pending setup expires. */
  barsLeft?: number;
  /** Breakout levels, set once the coil releases. */
  boHi?: number;
  boLo?: number;
}

/**
 * Binance always returns the still-forming candle last. Every read in this
 * module is off the last CLOSED bar, so the forming one is stripped exactly
 * once, here — callers pass the result around rather than each remembering to
 * offset their own indices.
 */
export function closedCandles(klines: any[]): any[] {
  return klines.slice(0, -1);
}

// ─────────────────────────── SERIES MATH ───────────────────────────
// Every helper returns an array the same length as its input, NaN-padded
// during warm-up, so indices line up with the kline array and the state
// machine can walk all of them together. (The `technicalindicators` package
// trims its output to `length - period + 1` instead, which silently shifts
// every index — hence the hand-rolled versions.)

/** Rolling simple moving average. */
function smaSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * BB bandwidth, normalised by the basis so it is comparable across price
 * levels: (upper - lower) / basis * 100, where the band half-width is
 * `mult * stdev`.
 */
function bandwidthSeries(
  closes: number[],
  period: number,
  mult: number,
): number[] {
  const means = smaSeries(closes, period);
  const out = new Array<number>(closes.length).fill(NaN);

  for (let i = period - 1; i < closes.length; i++) {
    const mean = means[i];
    if (!Number.isFinite(mean) || mean === 0) continue;

    // Two-pass variance on purpose. A squeeze *is* a tiny variance around a
    // large mean, which is precisely where the E[x²]-E[x]² shortcut loses its
    // significant digits to float64 cancellation.
    let sumSquares = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const deviation = closes[j] - mean;
      sumSquares += deviation * deviation;
    }
    const stdev = Math.sqrt(sumSquares / period); // divide by N, as Pine's ta.stdev does

    out[i] = ((2 * mult * stdev) / mean) * 100;
  }

  return out;
}

/**
 * Pine's `ta.percentrank`: the share of the PREVIOUS `lookback` values that are
 * less than or equal to the current one. The current bar is excluded from its
 * own window, so a reading of 20 means only a fifth of recent bars were tighter.
 */
function percentRankSeries(values: number[], lookback: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);

  for (let i = lookback; i < values.length; i++) {
    const current = values[i];
    if (!Number.isFinite(current)) continue;

    let count = 0;
    let complete = true;
    for (let j = i - lookback; j < i; j++) {
      if (!Number.isFinite(values[j])) {
        complete = false;
        break;
      }
      if (values[j] <= current) count++;
    }

    if (complete) out[i] = (count / lookback) * 100;
  }

  return out;
}

/**
 * Pine's `ta.linreg(source, period, 0)`: the least-squares line through the
 * last `period` points, evaluated at the newest of them.
 */
function linregAt(values: number[], end: number, period: number): number {
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let k = 0; k < period; k++) {
    const y = values[end - period + 1 + k];
    if (!Number.isFinite(y)) return NaN;
    sumX += k;
    sumY += y;
    sumXY += k * y;
    sumXX += k * k;
  }

  const denominator = period * sumXX - sumX * sumX;
  if (denominator === 0) return NaN;

  const slope = (period * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / period;
  return intercept + slope * (period - 1);
}

/**
 * TTM-style momentum: linear regression of price against the midline of the
 * recent range. Note that Pine evaluates `src - midRange` as a *series* — each
 * bar inside the regression window is measured against its own midline, not
 * against the current bar's.
 */
function momentumSeries(
  closes: number[],
  highs: number[],
  lows: number[],
  period: number,
): number[] {
  const closeMeans = smaSeries(closes, period);
  const relative = new Array<number>(closes.length).fill(NaN);

  for (let i = period - 1; i < closes.length; i++) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > highest) highest = highs[j];
      if (lows[j] < lowest) lowest = lows[j];
    }
    relative[i] = closes[i] - ((highest + lowest) / 2 + closeMeans[i]) / 2;
  }

  const out = new Array<number>(closes.length).fill(NaN);
  for (let i = 2 * (period - 1); i < closes.length; i++) {
    out[i] = linregAt(relative, i, period);
  }
  return out;
}

// ─────────────────────── THE STATE MACHINE ────────────────────────

/**
 * Replays strategy.pine's squeeze/arm/fire machine over a series of CLOSED
 * candles (pass the output of `closedCandles`) and reports where the symbol
 * stands on the final bar.
 */
export function replaySqueeze(closed: any[]): SqueezeState | null {
  if (closed.length < MIN_CANDLES) return null;

  const closes = closed.map((k: any) => parseFloat(k[4]));
  const highs = closed.map((k: any) => parseFloat(k[2]));
  const lows = closed.map((k: any) => parseFloat(k[3]));

  const bandwidth = bandwidthSeries(closes, BB_LENGTH, BB_STDDEV);
  const ranks = percentRankSeries(bandwidth, PERCENTILE_LOOKBACK);
  const momentum = momentumSeries(closes, highs, lows, BB_LENGTH);

  let coilHigh = NaN;
  let coilLow = NaN;
  let coilBars = 0;

  let armed = false;
  let barsSinceRelease = 0;
  let boHi = NaN;
  let boLo = NaN;

  let wasSqueezed = false;
  let firedOnLastBar = false;
  let firedSide: "LONG" | "SHORT" | undefined;
  let lastInSqueeze = false;

  for (let i = 0; i < closed.length; i++) {
    // Pine's `enoughData` guard: no verdict until the percentile has a full
    // window of its own behind it.
    const hasHistory = i > PERCENTILE_LOOKBACK + BB_LENGTH;
    const rank = ranks[i];
    const inSqueeze =
      hasHistory && Number.isFinite(rank) && rank <= SQUEEZE_PERCENTILE;

    const started = inSqueeze && !wasSqueezed;
    const released = !inSqueeze && wasSqueezed;

    if (started) {
      coilHigh = highs[i];
      coilLow = lows[i];
      coilBars = 1;
    } else if (inSqueeze) {
      coilHigh = Math.max(coilHigh, highs[i]);
      coilLow = Math.min(coilLow, lows[i]);
      coilBars += 1;
    }
    // `coilBars` is deliberately NOT reset on release — the release bar still
    // needs to know how long the coil it just left had lasted.

    if (released && coilBars >= MIN_SQUEEZE_BARS) {
      armed = true;
      barsSinceRelease = 0;
      boHi = coilHigh;
      boLo = coilLow;
    } else if (inSqueeze) {
      armed = false; // re-entered compression, void the pending setup
    } else if (armed) {
      barsSinceRelease += 1;
      if (barsSinceRelease > BREAKOUT_WINDOW) armed = false;
    }

    // Arming runs before the trigger check, exactly as in Pine, so a breakout
    // can fire on the release bar itself.
    const mom = momentum[i];
    const brokeUp = armed && closes[i] > boHi;
    const brokeDown = armed && closes[i] < boLo;
    const long = brokeUp && (!REQUIRE_MOMENTUM || mom > 0);
    const short = brokeDown && (!REQUIRE_MOMENTUM || mom < 0);

    if (long || short) {
      armed = false;
      firedOnLastBar = i === closed.length - 1;
      firedSide = long ? "LONG" : "SHORT";
    }

    wasSqueezed = inSqueeze;
    if (i === closed.length - 1) lastInSqueeze = inSqueeze;
  }

  const last = closed.length - 1;
  const rank = ranks[last];
  const shared = {
    rank,
    bandwidth: bandwidth[last],
    momentum: momentum[last],
    squeezeBars: coilBars,
  };

  if (firedOnLastBar) {
    return { ...shared, phase: "FIRED", side: firedSide, boHi, boLo };
  }
  if (lastInSqueeze) {
    return {
      ...shared,
      phase: rank <= EXTREME_PERCENTILE ? "EXTREME" : "SQUEEZE",
    };
  }
  if (armed) {
    return {
      ...shared,
      phase: "ARMED",
      barsLeft: BREAKOUT_WINDOW - barsSinceRelease,
      boHi,
      boLo,
    };
  }
  return { ...shared, phase: "NEUTRAL" };
}
