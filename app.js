(() => {
  const $ = (selector) => document.querySelector(selector);
  const amountFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
  let symbol = 'BTCUSDT';
  let side = 'BUY';
  let activeTable = 'trades';
  let account = null;
  let market = null;
  let candles = [];
  let lastHistoryAt = 0;
  let refreshTimer = null;
  let toastTimer = null;
  let marketAvailable = false;
  let refreshInProgress = false;
  let backendMode = null;

  function setRuntimeMode(onDevice) {
    $('#runtime-mode').textContent = onDevice ? 'ON-DEVICE PAPER' : 'SERVER MODE';
    $('#runtime-mode').classList.toggle('runtime-device', onDevice);
    $('#storage-subtitle').textContent = onDevice ? 'Saved in this browser · starting assumptions' : 'Saved on this server · starting assumptions';
    $('#activity-storage-note').textContent = onDevice
      ? 'Paper account and trade log stay in this browser on this device. No brokerage account data is read or changed.'
      : 'Trades and account state are stored on this server. No brokerage account data is read or changed.';
  }

  async function api(url, options = {}) {
    if (backendMode === false) return window.NorthstarLocalSimulator.api(url, options);
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
      });
    } catch (error) {
      if (backendMode === null) {
        backendMode = false;
        setRuntimeMode(true);
        return window.NorthstarLocalSimulator.api(url, options);
      }
      throw error;
    }
    const contentType = response.headers.get('content-type') || '';
    if (backendMode === null && (response.status === 404 || !contentType.includes('application/json'))) {
      backendMode = false;
      setRuntimeMode(true);
      return window.NorthstarLocalSimulator.api(url, options);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    if (backendMode === null) {
      backendMode = true;
      setRuntimeMode(false);
    }
    return payload;
  }

  function showToast(message, error = false) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.toggle('toast-error', error);
    toast.classList.add('visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3400);
  }

  function priceFormat(value) {
    if (!Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: value >= 100 ? 2 : value >= 1 ? 4 : 6,
    }).format(value);
  }

  function quantityFormat(value) {
    if (!Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(value);
  }

  function money(value, sign = false) {
    if (!Number.isFinite(value)) return '—';
    const formatted = `${amountFormat.format(Math.abs(value))} USDT`;
    if (!sign || value === 0) return value < 0 ? `−${formatted}` : formatted;
    return value > 0 ? `+${formatted}` : `−${formatted}`;
  }

  function applySignedStyle(element, value) {
    element.classList.toggle('positive', value > 0);
    element.classList.toggle('negative', value < 0);
  }

  function appendCell(row, value, className = '') {
    const cell = document.createElement('td');
    cell.textContent = value;
    if (className) cell.className = className;
    row.append(cell);
    return cell;
  }

  function addClass(row, index, className) {
    const cell = row.children[index];
    if (cell) cell.classList.add(className);
  }

  function formatTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function setPaperAlert(message, severity = 'warning') {
    const banner = $('#paper-alert');
    banner.textContent = message;
    banner.classList.remove('hidden', 'alert-warning', 'alert-danger', 'alert-success');
    banner.classList.add(severity === 'danger' ? 'alert-danger' : severity === 'success' ? 'alert-success' : 'alert-warning');
  }

  function clearPaperAlert() {
    $('#paper-alert').classList.add('hidden');
  }

  function renderAccount() {
    if (!account) return;
    const metrics = account.metrics;
    $('#equity-value').textContent = money(metrics.equity);
    $('#cash-value').textContent = `Available cash ${money(metrics.cash)}`;
    $('#daily-pnl').textContent = money(metrics.dailyPnl, true);
    $('#daily-pnl-pct').textContent = `${metrics.dailyPnlPct >= 0 ? '+' : ''}${metrics.dailyPnlPct.toFixed(2)}% · UTC day, unrealized included`;
    $('#open-risk').textContent = money(metrics.totalOpenRisk);
    $('#risk-cap').textContent = `Limit ${account.settings.maxRiskPct}% per position`;
    $('#drawdown-value').textContent = `${metrics.drawdownPct.toFixed(2)}%`;
    $('#drawdown-cap').textContent = `Limit ${account.settings.maxDrawdownPct}% · peak ${money(metrics.highWaterMark)}`;
    applySignedStyle($('#daily-pnl'), metrics.dailyPnl);
    applySignedStyle($('#daily-pnl-pct'), metrics.dailyPnl);
    $('#kill-switch').textContent = account.manualKillSwitch ? 'Disable kill switch' : 'Enable kill switch';
    $('#kill-switch').classList.toggle('button-danger', account.manualKillSwitch);
    $('#kill-switch').classList.toggle('button-quiet', !account.manualKillSwitch);
    $('#kill-switch').disabled = Boolean(account.autoHaltReason);
    $('#kill-switch').title = account.autoHaltReason || '';

    if (account.autoHaltReason) {
      setPaperAlert(`Trading halted: ${account.autoHaltReason}. Risk exits remain available; reset the paper account to clear an automatic halt.`, 'danger');
    } else if (account.manualKillSwitch) {
      setPaperAlert('Manual kill switch is active. New paper orders are blocked; protective stop exits can still run.', 'warning');
    } else if (!marketAvailable) {
      setPaperAlert('Market data is unavailable. New paper orders are disabled until a fresh public quote is restored.', 'warning');
    } else {
      clearPaperAlert();
    }
    $('#submit-order').disabled = !marketAvailable || Boolean(account.autoHaltReason) || account.manualKillSwitch;
    renderPositions(account.positions);
    renderActivity();
    fillSettings(account.settings);
    updateOrderForm();
  }

  function renderPositions(positions) {
    const tbody = $('#positions-body');
    tbody.replaceChildren();
    $('#position-count').textContent = String(positions.length);
    if (!positions.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.className = 'empty-row';
      cell.textContent = 'No open positions yet';
      row.append(cell);
      tbody.append(row);
      return;
    }
    for (const position of positions) {
      const row = document.createElement('tr');
      appendCell(row, `${position.symbol.slice(0, -4)} / USDT`, 'symbol-cell');
      appendCell(row, quantityFormat(position.qty));
      appendCell(row, money(position.avgEntry));
      appendCell(row, money(position.markPrice));
      appendCell(row, money(position.unrealizedPnl, true));
      appendCell(row, position.stopLoss ? money(position.stopLoss) : '—');
      addClass(row, 4, position.unrealizedPnl >= 0 ? 'positive' : 'negative');
      tbody.append(row);
    }
  }

  function renderActivity() {
    const head = $('#activity-head');
    const body = $('#activity-body');
    head.replaceChildren();
    body.replaceChildren();
    const headerRow = document.createElement('tr');
    const headers = activeTable === 'trades'
      ? ['TIME', 'MARKET', 'SIDE', 'TYPE', 'QUANTITY', 'FILL PRICE', 'FEE', 'REALIZED P&L']
      : ['TIME', 'MARKET', 'SIDE', 'TYPE', 'QUANTITY', 'FILLED', 'STATUS', 'DETAILS'];
    headers.forEach((label) => appendCell(headerRow, label));
    head.append(headerRow);
    const entries = account ? (activeTable === 'trades' ? account.trades : account.orders) : [];
    if (!entries.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = headers.length;
      cell.className = 'empty-row';
      cell.textContent = activeTable === 'trades' ? 'No fills yet' : 'No orders yet';
      row.append(cell);
      body.append(row);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('tr');
      appendCell(row, formatTime(activeTable === 'trades' ? entry.timestamp : entry.createdAt), 'time-cell');
      appendCell(row, `${entry.symbol.slice(0, -4)} / USDT`, 'symbol-cell');
      appendCell(row, entry.side, entry.side === 'BUY' ? 'positive' : 'negative');
      appendCell(row, entry.type.replaceAll('_', ' '));
      appendCell(row, quantityFormat(entry.qty ?? entry.quantity));
      if (activeTable === 'trades') {
        appendCell(row, money(entry.price));
        appendCell(row, money(entry.fee));
        appendCell(row, money(entry.realizedPnl, true), entry.realizedPnl > 0 ? 'positive' : entry.realizedPnl < 0 ? 'negative' : '');
      } else {
        appendCell(row, quantityFormat(entry.filledQty));
        appendCell(row, entry.status, entry.status === 'FILLED' ? 'positive' : entry.status === 'CANCELLED' ? 'negative' : '');
        appendCell(row, entry.cancelReason || (entry.remainingQty > 0 ? `${quantityFormat(entry.remainingQty)} remaining` : '—'), 'detail-cell');
      }
      body.append(row);
    }
  }

  function fillSettings(settings) {
    const form = $('#settings-form');
    for (const [name, value] of Object.entries(settings)) {
      const input = form.elements.namedItem(name);
      if (input && document.activeElement !== input) input.value = value;
    }
  }

  function renderResearch() {
    const regime = $('#regime-value');
    const rsiElement = $('#rsi-value');
    const smaElement = $('#sma-value');
    if (candles.length < 20) {
      regime.textContent = 'Waiting for candle history';
      $('#regime-detail').textContent = 'No prediction is generated';
      rsiElement.textContent = '—';
      smaElement.textContent = '—';
      $('#sma-detail').textContent = 'USDT simple moving average';
      regime.classList.remove('positive', 'negative');
      return;
    }
    const closes = candles.map((candle) => candle.close);
    const recent = closes.slice(-20);
    const sma20 = recent.reduce((sum, value) => sum + value, 0) / recent.length;
    const current = closes[closes.length - 1];
    const older = closes.slice(-40, -20);
    const priorSma = older.length === 20 ? older.reduce((sum, value) => sum + value, 0) / older.length : sma20;
    const trendPct = priorSma ? (sma20 - priorSma) / priorSma * 100 : 0;
    let regimeLabel = 'RANGE / MIXED';
    if (current > sma20 && trendPct > 0.05) regimeLabel = 'UP TREND';
    else if (current < sma20 && trendPct < -0.05) regimeLabel = 'DOWN TREND';
    regime.textContent = regimeLabel;
    regime.classList.toggle('positive', regimeLabel === 'UP TREND');
    regime.classList.toggle('negative', regimeLabel === 'DOWN TREND');
    $('#regime-detail').textContent = `Close vs SMA20 · MA shift ${trendPct >= 0 ? '+' : ''}${trendPct.toFixed(3)}%`;
    $('#sma-detail').textContent = `${priceFormat(sma20)} USDT · current close ${priceFormat(current)}`;
    smaElement.textContent = `${priceFormat(sma20)} USDT`;

    if (closes.length < 15) {
      rsiElement.textContent = '—';
      return;
    }
    let gains = 0;
    let losses = 0;
    for (let index = closes.length - 14; index < closes.length; index += 1) {
      const difference = closes[index] - closes[index - 1];
      if (difference > 0) gains += difference;
      else losses -= difference;
    }
    const averageGain = gains / 14;
    const averageLoss = losses / 14;
    const rsi = averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - (100 / (1 + averageGain / averageLoss));
    rsiElement.textContent = rsi.toFixed(1);
    rsiElement.classList.toggle('positive', rsi < 30);
    rsiElement.classList.toggle('negative', rsi > 70);
  }

  function renderMarket() {
    if (!market) return;
    $('#chart-subtitle').textContent = `${symbol.slice(0, -4)} / USDT · 1 minute`;
    $('#market-price').textContent = money(market.price);
    const change = $('#market-change');
    change.textContent = `${market.changePct >= 0 ? '+' : ''}${market.changePct.toFixed(2)}%`;
    change.classList.toggle('positive', market.changePct >= 0);
    change.classList.toggle('negative', market.changePct < 0);
    $('#best-bid').textContent = priceFormat(market.bidPrice);
    $('#best-ask').textContent = priceFormat(market.askPrice);
    const spread = ((market.askPrice - market.bidPrice) / ((market.askPrice + market.bidPrice) / 2)) * 10000;
    $('#spread-value').textContent = `${spread.toFixed(2)} bps`;
    $('#volume-value').textContent = `${compactNumber.format(market.volume)} ${symbol.slice(0, -4)}`;
    $('#last-updated').textContent = `Updated ${formatTime(market.fetchedAt)}`;
    marketAvailable = true;
    $('#header-data-status').textContent = 'Public market data connected';
    $('#sidebar-data-status').textContent = 'Binance public feed';
    $('#header-data-dot').classList.remove('offline');
    $('#header-data-dot').classList.add('online');
    updateOrderForm();
    renderResearch();
    drawChart();
  }

  function renderMarketOffline(message) {
    marketAvailable = false;
    $('#header-data-status').textContent = 'Market data unavailable';
    $('#sidebar-data-status').textContent = 'Quote unavailable';
    $('#header-data-dot').classList.remove('online');
    $('#header-data-dot').classList.add('offline');
    $('#last-updated').textContent = 'Waiting for a fresh quote';
    $('#submit-order').disabled = true;
    if (message && account && !account.autoHaltReason && !account.manualKillSwitch) setPaperAlert(`${message} New orders are disabled while quotes are stale.`, 'warning');
  }

  function updateOrderForm() {
    const base = symbol.slice(0, -4);
    $('#quantity-unit').textContent = base;
    $('#quantity-hint').textContent = `Base asset · ${base}`;
    const type = $('#order-type').value;
    $('#limit-field').classList.toggle('hidden', type !== 'LIMIT');
    $('#trigger-field').classList.toggle('hidden', type !== 'STOP_MARKET');
    $('#stop-field').classList.toggle('hidden', side !== 'BUY');
    const submit = $('#submit-order');
    submit.textContent = `Place simulated ${side.toLowerCase()}`;
    submit.classList.toggle('button-buy', side === 'BUY');
    submit.classList.toggle('button-sell', side === 'SELL');
    const qty = Number($('#quantity-input').value);
    const reference = market?.price || 0;
    $('#notional-estimate').textContent = qty > 0 && reference > 0 ? money(qty * reference) : '—';
    if (side === 'BUY' && market && !$('#stop-price-input').value) {
      $('#stop-price-input').value = (market.price * 0.98).toFixed(market.price >= 100 ? 2 : 6);
    }
  }

  function drawChart() {
    const canvas = $('#price-chart');
    const empty = $('#chart-empty');
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (!width || !height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    if (candles.length < 2) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    const padding = { top: 14, right: 10, bottom: 12, left: 10 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;
    const values = candles.flatMap((candle) => [candle.high, candle.low]);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max === min) { max += 1; min -= 1; }
    const gap = (max - min) * 0.1;
    min -= gap;
    max += gap;
    const y = (value) => padding.top + (max - value) / (max - min) * chartH;
    context.strokeStyle = 'rgba(255,255,255,0.055)';
    context.lineWidth = 1;
    for (let i = 0; i < 4; i += 1) {
      const lineY = padding.top + chartH * i / 3;
      context.beginPath();
      context.moveTo(padding.left, lineY);
      context.lineTo(width - padding.right, lineY);
      context.stroke();
    }
    const slot = chartW / candles.length;
    const bodyWidth = Math.max(1, Math.min(5, slot * 0.58));
    candles.forEach((candle, index) => {
      const x = padding.left + slot * (index + 0.5);
      const up = candle.close >= candle.open;
      const color = up ? '#64d5a3' : '#ed7786';
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, y(candle.high));
      context.lineTo(x, y(candle.low));
      context.stroke();
      const openY = y(candle.open);
      const closeY = y(candle.close);
      const bodyHeight = Math.max(1, Math.abs(closeY - openY));
      context.fillRect(x - bodyWidth / 2, Math.min(openY, closeY), bodyWidth, bodyHeight);
    });
    if (market?.price) {
      const priceY = y(market.price);
      context.strokeStyle = 'rgba(104, 187, 255, 0.65)';
      context.setLineDash([3, 4]);
      context.beginPath();
      context.moveTo(padding.left, priceY);
      context.lineTo(width - padding.right, priceY);
      context.stroke();
      context.setLineDash([]);
    }
  }

  async function refreshMarket(forceHistory = false) {
    if (refreshInProgress) return;
    refreshInProgress = true;
    const requestedSymbol = symbol;
    try {
      try {
        const result = await api(`/api/market?symbol=${encodeURIComponent(requestedSymbol)}`);
        if (symbol === requestedSymbol) {
          market = result;
          renderMarket();
        }
      } catch (error) {
        if (symbol === requestedSymbol) renderMarketOffline(error.message);
      }
      try {
        account = await api('/api/paper');
        renderAccount();
      } catch (error) {
        showToast(`Paper account unavailable: ${error.message}`, true);
      }
      const now = Date.now();
      if (symbol === requestedSymbol && (forceHistory || now - lastHistoryAt > 60000)) {
        try {
          const result = await api(`/api/history?symbol=${encodeURIComponent(requestedSymbol)}`);
          if (symbol === requestedSymbol) {
            candles = result.candles;
            lastHistoryAt = now;
            renderResearch();
            drawChart();
          }
        } catch {
          if (symbol === requestedSymbol) {
            candles = [];
            renderResearch();
            drawChart();
          }
        }
      }
    } finally {
      refreshInProgress = false;
    }
  }

  function switchMode(mode) {
    const paperMode = mode === 'paper';
    document.querySelectorAll('.nav-item').forEach((button) => {
      const selected = button.dataset.mode === mode;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    $('#paper-view').classList.toggle('active', paperMode);
    $('#live-view').classList.toggle('active', !paperMode);
    $('#breadcrumb-mode').textContent = paperMode ? 'PAPER TRADING' : 'LIVE TRADING';
    window.history.replaceState(null, '', paperMode ? '#paper' : '#live');
    if (!paperMode) api('/api/live').catch(() => {});
    if (paperMode) window.setTimeout(drawChart, 30);
  }

  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => switchMode(button.dataset.mode)));
  document.querySelectorAll('.side-button').forEach((button) => button.addEventListener('click', () => {
    side = button.dataset.side;
    document.querySelectorAll('.side-button').forEach((item) => item.classList.toggle('selected', item === button));
    updateOrderForm();
  }));
  document.querySelectorAll('.activity-tab').forEach((button) => button.addEventListener('click', () => {
    activeTable = button.dataset.table;
    document.querySelectorAll('.activity-tab').forEach((item) => item.classList.toggle('active', item === button));
    renderActivity();
  }));

  $('#symbol-select').addEventListener('change', async (event) => {
    symbol = event.target.value;
    market = null;
    candles = [];
    lastHistoryAt = 0;
    $('#quantity-input').value = '';
    $('#stop-price-input').value = '';
    $('#chart-subtitle').textContent = `${symbol.slice(0, -4)} / USDT · 1 minute`;
    await refreshMarket(true);
  });
  $('#order-type').addEventListener('change', updateOrderForm);
  $('#quantity-input').addEventListener('input', updateOrderForm);

  $('#submit-order').addEventListener('click', async () => {
    const payload = {
      symbol,
      side,
      type: $('#order-type').value,
      quantity: Number($('#quantity-input').value),
      stopLossPrice: side === 'BUY' ? Number($('#stop-price-input').value) : undefined,
      limitPrice: $('#order-type').value === 'LIMIT' ? Number($('#limit-price-input').value) : undefined,
      triggerPrice: $('#order-type').value === 'STOP_MARKET' ? Number($('#trigger-price-input').value) : undefined,
    };
    try {
      const result = await api('/api/paper/orders', { method: 'POST', body: JSON.stringify(payload) });
      account = result.account;
      renderAccount();
      const order = result.order;
      const message = order.status === 'FILLED'
        ? `Paper order filled ${quantityFormat(order.filledQty)} ${symbol.slice(0, -4)}.`
        : order.status === 'PARTIALLY_FILLED'
          ? `Paper order partially filled ${quantityFormat(order.filledQty)}; remaining quantity is open or cancelled.`
          : 'Paper order accepted and waiting for its price condition.';
      showToast(message);
      await refreshMarket();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload = Object.fromEntries(data.entries());
    try {
      account = await api('/api/paper/settings', { method: 'PUT', body: JSON.stringify(payload) });
      renderAccount();
      showToast('Simulation and risk settings saved.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $('#kill-switch').addEventListener('click', async () => {
    if (!account) return;
    const enabled = !account.manualKillSwitch;
    if (enabled && !window.confirm('Stop new paper orders and cancel open entries? Protective stop exits will remain active.')) return;
    try {
      account = await api('/api/paper/kill', { method: 'POST', body: JSON.stringify({ enabled }) });
      renderAccount();
      showToast(enabled ? 'Paper kill switch enabled.' : 'Paper kill switch disabled.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $('#reset-account').addEventListener('click', async () => {
    if (!window.confirm('Reset the paper balance, positions, orders, and trade log? This cannot be undone.')) return;
    const entered = window.prompt('Starting simulated balance in USDT:', String(account?.initialBalance || 10000));
    if (entered === null) return;
    const initialBalance = Number(entered);
    try {
      account = await api('/api/paper/reset', { method: 'POST', body: JSON.stringify({ initialBalance }) });
      renderAccount();
      showToast('Paper account reset.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  window.addEventListener('resize', drawChart);
  const initialMode = window.location.hash === '#live' ? 'live' : 'paper';
  switchMode(initialMode);
  refreshMarket(true);
  refreshTimer = window.setInterval(() => refreshMarket(false), 4000);
  window.addEventListener('pagehide', () => window.clearInterval(refreshTimer));
})();
