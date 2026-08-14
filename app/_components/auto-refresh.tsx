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
  /** Length of the entry candle in ms — refresh fires when one closes. */
  candleMs: number;
  /** Wait this long past the close so Binance has published the candle. */
  graceMs: number;
  /** Server render time, so we can show when the data was last scanned. */
  scannedAt: number;
}

function msUntilNextClose(candleMs: number, graceMs: number): number {
  const now = Date.now();
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
 * Re-renders the scanner the moment each entry candle closes. The server's
 * klines cache expires on the same boundary, so exactly one refresh per candle
 * pulls fresh data — anything more would be served from cache anyway.
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

  // Fire once per candle close by scheduling the timer at the exact boundary
  // and re-arming it afterwards, instead of polling for the crossing.
  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        refresh();
        schedule();
      }, msUntilNextClose(candleMs, graceMs));
    };

    schedule();
    return () => clearTimeout(timer);
  }, [enabled, candleMs, graceMs, refresh]);

  const remaining =
    nowSeconds == null ? null : msUntilNextClose(candleMs, graceMs);

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
        {enabled ? "● Auto-refresh ON" : "○ Auto-refresh OFF"}
      </button>

      <span className="text-gray-500">
        {isRefreshing
          ? "Scanning…"
          : !enabled
            ? "Paused"
            : remaining == null
              ? "Next candle in —:—"
              : `Next candle in ${formatCountdown(remaining)}`}
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
