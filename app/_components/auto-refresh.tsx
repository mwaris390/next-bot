"use client";

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";

interface AutoRefreshProps {
  /** Length of the entry candle in ms — what the structure half waits for. */
  candleMs: number;
  /**
   * How often to re-scan, when that is shorter than a candle. On a 4h chart
   * the live indicators would otherwise sit four hours stale, so the page
   * re-samples inside the candle; it must divide `candleMs` so that every
   * close is also a sample boundary. Defaults to one scan per candle.
   */
  sampleMs?: number;
  /** Wait this long past the boundary so Binance has published the candle. */
  graceMs: number;
  /** Server render time, so we can show when the data was last scanned. */
  scannedAt: number;
}

function msUntilNextBoundary(
  now: number,
  periodMs: number,
  graceMs: number,
): number {
  return periodMs - (now % periodMs) + graceMs;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** "4h" / "1h" / "15m" — the candle length, for the close countdown's label. */
function candleLabel(candleMs: number): string {
  const minutes = Math.round(candleMs / 60_000);
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

// A one-second clock modelled as an external store. Reading the time this way
// (rather than setState-in-an-effect) keeps the component pure and lets the
// server render a placeholder instead of a time that won't survive hydration.
function subscribeToSeconds(onChange: () => void): () => void {
  const id = setInterval(onChange, 1000);
  return () => clearInterval(id);
}

function getSecondsSnapshot(): number {
  return Math.floor(Date.now() / 1000);
}

function getServerSecondsSnapshot(): null {
  return null;
}

/**
 * Re-scans on every sample boundary — which, when `sampleMs` is a whole
 * division of `candleMs`, includes each candle close.
 *
 * The server's klines cache expires on the same boundary, so one scan per
 * boundary pulls fresh data and anything in between is served from cache
 * anyway. The timer is scheduled at the boundary and re-armed afterwards
 * rather than polling for the crossing.
 *
 * The watchlist reads closed candles only (see app/_lib/ema-zone.ts), so
 * it omits `sampleMs` and scans once per close. `sampleMs` stays for a scanner
 * whose indicators read the still-forming candle. "Refresh now" re-reads on
 * demand.
 */
export default function AutoRefresh({
  candleMs,
  sampleMs,
  graceMs,
  scannedAt,
}: AutoRefreshProps) {
  const scanMs = sampleMs ?? candleMs;
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);

  // `isPending` stays true for the whole round trip, so it doubles as the
  // "scan running" indicator without any extra state to reset.
  const [isRefreshing, startRefresh] = useTransition();

  const nowSeconds = useSyncExternalStore(
    subscribeToSeconds,
    getSecondsSnapshot,
    getServerSecondsSnapshot,
  );

  const refresh = useCallback(() => {
    startRefresh(() => router.refresh());
  }, [router]);

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        refresh();
        schedule();
      }, msUntilNextBoundary(Date.now(), scanMs, graceMs));
    };

    schedule();
    return () => clearTimeout(timer);
  }, [enabled, scanMs, graceMs, refresh]);

  // Derived from the seconds store rather than a fresh `Date.now()`, so the
  // render stays pure and the countdown still ticks once a second.
  const now = nowSeconds == null ? null : nowSeconds * 1000;
  const untilScan =
    now == null ? null : msUntilNextBoundary(now, scanMs, graceMs);
  // Only worth showing when a scan is not the same event as a close: it is the
  // clock the structure half of the table actually waits on.
  const untilClose =
    now == null || scanMs >= candleMs
      ? null
      : msUntilNextBoundary(now, candleMs, graceMs);

  return (
    <div className="mt-5 flex flex-wrap items-center justify-center gap-3 text-sm">
      <button
        type="button"
        onClick={() => setEnabled((on) => !on)}
        className={`rounded-full px-4 py-2 font-medium transition-colors ${
          enabled
            ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
            : "bg-gray-800 text-gray-400 hover:bg-gray-700"
        }`}
      >
        {enabled ? "● Auto-scan ON" : "○ Auto-scan OFF"}
      </button>

      <span className="text-gray-500">
        {isRefreshing
          ? "Scanning…"
          : !enabled
            ? "Paused"
            : untilScan == null
              ? "Next scan at the sample boundary"
              : `Next scan in ${formatCountdown(untilScan)}`}
      </span>

      {untilClose != null && (
        <span className="text-gray-600">
          {candleLabel(candleMs)} close in {formatCountdown(untilClose)}
        </span>
      )}

      <button
        type="button"
        onClick={refresh}
        disabled={isRefreshing}
        className="rounded-full bg-gray-800 px-4 py-2 text-gray-300 transition-colors hover:bg-gray-700 disabled:opacity-50"
      >
        Refresh now
      </button>

      {nowSeconds != null && (
        <span className="text-gray-600">
          Scanned {new Date(scannedAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}
