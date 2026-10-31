(() => {
  const MARKET_API = 'https://data-api.binance.vision';
  const STORAGE_KEY = 'northstar-paper-account-v1';
  const DEFAULT_SETTINGS = {
    feeBps: 10,
    slippageBps: 5,
    executionLatencyMs: 250,
    liquidityParticipationPct: 10,
    maxRiskPct: 2,
    dailyLossLimitPct: 5,
    maxDrawdownPct: 15,
  };
  let consecutiveErrors = 0;

  function utcDay() {
    return new Date().toISOString().slice(0, 10);
  }

  function freshState(initialBalance = 10000) {
    const balance = Number(initialBalance);
    return {
      version: 1,
      initialBalance: balance,
      cash: balance,
      positions: {},
      orders: [],
      trades: [],
      settings: { ...DEFAULT_SETTINGS },
      manualKillSwitch: false,
      autoHaltReason: null,
      highWaterMark: balance,
      dayKey: utcDay(),
      dayStartEquity: balance,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function loadState() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (stored?.version === 1 && typeof stored.cash === 'number') {
        return { ...freshState(stored.initialBalance), ...stored, settings: { ...DEFAULT_SETTINGS, ...stored.settings } };
      }
    } catch {
      // Start a fresh paper account if browser storage is unavailable or invalid.
    }
    return freshState();
  }

  let paper = loadState();

  function saveState() {
    paper.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(paper));
    } catch {
      throw new Error('On-device storage is unavailable. Paper state could not be saved.');
    }
  }

  function positionRisk(position, feeBps = paper.settings.feeBps) {
    const feeRate = feeBps / 10000;
    return (position?.lots || []).reduce((total, lot) => {
      return total + Math.max(0, lot.entryPrice - lot.stopLossPrice) * lot.qty
        + lot.entryFeeRemaining + lot.qty * lot.stopLossPrice * feeRate;
    }, 0);
  }

  function equity(state = paper) {
    return state.cash + Object.values(state.positions).reduce((sum, position) => sum + position.qty * position.markPrice, 0);
  }

  function accountMetrics(state = paper) {
    const currentEquity = equity(state);
    const dailyPnl = currentEquity - state.dayStartEquity;
    return {
      equity: currentEquity,
      cash: state.cash,
      dailyPnl,
      dailyPnlPct: state.dayStartEquity ? dailyPnl / state.dayStartEquity * 100 : 0,
      drawdownPct: state.highWaterMark > 0 ? Math.max(0, (state.highWaterMark - currentEquity) / state.highWaterMark * 100) : 0,
      highWaterMark: state.highWaterMark,
      dayStartEquity: state.dayStartEquity,
      totalOpenRisk: Object.values(state.positions).reduce((sum, position) => sum + positionRisk(position), 0),
    };
  }

  function rollUtcDay() {
    const today = utcDay();
    if (paper.dayKey !== today) {
      paper.dayKey = today;
      paper.dayStartEquity = equity();
    }
  }

  function activeOrder(order) {
    return ['OPEN', 'PARTIALLY_FILLED'].includes(order.status) && order.remainingQty > 1e-12;
  }

  function enforceRiskLimits() {
    rollUtcDay();
    const values = accountMetrics();
    if (!paper.autoHaltReason && values.dailyPnl <= -(paper.dayStartEquity * paper.settings.dailyLossLimitPct / 100)) {
      paper.autoHaltReason = 'Daily loss limit reached';
    }
    if (!paper.autoHaltReason && values.drawdownPct >= paper.settings.maxDrawdownPct) {
      paper.autoHaltReason = 'Maximum drawdown reached';
    }
    if (!paper.autoHaltReason && Object.values(paper.positions).some((position) => positionRisk(position) > values.equity * paper.settings.maxRiskPct / 100)) {
      paper.autoHaltReason = 'Maximum position risk exceeded';
    }
    if (paper.autoHaltReason) {
      for (const order of paper.orders) {
        if (activeOrder(order) && order.side === 'BUY' && order.type !== 'STOP_LOSS') {
          order.status = 'CANCELLED';
          order.cancelReason = paper.autoHaltReason;
        }
      }
    }
  }

  function markPosition(market) {
    const position = paper.positions[market.symbol];
    if (position) position.markPrice = market.price;
    paper.highWaterMark = Math.max(paper.highWaterMark, equity());
    enforceRiskLimits();
  }

  function openPosition(symbol, qty, price, fee, stopLossPrice) {
    const position = paper.positions[symbol] || { qty: 0, avgEntry: 0, markPrice: price, lots: [] };
    position.lots.push({ qty, entryPrice: price, stopLossPrice, entryFeeRemaining: fee, openedAt: new Date().toISOString() });
    position.qty += qty;
    position.avgEntry = position.lots.reduce((sum, lot) => sum + lot.qty * lot.entryPrice, 0) / position.qty;
    position.markPrice = price;
    paper.positions[symbol] = position;
  }

  function closePosition(symbol, qty, price, exitFee) {
    const position = paper.positions[symbol];
    let remaining = qty;
    let realizedPnl = -exitFee;
    for (const lot of position.lots) {
      if (remaining <= 1e-12) break;
      const beforeQty = lot.qty;
      const closedQty = Math.min(beforeQty, remaining);
      const entryFee = lot.entryFeeRemaining * closedQty / beforeQty;
      realizedPnl += closedQty * (price - lot.entryPrice) - entryFee;
      lot.qty -= closedQty;
      lot.entryFeeRemaining -= entryFee;
      remaining -= closedQty;
    }
    position.lots = position.lots.filter((lot) => lot.qty > 1e-12);
    position.qty = position.lots.reduce((sum, lot) => sum + lot.qty, 0);
    position.avgEntry = position.qty > 0
      ? position.lots.reduce((sum, lot) => sum + lot.qty * lot.entryPrice, 0) / position.qty
      : 0;
    if (position.qty <= 1e-12) delete paper.positions[symbol];
    return realizedPnl;
  }

  function triggered(order, market) {
    if (order.type === 'MARKET' || order.type === 'STOP_LOSS') return true;
    if (order.type === 'LIMIT') return order.side === 'BUY' ? market.askPrice <= order.limitPrice : market.bidPrice >= order.limitPrice;
    if (order.type === 'STOP_MARKET') return order.side === 'BUY' ? market.price >= order.triggerPrice : market.price <= order.triggerPrice;
    return false;
  }

  function cancelOrder(order, reason) {
    order.status = 'CANCELLED';
    order.cancelReason = reason;
  }

  function attemptFill(order, market, liquidity) {
    if (!activeOrder(order) || !triggered(order, market)) return;
    if (order.side === 'BUY' && (paper.manualKillSwitch || paper.autoHaltReason)) {
      cancelOrder(order, paper.autoHaltReason || 'Manual kill switch is active');
      return;
    }
    const visibleQty = order.side === 'BUY' ? market.askQty : market.bidQty;
    const availableQty = order.side === 'BUY' ? liquidity.buyQty : liquidity.sellQty;
    const participation = paper.settings.liquidityParticipationPct / 100;
    let fillQty = Math.min(order.remainingQty, availableQty, visibleQty * participation);
    if (order.side === 'SELL') {
      const position = paper.positions[order.symbol];
      if (!position || position.qty <= 1e-12) {
        cancelOrder(order, 'No open spot position remains');
        return;
      }
      fillQty = Math.min(fillQty, position.qty);
    }
    if (fillQty <= 1e-12) {
      if (order.type === 'MARKET') cancelOrder(order, 'No top-of-book liquidity available; unfilled market remainder was cancelled');
      return;
    }
    const rawPrice = order.side === 'BUY' ? market.askPrice : market.bidPrice;
    const slip = paper.settings.slippageBps / 10000;
    let fillPrice = order.side === 'BUY' ? rawPrice * (1 + slip) : rawPrice * (1 - slip);
    if (order.type === 'LIMIT') fillPrice = order.side === 'BUY' ? Math.min(fillPrice, order.limitPrice) : Math.max(fillPrice, order.limitPrice);
    const feeRate = paper.settings.feeBps / 10000;
    if (order.side === 'BUY') {
      if (fillPrice <= order.stopLossPrice) {
        cancelOrder(order, 'Market crossed the protective stop before entry; order cancelled');
        return;
      }
      const cashLimitedQty = paper.cash / (fillPrice * (1 + feeRate));
      if (cashLimitedQty <= 1e-12) {
        cancelOrder(order, 'No simulated cash remains for this buy order');
        return;
      }
      fillQty = Math.min(fillQty, cashLimitedQty);
      const addedRisk = Math.max(0, fillPrice - order.stopLossPrice) * fillQty
        + fillQty * (fillPrice + order.stopLossPrice) * feeRate;
      if (positionRisk(paper.positions[order.symbol]) + addedRisk > equity() * paper.settings.maxRiskPct / 100 + 1e-8) {
        cancelOrder(order, 'Position risk limit would be exceeded at this fill price');
        return;
      }
    }
    if (fillQty <= 1e-12) return;

    const notional = fillQty * fillPrice;
    const fee = notional * feeRate;
    let realizedPnl = 0;
    if (order.side === 'BUY') {
      paper.cash -= notional + fee;
      openPosition(order.symbol, fillQty, fillPrice, fee, order.stopLossPrice);
      liquidity.buyQty = Math.max(0, liquidity.buyQty - fillQty);
    } else {
      paper.cash += notional - fee;
      realizedPnl = closePosition(order.symbol, fillQty, fillPrice, fee);
      liquidity.sellQty = Math.max(0, liquidity.sellQty - fillQty);
    }
    order.filledQty += fillQty;
    order.remainingQty = Math.max(0, order.quantity - order.filledQty);
    order.updatedAt = new Date().toISOString();
    order.status = order.remainingQty <= 1e-10 ? 'FILLED' : 'PARTIALLY_FILLED';
    paper.trades.unshift({
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
    });
    paper.trades = paper.trades.slice(0, 2000);
    if (order.type === 'MARKET' && order.remainingQty > 1e-10) {
      order.status = 'PARTIALLY_FILLED';
      order.cancelReason = 'Market remainder cancelled after the current quote snapshot';
      order.remainingQty = 0;
    }
  }

  function processMarket(market) {
    const liquidity = { buyQty: market.askQty, sellQty: market.bidQty };
    for (const order of paper.orders) {
      if (!activeOrder(order) || order.symbol !== market.symbol) continue;
      if (order.side === 'BUY' && (paper.manualKillSwitch || paper.autoHaltReason) && order.type !== 'STOP_LOSS') {
        cancelOrder(order, paper.autoHaltReason || 'Manual kill switch is active');
        continue;
      }
      attemptFill(order, market, liquidity);
    }
    const position = paper.positions[market.symbol];
    const stopTriggered = position?.lots.some((lot) => market.price <= lot.stopLossPrice);
    const activeStop = paper.orders.some((order) => activeOrder(order) && order.symbol === market.symbol && order.type === 'STOP_LOSS');
    if (stopTriggered && !activeStop) {
      const order = {
        id: `P-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol: market.symbol,
        side: 'SELL',
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
      paper.orders.unshift(order);
      attemptFill(order, market, liquidity);
    }
    paper.orders = paper.orders.slice(0, 1000);
    markPosition(market);
    return liquidity;
  }

  async function fetchJson(url) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6500);
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Market data provider returned HTTP ${response.status}`);
      return await response.json();
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function validSymbol(value) {
    return typeof value === 'string' && /^[A-Z0-9]{2,16}USDT$/.test(value);
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

  async function tick(symbol) {
    const orderSymbols = paper.orders.filter(activeOrder).map((order) => order.symbol);
    const symbols = [...new Set([symbol, ...Object.keys(paper.positions), ...orderSymbols])];
    try {
      const markets = await Promise.all(symbols.map(fetchMarket));
      consecutiveErrors = 0;
      const liquidity = new Map();
      for (const market of markets) liquidity.set(market.symbol, processMarket(market));
      saveState();
      return { market: markets.find((item) => item.symbol === symbol), liquidity: liquidity.get(symbol) };
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3 && !paper.autoHaltReason) {
        paper.autoHaltReason = 'Repeated market-data API errors; paper entries halted';
        saveState();
      }
      throw error;
    }
  }

  function snapshot() {
    const positions = Object.entries(paper.positions).map(([symbol, position]) => ({
      symbol,
      qty: position.qty,
      avgEntry: position.avgEntry,
      markPrice: position.markPrice,
      marketValue: position.qty * position.markPrice,
      unrealizedPnl: position.qty * (position.markPrice - position.avgEntry)
        - position.lots.reduce((sum, lot) => sum + lot.entryFeeRemaining, 0),
      openRisk: positionRisk(position),
      stopLoss: position.lots.length ? Math.min(...position.lots.map((lot) => lot.stopLossPrice)) : null,
    }));
    return {
      mode: 'PAPER',
      quoteCurrency: 'USDT',
      initialBalance: paper.initialBalance,
      metrics: accountMetrics(),
      positions,
      orders: paper.orders.slice(0, 40),
      trades: paper.trades.slice(0, 40),
      settings: paper.settings,
      manualKillSwitch: paper.manualKillSwitch,
      autoHaltReason: paper.autoHaltReason,
      lastUpdatedAt: paper.updatedAt,
      liveTradingEnabled: false,
    };
  }

  function parseBody(options) {
    try {
      return options.body ? JSON.parse(options.body) : {};
    } catch {
      throw new Error('Request body must be valid JSON.');
    }
  }

  async function api(url, options = {}) {
    const parsed = new URL(url, window.location.href);
    const method = options.method || 'GET';
    const body = parseBody(options);

    if (method === 'GET' && parsed.pathname === '/api/health') {
      return { ok: true, paperTradingAvailable: true, liveTradingEnabled: false, liveOrderExecutionImplemented: false, storage: 'on-device browser storage' };
    }
    if (method === 'GET' && parsed.pathname === '/api/live') {
      return { mode: 'LIVE', status: 'LOCKED', tradingEnabled: false, accountConnected: false, ordersEnabled: false, message: 'Live trading is not configured. No live credentials or order routes are installed.' };
    }
    if (method === 'GET' && parsed.pathname === '/api/paper') return snapshot();

    if (method === 'GET' && parsed.pathname === '/api/market') {
      const symbol = (parsed.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
      try {
        const result = await tick(symbol);
        return result.market;
      } catch (error) {
        throw new Error(error.message || 'Public market data is unavailable.');
      }
    }

    if (method === 'GET' && parsed.pathname === '/api/history') {
      const symbol = (parsed.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
      if (!validSymbol(symbol)) throw new Error('Use a USDT-quoted symbol such as BTCUSDT.');
      const response = await fetchJson(`${MARKET_API}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=120`);
      return {
        symbol,
        interval: '1m',
        source: 'Binance Spot public historical klines',
        candles: response.map((row) => ({ time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) })),
      };
    }

    if (method === 'PUT' && parsed.pathname === '/api/paper/settings') {
      const ranges = {
        feeBps: [0, 100],
        slippageBps: [0, 500],
        executionLatencyMs: [0, 10000],
        liquidityParticipationPct: [1, 100],
        maxRiskPct: [0.1, 5],
        dailyLossLimitPct: [0.5, 50],
        maxDrawdownPct: [1, 80],
      };
      const settings = { ...paper.settings };
      for (const [key, range] of Object.entries(ranges)) {
        if (body[key] === undefined) continue;
        const value = Number(body[key]);
        if (!Number.isFinite(value) || value < range[0] || value > range[1]) throw new Error(`${key} is outside the allowed range.`);
        settings[key] = value;
      }
      paper.settings = settings;
      enforceRiskLimits();
      saveState();
      return snapshot();
    }

    if (method === 'POST' && parsed.pathname === '/api/paper/kill') {
      if (typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
      paper.manualKillSwitch = body.enabled;
      if (body.enabled) {
        for (const order of paper.orders) {
          if (activeOrder(order) && order.type !== 'STOP_LOSS') cancelOrder(order, 'Manual kill switch is active');
        }
      }
      saveState();
      return snapshot();
    }

    if (method === 'POST' && parsed.pathname === '/api/paper/reset') {
      const initialBalance = body.initialBalance === undefined ? paper.initialBalance : Number(body.initialBalance);
      if (!Number.isFinite(initialBalance) || initialBalance < 100 || initialBalance > 100000000) {
        throw new Error('Starting balance must be between 100 and 100,000,000 USDT.');
      }
      paper = freshState(initialBalance);
      consecutiveErrors = 0;
      saveState();
      return snapshot();
    }

    if (method === 'POST' && parsed.pathname === '/api/paper/orders') {
      if (paper.manualKillSwitch || paper.autoHaltReason) throw new Error(paper.autoHaltReason || 'Manual kill switch is active.');
      const symbol = String(body.symbol || '').toUpperCase();
      const side = String(body.side || '').toUpperCase();
      const type = String(body.type || '').toUpperCase();
      const quantity = Number(body.quantity);
      const stopLossPrice = Number(body.stopLossPrice);
      if (!validSymbol(symbol) || !['BUY', 'SELL'].includes(side) || !['MARKET', 'LIMIT', 'STOP_MARKET'].includes(type)) throw new Error('Invalid symbol, side, or order type.');
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000000) throw new Error('Order quantity must be greater than zero.');
      if (side === 'BUY' && (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0)) throw new Error('A protective stop-loss price is required for every paper buy.');
      if ((type === 'LIMIT' && !(Number(body.limitPrice) > 0)) || (type === 'STOP_MARKET' && !(Number(body.triggerPrice) > 0))) throw new Error('This order type requires a valid limit or trigger price.');
      const existingPosition = paper.positions[symbol];
      if (side === 'SELL' && (!existingPosition || quantity > existingPosition.qty + 1e-10)) throw new Error('A spot paper sell cannot exceed the open position.');
      if (paper.settings.executionLatencyMs > 0) await new Promise((resolve) => window.setTimeout(resolve, paper.settings.executionLatencyMs));
      const { market, liquidity } = await tick(symbol);
      if (side === 'BUY') {
        const referenceEntry = type === 'LIMIT' ? Number(body.limitPrice) : type === 'STOP_MARKET' ? Number(body.triggerPrice) : market.askPrice * (1 + paper.settings.slippageBps / 10000);
        if (stopLossPrice >= referenceEntry) throw new Error('Buy stop-loss must be below the expected entry price.');
        const feeRate = paper.settings.feeBps / 10000;
        const riskEstimate = Math.max(0, referenceEntry - stopLossPrice) * quantity + (referenceEntry + stopLossPrice) * quantity * feeRate;
        if (positionRisk(paper.positions[symbol]) + riskEstimate > equity() * paper.settings.maxRiskPct / 100 + 1e-8) {
          throw new Error(`Estimated position risk exceeds the configured ${paper.settings.maxRiskPct}% account limit.`);
        }
        if (quantity * referenceEntry > paper.cash * 1.02) throw new Error('Order notional exceeds available paper cash.');
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
        stopLossPrice: side === 'BUY' ? stopLossPrice : null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cancelReason: null,
      };
      paper.orders.unshift(order);
      attemptFill(order, market, liquidity);
      enforceRiskLimits();
      saveState();
      return { order, account: snapshot(), market };
    }

    throw new Error('Unknown local paper-trading action.');
  }

  window.NorthstarLocalSimulator = { api };
})();
