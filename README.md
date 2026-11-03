# Northstar Trading Lab

A local-first trading dashboard prototype with isolated paper and live modes. The manual simulator uses public Binance Spot quotes for simulated long trades and fully collateralized 1× synthetic shorts; a separate Kraken paper bot scans spot pairs and paper-trades one fixed, weighted long-only confluence strategy built from 20 technical and candlestick tools. Research that compared rules was a one-off exercise — the running app never re-runs a backtest. No exchange credentials are requested or stored, and no live order execution is implemented.

## Test on iPhone

Use the app's **Run** preview to open the zero-build web dashboard. Without the local Node backend, the manual simulator and separate Kraken bot store their own paper state in this browser. They request public Binance and Kraken market data directly; if the WebView/network blocks a provider, that feed reports an error instead of inventing prices.

## Publish a static GitHub Pages demo

The `pages.yml` workflow publishes only `index.html`, the dashboard styles and browser scripts. It does not publish or run the Node server, so paper state stays in the current browser and the bot runs only while the page is open and active. Public market-data requests may be blocked by the browser or provider.

After creating a public GitHub repository, choose **Settings → Pages → Build and deployment → GitHub Actions**. The workflow deploys automatically on pushes to `main`; use its **Run workflow** button for a manual deployment.

## Run with the local backend

Requires Node.js 18 or newer. From this directory, run `node server.js`, then open `http://127.0.0.1:4173` on the same computer. The server binds to loopback by default; set `HOST=0.0.0.0` and optionally `PORT` to accept connections from outside, which is what a host needs. The manual Binance paper account, including simulated shorts, is persisted in `data/paper-state.json`, and the server-side Kraken paper engine keeps its own account in `data/kraken-bot-state.json`. Both files are intentionally excluded from version control. While the server is running the dashboard mirrors the server's Kraken account; served as plain files it falls back to browser local storage.

## The bot running with no browser open

`node server.js` starts the same fixed confluence engine the page uses (`bot-service.js` loads `kraken-bot.js` in a Node sandbox), so the scanner, the paper entries and the position management keep going while the dashboard is closed. State is saved after every cycle and shown on any device that opens the page.

- `HOST=0.0.0.0 PORT=8080 node server.js` is the shape a host needs.
- `NORTHSTAR_HEADLESS_BOT=off` runs the site without the server engine, leaving the browser-only mode.
- The engine only calls Kraken's public market-data endpoints. There are no API keys, no order routes and no live execution anywhere in this process.
- `Dockerfile` and `render.yaml` are included: `docker build -t northstar . && docker run -p 8080:8080 northstar`.

### Free places to put it

- **Your own always-on Node host** (already available): the only option here that genuinely keeps trading around the clock. Copy the folder, run `npm start`, and keep the process alive (systemd, `pm2`, or Docker).
- **Fly.io**: machines can be configured not to auto-stop, with a volume for `data/`; a card is usually required.
- **Render free web service**: deploys the included Dockerfile, but the free plan sleeps after roughly 15 minutes without traffic, which stops the engine. Good for checking the dashboard, not for continuous trading.
- **Oracle Cloud Always Free VM** or **Google Cloud free-tier e2-micro**: free and always-on once you configure the machine and run the server there yourself.
- **Railway**: small trial credit, then paid.
- **Any free static host** (GitHub Pages, Netlify): serves the dashboard only. With no Node process the bot runs only while the page is open.

Free plans usually have an ephemeral disk, so `data/*.json` is lost on restart or redeploy and the paper account resets. Attach a persistent volume if the account history matters.

## Simulation behavior

- The Binance manual paper dashboard remains separate from the Kraken paper bot account.
- The Kraken scanner runs by itself: an engine timer owned by the bot refreshes quotes for every online spot pair on a configurable cadence (60 seconds by default, 20–300 seconds) and assigns each pair a quality score. Coin selection has its own **Coins** page: a score-ranked list of every scanned pair, and opening one replaces the list with that coin's page (price header, timeframe chart with EMA/Bollinger overlays and RSI/MACD subcharts, indicator tiles, weighted score breakdown, setup read, paper-bot eligibility, evidence and the tool votes). There is no scan button and no research sweep; "Rescan now" only forces an extra pass.
- The trading algorithm is fixed in code (`Northstar Confluence v1`), not chosen per run. It is a weighted vote over 20 tools: EMA stack (9/21/50/200), Supertrend (10, 3×ATR), MACD (12/26/9), ADX/DI (14), Ichimoku cloud, Donchian breakout, rate of change, RSI (14), Stochastic (14, 3), CCI (20), Williams %R, money flow index, Bollinger (20, 2) %B, on-balance volume, volume vs its 20-bar average, swing structure (higher highs/lows), Fibonacci retracement zones, session VWAP, support/resistance position, and 15 candlestick patterns (engulfing, hammer, shooting star, morning/evening star, piercing, dark cloud, harami, tweezers, three soldiers/crows, marubozu, doji). Votes are weighted and normalised to −100…+100; a long is paper-entered when the score clears the entry threshold, the spread/volume/volatility gates pass, a position slot is free and the pair is not in cooldown.
- Exits use a 2×ATR protective stop, a stop moved to break-even once price gains one risk unit, a confluence score collapse below the exit threshold, and a maximum hold of 96 bars. Risk is 1% of equity per position by default, with daily loss and drawdown halts and a per-position risk check that trips the halt.
- Backtesting is deliberately not part of the running app. The weight set is a fixed design decision made from comparing rules, not a validated edge: re-running a backtest on every startup would spend Kraken's rate limit without improving live decisions, and Kraken's 720-candle history cap makes repeated sweeps weak evidence anyway. Changing a setting does not retrain anything — the same fixed rules are re-scored on the next cycle. Profitability is not guaranteed.
- Each cycle scores a small watchlist (default 5 pairs: the highest-quality pairs plus a rotating slice of the rest), so every listed pair is eventually scored while request volume stays modest. Pairs with an open position and pairs you tap are always included. If a refresh fails, entries are blocked, quotes are marked stale, and the engine keeps retrying instead of trading on old prices.
- The engine runs in the page when the dashboard is served as plain files, so it pauses when the page is backgrounded or closed. When the Node backend is running it also runs server-side, and the page mirrors that account instead of trading a second browser-local one. Stopping the Node process stops the engine; only your host's own process supervision brings it back.
- Public best bid/ask and rolling 24-hour statistics are fetched from Binance's public Spot REST API. One-minute historical candles power the Binance chart and simple descriptive regime, SMA, and RSI indicators; no AI strategy or external sentiment source is connected.
- Market, limit, and stop-market orders use a configurable simulated delay before initial order arrival, then current bid/ask, configurable fees and slippage, and a participation cap against displayed best bid/ask size. Partial fills are recorded. Unfilled market remainders are cancelled; eligible limit and stop orders are checked on each later quote refresh.
- Paper long and synthetic-short entries require protective stops. Shorts reserve 1× paper collateral and compute inverse-price P&L with simulated fees/slippage; they do not model borrowing, funding, liquidation, or Kraken margin/futures. Per-position risk, daily equity loss, and account drawdown limits apply to both directions; protective stops and manual close/cover actions are simulated from public quotes.
- The displayed book size is only the top level, not a full depth feed or historical order-book replay. Refreshes are snapshots and do not model queue position, outages between polls, or exact exchange matching behavior. Synthetic shorts are educational paper positions, not real borrows or derivative contracts. Historical prices are real, but historical trades are not replayed into a backtest.
- Both paper accounts start with 10,000 quote-equivalent units and can be reset from the dashboard. The Node backend persists the manual Binance account and, when its Kraken engine is on, the separate Kraken account as well; otherwise that account stays in browser local storage.

## Safety boundary

Live trading is deliberately fail-closed: the live screen shares the Kraken paper strategy signals read-only, `/api/live` reports locked status, and there are no exchange credential or order-placement routes. Do not put this on the public internet as it stands: the server has no user accounts, no TLS termination of its own and nothing watching it. It trades paper only and does not claim to connect OpenAI, Claude, Jev, TradingView, on-chain data, Telegram, or Discord. The Kraken baseline implements common indicators locally; it does not use TradingView's proprietary tools or a connected AI model. Profitability is not guaranteed.

Before adding real-money execution, the exchange and market must be selected and the deployment/runtime, secure secret storage, account permissions, instrument constraints, and explicit live enablement must be agreed. Exchange secrets must never be put in browser code.
