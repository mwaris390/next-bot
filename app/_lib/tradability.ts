// How tradable a setup is, as opposed to how big yesterday's move was.
//
// This replaces 24h % change as the scanner's ranking key. A 24h move is
// backward-looking and it rewards exactly the wrong coin: the one that already
// went, on thin books, with the entry 14% behind it. What actually decides
// whether a pullback entry is worth taking is two things measured NOW —
//
//   VOLATILITY — is there enough range in a bar for the move to pay for the
//                spread and the stop, without being so wild that the structure
//                the entry leans on is noise?
//   LIQUIDITY  — is there enough 24h volume that the fill is near the screen
//                price and the exit is there when it's needed?
//
// Both are needed, so the two scores MULTIPLY rather than average. A deeply
// liquid coin that doesn't move can't produce the trade; a coin ripping 6% a
// bar on a $6M book can't be got out of. Averaging would let either one carry
// a row it shouldn't.

// ─────────────────────────── VOLATILITY ───────────────────────────
// Scored RELATIVE to the median ATR% across everything scanned this pass, not
// against fixed percentages. A sampled scan of the 241 eligible perps put the
// median 15m ATR at 1.23% with a p10 of 0.70% and a p90 of 2.46% — but that is
// one snapshot of one lively afternoon on one timeframe. Hard-coding those
// numbers would rank the whole table "too quiet" the first calm week and "too
// hot" the first panic. Against the scan's own median, "good volatility" keeps
// meaning *relative to what is actually moving right now*, which is the only
// version of the question that survives a regime change — and the reason the
// moves between 15m, 4h and 1h candles, which rescale every ATR% several
// times over, needed none of these bounds retuned.
//
// The shape is a trapezoid on that ratio: too slow to pay, good, too wild to
// lean on.

/** Below this multiple of the universe median, nothing is moving. Scores 0. */
export const VOL_DEAD = 0.35;
/** Full marks from here… */
export const VOL_GOOD_LO = 0.75;
/** …to here. */
export const VOL_GOOD_HI = 2.0;
/** Past this multiple the bar is noise, not structure. Scores 0. */
export const VOL_WILD = 4.0;

/** Where a row's ATR% sits on that trapezoid, as words. */
export type VolatilityBand = "dead" | "quiet" | "good" | "hot" | "wild";

export function volatilityBand(ratio: number): VolatilityBand {
  if (ratio < VOL_DEAD) return "dead";
  if (ratio < VOL_GOOD_LO) return "quiet";
  if (ratio <= VOL_GOOD_HI) return "good";
  if (ratio <= VOL_WILD) return "hot";
  return "wild";
}

/** 0 → 1 → 0 across the four bounds above. */
export function volatilityScore(ratio: number): number {
  if (ratio <= VOL_DEAD || ratio >= VOL_WILD) return 0;
  if (ratio < VOL_GOOD_LO) return (ratio - VOL_DEAD) / (VOL_GOOD_LO - VOL_DEAD);
  if (ratio <= VOL_GOOD_HI) return 1;
  return (VOL_WILD - ratio) / (VOL_WILD - VOL_GOOD_HI);
}

// ─────────────────────────── LIQUIDITY ────────────────────────────
// 24h quote volume, on a log scale, because the eligible universe spans three
// and a half decades — a $6M p10 against a $22B top end. Linear scaling would
// hand BTC and ETH a score no alt could come within a rounding error of, and
// every other row would tie at ~0.
//
// The floor is the scanner's own volume gate rather than zero: everything on
// the table already cleared MIN_VOLUME, so the thinnest qualifying book is
// "barely liquid enough", not "illiquid". Giving it a small positive score
// lets an otherwise perfect setup on a $6M pair still place, just low.

/** Volume that scores LIQ_FLOOR_SCORE — the scanner's own eligibility gate. */
export const LIQ_FLOOR_VOLUME = 5_000_000;
export const LIQ_FLOOR_SCORE = 0.15;
/** Volume that scores a full 1. Roughly the 95th percentile of the universe —
 *  past this, more depth stops mattering to positions this size. */
export const LIQ_FULL_VOLUME = 500_000_000;

export function liquidityScore(volume: number): number {
  if (volume <= LIQ_FLOOR_VOLUME) return LIQ_FLOOR_SCORE;
  const decades =
    Math.log10(volume / LIQ_FLOOR_VOLUME) /
    Math.log10(LIQ_FULL_VOLUME / LIQ_FLOOR_VOLUME);
  return LIQ_FLOOR_SCORE + (1 - LIQ_FLOOR_SCORE) * Math.min(1, decades);
}

// ──────────────────────────── COMBINED ────────────────────────────

export interface Tradability {
  /** ATR% ÷ the universe median ATR%. 1.0 = exactly as lively as the median. */
  volatilityRatio: number;
  band: VolatilityBand;
  volatility: number;
  liquidity: number;
  /** The ranking key: volatility × liquidity, 0–100. */
  score: number;
}

export function tradability(
  atrPercent: number,
  volume: number,
  medianAtrPercent: number,
): Tradability {
  // A zero or missing median can only happen if nothing was readable this
  // pass; fall back to a flat 1.0 ratio so every row scores on liquidity alone
  // rather than dividing by zero and ranking on NaN.
  const volatilityRatio =
    medianAtrPercent > 0 ? atrPercent / medianAtrPercent : 1;
  const volatility = volatilityScore(volatilityRatio);
  const liquidity = liquidityScore(volume);

  return {
    volatilityRatio,
    band: volatilityBand(volatilityRatio),
    volatility,
    liquidity,
    score: volatility * liquidity * 100,
  };
}

/** Median of an unsorted sample. Median rather than mean because a handful of
 *  coins mid-pump would drag a mean up and quietly re-band the whole table. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** $1.2B / $210M / $17M — volume at a glance. */
export function formatVolume(volume: number): string {
  if (volume >= 1_000_000_000) return `$${(volume / 1_000_000_000).toFixed(1)}B`;
  return `$${Math.round(volume / 1_000_000)}M`;
}
