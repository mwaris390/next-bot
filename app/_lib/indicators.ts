// Pine-faithful series math.
//
// Every helper returns an array the SAME LENGTH as its input, NaN-padded
// through warm-up, so indices line up with the kline array they came from —
// the scanner can read the live and the last closed candle off one series.
//
// (The `technicalindicators` package trims its output to `length - period + 1`
// instead, which silently shifts every index, so none of this can use it.)
//
// Each function names the TradingView built-in it reproduces. Where Pine and
// the textbook disagree — `ta.rma` and `ta.ema` seeding on an SMA rather than
// on the first value — Pine wins, because these numbers are meant to match
// what the chart prints.

/**
 * `ta.sma` — rolling simple moving average.
 *
 * NaN-aware, so a warm-up-padded series can be fed straight in. A plain
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
 * the first `period` FINITE values. The base for ATR.
 *
 * Finite, not the first `period` indices: Pine seeds past a leading na rather
 * than on it.
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

/**
 * `ta.tr` — true range. `handleNa` is Pine's own argument: `tr(true)` falls
 * back to `high - low` on the first bar, `ta.tr` (i.e. `tr(false)`) leaves it
 * na. ATR is built on the first, as in Pine.
 */
function trueRangeSeries(
  highs: number[],
  lows: number[],
  closes: number[],
  handleNa = true,
): number[] {
  const out = new Array<number>(highs.length).fill(NaN);
  for (let i = 0; i < highs.length; i++) {
    if (i === 0) {
      if (handleNa) out[i] = highs[i] - lows[i];
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
    // Pine's own edge cases: no losses is 100, no gains is 0.
    out[i] = down === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / down);
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
 * before bar `at`. Taking `at` as a parameter lets the indicator clock ask
 * this about the live bar while price structure reads a closed one.
 */
export function barsSinceCross(a: number[], b: number[], at: number): CrossInfo {
  for (let i = at; i > 0; i--) {
    const now = a[i] - b[i];
    const before = a[i - 1] - b[i - 1];
    if (!Number.isFinite(now) || !Number.isFinite(before)) break;

    if (now > 0 && before <= 0) return { side: "UP", barsSince: at - i };
    if (now < 0 && before >= 0) return { side: "DOWN", barsSince: at - i };
  }
  return { side: null, barsSince: null };
}

/** `ta.stdev` (biased, Pine's default) — rolling population standard deviation. */
export function stdevSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (!Number.isFinite(values[j])) {
        ok = false;
        break;
      }
      sum += values[j];
    }
    if (!ok) continue;
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

/**
 * `ta.percentrank` — percent of the previous `period` values that are less
 * than or equal to the current one.
 */
export function percentRankSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period; i < values.length; i++) {
    const now = values[i];
    if (!Number.isFinite(now)) continue;
    let count = 0;
    let ok = true;
    for (let j = 1; j <= period; j++) {
      const past = values[i - j];
      if (!Number.isFinite(past)) {
        ok = false;
        break;
      }
      if (past <= now) count += 1;
    }
    if (ok) out[i] = (count / period) * 100;
  }
  return out;
}

/** `ta.dmi(len, len)` — returns the ADX series. */
export function adxSeries(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number[] {
  const n = highs.length;
  const plusDm = new Array<number>(n).fill(NaN);
  const minusDm = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  // `ta.dmi` smooths `ta.tr`, which is na on the first bar.
  const trur = rmaSeries(trueRangeSeries(highs, lows, closes, false), period);
  const plusS = rmaSeries(plusDm, period);
  const minusS = rmaSeries(minusDm, period);
  const dx = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (![trur[i], plusS[i], minusS[i]].every(Number.isFinite) || trur[i] === 0) continue;
    const plus = (100 * plusS[i]) / trur[i];
    const minus = (100 * minusS[i]) / trur[i];
    const sum = plus + minus;
    dx[i] = Math.abs(plus - minus) / (sum === 0 ? 1 : sum);
  }
  return rmaSeries(dx, period).map((v) => 100 * v);
}

/** Median of a list (average of the two middles when even); NaN when empty. */
export function medianOf(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
