// Per-row market context: small tags from `rowContext` (../_lib/market-regime).
// Highlights only — dimming is applied by the table row, nothing is removed.

import { CONF_HIGH, CONF_LOW, type ContextTone, type RowContext } from "../_lib/market-regime";

// Tailwind only generates classes it finds as literal strings.
const TONE: Record<ContextTone, string> = {
  bull: "bg-emerald-500/15 text-emerald-300",
  bear: "bg-rose-500/15 text-rose-300",
  warn: "bg-amber-500/15 text-amber-300",
  muted: "bg-gray-800 text-gray-400",
};

export default function RowContextTags({ ctx }: { ctx: RowContext }) {
  if (ctx.tags.length === 0) return <span className="text-xs text-gray-600">—</span>;
  return (
    <span className="flex max-w-[15rem] flex-wrap gap-1">
      {ctx.tags.map((t) => (
        <span
          key={t.label}
          title={t.title}
          className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[t.tone]}`}
        >
          {t.label}
        </span>
      ))}
    </span>
  );
}

/** Confidence 0–100 with a bar; hover lists what built it. */
export function ConfidenceCell({ ctx }: { ctx: RowContext }) {
  const c = ctx.confidence;
  const level =
    c >= CONF_HIGH
      ? { word: "High", text: "text-emerald-300", bar: "bg-emerald-400" }
      : c >= CONF_LOW
        ? { word: "Medium", text: "text-amber-300", bar: "bg-amber-400" }
        : { word: "Low", text: "text-rose-300", bar: "bg-rose-500" };
  return (
    <span className="inline-flex w-20 flex-col gap-1" title={ctx.confidenceWhy.join("\n")}>
      <span className="flex items-baseline justify-between gap-2 text-xs">
        <span className={`font-semibold ${level.text}`}>{level.word}</span>
        <span className="font-mono text-gray-200">{c}</span>
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-gray-800">
        <span className={`block h-full rounded-full ${level.bar}`} style={{ width: `${c}%` }} />
      </span>
    </span>
  );
}

/** The row in plain words: verdict, why for, why against, what to do. */
export function VerdictCell({ ctx }: { ctx: RowContext }) {
  const v = ctx.verdict;
  const head =
    v.level === "high" ? "text-emerald-300" : v.level === "medium" ? "text-amber-300" : "text-rose-300";
  return (
    <span className="flex w-64 flex-col gap-0.5 text-[11px] leading-snug">
      <span className={`text-xs font-bold ${head}`}>{v.headline}</span>
      {v.pros.slice(0, 3).map((p) => (
        <span key={p} className="text-gray-300">
          <span className="text-emerald-400">+</span> {p}
        </span>
      ))}
      {v.cons.slice(0, 3).map((c) => (
        <span key={c} className="text-gray-300">
          <span className="text-rose-400">−</span> {c}
        </span>
      ))}
      {v.cons.length > 3 && <span className="text-gray-500">+{v.cons.length - 3} more risks (hover confidence)</span>}
      <span className="text-gray-500">→ {v.action}</span>
    </span>
  );
}
