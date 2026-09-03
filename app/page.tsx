/* eslint-disable @typescript-eslint/no-explicit-any */
import { unstable_rethrow } from "next/navigation";
import AutoRefresh from "./_components/auto-refresh";
import BtcMeter from "./_components/btc-meter";
import {
  CANDLE_CACHE_GRACE_MS,
  MIN_VOLUME,
  type PairData,
  RateLimitedError,
  formatPrice,
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
import { smaSeries } from "./_lib/indicators";
import {
  ATR_LENGTH,
  CROSS_LOOKBACK,
  EMA_LENGTH,
  K_MAX_LONG,
  K_MIN_SHORT,
  PROX_ATR,
  type Side,
  evaluateKstPullback,
} from "./_lib/kst-pullback";
import {
  BB_LENGTH,
  BB_STDDEV,
  EXTREME_PERCENTILE,
  PERCENTILE_LOOKBACK,
  SQUEEZE_PERCENTILE,
  squeezeAt,
} from "./_lib/squeeze";

// One timeframe for everything: the KST cross, StochRSI, EMA 50, the squeeze
// percentile and the context indicators all read the same 1h series.
const INTERVAL = "1h";
const CANDLE_MS = 60 * 60_000;

// 499, not 500, on purpose: Binance buckets klines request-weight by `limit`
// ([100,500) costs 2, [500,1000) costs 5), so one bar less is 2.5x cheaper for
// history we don't need. 499 clears every warm-up here — the BB percentile
// needs 240 + 20 = 260 bars, KST's slowest leg ~60.
const KLINE_LIMIT = 499;

// One scan per candle: klines are held until the next 1h close, so every
// reload inside the hour is served from cache and costs Binance nothing.
//
// Note what this trades away. The indicators still read the LIVE candle (see
// the clock note below) — but they are now sampled ONCE, moments after the
// close, and then held for the hour. So the numbers match TradingView at the
// close and drift from it as the candle fills out. "Refresh now" re-samples on
// demand when you want them back in step.
function klineTtlMs(): number {
  const now = Date.now();
  return CANDLE_MS - (now % CANDLE_MS) + CANDLE_CACHE_GRACE_MS;
}

const VOLUME_MA_LENGTH = 20; // context only — RVOL confirms a move
const HIGH_RVOL = 1.5; // highlight threshold, never a filter

// A cold scan is network-bound, not compute-bound: replaying every indicator
// over ~200 symbols takes ~0.1s, while the klines fetches take ~10s at 10 per
// round. 20 per round halves the sequential rounds to ~6.5s for the same
// number of calls and the same weight — worth it on the "Refresh now" path,
// which is the one you wait on.
const MAX_CONCURRENT = 20;
const BATCH_DELAY_MS = 120;

// The watchlist's size moves with the volatility regime rather than staying
// near a fixed count, so cap the table and report the overflow instead of
// rendering half the universe on a choppy day.
const WATCHLIST_DISPLAY_LIMIT = 40;

// ==================== The two clocks ====================
// Reproduced from kst-pullback.pine on its DEFAULT setting (`Indicators Read =
// Live candle`), because that is the one whose numbers match TradingView's
// built-ins tick for tick:
//
//   LIVE, still-forming candle : KST, its signal, StochRSI %K, the cross age,
//                                the Bollinger bandwidth rank.
//   LAST CLOSED candle         : candle colour, close vs EMA 50, the pullback
//                                distance, the EMA cross, ATR, RVOL.
//
// A forming candle's colour and close are not decided yet — a green candle
// hugging the EMA can end the bar red and below it — so the structure waits
// for the bar to finish.
//
// Scanning hourly rather than continuously makes the page final for the hour:
// the flag belongs to the candle that just closed and stays put, instead of
// appearing and vanishing as live values move. The live indicators are read a
// few seconds into the new bar, so they are effectively the freshest possible
// sample of the setup at the moment it completed.

// ==================== Rate-limit protection ====================
// Binance fapi allows 2400 request-weight/min per IP, shared across every
// scanner page (see ./_lib/binance). At limit 499 a klines call costs 2, so a
// full scan is ~200 eligible pairs x 2 + 41 for exchangeInfo/ticker ≈ 440 —
// once an hour, which is nothing against a per-minute cap. Defences, in order:
//   1. klines are cached until the next 1h close, so refreshing inside a
//      candle issues zero requests;
//   2. batches are staggered;
//   3. the X-MBX-USED-WEIGHT-1M header is read on every response and we idle
//      when it climbs toward the cap;
//   4. a 429/418 puts every caller into a cooldown that serves stale cache
//      instead of hammering the endpoint into an IP ban.

interface ScanRow {
  symbol: string;
  /** Live price — the forming candle's close. */
  price: string;
  changePercent: number;

  /** The complete Pine rule, or null for a watchlist-only row. */
  signal: Side | null;

  // ── Live candle ──
  crossSide: "UP" | "DOWN" | null;
  barsSinceCross: number | null;
  kstLong: boolean;
  kstShort: boolean;
  stochK: number;
  stochLong: boolean;
  stochShort: boolean;
  squeeze: boolean;
  extreme: boolean;
  squeezeRank: number | null;

  // ── Last closed candle ──
  ema: string;
  emaDistancePercent: number;
  withinProx: boolean;
  emaCross: "UP" | "DOWN" | null;
  candle: "GREEN" | "RED" | "FLAT";
  aboveEma: boolean;

  // ── Context, never gates ──
  rvol: number;
  atrPercent: number;
}

/** A KST cross is live for CROSS_LOOKBACK bars counted back from the live one. */
function hasFreshCross(row: ScanRow): boolean {
  return row.barsSinceCross != null && row.barsSinceCross <= CROSS_LOOKBACK - 1;
}

/** Which way a watchlist row leans: the KST side, else the side of the EMA. */
function bias(row: ScanRow): Side {
  if (row.kstLong) return "LONG";
  if (row.kstShort) return "SHORT";
  if (row.crossSide === "UP") return "LONG";
  if (row.crossSide === "DOWN") return "SHORT";
  return row.aboveEma ? "LONG" : "SHORT";
}

/**
 * The gates still standing between a watchlist row and a full signal. This is
 * what makes the second table worth reading rather than just long — it says
 * what you are waiting for, per coin.
 */
function missingGates(row: ScanRow, side: Side): string[] {
  const missing: string[] = [];
  const long = side === "LONG";

  if (long ? !row.kstLong : !row.kstShort) {
    missing.push(
      row.crossSide === (long ? "UP" : "DOWN") && row.barsSinceCross != null
        ? `KST cross ${row.barsSinceCross}b stale`
        : "KST cross",
    );
  }

  if (long ? !row.stochLong : !row.stochShort) {
    missing.push(
      `%K ${row.stochK.toFixed(0)} (need ${long ? `≤${K_MAX_LONG}` : `≥${K_MIN_SHORT}`})`,
    );
  }

  if (row.candle !== (long ? "GREEN" : "RED")) {
    missing.push(
      row.candle === "FLAT"
        ? "flat candle"
        : `candle ${row.candle.toLowerCase()}`,
    );
  }

  if (long ? !row.aboveEma : row.aboveEma) {
    missing.push(`close ${long ? "below" : "above"} EMA ${EMA_LENGTH}`);
  }

  if (!row.withinProx && row.emaCross !== (long ? "UP" : "DOWN")) {
    missing.push("too far from EMA");
  }

  return missing;
}

// ==================== Analysis ====================

/**
 * Breadth is why this returns a wrapper rather than a row: `aboveEma` is a vote
 * every readable pair casts, including the ~90% that never make either table.
 * Counting it only over qualifying rows would measure the tables, not the
 * market.
 */
interface Analysis {
  row: ScanRow | null;
  aboveEma: boolean;
}

function analyze(pair: PairData, klines: any[]): Analysis | null {
  // Every series is computed over the FULL array, forming candle included, and
  // indexed at two offsets. Nothing may strip the forming candle here.
  const live = klines.length - 1;
  const prev = live - 1;
  if (prev < 1) return null;

  const state = evaluateKstPullback(klines);
  if (!state) return null;

  const aboveEma = state.aboveEma;

  const squeezeState = squeezeAt(klines, live);
  const squeeze = squeezeState?.squeeze ?? false;
  const freshCross =
    state.barsSinceCross != null && state.barsSinceCross <= CROSS_LOOKBACK - 1;

  // Table 1 takes the full rule; table 2 takes price at the EMA plus at least
  // one of squeeze / fresh cross. Anything else is not worth a row.
  const qualifies =
    state.signal !== null || (state.nearEma && (squeeze || freshCross));
  if (!qualifies) return { row: null, aboveEma };

  // RVOL reads the CLOSED bar: a forming bar's volume is partial and would
  // read as a collapse for 59 minutes out of every 60.
  const volumes = klines.map((k: any) => parseFloat(k[5]));
  const volumeAverage = smaSeries(volumes, VOLUME_MA_LENGTH)[prev];
  const rvol =
    Number.isFinite(volumeAverage) && volumeAverage !== 0
      ? volumes[prev] / volumeAverage
      : 0;

  const livePrice = parseFloat(klines[live][4]);

  const row: ScanRow = {
    symbol: pair.symbol,
    price: formatPrice(livePrice, pair.tickSize),
    changePercent: pair.changePercent,

    signal: state.signal,

    crossSide: state.crossSide,
    barsSinceCross: state.barsSinceCross,
    kstLong: state.kstLong,
    kstShort: state.kstShort,
    stochK: state.stochK,
    stochLong: state.stochLong,
    stochShort: state.stochShort,
    squeeze,
    extreme: squeezeState?.extreme ?? false,
    squeezeRank: squeezeState?.rank ?? null,

    ema: formatPrice(state.ema, pair.tickSize),
    emaDistancePercent: state.emaDistancePercent,
    withinProx: state.withinProx,
    emaCross: state.emaCross,
    candle: state.candle,
    aboveEma: state.aboveEma,

    rvol,
    atrPercent: (state.atr / state.closedPrice) * 100,
  };

  return { row, aboveEma };
}

// ==================== Scan (concurrent batches) ====================

/**
 * How much of the universe is on the right side of its own EMA 50, on the last
 * closed 1h candle. Independent of what BTC itself did — "BTC up on the week,
 * but only a third of alts above their EMA" is a state no BTC-only reading can
 * show you, and it is the one where alt longs fail most often.
 */
interface Breadth {
  above: number;
  total: number;
  percent: number;
}

interface ScanResult {
  signals: ScanRow[];
  watchlist: ScanRow[];
  watchlistTotal: number;
  scanned: number;
  breadth: Breadth | null;
  rateLimited: boolean;
  scannedAt: number;
}

/** Freshest cross first, then tightest to the EMA, then heaviest volume. */
const byFreshnessThenDistance = (a: ScanRow, b: ScanRow) =>
  (a.barsSinceCross ?? Infinity) - (b.barsSinceCross ?? Infinity) ||
  a.emaDistancePercent - b.emaDistancePercent ||
  b.rvol - a.rvol;

async function scan(): Promise<ScanResult> {
  const pairs = await getFilteredPairs();
  const rows: ScanRow[] = [];
  let breadthAbove = 0;
  let breadthTotal = 0;
  let rateLimited = false;

  for (let i = 0; i < pairs.length; i += MAX_CONCURRENT) {
    const chunk = pairs.slice(i, i + MAX_CONCURRENT);

    // Everything already cached costs nothing — only throttle real traffic.
    const willHitNetwork = chunk.some((pair) =>
      klinesNeedNetwork(pair.symbol, INTERVAL, KLINE_LIMIT),
    );

    if (willHitNetwork && isThrottled()) {
      rateLimited = true;
    } else if (willHitNetwork && isNearWeightCap()) {
      // Too close to the cap to keep going this pass; report what we have.
      rateLimited = true;
      break;
    } else if (willHitNetwork && isPastWeightSoftCap()) {
      await sleep(weightCooldownMs);
    }

    const results = await Promise.all(
      chunk.map(async (pair) => {
        try {
          const klines = await getKlines(
            pair.symbol,
            INTERVAL,
            KLINE_LIMIT,
            klineTtlMs(),
          );
          return analyze(pair, klines);
        } catch (error) {
          if (error instanceof RateLimitedError) rateLimited = true;
          else console.log("scan error", pair.symbol, error);
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      breadthTotal += 1;
      if (result.aboveEma) breadthAbove += 1;
      if (result.row) rows.push(result.row);
    }

    // Stagger batches so a cold cache doesn't burst-fire every klines request
    // at once and trip Binance's request-weight limiter.
    if (willHitNetwork && i + MAX_CONCURRENT < pairs.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  const signals = rows
    .filter((r) => r.signal !== null)
    .sort(byFreshnessThenDistance);

  // A coin never appears twice: anything with a full signal is already above.
  const watchlist = rows
    .filter((r) => r.signal === null)
    .sort((a, b) => {
      // Both rules matched beats one of them, then the usual ordering.
      const score = (r: ScanRow) =>
        (r.squeeze ? 1 : 0) + (hasFreshCross(r) ? 1 : 0);
      return score(b) - score(a) || byFreshnessThenDistance(a, b);
    });

  return {
    signals,
    watchlist: watchlist.slice(0, WATCHLIST_DISPLAY_LIMIT),
    watchlistTotal: watchlist.length,
    scanned: pairs.length,
    // Over what was actually read this pass, which is the whole universe unless
    // a rate limit cut the scan short.
    breadth:
      breadthTotal > 0
        ? {
            above: breadthAbove,
            total: breadthTotal,
            percent: (breadthAbove / breadthTotal) * 100,
          }
        : null,
    rateLimited,
    scannedAt: Date.now(),
  };
}

// ==================== Presentation helpers ====================

function Section({
  icon,
  title,
  caption,
  count,
  accent,
  children,
}: {
  icon: string;
  title: string;
  caption: string;
  count: number;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-gray-900 rounded-3xl shadow-2xl p-8">
      <div className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h2 className="text-3xl font-semibold text-white flex items-center gap-3">
          {icon} {title}
        </h2>
        <span
          className={`rounded-full px-3 py-1 text-sm font-semibold ${accent}`}
        >
          {count}
        </span>
        <p className="text-sm text-gray-500">{caption}</p>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

const TH = ({ children }: { children: React.ReactNode }) => (
  <th className="text-left py-4 whitespace-nowrap">{children}</th>
);

function SideBadge({ side }: { side: Side }) {
  return (
    <span
      className={`px-3 py-1 rounded-full text-xs font-bold ${
        side === "LONG"
          ? "bg-green-500/20 text-green-400"
          : "bg-red-500/20 text-red-400"
      }`}
    >
      {side}
    </span>
  );
}

/**
 * The cross, with its age counted back from the LIVE bar — so `live` means the
 * cross is on the still-forming candle and can still un-cross before it
 * closes. Worth flagging rather than dressing up as settled.
 */
function Kst({ row }: { row: ScanRow }) {
  if (row.crossSide == null || row.barsSinceCross == null) {
    return <span className="text-gray-600">—</span>;
  }

  const up = row.crossSide === "UP";
  const stale = !hasFreshCross(row);
  const provisional = row.barsSinceCross === 0;

  return (
    <span
      className={`inline-flex items-baseline gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-bold ${
        stale
          ? "bg-gray-700/40 text-gray-500"
          : up
            ? "bg-green-500/15 text-green-400"
            : "bg-red-500/15 text-red-400"
      }`}
    >
      {up ? "↑" : "↓"}
      <span
        className={`font-normal ${provisional ? "text-amber-400" : "text-gray-400"}`}
      >
        {provisional ? "live" : `${row.barsSinceCross}b`}
      </span>
    </span>
  );
}

function StochK({ row, side }: { row: ScanRow; side: Side }) {
  const ok = side === "LONG" ? row.stochLong : row.stochShort;
  return (
    <span className={`font-medium ${ok ? "text-gray-300" : "text-red-400"}`}>
      {row.stochK.toFixed(1)}
    </span>
  );
}

function Squeeze({ row }: { row: ScanRow }) {
  if (row.extreme) {
    return (
      <span className="rounded-md bg-orange-500/20 px-2 py-1 text-xs font-bold text-orange-300">
        EXTREME {row.squeezeRank?.toFixed(0)}%
      </span>
    );
  }
  if (row.squeeze) {
    return (
      <span className="rounded-md bg-yellow-500/20 px-2 py-1 text-xs font-bold text-yellow-300">
        SQUEEZE {row.squeezeRank?.toFixed(0)}%
      </span>
    );
  }
  return (
    <span className="text-gray-600">
      {row.squeezeRank != null ? `${row.squeezeRank.toFixed(0)}%` : "—"}
    </span>
  );
}

/** 0.00% means the candle tagged or pierced the EMA. */
function EmaDistance({ row }: { row: ScanRow }) {
  return (
    <span
      className={`font-mono ${row.withinProx ? "text-cyan-400" : "text-gray-500"}`}
    >
      {row.emaDistancePercent.toFixed(2)}%
    </span>
  );
}

function Trigger({ row, side }: { row: ScanRow; side: Side }) {
  const crossed = row.emaCross === (side === "LONG" ? "UP" : "DOWN");
  const label = row.withinProx
    ? crossed
      ? "Pullback + cross"
      : "Pullback"
    : "EMA cross";
  return (
    <span className="whitespace-nowrap rounded-md bg-gray-800 px-2 py-1 text-xs text-gray-300">
      {label}
    </span>
  );
}

function Rvol({ value }: { value: number }) {
  // Highlighted, never a filter — a quiet setup is still a setup.
  return (
    <span
      className={
        value >= HIGH_RVOL
          ? "rounded-md bg-blue-500/20 px-2 py-1 font-semibold text-blue-300"
          : "text-gray-400"
      }
    >
      {value.toFixed(2)}×
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

const rowClass =
  "border-b border-gray-800 hover:bg-gray-800/70 transition-colors";
const emptyClass = "py-12 text-center text-gray-500";

// ==================== Page ====================

export default async function KstPullbackScanner() {
  let result: ScanResult;
  let btc: BtcMomentum | null = null;

  try {
    // The BTC card is one extra request-weight on a different interval, so it
    // rides alongside the scan rather than after it — it never has to wait on
    // ~200 symbols' worth of klines to render.
    [result, btc] = await Promise.all([scan(), getBtcMomentum(klineTtlMs())]);
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

  const { signals, watchlist, watchlistTotal, scanned } = result;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-7xl mx-auto space-y-10">
        {/* Three columns so the heading stays optically centred with the BTC
            card parked at the right edge — an absolutely positioned card would
            slide under the h1 as it wraps. The left column is its counterweight
            and holds nothing. Below lg it all collapses to one column. */}
        <div className="grid items-start gap-6 lg:grid-cols-[16rem_1fr_16rem]">
          <div className="hidden lg:block" aria-hidden="true" />

          <div className="text-center">
            <h1 className="text-5xl font-bold tracking-tight mb-3">
              Binance Futures 1H KST Pullback Scanner
            </h1>
            <p className="text-gray-400">
              KST cross within {CROSS_LOOKBACK} bars • StochRSI %K ≤{" "}
              {K_MAX_LONG} long / ≥ {K_MIN_SHORT} short • candle closing on the
              right side of EMA {EMA_LENGTH}, within {PROX_ATR} × ATR(
              {ATR_LENGTH}) of it or crossing it
            </p>
            <p className="mt-2 text-sm text-gray-500">
              Scanned once an hour, just after each candle closes • indicators
              read the live candle, the flag is judged on the last closed one
            </p>
            <AutoRefresh
              candleMs={CANDLE_MS}
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
            <BtcMeter momentum={btc} breadth={result.breadth} />
          </div>
        </div>

        {/* Table 1 — the complete rule */}
        <Section
          icon="🎯"
          title="Signals"
          count={signals.length}
          accent="bg-emerald-500/20 text-emerald-300"
          caption="every rule satisfied on the last closed 1h candle — KST, StochRSI and the EMA 50 pullback"
        >
          <table className="w-full text-sm">
            <thead className="text-gray-400 border-b border-gray-700">
              <tr>
                <TH>#</TH>
                <TH>Pair</TH>
                <TH>Side</TH>
                <TH>Price</TH>
                <TH>EMA {EMA_LENGTH}</TH>
                <TH>Dist</TH>
                <TH>Trigger</TH>
                <TH>KST</TH>
                <TH>%K</TH>
                <TH>Squeeze</TH>
                <TH>RVOL</TH>
                <TH>ATR%</TH>
                <TH>24h %</TH>
              </tr>
            </thead>
            <tbody>
              {signals.map((s, i) => (
                <tr key={s.symbol} className={rowClass}>
                  <td className="py-4">{i + 1}</td>
                  <td className="py-4 font-semibold">{s.symbol}</td>
                  <td className="py-4">
                    <SideBadge side={s.signal!} />
                  </td>
                  <td className="py-4 font-mono">{s.price}</td>
                  <td className="py-4 font-mono text-gray-400">{s.ema}</td>
                  <td className="py-4">
                    <EmaDistance row={s} />
                  </td>
                  <td className="py-4">
                    <Trigger row={s} side={s.signal!} />
                  </td>
                  <td className="py-4">
                    <Kst row={s} />
                  </td>
                  <td className="py-4">
                    <StochK row={s} side={s.signal!} />
                  </td>
                  <td className="py-4">
                    <Squeeze row={s} />
                  </td>
                  <td className="py-4">
                    <Rvol value={s.rvol} />
                  </td>
                  <td className="py-4 font-medium text-purple-400">
                    {s.atrPercent.toFixed(2)}%
                  </td>
                  <td className="py-4">
                    <Change value={s.changePercent} />
                  </td>
                </tr>
              ))}
              {signals.length === 0 && (
                <tr>
                  <td colSpan={13} className={emptyClass}>
                    No coin passes every rule on the last closed 1h candle
                    {watchlistTotal > 0
                      ? ` — ${watchlistTotal} ${watchlistTotal === 1 ? "is" : "are"} part-way there below`
                      : ""}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Section>

        {/* Table 2 — price at the EMA, plus one of the two rules */}
        <Section
          icon="👀"
          title="Watchlist"
          count={watchlistTotal}
          accent="bg-amber-500/20 text-amber-300"
          caption={
            watchlistTotal > watchlist.length
              ? `at the EMA ${EMA_LENGTH} with a squeeze or a fresh KST cross — closest ${watchlist.length} of ${watchlistTotal} shown`
              : `at the EMA ${EMA_LENGTH} with a squeeze or a fresh KST cross — not a signal yet, "Missing" says why`
          }
        >
          <table className="w-full text-sm">
            <thead className="text-gray-400 border-b border-gray-700">
              <tr>
                <TH>#</TH>
                <TH>Pair</TH>
                <TH>Bias</TH>
                <TH>Price</TH>
                {/* <TH>EMA {EMA_LENGTH}</TH> */}
                {/* <TH>Dist</TH> */}
                <TH>Matched</TH>
                <TH>Missing</TH>
                {/* <TH>KST</TH> */}
                <TH>%K</TH>
                {/* <TH>Squeeze</TH> */}
                {/* <TH>RVOL</TH> */}
                <TH>ATR%</TH>
                <TH>24h %</TH>
              </tr>
            </thead>
            <tbody>
              {watchlist.map((s, i) => {
                const side = bias(s);
                const missing = missingGates(s, side);
                return (
                  <tr key={s.symbol} className={rowClass}>
                    <td className="py-4">{i + 1}</td>
                    <td className="py-4 font-semibold">{s.symbol}</td>
                    <td className="py-4">
                      <SideBadge side={side} />
                    </td>
                    <td className="py-4 font-mono">{s.price}</td>
                    {/* <td className="py-4 font-mono text-gray-400">{s.ema}</td> */}
                    {/* <td className="py-4">
                      <EmaDistance row={s} />
                    </td> */}
                    <td className="py-4">
                      <span className="flex flex-wrap gap-1">
                        <span className="whitespace-nowrap rounded-md bg-cyan-500/15 px-2 py-1 text-xs font-semibold text-cyan-300">
                          AT EMA
                        </span>
                        {s.squeeze && (
                          <span
                            className={`whitespace-nowrap rounded-md px-2 py-1 text-xs font-semibold ${
                              s.extreme
                                ? "bg-orange-500/20 text-orange-300"
                                : "bg-yellow-500/20 text-yellow-300"
                            }`}
                          >
                            {s.extreme ? "EXTREME" : "SQUEEZE"}
                          </span>
                        )}
                        {hasFreshCross(s) && (
                          <span className="whitespace-nowrap rounded-md bg-green-500/15 px-2 py-1 text-xs font-semibold text-green-300">
                            KST {s.crossSide === "UP" ? "↑" : "↓"}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="py-4">
                      {missing.length === 0 ? (
                        <span className="text-gray-600">—</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {missing.map((gate) => (
                            <span
                              key={gate}
                              className="whitespace-nowrap rounded-md bg-gray-800 px-2 py-1 text-xs text-gray-400"
                            >
                              {gate}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    {/* <td className="py-4">
                      <Kst row={s} />
                    </td> */}
                    <td className="py-4">
                      <StochK row={s} side={side} />
                    </td>
                    {/* <td className="py-4">
                      <Squeeze row={s} />
                    </td> */}
                    {/* <td className="py-4">
                      <Rvol value={s.rvol} />
                    </td> */}
                    <td className="py-4 font-medium text-purple-400">
                      {s.atrPercent.toFixed(2)}%
                    </td>
                    <td className="py-4">
                      <Change value={s.changePercent} />
                    </td>
                  </tr>
                );
              })}
              {watchlist.length === 0 && (
                <tr>
                  <td colSpan={14} className={emptyClass}>
                    Nothing sitting at the EMA {EMA_LENGTH} with a squeeze or a
                    fresh KST cross
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Section>

        <p className="text-center text-xs text-gray-500">
          LONG = KST crossed above its signal within {CROSS_LOOKBACK} bars, %K ≤{" "}
          {K_MAX_LONG}, and a green candle closed above EMA {EMA_LENGTH} within{" "}
          {PROX_ATR} × ATR({ATR_LENGTH}) of it or crossing up through it; SHORT
          mirrors it (%K ≥ {K_MIN_SHORT}) • Watchlist = price at the EMA plus a
          squeeze or a fresh cross, one rule short of a signal • Squeeze = BB(
          {BB_LENGTH}, {BB_STDDEV}) bandwidth ranked in the bottom{" "}
          {SQUEEZE_PERCENTILE}% of the previous {PERCENTILE_LOOKBACK} bars (
          {EXTREME_PERCENTILE}% = EXTREME) — a bonus indicator on a signal,
          never a filter • KST, %K and the squeeze rank read the LIVE candle;
          candle colour, the EMA test and the pullback distance read the last
          CLOSED one • Sampled once per candle, moments after the close, so the
          table is final for the hour — live values match TradingView at that
          moment and drift as the candle fills out, so hit Refresh now to line
          them back up • KST age is counted back from the live bar • Scanned{" "}
          {scanned} perpetuals with 24h quote volume ≥ $
          {(MIN_VOLUME / 1_000_000).toFixed(0)}M • RVOL and ATR% are context
          only, never filters • No SL/TP shown by design — read the levels off
          the chart
        </p>
      </div>
    </div>
  );
}
