// Market bias — which side should the tables be read from right now?
//
// A pure server component. Instead of averaging everything into one number
// (which turns "downtrend, bouncing" into a meaningless MIXED), it reads three
// things separately and then says what the combination means:
//
//   TREND    — share of pairs with EMA 50 above EMA 200 (the larger direction)
//   MOMENTUM — share of pairs with KST above its signal (what is happening now)
//   BTC      — the leveler card's verdict
//
// Trend picks the side; momentum says whether now is a pullback inside it or
// a push with it; BTC agreeing or not is the confidence note. Context only: it
// filters nothing.

import type { BtcMomentum } from "../_lib/btc-momentum";
import { INTERVAL_LABEL } from "../_lib/watchlist";

export interface MarketStats {
  total: number;
  aboveEma50: number;
  emaBullStack: number;
  /** Pairs with KST above its signal on the last closed candle. */
  kstAbove: number;
  /** Fresh KST crosses (last few candles), up and down. */
  kstUp: number;
  kstDown: number;
}

type Lean = "BULL" | "BEAR" | "MIXED";

/** A share past 55% / under 45% counts as a lean; in between is a split. */
const LEAN_BAND = 5;

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 50);
const leanOf = (percent: number): Lean =>
  percent >= 50 + LEAN_BAND ? "BULL" : percent <= 50 - LEAN_BAND ? "BEAR" : "MIXED";

interface Call {
  headline: string;
  tone: "bull" | "bear" | "mixed";
  read: string;
  action: string;
}

function call(trend: Lean, momentum: Lean): Call {
  if (trend === "BULL" && momentum === "BULL")
    return {
      headline: "Favour LONGS",
      tone: "bull",
      read: "Uptrend, and momentum is pushing with it.",
      action: "Take long setups; skip shorts.",
    };
  if (trend === "BEAR" && momentum === "BEAR")
    return {
      headline: "Favour SHORTS",
      tone: "bear",
      read: "Downtrend, and momentum is pushing with it.",
      action: "Take short setups; skip longs.",
    };
  if (trend === "BULL" && momentum === "BEAR")
    return {
      headline: "LONGS on the dip",
      tone: "bull",
      read: "Uptrend, pulling back right now.",
      action: "Wait for long KST crosses near the EMAs; shorts are counter-trend.",
    };
  if (trend === "BEAR" && momentum === "BULL")
    return {
      headline: "SHORTS into the bounce",
      tone: "bear",
      read: "Downtrend, bouncing right now.",
      action: "Fresh long crosses are likely bounces — wait for shorts to turn back down near the EMAs.",
    };
  if (trend === "BULL" || trend === "BEAR")
    return {
      headline: trend === "BULL" ? "Lean LONG" : "Lean SHORT",
      tone: trend === "BULL" ? "bull" : "bear",
      read: `${trend === "BULL" ? "Uptrend" : "Downtrend"}, momentum undecided.`,
      action: `Prefer ${trend === "BULL" ? "long" : "short"} setups, smaller size.`,
    };
  if (momentum !== "MIXED")
    return {
      headline: "No trend",
      tone: "mixed",
      read: `Trend split; short-term momentum ${momentum === "BULL" ? "up" : "down"}.`,
      action: "Choppy — only take full-criteria setups, quick targets.",
    };
  return {
    headline: "No clear side",
    tone: "mixed",
    read: "Trend and momentum are both split.",
    action: "Stand aside or trade only the cleanest setups.",
  };
}

const HEADLINE_TONE = {
  bull: "text-emerald-400",
  bear: "text-rose-500",
  mixed: "text-gray-300",
} as const;

const LEAN_STYLE: Record<Lean, string> = {
  BULL: "bg-emerald-500/15 text-emerald-300",
  BEAR: "bg-rose-500/15 text-rose-300",
  MIXED: "bg-gray-800 text-gray-400",
};
const LEAN_WORD: Record<Lean, string> = { BULL: "↑ Bullish", BEAR: "↓ Bearish", MIXED: "↔ Split" };

const BAR_STYLE: Record<Lean, string> = {
  BULL: "bg-emerald-400",
  BEAR: "bg-rose-500",
  MIXED: "bg-gray-400",
};

function Leg({
  label,
  lean,
  percent,
  detail,
}: {
  label: string;
  lean: Lean;
  percent?: number;
  detail: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-gray-300">{label}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${LEAN_STYLE[lean]}`}>
          {LEAN_WORD[lean]}
        </span>
      </div>
      {percent != null && (
        <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-gray-800">
          <div
            className={`h-full rounded-full ${BAR_STYLE[lean]}`}
            style={{ width: `${percent}%` }}
          />
          <div className="absolute inset-y-0 left-1/2 w-px bg-gray-600" />
        </div>
      )}
      <p className="mt-0.5 text-[10px] text-gray-500">{detail}</p>
    </div>
  );
}

export default function MarketBias({
  stats,
  btc,
}: {
  stats: MarketStats;
  btc: BtcMomentum | null;
}) {
  const trendPct = pct(stats.emaBullStack, stats.total);
  const momentumPct = pct(stats.kstAbove, stats.total);
  const trend = leanOf(trendPct);
  const momentum = leanOf(momentumPct);
  const btcLean: Lean | null = btc
    ? btc.verdict === "BULLISH"
      ? "BULL"
      : btc.verdict === "BEARISH"
        ? "BEAR"
        : "MIXED"
    : null;

  const c = call(trend, momentum);
  const side = c.tone === "bull" ? "BULL" : c.tone === "bear" ? "BEAR" : null;
  const btcNote =
    btcLean == null || side == null
      ? null
      : btcLean === side
        ? { text: "BTC agrees — higher confidence", style: "text-emerald-400" }
        : btcLean === "MIXED"
          ? { text: "BTC is flat — no extra confirmation", style: "text-gray-400" }
          : { text: "BTC disagrees — size down", style: "text-amber-400" };

  return (
    <div className="w-full max-w-[16rem] space-y-3 rounded-2xl border border-gray-800 bg-gray-900 px-4 py-3 shadow-lg">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-bold tracking-wide text-gray-200">Market bias</span>
        <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
          {stats.total} pairs · {INTERVAL_LABEL}
        </span>
      </div>

      <div>
        <div className={`text-lg font-bold leading-tight ${HEADLINE_TONE[c.tone]}`}>
          {c.headline}
        </div>
        <p className="mt-1 text-[11px] text-gray-300">{c.read}</p>
        <p className="mt-0.5 text-[11px] text-gray-400">{c.action}</p>
        {btcNote && (
          <p className={`mt-1 text-[11px] font-medium ${btcNote.style}`}>{btcNote.text}</p>
        )}
      </div>

      <div className="space-y-2.5 border-t border-gray-800 pt-2">
        <Leg
          label="Trend · EMA 50/200"
          lean={trend}
          percent={trendPct}
          detail={`${trendPct.toFixed(0)}% of pairs have EMA 50 above EMA 200`}
        />
        <Leg
          label="Momentum · KST"
          lean={momentum}
          percent={momentumPct}
          detail={`${momentumPct.toFixed(0)}% have KST above signal · fresh crosses ${stats.kstUp}↑ ${stats.kstDown}↓`}
        />
        <Leg
          label="BTC · 7d"
          lean={btcLean ?? "MIXED"}
          detail={
            btc
              ? `${btc.changePercent >= 0 ? "+" : ""}${btc.changePercent.toFixed(2)}% over 7 days`
              : "unavailable this scan"
          }
        />
      </div>
    </div>
  );
}
