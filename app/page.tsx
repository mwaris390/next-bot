import { unstable_rethrow } from "next/navigation";
import AutoRefresh from "./_components/auto-refresh";
import BtcMeter from "./_components/btc-meter";
import MarketBias, { type MarketStats } from "./_components/market-bias";
import {
  CANDLE_CACHE_GRACE_MS,
  RateLimitedError,
  getFilteredPairs,
  getKlines,
  isNearWeightCap,
  isPastWeightSoftCap,
  isThrottled,
  klinesNeedNetwork,
  sleep,
  weightCooldownMs,
} from "./_lib/binance";
import { type BtcMomentum, getBtcMomentum } from "./_lib/btc-momentum";
import {
  ATR_LENGTH,
  CANDLE_MS,
  CRITERIA,
  type Criterion,
  EMA_FAST,
  EMA_SLOW,
  INTERVAL,
  INTERVAL_LABEL,
  EMA_CROSS_BARS,
  KST_CROSS_BARS,
  KST_ROC,
  KST_SIGNAL,
  KST_SMA,
  NEAR_ATR,
  RSI_LENGTH,
  RSI_NEUTRAL_HI,
  RSI_NEUTRAL_LO,
  type Reading,
  type Side,
  TRIGGER_CANDLE_MS,
  TRIGGER_EMAS,
  TRIGGER_INTERVAL,
  TRIGGER_INTERVAL_LABEL,
  type HourlyContext,
  type Trigger,
  evaluate,
  evaluateTrigger,
  hourlyContext,
} from "./_lib/watchlist";
import {
  CEB_ACCEPT,
  CEB_RECENT_BARS,
  COMP_MIN_BARS,
} from "./_lib/hourly-context";
import {
  type Tradability,
  VOL_GOOD_LO,
  VOL_WILD,
  formatVolume,
  median,
  tradability,
} from "./_lib/tradability";

// Binance buckets klines request-weight by `limit` ([100,500) costs 2,
// [500,1000) costs 5). The 1h series needs the top of the 5 bucket: CEB-X's
// regime test reads VR(16, 512) on the bar before a break, plus a replay
// window — ~570 closed bars at least. 999 is the most that bucket buys.
const KLINE_LIMIT = 999;
// The 15m gate only needs EMA 21 and KST (≈45 bars of warm-up) to settle.
const TRIGGER_KLINE_LIMIT = 199;

// One clock: everything reads the last CLOSED candle (see ./_lib/watchlist),
// so nothing changes until the next close. Klines are held until then and the
// page re-scans once per candle.
function ttlUntilClose(periodMs: number): number {
  return periodMs - (Date.now() % periodMs) + CANDLE_CACHE_GRACE_MS;
}
const candleTtlMs = () => ttlUntilClose(CANDLE_MS);
const triggerTtlMs = () => ttlUntilClose(TRIGGER_CANDLE_MS);
// The BTC card keeps its own 1h clock (see ./_lib/btc-momentum).
const BTC_CANDLE_MS = 60 * 60_000;

const MAX_CONCURRENT = 20;
const BATCH_DELAY_MS = 120;

const DISPLAY_LIMIT = 50;

// ─────────────── Trend filter: liquid AND moving ───────────────
// Quiet coins tick the boxes too — RSI sits at 50 and price hugs the EMAs
// precisely because nothing is happening. These cut them before either table.
/** 24h quote volume floor, on closed candles. */
const SCAN_MIN_VOLUME = 20_000_000;
/** ATR% must be at least this multiple of the scan median… */
const MIN_VOL_RATIO = VOL_GOOD_LO;
/** …and at most this (past it the bars are noise, not trend). */
const MAX_VOL_RATIO = VOL_WILD;

// ==================== Scan ====================

type Row = Reading & {
  symbol: string;
  met: number;
  tradability: Tradability;
  trigger: Trigger;
  /**
   * Partial rows only: which 1h reads (EMA 50/200, KST) point against the
   * 15m-aligned side. Null when 1h is with the 15m.
   */
  tfConflict: { ema: boolean; kst: boolean } | null;
} & HourlyContext;

interface ScanResult {
  full: Row[];
  partial: Row[];
  fullTotal: number;
  partialTotal: number;
  filteredOut: number;
  /** 1h candidates dropped because the 15m chart disagreed. */
  gatedOut: number;
  market: MarketStats;
  medianAtrPercent: number;
  scanned: number;
  rateLimited: boolean;
  scannedAt: number;
}

/**
 * Fetches klines for every symbol in rate-limited batches and maps each series
 * through `read`. Shared by the 1h pass (whole universe) and the 15m gate.
 */
async function fetchEach<T>(
  symbols: string[],
  interval: string,
  limit: number,
  ttlMs: () => number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  read: (klines: any[]) => T | null,
): Promise<{ results: Map<string, T>; rateLimited: boolean }> {
  const results = new Map<string, T>();
  let rateLimited = false;

  for (let i = 0; i < symbols.length; i += MAX_CONCURRENT) {
    const chunk = symbols.slice(i, i + MAX_CONCURRENT);

    const willHitNetwork = chunk.some((symbol) =>
      klinesNeedNetwork(symbol, interval, limit),
    );

    if (willHitNetwork && isThrottled()) {
      rateLimited = true;
    } else if (willHitNetwork && isNearWeightCap()) {
      rateLimited = true;
      break;
    } else if (willHitNetwork && isPastWeightSoftCap()) {
      await sleep(weightCooldownMs);
    }

    await Promise.all(
      chunk.map(async (symbol) => {
        try {
          const klines = await getKlines(symbol, interval, limit, ttlMs());
          const value = read(klines);
          if (value) results.set(symbol, value);
        } catch (error) {
          if (error instanceof RateLimitedError) rateLimited = true;
          else console.log("scan error", symbol, interval, error);
        }
      }),
    );

    if (willHitNetwork && i + MAX_CONCURRENT < symbols.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return { results, rateLimited };
}

/** Badges left blank when the 1h series couldn't be re-read. */
const NO_CONTEXT: HourlyContext = {
  compression: { compressed: false, bars: 0, loaded: false, adx: NaN, bbwRank: NaN },
  ceb: { signal: null, fakeout: null },
};

async function scan(): Promise<ScanResult> {
  const pairs = await getFilteredPairs();
  const hourly = await fetchEach(
    pairs.map((p) => p.symbol),
    INTERVAL,
    KLINE_LIMIT,
    candleTtlMs,
    evaluate,
  );
  let rateLimited = hourly.rateLimited;
  const readings = [...hourly.results].map(([symbol, reading]) => ({
    symbol,
    reading,
  }));

  // Market read: the whole universe, before any filter.
  const market: MarketStats = {
    total: readings.length,
    aboveEma50: 0,
    emaBullStack: 0,
    kstAbove: 0,
    kstUp: 0,
    kstDown: 0,
  };
  for (const { reading: r } of readings) {
    if (r.kstAbove) market.kstAbove += 1;
    if (r.closedPrice > r.ema50) market.aboveEma50 += 1;
    if (r.ema50 > r.ema200) market.emaBullStack += 1;
    if (r.kstBarsAgo != null && r.kstBarsAgo < KST_CROSS_BARS) {
      if (r.kstCrossSide === "LONG") market.kstUp += 1;
      else if (r.kstCrossSide === "SHORT") market.kstDown += 1;
    }
  }

  // Volatility is judged against the whole scan's median.
  const medianAtrPercent = median(readings.map(({ reading }) => reading.atrPercent));

  type Base = Omit<Row, "trigger" | "tfConflict" | keyof HourlyContext>;
  const rows: Base[] = [];
  let filteredOut = 0;
  for (const { symbol, reading } of readings) {
    const t = tradability(reading.atrPercent, reading.volume24h, medianAtrPercent);
    if (
      reading.volume24h < SCAN_MIN_VOLUME ||
      t.volatilityRatio < MIN_VOL_RATIO ||
      t.volatilityRatio > MAX_VOL_RATIO
    ) {
      filteredOut += 1;
      continue;
    }
    const met = CRITERIA.filter((c) => reading.criteria[c]).length;
    rows.push({ ...reading, symbol, met, tradability: t });
  }

  // 1h candidates for either table, before the 15m gate.
  const isFull = (r: Base) => r.met === CRITERIA.length;
  // Partial = KST and the EMAs disagree on 1h, one way or the other.
  const isPartial = (r: Base) =>
    r.met < CRITERIA.length && (r.conflict.kstVsEma || r.conflict.emaVsKst);

  // 15m read for every pair that passed the filter: it gates the 1h rows
  // and also brings in the 15m-aligned / 1h-not-aligned Partial rows.
  const triggers = await fetchEach(
    rows.map((r) => r.symbol),
    TRIGGER_INTERVAL,
    TRIGGER_KLINE_LIMIT,
    triggerTtlMs,
    evaluateTrigger,
  );
  if (triggers.rateLimited) rateLimited = true;

  type Gated = Omit<Row, keyof HourlyContext>;
  const full: Gated[] = [];
  const partial: Gated[] = [];
  let gatedOut = 0;
  for (const r of rows) {
    const trigger = triggers.results.get(r.symbol);
    const was1hCandidate = isFull(r) || isPartial(r);
    if (!trigger) {
      if (was1hCandidate) gatedOut += 1;
      continue;
    }

    // Is 1h with the 15m side? EMA 50/200 and KST, each on its own.
    const tfConflict = trigger.side
      ? {
          ema: r.ema50 >= r.ema200 !== (trigger.side === "LONG"),
          kst: r.kstAbove !== (trigger.side === "LONG"),
        }
      : null;
    const tfDisagrees = tfConflict != null && (tfConflict.ema || tfConflict.kst);

    if (trigger.side === r.side && isFull(r)) {
      full.push({ ...r, trigger, tfConflict: null });
    } else if (trigger.side === r.side && isPartial(r)) {
      partial.push({ ...r, trigger, tfConflict: tfDisagrees ? tfConflict : null });
    } else if (tfDisagrees && trigger.side) {
      // 15m aligned, 1h not (fully) with it: the row takes the 15m side, and
      // the 1h criteria are re-read against that side.
      const side = trigger.side;
      const criteria = {
        ...r.criteria,
        kst: r.kstAbove === (side === "LONG"),
        ema: r.ema50 >= r.ema200 === (side === "LONG"),
      };
      const met = CRITERIA.filter((c) => criteria[c]).length;
      partial.push({ ...r, side, criteria, met, trigger, tfConflict });
    } else if (was1hCandidate) {
      gatedOut += 1;
    }
  }

  const byTradability = (a: Gated, b: Gated) => b.tradability.score - a.tradability.score;
  full.sort(byTradability);
  // Rows that also meet RSI neutral / near EMA rank first.
  partial.sort((a, b) => b.met - a.met || byTradability(a, b));

  // 1h compression + CEB-X badges, only for the rows that get shown, off the
  // 1h series already in cache.
  const withContext = async (shown: Gated[]): Promise<Row[]> => {
    const out: Row[] = [];
    for (const r of shown) {
      let context: HourlyContext = NO_CONTEXT;
      try {
        context = hourlyContext(
          await getKlines(r.symbol, INTERVAL, KLINE_LIMIT, candleTtlMs()),
        );
      } catch (error) {
        if (error instanceof RateLimitedError) rateLimited = true;
      }
      out.push({ ...r, ...context });
    }
    return out;
  };
  const [fullShown, partialShown] = await Promise.all([
    withContext(full.slice(0, DISPLAY_LIMIT)),
    withContext(partial.slice(0, DISPLAY_LIMIT)),
  ]);

  return {
    full: fullShown,
    partial: partialShown,
    fullTotal: full.length,
    partialTotal: partial.length,
    filteredOut,
    gatedOut,
    market,
    medianAtrPercent,
    scanned: pairs.length,
    rateLimited,
    scannedAt: Date.now(),
  };
}

// ==================== Presentation helpers ====================

const TH = ({ children }: { children: React.ReactNode }) => (
  <th className="text-left py-4 whitespace-nowrap">{children}</th>
);

function SidePill({ side }: { side: Side }) {
  return (
    <span
      className={`px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap ${
        side === "LONG"
          ? "bg-green-500/20 text-green-400"
          : "bg-red-500/20 text-red-400"
      }`}
    >
      {side === "LONG" ? "LONG ↑" : "SHORT ↓"}
    </span>
  );
}

// ─────────────── Badges ───────────────
// Every class name is spelled out in full: Tailwind only generates CSS for
// literal strings it finds in the source.
const TONE = {
  bull: "bg-emerald-500/15 text-emerald-300",
  bear: "bg-rose-500/15 text-rose-300",
  warn: "bg-amber-500/15 text-amber-300",
  calm: "bg-cyan-500/15 text-cyan-300",
  muted: "bg-gray-800 text-gray-400",
} as const;
type Tone = keyof typeof TONE;

function Badge({
  tone,
  met = false,
  children,
}: {
  tone: Tone;
  /** Outlined when this badge is the reason a criterion passed. */
  met?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`w-fit whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[tone]} ${
        met ? "ring-1 ring-current" : ""
      }`}
    >
      {children}
    </span>
  );
}

/** A badge, plus a line of plain detail under it. */
function Cell({
  title,
  children,
  detail,
}: {
  title: string;
  children: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    <span className="inline-flex flex-col gap-1" title={title}>
      {children}
      {detail && (
        <span className="whitespace-nowrap text-[11px] text-gray-500">{detail}</span>
      )}
    </span>
  );
}

function Change({ value }: { value: number }) {
  return (
    <span
      className={`font-medium ${value >= 0 ? "text-green-400" : "text-red-400"}`}
    >
      {value >= 0 ? "+" : ""}
      {value.toFixed(2)}%
    </span>
  );
}

const candlesAgo = (barsAgo: number) =>
  barsAgo === 0 ? "on the last candle" : `${barsAgo + 1} candles ago`;

const sideTone = (bullish: boolean): Tone => (bullish ? "bull" : "bear");

function KstCell({ r }: { r: Row }) {
  const recent = r.kstBarsAgo != null && r.kstBarsAgo < KST_CROSS_BARS && r.kstCrossSide;
  if (recent) {
    const up = r.kstCrossSide === "LONG";
    return (
      <Cell
        title={`KST crossed ${up ? "above" : "below"} its signal ${candlesAgo(r.kstBarsAgo!)} (counts within ${KST_CROSS_BARS})`}
        detail={`crossed ${candlesAgo(r.kstBarsAgo!)}`}
      >
        <Badge tone={sideTone(up)} met={r.criteria.kst}>
          {up ? "↑ Bullish cross" : "↓ Bearish cross"}
        </Badge>
      </Cell>
    );
  }
  return (
    <Cell
      title={`No KST cross in the last ${KST_CROSS_BARS} candles — counts when KST sits on the trade's side of its signal`}
      detail={
        r.kstBarsAgo == null ? "no cross on record" : `last cross ${r.kstBarsAgo + 1} candles ago`
      }
    >
      <Badge tone={r.criteria.kst ? sideTone(r.kstAbove) : "muted"} met={r.criteria.kst}>
        {r.kstAbove ? "KST above signal" : "KST below signal"}
      </Badge>
    </Cell>
  );
}

function EmaCell({ r }: { r: Row }) {
  const bull = r.ema50 >= r.ema200;
  const freshCross =
    r.emaCrossBarsAgo != null && r.emaCrossBarsAgo < EMA_CROSS_BARS && r.emaCrossSide;
  return (
    <Cell
      title={`EMA ${EMA_FAST} ${r.ema50.toPrecision(6)} vs EMA ${EMA_SLOW} ${r.ema200.toPrecision(6)}`}
      detail={`EMA ${EMA_FAST} ${bull ? ">" : "<"} EMA ${EMA_SLOW}`}
    >
      <Badge tone={sideTone(bull)} met={r.criteria.ema}>
        {bull ? "↑ Bullish stack" : "↓ Bearish stack"}
      </Badge>
      {freshCross && (
        <Badge tone="warn">
          {r.emaCrossSide === "LONG" ? "Golden cross" : "Death cross"} ·{" "}
          {r.emaCrossBarsAgo === 0 ? "last candle" : `${r.emaCrossBarsAgo! + 1}c ago`}
        </Badge>
      )}
    </Cell>
  );
}

function rsiLabel(rsi: number): { label: string; tone: Tone } {
  if (rsi >= 70) return { label: "Overbought", tone: "warn" };
  if (rsi > RSI_NEUTRAL_HI) return { label: "Strong", tone: "muted" };
  if (rsi >= RSI_NEUTRAL_LO) return { label: "Neutral", tone: "calm" };
  if (rsi > 30) return { label: "Weak", tone: "muted" };
  return { label: "Oversold", tone: "warn" };
}

function RsiCell({ r }: { r: Row }) {
  const { label, tone } = rsiLabel(r.rsi);
  return (
    <Cell
      title={`RSI(${RSI_LENGTH}) — neutral is ${RSI_NEUTRAL_LO}–${RSI_NEUTRAL_HI}`}
      detail={`RSI ${r.rsi.toFixed(1)}`}
    >
      <Badge tone={tone} met={r.criteria.rsi}>
        {label}
      </Badge>
    </Cell>
  );
}

function NearCell({ r }: { r: Row }) {
  const t = r.touches[0];
  const above = t.distanceAtr >= 0;
  return (
    <Cell
      title={`Near = close within ${NEAR_ATR} ATR(${ATR_LENGTH}) of EMA ${EMA_FAST} or ${EMA_SLOW}`}
      detail={`${Math.abs(t.distanceAtr).toFixed(2)} ATR ${above ? "above" : "below"}`}
    >
      <Badge tone={r.criteria.near ? "calm" : "muted"} met={r.criteria.near}>
        {r.criteria.near ? `On EMA ${t.length}` : `Away from EMA ${t.length}`}
      </Badge>
    </Cell>
  );
}

const CRITERION_CELL: Record<Criterion, (props: { r: Row }) => React.ReactNode> = {
  kst: KstCell,
  ema: EmaCell,
  rsi: RsiCell,
  near: NearCell,
};

/** The 15m gate: EMA 8/12/21 ribbon and KST, both with the row's side. */
function TriggerCell({ r }: { r: Row }) {
  const long = r.trigger.side === "LONG";
  const [a, b, c] = TRIGGER_EMAS;
  return (
    <Cell
      title={`${TRIGGER_INTERVAL_LABEL}: EMA ${a} ${r.trigger.emas[0].toPrecision(6)} / ${b} ${r.trigger.emas[1].toPrecision(6)} / ${c} ${r.trigger.emas[2].toPrecision(6)}`}
      detail={`EMA ${a}${long ? ">" : "<"}${b}${long ? ">" : "<"}${c} · KST ${long ? "above" : "below"}`}
    >
      <Badge tone={sideTone(long)} met>
        {long ? "↑ 15M aligned" : "↓ 15M aligned"}
      </Badge>
    </Cell>
  );
}

const ago = (barsAgo: number) => (barsAgo === 0 ? "last 1H candle" : `${barsAgo + 1}h ago`);

/** 1H compression and CEB-X — context only, never a gate. */
function ContextCell({ r }: { r: Row }) {
  const { compression: comp, ceb } = r;
  const signal =
    ceb.signal && ceb.signal.barsAgo < CEB_RECENT_BARS ? ceb.signal : null;
  const fake =
    ceb.fakeout && ceb.fakeout.barsAgo < CEB_RECENT_BARS ? ceb.fakeout : null;
  if (!comp.compressed && !signal && !fake) {
    return <span className="text-xs text-gray-600">—</span>;
  }
  return (
    <span className="inline-flex flex-col gap-1.5">
      {comp.compressed && (
        <Cell
          title={`1H compression: ADX ${comp.adx.toFixed(1)}, BB width rank ${comp.bbwRank.toFixed(0)}%, RSI in band • loaded after ${COMP_MIN_BARS} bars`}
          detail={`${comp.bars} bar${comp.bars === 1 ? "" : "s"} compressed`}
        >
          <Badge tone="warn">{comp.loaded ? "Loaded coil" : "Compressing"}</Badge>
        </Cell>
      )}
      {signal && (
        <Cell
          title={`1H CEB-X ${signal.side === 1 ? "LONG" : "SHORT"} breakout, accepted after ${CEB_ACCEPT} closes • regime: ${signal.why} • box ${signal.boxBot.toPrecision(6)} – ${signal.boxTop.toPrecision(6)}`}
          detail={ago(signal.barsAgo)}
        >
          <Badge tone={sideTone(signal.side === 1)}>
            CEB-X {signal.side === 1 ? "LONG ↑" : "SHORT ↓"}
          </Badge>
        </Cell>
      )}
      {fake && (
        <Cell
          title="1H CEB-X fakeout: closed back inside the box before acceptance"
          detail={ago(fake.barsAgo)}
        >
          <Badge tone="muted">CEB-X × {fake.side === 1 ? "up" : "down"} fakeout</Badge>
        </Cell>
      )}
    </span>
  );
}

/** What disagrees with what, in words. */
function ConflictCell({ r }: { r: Row }) {
  const word = (bull: boolean) => (bull ? "bullish" : "bearish");
  return (
    <span className="inline-flex flex-col gap-1.5">
      {r.tfConflict && (
        <Cell
          title={`${TRIGGER_INTERVAL_LABEL} EMA ${TRIGGER_EMAS.join("/")} and KST aligned ${r.side === "LONG" ? "long" : "short"}, but ${INTERVAL_LABEL} isn't with it`}
          detail={[
            r.tfConflict.ema && `${INTERVAL_LABEL} EMA ${EMA_FAST}/${EMA_SLOW} ${word(r.ema50 >= r.ema200)}`,
            r.tfConflict.kst && `${INTERVAL_LABEL} KST ${word(r.kstAbove)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <Badge tone="warn">
            {TRIGGER_INTERVAL_LABEL} {word(r.side === "LONG")} vs {INTERVAL_LABEL}
          </Badge>
        </Cell>
      )}
      {r.conflict.kstVsEma && r.kstCrossSide && r.kstBarsAgo != null && (
        <Cell
          title="Fresh KST cross against the EMA 50/200 stack"
          detail={`KST crossed ${candlesAgo(r.kstBarsAgo)}`}
        >
          <Badge tone="warn">
            KST {word(r.kstCrossSide === "LONG")} vs EMA {word(r.ema50 >= r.ema200)}
          </Badge>
        </Cell>
      )}
      {r.conflict.emaVsKst && r.emaCrossSide && r.emaCrossBarsAgo != null && (
        <Cell
          title="Fresh EMA 50/200 cross with KST on the other side of its signal"
          detail={`EMAs crossed ${candlesAgo(r.emaCrossBarsAgo)}`}
        >
          <Badge tone="warn">
            {r.emaCrossSide === "LONG" ? "Golden cross" : "Death cross"} vs KST{" "}
            {word(r.kstAbove)}
          </Badge>
        </Cell>
      )}
    </span>
  );
}

const HEADER: Record<Criterion, string> = {
  kst: "KST (1H)",
  ema: "EMA trend",
  rsi: "RSI",
  near: "Price vs EMA",
};

function SetupTable({
  title,
  badgeClass,
  rows,
  total,
  subtitle,
  empty,
  showScore,
}: {
  title: string;
  badgeClass: string;
  rows: Row[];
  total: number;
  subtitle: string;
  empty: string;
  showScore: boolean;
}) {
  const longs = rows.filter((r) => r.side === "LONG").length;
  const columns = 11 + (showScore ? 1 : 0);
  return (
    <div className="bg-gray-900 rounded-3xl shadow-2xl p-8">
      <div className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h2 className="text-3xl font-semibold text-white">{title}</h2>
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ${badgeClass}`}>
          {total}
        </span>
        <span className="text-sm text-green-400">{longs} long</span>
        <span className="text-sm text-red-400">{rows.length - longs} short</span>
        <p className="text-sm text-gray-500">
          {subtitle}
          {total > rows.length ? ` — ${rows.length} of ${total} shown` : ""}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-gray-400 border-b border-gray-700">
            <tr>
              <TH>#</TH>
              <TH>Pair</TH>
              <TH>Side</TH>
              <TH>{TRIGGER_INTERVAL_LABEL} gate</TH>
              {showScore && <TH>Conflict</TH>}
              {CRITERIA.map((c) => (
                <TH key={c}>{HEADER[c]}</TH>
              ))}
              <TH>1H context</TH>
              <TH>ATR%</TH>
              <TH>24h volume</TH>
              <TH>24h %</TH>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.symbol}
                className="border-b border-gray-800 hover:bg-gray-800/70 transition-colors"
              >
                <td className="py-4">{i + 1}</td>
                <td className="py-4 font-semibold">{r.symbol}</td>
                <td className="py-4">
                  <SidePill side={r.side} />
                </td>
                <td className="py-4">
                  <TriggerCell r={r} />
                </td>
                {showScore && (
                  <td className="py-4">
                    <ConflictCell r={r} />
                  </td>
                )}
                {CRITERIA.map((c) => (
                  <td key={c} className="py-4">
                    {CRITERION_CELL[c]({ r })}
                  </td>
                ))}
                <td className="py-4">
                  <ContextCell r={r} />
                </td>
                <td
                  className="py-4 font-mono text-xs text-gray-300"
                  title={`ATR(${ATR_LENGTH}) is ${r.tradability.volatilityRatio.toFixed(2)}× the scan median`}
                >
                  {r.atrPercent.toFixed(2)}%
                </td>
                <td className="py-4 font-mono text-xs text-gray-300">
                  {formatVolume(r.volume24h)}
                </td>
                <td className="py-4">
                  <Change value={r.change24h} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns} className="py-12 text-center text-gray-500">
                  {empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ==================== Page ====================

export default async function TrendPullbackScanner() {
  let result: ScanResult;
  let btc: BtcMomentum | null = null;

  try {
    [result, btc] = await Promise.all([
      scan(),
      getBtcMomentum(ttlUntilClose(BTC_CANDLE_MS)),
    ]);
  } catch (error) {
    // Next signals "this route must render dynamically" by throwing — that's
    // control flow, not a scanner failure, so it has to pass straight through.
    unstable_rethrow(error);
    console.log("scanner error", error);
    return (
      <div className="min-h-screen bg-gray-950 text-red-400 flex items-center justify-center p-10">
        <div className="text-center">
          <h2 className="text-2xl mb-4">Failed to load scanner</h2>
          <p>Please refresh the page.</p>
        </div>
      </div>
    );
  }

  const { market } = result;
  const breadth =
    market.total > 0
      ? {
          bull: market.aboveEma50,
          total: market.total,
          percent: (market.aboveEma50 / market.total) * 100,
        }
      : null;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-7xl mx-auto space-y-10">
        <div className="grid items-start gap-6 lg:grid-cols-[16rem_1fr_16rem]">
          <div className="flex justify-center lg:justify-start">
            <MarketBias stats={market} btc={btc} />
          </div>

          <div className="text-center">
            <h1 className="text-5xl font-bold tracking-tight mb-3">
              Binance Futures {INTERVAL_LABEL} Trend Pullback Scanner
            </h1>
            <p className="text-gray-400">
              {TRIGGER_INTERVAL_LABEL} EMA {TRIGGER_EMAS.join("/")} + KST
              aligned • {INTERVAL_LABEL} KST aligned or just crossed • EMA{" "}
              {EMA_FAST}/{EMA_SLOW} aligned • RSI neutral • price near an EMA •
              liquid and moving coins only
            </p>
            <p className="mt-2 text-sm text-gray-500">
              Every reading is on the last closed candle • re-scanned at each{" "}
              {TRIGGER_INTERVAL_LABEL} close
            </p>
            <AutoRefresh
              candleMs={TRIGGER_CANDLE_MS}
              graceMs={CANDLE_CACHE_GRACE_MS}
              scannedAt={result.scannedAt}
            />
            {result.rateLimited && (
              <p className="mt-4 inline-block rounded-full bg-amber-500/15 px-4 py-2 text-sm text-amber-400">
                ⚠️ Binance rate limit reached — some pairs were served from
                cache or skipped. Refresh in a minute for a full scan.
              </p>
            )}
          </div>

          <div className="flex justify-center lg:justify-end">
            <BtcMeter momentum={btc} breadth={breadth} />
          </div>
        </div>

        <SetupTable
          title="🎯 All criteria"
          badgeClass="bg-emerald-500/20 text-emerald-300"
          rows={result.full}
          total={result.fullTotal}
          subtitle={`${TRIGGER_INTERVAL_LABEL} aligned + ${INTERVAL_LABEL} KST + EMA trend + RSI neutral + near EMA • most tradable first`}
          empty="No coin meets all four criteria on this close"
          showScore={false}
        />

        <SetupTable
          title="👀 Partial — KST vs EMA, 15M vs 1H"
          badgeClass="bg-amber-500/20 text-amber-300"
          rows={result.partial}
          total={result.partialTotal}
          subtitle={`1H: fresh KST cross against the EMA stack, or EMA ${EMA_FAST}/${EMA_SLOW} cross in the last ${EMA_CROSS_BARS} candles with KST the other way (side = the fresh signal, ${TRIGGER_INTERVAL_LABEL} agreeing) • or ${TRIGGER_INTERVAL_LABEL} EMA ${TRIGGER_EMAS.join("/")} + KST aligned while ${INTERVAL_LABEL} EMA ${EMA_FAST}/${EMA_SLOW} or KST is not (side = ${TRIGGER_INTERVAL_LABEL})`}
          empty="No KST / EMA or 15M / 1H disagreements on this close"
          showScore
        />

        <p className="text-center text-xs text-gray-500">
          {TRIGGER_INTERVAL_LABEL} gate: EMA {TRIGGER_EMAS.join(" > ")} and KST
          above its signal (long), mirrored for short, on the row&apos;s side —{" "}
          {result.gatedOut} {INTERVAL_LABEL} candidates dropped this close •{" "}
          {INTERVAL_LABEL} KST({KST_ROC.join(" ")} / {KST_SMA.join(" ")} /{" "}
          {KST_SIGNAL}) on the trade&apos;s side of its signal, badge shows a
          cross within {KST_CROSS_BARS} candles • 1H context: compression (ADX
          &lt; 20, BB width in bottom 20%, RSI 40–60; loaded after{" "}
          {COMP_MIN_BARS} bars) and CEB-X breakouts / fakeouts from the last{" "}
          {CEB_RECENT_BARS} closed hours • EMA {EMA_FAST} above (long) / below
          (short) EMA {EMA_SLOW} • RSI({RSI_LENGTH}) {RSI_NEUTRAL_LO}–
          {RSI_NEUTRAL_HI} • close within {NEAR_ATR} ATR({ATR_LENGTH}) of EMA{" "}
          {EMA_FAST} or {EMA_SLOW} • Side = recent KST cross, else EMA stack •
          Filter: 24h volume ≥ ${(SCAN_MIN_VOLUME / 1_000_000).toFixed(0)}M and
          ATR% {MIN_VOL_RATIO}×–{MAX_VOL_RATIO}× the scan median (
          {result.medianAtrPercent.toFixed(2)}%) — {result.filteredOut} of{" "}
          {market.total} pairs cut as too thin, too quiet or too wild • Scanned{" "}
          {result.scanned} perpetuals • No SL/TP shown by design — read the
          levels off the chart
        </p>
      </div>
    </div>
  );
}
