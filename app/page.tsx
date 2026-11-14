import { unstable_rethrow } from "next/navigation";
import AutoRefresh from "./_components/auto-refresh";
import BtcMeter from "./_components/btc-meter";
import MarketBias, { type MarketStats } from "./_components/market-bias";
import ScannerTabs from "./_components/scanner-tabs";
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
  ADX_MAX,
  ATR_LENGTH,
  CANDLE_MS,
  EMA_FAST,
  EMA_SLOW,
  EXH_ATR,
  type EmaZoneReading,
  FRESH_BARS,
  INTERVAL,
  INTERVAL_LABEL,
  KST_ROC,
  KST_SIGNAL,
  KST_SMA,
  RANGE_BARS,
  RECLAIM_BARS,
  RSI_LONG_MAX,
  RSI_SHORT_MIN,
  SL_ZONE_ATR,
  SPREAD_MAX,
  SPREAD_MIN,
  type Side,
  type Signal,
  type Strategy,
  TOUCH200_BARS,
  ZONE_BARS,
  evaluateEmaZone,
} from "./_lib/ema-zone";
import {
  type Tradability,
  VOL_GOOD_LO,
  VOL_WILD,
  formatVolume,
  median,
  tradability,
} from "./_lib/tradability";

// 499, not 500, on purpose: Binance buckets klines request-weight by `limit`
// ([100,500) costs 2, [500,1000) costs 5), so one bar less is 2.5x cheaper.
// Enough for EMA 200 / RSI / ADX to settle to TradingView's values.
const KLINE_LIMIT = 499;

// One clock: everything reads the last CLOSED candle, so nothing changes until
// the next close. Klines are held until then and the page re-scans once per
// candle.
function ttlUntilClose(periodMs: number): number {
  return periodMs - (Date.now() % periodMs) + CANDLE_CACHE_GRACE_MS;
}
const candleTtlMs = () => ttlUntilClose(CANDLE_MS);
const BTC_CANDLE_MS = 60 * 60_000;

const MAX_CONCURRENT = 20;
const BATCH_DELAY_MS = 120;
const DISPLAY_LIMIT = 50;

// ─────────────── Pre-filter: liquid AND moving ───────────────
/** 24h quote volume floor, on closed candles. */
const SCAN_MIN_VOLUME = 20_000_000;
/** ATR% between these multiples of the scan median. */
const MIN_VOL_RATIO = VOL_GOOD_LO;
const MAX_VOL_RATIO = VOL_WILD;

// ==================== Scan ====================

type Row = EmaZoneReading & { symbol: string; tradability: Tradability };
type SignalRow = Row & { shown: Signal };

interface ScanResult {
  signals: SignalRow[];
  signalsTotal: number;
  filteredOut: number;
  market: MarketStats;
  medianAtrPercent: number;
  scanned: number;
  rateLimited: boolean;
  scannedAt: number;
}

async function scan(): Promise<ScanResult> {
  const pairs = await getFilteredPairs();
  const readings: { symbol: string; reading: EmaZoneReading }[] = [];
  let rateLimited = false;

  for (let i = 0; i < pairs.length; i += MAX_CONCURRENT) {
    const chunk = pairs.slice(i, i + MAX_CONCURRENT);
    const willHitNetwork = chunk.some((pair) =>
      klinesNeedNetwork(pair.symbol, INTERVAL, KLINE_LIMIT),
    );

    if (willHitNetwork && isThrottled()) {
      rateLimited = true;
    } else if (willHitNetwork && isNearWeightCap()) {
      rateLimited = true;
      break;
    } else if (willHitNetwork && isPastWeightSoftCap()) {
      await sleep(weightCooldownMs);
    }

    const results = await Promise.all(
      chunk.map(async (pair) => {
        try {
          const klines = await getKlines(pair.symbol, INTERVAL, KLINE_LIMIT, candleTtlMs());
          const reading = evaluateEmaZone(klines);
          return reading ? { symbol: pair.symbol, reading } : null;
        } catch (error) {
          if (error instanceof RateLimitedError) rateLimited = true;
          else console.log("scan error", pair.symbol, error);
          return null;
        }
      }),
    );
    for (const result of results) if (result) readings.push(result);

    if (willHitNetwork && i + MAX_CONCURRENT < pairs.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

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
    if (r.closedPrice > r.ema50) market.aboveEma50 += 1;
    if (r.ema50 > r.ema200) market.emaBullStack += 1;
    if (r.kstAbove) market.kstAbove += 1;
    if (r.kstCross === "LONG") market.kstUp += 1;
    else if (r.kstCross === "SHORT") market.kstDown += 1;
  }

  const medianAtrPercent = median(readings.map(({ reading }) => reading.atrPercent));

  const signals: SignalRow[] = [];
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
    const row = { ...reading, symbol, tradability: t };
    if (reading.signal) signals.push({ ...row, shown: reading.signal });
  }

  // Freshest first, then most tradable.
  const order = (a: SignalRow, b: SignalRow) =>
    a.shown.barsAgo - b.shown.barsAgo || b.tradability.score - a.tradability.score;
  signals.sort(order);

  return {
    signals: signals.slice(0, DISPLAY_LIMIT),
    signalsTotal: signals.length,
    filteredOut,
    market,
    medianAtrPercent,
    scanned: pairs.length,
    rateLimited,
    scannedAt: Date.now(),
  };
}

// ==================== Presentation ====================

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

function Badge({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`w-fit whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/** Same colours as the dots in EMA-Zone-6-Strategies.pine. */
const STRATEGY: Record<Strategy, { name: string; dot: string; rule: string }> = {
  1: {
    name: "EMA200 touch",
    dot: "bg-orange-400",
    rule: `A candle touched EMA ${EMA_SLOW} within the last ${TOUCH200_BARS} candles`,
  },
  2: {
    name: "Reclaim / reject",
    dot: "bg-cyan-400",
    rule: `EMA ${EMA_FAST} or ${EMA_SLOW} touched within ${RECLAIM_BARS} candles and the close is back on the trade side of it`,
  },
  3: {
    name: "Range edge",
    dot: "bg-fuchsia-400",
    rule: `EMAs within ${SPREAD_MAX}% of each other, EMA ${EMA_FAST} touched within ${ZONE_BARS} candles, close inside the prior ${RANGE_BARS}-candle range`,
  },
  4: {
    name: "Trend pullback",
    dot: "bg-teal-400",
    rule: `EMAs ≥ ${SPREAD_MIN}% apart in the trade direction, an EMA touched within ${ZONE_BARS} candles, close on the trend side of EMA ${EMA_SLOW}`,
  },
  5: {
    name: "Exhaustion fade",
    dot: "bg-yellow-400",
    rule: `≥ ${EXH_ATR} ATR from EMA ${EMA_FAST} with stretched RSI — fade back toward the EMAs (no filters)`,
  },
};

function SidePill({ side }: { side: Side }) {
  return (
    <span
      className={`px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap ${
        side === "LONG" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
      }`}
    >
      {side === "LONG" ? "LONG ↑" : "SHORT ↓"}
    </span>
  );
}

function StrategyList({ list }: { list: Strategy[] }) {
  return (
    <span className="inline-flex flex-col gap-1">
      {list.map((s) => (
        <span
          key={s}
          title={STRATEGY[s].rule}
          className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-gray-200"
        >
          <span className={`h-2 w-2 rounded-full ${STRATEGY[s].dot}`} />
          {s} · {STRATEGY[s].name}
        </span>
      ))}
    </span>
  );
}

const when = (barsAgo: number) => (barsAgo === 0 ? "last candle" : `${barsAgo + 1} candles ago`);

function Location({ r }: { r: Row }) {
  const near = Math.abs(r.distEma200Atr) <= Math.abs(r.distEma50Atr) ? EMA_SLOW : EMA_FAST;
  const dist = near === EMA_SLOW ? r.distEma200Atr : r.distEma50Atr;
  const touch =
    r.ema200TouchAgo != null && r.ema200TouchAgo <= TOUCH200_BARS
      ? `EMA ${EMA_SLOW} touched ${r.ema200TouchAgo === 0 ? "now" : `${r.ema200TouchAgo}c ago`}`
      : r.ema50TouchAgo != null && r.ema50TouchAgo <= ZONE_BARS
        ? `EMA ${EMA_FAST} touched ${r.ema50TouchAgo === 0 ? "now" : `${r.ema50TouchAgo}c ago`}`
        : "no recent touch";
  return (
    <span className="inline-flex flex-col gap-0.5 whitespace-nowrap text-xs">
      <span className="text-gray-200">
        {Math.abs(dist).toFixed(1)} ATR {dist >= 0 ? "above" : "below"} EMA {near}
      </span>
      <span className="text-gray-500">
        {touch} · spread {r.spreadPct.toFixed(1)}%
      </span>
    </span>
  );
}

/** KST vs its signal: a fresh cross is coloured; it is outlined when it agrees with the trade side. */
function Kst({ r, side }: { r: Row; side: Side }) {
  const title = `KST(${KST_ROC.join(" ")} / ${KST_SMA.join(" ")} / ${KST_SIGNAL}) ${r.kst.toFixed(2)} vs signal ${r.kstSignal.toFixed(2)}`;
  if (r.kstCross && r.kstCrossAgo != null) {
    const up = r.kstCross === "LONG";
    return (
      <span
        title={`${title} • crossed ${when(r.kstCrossAgo)}`}
        className={`w-fit whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${
          up ? TONE.bull : TONE.bear
        } ${r.kstCross === side ? "ring-1 ring-current" : ""}`}
      >
        KST {up ? "↑" : "↓"} {r.kstCrossAgo === 0 ? "now" : `${r.kstCrossAgo + 1}c ago`}
      </span>
    );
  }
  return (
    <Badge tone="muted" title={title}>
      KST {r.kstAbove ? "above" : "below"} signal
    </Badge>
  );
}

function Momentum({ r, side }: { r: Row; side: Side }) {
  const rsiTone: Tone = r.rsi >= 70 || r.rsi <= 30 ? "warn" : "muted";
  const adxStrong = r.adx >= ADX_MAX;
  return (
    <span className="inline-flex flex-col gap-1">
      <Kst r={r} side={side} />
      <Badge tone={rsiTone} title={`RSI(14)`}>
        RSI {r.rsi.toFixed(0)}
      </Badge>
      <span
        className="whitespace-nowrap text-[11px] text-gray-500"
        title={`ADX(14) with +DI ${r.plusDi.toFixed(1)} / −DI ${r.minusDi.toFixed(1)}`}
      >
        ADX {r.adx.toFixed(0)}
        {adxStrong ? (r.plusDi > r.minusDi ? " · trend ↑" : " · trend ↓") : " · no trend"}
      </span>
    </span>
  );
}

function Change({ value }: { value: number }) {
  return (
    <span className={`font-medium ${value >= 0 ? "text-green-400" : "text-red-400"}`}>
      {value >= 0 ? "+" : ""}
      {value.toFixed(2)}%
    </span>
  );
}

const TH = ({ children }: { children: React.ReactNode }) => (
  <th className="text-left py-4 pr-4 whitespace-nowrap">{children}</th>
);

function SignalTable({
  title,
  badgeClass,
  rows,
  total,
  subtitle,
  empty,
}: {
  title: string;
  badgeClass: string;
  rows: SignalRow[];
  total: number;
  subtitle: string;
  empty: string;
}) {
  const longs = rows.filter((r) => r.shown.side === "LONG").length;
  return (
    <div className="bg-gray-900 rounded-3xl shadow-2xl p-8">
      <div className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h2 className="text-3xl font-semibold text-white">{title}</h2>
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ${badgeClass}`}>{total}</span>
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
              <TH>Strategies</TH>
              <TH>Fired</TH>
              <TH>Location</TH>
              <TH>KST / RSI / ADX</TH>
              <TH>ATR%</TH>
              <TH>24h volume</TH>
              <TH>24h %</TH>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.symbol} className="border-b border-gray-800 hover:bg-gray-800/70 transition-colors">
                <td className="py-4 pr-4">{i + 1}</td>
                <td className="py-4 pr-4 font-semibold">{r.symbol}</td>
                <td className="py-4 pr-4">
                  <SidePill side={r.shown.side} />
                </td>
                <td className="py-4 pr-4">
                  <span className="inline-flex flex-col gap-1">
                    <StrategyList list={r.shown.passed} />
                    {r.shown.passed.length >= 3 && (
                      <Badge tone="calm">{r.shown.passed.length} agree</Badge>
                    )}
                  </span>
                </td>
                <td className="py-4 pr-4">
                  <span className="inline-flex flex-col gap-0.5 whitespace-nowrap text-xs">
                    <span className={r.shown.barsAgo === 0 ? "text-emerald-300" : "text-gray-300"}>
                      {when(r.shown.barsAgo)}
                    </span>
                    <span className="text-gray-500">@ {r.shown.price.toPrecision(5)}</span>
                  </span>
                </td>
                <td className="py-4 pr-4">
                  <Location r={r} />
                </td>
                <td className="py-4 pr-4">
                  <Momentum r={r} side={r.shown.side} />
                </td>
                <td
                  className="py-4 pr-4 font-mono text-xs text-gray-300"
                  title={`ATR(${ATR_LENGTH}) is ${r.tradability.volatilityRatio.toFixed(2)}× the scan median`}
                >
                  {r.atrPercent.toFixed(2)}%
                </td>
                <td className="py-4 pr-4 font-mono text-xs text-gray-300">{formatVolume(r.volume24h)}</td>
                <td className="py-4">
                  <Change value={r.change24h} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="py-12 text-center text-gray-500">
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

function Legend() {
  return (
    <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-gray-400">
      {([1, 2, 3, 4, 5] as Strategy[]).map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5" title={STRATEGY[s].rule}>
          <span className={`h-2 w-2 rounded-full ${STRATEGY[s].dot}`} />
          {s} {STRATEGY[s].name}
        </span>
      ))}
    </div>
  );
}

// ==================== Page ====================

export default async function EmaZoneScanner() {
  let result: ScanResult;
  let btc: BtcMomentum | null = null;

  try {
    [result, btc] = await Promise.all([scan(), getBtcMomentum(ttlUntilClose(BTC_CANDLE_MS))]);
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
      ? { bull: market.aboveEma50, total: market.total, percent: (market.aboveEma50 / market.total) * 100 }
      : null;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-7xl mx-auto space-y-10">
        <ScannerTabs active="/" />
        <div className="grid items-start gap-6 lg:grid-cols-[16rem_1fr_16rem]">
          <div className="flex justify-center lg:justify-start">
            <MarketBias stats={market} btc={btc} />
          </div>

          <div className="text-center">
            <h1 className="text-5xl font-bold tracking-tight mb-3">
              Binance Futures {INTERVAL_LABEL} EMA Zone Scanner
            </h1>
            <p className="text-gray-400">
              Level entries at the EMA {EMA_FAST}/{EMA_SLOW} zone — the 6 strategies from
              strategy-discovery.md • liquid and moving coins only
            </p>
            <p className="mt-2 text-sm text-gray-500">
              Every reading is on the last closed {INTERVAL_LABEL} candle • re-scanned at each close
            </p>
            <AutoRefresh candleMs={CANDLE_MS} graceMs={CANDLE_CACHE_GRACE_MS} scannedAt={result.scannedAt} />
            {result.rateLimited && (
              <p className="mt-4 inline-block rounded-full bg-amber-500/15 px-4 py-2 text-sm text-amber-400">
                ⚠️ Binance rate limit reached — some pairs were served from cache or skipped. Refresh in a
                minute for a full scan.
              </p>
            )}
            <div className="mt-6">
              <Legend />
            </div>
          </div>

          <div className="flex justify-center lg:justify-end">
            <BtcMeter momentum={btc} breadth={breadth} />
          </div>
        </div>

        <SignalTable
          title="🎯 Combined signals"
          badgeClass="bg-emerald-500/20 text-emerald-300"
          rows={result.signals}
          total={result.signalsTotal}
          subtitle={`Any of strategies 1–5 passing the filters, in the last ${FRESH_BARS} closed candles • freshest first, then most tradable`}
          empty={`No signal in the last ${FRESH_BARS} closed candles`}
                />

        <p className="text-center text-xs text-gray-500">
          Same rules and defaults as EMA-Zone-6-Strategies.pine • Side = colour of the signal candle •
          Filters for 1–4: RSI ≤ {RSI_LONG_MAX} long / ≥ {RSI_SHORT_MIN} short; no long when ADX ≥{" "}
          {ADX_MAX} with −DI &gt; +DI; 10-candle-extreme stop no more than {SL_ZONE_ATR} ATR inside EMA{" "}
          {EMA_SLOW} • 5 is exempt • Pre-filter: 24h volume ≥ ${(SCAN_MIN_VOLUME / 1_000_000).toFixed(0)}M
          and ATR% {MIN_VOL_RATIO}×–{MAX_VOL_RATIO}× the scan median ({result.medianAtrPercent.toFixed(2)}%) —{" "}
          {result.filteredOut} of {market.total} pairs cut • Scanned {result.scanned} perpetuals • Rules are
          in-sample hypotheses from 30 trades • No SL/TP shown by design — read the levels off the chart
        </p>
      </div>
    </div>
  );
}
