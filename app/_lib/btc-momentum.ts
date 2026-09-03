/* eslint-disable @typescript-eslint/no-explicit-any */
// BTCUSDT.P momentum leveler — the regime read the two tables don't give you.
//
// A 1h KST pullback long into a week of BTC bleeding is a different trade from
// the same setup with BTC grinding up, so this sits above the tables as
// context: where BTC's last MOMENTUM_DAYS have left it, rendered as a spirit
// level. Flat is neutral, nose up is bullish, nose down bearish. It gates
// nothing and filters nothing — same standing as RVOL and the squeeze badge.
//
// Read on 1h candles, like everything else on this page. The window is still a
// week; it is measured in 168 hourly bars rather than 7 daily ones. That
// matters for two reasons: the bars line up with the chart the signals are
// taken from, and a daily series only moves once a day — on an hourly refresh
// it would hand back the same reading 23 times out of 24.
//
// Three legs, because each one alone lies in a way the others catch:
//
//   trend    — net % across the window, scaled by BTC's OWN hourly ATR, so +5%
//              counts as strong in a quiet regime and unremarkable in a
//              violent one. A fixed percentage threshold cannot do that.
//   position — where price sits inside the window's high–low range. Catches
//              the week that round-trips: plenty of movement, nothing held.
//   bodies   — the up/down balance of the candles themselves, each weighted by
//              body-to-range and by recency.
//
// Measured over a year of 1h bars (Apr 2025 → Aug 2026, ~11.7k readings) the
// composite runs −0.78…+0.77 with a median of −0.00, and the trend leg
// saturates in the top decile of weeks — full tilt means an exceptional week,
// not a merely good one. What it does NOT do is forecast: BULLISH hours were
// followed by +0.10% over the next 24h and BEARISH by −0.13%, against a 2%
// daily sd. Read it as orientation, never as a direction call.
//
// Like the scanner's indicators this reads the LIVE, still-forming 1h candle.
// Only ATR comes off the last CLOSED bar, because a partial bar's true range
// would read as a volatility collapse for most of every hour.

import { getKlines } from "./binance";
import { atrSeries } from "./indicators";

// ─────────────────────────── PARAMETERS ───────────────────────────
export const BTC_SYMBOL = "BTCUSDT";
export const MOMENTUM_DAYS = 7;

const INTERVAL = "1h";
export const MOMENTUM_INTERVAL_LABEL = "1H";

const BARS_PER_DAY = 24;
/** The window, in 1h bars. */
const MOMENTUM_BARS = MOMENTUM_DAYS * BARS_PER_DAY;

/** How much score history the card traces, and the hysteresis warm-up. */
export const HISTORY_BARS = 72;

// A day of hourly bars. Short enough to track the current regime, long enough
// that the trend scale doesn't jump around from hour to hour.
const ATR_LENGTH = BARS_PER_DAY;

// History (72) + window (168) + ATR warm-up (24), plus slack. Binance buckets
// klines weight by `limit` — anything under 500 costs 2 — so the extra history
// this buys is free.
const KLINE_LIMIT = 320;

// Leg weights. Trend leads because direction is the question being asked;
// position and bodies are there to veto a number that only looks like a trend.
const TREND_WEIGHT = 0.45;
const POSITION_WEIGHT = 0.3;
const BODY_WEIGHT = 0.25;

// Hysteresis. A single band made the verdict flip every ~0.6 days while the
// 24h autocorrelation of the score was 0.81 — the word flickered while the
// needle barely moved, because a score parked near the threshold crosses it on
// noise. So the meter must reach ENTER_BAND to take a side and fall back
// inside EXIT_BAND to give it up.
const ENTER_BAND = 0.2;
const EXIT_BAND = 0.1;

/** Tilt at |score| = 1. Past ~35° the needle stops reading as a level. */
export const MAX_TILT_DEG = 32;

export type BtcVerdict = "BULLISH" | "NEUTRAL" | "BEARISH";

export interface BtcMomentum {
  /** Live price — the forming 1h candle's close. The needle's right end. */
  price: number;
  /** Where the window opened: the close MOMENTUM_BARS bars back, and the
   *  needle's left end. The two together are what the tilt is measuring. */
  referencePrice: number;
  /** Net % across the window. */
  changePercent: number;
  /** −1 … +1 composite. */
  score: number;
  /** Needle tilt in degrees; positive = nose up = bullish. */
  angle: number;
  /** Verdict after hysteresis — not a plain threshold on `score`. */
  verdict: BtcVerdict;
  /** Score now minus score a day ago: is the lean firming or fading? */
  scoreDelta: number;
  /** The last HISTORY_BARS scores, oldest first. The card's trend trace. */
  history: number[];
  /** Window length, for the card's labels. */
  days: number;
  bars: number;

  // ── Legs, kept for the hover breakdown ──
  trendScore: number;
  positionScore: number;
  bodyScore: number;
  /** 0–100: where price sits in the window's range. */
  rangePosition: number;
  greenBars: number;
  redBars: number;
}

const clamp = (value: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, value));

/**
 * `ttlMs` is the caller's, exactly as in getKlines. The page passes the same
 * one-scan-per-1h-candle TTL it gives the scanner, so the card is re-sampled
 * moments after each hourly close and held for the hour — one rule for the
 * whole page.
 */
export async function getBtcMomentum(
  ttlMs: number,
): Promise<BtcMomentum | null> {
  try {
    const klines = await getKlines(BTC_SYMBOL, INTERVAL, KLINE_LIMIT, ttlMs);
    return evaluateBtcMomentum(klines);
  } catch {
    // Context, not content. A rate-limited card renders blank instead of
    // taking the whole scanner down with it.
    return null;
  }
}

interface Series {
  opens: number[];
  highs: number[];
  lows: number[];
  closes: number[];
  atr: number[];
}

interface Legs {
  score: number;
  changePercent: number;
  reference: number;
  trendScore: number;
  positionScore: number;
  bodyScore: number;
  rangePosition: number;
  greenBars: number;
  redBars: number;
}

/** The composite as of bar `i`, treating `i` as the live bar. */
function legsAt(i: number, s: Series): Legs | null {
  const start = i - MOMENTUM_BARS + 1;
  const prev = i - 1;
  if (start < 1) return null;

  const price = s.closes[i];
  const reference = s.closes[start - 1]; // close of the bar before the window
  if (!Number.isFinite(price) || !Number.isFinite(reference)) return null;

  // ── Trend: the net move, priced against what a week normally does to BTC ──
  const changePercent = ((price - reference) / reference) * 100;
  const barAtrPercent = (s.atr[prev] / s.closes[prev]) * 100;
  // Ranges compound as sqrt(N) under a random walk, so this is roughly the move
  // a directionless week produces on its own. Full tilt is one of those.
  const trendScale = barAtrPercent * Math.sqrt(MOMENTUM_BARS);
  const trendScore =
    Number.isFinite(trendScale) && trendScale > 0
      ? clamp(changePercent / trendScale, -1, 1)
      : 0;

  // ── Position: what the window's range has actually been left holding ──
  let high = -Infinity;
  let low = Infinity;
  for (let j = start; j <= i; j++) {
    if (s.highs[j] > high) high = s.highs[j];
    if (s.lows[j] < low) low = s.lows[j];
  }
  const span = high - low;
  const rangePosition = span > 0 ? ((price - low) / span) * 100 : 50;
  const positionScore = rangePosition / 50 - 1;

  // ── Bodies: the candles themselves, the newest bars weighted heaviest ──
  let weighted = 0;
  let totalWeight = 0;
  let greenBars = 0;
  let redBars = 0;

  for (let j = start; j <= i; j++) {
    const body = s.closes[j] - s.opens[j];
    const range = s.highs[j] - s.lows[j];
    // Body over range, signed — so a bar that swung both ways and closed where
    // it opened counts for almost nothing in either direction.
    const strength = range > 0 ? clamp(body / range, -1, 1) : 0;
    const weight = j - start + 1; // linear recency ramp, oldest = 1

    weighted += strength * weight;
    totalWeight += weight;

    if (body > 0) greenBars += 1;
    else if (body < 0) redBars += 1;
  }

  const bodyScore = totalWeight > 0 ? weighted / totalWeight : 0;

  return {
    score: clamp(
      trendScore * TREND_WEIGHT +
        positionScore * POSITION_WEIGHT +
        bodyScore * BODY_WEIGHT,
      -1,
      1,
    ),
    changePercent,
    reference,
    trendScore,
    positionScore,
    bodyScore,
    rangePosition,
    greenBars,
    redBars,
  };
}

/** One step of the two-band state machine. */
function nextVerdict(prev: BtcVerdict, score: number): BtcVerdict {
  if (score >= ENTER_BAND) return "BULLISH";
  if (score <= -ENTER_BAND) return "BEARISH";
  if (prev === "BULLISH" && score > EXIT_BAND) return "BULLISH";
  if (prev === "BEARISH" && score < -EXIT_BAND) return "BEARISH";
  return "NEUTRAL";
}

export function evaluateBtcMomentum(klines: any[]): BtcMomentum | null {
  const live = klines.length - 1;
  if (live < MOMENTUM_BARS + ATR_LENGTH) return null;

  const highs = klines.map((k: any) => parseFloat(k[2]));
  const lows = klines.map((k: any) => parseFloat(k[3]));
  const closes = klines.map((k: any) => parseFloat(k[4]));
  const series: Series = {
    opens: klines.map((k: any) => parseFloat(k[1])),
    highs,
    lows,
    closes,
    atr: atrSeries(highs, lows, closes, ATR_LENGTH),
  };

  // Replay the score forward so the verdict's hysteresis has somewhere to come
  // from. Each render is stateless — nothing survives between requests — so the
  // state machine is cold-started NEUTRAL HISTORY_BARS ago and walked to now.
  // Any excursion past ENTER_BAND inside the window pins it, which makes the
  // result path-independent except in a stretch that never once leaned.
  const oldest = Math.max(MOMENTUM_BARS, live - HISTORY_BARS + 1);
  const history: number[] = [];
  let verdict: BtcVerdict = "NEUTRAL";
  let current: Legs | null = null;

  for (let i = oldest; i <= live; i++) {
    const legs = legsAt(i, series);
    if (!legs) continue;
    history.push(legs.score);
    verdict = nextVerdict(verdict, legs.score);
    current = legs;
  }

  if (!current) return null;

  const dayAgo = history[history.length - 1 - BARS_PER_DAY];

  return {
    price: closes[live],
    referencePrice: current.reference,
    changePercent: current.changePercent,
    score: current.score,
    angle: current.score * MAX_TILT_DEG,
    verdict,
    scoreDelta: Number.isFinite(dayAgo) ? current.score - dayAgo : 0,
    history,
    days: MOMENTUM_DAYS,
    bars: MOMENTUM_BARS,

    trendScore: current.trendScore,
    positionScore: current.positionScore,
    bodyScore: current.bodyScore,
    rangePosition: current.rangePosition,
    greenBars: current.greenBars,
    redBars: current.redBars,
  };
}
