/* eslint-disable @typescript-eslint/no-explicit-any */
import { atr, sma } from "technicalindicators";
import { unstable_rethrow } from "next/navigation";
import AutoRefresh from "./_components/auto-refresh";
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
import {
  BB_LENGTH,
  BB_STDDEV,
  BREAKOUT_WINDOW,
  EXTREME_PERCENTILE,
  MIN_SQUEEZE_BARS,
  PERCENTILE_LOOKBACK,
  SQUEEZE_PERCENTILE,
  type SqueezePhase,
  closedCandles,
  replaySqueeze,
} from "./_lib/squeeze";

// One timeframe for everything. The squeeze, its percentile ranking, the
// breakout window and the context indicators all read the same 30m series.
const INTERVAL = "30m";
const CANDLE_MS = 30 * 60_000;
// 500 = weight 2 on fapi klines and ~10 days of 30m candles. The percentile
// warm-up swallows the first 261 bars, leaving ~238 bars of live state — far
// more than the longest coil plus its breakout window needs.
const KLINE_LIMIT = 500;

const ATR_PERIOD = 14; // context only — sizes the move a breakout can travel
const VOLUME_MA_LENGTH = 20; // context only — RVOL confirms the release
const HIGH_RVOL = 1.5; // highlight threshold, never a filter

// One klines call per pair now (the old 5m + 1h scanner cost two), so the
// burst can be wider without moving the weight needle.
const MAX_CONCURRENT = 10;
const BATCH_DELAY_MS = 120;

// Percentile rank is measured per symbol against its own recent history, so
// the size of the squeeze list moves with the volatility regime rather than
// staying near a fixed count. Cap the table and report the overflow instead of
// rendering the whole universe on a quiet weekend.
const SQUEEZE_DISPLAY_LIMIT = 30;

// ==================== Rate-limit protection ====================
// Binance fapi allows 2400 request-weight/min per IP, shared across every
// scanner page (see ./_lib/binance). A fully cold scan is ~200 eligible pairs
// x 2 weight + 41 for exchangeInfo/ticker, i.e. ~440/min — and because 30m
// klines only change twice an hour, a warm page costs nothing at all.
// Defences, in order:
//   1. klines are cached until the 30m candle actually closes, so refreshing
//      inside a candle issues zero requests;
//   2. batches are staggered;
//   3. the X-MBX-USED-WEIGHT-1M header is read on every response and we idle
//      when it climbs toward the cap;
//   4. a 429/418 puts every caller into a cooldown that serves stale cache
//      instead of hammering the endpoint into an IP ban.

interface ScanRow {
  symbol: string;
  phase: SqueezePhase;
  side?: "LONG" | "SHORT";
  price: string;
  /** Bandwidth percentile — lower is tighter. */
  rank: number;
  bandwidth: number;
  /** Bars the coil lasted. */
  coilBars: number;
  /** ARMED only — bars before the setup expires. */
  barsLeft?: number;
  breakoutHigh?: string;
  breakoutLow?: string;
  /** Momentum as a percent of price, so it compares across symbols. */
  momentumPercent: number;
  rvol: number;
  atrPercent: number;
  changePercent: number;
}

// ==================== Analysis ====================

function analyze(pair: PairData, klines: any[]): ScanRow | null {
  // Strip the still-forming candle once, then everything reads index -1.
  const closed = closedCandles(klines);

  const state = replaySqueeze(closed);
  if (!state || state.phase === "NEUTRAL") return null;

  const closes = closed.map((k: any) => parseFloat(k[4]));
  const highs = closed.map((k: any) => parseFloat(k[2]));
  const lows = closed.map((k: any) => parseFloat(k[3]));
  const volumes = closed.map((k: any) => parseFloat(k[5]));

  const price = closes.at(-1)!;

  const lastAtr = atr({
    period: ATR_PERIOD,
    high: highs,
    low: lows,
    close: closes,
  }).at(-1);
  if (lastAtr == null) return null;

  // Relative volume against the trailing average. Per the Pine original's
  // `useVol = false` default this is a bonus indicator, never a gate — a
  // breakout on heavy volume is worth more attention, but a quiet one is
  // still a breakout.
  const volumeAverage = sma({ values: volumes, period: VOLUME_MA_LENGTH }).at(-1);
  const rvol =
    volumeAverage != null && volumeAverage !== 0
      ? volumes.at(-1)! / volumeAverage
      : 0;

  return {
    symbol: pair.symbol,
    phase: state.phase,
    side: state.side,
    price: formatPrice(price, pair.tickSize),
    rank: state.rank,
    bandwidth: state.bandwidth,
    coilBars: state.squeezeBars,
    barsLeft: state.barsLeft,
    breakoutHigh:
      state.boHi != null ? formatPrice(state.boHi, pair.tickSize) : undefined,
    breakoutLow:
      state.boLo != null ? formatPrice(state.boLo, pair.tickSize) : undefined,
    momentumPercent: (state.momentum / price) * 100,
    rvol,
    atrPercent: (lastAtr / price) * 100,
    changePercent: pair.changePercent,
  };
}

// ==================== Scan (concurrent batches) ====================

interface ScanResult {
  fired: ScanRow[];
  armed: ScanRow[];
  squeezed: ScanRow[];
  squeezedTotal: number;
  scanned: number;
  rateLimited: boolean;
  scannedAt: number;
}

// A longer coil stores more energy than a short one, so it leads; heavy volume
// breaks the tie.
const byCoilThenVolume = (a: ScanRow, b: ScanRow) =>
  b.coilBars - a.coilBars || b.rvol - a.rvol;

async function scan(): Promise<ScanResult> {
  const pairs = await getFilteredPairs();
  const rows: ScanRow[] = [];
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
            CANDLE_MS,
          );
          return analyze(pair, klines);
        } catch (error) {
          if (error instanceof RateLimitedError) rateLimited = true;
          else console.log("scan error", pair.symbol, error);
          return null;
        }
      }),
    );

    for (const row of results) {
      if (row) rows.push(row);
    }

    // Stagger batches so a cold cache doesn't burst-fire every klines request
    // at once and trip Binance's request-weight limiter.
    if (willHitNetwork && i + MAX_CONCURRENT < pairs.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  const fired = rows.filter((r) => r.phase === "FIRED").sort(byCoilThenVolume);
  const armed = rows.filter((r) => r.phase === "ARMED").sort(byCoilThenVolume);
  const squeezed = rows
    .filter((r) => r.phase === "SQUEEZE" || r.phase === "EXTREME")
    .sort((a, b) => a.rank - b.rank || b.rvol - a.rvol);

  return {
    fired,
    armed,
    squeezed: squeezed.slice(0, SQUEEZE_DISPLAY_LIMIT),
    squeezedTotal: squeezed.length,
    scanned: pairs.length,
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

function Rvol({ value }: { value: number }) {
  // Highlighted, not filtered — see the note in `analyze`.
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

function Momentum({ value }: { value: number }) {
  return (
    <span className={`font-medium ${value > 0 ? "text-green-400" : "text-red-400"}`}>
      {value > 0 ? "▲" : "▼"} {Math.abs(value).toFixed(2)}%
    </span>
  );
}

const rowClass =
  "border-b border-gray-800 hover:bg-gray-800/70 transition-colors";
const emptyClass = "py-12 text-center text-gray-500";

// ==================== Page ====================

export default async function BollingerSqueezeScanner() {
  let result: ScanResult;

  try {
    result = await scan();
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

  const { fired, armed, squeezed, squeezedTotal, scanned } = result;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-7xl mx-auto space-y-10">
        <div className="text-center">
          <h1 className="text-5xl font-bold tracking-tight mb-3">
            Binance Futures 30M Squeeze Scanner
          </h1>
          <p className="text-gray-400">
            Bollinger bandwidth ≤ {SQUEEZE_PERCENTILE}th percentile of the last{" "}
            {PERCENTILE_LOOKBACK} bars • {MIN_SQUEEZE_BARS}-bar minimum coil •{" "}
            {BREAKOUT_WINDOW}-bar breakout window
          </p>
          <AutoRefresh
            candleMs={CANDLE_MS}
            graceMs={CANDLE_CACHE_GRACE_MS}
            scannedAt={result.scannedAt}
          />
          {result.rateLimited && (
            <p className="mt-4 inline-block rounded-full bg-amber-500/15 px-4 py-2 text-sm text-amber-400">
              ⚠️ Binance rate limit reached — some pairs were served from cache
              or skipped. Refresh in a minute for a full scan.
            </p>
          )}
        </div>

        {/* Stage 3 — resolved this bar */}
        <Section
          icon="🔥"
          title="Breakout Fired"
          count={fired.length}
          accent="bg-emerald-500/20 text-emerald-300"
          caption="close broke the coil on the last closed 30m candle, momentum agreeing"
        >
          <table className="w-full text-sm">
            <thead className="text-gray-400 border-b border-gray-700">
              <tr>
                <TH>#</TH>
                <TH>Pair</TH>
                <TH>Side</TH>
                <TH>Price</TH>
                <TH>Broke</TH>
                <TH>Coil</TH>
                <TH>Momentum</TH>
                <TH>RVOL</TH>
                <TH>ATR%</TH>
                <TH>24h %</TH>
              </tr>
            </thead>
            <tbody>
              {fired.map((s, i) => (
                <tr key={s.symbol} className={rowClass}>
                  <td className="py-4">{i + 1}</td>
                  <td className="py-4 font-semibold">{s.symbol}</td>
                  <td className="py-4">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-bold ${
                        s.side === "LONG"
                          ? "bg-green-500/20 text-green-400"
                          : "bg-red-500/20 text-red-400"
                      }`}
                    >
                      {s.side}
                    </span>
                  </td>
                  <td className="py-4 font-mono">{s.price}</td>
                  <td className="py-4 font-mono text-cyan-400">
                    {s.side === "LONG" ? s.breakoutHigh : s.breakoutLow}
                  </td>
                  <td className="py-4 text-gray-300">{s.coilBars} bars</td>
                  <td className="py-4">
                    <Momentum value={s.momentumPercent} />
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
              {fired.length === 0 && (
                <tr>
                  <td colSpan={10} className={emptyClass}>
                    No breakout on the last closed 30m candle
                    {armed.length > 0
                      ? ` — ${armed.length} setup${armed.length === 1 ? " is" : "s are"} armed and waiting below`
                      : ""}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Section>

        {/* Stage 2 — coil released, levels live */}
        <Section
          icon="⚡"
          title="Armed"
          count={armed.length}
          accent="bg-amber-500/20 text-amber-300"
          caption="coil released after enough bars — these levels are live until the window expires"
        >
          <table className="w-full text-sm">
            <thead className="text-gray-400 border-b border-gray-700">
              <tr>
                <TH>#</TH>
                <TH>Pair</TH>
                <TH>Price</TH>
                <TH>Trigger ↑</TH>
                <TH>Trigger ↓</TH>
                <TH>Expires</TH>
                <TH>Coil</TH>
                <TH>Bias</TH>
                <TH>RVOL</TH>
                <TH>ATR%</TH>
                <TH>24h %</TH>
              </tr>
            </thead>
            <tbody>
              {armed.map((s, i) => (
                <tr key={s.symbol} className={rowClass}>
                  <td className="py-4">{i + 1}</td>
                  <td className="py-4 font-semibold">{s.symbol}</td>
                  <td className="py-4 font-mono">{s.price}</td>
                  <td className="py-4 font-mono text-green-400">
                    {s.breakoutHigh}
                  </td>
                  <td className="py-4 font-mono text-red-400">
                    {s.breakoutLow}
                  </td>
                  <td className="py-4 text-amber-300">
                    {s.barsLeft} bar{s.barsLeft === 1 ? "" : "s"}
                  </td>
                  <td className="py-4 text-gray-300">{s.coilBars} bars</td>
                  <td className="py-4">
                    <Momentum value={s.momentumPercent} />
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
              {armed.length === 0 && (
                <tr>
                  <td colSpan={11} className={emptyClass}>
                    No live setups — a coil has to release after ≥{" "}
                    {MIN_SQUEEZE_BARS} bars to arm one
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Section>

        {/* Stage 1 — still compressing */}
        <Section
          icon="🟡"
          title="In Squeeze"
          count={squeezedTotal}
          accent="bg-yellow-500/20 text-yellow-300"
          caption={
            squeezedTotal > squeezed.length
              ? `still compressing — tightest ${squeezed.length} of ${squeezedTotal} shown`
              : "still compressing — nothing to trade yet, this is the watchlist"
          }
        >
          <table className="w-full text-sm">
            <thead className="text-gray-400 border-b border-gray-700">
              <tr>
                <TH>#</TH>
                <TH>Pair</TH>
                <TH>Price</TH>
                <TH>Rank</TH>
                <TH>Bandwidth</TH>
                <TH>Coil</TH>
                <TH>RVOL</TH>
                <TH>ATR%</TH>
                <TH>24h %</TH>
              </tr>
            </thead>
            <tbody>
              {squeezed.map((s, i) => (
                <tr key={s.symbol} className={rowClass}>
                  <td className="py-4">{i + 1}</td>
                  <td className="py-4 font-semibold">
                    <span className="flex items-center gap-2">
                      {s.symbol}
                      {s.phase === "EXTREME" && (
                        <span className="rounded-full bg-orange-500/20 px-2 py-0.5 text-[10px] font-bold text-orange-300">
                          EXTREME
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="py-4 font-mono">{s.price}</td>
                  <td
                    className={`py-4 font-medium ${
                      s.phase === "EXTREME" ? "text-orange-400" : "text-yellow-400"
                    }`}
                  >
                    {s.rank.toFixed(1)}%
                  </td>
                  <td className="py-4 font-mono text-gray-300">
                    {s.bandwidth.toFixed(3)}%
                  </td>
                  <td className="py-4 text-gray-300">{s.coilBars} bars</td>
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
              {squeezed.length === 0 && (
                <tr>
                  <td colSpan={9} className={emptyClass}>
                    Nothing in compression right now
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Section>

        <p className="text-center text-xs text-gray-500">
          Closed 30M candles only, never the forming one • Squeeze = BB(
          {BB_LENGTH}, {BB_STDDEV}) bandwidth ranked in the bottom{" "}
          {SQUEEZE_PERCENTILE}% of the previous {PERCENTILE_LOOKBACK} bars (
          {EXTREME_PERCENTILE}% = EXTREME) • A coil of ≥ {MIN_SQUEEZE_BARS} bars
          that releases arms its high/low as breakout levels for{" "}
          {BREAKOUT_WINDOW} bars • FIRED = close beyond a level with momentum
          agreeing; re-entering compression voids the setup • Scanned {scanned}{" "}
          perpetuals with 24h quote volume ≥ $
          {(MIN_VOLUME / 1_000_000).toFixed(0)}M • RVOL and ATR% are context
          only, never filters • No SL/TP shown by design — read the levels off
          the chart
        </p>
      </div>
    </div>
  );
}
