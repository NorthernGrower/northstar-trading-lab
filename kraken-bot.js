(() => {
  const API = 'https://api.kraken.com/0/public';
  const STORAGE_KEY = 'northstar-kraken-paper-bot-v1';
  const QUOTE_ALLOWLIST = new Set(['USD', 'USDT']);
  const STRATEGIES = [
    { id: 'ema-trend', label: 'EMA trend' },
    { id: 'donchian-breakout', label: 'Donchian breakout' },
    { id: 'macd-crossover', label: 'MACD crossover' },
    { id: 'elliott-fib-pullback', label: 'Elliott-inspired/Fibonacci pullback' },
  ];
  const DEFAULT_SETTINGS = {
    feeBps: 26,
    slippageBps: 8,
    assumedSpreadBps: 12,
    riskPct: 1,
    dailyLossLimitPct: 5,
    maxDrawdownPct: 15,
    maxPositions: 3,
    liquidityParticipationPct: 5,
    maxSpreadBps: 40,
    minVolumeUsd: 50000,
    scanCandidates: 5,
    intervalMinutes: 5,
    startingBalance: 10000,
  };
  const listeners = new Set();
  let requestQueue = Promise.resolve();
  let lastRequestAt = 0;
  let scanPromise = null;
  let backtestCancelled = false;
  let botTimer = null;
  let botCycleRunning = false;

  function utcDay() {
    return new Date().toISOString().slice(0, 10);
  }

  function createState() {
    const balance = DEFAULT_SETTINGS.startingBalance;
    return {
      version: 1,
      settings: { ...DEFAULT_SETTINGS },
      cash: balance,
      initialBalance: balance,
      positions: {},
      trades: [],
      pairMeta: [],
      markets: [],
      backtests: {},
      latestSignals: {},
      latestAnalysis: {},
      scanning: false,
      scanError: null,
      lastScanAt: null,
      backtestRunning: false,
      backtestProgress: { done: 0, total: 0, pair: '' },
      botActive: false,
      botEntriesEnabled: false,
      botStatus: 'Paused',
      botError: null,
      lastCycleAt: null,
      lastSignalAt: {},
      highWaterMark: balance,
      dayKey: utcDay(),
      dayStartEquity: balance,
      autoHaltReason: null,
      updatedAt: new Date().toISOString(),
    };
  }

  function loadState() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (stored?.version === 1 && typeof stored.cash === 'number') {
        const loaded = { ...createState(), ...stored, settings: { ...DEFAULT_SETTINGS, ...stored.settings } };
        loaded.botActive = false;
        loaded.botEntriesEnabled = false;
        loaded.backtestRunning = false;
        loaded.scanning = false;
        loaded.botStatus = 'Paused · reopen and explicitly resume';
        return loaded;
      }
    } catch {
      // Use a fresh on-device paper account if storage is unavailable or invalid.
    }
    return createState();
  }

  const state = loadState();

  function persist() {
    state.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      throw new Error('On-device storage is full or unavailable; Kraken bot state was not saved.');
    }
  }

  function emit() {
    for (const listener of listeners) listener(getSnapshot());
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(getSnapshot());
    return () => listeners.delete(listener);
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function publicRequest(path, params = {}) {
    const run = requestQueue.then(async () => {
      const wait = Math.max(0, 1100 - (Date.now() - lastRequestAt));
      if (wait) await sleep(wait);
      lastRequestAt = Date.now();
      const query = new URLSearchParams(params).toString();
      const suffix = query ? `?${query}` : '';
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 12000);
      try {
        let response = null;
        try {
          response = await fetch(`/api/kraken/${path}${suffix}`, { cache: 'no-store', signal: controller.signal });
        } catch {
          // The iPhone Run preview has no local Node proxy, so use Kraken's public REST endpoint directly.
        }
        if (response && response.status !== 404 && (response.headers.get('content-type') || '').includes('application/json')) {
          if (!response.ok) {
            const errorPayload = await response.json().catch(() => ({}));
            throw new Error(errorPayload.error || `Kraken proxy returned HTTP ${response.status}.`);
          }
          const payload = await response.json();
          if (payload.error?.length) throw new Error(`Kraken: ${payload.error.join(', ')}`);
          return payload.result;
        }
        const direct = await fetch(`${API}/${path}${suffix}`, { cache: 'no-store', signal: controller.signal });
        if (!direct.ok) throw new Error(`Kraken public API returned HTTP ${direct.status}.`);
        const payload = await direct.json();
        if (payload.error?.length) throw new Error(`Kraken: ${payload.error.join(', ')}`);
        return payload.result;
      } finally {
        window.clearTimeout(timeout);
      }
    });
    requestQueue = run.catch(() => {});
    return run;
  }

  function normalizeAsset(value) {
    let asset = String(value || '').trim().toUpperCase();
    if (asset === 'XBT' || asset === 'XXBT') return 'BTC';
    if (asset === 'XDG' || asset === 'XXDG') return 'DOGE';
    if (asset === 'XETH') return 'ETH';
    if (asset === 'ZUSD') return 'USD';
    if (asset === 'ZEUR') return 'EUR';
    if (asset === 'ZGBP') return 'GBP';
    if (asset === 'ZCAD') return 'CAD';
    if (asset === 'ZJPY') return 'JPY';
    if (asset === 'ZAUD') return 'AUD';
    return asset;
  }

  function pairNames(meta) {
    const display = meta.wsname || meta.altname || '';
    const parts = display.split('/');
    const base = normalizeAsset(parts[0] || meta.base);
    const quote = normalizeAsset(parts[1] || meta.quote);
    return { display: display || `${base}/${quote}`, base, quote };
  }

  function currencyRates(markets) {
    const graph = new Map();
    const addEdge = (from, to, rate) => {
      if (!(rate > 0) || !Number.isFinite(rate)) return;
      if (!graph.has(from)) graph.set(from, []);
      graph.get(from).push([to, rate]);
    };
    for (const market of markets) {
      if (!(market.last > 0)) continue;
      addEdge(market.base, market.quote, market.last);
      addEdge(market.quote, market.base, 1 / market.last);
    }
    const convert = (asset) => {
      if (asset === 'USD' || asset === 'USDT' || asset === 'USDC') return 1;
      const pending = [[asset, 1, 0]];
      const seen = new Set([asset]);
      while (pending.length) {
        const [currency, rate, depth] = pending.shift();
        if (depth >= 4) continue;
        for (const [next, edgeRate] of graph.get(currency) || []) {
          if (next === 'USD' || next === 'USDT' || next === 'USDC') return rate * edgeRate;
          if (!seen.has(next)) {
            seen.add(next);
            pending.push([next, rate * edgeRate, depth + 1]);
          }
        }
      }
      return null;
    };
    return convert;
  }

  function buildMarkets(pairResult, tickerResult) {
    const markets = [];
    for (const [pairKey, meta] of Object.entries(pairResult || {})) {
      if (meta.aclass_base && meta.aclass_base !== 'currency') continue;
      const ticker = tickerResult[pairKey] || tickerResult[meta.altname] || tickerResult[meta.wsname?.replace('/', '')];
      if (!ticker) continue;
      const names = pairNames(meta);
      const market = {
        pairKey,
        altname: meta.altname || pairKey,
        display: names.display,
        base: names.base,
        quote: names.quote,
        status: meta.status || 'unknown',
        pairDecimals: Number(meta.pair_decimals ?? 8),
        lotDecimals: Number(meta.lot_decimals ?? 8),
        orderMin: Number(meta.ordermin || 0),
        costMin: Number(meta.costmin || 0),
        bidPrice: Number(ticker.b?.[0]),
        bidQty: Number(ticker.b?.[1]),
        askPrice: Number(ticker.a?.[0]),
        askQty: Number(ticker.a?.[1]),
        last: Number(ticker.c?.[0]),
        volume24h: Number(ticker.v?.[1]),
        open24h: Number(ticker.o),
        tradeCount24h: Number(ticker.t?.[1]),
      };
      if (![market.bidPrice, market.bidQty, market.askPrice, market.askQty, market.last, market.volume24h, market.open24h].every(Number.isFinite)
        || market.last <= 0 || market.bidPrice <= 0 || market.askPrice <= 0 || market.bidQty < 0 || market.askQty < 0 || market.bidPrice > market.askPrice) continue;
      market.todayChangePct = market.open24h > 0 ? (market.last / market.open24h - 1) * 100 : 0;
      market.spreadBps = (market.askPrice - market.bidPrice) / ((market.askPrice + market.bidPrice) / 2) * 10000;
      markets.push(market);
    }
    const toUsd = currencyRates(markets);
    for (const market of markets) {
      market.quoteUsdRate = toUsd(market.quote);
      market.volumeUsd = market.quoteUsdRate === null ? null : market.volume24h * market.last * market.quoteUsdRate;
      const liquidity = market.volumeUsd === null ? 0 : Math.log10(Math.max(1, market.volumeUsd));
      const momentum = Math.max(-12, Math.min(12, market.todayChangePct));
      const spreadPenalty = Math.min(200, market.spreadBps);
      market.screenScore = liquidity * 5 + momentum * 0.55 - spreadPenalty * 0.12;
      market.eligible = market.status === 'online' && QUOTE_ALLOWLIST.has(market.quote);
    }
    return markets.sort((a, b) => b.screenScore - a.screenScore);
  }

  async function scan(options = {}) {
    if (scanPromise) return scanPromise;
    scanPromise = (async () => {
      state.scanning = true;
      state.scanError = null;
      emit();
      try {
        let pairResult;
        if (!options.forcePairs && state.pairMeta.length && state.pairMetaFetchedAt && Date.now() - state.pairMetaFetchedAt < 6 * 60 * 60 * 1000) {
          pairResult = Object.fromEntries(state.pairMeta.map((pair) => [pair.pairKey, pair]));
        } else {
          pairResult = await publicRequest('AssetPairs');
          state.pairMeta = Object.entries(pairResult || {}).map(([pairKey, meta]) => ({
            pairKey,
            altname: meta.altname || pairKey,
            wsname: meta.wsname || '',
            base: meta.base || '',
            quote: meta.quote || '',
            aclass_base: meta.aclass_base || 'currency',
            status: meta.status || 'unknown',
            pair_decimals: meta.pair_decimals,
            lot_decimals: meta.lot_decimals,
            ordermin: meta.ordermin,
            costmin: meta.costmin,
          }));
          state.pairMetaFetchedAt = Date.now();
        }
        const tickerResult = await publicRequest('Ticker');
        state.markets = buildMarkets(pairResult, tickerResult);
        state.lastScanAt = new Date().toISOString();
        state.scanError = null;
        persist();
      } catch (error) {
        state.scanError = error.message || 'Kraken scan failed.';
        throw error;
      } finally {
        state.scanning = false;
        emit();
        scanPromise = null;
      }
      return getSnapshot();
    })();
    return scanPromise;
  }

  function ema(values, period) {
    const output = Array(values.length).fill(null);
    if (values.length < period) return output;
    const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    output[period - 1] = seed;
    const multiplier = 2 / (period + 1);
    for (let i = period; i < values.length; i += 1) output[i] = values[i] * multiplier + output[i - 1] * (1 - multiplier);
    return output;
  }

  function indicators(candles) {
    const closes = candles.map((candle) => candle.close);
    const volumes = candles.map((candle) => candle.volume);
    const ema12 = ema(closes, 12);
    const ema20 = ema(closes, 20);
    const ema26 = ema(closes, 26);
    const ema50 = ema(closes, 50);
    const rsi = Array(closes.length).fill(null);
    const atr = Array(closes.length).fill(null);
    const macd = Array(closes.length).fill(null);
    const macdSignal = Array(closes.length).fill(null);
    const donchianHigh20 = Array(closes.length).fill(null);
    let averageGain = 0;
    let averageLoss = 0;
    const trueRanges = candles.map((candle, index) => {
      if (index === 0) return candle.high - candle.low;
      return Math.max(candle.high - candle.low, Math.abs(candle.high - closes[index - 1]), Math.abs(candle.low - closes[index - 1]));
    });
    if (closes.length > 14) {
      for (let i = 1; i <= 14; i += 1) {
        const change = closes[i] - closes[i - 1];
        averageGain += Math.max(0, change);
        averageLoss += Math.max(0, -change);
      }
      averageGain /= 14;
      averageLoss /= 14;
      for (let i = 14; i < closes.length; i += 1) {
        if (i > 14) {
          const change = closes[i] - closes[i - 1];
          averageGain = (averageGain * 13 + Math.max(0, change)) / 14;
          averageLoss = (averageLoss * 13 + Math.max(0, -change)) / 14;
        }
        rsi[i] = averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - 100 / (1 + averageGain / averageLoss);
      }
    }
    let atrValue = 0;
    if (trueRanges.length > 14) {
      atrValue = trueRanges.slice(1, 15).reduce((sum, value) => sum + value, 0) / 14;
      atr[14] = atrValue;
      for (let i = 15; i < trueRanges.length; i += 1) {
        atrValue = (atrValue * 13 + trueRanges[i]) / 14;
        atr[i] = atrValue;
      }
    }
    const macdValues = [];
    const macdIndices = [];
    for (let i = 0; i < closes.length; i += 1) {
      if (Number.isFinite(ema12[i]) && Number.isFinite(ema26[i])) {
        macd[i] = ema12[i] - ema26[i];
        macdValues.push(macd[i]);
        macdIndices.push(i);
      }
      if (i >= 20) donchianHigh20[i] = Math.max(...candles.slice(i - 20, i).map((candle) => candle.high));
    }
    const compactSignal = ema(macdValues, 9);
    compactSignal.forEach((value, index) => {
      if (Number.isFinite(value)) macdSignal[macdIndices[index]] = value;
    });
    const volumeAverage = Array(volumes.length).fill(null);
    for (let i = 19; i < volumes.length; i += 1) {
      volumeAverage[i] = volumes.slice(i - 19, i + 1).reduce((sum, value) => sum + value, 0) / 20;
    }
    const pivotWindow = 3;
    const swingEvents = Array(candles.length).fill(null);
    for (let center = pivotWindow; center < candles.length - pivotWindow; center += 1) {
      let isHigh = true;
      let isLow = true;
      for (let offset = -pivotWindow; offset <= pivotWindow; offset += 1) {
        if (offset === 0) continue;
        const neighbor = candles[center + offset];
        if (candles[center].high <= neighbor.high) isHigh = false;
        if (candles[center].low >= neighbor.low) isLow = false;
      }
      if (isHigh === isLow) continue;
      swingEvents[center + pivotWindow] = {
        type: isHigh ? 'HIGH' : 'LOW',
        price: isHigh ? candles[center].high : candles[center].low,
        index: center,
        confirmedAt: center + pivotWindow,
      };
    }
    const swingHistory = Array(candles.length).fill(null);
    let swings = [];
    for (let i = 0; i < candles.length; i += 1) {
      const event = swingEvents[i];
      if (event) {
        const last = swings[swings.length - 1];
        if (last?.type === event.type) {
          if ((event.type === 'HIGH' && event.price > last.price) || (event.type === 'LOW' && event.price < last.price)) swings[swings.length - 1] = event;
        } else {
          swings.push(event);
          swings = swings.slice(-8);
        }
      }
      swingHistory[i] = swings.map((point) => ({ ...point }));
    }
    return { closes, ema12, ema20, ema26, ema50, rsi, atr, macd, macdSignal, donchianHigh20, volumeAverage, swingHistory };
  }

  function swingContext(candles, values, index) {
    const swings = values.swingHistory[index] || [];
    const highs = swings.filter((point) => point.type === 'HIGH');
    const lows = swings.filter((point) => point.type === 'LOW');
    const higherHighs = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
    const higherLows = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price;
    const lowerHighs = highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price;
    const lowerLows = lows.length >= 2 && lows[lows.length - 1].price < lows[lows.length - 2].price;
    const impulseUp = higherHighs && higherLows;
    let swingHigh = null;
    let swingLow = null;
    let highListIndex = -1;
    for (let i = swings.length - 1; i >= 0; i -= 1) {
      if (swings[i].type === 'HIGH') { swingHigh = swings[i]; highListIndex = i; break; }
    }
    for (let i = highListIndex - 1; i >= 0; i -= 1) {
      if (swings[i].type === 'LOW' && swings[i].price < swingHigh?.price) { swingLow = swings[i]; break; }
    }
    let fibRatio = null;
    let fibLevel = null;
    let fibPrice = null;
    let inFibZone = false;
    if (swingHigh && swingLow && swingHigh.price > swingLow.price) {
      fibRatio = (swingHigh.price - candles[index].close) / (swingHigh.price - swingLow.price);
      if (fibRatio >= 0 && fibRatio <= 1.2) {
        const levels = [{ ratio: 0.382, label: '38.2%' }, { ratio: 0.5, label: '50.0%' }, { ratio: 0.618, label: '61.8%' }];
        const nearest = levels.reduce((best, level) => Math.abs(level.ratio - fibRatio) < Math.abs(best.ratio - fibRatio) ? level : best);
        fibLevel = nearest.label;
        fibPrice = swingHigh.price - (swingHigh.price - swingLow.price) * nearest.ratio;
        inFibZone = fibRatio >= 0.382 && fibRatio <= 0.618 && candles[index].close > swingLow.price;
      }
    }
    const waveLabel = impulseUp
      ? 'Elliott-inspired higher highs/lows'
      : lowerHighs && lowerLows
        ? 'Lower-high/lower-low structure'
        : swingHigh && swingLow && candles[index].close < swingHigh.price && candles[index].close > swingLow.price
          ? 'Possible swing pullback · unconfirmed'
          : 'Unclear pivot structure';
    return { swings, impulseUp, swingHigh, swingLow, fibRatio, fibLevel, fibPrice, inFibZone, waveLabel };
  }

  function entrySignal(candles, values, index, strategy = 'ema-trend') {
    if (index < 50 || !Number.isFinite(values.ema20[index]) || !Number.isFinite(values.ema50[index]) || !Number.isFinite(values.rsi[index]) || !Number.isFinite(values.atr[index])) return false;
    const candle = candles[index];
    const previous = candles[index - 1];
    const averageVolume = values.volumeAverage[index];
    const volumePass = !averageVolume || candle.volume >= averageVolume * 0.7;
    if (strategy === 'elliott-fib-pullback') {
      const swing = swingContext(candles, values, index);
      return swing.impulseUp && swing.inFibZone && candle.close > values.ema20[index]
        && values.rsi[index] >= 45 && values.rsi[index] <= 68 && candle.close > previous.close && volumePass;
    }
    if (strategy === 'donchian-breakout') {
      return Number.isFinite(values.donchianHigh20[index]) && candle.close > values.donchianHigh20[index]
        && values.rsi[index] >= 50 && values.rsi[index] <= 70 && volumePass;
    }
    if (strategy === 'macd-crossover') {
      return Number.isFinite(values.macd[index]) && Number.isFinite(values.macdSignal[index])
        && Number.isFinite(values.macd[index - 1]) && Number.isFinite(values.macdSignal[index - 1])
        && values.macd[index] > values.macdSignal[index] && values.macd[index - 1] <= values.macdSignal[index - 1]
        && candle.close > values.ema50[index] && values.rsi[index] >= 45 && values.rsi[index] <= 70 && volumePass;
    }
    return candle.close > values.ema50[index]
      && values.ema20[index] > values.ema50[index]
      && values.rsi[index] >= 50 && values.rsi[index] <= 68
      && candle.close > previous.close
      && volumePass;
  }

  function exitSignal(candles, values, index, strategy = 'ema-trend') {
    if (!Number.isFinite(values.ema20[index])) return false;
    if (strategy === 'elliott-fib-pullback') {
      const swing = swingContext(candles, values, index);
      return candles[index].close < values.ema20[index] || values.rsi[index] >= 72
        || Boolean(swing.swingLow && candles[index].close < swing.swingLow.price);
    }
    if (strategy === 'macd-crossover') {
      return Number.isFinite(values.macd[index]) && Number.isFinite(values.macdSignal[index])
        && (values.macd[index] < values.macdSignal[index] || candles[index].close < values.ema20[index]);
    }
    const rsiExit = strategy === 'donchian-breakout' ? 72 : 75;
    return candles[index].close < values.ema20[index] || values.rsi[index] >= rsiExit;
  }

  function analyzeClosedCandles(candles, strategy, isQualified) {
    const closed = candles.slice(0, -1);
    if (closed.length < 60) return { strategy, strategyLabel: STRATEGIES.find((item) => item.id === strategy)?.label || strategy, signal: 'NEED MORE DATA', shouldEnter: false, shouldExit: false, waveLabel: '—', fibLevel: '—', fibRatio: null, candleAt: null };
    const values = indicators(closed);
    const index = closed.length - 1;
    const swing = swingContext(closed, values, index);
    const entry = entrySignal(closed, values, index, strategy);
    const exit = exitSignal(closed, values, index, strategy);
    return {
      strategy,
      strategyLabel: STRATEGIES.find((item) => item.id === strategy)?.label || strategy,
      signal: entry ? isQualified ? 'ENTRY READY' : 'ENTRY UNQUALIFIED' : exit ? 'EXIT SETUP' : 'WAIT',
      shouldEnter: entry,
      shouldExit: exit,
      waveLabel: swing.waveLabel,
      fibLevel: swing.fibLevel || '—',
      fibRatio: swing.fibRatio,
      fibPrice: swing.fibPrice,
      candleAt: closed[index].time,
    };
  }

  function executeBacktest(candles, market, settings = state.settings, strategy = 'ema-trend') {
    const closed = candles.slice(0, -1);
    if (closed.length < 200) return { pairKey: market.pairKey, display: market.display, strategy, strategyLabel: STRATEGIES.find((item) => item.id === strategy)?.label || strategy, error: `Not enough closed ${settings.intervalMinutes}m candles (need at least 200).` };
    const values = indicators(closed);
    const validationStart = Math.max(100, Math.floor(closed.length * 0.7));
    let cash = 10000;
    let position = null;
    let peak = 10000;
    let maxDrawdownPct = 0;
    let dayKey = new Date(closed[validationStart].time).toISOString().slice(0, 10);
    let dayStartEquity = 10000;
    let lastMarkedEquity = 10000;
    let dailyHalt = false;
    let drawdownHalt = false;
    const trades = [];
    const adverseRate = (settings.assumedSpreadBps / 2 + settings.slippageBps) / 10000;
    const feeRate = settings.feeBps / 10000;

    const closePosition = (rawPrice, reason, time) => {
      if (!position) return;
      const fillPrice = rawPrice * (1 - adverseRate);
      const notional = position.qty * fillPrice;
      const fee = notional * feeRate;
      cash += notional - fee;
      const pnl = position.qty * (fillPrice - position.entryPrice) - position.entryFee - fee;
      trades.push({ pnl, entryPrice: position.entryPrice, exitPrice: fillPrice, entryAt: position.entryAt, exitAt: time, reason });
      position = null;
    };

    for (let i = validationStart; i < closed.length; i += 1) {
      const signalIndex = i - 1;
      const candle = closed[i];
      const candleDay = new Date(candle.time).toISOString().slice(0, 10);
      if (candleDay !== dayKey) {
        dayKey = candleDay;
        dayStartEquity = lastMarkedEquity;
        dailyHalt = false;
      }
      let exitedThisBar = false;
      if (position) {
        if (candle.low <= position.stopPrice) {
          closePosition(Math.min(candle.open, position.stopPrice), 'ATR stop', candle.time);
          exitedThisBar = true;
        } else if (exitSignal(closed, values, signalIndex, strategy)) {
          closePosition(candle.open, `${strategy} exit`, candle.time);
          exitedThisBar = true;
        }
      }
      if (!position && !exitedThisBar && !dailyHalt && !drawdownHalt && entrySignal(closed, values, signalIndex, strategy)) {
        const entryPrice = candle.open * (1 + adverseRate);
        const stopPrice = entryPrice - values.atr[signalIndex] * 2;
        if (!(stopPrice > 0 && stopPrice < entryPrice)) continue;
        const currentEquity = cash;
        const riskBudget = currentEquity * settings.riskPct / 100;
        const riskPerUnit = (entryPrice - stopPrice) + (entryPrice + stopPrice) * feeRate;
        const desiredQty = riskBudget / riskPerUnit;
        const qty = Math.min(desiredQty, cash / (entryPrice * (1 + feeRate)));
        if (!(qty > 0)) continue;
        const notional = qty * entryPrice;
        const fee = notional * feeRate;
        cash -= notional + fee;
        position = { qty, entryPrice, stopPrice, entryFee: fee, entryAt: candle.time };
      }
      const currentEquity = cash + (position ? position.qty * candle.close : 0);
      peak = Math.max(peak, currentEquity);
      maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - currentEquity) / peak * 100 : 0);
      lastMarkedEquity = currentEquity;
      if (currentEquity <= dayStartEquity * (1 - settings.dailyLossLimitPct / 100)) dailyHalt = true;
      if (maxDrawdownPct >= settings.maxDrawdownPct) drawdownHalt = true;
    }
    if (position) closePosition(closed[closed.length - 1].close, 'Backtest end', closed[closed.length - 1].time);
    peak = Math.max(peak, cash);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - cash) / peak * 100 : 0);
    const finalEquity = cash;
    const wins = trades.filter((trade) => trade.pnl > 0).length;
    const grossProfit = trades.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
    const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
    const benchmark = (closed[closed.length - 1].close / closed[validationStart].close - 1) * 100;
    const totalReturnPct = (finalEquity / 10000 - 1) * 100;
    return {
      pairKey: market.pairKey,
      display: market.display,
      strategy,
      strategyLabel: STRATEGIES.find((item) => item.id === strategy)?.label || strategy,
      interval: `${settings.intervalMinutes}m`,
      candles: closed.length,
      validationCandles: closed.length - validationStart,
      validationStart: closed[validationStart].time,
      validationEnd: closed[closed.length - 1].time,
      holdoutReturnPct: totalReturnPct,
      holdoutMaxDrawdownPct: maxDrawdownPct,
      holdoutTrades: trades.length,
      holdoutWinRatePct: trades.length ? wins / trades.length * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
      buyHoldReturnPct: benchmark,
      feeBps: settings.feeBps,
      assumedSpreadBps: settings.assumedSpreadBps,
      slippageBps: settings.slippageBps,
      lastClosedCandleAt: closed[closed.length - 1].time,
      screenScore: market.screenScore,
      volumeUsd: market.volumeUsd,
      rankScore: totalReturnPct - maxDrawdownPct * 0.5,
    };
  }

  async function fetchCandles(market, interval = state.settings.intervalMinutes) {
    const result = await publicRequest('OHLC', { pair: market.altname, interval: String(interval) });
    const rows = Object.entries(result || {}).find(([key, value]) => key !== 'last' && Array.isArray(value))?.[1];
    if (!rows) throw new Error(`No OHLC history returned for ${market.display}.`);
    return rows.map((row) => ({
      time: Number(row[0]) * 1000,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[6]),
    })).filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite));
  }

  async function backtestAll(onProgress = () => {}) {
    if (state.backtestRunning) throw new Error('A Kraken backtest is already running.');
    if (state.botActive || Object.keys(state.positions).length) throw new Error('Pause the bot and wait until positions are closed before rerunning backtests.');
    if (!state.markets.length) await scan();
    const eligible = state.markets.filter((market) => market.eligible).sort((a, b) => (b.volumeUsd || 0) - (a.volumeUsd || 0));
    if (!eligible.length) throw new Error('No online Kraken USD/USDT spot pairs were found.');
    backtestCancelled = false;
    state.backtests = {};
    state.latestSignals = {};
    state.latestAnalysis = {};
    state.backtestRunning = true;
    state.backtestProgress = { done: 0, total: eligible.length, pair: '' };
    persist();
    emit();
    let completed = 0;
    try {
      for (const market of eligible) {
        if (backtestCancelled) break;
        state.backtestProgress = { done: completed, total: eligible.length, pair: market.display };
        emit();
        try {
          const candles = await fetchCandles(market, state.settings.intervalMinutes);
          const results = STRATEGIES.map((strategy) => executeBacktest(candles, market, state.settings, strategy.id));
          const available = results.filter((result) => !result.error);
          if (!available.length) {
            state.backtests[market.pairKey] = { pairKey: market.pairKey, display: market.display, error: results[0]?.error || 'No strategy results.' };
          } else {
            const qualified = available.filter((result) => result.holdoutTrades >= 2
              && result.holdoutReturnPct > 0
              && result.holdoutMaxDrawdownPct < state.settings.maxDrawdownPct);
            const traded = available.filter((result) => result.holdoutTrades >= 2);
            const selectionPool = qualified.length ? qualified : traded.length ? traded : available;
            const best = [...selectionPool].sort((a, b) => b.rankScore - a.rankScore)[0];
            state.backtests[market.pairKey] = {
              ...best,
              strategyVariants: results.map((result) => result.error
                ? { strategy: result.strategy, strategyLabel: result.strategyLabel, error: result.error }
                : {
                    strategy: result.strategy,
                    strategyLabel: result.strategyLabel,
                    holdoutReturnPct: result.holdoutReturnPct,
                    holdoutMaxDrawdownPct: result.holdoutMaxDrawdownPct,
                    holdoutTrades: result.holdoutTrades,
                    holdoutWinRatePct: result.holdoutWinRatePct,
                  }),
            };
          }
          const selectedResult = state.backtests[market.pairKey];
          if (selectedResult && !selectedResult.error) {
            const analysis = analyzeClosedCandles(candles, selectedResult.strategy, backtestQualified(market.pairKey));
            state.latestAnalysis[market.pairKey] = analysis;
            state.latestSignals[market.pairKey] = analysis.signal;
          }
        } catch (error) {
          state.backtests[market.pairKey] = { pairKey: market.pairKey, display: market.display, error: error.message || 'Historical data unavailable.' };
        }
        completed += 1;
        state.backtestProgress = { done: completed, total: eligible.length, pair: market.display };
        if (completed % 5 === 0) {
          persist();
          emit();
        }
      }
      persist();
    } finally {
      state.backtestRunning = false;
      state.backtestProgress = { done: completed, total: eligible.length, pair: backtestCancelled ? 'Stopped by user' : 'Complete' };
      emit();
    }
    return getSnapshot();
  }

  function cancelBacktest() {
    backtestCancelled = true;
  }

  function botEquity() {
    return state.cash + Object.values(state.positions).reduce((sum, position) => sum + position.qty * position.markPrice, 0);
  }

  function botRisk(position) {
    return Math.max(0, position.entryPrice - position.stopPrice) * position.qty + position.entryFeeRemaining
      + position.qty * position.stopPrice * state.settings.feeBps / 10000;
  }

  function rollDay() {
    if (state.dayKey !== utcDay()) {
      state.dayKey = utcDay();
      state.dayStartEquity = botEquity();
    }
  }

  function enforceBotLimits() {
    rollDay();
    const equity = botEquity();
    if (!state.autoHaltReason && equity - state.dayStartEquity <= -state.dayStartEquity * state.settings.dailyLossLimitPct / 100) {
      state.autoHaltReason = 'Daily loss limit reached';
    }
    if (!state.autoHaltReason && state.highWaterMark > 0 && (state.highWaterMark - equity) / state.highWaterMark * 100 >= state.settings.maxDrawdownPct) {
      state.autoHaltReason = 'Maximum drawdown reached';
    }
    const cap = equity * state.settings.riskPct / 100;
    if (!state.autoHaltReason && Object.values(state.positions).some((position) => botRisk(position) > cap + 1e-8)) {
      state.autoHaltReason = 'Per-position risk limit exceeded';
    }
    if (state.autoHaltReason) {
      state.botEntriesEnabled = false;
      state.botStatus = `Halted · ${state.autoHaltReason}`;
    }
  }

  function floorQuantity(value, decimals) {
    const factor = 10 ** Math.min(12, Math.max(0, Number(decimals) || 0));
    return Math.floor(value * factor) / factor;
  }

  function appendTrade(market, side, qty, price, fee, realizedPnl, reason) {
    state.trades.unshift({
      timestamp: new Date().toISOString(),
      pairKey: market.pairKey,
      display: market.display,
      side,
      qty,
      price,
      fee,
      realizedPnl,
      reason,
      paperOnly: true,
    });
    state.trades = state.trades.slice(0, 1000);
  }

  function paperBuy(market, candles) {
    const current = state.markets.find((item) => item.pairKey === market.pairKey);
    if (!current || !current.eligible || state.positions[market.pairKey]) return false;
    if (current.spreadBps > state.settings.maxSpreadBps || (current.volumeUsd || 0) < state.settings.minVolumeUsd) return false;
    if (Object.keys(state.positions).length >= state.settings.maxPositions) return false;
    const metrics = indicators(candles.slice(0, -1));
    const i = candles.length - 2;
    const strategy = state.backtests[market.pairKey]?.strategy || 'ema-trend';
    if (!entrySignal(candles.slice(0, -1), metrics, i, strategy)) return false;
    const stopDistance = metrics.atr[i] * 2;
    const entryPrice = current.askPrice * (1 + state.settings.slippageBps / 10000);
    const stopPrice = entryPrice - stopDistance;
    if (!(stopPrice > 0 && stopPrice < entryPrice)) return false;
    const accountEquity = botEquity();
    const riskBudget = accountEquity * state.settings.riskPct / 100;
    const feeRate = state.settings.feeBps / 10000;
    const riskPerUnit = stopDistance + (entryPrice + stopPrice) * feeRate;
    const availableLiquidity = current.askQty * state.settings.liquidityParticipationPct / 100;
    let qty = Math.min(riskBudget / riskPerUnit, state.cash / (entryPrice * (1 + feeRate)), availableLiquidity);
    qty = floorQuantity(qty, current.lotDecimals);
    const notional = qty * entryPrice;
    if (qty < current.orderMin || notional < current.costMin || notional <= 0) return false;
    const fee = notional * feeRate;
    state.cash -= notional + fee;
    state.positions[current.pairKey] = {
      pairKey: current.pairKey,
      display: current.display,
      base: current.base,
      quote: current.quote,
      qty,
      entryPrice,
      markPrice: current.last,
      stopPrice,
      entryFeeRemaining: fee,
      openedAt: new Date().toISOString(),
      lastClosedCandleAt: candles[candles.length - 2].time,
    };
    appendTrade(current, 'BUY', qty, entryPrice, fee, 0, `${state.settings.intervalMinutes}m ${strategy} entry`);
    return true;
  }

  function paperSell(market, reason) {
    const position = state.positions[market.pairKey];
    const current = state.markets.find((item) => item.pairKey === market.pairKey);
    if (!position || !current) return false;
    const fillQty = floorQuantity(Math.min(position.qty, current.bidQty * state.settings.liquidityParticipationPct / 100), current.lotDecimals);
    if (!(fillQty > 0)) return false;
    const fillPrice = current.bidPrice * (1 - state.settings.slippageBps / 10000);
    const notional = fillQty * fillPrice;
    const fee = notional * state.settings.feeBps / 10000;
    const entryFee = position.entryFeeRemaining * (fillQty / position.qty);
    const pnl = fillQty * (fillPrice - position.entryPrice) - entryFee - fee;
    state.cash += notional - fee;
    position.qty -= fillQty;
    position.entryFeeRemaining -= entryFee;
    appendTrade(current, 'SELL', fillQty, fillPrice, fee, pnl, reason);
    if (position.qty <= 1e-10) delete state.positions[market.pairKey];
    return true;
  }

  function updatePositionMarks() {
    for (const [pairKey, position] of Object.entries(state.positions)) {
      const market = state.markets.find((item) => item.pairKey === pairKey);
      if (market) position.markPrice = market.last;
    }
    state.highWaterMark = Math.max(state.highWaterMark, botEquity());
    enforceBotLimits();
  }

  function backtestQualified(pairKey) {
    const result = state.backtests[pairKey];
    return result && !result.error && result.holdoutTrades >= 2 && result.holdoutReturnPct > 0
      && result.holdoutMaxDrawdownPct < state.settings.maxDrawdownPct;
  }

  function candidateMarkets() {
    return state.markets.filter((market) => market.eligible && backtestQualified(market.pairKey))
      .sort((a, b) => {
        const first = state.backtests[b.pairKey].rankScore - state.backtests[a.pairKey].rankScore;
        return first || (b.volumeUsd || 0) - (a.volumeUsd || 0);
      }).slice(0, Math.max(1, state.settings.scanCandidates));
  }

  async function botCycle() {
    if (!state.botActive || botCycleRunning) return;
    botCycleRunning = true;
    try {
      await scan();
      if (!state.botActive) return;
      const selected = candidateMarkets();
      const open = Object.keys(state.positions).map((pairKey) => state.markets.find((item) => item.pairKey === pairKey)).filter(Boolean);
      const pairs = [...new Map([...selected, ...open].map((market) => [market.pairKey, market])).values()];
      const fresh = new Map();
      const cycleErrors = [];
      for (const market of pairs) {
        if (!state.botActive) break;
        try {
          fresh.set(market.pairKey, await fetchCandles(market, state.settings.intervalMinutes));
        } catch (error) {
          cycleErrors.push(`${market.display}: ${error.message}`);
        }
      }
      if (!state.botActive) return;
      updatePositionMarks();
      for (const [pairKey, candles] of fresh) {
        const market = state.markets.find((item) => item.pairKey === pairKey);
        if (!market || candles.length < 121) continue;
        const closed = candles.slice(0, -1);
        const latest = closed[closed.length - 1];
        const position = state.positions[pairKey];
        const strategy = state.backtests[pairKey]?.strategy || 'ema-trend';
        const analysis = analyzeClosedCandles(candles, strategy, backtestQualified(pairKey));
        state.latestAnalysis[pairKey] = analysis;
        state.latestSignals[pairKey] = analysis.signal;
        const shouldEnter = analysis.shouldEnter;
        const shouldExit = analysis.shouldExit;
        if (position && market.last <= position.stopPrice) {
          paperSell(market, 'ATR protective stop');
          state.lastSignalAt[pairKey] = latest.time;
          continue;
        }
        if (position && shouldExit) {
          paperSell(market, `${state.settings.intervalMinutes}m ${strategy} exit`);
          state.lastSignalAt[pairKey] = latest.time;
          continue;
        }
        const previouslyProcessed = state.lastSignalAt[pairKey];
        if (!position && state.botEntriesEnabled && !state.autoHaltReason && latest.time !== previouslyProcessed
          && shouldEnter && backtestQualified(pairKey)) {
          paperBuy(market, candles);
        }
        state.lastSignalAt[pairKey] = latest.time;
      }
      updatePositionMarks();
      enforceBotLimits();
      if (!state.botEntriesEnabled && !Object.keys(state.positions).length) {
        state.botActive = false;
        if (botTimer) window.clearInterval(botTimer);
        botTimer = null;
        if (!state.autoHaltReason) state.botStatus = 'Paused · no open positions';
      }
      state.lastCycleAt = new Date().toISOString();
      state.botError = cycleErrors.length ? cycleErrors.slice(0, 3).join(' · ') : null;
      if (state.botActive && !state.autoHaltReason) {
        state.botStatus = state.botEntriesEnabled ? `Monitoring ${pairs.length} backtested pairs` : `Managing ${Object.keys(state.positions).length} open paper positions · entries paused`;
      }
      persist();
    } catch (error) {
      state.botError = error.message || 'Paper bot cycle failed.';
      state.botStatus = 'Paused after data error';
      state.botEntriesEnabled = false;
      if (!Object.keys(state.positions).length) {
        state.botActive = false;
        if (botTimer) window.clearInterval(botTimer);
        botTimer = null;
      }
      persist();
    } finally {
      botCycleRunning = false;
      emit();
    }
  }

  function startBot() {
    if (state.backtestRunning) throw new Error('Wait for the backtest to finish before starting the paper bot.');
    const hasPositions = Object.keys(state.positions).length > 0;
    const candidates = candidateMarkets();
    if (state.autoHaltReason && !hasPositions) throw new Error(`${state.autoHaltReason}; reset the Kraken paper account before restarting.`);
    if (!state.markets.length && !hasPositions) throw new Error('Scan Kraken markets first.');
    if (!candidates.length && !hasPositions) throw new Error('No pairs passed the out-of-sample return, trade-count, and drawdown filters. Review costs or strategy assumptions; the bot will not force trades.');
    if (botTimer) window.clearInterval(botTimer);
    state.botActive = true;
    state.botEntriesEnabled = candidates.length > 0 && !state.autoHaltReason;
    state.botStatus = state.botEntriesEnabled ? 'Starting paper-only monitor' : 'Managing existing positions · entries disabled';
    state.botError = null;
    persist();
    emit();
    botCycle();
    botTimer = window.setInterval(botCycle, 20000);
  }

  function pauseEntries() {
    state.botEntriesEnabled = false;
    state.botStatus = 'Entries paused · protective exits still monitored while this page stays open';
    if (!Object.keys(state.positions).length) {
      state.botActive = false;
      if (botTimer) window.clearInterval(botTimer);
      botTimer = null;
    }
    persist();
    emit();
  }

  function stopOnPageHide() {
    backtestCancelled = true;
    state.botActive = false;
    state.botEntriesEnabled = false;
    state.botStatus = 'Paused · dashboard closed';
    if (botTimer) window.clearInterval(botTimer);
    botTimer = null;
    try { persist(); } catch { /* Best-effort save while closing the page. */ }
  }

  function updateSettings(values) {
    if (state.backtestRunning) throw new Error('Cancel the running backtest before changing assumptions.');
    const ranges = {
      feeBps: [0, 100],
      slippageBps: [0, 100],
      assumedSpreadBps: [0, 200],
      riskPct: [0.1, 2],
      dailyLossLimitPct: [0.5, 20],
      maxDrawdownPct: [1, 40],
      maxPositions: [1, 10],
      liquidityParticipationPct: [1, 25],
      maxSpreadBps: [1, 200],
      minVolumeUsd: [0, 1000000000],
      scanCandidates: [1, 10],
      intervalMinutes: [1, 5],
      startingBalance: [100, 100000000],
    };
    const next = { ...state.settings };
    for (const [key, range] of Object.entries(ranges)) {
      if (values[key] === undefined) continue;
      const number = Number(values[key]);
      if (!Number.isFinite(number) || number < range[0] || number > range[1]) throw new Error(`${key} must be between ${range[0]} and ${range[1]}.`);
      if (key === 'intervalMinutes' && ![1, 5].includes(number)) throw new Error('Scalping interval must be 1 or 5 minutes.');
      next[key] = number;
    }
    if (next.startingBalance !== state.settings.startingBalance && !Object.keys(state.positions).length && !state.trades.length) {
      state.cash = next.startingBalance;
      state.initialBalance = next.startingBalance;
      state.highWaterMark = next.startingBalance;
      state.dayStartEquity = next.startingBalance;
    }
    const settingsChanged = Object.keys(next).some((key) => next[key] !== state.settings[key]);
    state.settings = next;
    if (settingsChanged) {
      state.backtests = {};
      state.latestSignals = {};
      state.latestAnalysis = {};
      state.botEntriesEnabled = false;
      if (!Object.keys(state.positions).length) {
        state.botActive = false;
        if (botTimer) window.clearInterval(botTimer);
        botTimer = null;
      }
      state.botStatus = Object.keys(state.positions).length
        ? 'Settings changed · entries paused; existing positions are still monitored'
        : 'Settings changed · rerun backtests before enabling the bot';
    }
    enforceBotLimits();
    persist();
    emit();
  }

  function resetAccount() {
    backtestCancelled = true;
    const replacement = createState();
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, replacement);
    if (botTimer) window.clearInterval(botTimer);
    botTimer = null;
    persist();
    emit();
  }

  function getSnapshot() {
    const equity = botEquity();
    const positions = Object.values(state.positions).map((position) => ({
      ...position,
      marketValue: position.qty * position.markPrice,
      unrealizedPnl: position.qty * (position.markPrice - position.entryPrice) - position.entryFeeRemaining,
      openRisk: botRisk(position),
    }));
    const eligibleCount = state.markets.filter((market) => market.eligible).length;
    const backtestCount = Object.values(state.backtests).filter((result) => result && !result.error).length;
    const qualifiedCount = state.markets.filter((market) => market.eligible && backtestQualified(market.pairKey)).length;
    return {
      settings: state.settings,
      markets: state.markets,
      latestSignals: state.latestSignals || {},
      latestAnalysis: state.latestAnalysis || {},
      positions,
      trades: state.trades.slice(0, 30),
      backtests: state.backtests,
      eligibleCount,
      backtestCount,
      qualifiedCount,
      scanning: state.scanning,
      scanError: state.scanError,
      lastScanAt: state.lastScanAt,
      backtestRunning: state.backtestRunning,
      backtestProgress: state.backtestProgress,
      botActive: state.botActive,
      botEntriesEnabled: state.botEntriesEnabled,
      botStatus: state.botStatus,
      botError: state.botError,
      lastCycleAt: state.lastCycleAt,
      autoHaltReason: state.autoHaltReason,
      cash: state.cash,
      equity,
      dailyPnl: equity - state.dayStartEquity,
      dailyPnlPct: state.dayStartEquity ? (equity - state.dayStartEquity) / state.dayStartEquity * 100 : 0,
      drawdownPct: state.highWaterMark ? Math.max(0, (state.highWaterMark - equity) / state.highWaterMark * 100) : 0,
      highWaterMark: state.highWaterMark,
      initialBalance: state.initialBalance,
      quoteCurrency: 'USD-equivalent (USD/USDT quotes only; USDT≈USD)',
    };
  }

  window.addEventListener('pagehide', stopOnPageHide);
  window.NorthstarKrakenBot = {
    subscribe,
    getSnapshot,
    scan,
    backtestAll,
    cancelBacktest,
    startBot,
    pauseEntries,
    updateSettings,
    resetAccount,
  };
})();
