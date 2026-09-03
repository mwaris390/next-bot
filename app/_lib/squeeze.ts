/* eslint-disable @typescript-eslint/no-explicit-any */
// Bollinger squeeze, ported from the BB block of kst-pullback.pine.
//
// In that script the squeeze is explicitly COLOUR ONLY — it fills the bands
// and shades the background, but it does not gate a signal. The scanner keeps
// that division: a squeeze is a bonus badge next to a signal, and one of the
// two qualifying rules on the watchlist, never a filter on the signal itself.
//
// Bandwidth is normalised by the basis so it compares across price levels,
// then ranked against the prior `PERCENTILE_LOOKBACK` bars. Ranking rather
// than thresholding is what makes one number work across the whole universe:
// "tight for this symbol lately" means the same thing on BTC and on a
// low-priced alt, where a raw bandwidth figure would not.
//
// Like the rest of the scanner this reads the LIVE, still-forming candle —
// Pine's `sqzUse` on its default clock. See ./kst-pullback for why.

import { bandwidthSeries, percentRankSeries } from "./indicators";

// ─────────────────────────── PARAMETERS ───────────────────────────
// These mirror the `input.*` defaults in kst-pullback.pine one for one.
export const BB_LENGTH = 20;
export const BB_STDDEV = 2.0;
export const PERCENTILE_LOOKBACK = 240; // 240 bars on 1h ~ 10 days
export const SQUEEZE_PERCENTILE = 20;
export const EXTREME_PERCENTILE = SQUEEZE_PERCENTILE / 2;

// Pine gates every squeeze on `bar_index > lookback + bbLen`; the +2 leaves at
// least one qualifying bar plus the bar before it to compare against.
export const MIN_CANDLES = PERCENTILE_LOOKBACK + BB_LENGTH + 2;

export interface SqueezeState {
  /** Bandwidth percentile on the read bar. Lower = tighter. */
  rank: number;
  /** BB bandwidth as a percent of the basis. */
  bandwidth: number;
  /** Pine `squeeze`: bandwidth in the bottom SQUEEZE_PERCENTILE%. */
  squeeze: boolean;
  /** Pine `extreme`: the bottom half of that band again. */
  extreme: boolean;
}

/**
 * The Pine's `squeeze`/`extreme` at one bar of a FULL kline series — pass the
 * live index to reproduce the chart's default clock.
 */
export function squeezeAt(klines: any[], at: number): SqueezeState | null {
  if (klines.length < MIN_CANDLES || at < 0 || at >= klines.length) return null;

  const closes = klines.map((k: any) => parseFloat(k[4]));
  const bandwidth = bandwidthSeries(closes, BB_LENGTH, BB_STDDEV);
  const ranks = percentRankSeries(bandwidth, PERCENTILE_LOOKBACK);

  const rank = ranks[at];
  // Pine's `enoughData` guard: no verdict until the percentile has a full
  // window of its own behind it.
  const enoughData = at > PERCENTILE_LOOKBACK + BB_LENGTH;
  if (!enoughData || !Number.isFinite(rank)) return null;

  return {
    rank,
    bandwidth: bandwidth[at],
    squeeze: rank <= SQUEEZE_PERCENTILE,
    extreme: rank <= EXTREME_PERCENTILE,
  };
}
