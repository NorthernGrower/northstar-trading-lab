(() => {
  const API = 'https://api.kraken.com/0/public';
  const STORAGE_KEY = 'northstar-kraken-paper-bot-v2';
  const QUOTE_ALLOWLIST = new Set(['USD', 'USDT']);
  const ENGINE_TICK_MS = 10000;
  const SIGNAL_CYCLE_MS = 20000;
  const MIN_SCAN_SECONDS = 20;
  const MAX_SCAN_SECONDS = 300;
  const MIN_ATR_PCT = 0.08;
  const MAX_ATR_PCT = 4;
  const MIN_CLOSED_CANDLES = 220;
  const COOLDOWN_BARS = 3;
  const MAX_HOLD_BARS = 96;
  const STRATEGY_NAME = 'Northstar Confluence v1';

  // Each tool contributes a directional vote; the weighted total is normalised to -100..+100.
  const WEIGHTS = {
    emaStack: 12,
    supertrend: 8,
    macd: 10,
    adx: 8,
    ichimoku: 7,
    donchian: 6,
    roc: 5,
    rsi: 8,
    stochastic: 6,
    cci: 4,
    williams: 3,
    mfi: 5,
    bollinger: 6,
    obv: 5,
    volume: 4,
    structure: 7,
    fibonacci: 6,
    vwap: 4,
    levels: 5,
    candles: 9,
  };
  const WEIGHT_TOTAL = Object.values(WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  const FACTOR_WEIGHTS = [
    { key: 'trend', label: 'Trend & structure', weight: 30, tools: ['emaStack', 'supertrend', 'adx', 'ichimoku', 'donchian', 'structure', 'levels'] },
    { key: 'momentum', label: 'Momentum', weight: 22, tools: ['macd', 'roc', 'rsi', 'stochastic', 'cci', 'williams'] },
    { key: 'volume', label: 'Volume flow', weight: 19, tools: ['mfi', 'obv', 'volume', 'vwap'] },
    { key: 'location', label: 'Entry location', weight: 19, tools: ['bollinger', 'fibonacci', 'candles'] },
    { key: 'risk', label: 'Risk & tradability', weight: 10, tools: [] },
  ];
  const FACTOR_GROUPS = [
    { id: 'trend', label: 'Trend & structure', weight: 30, tools: ['emaStack', 'supertrend', 'adx', 'ichimoku', 'donchian', 'structure', 'levels'] },
    { id: 'momentum', label: 'Momentum', weight: 22, tools: ['macd', 'roc', 'rsi', 'stochastic', 'cci', 'williams'] },
    { id: 'volume', label: 'Volume flow', weight: 19, tools: ['mfi', 'obv', 'volume', 'vwap'] },
    { id: 'location', label: 'Entry location', weight: 19, tools: ['bollinger', 'fibonacci', 'candles'] },
    { id: 'risk', label: 'Risk & tradability', weight: 10, tools: [] },
  ];

  const DEFAULT_SETTINGS = {
    feeBps: 26,
    slippageBps: 8,
    riskPct: 1,
    dailyLossLimitPct: 5,
    maxDrawdownPct: 15,
    maxPositions: 3,
    liquidityParticipationPct: 5,
    maxSpreadBps: 40,
    minVolumeUsd: 200000,
    scanPairs: 5,
    intervalMinutes: 5,
    autoScanSeconds: 60,
    entryScore: 45,
    exitScore: 5,
    startingBalance: 10000,
  };

  const listeners = new Set();
  let requestQueue = Promise.resolve();
  let lastRequestAt = 0;
  let scanPromise = null;
  let signalCycleRunning = false;
  let engineTimer = null;
  let engineBusy = false;
  let focusQueue = new Set();

  function utcDay() {
    return new Date().toISOString().slice(0, 10);
  }

  function clamp(value, low = 0, high = 100) {
    return Math.max(low, Math.min(high, value));
  }

  function createState() {
    const balance = DEFAULT_SETTINGS.startingBalance;
    return {
      version: 2,
      settings: { ...DEFAULT_SETTINGS },
      cash: balance,
      initialBalance: balance,
      positions: {},
      trades: [],
      pairMeta: [],
      pairMetaFetchedAt: null,
      markets: [],
      latestAnalysis: {},
      rotationIndex: 0,
      lastExitAt: {},
      scanning: false,
      scanError: null,
      lastScanAt: null,
      lastScanTs: 0,
      dataStale: false,
      scanFailures: 0,
      lastSignalCycleAt: null,
      entriesEnabled: true,
      haltedReason: null,
      botStatus: 'Scanning Kraken spot markets automatically',
      botError: null,
      highWaterMark: balance,
      dayKey: utcDay(),
      dayStartEquity: balance,
      updatedAt: new Date().toISOString(),
    };
  }

  function loadState() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (stored?.version === 2 && typeof stored.cash === 'number') {
        const loaded = { ...createState(), ...stored, settings: { ...DEFAULT_SETTINGS, ...stored.settings } };
        loaded.scanning = false;
        loaded.entriesEnabled = Boolean(stored.entriesEnabled);
        loaded.botStatus = 'Auto scanner starting · confluence strategy armed';
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
    // Quotes and analyses are rebuilt from Kraken on every load; keeping them out of storage
    // avoids exhausting the browser quota as hundreds of pairs accumulate.
    const lightweight = { ...state, markets: [], latestAnalysis: {} };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lightweight));
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

  function marketQuality(market) {
    const volumeScore = market.volumeUsd === null ? 0 : clamp((Math.log10(Math.max(1, market.volumeUsd)) - 3) / 5 * 100);
    const spreadScore = clamp(100 - market.spreadBps * 2);
    const momentumScore = clamp(50 + market.todayChangePct * 2);
    return 0.45 * volumeScore + 0.4 * spreadScore + 0.15 * momentumScore;
  }

  /* ---------------------------- indicator maths --------------------------- */

  function ema(values, period) {
    const output = Array(values.length).fill(null);
    if (values.length < period) return output;
    const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    output[period - 1] = seed;
    const multiplier = 2 / (period + 1);
    for (let i = period; i < values.length; i += 1) output[i] = values[i] * multiplier + output[i - 1] * (1 - multiplier);
    return output;
  }

  function sma(values, period) {
    const output = Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) output[i] = sum / period;
    }
    return output;
  }

  function stdev(values, period) {
    const output = Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i += 1) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j += 1) sum += values[j];
      const mean = sum / period;
      let variance = 0;
      for (let j = i - period + 1; j <= i; j += 1) variance += (values[j] - mean) ** 2;
      output[i] = Math.sqrt(variance / period);
    }
    return output;
  }

  function rsiSeries(closes, period = 14) {
    const output = Array(closes.length).fill(null);
    if (closes.length <= period) return output;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i += 1) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    gains /= period;
    losses /= period;
    output[period] = losses === 0 ? (gains === 0 ? 50 : 100) : 100 - 100 / (1 + gains / losses);
    for (let i = period + 1; i < closes.length; i += 1) {
      const change = closes[i] - closes[i - 1];
      gains = (gains * (period - 1) + Math.max(0, change)) / period;
      losses = (losses * (period - 1) + Math.max(0, -change)) / period;
      output[i] = losses === 0 ? (gains === 0 ? 50 : 100) : 100 - 100 / (1 + gains / losses);
    }
    return output;
  }

  function atrSeries(candles, period = 14) {
    const output = Array(candles.length).fill(null);
    if (candles.length <= period) return output;
    const trueRanges = candles.map((candle, index) => (index === 0
      ? candle.high - candle.low
      : Math.max(candle.high - candle.low, Math.abs(candle.high - candles[index - 1].close), Math.abs(candle.low - candles[index - 1].close))));
    let value = trueRanges.slice(1, period + 1).reduce((sum, item) => sum + item, 0) / period;
    output[period] = value;
    for (let i = period + 1; i < candles.length; i += 1) {
      value = (value * (period - 1) + trueRanges[i]) / period;
      output[i] = value;
    }
    return output;
  }

  function macdSeries(closes) {
    const fast = ema(closes, 12);
    const slow = ema(closes, 26);
    const macd = Array(closes.length).fill(null);
    const compact = [];
    const indices = [];
    for (let i = 0; i < closes.length; i += 1) {
      if (Number.isFinite(fast[i]) && Number.isFinite(slow[i])) {
        macd[i] = fast[i] - slow[i];
        compact.push(macd[i]);
        indices.push(i);
      }
    }
    const signal = Array(closes.length).fill(null);
    const compactSignal = ema(compact, 9);
    compactSignal.forEach((value, index) => {
      if (Number.isFinite(value)) signal[indices[index]] = value;
    });
    return { macd, signal };
  }

  function stochasticSeries(candles, period = 14, smoothing = 3) {
    const length = candles.length;
    const k = Array(length).fill(null);
    const d = Array(length).fill(null);
    for (let i = period - 1; i < length; i += 1) {
      let high = -Infinity;
      let low = Infinity;
      for (let j = i - period + 1; j <= i; j += 1) {
        high = Math.max(high, candles[j].high);
        low = Math.min(low, candles[j].low);
      }
      k[i] = high - low > 0 ? (candles[i].close - low) / (high - low) * 100 : 50;
    }
    for (let i = 0; i < length; i += 1) {
      const window = [];
      for (let j = i - smoothing + 1; j <= i; j += 1) if (Number.isFinite(k[j])) window.push(k[j]);
      if (window.length === smoothing) d[i] = window.reduce((sum, value) => sum + value, 0) / smoothing;
    }
    return { k, d };
  }

  function bollingerSeries(closes, period = 20, multiplier = 2) {
    const mid = sma(closes, period);
    const deviation = stdev(closes, period);
    return {
      mid,
      upper: mid.map((value, index) => (Number.isFinite(value) ? mid[index] + multiplier * deviation[index] : null)),
      lower: mid.map((value, index) => (Number.isFinite(value) ? value - multiplier * deviation[index] : null)),
    };
  }

  function adxSeries(candles, period = 14) {
    const length = candles.length;
    const adx = Array(length).fill(null);
    const plusDI = Array(length).fill(null);
    const minusDI = Array(length).fill(null);
    const dx = Array(length).fill(null);
    if (length < period + 2) return { adx, plusDI, minusDI };
    let smoothedTr = 0;
    let smoothedPlus = 0;
    let smoothedMinus = 0;
    for (let i = 1; i < length; i += 1) {
      const upMove = candles[i].high - candles[i - 1].high;
      const downMove = candles[i - 1].low - candles[i].low;
      const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
      const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
      const trueRange = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
      if (i <= 14) {
        smoothedTr += trueRange;
        smoothedPlus += plusDm;
        smoothedMinus += minusDm;
        if (i === 14) {
          smoothedTr /= 14;
          smoothedPlus /= 14;
          smoothedMinus /= 14;
          applyDirectional(i);
        }
        continue;
      }
      smoothedTr = smoothedTr - smoothedTr / 14 + trueRange;
      smoothedPlus = smoothedPlus - smoothedPlus / 14 + plusDm;
      smoothedMinus = smoothedMinus - smoothedMinus / 14 + minusDm;
      applyDirectional(i);
    }
    function applyDirectional(index) {
      const trAverage = smoothedTr;
      const averagePlus = smoothedPlus;
      const averageMinus = smoothedMinus;
      plusDI[index] = trAverage > 0 ? 100 * averagePlus / trAverage : 0;
      minusDI[index] = trAverage > 0 ? 100 * averageMinus / trAverage : 0;
      const sum = plusDI[index] + minusDI[index];
      dx[index] = sum > 0 ? 100 * Math.abs(plusDI[index] - minusDI[index]) / sum : 0;
    }
    let seedSum = 0;
    let seedCount = 0;
    let adxValue = null;
    for (let i = 14; i < length; i += 1) {
      if (!Number.isFinite(dx[i])) continue;
      if (adxValue === null) {
        seedSum += dx[i];
        seedCount += 1;
        if (seedCount === 14) {
          adxValue = seedSum / 14;
          adx[i] = adxValue;
        }
        continue;
      }
      adxValue = (adxValue * 13 + dx[i]) / 14;
      adx[i] = adxValue;
    }
    return { adx, plusDI, minusDI };
  }

  function cciSeries(candles, period = 20) {
    const length = candles.length;
    const output = Array(length).fill(null);
    const typical = candles.map((candle) => (candle.high + candle.low + candle.close) / 3);
    for (let i = period - 1; i < length; i += 1) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j += 1) sum += typical[j];
      const mean = sum / period;
      let deviation = 0;
      for (let j = i - period + 1; j <= i; j += 1) deviation += Math.abs(typical[j] - mean);
      const meanDeviation = deviation / period;
      output[i] = meanDeviation > 0 ? (typical[i] - mean) / (0.015 * meanDeviation) : 0;
    }
    return output;
  }

  function williamsSeries(candles, period = 14) {
    const length = candles.length;
    const output = Array(length).fill(null);
    for (let i = period - 1; i < length; i += 1) {
      let high = -Infinity;
      let low = Infinity;
      for (let j = i - period + 1; j <= i; j += 1) {
        high = Math.max(high, candles[j].high);
        low = Math.min(low, candles[j].low);
      }
      output[i] = high - low > 0 ? -100 * (high - candles[i].close) / (high - low) : -50;
    }
    return output;
  }

  function mfiSeries(candles, period = 14) {
    const length = candles.length;
    const output = Array(length).fill(null);
    const typical = candles.map((candle) => (candle.high + candle.low + candle.close) / 3);
    for (let i = period; i < length; i += 1) {
      let positive = 0;
      let negative = 0;
      for (let j = i - period + 1; j <= i; j += 1) {
        const flow = typical[j] * candles[j].volume;
        if (typical[j] >= typical[j - 1]) positive += flow;
        else negative += flow;
      }
      output[i] = negative === 0 ? 100 : (positive === 0 ? 0 : 100 - 100 / (1 + positive / negative));
    }
    return output;
  }

  function obvSeries(candles) {
    const output = Array(candles.length).fill(0);
    for (let i = 1; i < candles.length; i += 1) {
      const change = candles[i].close - candles[i - 1].close;
      output[i] = output[i - 1] + (change > 0 ? candles[i].volume : change < 0 ? -candles[i].volume : 0);
    }
    return output;
  }

  function rocSeries(closes, period = 10) {
    const output = Array(closes.length).fill(null);
    for (let i = period; i < closes.length; i += 1) {
      const base = closes[i - period];
      output[i] = base > 0 ? (closes[i] / base - 1) * 100 : null;
    }
    return output;
  }

  function donchianSeries(candles, period = 20) {
    const length = candles.length;
    const high = Array(length).fill(null);
    const low = Array(length).fill(null);
    for (let i = period; i < length; i += 1) {
      let highest = -Infinity;
      let lowest = Infinity;
      for (let j = i - period; j < i; j += 1) {
        highest = Math.max(highest, candles[j].high);
        lowest = Math.min(lowest, candles[j].low);
      }
      high[i] = highest;
      low[i] = lowest;
    }
    return { high, low };
  }

  function ichimokuSeries(candles) {
    const length = candles.length;
    const midpoint = (index, period) => {
      if (index < period - 1) return null;
      let high = -Infinity;
      let low = Infinity;
      for (let j = index - period + 1; j <= index; j += 1) {
        high = Math.max(high, candles[j].high);
        low = Math.min(low, candles[j].low);
      }
      return (high + low) / 2;
    };
    const tenkan = Array(length).fill(null);
    const kijun = Array(length).fill(null);
    const spanA = Array(length).fill(null);
    const spanB = Array(length).fill(null);
    for (let i = 0; i < length; i += 1) {
      tenkan[i] = midpoint(i, 9);
      kijun[i] = midpoint(i, 26);
      spanA[i] = Number.isFinite(tenkan[i]) && Number.isFinite(kijun[i]) ? (tenkan[i] + kijun[i]) / 2 : null;
      spanB[i] = midpoint(i, 52);
    }
    return { tenkan, kijun, spanA, spanB };
  }

  function vwapSeries(candles) {
    const output = Array(candles.length).fill(null);
    let day = null;
    let priceVolume = 0;
    let volume = 0;
    for (let i = 0; i < candles.length; i += 1) {
      const key = new Date(candles[i].time).toISOString().slice(0, 10);
      if (key !== day) {
        day = key;
        priceVolume = 0;
        volume = 0;
      }
      const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
      priceVolume += typical * candles[i].volume;
      volume += candles[i].volume;
      output[i] = volume > 0 ? priceVolume / volume : null;
    }
    return output;
  }

  function supertrendSeries(candles, atr, multiplier = 3) {
    const length = candles.length;
    const trend = Array(length).fill(0);
    const band = Array(length).fill(null);
    let finalUpper = null;
    let finalLower = null;
    let direction = 1;
    for (let i = 0; i < length; i += 1) {
      const atrValue = atr[i];
      if (!Number.isFinite(atrValue)) continue;
      const mid = (candles[i].high + candles[i].low) / 2;
      const basicUpper = mid + multiplier * atrValue;
      const basicLower = mid - multiplier * atrValue;
      if (finalUpper === null || finalLower === null) {
        finalUpper = basicUpper;
        finalLower = basicLower;
        direction = 1;
      } else {
        finalUpper = candles[i - 1].close <= finalUpper ? Math.min(basicUpper, finalUpper) : basicUpper;
        finalLower = candles[i - 1].close >= finalLower ? Math.max(basicLower, finalLower) : basicLower;
        if (candles[i].close > finalUpper) direction = 1;
        else if (candles[i].close < finalLower) direction = -1;
      }
      trend[i] = direction;
      band[i] = direction === 1 ? finalLower : finalUpper;
    }
    return { trend, band };
  }

  function swingSeries(candles, windowSize = 3) {
    const length = candles.length;
    const history = Array(length).fill(null);
    const events = Array(length).fill(null);
    let swings = [];
    for (let center = windowSize; center < length - windowSize; center += 1) {
      let isHigh = true;
      let isLow = true;
      for (let offset = -windowSize; offset <= windowSize; offset += 1) {
        if (offset === 0) continue;
        const neighbour = candles[center + offset];
        if (candles[center].high <= neighbour.high) isHigh = false;
        if (candles[center].low >= neighbour.low) isLow = false;
      }
      if (isHigh === isLow) continue;
      events[center + windowSize] = {
        type: isHigh ? 'HIGH' : 'LOW',
        price: isHigh ? candles[center].high : candles[center].low,
        index: center,
      };
    }
    for (let i = 0; i < length; i += 1) {
      const event = events[i];
      if (event) {
        const last = swings[swings.length - 1];
        if (last?.type === event.type) {
          if ((event.type === 'HIGH' && event.price > last.price) || (event.type === 'LOW' && event.price < last.price)) swings[swings.length - 1] = event;
        } else {
          swings.push(event);
          swings = swings.slice(-8);
        }
      }
      history[i] = swings.map((point) => ({ ...point }));
    }
    return history;
  }

  function candleShape(candle) {
    const body = Math.abs(candle.close - candle.open);
    const range = Math.max(1e-12, candle.high - candle.low);
    return {
      body,
      range,
      upper: candle.high - Math.max(candle.open, candle.close),
      lower: Math.min(candle.open, candle.close) - candle.low,
      bullish: candle.close > candle.open,
      bearish: candle.close < candle.open,
      bodyRatio: body / range,
    };
  }

  function detectPatterns(candles, index) {
    const found = [];
    if (index < 4) return found;
    const current = candles[index];
    const previous = candles[index - 1];
    const before = candles[index - 2];
    const shape = candleShape(current);
    const shapePrevious = candleShape(previous);
    const shapeBefore = candleShape(before);
    const closes = candles.slice(Math.max(0, index - 8), index).map((candle) => candle.close);
    const downtrend = closes.length >= 5 && closes[closes.length - 1] < closes[0];
    const uptrend = closes.length >= 5 && closes[closes.length - 1] > closes[0];
    const add = (name, bias, note) => found.push({ name, bias, note });

    if (shapePrevious.bearish && shape.bullish && current.close > previous.open && current.open <= previous.close && shape.bodyRatio > 0.45) {
      add('Bullish engulfing', 'bullish', 'Body engulfs the prior bearish candle.');
    }
    if (shapePrevious.bullish && shape.bearish && current.close < previous.open && current.open >= previous.close && shape.bodyRatio > 0.45) {
      add('Bearish engulfing', 'bearish', 'Body engulfs the prior bullish candle.');
    }
    if (shape.bodyRatio < 0.12) add('Doji', 'neutral', 'Indecision: open and close are almost equal.');
    if (shape.lower > shape.body * 2 && shape.upper < shape.body && downtrend) {
      add('Hammer', 'bullish', 'Long lower wick rejected lower prices after a decline.');
    }
    if (shape.upper > shape.body * 2 && shape.lower < shape.body && uptrend) {
      add('Shooting star', 'bearish', 'Long upper wick rejected higher prices after a rally.');
    }
    if (shapeBefore.bearish && shapeBefore.bodyRatio > 0.35 && shapePrevious.bodyRatio < 0.35 && shape.bullish
      && current.close > (before.open + before.close) / 2) {
      add('Morning star', 'bullish', 'Three-bar reversal after selling pressure.');
    }
    if (shapeBefore.bullish && shapeBefore.bodyRatio > 0.35 && shapePrevious.bodyRatio < 0.35 && shape.bearish
      && current.close < (before.open + before.close) / 2) {
      add('Evening star', 'bearish', 'Three-bar reversal after buying pressure.');
    }
    if (shapePrevious.bearish && shape.bullish && current.close > (previous.open + previous.close) / 2 && current.close < previous.open) {
      add('Piercing line', 'bullish', 'Closes above the midpoint of the prior down candle.');
    }
    if (shapePrevious.bullish && shape.bearish && current.close < (previous.open + previous.close) / 2 && current.close > previous.open) {
      add('Dark cloud cover', 'bearish', 'Closes below the midpoint of the prior up candle.');
    }
    if (shapePrevious.bearish && shape.bullish && current.open > previous.close && current.close < previous.open) {
      add('Bullish harami', 'bullish', 'Inside bar after a down candle.');
    }
    if (shapePrevious.bullish && shape.bearish && current.open < previous.close && current.close > previous.open) {
      add('Bearish harami', 'bearish', 'Inside bar after an up candle.');
    }
    if (Math.abs(current.low - previous.low) < shape.range * 0.1 && shapePrevious.bearish && shape.bullish) {
      add('Tweezer bottom', 'bullish', 'Matching lows rejected the same level twice.');
    }
    if (Math.abs(current.high - previous.high) < shape.range * 0.1 && shapePrevious.bullish && shape.bearish) {
      add('Tweezer top', 'bearish', 'Matching highs rejected the same level twice.');
    }
    const lastThree = candles.slice(index - 2, index + 1).map(candleShape);
    if (lastThree.every((item) => item.bullish) && current.close > previous.close && previous.close > before.close) {
      add('Three white soldiers', 'bullish', 'Three consecutive rising bullish closes.');
    }
    if (lastThree.every((item) => item.bearish) && current.close < previous.close && previous.close < before.close) {
      add('Three black crows', 'bearish', 'Three consecutive lower closes.');
    }
    if (shape.bodyRatio > 0.85) add(shape.bullish ? 'Bullish marubozu' : 'Bearish marubozu', shape.bullish ? 'bullish' : 'bearish', 'Almost no wick: one side controlled the bar.');
    return found;
  }

  function fibContext(candles, swings, index) {
    const highs = swings.filter((point) => point.type === 'HIGH');
    const lows = swings.filter((point) => point.type === 'LOW');
    const higherHighs = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
    const higherLows = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price;
    const lowerHighs = highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price;
    const lowerLows = lows.length >= 2 && lows[lows.length - 1].price < lows[lows.length - 2].price;
    let swingHigh = null;
    let swingLow = null;
    let highIndex = -1;
    for (let i = swings.length - 1; i >= 0; i -= 1) {
      if (swings[i].type === 'HIGH') { swingHigh = swings[i]; highIndex = i; break; }
    }
    for (let i = highIndex - 1; i >= 0; i -= 1) {
      if (swings[i].type === 'LOW' && swings[i].price < (swingHigh?.price ?? Infinity)) { swingLow = swings[i]; break; }
    }
    let ratio = null;
    let level = null;
    let inZone = false;
    if (swingHigh && swingLow && swingHigh.price > swingLow.price) {
      ratio = (swingHigh.price - candles[index].close) / (swingHigh.price - swingLow.price);
      if (ratio >= 0 && ratio <= 1.2) {
        const levels = [{ ratio: 0.382, label: '38.2%' }, { ratio: 0.5, label: '50.0%' }, { ratio: 0.618, label: '61.8%' }];
        const nearest = levels.reduce((best, item) => (Math.abs(item.ratio - ratio) < Math.abs(best.ratio - ratio) ? item : best));
        level = nearest.label;
        inZone = ratio >= 0.382 && ratio <= 0.618 && candles[index].close > swingLow.price;
      }
    }
    const impulseUp = higherHighs && higherLows;
    const waveLabel = impulseUp
      ? 'Higher highs and higher lows (impulse)'
      : lowerHighs && lowerLows
        ? 'Lower highs and lower lows (impulse down)'
        : swingHigh && swingLow && candles[index].close < swingHigh.price && candles[index].close > swingLow.price
          ? 'Swing pullback · unconfirmed'
          : 'Unclear pivot structure';
    return { impulseUp, lowerStructure: lowerHighs && lowerLows, swingHigh, swingLow, ratio, level, inZone, waveLabel };
  }

  function buildIndicators(candles) {
    const closes = candles.map((candle) => candle.close);
    const volumes = candles.map((candle) => candle.volume);
    const atr = atrSeries(candles);
    const macd = macdSeries(closes);
    return {
      closes,
      ema9: ema(closes, 9),
      ema20: ema(closes, 20),
      ema21: ema(closes, 21),
      ema50: ema(closes, 50),
      ema200: ema(closes, 200),
      rsi: rsiSeries(closes),
      atr,
      macd: macd.macd,
      macdSignal: macd.signal,
      stochastic: stochasticSeries(candles),
      bollinger: bollingerSeries(closes),
      adx: adxSeries(candles),
      cci: cciSeries(candles),
      williams: williamsSeries(candles),
      mfi: mfiSeries(candles),
      obv: obvSeries(candles),
      roc: rocSeries(closes),
      donchian: donchianSeries(candles),
      ichimoku: ichimokuSeries(candles),
      supertrend: supertrendSeries(candles, atr),
      vwap: vwapSeries(candles),
      volumeAverage: sma(volumes, 20),
      swings: swingSeries(candles),
    };
  }

  /* ----------------------------- the algorithm ---------------------------- */

  function analyzePair(candles, market, settings) {
    const closed = candles.slice(0, -1);
    if (closed.length < MIN_CLOSED_CANDLES) {
      return {
        available: false,
        reason: `Waiting for ${MIN_CLOSED_CANDLES - closed.length} more closed ${settings.intervalMinutes}m candles before scoring.`,
      };
    }
    const ind = buildIndicators(closed);
    const index = closed.length - 1;
    const price = closed[index].close;
    const atr = ind.atr[index];
    if (!Number.isFinite(atr) || atr <= 0) return { available: false, reason: 'ATR is unavailable for this pair.' };

    const votes = [];
    const vote = (key, label, value, note) => {
      if (!WEIGHTS[key]) return;
      votes.push({ key, label, vote: Math.round(clamp(value, -1, 1) * 100) / 100, weight: WEIGHTS[key], note });
    };

    const e9 = ind.ema9[index];
    const e21 = ind.ema21[index];
    const e50 = ind.ema50[index];
    const e200 = ind.ema200[index];
    if ([e9, e21, e50, e200].every(Number.isFinite)) {
      if (e9 > e21 && e21 > e50 && e50 > e200) vote('emaStack', 'EMA stack (9/21/50/200)', 1, 'Fully stacked upward: trend and momentum agree.');
      else if (e9 < e21 && e21 < e50 && e50 < e200) vote('emaStack', 'EMA stack (9/21/50/200)', -1, 'Fully stacked downward: every average is falling.');
      else if (e9 > e21 && e21 > e50) vote('emaStack', 'EMA stack (9/21/50/200)', 0.5, 'Short and medium averages are bullish; the 200 EMA disagrees.');
      else if (e9 < e21 && e21 < e50) vote('emaStack', 'EMA stack (9/21/50/200)', -0.5, 'Short and medium averages are bearish.');
      else vote('emaStack', 'EMA stack (9/21/50/200)', 0, 'Averages are tangled: no directional agreement.');
    }

    const trend = ind.supertrend.trend[index];
    if (trend) vote('supertrend', 'Supertrend (10, 3×ATR)', trend, trend > 0 ? 'Price is above the ATR trailing band.' : 'Price is below the ATR trailing band.');

    const macd = ind.macd[index];
    const macdSignal = ind.macdSignal[index];
    const previousMacd = ind.macd[index - 1];
    const previousSignal = ind.macdSignal[index - 1];
    if ([macd, macdSignal, previousMacd, previousSignal].every(Number.isFinite)) {
      const histogram = macd - macdSignal;
      const previousHistogram = previousMacd - previousSignal;
      if (macd > macdSignal && histogram > previousHistogram) vote('macd', 'MACD (12/26/9)', 1, 'MACD is above its signal line and the histogram is expanding.');
      else if (macd > macdSignal) vote('macd', 'MACD (12/26/9)', 0.5, 'MACD is above its signal line but momentum is fading.');
      else if (histogram < previousHistogram) vote('macd', 'MACD (12/26/9)', -1, 'MACD is below its signal line and the histogram is expanding downward.');
      else vote('macd', 'MACD (12/26/9)', -0.5, 'MACD is below its signal line.');
    }

    const adx = ind.adx.adx[index];
    const plusDI = ind.adx.plusDI[index];
    const minusDI = ind.adx.minusDI[index];
    if ([adx, plusDI, minusDI].every(Number.isFinite)) {
      if (plusDI > minusDI && adx >= 20) vote('adx', 'ADX / DI (14)', 1, `ADX ${adx.toFixed(0)} with +DI above -DI: a real trend is in force.`);
      else if (plusDI > minusDI) vote('adx', 'ADX / DI (14)', 0.5, `ADX ${adx.toFixed(0)}: upside bias but the trend is not yet established.`);
      else if (adx >= 20) vote('adx', 'ADX / DI (14)', -1, `ADX ${adx.toFixed(0)} with -DI above +DI: a downtrend is in force.`);
      else vote('adx', 'ADX / DI (14)', -0.5, `ADX ${adx.toFixed(0)}: weak upside edge is gone.`);
    }

    const spanA = ind.ichimoku.spanA[index - 26];
    const spanB = ind.ichimoku.spanB[index - 26];
    const tenkan = ind.ichimoku.tenkan[index];
    const kijun = ind.ichimoku.kijun[index];
    if ([spanA, spanB, tenkan, kijun].every(Number.isFinite)) {
      if (price > spanA && price > spanB && tenkan > kijun) vote('ichimoku', 'Ichimoku cloud', 1, 'Price is above the cloud with tenkan over kijun.');
      else if (price > spanA && price > spanB) vote('ichimoku', 'Ichimoku cloud', 0.5, 'Price is above the cloud but the tenkan/kijun cross is against it.');
      else if (price < spanA && price < spanB) vote('ichimoku', 'Ichimoku cloud', -1, 'Price is below the cloud.');
      else vote('ichimoku', 'Ichimoku cloud', 0, 'Price is inside the cloud: no clear side.');
    }

    const donchianHigh = ind.donchian.high[index];
    const donchianLow = ind.donchian.low[index];
    if (Number.isFinite(donchianHigh) && Number.isFinite(donchianLow) && donchianHigh > donchianLow) {
      if (price >= donchianHigh) vote('donchian', 'Donchian breakout (20)', 1, 'Price is at the prior 20-bar high.');
      else if (price <= donchianLow) vote('donchian', 'Donchian breakout (20)', -1, 'Price is at the prior 20-bar low.');
      else {
        const position = (price - donchianLow) / (donchianHigh - donchianLow);
        vote('donchian', 'Donchian breakout (20)', position > 0.7 ? 0.5 : position < 0.3 ? -0.5 : 0, `Price sits at ${(position * 100).toFixed(0)}% of the 20-bar range.`);
      }
    }

    const roc = ind.roc[index];
    if (Number.isFinite(roc)) vote('roc', 'Rate of change (10)', roc > 0.25 ? 1 : roc > 0 ? 0.5 : roc < -0.25 ? -1 : -0.5, `${roc >= 0 ? '+' : ''}${roc.toFixed(2)}% over 10 bars.`);

    const rsi = ind.rsi[index];
    if (Number.isFinite(rsi)) {
      if (rsi >= 78) vote('rsi', 'RSI (14)', -0.5, `${rsi.toFixed(0)} is overbought: chasing here is poor value.`);
      else if (rsi >= 58) vote('rsi', 'RSI (14)', 1, `${rsi.toFixed(0)} shows strong but not exhausted momentum.`);
      else if (rsi >= 50) vote('rsi', 'RSI (14)', 0.5, `${rsi.toFixed(0)} leans bullish.`);
      else if (rsi >= 42) vote('rsi', 'RSI (14)', -0.5, `${rsi.toFixed(0)} leans bearish.`);
      else vote('rsi', 'RSI (14)', -1, `${rsi.toFixed(0)} is weak.`);
    }

    const stochK = ind.stochastic.k[index];
    const stochD = ind.stochastic.d[index];
    const previousK = ind.stochastic.k[index - 1];
    const previousD = ind.stochastic.d[index - 1];
    if ([stochK, stochD, previousK, previousD].every(Number.isFinite)) {
      if (stochK > stochD && previousK <= previousD && stochK < 80) vote('stochastic', 'Stochastic (14, 3)', 1, 'Fresh bullish cross below the overbought zone.');
      else if (stochK > stochD && stochK < 80) vote('stochastic', 'Stochastic (14, 3)', 0.5, 'Stochastic is pointing up but not freshly crossed.');
      else if (stochK > 85) vote('stochastic', 'Stochastic (14, 3)', -0.5, 'Stochastic is pinned overbought.');
      else vote('stochastic', 'Stochastic (14, 3)', -0.5, 'Stochastic is pointing down.');
    }

    const cci = ind.cci[index];
    if (Number.isFinite(cci)) vote('cci', 'CCI (20)', cci > 100 ? 1 : cci > 0 ? 0.5 : cci < -100 ? -1 : -0.5, `CCI ${cci.toFixed(0)}.`);

    const williams = ind.williams[index];
    if (Number.isFinite(williams)) vote('williams', 'Williams %R (14)', williams > -20 ? -0.5 : williams > -50 ? 0.5 : williams > -80 ? -0.5 : 0.5, `%R ${williams.toFixed(0)}.`);

    const mfi = ind.mfi[index];
    if (Number.isFinite(mfi)) vote('mfi', 'Money flow index (14)', mfi >= 80 ? -0.5 : mfi >= 55 ? 1 : mfi >= 45 ? 0 : -0.5, `MFI ${mfi.toFixed(0)}: volume-weighted buying pressure.`);

    const upper = ind.bollinger.upper[index];
    const lower = ind.bollinger.lower[index];
    const middle = ind.bollinger.mid[index];
    let percentB = null;
    if ([upper, lower, middle].every(Number.isFinite) && upper > lower) {
      percentB = (price - lower) / (upper - lower);
      const bandwidth = (upper - lower) / middle * 100;
      if (percentB > 1) vote('bollinger', 'Bollinger (20, 2)', -0.5, 'Price is above the upper band: extended.');
      else if (percentB > 0.55) vote('bollinger', 'Bollinger (20, 2)', 1, `%B ${(percentB * 100).toFixed(0)} with a ${bandwidth.toFixed(2)}% band width.`);
      else if (percentB > 0.45) vote('bollinger', 'Bollinger (20, 2)', 0.5, `%B ${(percentB * 100).toFixed(0)}: mid-band.`);
      else if (percentB > 0.15) vote('bollinger', 'Bollinger (20, 2)', -0.5, `%B ${(percentB * 100).toFixed(0)}: lower half of the band.`);
      else vote('bollinger', 'Bollinger (20, 2)', -1, `%B ${(percentB * 100).toFixed(0)}: pressing the lower band.`);
    }

    const obv = ind.obv[index];
    const obvPast = ind.obv[index - 10];
    if (Number.isFinite(obv) && Number.isFinite(obvPast) && obv !== obvPast) {
      const rising = obv > obvPast;
      vote('obv', 'On-balance volume', rising ? 0.5 : -0.5, rising ? 'OBV has risen over the last 10 bars.' : 'OBV has fallen over the last 10 bars.');
    }

    const averageVolume = ind.volumeAverage[index];
    if (Number.isFinite(averageVolume) && averageVolume > 0) {
      const ratio = closed[index].volume / averageVolume;
      const bullish = closed[index].close >= closed[index].open;
      const value = ratio >= 1.3 ? (bullish ? 1 : -1) : ratio >= 1.05 ? (bullish ? 0.5 : -0.5) : 0;
      vote('volume', 'Volume vs 20-bar average', value, `${ratio.toFixed(2)}× average volume on the last closed bar.`);
    }

    const swings = ind.swings[index] || [];
    const fib = fibContext(closed, swings, index);
    vote('structure', 'Swing structure', fib.impulseUp ? 1 : fib.lowerStructure ? -1 : 0, fib.waveLabel);
    vote('fibonacci', 'Fibonacci retracement', fib.inZone && fib.impulseUp ? 1 : 0, fib.level ? `${fib.level} retracement${fib.inZone ? ' in the buy zone' : ' not in the 38.2–61.8% zone'}.` : 'No confirmed swing pair to measure.');

    const vwap = ind.vwap[index];
    if (Number.isFinite(vwap)) vote('vwap', 'Session VWAP', price >= vwap ? 1 : -0.5, `Price is ${price >= vwap ? 'above' : 'below'} the UTC session VWAP.`);

    const recent = closed.slice(-60);
    const rangeHigh = Math.max(...recent.map((candle) => candle.high));
    const rangeLow = Math.min(...recent.map((candle) => candle.low));
    const rangePosition = rangeHigh > rangeLow ? (price - rangeLow) / (rangeHigh - rangeLow) : 0.5;
    vote('levels', 'Support / resistance (60 bars)', rangePosition < 0.35 ? 1 : rangePosition > 0.9 ? -0.5 : 0, `Price is at ${(rangePosition * 100).toFixed(0)}% of the 60-bar range.`);

    const patterns = detectPatterns(closed, index);
    const bullishPatterns = patterns.filter((pattern) => pattern.bias === 'bullish').length;
    const bearishPatterns = patterns.filter((pattern) => pattern.bias === 'bearish').length;
    const candleVote = clamp(bullishPatterns - bearishPatterns, -1, 1);
    vote('candles', 'Candlestick patterns', candleVote, patterns.length
      ? patterns.map((pattern) => `${pattern.name} (${pattern.bias})`).join(', ')
      : 'No completed reversal or continuation pattern.');

    const weighted = votes.reduce((sum, item) => sum + item.vote * item.weight, 0);
    const totalWeight = votes.reduce((sum, item) => sum + item.weight, 0);
    const score = Math.round(clamp(totalWeight ? (weighted / totalWeight) * 100 : 0, -100, 100));
    const atrPct = atr / price * 100;
    const volatilityOk = atrPct >= MIN_ATR_PCT && atrPct <= MAX_ATR_PCT;
    const spreadOk = market.spreadBps <= settings.maxSpreadBps;
    const volumeOk = (market.volumeUsd || 0) >= settings.minVolumeUsd;
    const tradeable = spreadOk && volumeOk && volatilityOk;
    const entryReady = score >= settings.entryScore;
    const signal = !spreadOk || !volumeOk || !volatilityOk ? 'BLOCKED' : signalLabel(score, settings);
    const factorBreakdown = FACTOR_GROUPS.map((factor) => {
      if (factor.key === 'risk') {
        const spreadScore = settings.maxSpreadBps > 0 ? clamp(100 - market.spreadBps / settings.maxSpreadBps * 100) : 0;
        const volumeScore = settings.minVolumeUsd > 0 ? clamp((market.volumeUsd || 0) / settings.minVolumeUsd * 100) : 100;
        const volatilityScore = volatilityOk ? 100 : atrPct < MIN_ATR_PCT
          ? clamp(100 - (MIN_ATR_PCT - atrPct) / MIN_ATR_PCT * 100)
          : clamp(100 - (atrPct - MAX_ATR_PCT) / MAX_ATR_PCT * 100);
        const factorScore = Math.round((spreadScore + volumeScore + volatilityScore) / 3);
        return { key: factor.key, label: factor.label, weight: factor.weight, score: factorScore, detail: `Spread ${spreadScore.toFixed(0)} · volume ${volumeScore.toFixed(0)} · volatility ${volatilityScore.toFixed(0)}` };
      }
      const members = votes.filter((item) => factor.tools.includes(item.key));
      const memberWeight = members.reduce((sum, item) => sum + item.weight, 0);
      const directional = memberWeight ? members.reduce((sum, item) => sum + item.vote * item.weight, 0) / memberWeight : 0;
      const strongest = [...members].sort((a, b) => Math.abs(b.vote * b.weight) - Math.abs(a.vote * a.weight))[0];
      return { key: factor.key, label: factor.label, weight: factor.weight, score: Math.round((directional + 1) * 50), detail: strongest?.label || 'No readings yet' };
    });
    const confluenceScore = Math.round(factorBreakdown.reduce((sum, factor) => sum + factor.score * factor.weight, 0) / 100);
    const regime = (() => {
      const trending = Number.isFinite(adx) && adx >= 25;
      const developing = Number.isFinite(adx) && adx >= 18;
      if (atrPct > 2.5) return 'VOLATILE';
      if (trending) return 'TRENDING';
      if (developing) return 'DEVELOPING';
      return 'RANGE';
    })();

    const entryPrice = market.askPrice * (1 + settings.slippageBps / 10000);
    const stopPrice = entryPrice - atr * 2;
    const targetPrice = entryPrice + atr * 4;
    const targetDistancePct = entryPrice > 0 ? (targetPrice / entryPrice - 1) * 100 : 0;
    const voteSupport = [...votes].filter((item) => item.vote > 0).sort((a, b) => Math.abs(b.vote * b.weight) - Math.abs(a.vote * a.weight)).slice(0, 3).map((item) => item.label);
    const voteRisks = [...votes].filter((item) => item.vote < 0).sort((a, b) => Math.abs(b.vote * b.weight) - Math.abs(a.vote * a.weight)).slice(0, 3).map((item) => item.label);
    const thesis = entryReady && tradeable
      ? `Long confluence ${confluenceScore}/100 (${score >= 0 ? '+' : ''}${score} weighted vote). ${voteSupport.length ? `${voteSupport.join(', ')} support the setup.` : 'Few indicators agree.'} ${voteRisks.length ? `${voteRisks.join(', ')} are the main counter-signals.` : 'No strong opposing votes were found.'} The paper engine still waits for a fresh closed-bar entry.`
      : signal === 'BLOCKED'
        ? `No entry: ${!spreadOk ? 'spread is above the configured limit' : !volumeOk ? '24h volume is below the configured floor' : 'volatility is outside the allowed range'}. Current weighted vote is ${score >= 0 ? '+' : ''}${score}.`
        : `No long entry yet: weighted vote ${score >= 0 ? '+' : ''}${score} has not cleared the +${settings.entryScore} threshold. ${voteSupport.length ? `Supportive tools: ${voteSupport.join(', ')}.` : 'No strong bullish tool agreement.'}`;
    const riskItems = [];
    if (!spreadOk) riskItems.push(`Spread ${market.spreadBps.toFixed(2)} bps exceeds the ${settings.maxSpreadBps} bps limit.`);
    if (!volumeOk) riskItems.push('24h USD-equivalent volume is below the configured minimum.');
    if (!volatilityOk) riskItems.push(`ATR volatility ${atrPct.toFixed(2)}% is outside the ${MIN_ATR_PCT}–${MAX_ATR_PCT}% gate.`);
    if (atrPct > 2.5) riskItems.push('High realized volatility increases stop slippage and gap risk.');
    if (patterns.some((pattern) => pattern.bias === 'bearish')) riskItems.push('A bearish completed candle pattern conflicts with a long entry.');
    if (riskItems.length === 0) riskItems.push('A 2×ATR stop is illustrative; gaps and thin liquidity can exceed the modeled loss.');
    const volumeRatio = Number.isFinite(ind.volumeAverage[index]) && ind.volumeAverage[index] > 0 ? closed[index].volume / ind.volumeAverage[index] : null;
    const obvFlow = Number.isFinite(obv) && Number.isFinite(obvPast) ? obv - obvPast : null;
    const diagnostics = [
      { label: 'Trend', value: regime, detail: `EMA stack ${e9 > e21 ? 'short-term up' : 'short-term down'} · ADX ${Number.isFinite(adx) ? adx.toFixed(1) : '—'}` },
      { label: 'Structure', value: fib.waveLabel, detail: `Swing low ${fib.swingLow?.price?.toFixed(6) || '—'} · swing high ${fib.swingHigh?.price?.toFixed(6) || '—'}` },
      { label: 'ADX / DI', value: Number.isFinite(adx) ? adx.toFixed(1) : '—', detail: `+DI ${Number.isFinite(plusDI) ? plusDI.toFixed(1) : '—'} · −DI ${Number.isFinite(minusDI) ? minusDI.toFixed(1) : '—'}` },
      { label: 'RSI 14', value: Number.isFinite(rsi) ? rsi.toFixed(1) : '—', detail: rsi >= 70 ? 'Overbought' : rsi <= 30 ? 'Oversold' : 'Neutral zone' },
      { label: 'Stochastic', value: Number.isFinite(stochK) ? stochK.toFixed(1) : '—', detail: `%D ${Number.isFinite(stochD) ? stochD.toFixed(1) : '—'} · ${stochK > stochD ? 'K above D' : 'K below D'}` },
      { label: 'MACD histogram', value: Number.isFinite(macd) && Number.isFinite(macdSignal) ? (macd - macdSignal).toFixed(6) : '—', detail: Number.isFinite(macd) && Number.isFinite(macdSignal) ? (macd > macdSignal ? 'Momentum above signal' : 'Momentum below signal') : 'Warm-up' },
      { label: 'VWAP', value: Number.isFinite(vwap) ? vwap.toFixed(6) : '—', detail: Number.isFinite(vwap) ? `${((price / vwap - 1) * 100).toFixed(2)}% vs UTC session VWAP` : 'Unavailable' },
      { label: 'OBV flow', value: Number.isFinite(obvFlow) ? obvFlow > 0 ? 'Accumulating' : 'Distributing' : '—', detail: Number.isFinite(obvFlow) ? `10-bar OBV change ${obvFlow.toFixed(0)}` : 'Unavailable' },
      { label: 'MFI 14', value: Number.isFinite(mfi) ? mfi.toFixed(1) : '—', detail: Number.isFinite(mfi) ? 'Volume-weighted money flow' : 'Warm-up' },
      { label: 'Bollinger %B', value: Number.isFinite(percentB) ? `${(percentB * 100).toFixed(0)}%` : '—', detail: Number.isFinite(percentB) ? percentB > 1 ? 'Above upper band' : percentB < 0 ? 'Below lower band' : 'Inside bands' : 'Warm-up' },
      { label: 'Volatility', value: `${atrPct.toFixed(2)}%`, detail: `ATR ${atr.toFixed(6)} · ${volatilityOk ? 'within gate' : 'outside gate'}` },
      { label: 'Volume vs average', value: Number.isFinite(volumeRatio) ? `${volumeRatio.toFixed(2)}×` : '—', detail: '20-bar average' },
      { label: 'Support / resistance', value: `${rangeLow.toFixed(6)} / ${rangeHigh.toFixed(6)}`, detail: `Price at ${(rangePosition * 100).toFixed(0)}% of 60-bar range` },
      { label: 'Fibonacci', value: fib.level || '—', detail: fib.inZone ? 'Inside 38.2–61.8% pullback zone' : 'No confirmed entry-zone confluence' },
      { label: 'Last candle', value: patterns.map((pattern) => pattern.name).join(', ') || 'None', detail: 'Closed candle only' },
    ];
    const reasons = [];
    const scored = [...votes].sort((a, b) => Math.abs(b.vote * b.weight) - Math.abs(a.vote * a.weight));
    for (const item of scored.slice(0, 6)) {
      const contribution = Math.round(item.vote * item.weight);
      reasons.push(`${contribution > 0 ? '+' : ''}${contribution} ${item.label}: ${item.note}`);
    }
    if (patterns.length) reasons.push(`Candles: ${patterns.map((pattern) => pattern.name).join(', ')}.`);
    reasons.push(`${regime} regime · ATR ${atrPct.toFixed(2)}% of price · spread ${market.spreadBps.toFixed(2)} bps.`);
    if (!volatilityOk) reasons.push(`Volatility gate: ATR must stay between ${MIN_ATR_PCT}% and ${MAX_ATR_PCT}% of price.`);
    if (!spreadOk) reasons.push(`Spread ${market.spreadBps.toFixed(2)} bps exceeds the ${settings.maxSpreadBps} bps entry limit.`);
    if (!volumeOk) reasons.push('24h USD-equivalent volume is below the configured floor.');
    if (entryReady && tradeable) reasons.push(`Score ${score >= 0 ? '+' : ''}${score} clears the +${settings.entryScore} entry threshold, so the bot may take this long.`);
    else if (entryReady) reasons.push(`Score ${score >= 0 ? '+' : ''}${score} clears the threshold, but a spread, volume or volatility gate blocks the entry.`);
    else reasons.push(`Score ${score >= 0 ? '+' : ''}${score} is below the +${settings.entryScore} entry threshold; the bot waits for stronger agreement.`);
    reasons.push('Rule-based confluence, not a prediction. Spot longs only; no leverage.');

    return {
      available: true,
      score,
      confluenceScore,
      confluenceCount: votes.filter((item) => score === 0 ? item.vote === 0 : item.vote * score > 0).length,
      factorBreakdown,
      signal,
      regime,
      entryPrice,
      stopPrice,
      targetPrice,
      targetDistancePct,
      rewardRisk: 2,
      thesis,
      riskItems,
      invalidation: stopPrice > 0 ? `A move through ${stopPrice.toFixed(market.pair_decimals)} reaches the illustrative 2×ATR long stop; actual fills can slip.` : 'No valid stop level available.',
      diagnostics,
      votes,
      patterns,
      atr,
      atrPct,
      stopDistance: atr * 2,
      stopPct: atr * 2 / price * 100,
      rsi,
      adx,
      vwap,
      percentB,
      atrPercent: atrPct,
      fib: fib.level ? { level: fib.level, ratio: fib.ratio, inZone: fib.inZone } : null,
      waveLabel: fib.waveLabel,
      tradeable,
      entryReady: entryReady && tradeable,
      candleAt: closed[index].time,
      closedCandles: closed.length,
      price,
      reasons,
      weightedTotal: Math.round(weighted),
      engine: STRATEGY_NAME,
      candlePatterns: patterns,
    };
  }

  function signalLabel(score, settings) {
    if (score >= settings.entryScore) return 'ENTRY READY';
    if (score <= settings.exitScore) return 'EXIT SIGNAL';
    return 'WAIT';
  }

  /* ------------------------------- scanning ------------------------------- */

  async function scan() {
    if (scanPromise) return scanPromise;
    scanPromise = (async () => {
      state.scanning = true;
      state.scanError = null;
      emit();
      try {
        let pairResult;
        if (state.pairMeta.length && state.pairMetaFetchedAt && Date.now() - state.pairMetaFetchedAt < 6 * 60 * 60 * 1000) {
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
        updateScores();
        state.lastScanAt = new Date().toISOString();
        state.lastScanTs = Date.now();
        state.scanError = null;
        state.dataStale = false;
        state.scanFailures = 0;
        persist();
      } catch (error) {
        state.scanError = error.message || 'Kraken scan failed.';
        state.dataStale = true;
        state.scanFailures = (state.scanFailures || 0) + 1;
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

  function updateScores() {
    for (const market of state.markets) {
      const quality = marketQuality(market);
      const analysis = state.latestAnalysis[market.pairKey];
      market.marketQuality = Math.round(quality);
      if (analysis?.available) {
        market.tradeScore = Math.round(analysis.confluenceScore ?? clamp((analysis.score + 100) / 2));
        market.scoreBreakdown = analysis.factorBreakdown;
        market.scoreGrade = !market.eligible ? 'SCAN ONLY'
          : !analysis.tradeable ? 'BLOCKED BY RISK GATE'
            : analysis.entryReady ? 'ENTRY CANDIDATE' : 'MONITOR';
        market.scoreReasons = [
          analysis.thesis,
          ...analysis.reasons.slice(0, 4),
          analysis.invalidation,
          market.eligible ? (analysis.entryReady ? 'Passes the confluence, spread, volume and volatility gates.' : 'Below the entry threshold; the bot is waiting.') : `Quote ${market.quote} is display-only; paper entries are limited to USD/USDT.`,
        ].filter(Boolean);
      } else {
        market.tradeScore = Math.round(quality);
        market.scoreGrade = market.eligible ? 'PRELIMINARY' : 'SCAN ONLY';
        market.scoreReasons = [
          analysis?.reason || 'Technical scoring runs on the next signal cycle for this pair.',
          `24h USD-equivalent volume ${market.volumeUsd === null ? 'conversion unavailable' : `$${Math.round(market.volumeUsd).toLocaleString('en-US')}`}.`,
          `Current spread: ${market.spreadBps.toFixed(2)} bps.`,
          market.eligible ? 'USD/USDT pair is eligible for paper entries.' : `Quote ${market.quote} is scan-only.`,
        ];
      }
    }
    state.markets.sort((a, b) => b.tradeScore - a.tradeScore);
  }

  function fetchCandles(market, interval = state.settings.intervalMinutes) {
    return publicRequest('OHLC', { pair: market.altname, interval: String(interval) }).then((result) => {
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
    });
  }

  async function loadPairDetail(pairKey, interval = state.settings.intervalMinutes, prioritizeForPaper = true) {
    if (scanDue() || state.dataStale) await scan();
    const market = state.markets.find((item) => item.pairKey === pairKey);
    if (!market) throw new Error('Market is no longer in the Kraken spot universe. Rescan and try again.');
    if (prioritizeForPaper) focusPair(pairKey);
    const candles = await fetchCandles(market, interval);
    const closed = candles.slice(0, -1);
    const indicators = buildIndicators(closed);
    const analysis = analyzePair(candles, market, state.settings);
    return {
      pairKey,
      interval,
      market,
      candles: closed,
      analysis,
      indicators: {
        ema9: indicators.ema9,
        ema20: indicators.ema20,
        ema21: indicators.ema21,
        ema50: indicators.ema50,
        ema200: indicators.ema200,
        bollinger: indicators.bollinger,
        rsi: indicators.rsi,
        macd: indicators.macd,
        macdSignal: indicators.macdSignal,
      },
    };
  }

  /* -------------------------------- account -------------------------------- */

  function botEquity() {
    return state.cash + Object.values(state.positions).reduce((sum, position) => sum + position.qty * position.markPrice, 0);
  }

  function botRisk(position) {
    const stop = Number.isFinite(position.initialStop) ? position.initialStop : position.stopPrice;
    return Math.max(0, position.entryPrice - stop) * position.qty + position.entryFeeRemaining
      + position.qty * position.stopPrice * state.settings.feeBps / 10000;
  }

  function rollDay() {
    if (state.dayKey !== utcDay()) {
      state.dayKey = utcDay();
      state.dayStartEquity = botEquity();
      if (state.haltedReason === 'Daily loss limit reached') state.haltedReason = null;
    }
  }

  function enforceLimits() {
    rollDay();
    const equity = botEquity();
    if (!state.haltedReason && equity - state.dayStartEquity <= -state.dayStartEquity * state.settings.dailyLossLimitPct / 100) {
      state.haltedReason = 'Daily loss limit reached';
    }
    if (!state.haltedReason && state.highWaterMark > 0 && (state.highWaterMark - equity) / state.highWaterMark * 100 >= state.settings.maxDrawdownPct) {
      state.haltedReason = 'Maximum drawdown reached';
    }
    const cap = equity * state.settings.riskPct / 100;
    if (!state.haltedReason && Object.values(state.positions).some((position) => botRisk(position) > cap + 1e-8)) {
      state.haltedReason = 'Per-position risk limit exceeded';
    }
    if (state.haltedReason) {
      state.entriesEnabled = false;
      state.botStatus = `Halted · ${state.haltedReason}`;
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

  function paperBuy(market, analysis) {
    const current = state.markets.find((item) => item.pairKey === market.pairKey);
    if (!current || !current.eligible || state.positions[market.pairKey]) return false;
    if (!analysis.entryReady) return false;
    if (Object.keys(state.positions).length >= state.settings.maxPositions) return false;
    const intervalMs = state.settings.intervalMinutes * 60000;
    const lastExit = state.lastExitAt[market.pairKey];
    if (lastExit && analysis.candleAt - lastExit < COOLDOWN_BARS * intervalMs) return false;
    const entryPrice = current.askPrice * (1 + state.settings.slippageBps / 10000);
    const stopPrice = entryPrice - analysis.stopDistance;
    if (!(stopPrice > 0 && stopPrice < entryPrice)) return false;
    const accountEquity = botEquity();
    const riskBudget = accountEquity * state.settings.riskPct / 100;
    const feeRate = state.settings.feeBps / 10000;
    const riskPerUnit = (entryPrice - stopPrice) + (entryPrice + stopPrice) * feeRate;
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
      initialStop: stopPrice,
      entryFeeRemaining: fee,
      entryScore: analysis.score,
      openedAt: new Date().toISOString(),
      openedCandleAt: analysis.candleAt,
      strategy: analysis.engine,
    };
    appendTrade(current, 'BUY', qty, entryPrice, fee, 0, `${analysis.score >= 0 ? '+' : ''}${analysis.score} confluence entry`);
    return true;
  }

  function paperSell(market, reason, candleAt) {
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
    if (position.qty <= 1e-10) {
      delete state.positions[market.pairKey];
      state.lastExitAt[market.pairKey] = candleAt || Date.now();
    }
    return true;
  }

  function updatePositionMarks() {
    for (const [pairKey, position] of Object.entries(state.positions)) {
      const market = state.markets.find((item) => item.pairKey === pairKey);
      if (market && market.last > 0) position.markPrice = market.last;
    }
    state.highWaterMark = Math.max(state.highWaterMark, botEquity());
    enforceLimits();
  }

  /* ------------------------------ the engine ------------------------------- */

  function scanDue(now = Date.now()) {
    const last = Number(state.lastScanTs) || (state.lastScanAt ? Date.parse(state.lastScanAt) : 0);
    const interval = Math.max(MIN_SCAN_SECONDS, Number(state.settings.autoScanSeconds) || 60) * 1000;
    return !last || now - last >= interval;
  }

  function watchlist() {
    const selected = new Map();
    const add = (market) => {
      if (market) selected.set(market.pairKey, market);
    };
    for (const position of Object.values(state.positions)) add(state.markets.find((item) => item.pairKey === position.pairKey));
    for (const pairKey of focusQueue) add(state.markets.find((item) => item.pairKey === pairKey));
    focusQueue = new Set();
    const universe = [...state.markets].filter((market) => market.status === 'online').sort((a, b) => b.screenScore - a.screenScore);
    if (!universe.length) return [...selected.values()];
    const count = Math.max(1, Math.min(10, Math.round(state.settings.scanPairs)));
    const fixedSlots = Math.max(1, Math.floor(count / 2));
    for (let i = 0; i < fixedSlots && i < universe.length; i += 1) add(universe[i]);
    const rotationSlots = count - fixedSlots;
    for (let i = 0; i < rotationSlots && universe.length; i += 1) {
      const index = (state.rotationIndex + i) % universe.length;
      add(universe[index]);
    }
    state.rotationIndex = (state.rotationIndex + Math.max(1, rotationSlots)) % universe.length;
    return [...selected.values()];
  }

  async function signalCycle() {
    if (signalCycleRunning) return;
    signalCycleRunning = true;
    try {
      if (scanDue() || state.dataStale) {
        try {
          await scan();
        } catch (error) {
          state.botError = `Quote refresh failed: ${error.message || 'unknown error'}`;
        }
      }
      const targets = watchlist();
      if (!targets.length) {
        state.lastSignalCycleAt = new Date().toISOString();
        persist();
        return;
      }
      if (state.dataStale) {
        state.botStatus = 'Quotes stale · new entries blocked · retrying automatically';
        state.lastSignalCycleAt = new Date().toISOString();
        persist();
        return;
      }
      const evaluations = [];
      const errors = [];
      for (const market of targets) {
        try {
          const candles = await fetchCandles(market, state.settings.intervalMinutes);
          const analysis = analyzePair(candles, market, state.settings);
          state.latestAnalysis[market.pairKey] = analysis;
          evaluations.push({ market, analysis });
        } catch (error) {
          errors.push(`${market.display}: ${error.message || 'candles unavailable'}`);
        }
      }
      updateScores();
      updatePositionMarks();
      const intervalMs = state.settings.intervalMinutes * 60000;
      for (const { market, analysis } of evaluations) {
        const position = state.positions[market.pairKey];
        if (position) {
          const current = state.markets.find((item) => item.pairKey === market.pairKey);
          if (current && current.last <= position.stopPrice) {
            paperSell(market, position.stopPrice >= position.entryPrice ? 'Trailing stop (break-even or better)' : '2×ATR protective stop', analysis.candleAt);
            continue;
          }
          if (analysis.available && analysis.score <= state.settings.exitScore) {
            paperSell(market, `Confluence fell to ${analysis.score >= 0 ? '+' : ''}${analysis.score}`, analysis.candleAt);
            continue;
          }
          if (analysis.available && analysis.candleAt - position.openedCandleAt > MAX_HOLD_BARS * intervalMs) {
            paperSell(market, `Max hold reached (${MAX_HOLD_BARS} bars)`, analysis.candleAt);
            continue;
          }
          const riskUnit = position.entryPrice - position.initialStop;
          if (current && riskUnit > 0 && current.last >= position.entryPrice + riskUnit) {
            const breakEven = position.entryPrice * (1 + (state.settings.feeBps * 2) / 10000);
            if (breakEven > position.stopPrice) position.stopPrice = breakEven;
          }
          continue;
        }
        if (!state.entriesEnabled || state.haltedReason) continue;
        if (Object.keys(state.positions).length >= state.settings.maxPositions) continue;
        paperBuy(market, analysis);
      }
      updatePositionMarks();
      enforceLimits();
      state.lastSignalCycleAt = new Date().toISOString();
      state.botError = errors.length ? errors.slice(0, 2).join(' · ') : null;
      if (!state.haltedReason) {
        const openCount = Object.keys(state.positions).length;
        state.botStatus = state.entriesEnabled
          ? `Hunting ${targets.length} pairs per cycle · ${openCount}/${state.settings.maxPositions} open · entry needs +${state.settings.entryScore}`
          : `Managing ${openCount} open paper position${openCount === 1 ? '' : 's'} · entries paused`;
      }
      persist();
    } catch (error) {
      state.botError = error.message || 'Signal cycle failed.';
      state.botStatus = 'Cycle error · retrying automatically';
      state.lastSignalCycleAt = new Date().toISOString();
      persist();
    } finally {
      signalCycleRunning = false;
      emit();
    }
  }

  async function engineTick() {
    if (engineBusy) return;
    engineBusy = true;
    try {
      rollDay();
      const lastCycle = state.lastSignalCycleAt ? Date.parse(state.lastSignalCycleAt) : 0;
      if (scanDue() || !lastCycle || Date.now() - lastCycle >= SIGNAL_CYCLE_MS) await signalCycle();
      enforceLimits();
    } finally {
      engineBusy = false;
    }
  }

  function ensureEngine() {
    if (engineTimer || host.active) return;
    engineTimer = window.setInterval(engineTick, ENGINE_TICK_MS);
  }

  function startAutoEngine() {
    ensureEngine();
    emit();
    engineTick();
  }

  function stopOnPageHide() {
    if (host.active) return;
    if (engineTimer) window.clearInterval(engineTimer);
    engineTimer = null;
    state.botStatus = 'Paused · dashboard closed';
    try { persist(); } catch { /* Best-effort save while closing the page. */ }
  }

  /* ------------------------------- controls -------------------------------- */

  function setEntriesEnabled(enabled) {
    if (enabled && state.haltedReason) throw new Error(`${state.haltedReason}; reset the Kraken paper account to clear the halt.`);
    state.entriesEnabled = Boolean(enabled);
    state.botStatus = enabled ? 'Entries enabled · scanning for confluence setups' : 'Entries paused · open positions are still managed';
    persist();
    emit();
    if (enabled) engineTick();
  }

  function focusPair(pairKey) {
    if (!pairKey) return;
    focusQueue.add(pairKey);
  }

  function updateSettings(values) {
    const ranges = {
      feeBps: [0, 100],
      slippageBps: [0, 100],
      riskPct: [0.1, 2],
      dailyLossLimitPct: [0.5, 20],
      maxDrawdownPct: [1, 40],
      maxPositions: [1, 10],
      liquidityParticipationPct: [1, 25],
      maxSpreadBps: [1, 200],
      minVolumeUsd: [0, 1000000000],
      scanPairs: [1, 10],
      intervalMinutes: [1, 5],
      autoScanSeconds: [MIN_SCAN_SECONDS, MAX_SCAN_SECONDS],
      entryScore: [20, 80],
      exitScore: [-40, 40],
      startingBalance: [100, 100000000],
    };
    const next = { ...state.settings };
    for (const [key, range] of Object.entries(ranges)) {
      if (values[key] === undefined) continue;
      const numeric = Number(values[key]);
      if (!Number.isFinite(numeric) || numeric < range[0] || numeric > range[1]) throw new Error(`${key} must be between ${range[0]} and ${range[1]}.`);
      if (key === 'intervalMinutes' && ![1, 5].includes(numeric)) throw new Error('Scalping interval must be 1 or 5 minutes.');
      next[key] = numeric;
    }
    if (next.exitScore >= next.entryScore) throw new Error('The exit score must stay below the entry score.');
    if (next.startingBalance !== state.settings.startingBalance && !Object.keys(state.positions).length && !state.trades.length) {
      state.cash = next.startingBalance;
      state.initialBalance = next.startingBalance;
      state.highWaterMark = next.startingBalance;
      state.dayStartEquity = next.startingBalance;
    }
    state.settings = next;
    updateScores();
    persist();
    emit();
  }

  function resetAccount() {
    const replacement = createState();
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, replacement);
    focusQueue = new Set();
    persist();
    emit();
    ensureEngine();
    engineTick();
  }

  /* -------------------------------- snapshot ------------------------------- */

  function getSnapshot() {
    const equity = botEquity();
    const positions = Object.values(state.positions).map((position) => ({
      ...position,
      marketValue: position.qty * position.markPrice,
      unrealizedPnl: position.qty * (position.markPrice - position.entryPrice) - position.entryFeeRemaining,
      openRisk: botRisk(position),
    }));
    const analyzedCount = Object.values(state.latestAnalysis).filter((analysis) => analysis?.available).length;
    const eligibleCount = state.markets.filter((market) => market.eligible).length;
    const candidateCount = state.markets.filter((market) => {
      const analysis = state.latestAnalysis[market.pairKey];
      return market.eligible && analysis?.available && analysis.entryReady;
    }).length;
    return {
      settings: state.settings,
      markets: state.markets,
      latestAnalysis: state.latestAnalysis,
      positions,
      trades: state.trades.slice(0, 30),
      marketCount: state.markets.length,
      eligibleCount,
      analyzedCount,
      candidateCount,
      scanning: state.scanning,
      scanError: state.scanError,
      lastScanAt: state.lastScanAt,
      dataStale: Boolean(state.dataStale),
      scanFailures: state.scanFailures || 0,
      lastSignalCycleAt: state.lastSignalCycleAt,
      entriesEnabled: state.entriesEnabled,
      haltedReason: state.haltedReason,
      botStatus: state.botStatus,
      botError: state.botError,
      cash: state.cash,
      equity,
      dailyPnl: equity - state.dayStartEquity,
      dailyPnlPct: state.dayStartEquity ? (equity - state.dayStartEquity) / state.dayStartEquity * 100 : 0,
      drawdownPct: state.highWaterMark ? Math.max(0, (state.highWaterMark - equity) / state.highWaterMark * 100) : 0,
      highWaterMark: state.highWaterMark,
      initialBalance: state.initialBalance,
      strategy: {
        name: STRATEGY_NAME,
        weights: WEIGHTS,
        weightTotal: WEIGHT_TOTAL,
        entryScore: state.settings.entryScore,
        exitScore: state.settings.exitScore,
        cooldownBars: COOLDOWN_BARS,
        maxHoldBars: MAX_HOLD_BARS,
        minAtrPct: MIN_ATR_PCT,
        maxAtrPct: MAX_ATR_PCT,
      },
      quoteCurrency: 'USD-equivalent (USD/USDT quotes only; USDT≈USD)',
    };
  }

  window.addEventListener('pagehide', stopOnPageHide);
  window.addEventListener('pageshow', () => {
    if (host.active) return;
    ensureEngine();
    engineTick();
  });
  document.addEventListener('visibilitychange', () => {
    if (host.active) return;
    if (document.visibilityState === 'visible') engineTick();
  });

  /* ------------------------- headless host bridge --------------------------- */

  // A Node host can run this same engine with no browser open. When this page is
  // served by such a host, the dashboard mirrors that one paper account instead of
  // trading a second browser-only account. Without a host (Run preview, plain file
  // hosting) everything stays in this browser exactly as before.
  const host = {
    active: false,
    snapshot: null,
    listeners: new Set(),
    pollTimer: null,
    polling: false,
  };

  async function hostRequest(path, options = {}) {
    const response = await fetch(path, {
      cache: 'no-store',
      method: options.body === undefined ? 'GET' : 'POST',
      headers: options.body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json().catch(() => ({})) : {};
    if (!response.ok) throw new Error(payload.error || `Host returned HTTP ${response.status}.`);
    return payload;
  }

  function applyHostSnapshot(snapshot) {
    if (!snapshot) return;
    host.snapshot = snapshot;
    for (const listener of host.listeners) listener(snapshot);
  }

  function startHostPolling() {
    if (host.pollTimer) return;
    const poll = async () => {
      if (host.polling) return;
      host.polling = true;
      try {
        const payload = await hostRequest('/api/bot/state');
        if (payload?.snapshot) applyHostSnapshot(payload.snapshot);
      } catch {
        // Keep the last snapshot on screen; the next poll retries.
      } finally {
        host.polling = false;
      }
    };
    host.pollTimer = window.setInterval(poll, 5000);
    poll();
  }

  async function hostAction(action, body) {
    const payload = await hostRequest(`/api/bot/${action}`, { body: body || {} });
    if (payload?.snapshot) applyHostSnapshot(payload.snapshot);
    return payload;
  }

  async function detectHeadlessHost() {
    let payload = null;
    try {
      payload = await hostRequest('/api/bot/state');
    } catch {
      return;
    }
    if (payload?.headless !== true || !payload.snapshot) return;
    host.active = true;
    if (engineTimer) window.clearInterval(engineTimer);
    engineTimer = null;
    // The dashboard subscribed before this probe answered, so move its listeners
    // over to the host account and repaint from there.
    for (const listener of listeners) host.listeners.add(listener);
    listeners.clear();
    applyHostSnapshot(payload.snapshot);
    startHostPolling();
  }

  window.NorthstarKrakenBot = {
    subscribe(listener) {
      if (!host.active) return subscribe(listener);
      host.listeners.add(listener);
      if (host.snapshot) listener(host.snapshot);
      return () => host.listeners.delete(listener);
    },
    getSnapshot() {
      return host.active && host.snapshot ? host.snapshot : getSnapshot();
    },
    scan: () => (host.active ? hostAction('scan') : scan()),
    refreshNow: () => (host.active ? hostAction('scan') : scan()),
    focusPair(pairKey) {
      if (!host.active) return focusPair(pairKey);
      hostAction('focus', { pairKey }).catch(() => {});
      return undefined;
    },
    loadPairDetail(pairKey, interval = state.settings.intervalMinutes, prioritizeForPaper = true) {
      if (!host.active) return loadPairDetail(pairKey, interval, prioritizeForPaper);
      const query = new URLSearchParams({ pair: pairKey, interval: String(interval), paper: prioritizeForPaper ? 'true' : 'false' });
      return hostRequest(`/api/bot/detail?${query.toString()}`);
    },
    setEntriesEnabled(enabled) {
      if (!host.active) return setEntriesEnabled(enabled);
      return hostAction('entries', { enabled: Boolean(enabled) }).then(() => undefined);
    },
    updateSettings(values) {
      if (!host.active) return updateSettings(values);
      return hostAction('settings', values).then(() => undefined);
    },
    resetAccount() {
      if (!host.active) return resetAccount();
      return hostAction('reset').then(() => undefined);
    },
    isHosted: () => host.active,
  };

  startAutoEngine();
  detectHeadlessHost();
})();
