import { unstable_rethrow } from "next/navigation";
import AutoRefresh from "./_components/auto-refresh";
import BtcMeter from "./_components/btc-meter";
import {
  CANDLE_CACHE_GRACE_MS,
  MIN_VOLUME,
  RateLimitedError,
  getFilteredPairs,
  getKlines,
  getOpenInterestChange,
  isNearWeightCap,
  isPastWeightSoftCap,
  isThrottled,
  klinesNeedNetwork,
  sleep,
  weightCooldownMs,
} from "./_lib/binance";
import { type BtcMomentum, getBtcMomentum } from "./_lib/btc-momentum";
import {
  ADX_LENGTH,
  ATR_LENGTH,
  CANDLE_MS,
  type Check,
  EMA_BREADTH,
  type EmaTouch,
  INTERVAL,
  INTERVAL_LABEL,
  KST_ROC,
  KST_SIGNAL,
  KST_SMA,
  MAX_SCORE,
  NEAR_ATR,
  OI_BARS,
  RSI_LENGTH,
  type Side,
  evaluateSetup,
} from "./_lib/watchlist";
import {
  type Tradability,
  formatVolume,
  median,
  tradability,
} from "./_lib/tradability";

// 499, not 500, on purpose: Binance buckets klines request-weight by `limit`
// ([100,500) costs 2, [500,1000) costs 5), so one bar less is 2.5x cheaper.
// Enough for EMA 200 / RSI / ADX / KST to settle to TradingView's values.
const KLINE_LIMIT = 499;

// One clock: everything reads the last CLOSED candle (see ./_lib/watchlist),
// so nothing changes until the next close. Klines are held until then and the
// page re-scans once per candle.
function ttlUntilClose(periodMs: number): number {
  return periodMs - (Date.now() % periodMs) + CANDLE_CACHE_GRACE_MS;
}
const candleTtlMs = () => ttlUntilClose(CANDLE_MS);
// The BTC card keeps its own 1h clock (see ./_lib/btc-momentum).
const BTC_CANDLE_MS = 60 * 60_000;

const MAX_CONCURRENT = 20;
const BATCH_DELAY_MS = 120;

const DISPLAY_LIMIT = 50;

// ==================== Scan ====================

interface Row {
  symbol: string;
  side: Side;
  changePercent: number;
  volume: number;
  atrPercent: number;
  candleChecks: Omit<Record<Check, boolean>, "oi">;
  kst: number;
  kstSignal: number;
  rsi: number;
  rsiPrev: number;
  adx: number;
  adxPrev: number;
  touches: EmaTouch[];
  closedAt: number;
}

type Ranked = Row & {
  checks: Record<Check, boolean>;
  /** OI % change over the previous candle; null when the read failed. */
  oiChange: number | null;
  /** Confirmations met, 0–MAX_SCORE. The primary sort key. */
  score: number;
  /** Volatility × liquidity — breaks ties between equal scores. */
  tradability: Tradability;
};

/** Share of the universe closing above its EMA 50. */
interface Breadth {
  bull: number;
  total: number;
  percent: number;
}

interface ScanResult {
  rows: Ranked[];
  total: number;
  longs: number;
  shorts: number;
  scanned: number;
  breadth: Breadth | null;
  medianAtrPercent: number;
  rateLimited: boolean;
  scannedAt: number;
}

async function scan(): Promise<ScanResult> {
  const pairs = await getFilteredPairs();
  const rows: Row[] = [];
  const atrSamples: number[] = [];
  let breadthBull = 0;
  let breadthTotal = 0;
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
          const klines = await getKlines(
            pair.symbol,
            INTERVAL,
            KLINE_LIMIT,
            candleTtlMs(),
          );
          return { pair, evaluation: evaluateSetup(klines) };
        } catch (error) {
          if (error instanceof RateLimitedError) rateLimited = true;
          else console.log("scan error", pair.symbol, error);
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result?.evaluation) continue;
      const { pair, evaluation } = result;
      breadthTotal += 1;
      atrSamples.push(evaluation.atrPercent);
      if (evaluation.aboveEma50) breadthBull += 1;
      const setup = evaluation.setup;
      // The ticker's rolling 24h includes the forming candle, so it only picks
      // which pairs to fetch; the volume floor is re-checked on closed candles.
      if (setup && setup.volume24h >= MIN_VOLUME) {
        rows.push({
          symbol: pair.symbol,
          side: setup.side,
          changePercent: setup.change24h,
          volume: setup.volume24h,
          atrPercent: setup.atrPercent,
          candleChecks: setup.checks,
          kst: setup.kst,
          kstSignal: setup.kstSignal,
          rsi: setup.rsi,
          rsiPrev: setup.rsiPrev,
          adx: setup.adx,
          adxPrev: setup.adxPrev,
          touches: setup.touches,
          closedAt: setup.closedAt,
        });
      }
    }

    if (willHitNetwork && i + MAX_CONCURRENT < pairs.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // Volatility is scored against the whole scan's median, so ranking waits
  // until every pair has been read.
  const medianAtrPercent = median(atrSamples);

  // Every near-EMA row gets an OI read — one request each, held until the next
  // close. OI only ranks, so a failed read just leaves that check unmet.
  const ranked: Ranked[] = [];
  for (let i = 0; i < rows.length; i += MAX_CONCURRENT) {
    const skipOi = isThrottled() || isNearWeightCap();
    if (skipOi) rateLimited = true;
    const checked = await Promise.all(
      rows.slice(i, i + MAX_CONCURRENT).map(async (row) => {
        const oiChange = skipOi
          ? null
          : await getOpenInterestChange(
              row.symbol,
              INTERVAL,
              CANDLE_MS,
              row.closedAt,
              OI_BARS,
              candleTtlMs(),
            ).catch((error) => {
              if (error instanceof RateLimitedError) rateLimited = true;
              else console.log("oi error", row.symbol, error);
              return null;
            });
        return { row, oiChange };
      }),
    );

    for (const { row, oiChange } of checked) {
      const checks = { ...row.candleChecks, oi: oiChange != null && oiChange > 0 };
      ranked.push({
        ...row,
        checks,
        oiChange,
        score: Object.values(checks).filter(Boolean).length,
        tradability: tradability(row.atrPercent, row.volume, medianAtrPercent),
      });
    }
  }

  ranked.sort(
    (a, b) => b.score - a.score || b.tradability.score - a.tradability.score,
  );

  return {
    rows: ranked.slice(0, DISPLAY_LIMIT),
    total: ranked.length,
    longs: ranked.filter((r) => r.side === "LONG").length,
    shorts: ranked.filter((r) => r.side === "SHORT").length,
    scanned: pairs.length,
    breadth:
      breadthTotal > 0
        ? {
            bull: breadthBull,
            total: breadthTotal,
            percent: (breadthBull / breadthTotal) * 100,
          }
        : null,
    medianAtrPercent,
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

function NearEma({ row }: { row: Row }) {
  const [nearest, ...rest] = row.touches;
  return (
    <span className="inline-flex flex-col gap-0.5 whitespace-nowrap">
      <span
        className="font-mono text-sm text-cyan-300"
        title={`Close is ${Math.abs(nearest.distanceAtr).toFixed(2)} ATR ${
          nearest.distanceAtr >= 0 ? "above" : "below"
        } EMA ${nearest.length}`}
      >
        EMA {nearest.length}{" "}
        <span className="text-gray-500">
          {nearest.distanceAtr >= 0 ? "+" : "−"}
          {Math.abs(nearest.distanceAtr).toFixed(2)} ATR
        </span>
      </span>
      {rest.length > 0 && (
        <span className="font-mono text-[11px] text-gray-500">
          also {rest.map((t) => `EMA ${t.length}`).join(", ")}
        </span>
      )}
    </span>
  );
}

/** One confirmation cell: a tick or a dash, with the reading underneath. */
function CheckCell({
  met,
  detail,
  title,
}: {
  met: boolean;
  detail: React.ReactNode;
  title: string;
}) {
  return (
    <span className="inline-flex flex-col gap-0.5 whitespace-nowrap" title={title}>
      <span
        className={`w-fit rounded-md px-2 py-0.5 font-mono text-xs ${
          met
            ? "bg-emerald-500/15 font-bold text-emerald-300"
            : "bg-gray-800 text-gray-500"
        }`}
      >
        {met ? "✓" : "—"}
      </span>
      <span className="font-mono text-[11px] text-gray-500">{detail}</span>
    </span>
  );
}

const arrow = (now: number, prev: number) =>
  `${prev.toFixed(1)} → ${now.toFixed(1)}`;

function ScoreBadge({ row }: { row: Ranked }) {
  const tone =
    row.score >= 4
      ? "text-emerald-300"
      : row.score >= 3
        ? "text-cyan-300"
        : row.score >= 2
          ? "text-gray-300"
          : "text-gray-600";
  return (
    <span className={`font-mono text-sm font-bold ${tone}`}>
      {row.score}/{MAX_SCORE}
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

// ==================== Page ====================

export default async function EmaConfluenceScanner() {
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

  const { rows, total, longs, shorts, scanned, medianAtrPercent } = result;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-7xl mx-auto space-y-10">
        <div className="grid items-start gap-6 lg:grid-cols-[16rem_1fr_16rem]">
          <div className="hidden lg:block" aria-hidden="true" />

          <div className="text-center">
            <h1 className="text-5xl font-bold tracking-tight mb-3">
              Binance Futures {INTERVAL_LABEL} EMA Confluence Scanner
            </h1>
            <p className="text-gray-400">
              Price near EMA 50 / 200 • ranked by the previous candle&apos;s KST
              cross, rising RSI, rising ADX, rising open interest and engulfing
              candle • shorts mirrored
            </p>
            <p className="mt-2 text-sm text-gray-500">
              Every reading is on the last closed {INTERVAL_LABEL} candle •
              re-scanned at each close
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

        <div className="bg-gray-900 rounded-3xl shadow-2xl p-8">
          <div className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-2">
            <h2 className="text-3xl font-semibold text-white">👀 Near EMA</h2>
            <span className="rounded-full bg-amber-500/20 px-3 py-1 text-sm font-semibold text-amber-300">
              {total}
            </span>
            <span className="text-sm text-green-400">{longs} long</span>
            <span className="text-sm text-red-400">{shorts} short</span>
            <p className="text-sm text-gray-500">
              Most confirmations first
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
                  <TH>Score</TH>
                  <TH>Near</TH>
                  <TH>KST cross</TH>
                  <TH>RSI</TH>
                  <TH>ADX</TH>
                  <TH>OI</TH>
                  <TH>Engulf</TH>
                  <TH>ATR%</TH>
                  <TH>24h volume</TH>
                  <TH>24h %</TH>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const up = r.side === "LONG";
                  return (
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
                        <ScoreBadge row={r} />
                      </td>
                      <td className="py-4">
                        <NearEma row={r} />
                      </td>
                      <td className="py-4">
                        <CheckCell
                          met={r.checks.kst}
                          detail={`${r.kst.toFixed(2)} / ${r.kstSignal.toFixed(2)}`}
                          title={`KST crossed ${up ? "above" : "below"} its signal on the previous candle`}
                        />
                      </td>
                      <td className="py-4">
                        <CheckCell
                          met={r.checks.rsi}
                          detail={arrow(r.rsi, r.rsiPrev)}
                          title={`RSI(${RSI_LENGTH}) ${up ? "rose" : "fell"} on the previous candle`}
                        />
                      </td>
                      <td className="py-4">
                        <CheckCell
                          met={r.checks.adx}
                          detail={arrow(r.adx, r.adxPrev)}
                          title={`ADX(${ADX_LENGTH}) rose on the previous candle`}
                        />
                      </td>
                      <td className="py-4">
                        <CheckCell
                          met={r.checks.oi}
                          detail={
                            r.oiChange == null
                              ? "n/a"
                              : `${r.oiChange >= 0 ? "+" : ""}${r.oiChange.toFixed(2)}%`
                          }
                          title="Open interest rose over the previous candle — new positions opening"
                        />
                      </td>
                      <td className="py-4">
                        <CheckCell
                          met={r.checks.engulf}
                          detail={up ? "bullish" : "bearish"}
                          title={`${up ? "Bullish" : "Bearish"} engulfing on the previous candle`}
                        />
                      </td>
                      <td
                        className="py-4 font-mono text-xs text-gray-300"
                        title={`ATR(${ATR_LENGTH}) is ${r.tradability.volatilityRatio.toFixed(2)}× the scan median`}
                      >
                        {r.atrPercent.toFixed(2)}%
                      </td>
                      <td className="py-4 font-mono text-xs text-gray-300">
                        {formatVolume(r.volume)}
                      </td>
                      <td className="py-4">
                        <Change value={r.changePercent} />
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={13} className="py-12 text-center text-gray-500">
                      No coin is near EMA 50 / 200 on this close
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-center text-xs text-gray-500">
          Gate: close within {NEAR_ATR} ATR({ATR_LENGTH}) of EMA 50 or EMA 200,
          either side • Score = confirmations on the previous {INTERVAL_LABEL}{" "}
          candle: KST({KST_ROC.join(" ")} / {KST_SMA.join(" ")} / {KST_SIGNAL})
          crossed its signal, RSI({RSI_LENGTH}) moved the trade&apos;s way,
          ADX({ADX_LENGTH}) rose, open interest rose, engulfing candle • Side is
          the majority of KST / engulf / RSI; shorts are the mirror • Ties
          broken by volatility × liquidity (ATR% vs the scan median{" "}
          {medianAtrPercent.toFixed(2)}%, 24h volume) • Breadth = share of
          pairs closing above {INTERVAL_LABEL} EMA {EMA_BREADTH} • Scanned{" "}
          {scanned} perpetuals with 24h quote volume ≥ $
          {(MIN_VOLUME / 1_000_000).toFixed(0)}M • No SL/TP shown by design —
          read the levels off the chart
        </p>
      </div>
    </div>
  );
}
