// Pine-faithful series math.
//
// Every helper returns an array the SAME LENGTH as its input, NaN-padded
// through warm-up, so indices line up with the kline array they came from.
// That is the whole point: the scanner runs two clocks at once — indicators on
// the live, still-forming candle and price structure on the last closed one —
// and it can only index the same series at two different offsets if nothing
// has been trimmed or shifted.
//
// (The `technicalindicators` package trims its output to `length - period + 1`
// instead, which silently shifts every index, so none of this can use it.)
//
// Each function names the TradingView built-in it reproduces. Where Pine and
// the textbook disagree — `ta.stdev` dividing by N, `ta.rma`/`ta.ema` seeding
// on an SMA, `ta.percentrank` excluding the current bar — Pine wins, because
// these numbers are meant to match what the chart prints.

/**
 * `ta.sma` — rolling simple moving average.
 *
 * NaN-aware, and it has to be: this gets fed the warm-up-padded output of
 * `rocSeries`, `stochSeries` and KST itself, not just raw closes. A plain
 * running sum is poisoned permanently by a single NaN (subtracting it back out
 * when it leaves the window doesn't clear it), so the holes are counted
 * separately and the sum only ever accumulates finite values. Like Pine, a
 * window containing an na produces an na.
 */
export function smaSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  let holes = 0;

  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) sum += values[i];
    else holes += 1;

    if (i >= period) {
      const leaving = values[i - period];
      if (Number.isFinite(leaving)) sum -= leaving;
      else holes -= 1;
    }

    if (i >= period - 1 && holes === 0) out[i] = sum / period;
  }

  return out;
}

/**
 * `ta.rma` — Wilder's smoothing, `alpha = 1 / period`, seeded with the SMA of
 * the first `period` FINITE values. The base for both RSI and ATR.
 *
 * Finite, not the first `period` indices: series fed through here (the up/down
 * moves behind RSI) start with an na from `ta.change`, and Pine seeds past it
 * rather than on it.
 */
export function rmaSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const alpha = 1 / period;

  let seedSum = 0;
  let seedCount = 0;
  let previous = NaN;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;

    if (!Number.isFinite(previous)) {
      seedSum += value;
      seedCount += 1;
      if (seedCount === period) {
        previous = seedSum / period;
        out[i] = previous;
      }
      continue;
    }

    previous = alpha * value + (1 - alpha) * previous;
    out[i] = previous;
  }

  return out;
}

/** `ta.ema` — `alpha = 2 / (period + 1)`, seeded with an SMA like Pine's. */
export function emaSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const alpha = 2 / (period + 1);

  let seedSum = 0;
  let previous = NaN;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    // Only ever fed raw closes, which are always finite; a hole would poison
    // every later bar, so stop rather than propagate a NaN forward.
    if (!Number.isFinite(value)) return out;

    if (i < period - 1) {
      seedSum += value;
      continue;
    }
    if (i === period - 1) {
      previous = (seedSum + value) / period;
    } else {
      previous = alpha * value + (1 - alpha) * previous;
    }
    out[i] = previous;
  }

  return out;
}

/** `ta.roc` — rate of change in percent: `100 * (v - v[n]) / v[n]`. */
export function rocSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period; i < values.length; i++) {
    const past = values[i - period];
    if (past !== 0) out[i] = ((values[i] - past) / past) * 100;
  }
  return out;
}

/**
 * `ta.rsi` — Wilder's RSI: RMA of upward moves over RMA of downward moves.
 * The head of the change series is na, which `rmaSeries` skips, so the seed
 * lands on the same bar TradingView puts it on.
 */
export function rsiSeries(values: number[], period: number): number[] {
  const gains = new Array<number>(values.length).fill(NaN);
  const losses = new Array<number>(values.length).fill(NaN);

  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    gains[i] = Math.max(change, 0);
    losses[i] = Math.max(-change, 0);
  }

  const avgGain = rmaSeries(gains, period);
  const avgLoss = rmaSeries(losses, period);

  const out = new Array<number>(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    const up = avgGain[i];
    const down = avgLoss[i];
    if (!Number.isFinite(up) || !Number.isFinite(down)) continue;
    // Pine's own edge cases, kept verbatim: a period with no losses is 100,
    // one with no gains is 0, rather than a division by zero.
    out[i] = down === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / down);
  }
  return out;
}

/**
 * `ta.stoch(src, high, low, period)` — where the source sits inside the
 * highest/lowest range of the window. Flat window means no range and no
 * verdict, so NaN rather than a divide by zero.
 */
export function stochSeries(
  src: number[],
  highs: number[],
  lows: number[],
  period: number,
): number[] {
  const out = new Array<number>(src.length).fill(NaN);

  for (let i = period - 1; i < src.length; i++) {
    let highest = -Infinity;
    let lowest = Infinity;
    let complete = true;

    for (let j = i - period + 1; j <= i; j++) {
      if (!Number.isFinite(highs[j]) || !Number.isFinite(lows[j])) {
        complete = false;
        break;
      }
      if (highs[j] > highest) highest = highs[j];
      if (lows[j] < lowest) lowest = lows[j];
    }

    if (!complete || !Number.isFinite(src[i])) continue;
    const range = highest - lowest;
    if (range !== 0) out[i] = ((src[i] - lowest) / range) * 100;
  }

  return out;
}

/** `ta.tr(true)` — true range, falling back to `high - low` on the first bar. */
function trueRangeSeries(
  highs: number[],
  lows: number[],
  closes: number[],
): number[] {
  const out = new Array<number>(highs.length).fill(NaN);
  for (let i = 0; i < highs.length; i++) {
    if (i === 0) {
      out[i] = highs[i] - lows[i];
      continue;
    }
    out[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
  }
  return out;
}

/** `ta.atr` — RMA of the true range. */
export function atrSeries(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number[] {
  return rmaSeries(trueRangeSeries(highs, lows, closes), period);
}

/**
 * Bollinger bandwidth, normalised by the basis so it is comparable across
 * price levels: `(upper - lower) / basis * 100`, band half-width `mult * stdev`.
 */
export function bandwidthSeries(
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
    const stdev = Math.sqrt(sumSquares / period); // divide by N, as ta.stdev does

    out[i] = ((2 * mult * stdev) / mean) * 100;
  }

  return out;
}

/**
 * `ta.percentrank` — the share of the PREVIOUS `lookback` values that are less
 * than or equal to the current one. The current bar is excluded from its own
 * window, so a reading of 20 means only a fifth of recent bars were tighter.
 */
export function percentRankSeries(
  values: number[],
  lookback: number,
): number[] {
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

export interface CrossInfo {
  side: "UP" | "DOWN" | null;
  /** Pine's `ta.barssince`: 0 = the cross landed on bar `at`. */
  barsSince: number | null;
}

/**
 * The most recent `ta.crossover`/`ta.crossunder` of `a` through `b` at or
 * before bar `at`. Taking `at` as a parameter is what lets the indicator clock
 * ask this question about the live bar while everything else reads a closed one.
 */
export function barsSinceCross(
  a: number[],
  b: number[],
  at: number,
): CrossInfo {
  for (let i = at; i > 0; i--) {
    const now = a[i] - b[i];
    const before = a[i - 1] - b[i - 1];
    if (!Number.isFinite(now) || !Number.isFinite(before)) break;

    if (now > 0 && before <= 0) return { side: "UP", barsSince: at - i };
    if (now < 0 && before >= 0) return { side: "DOWN", barsSince: at - i };
  }
  return { side: null, barsSince: null };
}
