// Market bias — which side can be traded right now, and how safely?
// Laid out for the trend-pullback scanner: phase → side scores → the scanner's
// own criteria read market-wide → what tends to stop pullback entries out.
//
// A pure server component over `MarketRegime` (../_lib/market-regime). v1 only
// said which way the market pointed; this also says how far it has already
// gone (stretch), how violent it is (volatility vs its own norm, typical
// counter swing), and whether one side is crowded (funding) — the three things
// behind stop-outs in a trend that looked fine.
//
// Each side gets its own 0–100 score, split into the parts that built it, and
// the phase names what the combination means. Context only: the tables dim the
// rows of a side scoring under DIM_SCORE, they never hide them.

import {
  type BiasSide,
  DIM_SCORE,
  EXTENDED_SHARE,
  HISTORY,
  type MarketRegime,
  STRETCH_ATR,
  type SideScore,
  TREND_AGE_CAP,
  VOLATILE_RATIO,
} from "../_lib/market-regime";
import { INTERVAL_LABEL, KST_CROSS_BARS, NEAR_ATR, RSI_NEUTRAL_HI, RSI_NEUTRAL_LO } from "../_lib/watchlist";

// Tailwind only generates classes it finds as literal strings.
const HEADLINE_TONE = {
  bull: "text-emerald-400",
  bear: "text-rose-500",
  mixed: "text-amber-300",
} as const;

const SIDE_STYLE: Record<BiasSide, { text: string; bar: string }> = {
  LONG: { text: "text-emerald-400", bar: "bg-emerald-400" },
  SHORT: { text: "text-rose-500", bar: "bg-rose-500" },
};

// ── Sparkline ──
const SW = 100;
const SH = 18;

function Spark({ values, className }: { values: number[]; className: string }) {
  // values: index 0 = now. Draw oldest → newest, fixed 0–100 domain, 50 marked.
  const ordered = [...values].reverse();
  if (ordered.length < 2) return null;
  const d = ordered
    .map((v, i) => {
      const x = (i / (ordered.length - 1)) * SW;
      const y = SH - (Math.min(100, Math.max(0, v)) / 100) * SH;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${SW} ${SH}`} className="mt-1 h-4 w-full" preserveAspectRatio="none" aria-hidden>
      <line x1={0} y1={SH / 2} x2={SW} y2={SH / 2} className="text-gray-800" stroke="currentColor" strokeDasharray="2 3" />
      <path d={d} className={className} stroke="currentColor" strokeWidth={1.5} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const drift = (now: number, then: number) => {
  const d = now - then;
  return Math.abs(d) < 3 ? "→" : d > 0 ? "↗" : "↘";
};

function Breadth({
  label,
  values,
  detail,
  className,
}: {
  label: string;
  values: number[];
  detail: string;
  className: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="font-semibold text-gray-300">{label}</span>
        <span className="font-mono text-gray-200">
          {values[0].toFixed(0)}% <span className="text-gray-500">{drift(values[0], values[HISTORY])}</span>
        </span>
      </div>
      <Spark values={values} className={className} />
      <p className="text-[10px] text-gray-500">{detail}</p>
    </div>
  );
}

function ScoreBar({ s }: { s: SideScore }) {
  const style = SIDE_STYLE[s.side];
  const breakdown = [
    `direction ${Math.round(s.direction * 100)}% × safety ${Math.round(s.safety * 100)}%`,
    s.parts.map((p) => `${p.label} ${Math.round(p.value * 100)}%`).join(" · "),
    s.btc !== 0 ? `BTC ${s.btc > 0 ? "+" : ""}${s.btc}` : "BTC ±0",
  ].join("\n");
  return (
    <div title={breakdown}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-xs font-bold ${style.text}`}>
          {s.side}
          {s.counterTrend && <span className="ml-1 text-[9px] font-medium text-gray-500">counter-trend</span>}
        </span>
        <span className={`font-mono text-sm font-bold ${s.score < DIM_SCORE ? "text-gray-500" : "text-gray-100"}`}>
          {s.score}
        </span>
      </div>
      <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-gray-800">
        <div className={`h-full rounded-full ${style.bar}`} style={{ width: `${s.score}%` }} />
        <div className="absolute inset-y-0 w-px bg-gray-600" style={{ left: `${DIM_SCORE}%` }} />
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {s.parts.map((p) => (
          <span
            key={p.key}
            className={`rounded px-1 text-[9px] font-medium ${
              p.value >= 0.66
                ? "bg-emerald-500/10 text-emerald-300"
                : p.value <= 0.33
                  ? "bg-rose-500/10 text-rose-300"
                  : "bg-gray-800 text-gray-400"
            }`}
          >
            {p.value >= 0.66 ? "✓" : p.value <= 0.33 ? "✗" : "~"} {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Fact({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[10px]">
      <span className="text-gray-500">{label}</span>
      <span className={`font-mono ${warn ? "text-amber-300" : "text-gray-300"}`}>{value}</span>
    </div>
  );
}

export default function MarketBias({ market: m }: { market: MarketRegime }) {
  const btcNote =
    m.btcLean == null || m.favoured == null
      ? null
      : m.btcLean === "MIXED"
        ? { text: "BTC flat — no extra confirmation", style: "text-gray-400" }
        : (m.btcLean === "BULL") === (m.favoured === "LONG")
          ? { text: "BTC agrees — higher confidence", style: "text-emerald-400" }
          : { text: "BTC disagrees — size down", style: "text-amber-400" };

  const favour =
    m.favoured == null
      ? "No side clearly favoured"
      : `Favour ${m.favoured === "LONG" ? "LONGS" : "SHORTS"}`;

  const bear = m.trend[0] < 50;
  const stretchWith = bear ? m.stretchedDown : m.stretchedUp;

  return (
    <div className="w-full max-w-[16rem] space-y-3 rounded-2xl border border-gray-800 bg-gray-900 px-4 py-3 shadow-lg">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-bold tracking-wide text-gray-200">Market bias</span>
        <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
          {m.total} pairs · {INTERVAL_LABEL}
        </span>
      </div>

      <div>
        <div className={`text-lg font-bold leading-tight ${HEADLINE_TONE[m.phase.tone]}`}>{m.phase.label}</div>
        <p className="mt-0.5 text-[11px] font-semibold text-gray-200">{favour}</p>
        <p className="mt-1 text-[11px] text-gray-300">{m.phase.read}</p>
        <p className="mt-0.5 text-[11px] text-gray-400">{m.phase.action}</p>
        {m.volatile && (
          <p className="mt-1 text-[11px] font-medium text-amber-400">
            Volatile: ATR {m.volExpansion.toFixed(1)}× its 7-day norm — counter swings are bigger than usual, size
            down.
          </p>
        )}
        {m.divergence && <p className="mt-1 text-[11px] font-medium text-amber-400">{m.divergence}</p>}
        {btcNote && <p className={`mt-1 text-[11px] font-medium ${btcNote.style}`}>{btcNote.text}</p>}
      </div>

      <div className="space-y-2.5 border-t border-gray-800 pt-2">
        <ScoreBar s={m.scores.SHORT} />
        <ScoreBar s={m.scores.LONG} />
        <p className="text-[9px] text-gray-600">Rows of a side under {DIM_SCORE} are dimmed. Hover a score for its parts.</p>
      </div>

      {/* The scanner's four criteria, read across the whole universe, in the
          table's column order: KST cross · EMA trend · RSI neutral · near EMA. */}
      <div className="space-y-2 border-t border-gray-800 pt-2">
        <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">Pullback conditions</p>
        <Breadth
          label="Momentum · KST > signal"
          values={m.momentum}
          className="text-gray-400"
          detail={`fresh crosses (≤${KST_CROSS_BARS}c) ${m.kstUp}↑ ${m.kstDown}↓`}
        />
        <Breadth
          label="Trend · EMA 50 > 200"
          values={m.trend}
          className="text-gray-400"
          detail={`last ${HISTORY} candles${m.trendAge != null ? ` · median trend age ${m.trendAge >= TREND_AGE_CAP ? `${TREND_AGE_CAP}+` : Math.round(m.trendAge)}c` : ""}`}
        />
        <Fact
          label={`RSI neutral ${RSI_NEUTRAL_LO}–${RSI_NEUTRAL_HI}`}
          value={`${m.rsiNeutral.toFixed(0)}%`}
        />
        <Breadth
          label={`In zone · ≤${NEAR_ATR} ATR of EMA 50/200`}
          values={m.nearEma}
          className="text-cyan-400"
          detail={`pairs pulled back to an EMA · median ${m.medianDist50 >= 0 ? "+" : ""}${m.medianDist50.toFixed(1)} ATR from EMA 50`}
        />
        <Breadth
          label={`Stretch · ${STRETCH_ATR}+ ATR ${bear ? "under" : "over"} EMA 50`}
          values={stretchWith}
          className={stretchWith[0] >= EXTENDED_SHARE ? "text-amber-400" : "text-gray-400"}
          detail={`too far to pull back into · extended past ${EXTENDED_SHARE}% · other way ${(bear ? m.stretchedUp : m.stretchedDown)[0].toFixed(0)}%`}
        />
      </div>

      <div className="space-y-0.5 border-t border-gray-800 pt-2">
        <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">Stop-out risk</p>
        <Fact
          label="ATR vs 7-day norm"
          value={`${m.volExpansion.toFixed(2)}× ${m.volExpansion >= 1.3 ? "expanding" : m.volExpansion <= 0.8 ? "compressing" : "normal"}`}
          warn={m.volExpansion >= VOLATILE_RATIO}
        />
        {m.counterSwingAtr != null && (
          <Fact
            label={`Typical ${bear ? "bounce" : "dip"} (48c)`}
            value={`${m.counterSwingAtr.toFixed(1)} ATR`}
            warn={m.counterSwingAtr >= 4}
          />
        )}
        <Fact
          label="RSI ≤30 / ≥70"
          value={`${m.rsiOversold.toFixed(0)}% / ${m.rsiOverbought.toFixed(0)}%`}
          warn={m.rsiOversold >= 30 || m.rsiOverbought >= 30}
        />
        <Fact
          label="Funding < 0 / hot"
          value={m.funding ? `${m.funding.negativePct.toFixed(0)}% / ${m.funding.hotPct.toFixed(0)}%` : "unavailable"}
          warn={m.funding != null && (m.funding.negativePct >= 60 || m.funding.hotPct >= 30)}
        />
        <Fact
          label="BTC · 7d"
          value={m.btcLean == null ? "unavailable" : m.btcLean === "BULL" ? "↑ bullish" : m.btcLean === "BEAR" ? "↓ bearish" : "↔ flat"}
        />
      </div>
    </div>
  );
}
