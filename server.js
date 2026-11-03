const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const botService = require('./bot-service');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'paper-state.json');
const MARKET_API = 'https://data-api.binance.vision';
const KRAKEN_API = 'https://api.kraken.com';
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const DEFAULT_SETTINGS = {
  feeBps: 10,
  slippageBps: 5,
  executionLatencyMs: 250,
  liquidityParticipationPct: 10,
  maxRiskPct: 2,
  dailyLossLimitPct: 5,
  maxDrawdownPct: 15,
};

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function createInitialState(initialBalance = 10000) {
  const balance = Number(initialBalance);
  const today = utcDay();
  return {
    version: 1,
    initialBalance: balance,
    cash: balance,
    positions: {},
    orders: [],
    trades: [],
    dailyPnlCandles: [{ day: today, open: 0, high: 0, low: 0, close: 0 }],
    settings: { ...DEFAULT_SETTINGS },
    manualKillSwitch: false,
    autoHaltReason: null,
    highWaterMark: balance,
    dayKey: today,
    dayStartEquity: balance,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    const stored = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (stored.version !== 1 || typeof stored.cash !== 'number' || !stored.settings) {
      throw new Error('Invalid paper account state');
    }
    return {
      ...createInitialState(stored.initialBalance),
      ...stored,
      dailyPnlCandles: Array.isArray(stored.dailyPnlCandles) ? stored.dailyPnlCandles.slice(-90) : [],
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Paper account state could not be loaded; starting a fresh account:', error.message);
    }
    const state = createInitialState();
    saveState(state);
    return state;
  }
}

function recordDailyPnl(state) {
  rollUtcDay(state);
  const day = state.dayKey;
  const pnl = accountEquity(state) - state.dayStartEquity;
  let candle = state.dailyPnlCandles[state.dailyPnlCandles.length - 1];
  if (!candle || candle.day !== day) {
    candle = { day, open: 0, high: Math.max(0, pnl), low: Math.min(0, pnl), close: pnl };
    state.dailyPnlCandles.push(candle);
  } else {
    candle.high = Math.max(candle.high, pnl);
    candle.low = Math.min(candle.low, pnl);
    candle.close = pnl;
  }
  if (state.dailyPnlCandles.length > 90) state.dailyPnlCandles.splice(0, state.dailyPnlCandles.length - 90);
}

function saveState(state) {
  recordDailyPnl(state);
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporaryFile = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, STATE_FILE);
}

let paper = loadState();
let consecutiveMarketErrors = 0;

// The Kraken paper engine also runs here, so the scanner keeps working with no
// dashboard open. It only calls Kraken's public endpoints and writes simulated
// fills; it cannot place a real order. Set NORTHSTAR_HEADLESS_BOT=off to skip it.
const headlessBot = (() => {
  if (!botService.headlessEnabled()) {
    console.log('Server-side Kraken paper engine disabled (NORTHSTAR_HEADLESS_BOT=off).');
    return null;
  }
  try {
    const runtime = botService.startHeadlessBot({
      dataDir: DATA_DIR,
      sourcePath: path.join(__dirname, 'kraken-bot.js'),
    });
    console.log(`Server-side Kraken paper engine running; paper state: ${runtime.stateFile}`);
    return runtime;
  } catch (error) {
    console.error('Server-side Kraken paper engine could not start:', error.message);
    return null;
  }
})();

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function applySecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://data-api.binance.vision https://api.kraken.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function validSymbol(value) {
  return typeof value === 'string' && /^[A-Z0-9]{2,16}USDT$/.test(value);
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('Invalid request origin');
  }
  if (parsed.host !== request.headers.host || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Cross-origin state changes are not allowed');
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 32768) {
        reject(new Error('Request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`Market data provider returned HTTP ${response.status}`);
  return response.json();
}

async function fetchMarket(symbol) {
  if (!validSymbol(symbol)) throw new Error('Use a USDT-quoted symbol such as BTCUSDT.');
  const query = `symbol=${encodeURIComponent(symbol)}`;
  const [book, ticker] = await Promise.all([
    fetchJson(`${MARKET_API}/api/v3/ticker/bookTicker?${query}`),
    fetchJson(`${MARKET_API}/api/v3/ticker/24hr?${query}`),
  ]);
  const market = {
    symbol,
    source: 'Binance Spot public market data',
    fetchedAt: new Date().toISOString(),
    price: Number(ticker.lastPrice),
    bidPrice: Number(book.bidPrice),
    bidQty: Number(book.bidQty),
    askPrice: Number(book.askPrice),
    askQty: Number(book.askQty),
    changePct: Number(ticker.priceChangePercent),
    high: Number(ticker.highPrice),
    low: Number(ticker.lowPrice),
    volume: Number(ticker.volume),
  };
  if (![market.price, market.bidPrice, market.bidQty, market.askPrice, market.askQty, market.changePct, market.high, market.low, market.volume].every(Number.isFinite)
    || market.price <= 0 || market.bidPrice <= 0 || market.askPrice <= 0 || market.bidQty < 0 || market.askQty < 0 || market.bidPrice > market.askPrice) {
    throw new Error('Market data provider returned an invalid quote.');
  }
  return market;
}

function positionRisk(position, feeBps = 0) {
  const feeRate = feeBps / 10000;
  const isShort = position?.direction === 'SHORT';
  return (position?.lots || []).reduce((total, lot) => {
    const stopDistance = isShort ? lot.stopLossPrice - lot.entryPrice : lot.entryPrice - lot.stopLossPrice;
    return total + Math.max(0, stopDistance) * lot.qty
      + lot.entryFeeRemaining + lot.qty * lot.stopLossPrice * feeRate;
  }, 0);
}

function accountEquity(state) {
  return state.cash + Object.values(state.positions).reduce((total, position) => {
    if (position.direction !== 'SHORT') return total + position.qty * position.markPrice;
    const collateral = Number(position.reservedMargin) || 0;
    const unrealized = position.lots.reduce((sum, lot) => sum + lot.qty * (lot.entryPrice - position.markPrice), 0);
    return total + collateral + unrealized;
  }, 0);
}

function metrics(state) {
  const equity = accountEquity(state);
  const dailyPnl = equity - state.dayStartEquity;
  const drawdownPct = state.highWaterMark > 0 ? Math.max(0, (state.highWaterMark - equity) / state.highWaterMark * 100) : 0;
  return {
    equity,
    cash: state.cash,
    dailyPnl,
    dailyPnlPct: state.dayStartEquity ? dailyPnl / state.dayStartEquity * 100 : 0,
    drawdownPct,
    highWaterMark: state.highWaterMark,
    dayStartEquity: state.dayStartEquity,
    totalOpenRisk: Object.values(state.positions).reduce((sum, position) => sum + positionRisk(position, state.settings.feeBps), 0),
  };
}

function rollUtcDay(state) {
  const today = utcDay();
  if (state.dayKey !== today) {
    const previous = state.dailyPnlCandles[state.dailyPnlCandles.length - 1];
    if (previous && previous.day === state.dayKey) previous.close = accountEquity(state) - state.dayStartEquity;
    state.dayKey = today;
    state.dayStartEquity = accountEquity(state);
  }
}

function enforceRiskLimits(state) {
  rollUtcDay(state);
  const values = metrics(state);
  if (!state.autoHaltReason && values.dailyPnl <= -(state.dayStartEquity * state.settings.dailyLossLimitPct / 100)) {
    state.autoHaltReason = 'Daily loss limit reached';
  }
  if (!state.autoHaltReason && values.drawdownPct >= state.settings.maxDrawdownPct) {
    state.autoHaltReason = 'Maximum drawdown reached';
  }
  if (!state.autoHaltReason && Object.values(state.positions).some((position) => positionRisk(position, state.settings.feeBps) > values.equity * state.settings.maxRiskPct / 100)) {
    state.autoHaltReason = 'Maximum position risk exceeded';
  }
  if (state.autoHaltReason) {
    for (const order of state.orders) {
      if (isActiveOrder(order) && isEntrySide(order.side) && order.type !== 'STOP_LOSS') {
        order.status = 'CANCELLED';
        order.cancelReason = state.autoHaltReason;
      }
    }
  }
}

function updatePositionMark(state, market) {
  const position = state.positions[market.symbol];
  if (position) position.markPrice = market.price;
  const equity = accountEquity(state);
  state.highWaterMark = Math.max(state.highWaterMark, equity);
  enforceRiskLimits(state);
}

function openPosition(state, symbol, direction, qty, price, fee, stopLossPrice) {
  const position = state.positions[symbol] || { direction, qty: 0, avgEntry: 0, markPrice: price, reservedMargin: 0, lots: [] };
  position.direction = position.direction || direction;
  const reservedMargin = position.direction === 'SHORT' ? price * qty : 0;
  position.lots.push({
    qty,
    entryPrice: price,
    stopLossPrice,
    entryFeeRemaining: fee,
    reservedMarginRemaining: reservedMargin,
    openedAt: new Date().toISOString(),
  });
  position.qty += qty;
  position.reservedMargin = (Number(position.reservedMargin) || 0) + reservedMargin;
  position.avgEntry = position.lots.reduce((sum, lot) => sum + lot.qty * lot.entryPrice, 0) / position.qty;
  position.markPrice = price;
  state.positions[symbol] = position;
}

function closePosition(state, symbol, qty, price, exitFee) {
  const position = state.positions[symbol];
  const isShort = position.direction === 'SHORT';
  let remaining = qty;
  let realizedPnl = -exitFee;
  let grossPnl = 0;
  let releasedMargin = 0;
  for (const lot of position.lots) {
    if (remaining <= 1e-12) break;
    const beforeQty = lot.qty;
    const closedQty = Math.min(beforeQty, remaining);
    const entryFee = lot.entryFeeRemaining * (closedQty / beforeQty);
    const lotGrossPnl = closedQty * (isShort ? lot.entryPrice - price : price - lot.entryPrice);
    const marginReleased = isShort ? (Number(lot.reservedMarginRemaining) || 0) * closedQty / beforeQty : 0;
    grossPnl += lotGrossPnl;
    realizedPnl += lotGrossPnl - entryFee;
    releasedMargin += marginReleased;
    lot.qty -= closedQty;
    lot.entryFeeRemaining -= entryFee;
    lot.reservedMarginRemaining = Math.max(0, (Number(lot.reservedMarginRemaining) || 0) - marginReleased);
    remaining -= closedQty;
  }
  position.lots = position.lots.filter((lot) => lot.qty > 1e-12);
  position.qty = position.lots.reduce((sum, lot) => sum + lot.qty, 0);
  position.reservedMargin = position.lots.reduce((sum, lot) => sum + (Number(lot.reservedMarginRemaining) || 0), 0);
  position.avgEntry = position.qty > 0
    ? position.lots.reduce((sum, lot) => sum + lot.qty * lot.entryPrice, 0) / position.qty
    : 0;
  if (position.qty <= 1e-12) delete state.positions[symbol];
  return { realizedPnl, grossPnl, releasedMargin };
}

function isBuySide(side) {
  return side === 'BUY' || side === 'COVER';
}

function isEntrySide(side) {
  return side === 'BUY' || side === 'SHORT';
}

function createLiquidity(market) {
  return { buyQty: market.askQty, sellQty: market.bidQty };
}

function isOrderTriggered(order, market) {
  if (order.type === 'MARKET' || order.type === 'STOP_LOSS') return true;
  if (order.type === 'LIMIT') {
    return isBuySide(order.side) ? market.askPrice <= order.limitPrice : market.bidPrice >= order.limitPrice;
  }
  if (order.type === 'STOP_MARKET') {
    return isBuySide(order.side) ? market.price >= order.triggerPrice : market.price <= order.triggerPrice;
  }
  return false;
}

function cancelOrder(order, reason) {
  order.status = 'CANCELLED';
  order.cancelReason = reason;
}

function isActiveOrder(order) {
  return ['OPEN', 'PARTIALLY_FILLED'].includes(order.status) && order.remainingQty > 1e-12;
}

function attemptFill(state, order, market, liquidity) {
  if (!isActiveOrder(order) || !isOrderTriggered(order, market)) return;
  if (isEntrySide(order.side) && (state.manualKillSwitch || state.autoHaltReason)) {
    cancelOrder(order, state.autoHaltReason || 'Manual kill switch is active');
    return;
  }
  const buySide = isBuySide(order.side);
  const visibleQty = buySide ? market.askQty : market.bidQty;
  const remainingLiquidity = buySide ? liquidity.buyQty : liquidity.sellQty;
  const participation = state.settings.liquidityParticipationPct / 100;
  let fillQty = Math.min(order.remainingQty, remainingLiquidity, visibleQty * participation);
  const position = state.positions[order.symbol];
  if (order.side === 'SELL' || order.side === 'COVER') {
    const expectedDirection = order.side === 'COVER' ? 'SHORT' : 'LONG';
    if (!position || (position.direction || 'LONG') !== expectedDirection) {
      cancelOrder(order, order.side === 'COVER' ? 'No open paper short remains to cover' : 'No open paper long remains to sell');
      return;
    }
    fillQty = Math.min(fillQty, position.qty);
  }
  if (order.side === 'BUY' && position?.direction === 'SHORT') {
    cancelOrder(order, 'Use a cover order to close the simulated short');
    return;
  }
  if (order.side === 'SHORT' && position && position.direction !== 'SHORT') {
    cancelOrder(order, 'Close the open long before opening a simulated short');
    return;
  }
  if (fillQty <= 1e-12) {
    if (order.type === 'MARKET') cancelOrder(order, 'No top-of-book liquidity available; unfilled market remainder was cancelled');
    return;
  }

  const rawPrice = buySide ? market.askPrice : market.bidPrice;
  const slip = state.settings.slippageBps / 10000;
  let fillPrice = buySide ? rawPrice * (1 + slip) : rawPrice * (1 - slip);
  if (order.type === 'LIMIT') {
    fillPrice = buySide ? Math.min(fillPrice, order.limitPrice) : Math.max(fillPrice, order.limitPrice);
    if ((buySide && fillPrice > order.limitPrice) || (!buySide && fillPrice < order.limitPrice)) return;
  }
  const feeRate = state.settings.feeBps / 10000;
  if (order.side === 'BUY' || order.side === 'SHORT') {
    const isShort = order.side === 'SHORT';
    const protectiveStopValid = isShort ? fillPrice < order.stopLossPrice : fillPrice > order.stopLossPrice;
    if (!protectiveStopValid) {
      cancelOrder(order, 'Market crossed the protective stop before entry; order cancelled');
      return;
    }
    const cashLimitedQty = state.cash / (fillPrice * (1 + feeRate));
    if (cashLimitedQty <= 1e-12) {
      cancelOrder(order, 'No simulated cash remains for this paper entry');
      return;
    }
    fillQty = Math.min(fillQty, cashLimitedQty);
    const equity = accountEquity(state);
    const existingRisk = positionRisk(state.positions[order.symbol], state.settings.feeBps);
    const stopDistance = isShort ? order.stopLossPrice - fillPrice : fillPrice - order.stopLossPrice;
    const addedRisk = Math.max(0, stopDistance) * fillQty + fillQty * (fillPrice + order.stopLossPrice) * feeRate;
    if (existingRisk + addedRisk > equity * state.settings.maxRiskPct / 100 + 1e-8) {
      cancelOrder(order, 'Position risk limit would be exceeded at this fill price');
      return;
    }
  }
  if (fillQty <= 1e-12) {
    if (order.type === 'MARKET') cancelOrder(order, 'Insufficient simulated cash for a fill');
    return;
  }

  const notional = fillQty * fillPrice;
  const fee = notional * feeRate;
  let realizedPnl = 0;
  if (order.side === 'BUY') {
    state.cash -= notional + fee;
    openPosition(state, order.symbol, 'LONG', fillQty, fillPrice, fee, order.stopLossPrice);
  } else if (order.side === 'SHORT') {
    state.cash -= notional + fee;
    openPosition(state, order.symbol, 'SHORT', fillQty, fillPrice, fee, order.stopLossPrice);
  } else if (order.side === 'SELL') {
    state.cash += notional - fee;
    realizedPnl = closePosition(state, order.symbol, fillQty, fillPrice, fee).realizedPnl;
  } else {
    const closed = closePosition(state, order.symbol, fillQty, fillPrice, fee);
    state.cash += closed.releasedMargin + closed.grossPnl - fee;
    realizedPnl = closed.realizedPnl;
  }
  if (buySide) liquidity.buyQty = Math.max(0, liquidity.buyQty - fillQty);
  else liquidity.sellQty = Math.max(0, liquidity.sellQty - fillQty);

  order.filledQty += fillQty;
  order.remainingQty = Math.max(0, order.quantity - order.filledQty);
  order.updatedAt = new Date().toISOString();
  order.status = order.remainingQty <= 1e-10 ? 'FILLED' : 'PARTIALLY_FILLED';
  const trade = {
    id: `${order.id}-${order.filledQty.toPrecision(10)}`,
    orderId: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    qty: fillQty,
    price: fillPrice,
    notional,
    fee,
    realizedPnl,
    timestamp: new Date().toISOString(),
    simulated: true,
  };
  state.trades.unshift(trade);
  state.trades = state.trades.slice(0, 2000);

  if (order.type === 'MARKET' && order.remainingQty > 1e-10) {
    order.status = 'PARTIALLY_FILLED';
    order.cancelReason = 'Market remainder cancelled after the current quote snapshot';
    order.remainingQty = 0;
  }
}

function refreshOrderStates(state, market, liquidity) {
  for (const order of state.orders) {
    if (!isActiveOrder(order) || order.symbol !== market.symbol) continue;
    if (isEntrySide(order.side) && (state.manualKillSwitch || state.autoHaltReason) && order.type !== 'STOP_LOSS') {
      cancelOrder(order, state.autoHaltReason || 'Manual kill switch is active');
      continue;
    }
    attemptFill(state, order, market, liquidity);
  }

  const position = state.positions[market.symbol];
  const isShort = position?.direction === 'SHORT';
  const stopTriggered = position?.lots.some((lot) => isShort ? market.price >= lot.stopLossPrice : market.price <= lot.stopLossPrice);
  const existingStopOrder = state.orders.some((order) => isActiveOrder(order) && order.symbol === market.symbol && order.type === 'STOP_LOSS');
  if (stopTriggered && !existingStopOrder) {
    const order = {
      id: `P-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: market.symbol,
      side: isShort ? 'COVER' : 'SELL',
      type: 'STOP_LOSS',
      quantity: position.qty,
      filledQty: 0,
      remainingQty: position.qty,
      status: 'OPEN',
      limitPrice: null,
      triggerPrice: null,
      stopLossPrice: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cancelReason: null,
    };
    state.orders.unshift(order);
    attemptFill(state, order, market, liquidity);
  }
  state.orders = state.orders.slice(0, 1000);
  updatePositionMark(state, market);
}

function stateSnapshot(state) {
  const values = metrics(state);
  const positions = Object.entries(state.positions).map(([symbol, position]) => {
    const isShort = position.direction === 'SHORT';
    const unrealizedPnl = position.lots.reduce((sum, lot) => {
      const move = isShort ? lot.entryPrice - position.markPrice : position.markPrice - lot.entryPrice;
      return sum + lot.qty * move - lot.entryFeeRemaining;
    }, 0);
    return {
      symbol,
      direction: isShort ? 'SHORT' : 'LONG',
      qty: position.qty,
      avgEntry: position.avgEntry,
      markPrice: position.markPrice,
      marketValue: position.qty * position.markPrice,
      unrealizedPnl,
      openRisk: positionRisk(position, state.settings.feeBps),
      stopLoss: position.lots.length ? (isShort
        ? Math.max(...position.lots.map((lot) => lot.stopLossPrice))
        : Math.min(...position.lots.map((lot) => lot.stopLossPrice))) : null,
    };
  });
  return {
    mode: 'PAPER',
    quoteCurrency: 'USDT',
    initialBalance: state.initialBalance,
    metrics: values,
    positions,
    orders: state.orders.slice(0, 40),
    trades: state.trades.slice(0, 40),
    dailyPnlCandles: state.dailyPnlCandles.slice(-60),
    settings: state.settings,
    manualKillSwitch: state.manualKillSwitch,
    autoHaltReason: state.autoHaltReason,
    lastUpdatedAt: state.updatedAt,
    liveTradingEnabled: false,
  };
}

function recordMarketFailure(error) {
  consecutiveMarketErrors += 1;
  if (consecutiveMarketErrors >= 3 && !paper.autoHaltReason) {
    paper.autoHaltReason = 'Repeated market-data API errors; paper entries halted';
    saveState(paper);
  }
  console.warn('Market data request failed:', error.message);
}

let marketTickQueue = Promise.resolve();

function getMarketAndTick(symbol) {
  const tick = marketTickQueue.then(async () => {
    try {
      const activeOrderSymbols = paper.orders.filter(isActiveOrder).map((order) => order.symbol);
      const symbols = [...new Set([symbol, ...Object.keys(paper.positions), ...activeOrderSymbols])];
      const markets = await Promise.all(symbols.map((item) => fetchMarket(item)));
      consecutiveMarketErrors = 0;
      const liquidityBySymbol = new Map();
      for (const market of markets) {
        const liquidity = createLiquidity(market);
        liquidityBySymbol.set(market.symbol, liquidity);
        refreshOrderStates(paper, market, liquidity);
      }
      saveState(paper);
      return { market: markets.find((item) => item.symbol === symbol), liquidity: liquidityBySymbol.get(symbol) };
    } catch (error) {
      recordMarketFailure(error);
      throw error;
    }
  });
  marketTickQueue = tick.catch(() => {});
  return tick;
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(response, 200, {
      ok: true,
      paperTradingAvailable: true,
      liveTradingEnabled: false,
      liveOrderExecutionImplemented: false,
      marketDataProvider: 'Binance Spot public REST market data; no credentials used',
      serverSideKrakenEngine: Boolean(headlessBot),
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/paper') {
    return sendJson(response, 200, stateSnapshot(paper));
  }

  if (request.method === 'GET' && url.pathname === '/api/market') {
    const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
    try {
      const { market } = await getMarketAndTick(symbol);
      return sendJson(response, 200, market);
    } catch (error) {
      return sendJson(response, 502, { error: error.message || 'Market data is unavailable.' });
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/history') {
    const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
    if (!validSymbol(symbol)) return sendJson(response, 400, { error: 'Use a USDT-quoted symbol such as BTCUSDT.' });
    try {
      const responseData = await fetchJson(`${MARKET_API}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=120`);
      const candles = responseData.map((row) => ({ time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }));
      return sendJson(response, 200, { symbol, interval: '1m', source: 'Binance Spot public historical klines', candles });
    } catch (error) {
      return sendJson(response, 502, { error: error.message || 'Historical market data is unavailable.' });
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/live') {
    return sendJson(response, 200, {
      mode: 'LIVE',
      status: 'LOCKED',
      tradingEnabled: false,
      accountConnected: false,
      ordersEnabled: false,
      message: 'Live trading is not configured. No live credentials or order routes are installed.',
    });
  }

  if (url.pathname.startsWith('/api/bot/')) {
    if (!headlessBot) {
      return sendJson(response, 200, {
        headless: false,
        runtime: 'browser',
        message: 'This host does not run the server-side paper engine; the dashboard trades its own browser account.',
      });
    }
    const action = url.pathname.slice('/api/bot/'.length);

    if (request.method === 'GET' && action === 'state') {
      try {
        return sendJson(response, 200, {
          headless: true,
          runtime: 'node',
          stateFile: headlessBot.stateFile,
          snapshot: { ...headlessBot.api.getSnapshot(), engineRuntime: 'node' },
        });
      } catch (error) {
        return sendJson(response, 503, { headless: true, error: error.message || 'The server-side bot is unavailable.' });
      }
    }

    if (request.method === 'GET' && action === 'detail') {
      const pair = url.searchParams.get('pair') || '';
      const interval = Number(url.searchParams.get('interval') || '5');
      const prioritizeForPaper = url.searchParams.get('paper') !== 'false';
      if (!/^[A-Z0-9./_-]{1,30}$/i.test(pair)) return sendJson(response, 400, { error: 'Invalid Kraken pair.' });
      if (![1, 5, 15, 30, 60, 240, 1440].includes(interval)) return sendJson(response, 400, { error: 'Invalid Kraken OHLC interval.' });
      try {
        return sendJson(response, 200, await headlessBot.api.loadPairDetail(pair, interval, prioritizeForPaper));
      } catch (error) {
        return sendJson(response, 502, { error: error.message || 'Kraken history is unavailable.' });
      }
    }

    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
    try {
      assertSameOrigin(request);
      const body = await readJson(request);
      if (action === 'scan') await headlessBot.api.scan();
      else if (action === 'focus') headlessBot.api.focusPair(String(body.pairKey || ''));
      else if (action === 'entries') headlessBot.api.setEntriesEnabled(Boolean(body.enabled));
      else if (action === 'settings') headlessBot.api.updateSettings(body);
      else if (action === 'reset') headlessBot.api.resetAccount();
      else return sendJson(response, 404, { error: 'Unknown bot action.' });
      return sendJson(response, 200, {
        headless: true,
        snapshot: { ...headlessBot.api.getSnapshot(), engineRuntime: 'node' },
      });
    } catch (error) {
      return sendJson(response, 400, { error: error.message || 'The bot action failed.' });
    }
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/kraken/')) {
    const endpoint = url.pathname.slice('/api/kraken/'.length);
    if (!['AssetPairs', 'Ticker', 'OHLC'].includes(endpoint)) return sendJson(response, 404, { error: 'Unknown Kraken public market-data endpoint.' });
    const query = new URLSearchParams();
    if (endpoint === 'OHLC') {
      const pair = url.searchParams.get('pair') || '';
      const interval = url.searchParams.get('interval') || '60';
      if (!/^[A-Z0-9/]{3,30}$/.test(pair) || !['1', '5', '15', '30', '60', '240', '1440', '10080', '21600'].includes(interval)) {
        return sendJson(response, 400, { error: 'Invalid Kraken pair or OHLC interval.' });
      }
      query.set('pair', pair);
      query.set('interval', interval);
    }
    try {
      const queryString = query.toString();
      const payload = await fetchJson(`${KRAKEN_API}/0/public/${endpoint}${queryString ? `?${queryString}` : ''}`);
      if (payload.error?.length) return sendJson(response, 502, { error: payload.error.join(', ') });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 502, { error: error.message || 'Kraken public data is unavailable.' });
    }
  }

  if (!url.pathname.startsWith('/api/paper/')) return sendJson(response, 404, { error: 'Not found.' });
  if (!['POST', 'PUT'].includes(request.method)) return sendJson(response, 405, { error: 'Method not allowed.' });
  try {
    assertSameOrigin(request);
    const body = await readJson(request);

    if (request.method === 'PUT' && url.pathname === '/api/paper/settings') {
      const allowed = Object.keys(DEFAULT_SETTINGS);
      const next = { ...paper.settings };
      for (const key of allowed) {
        if (body[key] === undefined) continue;
        const value = Number(body[key]);
        if (!Number.isFinite(value)) return sendJson(response, 400, { error: `Invalid ${key}.` });
        const ranges = {
          feeBps: [0, 100],
          slippageBps: [0, 500],
          executionLatencyMs: [0, 10000],
          liquidityParticipationPct: [1, 100],
          maxRiskPct: [0.1, 5],
          dailyLossLimitPct: [0.5, 50],
          maxDrawdownPct: [1, 80],
        };
        if (value < ranges[key][0] || value > ranges[key][1]) return sendJson(response, 400, { error: `${key} is outside the allowed range.` });
        next[key] = value;
      }
      paper.settings = next;
      enforceRiskLimits(paper);
      saveState(paper);
      return sendJson(response, 200, stateSnapshot(paper));
    }

    if (request.method === 'POST' && url.pathname === '/api/paper/kill') {
      if (typeof body.enabled !== 'boolean') return sendJson(response, 400, { error: 'enabled must be a boolean.' });
      paper.manualKillSwitch = body.enabled;
      if (body.enabled) {
        for (const order of paper.orders) {
          if (isActiveOrder(order) && isEntrySide(order.side) && order.type !== 'STOP_LOSS') cancelOrder(order, 'Manual kill switch is active');
        }
      } else if (!paper.autoHaltReason) {
        paper.manualKillSwitch = false;
      }
      saveState(paper);
      return sendJson(response, 200, stateSnapshot(paper));
    }

    if (request.method === 'POST' && url.pathname === '/api/paper/reset') {
      const startingBalance = body.initialBalance === undefined ? paper.initialBalance : Number(body.initialBalance);
      if (!Number.isFinite(startingBalance) || startingBalance < 100 || startingBalance > 100000000) {
        return sendJson(response, 400, { error: 'Starting balance must be between 100 and 100,000,000 USDT.' });
      }
      paper = createInitialState(startingBalance);
      consecutiveMarketErrors = 0;
      saveState(paper);
      return sendJson(response, 200, stateSnapshot(paper));
    }

    if (request.method === 'POST' && url.pathname === '/api/paper/orders') {
      const symbol = String(body.symbol || '').toUpperCase();
      const side = String(body.side || '').toUpperCase();
      const type = String(body.type || '').toUpperCase();
      const quantity = Number(body.quantity);
      const stopLossPrice = Number(body.stopLossPrice);
      if (!validSymbol(symbol) || !['BUY', 'SELL', 'SHORT', 'COVER'].includes(side) || !['MARKET', 'LIMIT', 'STOP_MARKET'].includes(type)) {
        return sendJson(response, 400, { error: 'Invalid symbol, side, or order type.' });
      }
      if (isEntrySide(side) && (paper.manualKillSwitch || paper.autoHaltReason)) {
        return sendJson(response, 423, { error: paper.autoHaltReason || 'Manual kill switch is active.' });
      }
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000000) return sendJson(response, 400, { error: 'Order quantity must be greater than zero.' });
      if (isEntrySide(side) && (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0)) {
        return sendJson(response, 400, { error: 'A protective stop-loss price is required for every paper entry.' });
      }
      if ((type === 'LIMIT' && !(Number(body.limitPrice) > 0)) || (type === 'STOP_MARKET' && !(Number(body.triggerPrice) > 0))) {
        return sendJson(response, 400, { error: 'This order type requires a valid limit or trigger price.' });
      }
      const position = paper.positions[symbol];
      if (side === 'BUY' && position?.direction === 'SHORT') return sendJson(response, 400, { error: 'Cover the open simulated short before opening a long.' });
      if (side === 'SHORT' && position && position.direction !== 'SHORT') return sendJson(response, 400, { error: 'Close the open long before opening a simulated short.' });
      if (side === 'SELL' && (!position || position.direction === 'SHORT' || quantity > position.qty + 1e-10)) {
        return sendJson(response, 400, { error: 'A simulated long sell cannot exceed an open long position.' });
      }
      if (side === 'COVER' && (!position || position.direction !== 'SHORT' || quantity > position.qty + 1e-10)) {
        return sendJson(response, 400, { error: 'A cover order cannot exceed an open simulated short.' });
      }

      let market;
      let liquidity;
      try {
        if (paper.settings.executionLatencyMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, paper.settings.executionLatencyMs));
        }
        ({ market, liquidity } = await getMarketAndTick(symbol));
      } catch (error) {
        return sendJson(response, 503, { error: 'Fresh market data is required; the order was not accepted.', detail: error.message });
      }
      if (isEntrySide(side)) {
        const slip = paper.settings.slippageBps / 10000;
        const referenceEntry = type === 'LIMIT' ? Number(body.limitPrice) : type === 'STOP_MARKET' ? Number(body.triggerPrice)
          : side === 'BUY' ? market.askPrice * (1 + slip) : market.bidPrice * (1 - slip);
        if (side === 'BUY' && stopLossPrice >= referenceEntry) return sendJson(response, 400, { error: 'Long stop-loss must be below the expected entry price.' });
        if (side === 'SHORT' && stopLossPrice <= referenceEntry) return sendJson(response, 400, { error: 'Short stop-loss must be above the expected entry price.' });
        const stopDistance = side === 'SHORT' ? stopLossPrice - referenceEntry : referenceEntry - stopLossPrice;
        const feeRate = paper.settings.feeBps / 10000;
        const riskEstimate = Math.max(0, stopDistance) * quantity + (referenceEntry + stopLossPrice) * quantity * feeRate;
        const equityLimit = accountEquity(paper) * paper.settings.maxRiskPct / 100;
        if (positionRisk(position, paper.settings.feeBps) + riskEstimate > equityLimit + 1e-8) {
          return sendJson(response, 400, { error: `Estimated position risk exceeds the configured ${paper.settings.maxRiskPct}% account limit.` });
        }
        if (quantity * referenceEntry * (1 + feeRate) > paper.cash * 1.02) return sendJson(response, 400, { error: 'Order notional exceeds available 1× paper collateral.' });
      }

      const order = {
        id: `P-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        side,
        type,
        quantity,
        filledQty: 0,
        remainingQty: quantity,
        status: 'OPEN',
        limitPrice: type === 'LIMIT' ? Number(body.limitPrice) : null,
        triggerPrice: type === 'STOP_MARKET' ? Number(body.triggerPrice) : null,
        stopLossPrice: isEntrySide(side) ? stopLossPrice : null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cancelReason: null,
      };
      paper.orders.unshift(order);
      attemptFill(paper, order, market, liquidity);
      enforceRiskLimits(paper);
      saveState(paper);
      return sendJson(response, 201, { order, account: stateSnapshot(paper), market });
    }

    return sendJson(response, 404, { error: 'Unknown paper-trading action.' });
  } catch (error) {
    return sendJson(response, 400, { error: error.message || 'Invalid request.' });
  }
}

function serveStatic(request, response, pathname) {
  const files = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/styles.css': 'styles.css',
    '/local-simulator.js': 'local-simulator.js',
    '/kraken-bot.js': 'kraken-bot.js',
    '/app.js': 'app.js',
    '/kraken-ui.js': 'kraken-ui.js',
  };
  const filename = files[pathname];
  if (!filename || request.method !== 'GET') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  const filePath = path.join(__dirname, filename);
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Application files are unavailable.');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(contents);
  });
}

// A long-running paper engine must survive a failed cycle instead of exiting the process.
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error?.message || error);
});

const server = http.createServer(async (request, response) => {
  applySecurityHeaders(response);
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  } catch {
    return sendJson(response, 400, { error: 'Invalid request URL.' });
  }
  if (url.pathname.startsWith('/api/')) return handleApi(request, response, url);
  return serveStatic(request, response, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Paper trading dashboard available at http://${HOST}:${PORT}`);
  console.log('Live order execution is disabled and is not implemented.');
});
