import Link from "next/link";

// One tab per scanner route. Each page renders this with its own `active`, so
// it stays a server component. prefetch is off: each route runs a full Binance
// scan, which should only happen when the tab is actually opened.
const TABS = [
  { href: "/", label: "EMA Zone" },
  { href: "/trend-pullback", label: "Trend Pullback" },
] as const;

export type ScannerTab = (typeof TABS)[number]["href"];

export default function ScannerTabs({ active }: { active: ScannerTab }) {
  return (
    <nav className="flex justify-center">
      <div className="inline-flex gap-1 rounded-full bg-gray-900 p-1">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            prefetch={false}
            aria-current={tab.href === active ? "page" : undefined}
            className={`rounded-full px-5 py-2 text-sm font-semibold transition-colors ${
              tab.href === active
                ? "bg-gray-700 text-white"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
