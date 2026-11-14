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
export function trueRangeSeries(
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

// ─────────────────────── Rolling-window helpers ───────────────────────
// Same contract as above: output length = input length, NaN through warm-up,
// and a window that holds an na produces an na (Pine's behaviour after warm-up).

/** Runs `pick` over each full, hole-free window of `period` values ending at i. */
function rolling(
  values: number[],
  period: number,
  pick: (window: number[]) => number,
): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let holes = 0;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) holes += 1;
    if (i >= period && !Number.isFinite(values[i - period])) holes -= 1;
    if (i >= period - 1 && holes === 0) {
      out[i] = pick(values.slice(i - period + 1, i + 1));
    }
  }
  return out;
}

/** `ta.highest` — max of the last `period` values, current bar included. */
export function highestSeries(values: number[], period: number): number[] {
  return rolling(values, period, (w) => Math.max(...w));
}

/** `ta.lowest` — min of the last `period` values, current bar included. */
export function lowestSeries(values: number[], period: number): number[] {
  return rolling(values, period, (w) => Math.min(...w));
}

/** `math.sum` — rolling sum over `period` values. */
export function sumSeries(values: number[], period: number): number[] {
  return rolling(values, period, (w) => w.reduce((a, b) => a + b, 0));
}

/** `ta.stdev` — population (biased) standard deviation, Pine's default. */
export function stdevSeries(values: number[], period: number): number[] {
  return rolling(values, period, (w) => {
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    return Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / w.length);
  });
}

/**
 * `ta.percentrank` — percent (0–100) of the previous `period` values that are
 * less than or equal to the current one. The current bar is not in the window.
 */
export function percentRankSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period; i < values.length; i++) {
    const current = values[i];
    if (!Number.isFinite(current)) continue;
    let count = 0;
    let complete = true;
    for (let j = i - period; j < i; j++) {
      if (!Number.isFinite(values[j])) {
        complete = false;
        break;
      }
      if (values[j] <= current) count += 1;
    }
    if (complete) out[i] = (count / period) * 100;
  }
  return out;
}

/** `ta.percentile_nearest_rank` — nearest-rank percentile of the last `period` values. */
export function percentileNearestRankSeries(
  values: number[],
  period: number,
  percentage: number,
): number[] {
  return rolling(values, period, (w) => {
    const sorted = [...w].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil((percentage / 100) * sorted.length));
    return sorted[rank - 1];
  });
}

/** `ta.median` — median of the last `period` values. */
export function medianSeries(values: number[], period: number): number[] {
  return rolling(values, period, (w) => {
    const sorted = [...w].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  });
}

/** `ta.barssince` — bars since `condition` was last true (0 = this bar), NaN if never. */
export function barsSinceSeries(condition: boolean[]): number[] {
  const out = new Array<number>(condition.length).fill(NaN);
  let last = -1;
  for (let i = 0; i < condition.length; i++) {
    if (condition[i]) last = i;
    if (last >= 0) out[i] = i - last;
  }
  return out;
}

/** `x[n]` — the series shifted back `n` bars (NaN where there is no history). */
export function shiftSeries(values: number[], n = 1): number[] {
  return values.map((_, i) => (i - n >= 0 ? values[i - n] : NaN));
}

// ─────────────────────── DMI / ADX and KST ───────────────────────

/**
 * `ta.dmi(diLength, adxSmoothing)` — [+DI, −DI, ADX]. Built on `ta.tr` (na on
 * the first bar), RMA-smoothed, exactly as Pine's reference implementation.
 */
export function dmiSeries(
  highs: number[],
  lows: number[],
  closes: number[],
  diLength: number,
  adxSmoothing: number,
): { plus: number[]; minus: number[]; adx: number[] } {
  const n = highs.length;
  const plusDm = new Array<number>(n).fill(NaN);
  const minusDm = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  const trur = rmaSeries(trueRangeSeries(highs, lows, closes, false), diLength);
  const plusS = rmaSeries(plusDm, diLength);
  const minusS = rmaSeries(minusDm, diLength);

  const plus = new Array<number>(n).fill(NaN);
  const minus = new Array<number>(n).fill(NaN);
  const dx = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(trur[i]) || trur[i] === 0) continue;
    plus[i] = (100 * plusS[i]) / trur[i];
    minus[i] = (100 * minusS[i]) / trur[i];
    const sum = plus[i] + minus[i];
    dx[i] = Math.abs(plus[i] - minus[i]) / (sum === 0 ? 1 : sum);
  }
  const adx = rmaSeries(dx, adxSmoothing).map((v) => 100 * v);
  return { plus, minus, adx };
}

/** KST: weighted (1,2,3,4) sum of SMA-smoothed ROCs, plus its SMA signal line. */
export function kstSeries(
  closes: number[],
  roc: readonly number[],
  sma: readonly number[],
  signalLength: number,
): { kst: number[]; signal: number[] } {
  const legs = roc.map((rocLength, index) =>
    smaSeries(rocSeries(closes, rocLength), sma[index]),
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
      total += (leg + 1) * value;
    }
    if (complete) kst[i] = total;
  }
  return { kst, signal: smaSeries(kst, signalLength) };
}
