/* eslint-disable @typescript-eslint/no-explicit-any */
import { KST, EMA, StochasticRSI, sma, sd, atr } from "technicalindicators";

const MAX_CONCURRENT = 12;
const MIN_VOLUME = 1_000_000; // USDT
const MIN_CHANGE_PERCENT = 3;

interface Ticker {
  symbol: string;
  quoteVolume: string;
  priceChangePercent: string;
  lastPrice: string;
  highPrice: string;
  lowPrice: string;
}

interface PairData {
  symbol: string;
  changePercent: number;
  volume: number;
  tickSize: string;
  lastPrice: number;
  highPrice: number;
  lowPrice: number;
}

interface Signal {
  symbol: string;
  strength: number; // KST Gap
  changePercent: string;
  kstGap: string;
  stochK: string;
  ema50: string;
  zScore: string;
  price: string;
  side?: "LONG" | "SHORT";
  stopLoss?: string;
  takeProfit?: string;
  volatility: number;
}
interface PotentialOpportunity {
  symbol: string;
  bias: "BULLISH" | "BEARISH";
  price: string;
  ema50: string;
  distancePercent: string;
  kstGap: string;
  volatility: string;
  changePercent: string;
}

// Helper
function formatPrice(price: number | string, tickSize: string): string {
  const ts = parseFloat(tickSize);
  const decimals = ts >= 1 ? 0 : Math.abs(Math.floor(Math.log10(ts))) || 2;
  return Number(price).toFixed(decimals);
}

// Fetch pairs with volume + change filter
async function getFilteredPairs(): Promise<PairData[]> {
  const [exchangeRes, tickerRes] = await Promise.all([
    fetch("https://fapi.binance.com/fapi/v1/exchangeInfo", {
      cache: "no-store",
    }),
    fetch("https://fapi.binance.com/fapi/v1/ticker/24hr", {
      cache: "no-store",
    }),
  ]);

  const exchange = await exchangeRes.json();
  const tickers: Ticker[] = await tickerRes.json();

  const tickerMap = new Map(tickers.map((t) => [t.symbol, t]));

  const precisionMap = new Map<string, string>();

  return exchange.symbols
    .filter(
      (s: any) =>
        s.contractType === "PERPETUAL" &&
        s.quoteAsset === "USDT" &&
        s.status === "TRADING",
    )
    .map((s: any) => {
      const priceFilter = s.filters?.find(
        (f: any) => f.filterType === "PRICE_FILTER",
      );
      precisionMap.set(s.symbol, priceFilter?.tickSize ?? "0.01");
      return s.symbol;
    })
    .map((symbol: string) => {
      const ticker = tickerMap.get(symbol);
      if (!ticker) return null;

      const volume = parseFloat(ticker.quoteVolume);
      const change = parseFloat(ticker.priceChangePercent || "0");

      if (volume < MIN_VOLUME || Math.abs(change) < MIN_CHANGE_PERCENT) {
        return null;
      }

      return {
        symbol,
        changePercent: change,
        volume,
        tickSize: precisionMap.get(symbol) || "0.01",
        lastPrice: parseFloat(ticker.lastPrice),
        highPrice: parseFloat(ticker.highPrice),
        lowPrice: parseFloat(ticker.lowPrice),
      };
    })
    .filter(Boolean) as PairData[];
}

async function getKlines(symbol: string): Promise<any[]> {
  const res = await fetch(
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=200`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Klines failed for ${symbol}`);
  return res.json();
}

function analyze(
  pair: PairData,
  klines: any[],
): { signal: Signal | null; potential: PotentialOpportunity | null } {
  const closes = klines.map((k: any) => parseFloat(k[4]));
  if (closes.length < 80) return null;

  const price = closes[closes.length - 2];
  const highs = klines.map((k) => parseFloat(k[2]));
  const lows = klines.map((k) => parseFloat(k[3]));
  const lastOpen = parseFloat(klines[klines.length - 2][1]);
  const lastHigh = parseFloat(klines[klines.length - 2][2]);
  const lastLow = parseFloat(klines[klines.length - 2][3]);

  // EMA50
  const ema50Values = EMA.calculate({ period: 50, values: closes });
  const lastEma50 = ema50Values[ema50Values.length - 2];

  // KST
  const kst = KST.calculate({
    values: closes,
    ROCPer1: 8,
    ROCPer2: 13,
    ROCPer3: 15,
    ROCPer4: 25,
    SMAROCPer1: 8,
    SMAROCPer2: 8,
    SMAROCPer3: 8,
    SMAROCPer4: 12,
    signalPeriod: 7,
  });

  if (kst.length < 3) return null;

  const lastKST = kst[kst.length - 2];
  const prevKST = kst[kst.length - 3];
  const kstGap = Math.abs(lastKST.kst - lastKST.signal);

  const kstCrossover =
    prevKST.kst <= prevKST.signal && lastKST.kst > lastKST.signal;
  const kstCrossunder =
    prevKST.kst >= prevKST.signal && lastKST.kst < lastKST.signal;

  // StochRSI
  const stochRSI = StochasticRSI.calculate({
    values: closes,
    rsiPeriod: 14,
    stochasticPeriod: 14,
    kPeriod: 3,
    dPeriod: 3,
  });
  const lastStochK = stochRSI[stochRSI.length - 2]?.k ?? 50;

  // Z-Score
  const zLength = 20;
  const priceMean = sma({ values: closes, period: zLength });
  const priceMeanLast = priceMean[priceMean.length - 2];
  const priceStd = sd({ values: closes, period: zLength });
  const priceStdLast = priceStd[priceStd.length - 2];
  const zScore = (price - priceMeanLast) / priceStdLast;

  // const atrPeriod = 14;
  // let atr = 0;
  // for (let i = closes.length - atrPeriod - 1; i < closes.length - 1; i++) {
  //   const tr = Math.max(
  //     parseFloat(klines[i][2]) - parseFloat(klines[i][3]),
  //     Math.abs(parseFloat(klines[i][2]) - parseFloat(klines[i - 1][4])),
  //     Math.abs(parseFloat(klines[i][3]) - parseFloat(klines[i - 1][4])),
  //   );
  //   atr += tr;
  // }
  // atr = atr / atrPeriod;
  // ATR
  const lastAtr = atr({
    period: 14,
    high: highs,
    low: lows,
    close: closes,
  }).at(-2);

  const atrUpper = price + lastAtr * 2;
  const atrLower = price - lastAtr * 2;

  const volatility = lastAtr / price;

  const rr = volatility > 0.01 ? 1.2 : 1.2;

  let signal: Signal | null = null;

  if (
    kstCrossover &&
    kstGap > 0.5 &&
    lastStochK < 65 &&
    price > lastEma50 &&
    zScore > 0
  ) {
    const risk = price - atrLower;
    signal = {
      symbol: pair.symbol,
      side: "LONG",
      strength: kstGap,
      changePercent: pair.changePercent.toFixed(2),
      kstGap: kstGap.toFixed(3),
      stochK: lastStochK.toFixed(2),
      ema50: lastEma50.toFixed(4),
      zScore: zScore.toFixed(3),
      price: formatPrice(price, pair.tickSize),
      stopLoss: formatPrice(
        atrLower >= lastLow ? lastLow : atrLower,
        pair.tickSize,
      ),
      takeProfit: formatPrice(price + risk * rr, pair.tickSize),
      volatility: volatility,
    };
  } else if (
    kstCrossunder &&
    kstGap > 0.5 &&
    lastStochK > 45 &&
    price < lastEma50 &&
    zScore < 0
  ) {
    const risk = price - atrUpper;
    signal = {
      symbol: pair.symbol,
      side: "SHORT",
      strength: kstGap,
      changePercent: pair.changePercent.toFixed(2),
      kstGap: kstGap.toFixed(3),
      stochK: lastStochK.toFixed(2),
      ema50: lastEma50.toFixed(4),
      zScore: zScore.toFixed(3),
      price: formatPrice(price, pair.tickSize),
      stopLoss: formatPrice(
        atrUpper <= lastHigh ? lastHigh : atrUpper,
        pair.tickSize,
      ),
      takeProfit: formatPrice(price - risk * rr, pair.tickSize),
      volatility: volatility,
    };
  }

  // ==================== Potential Opportunity ====================
  let potential: PotentialOpportunity | null = null;
  const distancePercent = Math.abs((price - lastEma50) / lastEma50) * 100;

  const isBullishKST = lastKST.kst > lastKST.signal && price > lastEma50;
  const isBearishKST = lastKST.kst < lastKST.signal && price < lastEma50;

  if (distancePercent <= 1) {
    if (isBullishKST) {
      potential = {
        symbol: pair.symbol,
        bias: "BULLISH",
        price: formatPrice(price, pair.tickSize),
        ema50: lastEma50.toFixed(4),
        distancePercent: distancePercent.toFixed(2),
        kstGap: kstGap.toFixed(3),
        volatility: volatility.toFixed(2),
        changePercent: pair.changePercent.toFixed(2),
      };
    } else if (isBearishKST) {
      potential = {
        symbol: pair.symbol,
        bias: "BEARISH",
        price: formatPrice(price, pair.tickSize),
        ema50: lastEma50.toFixed(4),
        distancePercent: distancePercent.toFixed(2),
        kstGap: kstGap.toFixed(3),
        volatility: volatility.toFixed(2),
        changePercent: pair.changePercent.toFixed(2),
      };
    }
  }

  return { signal, potential };
}

async function scan(): Promise<{
  strongSignals: Signal[] | null;
  potentials: PotentialOpportunity[] | null;
}> {
  const pairs = await getFilteredPairs();
  // const results: Signal[] = [];
  const strongSignals: Signal[] = [];
  const potentials: PotentialOpportunity[] = [];

  for (let i = 0; i < pairs.length; i += MAX_CONCURRENT) {
    const chunk = pairs.slice(i, i + MAX_CONCURRENT);

    const chunkPromises = chunk.map(async (pair) => {
      try {
        const klines = await getKlines(pair.symbol);
        return analyze(pair, klines);
      } catch (error) {
        console.log("scan error", error);
        return { signal: null, potential: null };
      }
    });
    const results = await Promise.all(chunkPromises);
    // console.log(results);

    for (const res of results) {
      if (res?.signal) strongSignals.push(res.signal);
      if (res?.potential) potentials.push(res.potential);
    }
  }

  return {
    strongSignals: strongSignals.sort((a, b) => b.strength - a.strength),
    potentials: potentials.sort(
      (a, b) => parseFloat(b.volatility) - parseFloat(a.volatility),
    ),
  };
}

export default async function BinanceFuturesScanner() {
  let strongSignals: Signal[] = [];
  let potentials: PotentialOpportunity[] = [];
  try {
    const data = await scan();
    strongSignals = data.strongSignals;
    potentials = data.potentials;
  } catch (error) {
    console.log("signals", error);
    return (
      <div className="min-h-screen bg-gray-950 text-red-400 flex items-center justify-center p-10">
        <div className="text-center">
          <h2 className="text-2xl mb-4">Failed to load scanner</h2>
          <p>Please refresh the page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-7xl mx-auto space-y-16">
        <div className="text-center">
          <h1 className="text-5xl font-bold tracking-tight mb-3">
            Binance USDT Futures Scanner
          </h1>
          <p className="text-gray-400">
            1H • KST + StochRSI • Combined Analysis
          </p>
        </div>

        {/* Strong Signals */}
        <div className="bg-gray-900 rounded-3xl shadow-2xl p-8">
          <h2 className="text-3xl font-semibold mb-6 text-white flex items-center gap-3">
            🔥 Strong Confirmed Signals
          </h2>
          {/* Table code same as previous response - omitted for brevity, but you can copy from last message */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-gray-400 border-b border-gray-700">
                <tr>
                  <th className="text-left py-4">Rank</th>
                  <th className="text-left py-4">Pair</th>
                  <th className="text-left py-4">Direction</th>
                  <th className="text-left py-4">Price</th>
                  <th className="text-left py-4">24h %</th>
                  <th className="text-left py-4">KST Gap</th>
                  <th className="text-left py-4">Stoch %K</th>
                  <th className="text-left py-4">Z-Score</th>
                  <th className="text-left py-4">SL</th>
                  <th className="text-left py-4">TP</th>
                </tr>
              </thead>
              <tbody>
                {strongSignals.map((s, i) => (
                  <tr
                    key={s.symbol}
                    className="border-b border-gray-800 hover:bg-gray-800/70 transition-colors"
                  >
                    <td className="py-4">{i + 1}</td>
                    <td className="py-4 font-semibold">{s.symbol}</td>
                    <td className="py-4">
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-bold ${s.side === "LONG" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}
                      >
                        {s.side}
                      </span>
                    </td>
                    <td className="py-4 font-mono">{s.price}</td>
                    <td
                      className={`py-4 font-medium ${s.side === "LONG" ? "text-green-400" : "text-red-400"}`}
                    >
                      {s.side === "LONG" ? "+" : ""}
                      {s.changePercent}%
                    </td>
                    <td className="py-4 font-medium">{s.kstGap}</td>
                    <td className="py-4">{s.stochK}</td>
                    <td className="py-4">{s.zScore}</td>
                    <td className="py-4 text-orange-400">{s.stopLoss}</td>
                    <td className="py-4 text-emerald-400">{s.takeProfit}</td>
                  </tr>
                ))}
                {strongSignals.length === 0 && (
                  <tr>
                    <td
                      colSpan={10}
                      className="py-12 text-center text-gray-500"
                    >
                      No strong signals currently
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Potential Opportunities */}
        <div className="bg-gray-900 rounded-3xl shadow-2xl p-8">
          <h2 className="text-3xl font-semibold mb-6 text-amber-400 flex items-center gap-3">
            ⭐ Potential Opportunities (Near EMA50)
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-gray-400 border-b border-gray-700">
                <tr>
                  <th className="text-left py-4">Rank</th>
                  <th className="text-left py-4">Pair</th>
                  <th className="text-left py-4">Bias</th>
                  <th className="text-left py-4">Price</th>
                  <th className="text-left py-4">EMA50</th>
                  <th className="text-left py-4">Distance</th>
                  <th className="text-left py-4">KST Gap</th>
                  <th className="text-left py-4">Volatility %</th>
                  <th className="text-left py-4">24h %</th>
                </tr>
              </thead>
              <tbody>
                {potentials.map((p, i) => (
                  <tr
                    key={p.symbol}
                    className="border-b border-gray-800 hover:bg-gray-800/70 transition-colors"
                  >
                    <td className="py-4">{i + 1}</td>
                    <td className="py-4 font-semibold">{p.symbol}</td>
                    <td className="py-4">
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-bold ${p.bias === "BULLISH" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}
                      >
                        {p.bias}
                      </span>
                    </td>
                    <td className="py-4 font-mono">{p.price}</td>
                    <td className="py-4 text-gray-300">{p.ema50}</td>
                    <td className="py-4 text-amber-400">
                      {p.distancePercent}%
                    </td>
                    <td className="py-4">{p.kstGap}</td>
                    <td className="py-4 font-medium text-purple-400">
                      {p.volatility}%
                    </td>
                    <td className="py-4">{p.changePercent}%</td>
                  </tr>
                ))}
                {potentials.length === 0 && (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-gray-500">
                      No potential opportunities near EMA50 right now
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-center text-xs text-gray-500">
          Potential Opportunities: Price within 1.8% of EMA50 + KST bias +
          Volatility ≥ 0.8%
        </p>
      </div>
    </div>
  );
}
