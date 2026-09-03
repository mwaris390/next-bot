// The BTCUSDT.P leveler — a stat tile: value, delta, trend trace, and the one
// reading BTC itself cannot give you (alt breadth).
//
// A pure server component. The needle is a static rotation baked into the
// markup, so this ships no client JS and re-renders with the hourly scan like
// everything else on the page.
//
// Read it the way you'd read a spirit level: dead flat is neutral, nose up
// bullish, nose down bearish, and how far it has tipped is how strongly. The
// dotted arcs mark the needle's full travel (±MAX_TILT_DEG), so a small lean
// looks small — which is the point of a level over a number.
//
// Colour is never the only channel: the tilt itself carries the sign, and the
// verdict word and signed percentage repeat it. That matters here because the
// two poles are a green/red pair — emerald #34d399 against rose #f43f5e, which
// separates at ΔE 12.0 under deuteranopia where the softer red-400 managed 6.5.

import {
  HISTORY_BARS,
  MAX_TILT_DEG,
  MOMENTUM_DAYS,
  MOMENTUM_INTERVAL_LABEL,
  type BtcMomentum,
} from "../_lib/btc-momentum";

interface Breadth {
  above: number;
  total: number;
  percent: number;
}

// ── Dial geometry (SVG user units) ──
const W = 200;
const H = 100;
const CX = 100;
const CY = 50;
const NEEDLE = 76; // half-length, and the radius the tip travels on
const ARC = 80; // travel guide, clear of the needle tip
const TICK_IN = 83;
const TICK_OUT = 88;

// One card per page, so a fixed id is safe and keeps the markup stable.
const NEEDLE_GRADIENT = "btc-needle";

const rad = (deg: number) => (deg * Math.PI) / 180;
const atX = (deg: number, r: number) => CX + r * Math.cos(rad(deg));
// Screen y grows downward, so a POSITIVE (bullish) angle has to subtract.
const atY = (deg: number, r: number) => CY - r * Math.sin(rad(deg));

// The two travel arcs. Sweep flag 1 on the right (top → bottom is clockwise
// there), 0 on the mirrored left side.
const arc = (from: number, to: number, sweep: 0 | 1) =>
  `M ${atX(from, ARC)} ${atY(from, ARC)} A ${ARC} ${ARC} 0 0 ${sweep} ${atX(to, ARC)} ${atY(to, ARC)}`;
const RIGHT_ARC = arc(MAX_TILT_DEG, -MAX_TILT_DEG, 1);
const LEFT_ARC = arc(180 - MAX_TILT_DEG, 180 + MAX_TILT_DEG, 0);

// Compass ticks at both ends of the travel, quartered.
const TICK_ANGLES = [-1, -0.5, 0, 0.5, 1].flatMap((f) => {
  const deg = f * MAX_TILT_DEG;
  return [deg, 180 - deg];
});

// ── Trend trace ──
const SPARK_H = 30;
// Half-height of the plot, and the floor under the trace's domain. Zero is
// always the middle line, so the trace can't lie about sign — but a quiet three
// days is rescaled up to `SPARK_FLOOR` rather than autoscaled to fill, which is
// what turns chop into fake drama.
const SPARK_FLOOR = 0.35;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

const sparkDomain = (history: number[]) =>
  Math.max(SPARK_FLOOR, ...history.map(Math.abs));

const sparkY = (value: number, domain: number) =>
  SPARK_H / 2 - (clamp(value, -domain, domain) / domain) * (SPARK_H / 2 - 3);

function sparkPath(history: number[], domain: number): string {
  if (history.length < 2) return "";
  return history
    .map((value, i) => {
      const x = (i / (history.length - 1)) * W;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${sparkY(value, domain).toFixed(1)}`;
    })
    .join(" ");
}

const TONE = {
  BULLISH: "text-emerald-400",
  BEARISH: "text-rose-500",
  NEUTRAL: "text-gray-300",
} as const;

const usd = (price: number) => `$${Math.round(price).toLocaleString("en-US")}`;

/** Label/value pair — every row in the tile is one of these. */
function Row({
  label,
  value,
  muted = false,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-2 ${
        muted
          ? "text-[9px] font-medium uppercase tracking-wider text-gray-600"
          : "text-[11px] text-gray-400"
      }`}
    >
      <span>{label}</span>
      <span className={muted ? "" : "font-mono"}>{value}</span>
    </div>
  );
}

export default function BtcMeter({
  momentum,
  breadth,
}: {
  momentum: BtcMomentum | null;
  breadth: Breadth | null;
}) {
  const angle = momentum?.angle ?? 0;
  const tone = momentum ? TONE[momentum.verdict] : "text-gray-600";
  const days = momentum?.days ?? MOMENTUM_DAYS;

  // Direction of the score itself over the last day — the level says where we
  // are, this says which way it is going.
  const spark = sparkDomain(momentum?.history ?? []);
  const delta = momentum?.scoreDelta ?? 0;
  const drift =
    Math.abs(delta) < 0.08 ? "→ steady" : delta > 0 ? "↗ rising" : "↘ falling";

  // Breadth gets the same poles as the needle, and disagreement between them is
  // the whole reason it is on the card.
  //
  // Both class names are spelled out because Tailwind generates CSS by scanning
  // the source for literal strings — a name built at runtime (`text-rose-500`
  // .replace(…)) compiles to nothing and the bar renders empty.
  const breadthTone =
    breadth == null
      ? { text: "text-gray-600", bar: "bg-gray-700" }
      : breadth.percent >= 55
        ? { text: "text-emerald-400", bar: "bg-emerald-400" }
        : breadth.percent <= 45
          ? { text: "text-rose-500", bar: "bg-rose-500" }
          : { text: "text-gray-400", bar: "bg-gray-400" };

  const breakdown = momentum
    ? [
        `BTC ${days}d momentum ${momentum.score >= 0 ? "+" : ""}${momentum.score.toFixed(2)} (${angle >= 0 ? "+" : ""}${angle.toFixed(0)}°), ${drift.slice(2)} over 24h`,
        `trend ${momentum.trendScore.toFixed(2)} · range position ${momentum.rangePosition.toFixed(0)}% · candles ${momentum.bodyScore.toFixed(2)}`,
        `${momentum.greenBars} up / ${momentum.redBars} down of ${momentum.bars} 1h bars`,
        breadth
          ? `${breadth.above} of ${breadth.total} scanned pairs above their EMA 50`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "BTC momentum unavailable — Binance data was not reachable this scan";

  return (
    <div
      title={breakdown}
      className="w-full max-w-[16rem] space-y-2 rounded-2xl border border-gray-800 bg-gray-900 px-4 py-3 shadow-lg"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-bold tracking-wide text-gray-200">
          BTCUSDT.P
        </span>
        <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
          {days}d · {MOMENTUM_INTERVAL_LABEL}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={breakdown}
      >
        {/* Level line and travel arcs — the neutral reference the tilt is read against */}
        <line
          x1={CX - NEEDLE}
          y1={CY}
          x2={CX + NEEDLE}
          y2={CY}
          className="text-gray-700"
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="3 5"
        />
        {[RIGHT_ARC, LEFT_ARC].map((d) => (
          <path
            key={d}
            d={d}
            className="text-gray-700"
            stroke="currentColor"
            strokeWidth={1.5}
            fill="none"
          />
        ))}
        {TICK_ANGLES.map((deg) => (
          <line
            key={deg}
            x1={atX(deg, TICK_IN)}
            y1={atY(deg, TICK_IN)}
            x2={atX(deg, TICK_OUT)}
            y2={atY(deg, TICK_OUT)}
            className="text-gray-600"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        ))}

        {/* The needle, tapered from the hub. Negated: SVG rotates clockwise,
            bullish tips upward. Its left half is the muted "then" end, its
            right half the live one — the same pair of prices printed below. */}
        <g transform={`rotate(${-angle} ${CX} ${CY})`} className={tone}>
          {/* One needle, not two halves. Split into a grey wedge and a coloured
              one, the "then" half read as a second needle pointing the opposite
              way — on a level it always does. The gradient keeps the same
              meaning (muted at the window's open, live at the tip) while the
              shape stays a single object. Its stops inherit `currentColor` from
              this group, so the live end tracks the verdict. */}
          <defs>
            <linearGradient
              id={NEEDLE_GRADIENT}
              gradientUnits="userSpaceOnUse"
              x1={CX - NEEDLE}
              y1={CY}
              x2={CX + NEEDLE}
              y2={CY}
            >
              <stop offset="0%" stopColor="#374151" />
              <stop offset="42%" stopColor="#4b5563" />
              <stop offset="68%" stopColor="currentColor" stopOpacity={0.5} />
              <stop offset="100%" stopColor="currentColor" />
            </linearGradient>
          </defs>
          <path
            d={`M ${CX} ${CY - 4} L ${CX + NEEDLE} ${CY} L ${CX} ${CY + 4} L ${CX - NEEDLE} ${CY} Z`}
            fill={`url(#${NEEDLE_GRADIENT})`}
          />
          <circle
            cx={CX + NEEDLE}
            cy={CY}
            r={9}
            fill="currentColor"
            opacity={0.14}
          />
          <circle cx={CX + NEEDLE} cy={CY} r={4} fill="currentColor" />
        </g>

        {/* Hub last, so the needle passes behind it */}
        <circle
          cx={CX}
          cy={CY}
          r={4}
          className="text-gray-600"
          fill="#111827"
          stroke="currentColor"
          strokeWidth={1.5}
        />
      </svg>

      {/* The two prices the needle is drawn between: its left end is where the
          window opened, its right end is now. The tilt IS this pair. */}
      <div>
        <div className="flex items-baseline justify-between gap-2 font-mono text-[11px]">
          <span className="text-gray-500">
            {momentum ? usd(momentum.referencePrice) : "—"}
          </span>
          <span className="text-gray-200">
            {momentum ? usd(momentum.price) : "—"}
          </span>
        </div>
        <Row muted label={`${days}d ago`} value="now" />
      </div>

      <div className="border-t border-gray-800 pt-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`text-sm font-bold tracking-wide ${tone}`}>
            {momentum?.verdict ?? "NO DATA"}
          </span>
          <span className="font-mono text-xs">
            {momentum ? (
              // Its own sign, never the verdict's: the legs can outvote a
              // slightly negative week into a BULLISH read, and printing that
              // week's minus in green would be a lie.
              <span
                className={
                  momentum.changePercent >= 0
                    ? "text-emerald-400"
                    : "text-rose-500"
                }
              >
                {momentum.changePercent >= 0 ? "+" : ""}
                {momentum.changePercent.toFixed(2)}%
              </span>
            ) : (
              <span className="text-gray-600">—</span>
            )}
          </span>
        </div>

        {/* Trend trace: the score's own last 72h, de-emphasised, with only the
            live end in the verdict colour. */}
        {momentum && momentum.history.length > 1 && (
          <svg
            viewBox={`0 0 ${W} ${SPARK_H}`}
            className="mt-1 w-full"
            role="img"
            aria-label={`Momentum over the last ${momentum.history.length} hours, ${drift.slice(2)}`}
          >
            <line
              x1={0}
              y1={SPARK_H / 2}
              x2={W}
              y2={SPARK_H / 2}
              className="text-gray-800"
              stroke="currentColor"
              strokeWidth={1}
              strokeDasharray="2 4"
            />
            <path
              d={`${sparkPath(momentum.history, spark)} L ${W} ${SPARK_H / 2} L 0 ${SPARK_H / 2} Z`}
              className={tone}
              fill="currentColor"
              opacity={0.12}
            />
            <path
              d={sparkPath(momentum.history, spark)}
              className="text-gray-400"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <circle
              cx={W}
              cy={sparkY(momentum.score, spark)}
              r={2.5}
              className={tone}
              fill="currentColor"
            />
          </svg>
        )}

        <Row
          muted
          label={`${momentum?.history.length ?? HISTORY_BARS}h trend`}
          value={drift}
        />
      </div>

      {/* Breadth — the half of the regime BTC's own candles cannot report */}
      <div className="border-t border-gray-800 pt-2">
        <Row
          label="Alts above EMA 50"
          value={
            <span className={breadthTone.text}>
              {breadth ? `${breadth.percent.toFixed(0)}%` : "—"}
            </span>
          }
        />
        <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-800">
          <div
            className={`h-full rounded-full ${breadthTone.bar}`}
            style={{
              width: `${breadth ? clamp(breadth.percent, 0, 100) : 0}%`,
            }}
          />
          {/* The 50% mark: breadth only means something against half */}
          <div className="absolute inset-y-0 left-1/2 w-px bg-gray-600" />
        </div>
      </div>
    </div>
  );
}
