# Prompt: Backtest the "5M VWAP Cross" Binance futures strategy in Python

Build a historical backtest, in Python, of the intraday strategy specified below. The
strategy currently exists only as a live scanner; I need to know whether it actually has
an edge before trading it. Treat the spec as exact — reproduce the indicator semantics
literally, then tell me honestly what the numbers say.

---

## 1. Market & universe

- Exchange: **Binance USDT-M perpetual futures** (`https://fapi.binance.com`).
- Universe: symbols where `contractType == "PERPETUAL"`, `quoteAsset == "USDT"`,
  `status == "TRADING"`, and 24h quote volume ≥ **$5,000,000**.
- Everything is UTC. No timezone conversion anywhere.

**Survivorship bias warning:** the live scanner filters on *today's* volume and *today's*
listed symbols. Do not apply today's list to 2023 data as-is. Either (a) derive each
symbol's listing date from its first available kline and only trade it after it exists,
and recompute the ≥$5M volume filter on a rolling 24h basis *as of each bar*, or (b) if
you use a static list, state the bias explicitly in the report and quantify it by
re-running on a list frozen at the start of the test window.

## 2. Data

- 5m klines (entry timeframe) and 1h klines (trend timeframe) per symbol.
- `GET /fapi/v1/klines?symbol=&interval=&limit=1500&startTime=` — paginate forward on
  `startTime`, respect the request-weight limit (weight 10 at limit 1500; 2400/min per
  IP), back off on 429/418.
- Default window: **last 18–24 months**, or as much history as exists per symbol.
- Cache raw klines to disk (parquet, one file per symbol/interval) so re-runs are free.
- Validate on load: strictly increasing open times, no duplicates, and **detect gaps** —
  a missing 5m bar must break VWAP/indicator continuity rather than be silently bridged.
- Kline columns: `open_time, open, high, low, close, volume, close_time, quote_volume, ...`.
  All prices/volumes to float.

## 3. Indicators — replicate these exactly

The live scanner uses the JS `technicalindicators` library. Match its semantics; if you
use `pandas_ta`/`talib`, verify agreement on a sample symbol and report any drift.

| Indicator | Timeframe | Definition |
|---|---|---|
| Session VWAP | 5m | Cumulative `Σ(typical_price × volume) / Σ(volume)`, `typical = (H+L+C)/3`, **re-anchored at every UTC midnight**. |
| EMA(50) | **1h** | EMA of 1h closes. `technicalindicators` seeds the EMA with the SMA of the first 50 values — replicate that seeding. |
| ADX / +DI / −DI | 5m | Wilder ADX, period 14. |
| ATR | 5m | Wilder ATR, period 14. `atr_pct = atr / close × 100`. |
| RSI | 5m and 1h | Wilder RSI, period 14. **Context only — never a gate.** Record it on every trade so I can test it as a filter later. |
| Volume SMA(20) | 5m | Simple mean of the last 20 5m volumes, **inclusive of the signal candle**. `rvol = candle_volume / volume_sma20`. |

**Causality rules (critical):**

- Signals are evaluated **once per closed 5m candle**. The live scanner reads index `-2`
  of a series whose index `-1` is the still-forming candle — i.e. it always trades off the
  **last fully closed** 5m candle. Never let a forming candle leak in.
- The 1h EMA50 value used at 5m bar *t* must come from the **last 1h candle that closed
  strictly before bar t's close time**. Do not forward-fill the in-progress hour. Get this
  wrong and you get lookahead that will flatter the results.
- VWAP is naturally causal (cumulative), but at each UTC rollover require at least
  **2 candles into the session** before any signal — with one candle, VWAP is just that
  candle's typical price and a "cross" is meaningless.

## 4. Signal rules

Let `close_t` / `vwap_t` be the last closed 5m candle, `close_{t-1}` / `vwap_{t-1}` the one before.

**Tradability gate (both sides must pass first):**
```
rvol >= 1.0
0.05 <= atr_pct <= 2.0
```

**LONG:**
```
close_{t-1} <= vwap_{t-1}  and  close_t > vwap_t     # cross above session VWAP
close_t > ema50_1h                                    # 1h trend filter
plus_di > minus_di
adx >= 20
```

**SHORT:** mirror — `close_{t-1} >= vwap_{t-1} and close_t < vwap_t`, `close_t < ema50_1h`,
`minus_di > plus_di`, `adx >= 20`.

**Exits (bracket, fixed at entry):**
```
risk       = 2.0 × atr_t
LONG :  SL = entry - risk ,  TP = entry + 1.5 × risk
SHORT:  SL = entry + risk ,  TP = entry - 1.5 × risk
```
Reward:risk is 1.5, so break-even win rate before costs is 40%. Say plainly whether the
strategy clears it.

Ignore the scanner's "Opportunities" watchlist — it is not a trade.

## 5. Execution model

- **Fill:** the scanner computes SL/TP off the signal candle's *close*, but that close is
  already in the past when the signal fires. Model the realistic case — enter at the
  **next 5m candle's open** — and also run the optimistic **signal-close fill** as a
  comparison. Report both; the gap between them is a direct measure of how fragile the
  edge is.
- **Intrabar SL/TP ambiguity:** if a candle's range touches both SL and TP, assume
  **SL first** (conservative). Additionally, resolve a sample of these bars with 1m klines
  and report how much the assumption actually costs.
- **Costs:** taker fee **0.05% per side** (parameterize; note VIP/BNB discounts),
  slippage **1–2 bps** on entry and exit (parameterize), and **funding** at 00:00/08:00/16:00
  UTC for any position open across the mark — pull real funding rates from
  `/fapi/v1/fundingRate` rather than assuming a constant.
- **Sizing:** fixed-fractional — risk **1% of current equity** per trade, position size
  derived from the SL distance. Starting equity $10,000. Also report a flat-notional
  variant so results aren't purely a compounding artifact.
- **Portfolio constraints:** one open position per symbol; cap concurrent positions
  (default 5) and, when more signals fire on the same bar than slots available, rank by
  ADX descending (matching the scanner's sort) and document the ties dropped.
- **Optional time stop:** exit after N bars (default: none/disabled, but test 24, 48, 96).

## 6. Metrics & report

Per run: trade count, win rate, average/median R, **expectancy in R**, profit factor,
total return, CAGR, max drawdown (and duration), Sharpe & Sortino on daily returns,
longest losing streak, average holding time, total fees + funding paid as a share of
gross P&L.

Breakdowns: by symbol, by side (long vs short), by hour of UTC day, by month, by ADX
bucket, by ATR% bucket, by RVOL bucket, and by 5m/1h RSI bucket at entry. Record MFE and
MAE in R for every trade — the distribution tells me whether 2×ATR / 1.5R is anywhere
near the right bracket.

Plots: equity curve, drawdown curve, R-multiple histogram, MAE-vs-outcome scatter.

## 7. Robustness — do not skip this

1. **Parameter sweep** over `ADX_MIN ∈ {15,20,25,30}`, `ATR_MULT ∈ {1.0,1.5,2.0,3.0}`,
   `RR ∈ {1.0,1.5,2.0,3.0}`, `MIN_RVOL ∈ {0.8,1.0,1.5}`, ATR band edges. Show a heatmap.
   A single sharp peak surrounded by losses is overfit — say so if that's what you see.
2. **Walk-forward / out-of-sample:** hold out the most recent ~30% and never tune on it.
3. **Baselines:** compare against (a) random entries with the identical bracket and the
   same trade count, and (b) the same signals with the 1h EMA / ADX / RVOL gates removed
   one at a time, so I can see which filter is actually carrying the strategy.
4. **Regime split:** bull / bear / chop segments of BTC, since the universe is highly
   correlated and 100 alt signals in one hour is roughly one bet, not 100.
5. **Cost sensitivity:** re-run at 0 / 0.05% / 0.10% per side. A 5m mean-reversion-ish
   scalper often dies entirely on fees — if it does, lead with that.

## 8. Deliverables

Structured, runnable code — not one giant script:

```
data.py        # fetch, cache, validate klines + funding
indicators.py  # vwap / ema / adx / atr / rsi / rvol, with parity tests vs technicalindicators
signals.py     # gate + entry logic, returns a signal DataFrame
engine.py      # event-driven portfolio loop, bracket fills, fees, funding, sizing
metrics.py     # stats + plots
run.py         # CLI: --symbols --start --end --params  (config via dataclass or YAML)
tests/         # unit tests
```

Tests I specifically want: a hand-built fixture where the VWAP cross, the UTC re-anchor,
and the 1h-EMA lookup all have known correct answers; a lookahead test asserting that
truncating the data after bar *t* does not change the signal at bar *t*; and an intrabar
SL/TP-precedence test.

At the end, give me a short, blunt verdict: does this edge survive costs and realistic
fills, or not? Include the numbers that support it, and flag any assumption you had to
make that materially moves the result.
