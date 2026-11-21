// 1H context badges, ported from EMA+KST+RSI.pine: compression shading and
// CEB-X breakouts. Both are display only — they never gate a row.
//
// Callers pass CLOSED 1h bars (forming candle already dropped), so the last
// index is the last closed hour, the same bar the Pine script reads on a
// lower-timeframe chart.

import {
  adxSeries,
  medianOf,
  percentRankSeries,
  rsiSeries,
  smaSeries,
  stdevSeries,
} from "./indicators";

// ─────────────────────────── COMPRESSION ───────────────────────────
export const COMP_ADX_LEN = 14;
export const COMP_ADX_BELOW = 20;
export const COMP_BB_LEN = 20;
export const COMP_BB_MULT = 2.0;
export const COMP_BBW_LOOKBACK = 100;
export const COMP_BBW_PCT = 20;
export const COMP_RSI_LEN = 14;
export const COMP_RSI_LO = 40;
export const COMP_RSI_HI = 60;
/** Consecutive compressed 1h bars before the coil counts as "loaded". */
export const COMP_MIN_BARS = 6;

export interface Compression {
  /** The last closed 1h bar is compressed. */
  compressed: boolean;
  /** Consecutive compressed bars ending on the last closed one. */
  bars: number;
  /** bars >= COMP_MIN_BARS. */
  loaded: boolean;
  adx: number;
  bbwRank: number;
}

export function compression(
  highs: number[],
  lows: number[],
  closes: number[],
): Compression {
  const adx = adxSeries(highs, lows, closes, COMP_ADX_LEN);
  const rsi = rsiSeries(closes, COMP_RSI_LEN);
  const basis = smaSeries(closes, COMP_BB_LEN);
  const dev = stdevSeries(closes, COMP_BB_LEN);
  const width = basis.map((m, i) => (2 * COMP_BB_MULT * dev[i]) / m);
  const rank = percentRankSeries(width, COMP_BBW_LOOKBACK);

  const isComp = (i: number) =>
    adx[i] < COMP_ADX_BELOW &&
    rank[i] <= COMP_BBW_PCT &&
    rsi[i] >= COMP_RSI_LO &&
    rsi[i] <= COMP_RSI_HI;

  const last = closes.length - 1;
  let bars = 0;
  for (let i = last; i >= 0 && isComp(i); i--) bars += 1;

  return {
    compressed: bars > 0,
    bars,
    loaded: bars >= COMP_MIN_BARS,
    adx: adx[last],
    bbwRank: rank[last],
  };
}

// ─────────────────────────── CEB-X ───────────────────────────
// ESCAPE: 1H close beyond the highs/lows of >= CEB_N_MIN prior bars.
// COIL BOX: tightest recent box (lowest Lambda) the close cleared.
// ACCEPTANCE: next CEB_ACCEPT closes must stay outside the box, else fakeout (x).
// REGIME: ranging before the break (VR(16,512) < 1) AND (vol squeeze OR with 256-bar drift).
export const CEB_N_MIN = 12;
export const CEB_BOX_MAX = 768;
export const CEB_ACCEPT = 2;
/** A CEB-X event is shown when it landed on one of the last this-many closed 1h bars. */
export const CEB_RECENT_BARS = 3;
/** Bars replayed through the acceptance state machine before the last close. */
const CEB_REPLAY = 40;

interface Pending {
  t: number;
  edge: number;
  legit: boolean;
  why: string;
  boxTop: number;
  boxBot: number;
}

export interface CebEvent {
  /** Closed 1h bars since the event (0 = the last closed one). */
  barsAgo: number;
  side: 1 | -1;
  why: string;
  boxTop: number;
  boxBot: number;
}

export interface CebX {
  /** Latest accepted breakout in the replay window, if any. */
  signal: CebEvent | null;
  /** Latest fakeout (closed back inside before acceptance), if any. */
  fakeout: { barsAgo: number; side: 1 | -1 } | null;
}

/** Population variance of the `len` values ending at `end`; NaN if short. */
function varianceAt(values: number[], end: number, len: number): number {
  if (end - len + 1 < 0) return NaN;
  let sum = 0;
  for (let j = end - len + 1; j <= end; j++) {
    if (!Number.isFinite(values[j])) return NaN;
    sum += values[j];
  }
  const mean = sum / len;
  let sq = 0;
  for (let j = end - len + 1; j <= end; j++) sq += (values[j] - mean) ** 2;
  return sq / len;
}

function medianAt(values: number[], end: number, len: number): number {
  if (end - len + 1 < 0) return NaN;
  return medianOf(values.slice(end - len + 1, end + 1));
}

export function cebX(highs: number[], lows: number[], closes: number[]): CebX {
  const lH = highs.map(Math.log);
  const lL = lows.map(Math.log);
  const lC = closes.map(Math.log);
  const lr = lH.map((h, i) => h - lL[i]);
  const d16 = lC.map((c, i) => (i >= 16 ? c - lC[i - 16] : NaN));
  const d1 = lC.map((c, i) => (i >= 1 ? c - lC[i - 1] : NaN));

  const last = closes.length - 1;
  let pUp: Pending | null = null;
  let pDn: Pending | null = null;
  let signal: CebEvent | null = null;
  let fakeout: CebX["fakeout"] = null;

  for (let b = Math.max(1, last - CEB_REPLAY); b <= last; b++) {
    // 1. escape horizon
    const lim = Math.min(CEB_BOX_MAX, b);
    let nUp = 0;
    let nDn = 0;
    for (let i = 1; i <= lim; i++) {
      if (highs[b - i] >= closes[b]) break;
      nUp += 1;
    }
    if (nUp === 0) {
      for (let i = 1; i <= lim; i++) {
        if (lows[b - i] <= closes[b]) break;
        nDn += 1;
      }
    }
    const side = nUp >= CEB_N_MIN ? 1 : nDn >= CEB_N_MIN ? -1 : 0;
    const N = side === 1 ? nUp : side === -1 ? nDn : 0;

    // 2. coil box scan
    let bestLam = NaN;
    let bestUp = NaN;
    let bestDn = NaN;
    if (side !== 0) {
      const rngs: number[] = [];
      let hi = -Infinity;
      let lo = Infinity;
      let nextGrid = CEB_N_MIN;
      for (let i = 1; i <= N; i++) {
        rngs.push(lr[b - i]);
        hi = Math.max(hi, lH[b - i]);
        lo = Math.min(lo, lL[b - i]);
        if (i === nextGrid) {
          const med = medianOf(rngs);
          const sg =
            med > 0
              ? med / 1.51
              : rngs.reduce((s, v) => s + v, 0) / rngs.length / 1.5957691216;
          if (sg > 0) {
            const lam = (hi - lo) / (sg * Math.sqrt((8 * i) / Math.PI));
            if (Number.isNaN(bestLam) || lam < bestLam) {
              bestLam = lam;
              bestUp = hi;
              bestDn = lo;
            }
          }
          nextGrid = Math.ceil(nextGrid * Math.SQRT2);
        }
      }
    }

    // 4. regime test — on the bar before the break
    const vrPrev = varianceAt(d16, b - 1, 512) / (16 * varianceAt(d1, b - 1, 512));
    const med24Prev = medianAt(lr, b - 1, 24);
    const med384Prev = medianAt(lr, b - 1, 384);
    const featReady =
      Number.isFinite(vrPrev) && Number.isFinite(med384Prev) && b >= 256;
    const ranging = vrPrev < 1;
    const squeeze = med24Prev < med384Prev;
    const withDrift = b >= 256 && side * (lC[b] - lC[b - 256]) > 0;

    // 3. acceptance state machine
    let sigSide = 0;
    if (pUp) {
      if (lC[b] - pUp.edge <= 0) {
        fakeout = { barsAgo: last - b, side: 1 };
        pUp = null;
      } else if (b - pUp.t >= CEB_ACCEPT) {
        if (pUp.legit) {
          sigSide = 1;
          signal = { barsAgo: last - b, side: 1, why: pUp.why, boxTop: pUp.boxTop, boxBot: pUp.boxBot };
        }
        pUp = null;
      }
    }
    if (pDn) {
      if (pDn.edge - lC[b] <= 0) {
        fakeout = { barsAgo: last - b, side: -1 };
        pDn = null;
      } else if (b - pDn.t >= CEB_ACCEPT) {
        if (pDn.legit && sigSide === 0) {
          signal = { barsAgo: last - b, side: -1, why: pDn.why, boxTop: pDn.boxTop, boxBot: pDn.boxBot };
        }
        pDn = null;
      }
    }

    if (side !== 0 && !Number.isNaN(bestLam) && featReady) {
      const legit = ranging && (squeeze || withDrift);
      const why =
        (ranging ? "ranging (VR<1)" : "trending (VR>=1)") +
        (squeeze ? " + vol squeeze" : "") +
        (withDrift ? " + with drift" : "");
      const pending = (edge: number): Pending => ({
        t: b,
        edge,
        legit,
        why,
        boxTop: Math.exp(bestUp),
        boxBot: Math.exp(bestDn),
      });
      if (side === 1 && !pUp) pUp = pending(bestUp);
      else if (side === -1 && !pDn) pDn = pending(bestDn);
    }
  }

  return { signal, fakeout };
}
