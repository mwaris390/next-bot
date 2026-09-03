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
  /** Length of the entry candle in ms — one scan fires per close. */
  candleMs: number;
  /** Wait this long past the close so Binance has published the candle. */
  graceMs: number;
  /** Server render time, so we can show when the data was last scanned. */
  scannedAt: number;
}

function msUntilNextClose(
  now: number,
  candleMs: number,
  graceMs: number,
): number {
  return candleMs - (now % candleMs) + graceMs;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
 * Re-scans once per candle, the moment each one closes.
 *
 * The server's klines cache expires on the same boundary, so exactly one scan
 * per candle pulls fresh data and anything more would be served from cache
 * anyway. The timer is scheduled at the boundary and re-armed afterwards
 * rather than polling for the crossing.
 *
 * The scanner's indicators read the still-forming candle (see
 * app/_lib/kst-pullback.ts), so this samples them just after the close and
 * holds that reading for the hour — "Refresh now" re-samples when you want to
 * line the numbers back up with a chart mid-candle.
 */
export default function AutoRefresh({
  candleMs,
  graceMs,
  scannedAt,
}: AutoRefreshProps) {
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
      }, msUntilNextClose(Date.now(), candleMs, graceMs));
    };

    schedule();
    return () => clearTimeout(timer);
  }, [enabled, candleMs, graceMs, refresh]);

  // Derived from the seconds store rather than a fresh `Date.now()`, so the
  // render stays pure and the countdown still ticks once a second.
  const now = nowSeconds == null ? null : nowSeconds * 1000;
  const untilClose =
    now == null ? null : msUntilNextClose(now, candleMs, graceMs);

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
            : untilClose == null
              ? "Next scan at candle close"
              : `Next scan in ${formatCountdown(untilClose)}`}
      </span>

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
