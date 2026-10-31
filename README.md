# Northstar Trading Lab

A local-first trading dashboard prototype with isolated paper and live modes. The manual simulator uses public Binance Spot data; a separate, opt-in Kraken paper bot scans markets and simulates a rule-based strategy. No brokerage credentials are requested or stored, and no live order execution is implemented.

## Test on iPhone

Use the app's **Run** preview to open the zero-build web dashboard. Without the local Node backend, the manual simulator and separate Kraken bot store their own paper state in this browser. They request public Binance and Kraken market data directly; if the WebView/network blocks a provider, that feed reports an error instead of inventing prices.

## Run with the local backend

Requires Node.js 18 or newer. From this directory, run `node server.js`, then open `http://127.0.0.1:4173` on the same computer. The server binds to loopback by default. The manual Binance paper account is persisted in `data/paper-state.json`; the Kraken bot keeps its separate paper account, scan results, and backtests in browser local storage. The JSON file is intentionally excluded from version control.

## Simulation behavior

- The Binance manual paper dashboard remains separate from the Kraken paper bot account.
- The Kraken scanner discovers all online spot pairs with public AssetPairs and all-market Ticker endpoints, then ranks market quality from approximately USD-converted rolling 24-hour quote volume, current spread, and UTC-day price change. It may display markets with other quote currencies, but the bot only backtests and paper-trades USD/USDT pairs; those two quote currencies are treated approximately 1:1. The displayed ticker change is the UTC-day change (Kraken's ticker open is UTC-day based), not a rolling 24-hour return.
- The paper bot compares fixed scalping baselines (EMA/RSI trend, Donchian breakout, MACD crossover, and Elliott-inspired swing/Fibonacci pullback), with 2-ATR stops, configurable costs, 1% default position risk, and daily/drawdown halts. Select 1m or 5m bars. Kraken's OHLC cap of 720 candles means only about 12 hours at 1m or 2.5 days at 5m; tests exclude the unfinished candle, use early candles for warm-up, and report on the final 30% holdout. Selecting the best among many pairs/rules can itself overfit; these baselines cannot establish durable profitability.
- Kraken public REST market data requires no credentials. The scanner/backtest obeys a conservative one-request-per-second cadence; backtesting every eligible pair may take minutes. The on-device bot checks quotes about every 20 seconds while its dashboard stays open and is not a 24/7 service.
- Public best bid/ask and rolling 24-hour statistics are fetched from Binance's public Spot REST API. One-minute historical candles power the Binance chart and simple descriptive regime, SMA, and RSI indicators; no AI strategy or external sentiment source is connected.
- Market, limit, and stop-market orders use a configurable simulated delay before initial order arrival, then current bid/ask, configurable fees and slippage, and a participation cap against displayed best bid/ask size. Partial fills are recorded. Unfilled market remainders are cancelled; eligible limit and stop orders are checked on each later quote refresh.
- Paper buys require a protective stop price. Per-position risk, daily equity loss, and account drawdown limits are enforced; lowering limits below existing exposure trips an automatic halt. Protective stop exits are simulated when the observed last price crosses the stop.
- The displayed book size is only the top level, not a full depth feed or historical order-book replay. Refreshes are snapshots and do not model queue position, outages between polls, or exact exchange matching behavior. Historical prices are real, but historical trades are not replayed into a backtest.
- Both paper accounts start with 10,000 quote-equivalent units and can be reset from the dashboard. The Node backend persists the manual Binance account; the independent Kraken bot account remains in browser local storage.

## Safety boundary

Live trading is deliberately fail-closed: the live screen shares the Kraken paper strategy signals read-only, `/api/live` reports locked status, and there are no exchange credential or order-placement routes. Do not expose this prototype publicly. It is not an always-on trading service, has no monitoring or deployment setup, and does not claim to connect OpenAI, Claude, Jev, TradingView, on-chain data, Telegram, or Discord. The Kraken baseline implements common indicators locally; it does not use TradingView's proprietary tools or a connected AI model.

Before adding real-money execution, the exchange and market must be selected and the deployment/runtime, secure secret storage, account permissions, instrument constraints, and explicit live enablement must be agreed. Exchange secrets must never be put in browser code.
