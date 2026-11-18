/* eslint-disable @typescript-eslint/no-explicit-any */
// Market regime — the data behind the market-bias card and the per-row context
// badges for the trend-pullback scanner. Its parameters (EMA 50/200, KST,
// RSI neutral band, "near EMA" distance, fresh-cross window) come from
// ./watchlist so the card measures the market with the same rules the table
// uses to pick rows.
//
// v1 of the card measured DIRECTION only (EMA 50/200 breadth, KST breadth,
// BTC). The stop-outs it failed to warn about come from three things it never
// looked at:
//
//   STRETCH    — how far coins have already run from EMA 50. A bear market with
//                half the universe 2+ ATR under EMA 50 is late, not early: the
//                table fills with exhaustion-fade longs and continuation shorts
//                are selling the bottom of the wave.
//   VOLATILITY — whether ATR is expanding against its own 7-day norm, and how
//                big the counter-trend swings have actually been. Expanding
//                volatility turns a normal bounce into one that clears stops.
//   CROWDING   — funding. A downtrend where most perps pay negative funding is
//                short-squeeze fuel.
//
// …plus DIRECTION OF CHANGE: every breadth number is recomputed for each of the
// last HISTORY candles from the same kline arrays, so the card can say whether
// a lean is firming or fading without storing anything between renders.
//
// Each side (LONG, SHORT) gets its own 0–100 score. They are not two ends of
// one slider: both can be low (chop, or a stretched trend), and the trend side
// can score low while the trend still points that way.
//
// Thresholds and weights are starting values, not calibrated against history.
//
// ─────────────────────────── ONE CLOCK ───────────────────────────
// The forming candle is dropped in `pairRegime`; everything is closed candles.

import {
  atrSeries,
  barsSinceCross,
  dmiSeries,
  emaSeries,
  highestSeries,
  kstSeries,
  lowestSeries,
  rsiSeries,
} from "./indicators";
import {
  ATR_LENGTH,
  EMA_FAST,
  EMA_SLOW,
  KST_CROSS_BARS,
  KST_ROC,
  KST_SIGNAL,
  KST_SMA,
  NEAR_ATR,
  RSI_LENGTH,
  RSI_NEUTRAL_HI,
  RSI_NEUTRAL_LO,
} from "./watchlist";
import type { BtcMomentum } from "./btc-momentum";

// ─────────────────────────── PARAMETERS ───────────────────────────

/** Candles of breadth history, for the sparklines and the deltas. */
export const HISTORY = 24;
/** Momentum delta is measured over this many candles. */
const DELTA_BARS = 12;

/** |close − EMA 50| in ATRs past which a coin counts as stretched. */
export const STRETCH_ATR = 2;
/** A close at a new low/high of this many prior candles. */
const NEW_EXTREME_BARS = 24;
/** Window for the biggest counter-trend swing. */
const SWING_BARS = 48;
/** A coin's ATR is compared with its own average over this many candles. */
const VOL_BASE_BARS = 168;
/** Relative strength vs BTC is measured over this many candles. */
const RS_BARS = 24;
/** A KST cross this recent counts as fresh — the scanner's own window. */
const KST_FRESH_BARS = KST_CROSS_BARS;

/** Share of pairs at/past which a breadth reading leans one way. */
const LEAN_BAND = 5;
/** Stretch share (in the trend direction) at which the trend is "extended". */
export const EXTENDED_SHARE = 35;
/** Universe ATR vs its own 7-day norm: past this the market is "volatile". */
export const VOLATILE_RATIO = 1.5;
/** Rolling over: momentum must have moved this many points over DELTA_BARS. */
const ROLLOVER_DELTA = 15;

/** Funding ≥ this (per 8h, as a fraction) counts as crowded long. 0.03%. */
export const FUNDING_HOT = 0.0003;
/** Funding ≤ this counts as crowded short on a single row. −0.01%. */
const FUNDING_COLD = -0.0001;

/** Below this score a side's rows are dimmed in the tables. */
export const DIM_SCORE = 30;
/** The favoured side must lead by this much (and clear FAVOUR_MIN). */
const FAVOUR_GAP = 10;
const FAVOUR_MIN = 45;

/** Row confidence: half the market score for the row's side, half the coin's
 *  own score — which starts at 100 and loses these points per warning. */
const CONF_MARKET_WEIGHT = 0.5;
const CONF_PENALTY = {
  stretched: 25,
  squeeze: 30,
  hotVol: 20,
  rsAgainst: 15,
  /** Funding extreme against the side, when Squeeze risk didn't already fire. */
  fundingExtreme: 20,
  /** OI piling up while price moves against the side. */
  oiAgainst: 15,
  /** A strong trend (ADX) pushing against the side. */
  adxAgainst: 15,
} as const;
/** Funding beyond ±this (fraction) is extreme. 0.05%. */
const FUNDING_EXTREME = 0.0005;
/** OI change (%) over 24 candles that counts as piling up. */
const OI_SURGE = 15;
/** ADX at/above this, with the DI against the side, is a push against it. */
const ADX_AGAINST = 40;
/** Coin strength vs BTC beyond this (in %) counts for or against the row. */
const RS_MEANINGFUL = 1;
export const CONF_HIGH = 65;
export const CONF_LOW = 40;

/** Per-row badges. */
const ROW_HOT_RATIO = 2; // ATR ≥ 2× the scan median
const ROW_EXPANDING = 1.5; // ATR ≥ 1.5× the coin's own 7-day norm
const ROW_SQUEEZE_RSI_SHORT = 35;
const ROW_SQUEEZE_RSI_LONG = 65;

// Score = 100 × DIRECTION × SAFETY (+ BTC nudge). Multiplied, not added, so
// neither half can carry a side alone: a calm, uncrowded market with nothing
// pointing your way scores ~0, and so does a perfect trend that is already
// stretched, volatile and crowded.
//
// DIRECTION (0–1) — trend and momentum, half each. The counter-trend side can
// also earn a FADE credit when the trend side is stretched (capped below a full
// trend, since fades are smaller trades).
const W_TREND = 0.5;
const W_MOMENTUM = 0.5;
const FADE_CAP = 0.7;
// SAFETY (0–1) — weighted mean of room to run, volatility and crowding.
const W_ROOM = 0.5;
const W_VOL = 0.25;
const W_CROWD = 0.25;
const BTC_NUDGE = 5;
/** barsSinceCross can't see past EMA 200's warm-up; older crosses read as this. */
export const TREND_AGE_CAP = 299;

export type BiasSide = "LONG" | "SHORT";
type Lean = "BULL" | "BEAR" | "MIXED";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ramp = (v: number, lo: number, hi: number) => clamp01((v - lo) / (hi - lo));

function median(values: number[]): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid];
}

// ─────────────────────────── PER PAIR ───────────────────────────

export interface PairSnapshot {
  bull: boolean;
  kstAbove: boolean;
  aboveEma50: boolean;
  /** (close − EMA 50) / ATR, signed. */
  dist50: number;
  /** (close − EMA 200) / ATR, signed. */
  dist200: number;
  /** Close within NEAR_ATR of EMA 50 or EMA 200 — the scanner's pullback zone. */
  nearEma: boolean;
  rsi: number;
  newLow: boolean;
  newHigh: boolean;
}

export interface PairRegime {
  /** Index 0 = last closed candle, k = k candles before it. Length HISTORY + 1. */
  history: PairSnapshot[];
  /** Candles since EMA 50 last crossed EMA 200 (null = older than the data). */
  trendAge: number | null;
  /** Biggest move against the EMA stack in the last SWING_BARS candles, in ATR. */
  counterSwingAtr: number;
  atrPercent: number;
  /** ATR now ÷ this coin's average ATR over the last VOL_BASE_BARS candles. */
  volExpansion: number;
  /** % change over the last RS_BARS candles. */
  ret24: number;
  adx: number;
  plusDi: number;
  minusDi: number;
  /** Fresh KST cross direction, or null. */
  kstCross: BiasSide | null;
}

export function pairRegime(allKlines: any[]): PairRegime | null {
  const bars = allKlines.slice(0, -1);
  const last = bars.length - 1;
  if (last < EMA_SLOW + HISTORY + NEW_EXTREME_BARS) return null;

  const highs = bars.map((k: any) => parseFloat(k[2]));
  const lows = bars.map((k: any) => parseFloat(k[3]));
  const closes = bars.map((k: any) => parseFloat(k[4]));

  const ema50 = emaSeries(closes, EMA_FAST);
  const ema200 = emaSeries(closes, EMA_SLOW);
  const atr = atrSeries(highs, lows, closes, ATR_LENGTH);
  const rsi = rsiSeries(closes, RSI_LENGTH);
  const { kst, signal } = kstSeries(closes, KST_ROC, KST_SMA, KST_SIGNAL);
  const priorLow = lowestSeries(lows, NEW_EXTREME_BARS);
  const priorHigh = highestSeries(highs, NEW_EXTREME_BARS);

  const history: PairSnapshot[] = [];
  for (let k = 0; k <= HISTORY; k++) {
    const i = last - k;
    const values = [closes[i], ema50[i], ema200[i], atr[i], rsi[i], kst[i], signal[i]];
    if (!values.every(Number.isFinite) || atr[i] <= 0) return null;
    history.push({
      bull: ema50[i] > ema200[i],
      kstAbove: kst[i] > signal[i],
      aboveEma50: closes[i] > ema50[i],
      dist50: (closes[i] - ema50[i]) / atr[i],
      dist200: (closes[i] - ema200[i]) / atr[i],
      nearEma:
        Math.abs(closes[i] - ema50[i]) <= NEAR_ATR * atr[i] ||
        Math.abs(closes[i] - ema200[i]) <= NEAR_ATR * atr[i],
      rsi: rsi[i],
      newLow: lows[i] <= priorLow[i - 1],
      newHigh: highs[i] >= priorHigh[i - 1],
    });
  }

  // Counter-trend swing: in a bear stack, the biggest rally off a running low;
  // in a bull stack, the biggest drop off a running high.
  const bull = history[0].bull;
  let swing = 0;
  let runLow = Infinity;
  let runHigh = -Infinity;
  for (let j = last - SWING_BARS + 1; j <= last; j++) {
    if (bull) {
      runHigh = Math.max(runHigh, highs[j]);
      swing = Math.max(swing, runHigh - lows[j]);
    } else {
      runLow = Math.min(runLow, lows[j]);
      swing = Math.max(swing, highs[j] - runLow);
    }
  }

  let atrSum = 0;
  let atrCount = 0;
  for (let j = Math.max(0, last - VOL_BASE_BARS + 1); j <= last; j++) {
    if (Number.isFinite(atr[j]) && closes[j] > 0) {
      atrSum += atr[j] / closes[j];
      atrCount += 1;
    }
  }
  const atrPctNow = atr[last] / closes[last];
  const atrPctBase = atrCount > 0 ? atrSum / atrCount : NaN;

  const cross = barsSinceCross(ema50, ema200, last);
  const kstX = barsSinceCross(kst, signal, last);
  const dmi = dmiSeries(highs, lows, closes, ATR_LENGTH, ATR_LENGTH);

  return {
    history,
    trendAge: cross.barsSince,
    counterSwingAtr: swing / atr[last],
    atrPercent: atrPctNow * 100,
    volExpansion: atrPctBase > 0 ? atrPctNow / atrPctBase : 1,
    ret24: ((closes[last] - closes[last - RS_BARS]) / closes[last - RS_BARS]) * 100,
    adx: dmi.adx[last],
    plusDi: dmi.plus[last],
    minusDi: dmi.minus[last],
    kstCross:
      kstX.barsSince != null && kstX.barsSince < KST_FRESH_BARS
        ? kstX.side === "UP"
          ? "LONG"
          : kstX.side === "DOWN"
            ? "SHORT"
            : null
        : null,
  };
}

// ─────────────────────────── MARKET ───────────────────────────

export type PhaseId = "TRENDING" | "EXTENDED" | "COUNTER_MOVE" | "ROLLING_OVER" | "CHOP";

export interface Phase {
  id: PhaseId;
  /** "Bear · Extended" */
  label: string;
  tone: "bull" | "bear" | "mixed";
  read: string;
  action: string;
}

export interface ScorePart {
  key: "trend" | "momentum" | "fade" | "room" | "vol" | "crowd";
  group: "direction" | "safety";
  label: string;
  /** 0–1, how much this part supports the side. */
  value: number;
}

export interface SideScore {
  side: BiasSide;
  score: number;
  /** 0–1: trend + momentum, or the fade credit if larger. */
  direction: number;
  /** 0–1: room, volatility, crowding. */
  safety: number;
  parts: ScorePart[];
  /** BTC nudge applied: +BTC_NUDGE, −BTC_NUDGE or 0. */
  btc: number;
  /** True when this side runs against the EMA-stack majority. */
  counterTrend: boolean;
}

export interface FundingStats {
  /** % of scanned pairs with negative funding. */
  negativePct: number;
  /** % of scanned pairs with funding ≥ FUNDING_HOT. */
  hotPct: number;
  /** Median funding rate (fraction per 8h). */
  median: number;
  pairs: number;
}

export interface MarketRegime {
  total: number;
  /** Pairs closing above EMA 50 (the BTC card's breadth bar). */
  aboveEma50: number;
  /** Breadth series, index 0 = now, length HISTORY + 1. Percentages. */
  trend: number[];
  momentum: number[];
  stretchedDown: number[];
  stretchedUp: number[];
  newLows: number[];
  newHighs: number[];
  /** % of pairs closing within NEAR_ATR of EMA 50 or 200 (pullback zone). */
  nearEma: number[];
  /** % of pairs with RSI inside the scanner's neutral band. */
  rsiNeutral: number;
  rsiOversold: number;
  rsiOverbought: number;
  medianDist50: number;
  kstUp: number;
  kstDown: number;
  /** Median of each pair's ATR ÷ its own 7-day norm. */
  volExpansion: number;
  /** Median candles since the EMA 50/200 cross, trend-side pairs only. */
  trendAge: number | null;
  /** Median counter-trend swing (ATR), trend-side pairs only. */
  counterSwingAtr: number | null;
  funding: FundingStats | null;
  btcLean: Lean | null;
  phase: Phase;
  volatile: boolean;
  /** Breadth divergence note, or null. */
  divergence: string | null;
  scores: Record<BiasSide, SideScore>;
  favoured: BiasSide | null;
}

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 50);
const leanOf = (p: number): Lean => (p >= 50 + LEAN_BAND ? "BULL" : p <= 50 - LEAN_BAND ? "BEAR" : "MIXED");

function phaseOf(
  trendLean: Lean,
  momLean: Lean,
  trend: number[],
  momentum: number[],
  stretchWith: number,
): Phase {
  if (trendLean === "MIXED") {
    const m = momLean === "MIXED" ? "" : ` Short-term momentum ${momLean === "BULL" ? "up" : "down"}.`;
    return {
      id: "CHOP",
      label: "No trend · Chop",
      tone: "mixed",
      read: `EMA stacks are split.${m}`,
      action: "Range-edge setups only, quick targets — or stand aside.",
    };
  }

  const bear = trendLean === "BEAR";
  const word = bear ? "Bear" : "Bull";
  const tone = bear ? "bear" : "bull";
  const withSide = bear ? "short" : "long";
  const counterSide = bear ? "long" : "short";
  const opposite: Lean = bear ? "BULL" : "BEAR";

  if (momLean === opposite) {
    // Momentum against the trend: a counter move, or the trend turning.
    const momDelta = momentum[0] - momentum[DELTA_BARS];
    const trendDelta = trend[0] - trend[HISTORY];
    const turning = bear
      ? momDelta >= ROLLOVER_DELTA && trendDelta >= 3
      : momDelta <= -ROLLOVER_DELTA && trendDelta <= -3;
    if (turning)
      return {
        id: "ROLLING_OVER",
        label: `${word} · Rolling over`,
        tone: "mixed",
        read: `${bear ? "Downtrend" : "Uptrend"} losing its grip — momentum flipped and the EMA stacks are starting to follow.`,
        action: `Early reversal: ${counterSide}s are possible but small size; skip fresh ${withSide} continuation.`,
      };
    return {
      id: "COUNTER_MOVE",
      label: `${word} · ${bear ? "Bouncing" : "Pulling back"}`,
      tone,
      read: `${bear ? "Downtrend, bouncing" : "Uptrend, pulling back"} right now.`,
      action: `Wait for the ${bear ? "bounce" : "dip"} to stall at EMA 50/200, then ${withSide} with the trend. Fresh ${counterSide} crosses are likely the counter move.`,
    };
  }

  if (stretchWith >= EXTENDED_SHARE)
    return {
      id: "EXTENDED",
      label: `${word} · Extended`,
      tone: "mixed",
      read: `${bear ? "Downtrend" : "Uptrend"}, but ${stretchWith.toFixed(0)}% of pairs are already ${STRETCH_ATR}+ ATR ${bear ? "under" : "over"} EMA 50 — the move is late.`,
      action: `No continuation ${withSide}s here. ${bear ? "Short" : "Long"} only after a ${bear ? "bounce" : "dip"} back into EMA 50; fade ${counterSide}s ok, quick targets.`,
    };

  return {
    id: "TRENDING",
    label: `${word} · Trending`,
    tone,
    read: `${bear ? "Downtrend" : "Uptrend"} with momentum, and room left to run.`,
    action: `Take ${withSide} pullbacks to the EMAs; ${counterSide}s are counter-trend.`,
  };
}

function sideScore(
  side: BiasSide,
  m: {
    trendPct: number;
    momentum: number[];
    stretchedDown: number;
    stretchedUp: number;
    volExpansion: number;
    funding: FundingStats | null;
    btcLean: Lean | null;
    trendLean: Lean;
  },
): SideScore {
  const long = side === "LONG";
  const share = (p: number) => (long ? p : 100 - p);

  const trend = ramp(share(m.trendPct), 30, 70);
  const momNow = share(m.momentum[0]);
  const momDelta = momNow - share(m.momentum[DELTA_BARS]);
  const momentum = 0.7 * ramp(momNow, 30, 70) + 0.3 * clamp01(0.5 + momDelta / 30);
  // Room: few pairs already stretched in this side's direction.
  const stretched = long ? m.stretchedUp : m.stretchedDown;
  const room = 1 - ramp(stretched, 15, 45);
  const vol = 1 - ramp(m.volExpansion, 1.1, 1.8);
  const crowd = m.funding
    ? long
      ? 1 - ramp(m.funding.hotPct, 15, 45)
      : 1 - ramp(m.funding.negativePct, 40, 75)
    : 0.5;

  // Fade credit: the OTHER side is stretched, so a snap back is in play.
  const fade = FADE_CAP * ramp(long ? m.stretchedDown : m.stretchedUp, 20, 50);
  const trendDir = W_TREND * trend + W_MOMENTUM * momentum;
  const direction = Math.max(trendDir, fade);
  const safety = W_ROOM * room + W_VOL * vol + W_CROWD * crowd;

  const parts: ScorePart[] = [
    { key: "trend", group: "direction", label: "trend", value: trend },
    { key: "momentum", group: "direction", label: "momentum", value: momentum },
    ...(fade > trendDir
      ? [{ key: "fade" as const, group: "direction" as const, label: "fade", value: fade / FADE_CAP }]
      : []),
    { key: "room", group: "safety", label: "room", value: room },
    { key: "vol", group: "safety", label: "vol", value: vol },
    { key: "crowd", group: "safety", label: m.funding ? "crowding" : "crowding n/a", value: crowd },
  ];

  const btc =
    m.btcLean == null || m.btcLean === "MIXED"
      ? 0
      : (m.btcLean === "BULL") === long
        ? BTC_NUDGE
        : -BTC_NUDGE;

  const raw = 100 * direction * safety + btc;
  return {
    side,
    score: Math.round(Math.min(100, Math.max(0, raw))),
    direction,
    safety,
    parts,
    btc,
    counterTrend: m.trendLean !== "MIXED" && (m.trendLean === "BULL") !== long,
  };
}

export function fundingStats(
  symbols: string[],
  rates: Map<string, number> | null,
): FundingStats | null {
  if (!rates) return null;
  const values = symbols.map((s) => rates.get(s)).filter((v): v is number => Number.isFinite(v));
  if (values.length === 0) return null;
  return {
    negativePct: pct(values.filter((v) => v < 0).length, values.length),
    hotPct: pct(values.filter((v) => v >= FUNDING_HOT).length, values.length),
    median: median(values),
    pairs: values.length,
  };
}

export function buildMarketRegime(
  regimes: Map<string, PairRegime>,
  fundingRates: Map<string, number> | null,
  btc: BtcMomentum | null,
): MarketRegime {
  const list = [...regimes.values()];
  const total = list.length;

  const series = (test: (s: PairSnapshot) => boolean) =>
    Array.from({ length: HISTORY + 1 }, (_, k) =>
      pct(list.filter((r) => test(r.history[k])).length, total),
    );

  const trend = series((s) => s.bull);
  const momentum = series((s) => s.kstAbove);
  const stretchedDown = series((s) => s.dist50 <= -STRETCH_ATR);
  const stretchedUp = series((s) => s.dist50 >= STRETCH_ATR);
  const newLows = series((s) => s.newLow);
  const newHighs = series((s) => s.newHigh);
  const nearEma = series((s) => s.nearEma);

  const now = list.map((r) => r.history[0]);
  const trendLean = leanOf(trend[0]);
  const momLean = leanOf(momentum[0]);
  const volExpansion = median(list.map((r) => r.volExpansion));
  const volatile = Number.isFinite(volExpansion) && volExpansion >= VOLATILE_RATIO;

  // Trend age and swing size: only the pairs that are on the trend's side.
  const trendSide = list.filter((r) =>
    trendLean === "MIXED" ? true : r.history[0].bull === (trendLean === "BULL"),
  );
  const ageMedian = median(trendSide.map((r) => Math.min(TREND_AGE_CAP, r.trendAge ?? TREND_AGE_CAP)));
  const swingMedian = median(trendSide.map((r) => r.counterSwingAtr));

  const btcLean: Lean | null = btc
    ? btc.verdict === "BULLISH"
      ? "BULL"
      : btc.verdict === "BEARISH"
        ? "BEAR"
        : "MIXED"
    : null;

  const funding = fundingStats([...regimes.keys()], fundingRates);
  const stretchWith =
    trendLean === "BEAR" ? stretchedDown[0] : trendLean === "BULL" ? stretchedUp[0] : 0;
  const phase = phaseOf(trendLean, momLean, trend, momentum, stretchWith);

  // Divergence: the extreme-makers thinning out while the trend still points on.
  let divergence: string | null = null;
  if (trendLean === "BEAR" && newLows[DELTA_BARS] >= 15 && newLows[0] <= newLows[DELTA_BARS] * 0.5)
    divergence = `Selling narrowing: ${newLows[0].toFixed(0)}% at a new ${NEW_EXTREME_BARS}-candle low vs ${newLows[DELTA_BARS].toFixed(0)}% ${DELTA_BARS} candles ago`;
  else if (trendLean === "BULL" && newHighs[DELTA_BARS] >= 15 && newHighs[0] <= newHighs[DELTA_BARS] * 0.5)
    divergence = `Buying narrowing: ${newHighs[0].toFixed(0)}% at a new ${NEW_EXTREME_BARS}-candle high vs ${newHighs[DELTA_BARS].toFixed(0)}% ${DELTA_BARS} candles ago`;

  const input = {
    trendPct: trend[0],
    momentum,
    stretchedDown: stretchedDown[0],
    stretchedUp: stretchedUp[0],
    volExpansion: Number.isFinite(volExpansion) ? volExpansion : 1,
    funding,
    btcLean,
    trendLean,
  };
  const scores = { LONG: sideScore("LONG", input), SHORT: sideScore("SHORT", input) };
  const [hi, lo] =
    scores.LONG.score >= scores.SHORT.score ? [scores.LONG, scores.SHORT] : [scores.SHORT, scores.LONG];
  const favoured = hi.score >= FAVOUR_MIN && hi.score - lo.score >= FAVOUR_GAP ? hi.side : null;

  let kstUp = 0;
  let kstDown = 0;
  for (const r of list) {
    if (r.kstCross === "LONG") kstUp += 1;
    else if (r.kstCross === "SHORT") kstDown += 1;
  }

  return {
    total,
    aboveEma50: now.filter((s) => s.aboveEma50).length,
    trend,
    momentum,
    stretchedDown,
    stretchedUp,
    newLows,
    newHighs,
    nearEma,
    rsiNeutral: pct(now.filter((s) => s.rsi >= RSI_NEUTRAL_LO && s.rsi <= RSI_NEUTRAL_HI).length, total),
    rsiOversold: pct(now.filter((s) => s.rsi <= 30).length, total),
    rsiOverbought: pct(now.filter((s) => s.rsi >= 70).length, total),
    medianDist50: median(now.map((s) => s.dist50)),
    kstUp,
    kstDown,
    volExpansion: input.volExpansion,
    trendAge: Number.isFinite(ageMedian) ? ageMedian : null,
    counterSwingAtr: Number.isFinite(swingMedian) ? swingMedian : null,
    funding,
    btcLean,
    phase,
    volatile,
    divergence,
    scores,
    favoured,
  };
}

// ─────────────────────────── PER ROW ───────────────────────────
// Context tags for a table row. Highlights only: nothing here removes a row.

export type ContextTone = "bull" | "bear" | "warn" | "muted";

export interface ContextTag {
  label: string;
  tone: ContextTone;
  title: string;
}

export interface RowVerdict {
  /** "Tradeable" / "Wait · half size" / "Skip" */
  headline: string;
  level: "high" | "medium" | "low";
  /** What to do, one short line. */
  action: string;
  pros: string[];
  /** Biggest risk first. */
  cons: string[];
}

export interface RowContext {
  tags: ContextTag[];
  /** The row's side scores under DIM_SCORE on the bias card. */
  dim: boolean;
  dimReason: string | null;
  /** 0–100: market support for the side × the coin's own warnings. */
  confidence: number;
  /** One line per input to `confidence`, for the hover text. */
  confidenceWhy: string[];
  verdict: RowVerdict;
}

const pctText = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;

export function rowContext({
  symbol,
  side,
  volatilityRatio,
  pair,
  market,
  fundingRate,
  btcRet24,
  oiChange,
  setupPros = [],
}: {
  symbol: string;
  side: BiasSide;
  /** ATR% ÷ the scan median. */
  volatilityRatio: number;
  pair: PairRegime | undefined;
  market: MarketRegime;
  fundingRate: number | undefined;
  btcRet24: number | null;
  /** Open-interest % change over 24 candles, if fetched. */
  oiChange: number | undefined;
  /** The page's own reasons for the setup ("3 strategies agree", …). */
  setupPros?: string[];
}): RowContext {
  const tags: ContextTag[] = [];
  const long = side === "LONG";
  const sides = long ? "longs" : "shorts";
  const now = pair?.history[0];
  /** [short reason shown in the verdict, points off the coin score] */
  const penalties: [string, number][] = [];
  const pros = [...setupPros];
  const extraCons: string[] = [];

  // ── Market bias ──
  if (market.favoured) {
    const withBias = market.favoured === side;
    tags.push(
      withBias
        ? { label: "With bias", tone: long ? "bull" : "bear", title: `Market bias favours ${side}s` }
        : { label: "Counter bias", tone: "warn", title: `Market bias favours ${market.favoured}s` },
    );
    if (withBias) pros.push(`Market favours ${sides}`);
    else extraCons.push(`Market favours ${market.favoured.toLowerCase()}s`);
  }

  // ── Stretch ──
  const stretched = now != null && (long ? now.dist50 >= STRETCH_ATR : now.dist50 <= -STRETCH_ATR);
  if (now && stretched) {
    tags.push({
      label: "Stretched",
      tone: "warn",
      title: `Already ${Math.abs(now.dist50).toFixed(1)} ATR ${long ? "above" : "below"} EMA 50 in the trade direction — chasing`,
    });
    penalties.push([`${Math.abs(now.dist50).toFixed(1)} ATR from EMA 50 — chasing`, CONF_PENALTY.stretched]);
  }

  // ── Crowding: squeeze risk, then extreme funding on its own ──
  const fundingAgainst = fundingRate != null && (long ? fundingRate >= FUNDING_HOT : fundingRate <= FUNDING_COLD);
  const fundingExtreme =
    fundingRate != null && (long ? fundingRate >= FUNDING_EXTREME : fundingRate <= -FUNDING_EXTREME);
  let squeeze = false;
  if (now) {
    const rsiSays = long ? now.rsi >= ROW_SQUEEZE_RSI_LONG : now.rsi <= ROW_SQUEEZE_RSI_SHORT;
    squeeze = rsiSays && (fundingAgainst || stretched);
    if (squeeze) {
      tags.push({
        label: "Squeeze risk",
        tone: "warn",
        title: `${long ? "Long" : "Short"} into RSI ${now.rsi.toFixed(0)}${
          fundingRate != null ? `, funding ${(fundingRate * 100).toFixed(4)}%` : ""
        } — the ${sides} are crowded`,
      });
      penalties.push([`${sides[0].toUpperCase()}${sides.slice(1)} crowded + RSI ${now.rsi.toFixed(0)} — squeeze risk`, CONF_PENALTY.squeeze]);
    }
  }
  if (fundingExtreme && !squeeze)
    penalties.push([
      `Funding ${(fundingRate! * 100).toFixed(3)}% — ${sides} crowded, squeeze fuel`,
      CONF_PENALTY.fundingExtreme,
    ]);
  // The other side crowded is fuel for this one.
  if (fundingRate != null && (long ? fundingRate <= -FUNDING_EXTREME : fundingRate >= FUNDING_EXTREME))
    pros.push(`${long ? "Shorts" : "Longs"} crowded — fuel for you`);

  // ── Volatility ──
  const expanding = pair && pair.volExpansion >= ROW_EXPANDING;
  if (volatilityRatio >= ROW_HOT_RATIO || expanding) {
    tags.push({
      label: "Hot vol",
      tone: "warn",
      title: `ATR ${volatilityRatio.toFixed(1)}× the scan median${
        pair ? `, ${pair.volExpansion.toFixed(1)}× its own 7-day norm` : ""
      } — counter swings will be large`,
    });
    penalties.push(["Big candles — swings can hit a tight stop", CONF_PENALTY.hotVol]);
  }

  // ── Strength vs BTC ──
  if (pair && btcRet24 != null && symbol !== "BTCUSDT") {
    const rs = pair.ret24 - btcRet24;
    const aligned = long ? rs > 0 : rs < 0;
    tags.push({
      label: `RS ${rs >= 0 ? "+" : ""}${rs.toFixed(1)}% vs BTC`,
      tone: Math.abs(rs) < RS_MEANINGFUL ? "muted" : aligned ? (long ? "bull" : "bear") : "warn",
      title: `24-candle return ${pair.ret24.toFixed(2)}% vs BTC ${btcRet24.toFixed(2)}% — ${
        aligned ? "agrees with" : "fights"
      } the ${side.toLowerCase()}`,
    });
    if (Math.abs(rs) >= RS_MEANINGFUL) {
      if (aligned) pros.push(`${long ? "Stronger" : "Weaker"} than BTC (${pctText(rs)})`);
      else penalties.push([`${long ? "Weaker" : "Stronger"} than BTC (${pctText(rs)})`, CONF_PENALTY.rsAgainst]);
    }
  }

  // ── ADX pushing against the side ──
  if (pair && Number.isFinite(pair.adx) && pair.adx >= ADX_AGAINST) {
    const pushUp = pair.plusDi > pair.minusDi;
    if (pushUp === !long)
      penalties.push([`ADX ${pair.adx.toFixed(0)} — strong push ${pushUp ? "up" : "down"} against you`, CONF_PENALTY.adxAgainst]);
  }

  // ── Funding tag ──
  if (fundingRate != null)
    tags.push({
      label: `Fund ${(fundingRate * 100).toFixed(3)}%`,
      tone: fundingAgainst ? "warn" : "muted",
      title: "Last funding rate. Negative = shorts paying longs (shorts crowded); high positive = longs crowded.",
    });

  // ── Open interest ──
  if (oiChange != null && Number.isFinite(oiChange)) {
    const priceUp = (pair?.ret24 ?? 0) >= 0;
    const oiUp = oiChange >= 0;
    // Funding says who is doing the opening when OI rises.
    const meaning = oiUp
      ? priceUp
        ? fundingRate != null && fundingRate <= FUNDING_COLD
          ? "shorts adding into the rise — squeeze fuel"
          : "new longs opening"
        : fundingRate != null && fundingRate >= FUNDING_HOT
          ? "longs adding into the drop — flush fuel"
          : "new shorts opening"
      : priceUp
        ? "shorts covering"
        : "longs closing out";
    tags.push({
      label: `OI ${oiUp ? "+" : ""}${oiChange.toFixed(1)}%`,
      tone: "muted",
      title: `Open interest over 24 candles: ${meaning}`,
    });
    const againstSide = long ? !priceUp : priceUp;
    if (oiChange >= OI_SURGE && againstSide)
      penalties.push([
        `OI ${pctText(oiChange, 0)} while price ${priceUp ? "rises" : "falls"} — ${meaning.split(" — ")[0]}`,
        CONF_PENALTY.oiAgainst,
      ]);
  }

  // ── Confidence ──
  const score = market.scores[side].score;
  const dim = score < DIM_SCORE;
  const coinScore = Math.max(0, 100 - penalties.reduce((sum, [, p]) => sum + p, 0));
  const confidence = Math.round(CONF_MARKET_WEIGHT * score + (1 - CONF_MARKET_WEIGHT) * coinScore);
  const confidenceWhy = [
    `Market ${side} score ${score}/100 (half)`,
    `Coin score ${coinScore}/100 (half)${penalties.length ? ":" : " — no warnings"}`,
    ...penalties.map(([why, p]) => `  −${p} ${why}`),
  ];

  // ── Verdict ──
  const level = confidence >= CONF_HIGH ? "high" : confidence >= CONF_LOW ? "medium" : "low";
  const cons = [...[...penalties].sort((a, b) => b[1] - a[1]).map(([why]) => why), ...extraCons];
  const verdict: RowVerdict =
    level === "high"
      ? {
          headline: cons.length ? "Tradeable — mind the risk" : "Tradeable",
          level,
          action: "Normal size; stop beyond the swing.",
          pros,
          cons,
        }
      : level === "medium"
        ? {
            headline: "Wait · half size",
            level,
            action: `Wait for one more close ${long ? "up" : "down"}; half size, wide stop.`,
            pros,
            cons,
          }
        : {
            headline: "Skip",
            level,
            action: "Too much against it — skip unless the chart is compelling.",
            pros,
            cons,
          };

  return {
    tags,
    dim,
    dimReason: dim ? `${side} scores ${score}/100 on the market-bias card` : null,
    confidence,
    confidenceWhy,
    verdict,
  };
}
