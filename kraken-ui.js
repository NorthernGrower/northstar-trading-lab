(() => {
  const bot = window.NorthstarKrakenBot;
  const $ = (selector) => document.querySelector(selector);
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  let toastTimer = null;

  function showToast(message, isError = false) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.toggle('toast-error', isError);
    toast.classList.add('visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3600);
  }

  function number(value, digits = 2) {
    return Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value) : '—';
  }

  function dollars(value, sign = false) {
    if (!Number.isFinite(value)) return '—';
    const formatted = usd.format(Math.abs(value));
    if (!sign || value === 0) return value < 0 ? `−${formatted}` : formatted;
    return value > 0 ? `+${formatted}` : `−${formatted}`;
  }

  function cell(row, value, className = '') {
    const item = document.createElement('td');
    item.textContent = value;
    if (className) item.className = className;
    row.append(item);
    return item;
  }

  function signedClass(value) {
    return value > 0 ? 'positive' : value < 0 ? 'negative' : '';
  }

  function renderMarkets(snapshot) {
    const body = $('#kraken-markets-body');
    body.replaceChildren();
    const markets = snapshot.markets.slice(0, 30);
    if (!markets.length) {
      const row = document.createElement('tr');
      const item = document.createElement('td');
      item.colSpan = 9;
      item.className = 'empty-row';
      item.textContent = snapshot.scanError || 'Scan to load Kraken spot markets';
      row.append(item);
      body.append(row);
      return;
    }
    for (const market of markets) {
      const row = document.createElement('tr');
      const result = snapshot.backtests[market.pairKey];
      const signal = snapshot.latestSignals[market.pairKey]
        || (result?.error ? 'HISTORY ERROR' : result ? 'BACKTESTED' : market.eligible ? 'NOT TESTED' : 'SCAN ONLY');
      const signalText = result && !result.error ? `${result.strategyLabel} · ${signal}` : signal;
      const signalClass = signal.includes('READY') ? 'positive' : signal.includes('EXIT') ? 'negative' : 'muted-cell';
      const comparisons = result?.strategyVariants?.map((variant) => variant.error
        ? `${variant.strategyLabel || variant.strategy}: n/a`
        : `${variant.strategyLabel} ${variant.holdoutReturnPct >= 0 ? '+' : ''}${variant.holdoutReturnPct.toFixed(1)}% (${variant.holdoutTrades}t)`).join(' · ') || '—';
      cell(row, market.display, 'symbol-cell');
      cell(row, market.quote, market.eligible ? 'eligible-cell' : '');
      cell(row, `${market.todayChangePct >= 0 ? '+' : ''}${market.todayChangePct.toFixed(2)}%`, signedClass(market.todayChangePct));
      cell(row, market.volumeUsd === null ? '—' : dollars(market.volumeUsd));
      cell(row, `${market.spreadBps.toFixed(2)} bps`);
      cell(row, result?.error ? 'Unavailable' : result ? `${result.holdoutReturnPct >= 0 ? '+' : ''}${result.holdoutReturnPct.toFixed(2)}%` : '—', result ? signedClass(result.holdoutReturnPct) : '');
      cell(row, result && !result.error ? `${result.holdoutMaxDrawdownPct.toFixed(2)}%` : '—');
      cell(row, signalText, signalClass);
      cell(row, comparisons, 'strategy-comparison-cell');
      if (!market.eligible) row.classList.add('excluded-market-row');
      body.append(row);
    }
  }

  function renderSharedSignals(snapshot) {
    const body = $('#shared-signals-body');
    body.replaceChildren();
    const rows = snapshot.markets.filter((market) => snapshot.latestAnalysis[market.pairKey]).slice(0, 20);
    if (!rows.length) {
      const row = document.createElement('tr');
      const item = document.createElement('td');
      item.colSpan = 6;
      item.className = 'empty-row';
      item.textContent = 'Run a Kraken scan and backtest in Paper Trading to populate shared signals.';
      row.append(item);
      body.append(row);
      return;
    }
    for (const market of rows) {
      const row = document.createElement('tr');
      const analysis = snapshot.latestAnalysis[market.pairKey];
      const backtest = snapshot.backtests[market.pairKey];
      const fibText = analysis.fibLevel && analysis.fibLevel !== '—'
        ? `${analysis.fibLevel}${Number.isFinite(analysis.fibRatio) ? ` · ${number(analysis.fibRatio * 100, 1)}%` : ''}`
        : '—';
      cell(row, market.display, 'symbol-cell');
      cell(row, analysis.signal, analysis.signal.includes('READY') ? 'positive' : analysis.signal.includes('EXIT') ? 'negative' : 'muted-cell');
      cell(row, analysis.strategyLabel || '—');
      cell(row, analysis.waveLabel || '—', 'detail-cell');
      cell(row, fibText);
      cell(row, backtest && !backtest.error ? `${backtest.holdoutReturnPct >= 0 ? '+' : ''}${backtest.holdoutReturnPct.toFixed(2)}%` : '—', backtest ? signedClass(backtest.holdoutReturnPct) : '');
      body.append(row);
    }
  }

  function renderPositions(positions) {
    const body = $('#kraken-positions-body');
    body.replaceChildren();
    $('#kraken-position-count').textContent = String(positions.length);
    if (!positions.length) {
      const row = document.createElement('tr');
      const item = document.createElement('td');
      item.colSpan = 6;
      item.className = 'empty-row';
      item.textContent = 'No bot positions';
      row.append(item);
      body.append(row);
      return;
    }
    for (const position of positions) {
      const row = document.createElement('tr');
      cell(row, position.display, 'symbol-cell');
      cell(row, number(position.qty, 8));
      cell(row, `${number(position.entryPrice, 6)} ${position.quote}`);
      cell(row, `${number(position.markPrice, 6)} ${position.quote}`);
      cell(row, `${number(position.stopPrice, 6)} ${position.quote}`);
      cell(row, dollars(position.unrealizedPnl, true), signedClass(position.unrealizedPnl));
      body.append(row);
    }
  }

  function renderTrades(trades) {
    const body = $('#kraken-trades-body');
    body.replaceChildren();
    if (!trades.length) {
      const row = document.createElement('tr');
      const item = document.createElement('td');
      item.colSpan = 6;
      item.className = 'empty-row';
      item.textContent = 'No bot trades yet';
      row.append(item);
      body.append(row);
      return;
    }
    for (const trade of trades.slice(0, 12)) {
      const row = document.createElement('tr');
      const date = new Date(trade.timestamp);
      cell(row, Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—', 'time-cell');
      cell(row, trade.display, 'symbol-cell');
      cell(row, trade.side, trade.side === 'BUY' ? 'positive' : 'negative');
      cell(row, number(trade.qty, 8));
      cell(row, `${number(trade.price, 6)} ${trade.display.split('/')[1] || ''}`);
      cell(row, dollars(trade.realizedPnl, true), signedClass(trade.realizedPnl));
      body.append(row);
    }
  }

  function render(snapshot) {
    $('#kraken-market-count').textContent = number(snapshot.markets.length, 0);
    $('#kraken-eligible-count').textContent = number(snapshot.eligibleCount, 0);
    $('#kraken-backtest-count').textContent = `${number(snapshot.backtestCount, 0)} / ${number(snapshot.eligibleCount, 0)}`;
    $('#kraken-qualified-count').textContent = number(snapshot.qualifiedCount, 0);
    $('#kraken-equity').textContent = dollars(snapshot.equity);
    $('#kraken-daily-pnl').textContent = dollars(snapshot.dailyPnl, true);
    $('#kraken-daily-pnl').classList.toggle('positive', snapshot.dailyPnl > 0);
    $('#kraken-daily-pnl').classList.toggle('negative', snapshot.dailyPnl < 0);
    $('#kraken-drawdown').textContent = `${snapshot.drawdownPct.toFixed(2)}%`;
    $('#kraken-starting-balance').textContent = dollars(snapshot.initialBalance);

    const status = $('#kraken-status');
    if (snapshot.backtestRunning) {
      const done = snapshot.backtestProgress.done;
      const total = snapshot.backtestProgress.total;
      status.textContent = `Backtesting ${snapshot.backtestProgress.pair || 'Kraken markets'} · ${done} of ${total} · requests are rate-limited.`;
      $('#kraken-progress-wrap').classList.remove('hidden');
      $('#kraken-progress-bar').style.width = `${total ? done / total * 100 : 0}%`;
      $('#kraken-progress-label').textContent = `${done}/${total} pairs · about ${Math.ceil(Math.max(0, total - done) * 1.1 / 60)} minutes remaining at Kraken's safe request cadence`;
    } else {
      $('#kraken-progress-wrap').classList.add('hidden');
      status.textContent = snapshot.botStatus
        + (snapshot.lastScanAt ? ` · scanned ${new Date(snapshot.lastScanAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '');
    }
    const alert = $('#kraken-alert');
    const alertText = snapshot.autoHaltReason
      ? `Bot automatically halted: ${snapshot.autoHaltReason}. Reset the separate Kraken paper account to clear this safety halt.`
      : snapshot.botError || snapshot.scanError
        || (!snapshot.backtestRunning && snapshot.backtestCount > 0 && snapshot.qualifiedCount === 0 ? 'No pair passed the holdout return, trade-count, and drawdown filters; the bot will not force a trade.' : null);
    if (alertText) {
      alert.textContent = alertText;
      alert.classList.remove('hidden', 'alert-warning', 'alert-danger', 'alert-success');
      alert.classList.add(snapshot.autoHaltReason ? 'alert-danger' : 'alert-warning');
    } else {
      alert.classList.add('hidden');
    }

    $('#kraken-scan').disabled = snapshot.scanning || snapshot.backtestRunning;
    $('#kraken-scan').textContent = snapshot.scanning ? 'Scanning…' : 'Scan Kraken markets';
    $('#kraken-backtest').disabled = snapshot.backtestRunning || snapshot.scanning || !snapshot.eligibleCount || snapshot.botActive || snapshot.positions.length > 0;
    $('#kraken-backtest').textContent = snapshot.backtestRunning ? 'Backtest running…' : `Backtest all ${snapshot.eligibleCount || ''} USD/USDT pairs`.replace('  ', ' ');
    $('#kraken-backtest-cancel').classList.toggle('hidden', !snapshot.backtestRunning);
    const toggle = $('#kraken-bot-toggle');
    const hasPositions = snapshot.positions.length > 0;
    toggle.textContent = snapshot.botEntriesEnabled ? 'Pause new entries'
      : snapshot.botActive ? 'Resume entries'
        : hasPositions && snapshot.qualifiedCount === 0 ? 'Monitor open positions' : 'Start paper bot';
    toggle.classList.toggle('button-danger', snapshot.botEntriesEnabled);
    toggle.classList.toggle('button-buy', !snapshot.botEntriesEnabled);
    toggle.disabled = snapshot.botEntriesEnabled ? false
      : snapshot.backtestRunning || (!snapshot.markets.length && !hasPositions) || (Boolean(snapshot.autoHaltReason) && !hasPositions) || (snapshot.qualifiedCount === 0 && !hasPositions);

    const form = $('#kraken-settings-form');
    for (const [name, value] of Object.entries(snapshot.settings)) {
      const input = form.elements.namedItem(name);
      if (input && document.activeElement !== input) input.value = value;
    }
    renderMarkets(snapshot);
    renderSharedSignals(snapshot);
    renderPositions(snapshot.positions);
    renderTrades(snapshot.trades);
  }

  $('#kraken-scan').addEventListener('click', async () => {
    try {
      await bot.scan();
      showToast('Kraken public spot markets scanned.');
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $('#kraken-backtest').addEventListener('click', async () => {
    try {
      await bot.backtestAll();
      showToast(`Kraken ${bot.getSnapshot().settings.intervalMinutes}m holdout backtests completed.`);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $('#kraken-backtest-cancel').addEventListener('click', () => bot.cancelBacktest());
  $('#kraken-bot-toggle').addEventListener('click', () => {
    try {
      if (bot.getSnapshot().botEntriesEnabled) bot.pauseEntries();
      else bot.startBot();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $('#kraken-reset').addEventListener('click', () => {
    if (!window.confirm('Reset the separate Kraken paper balance, positions, backtests, and trade log?')) return;
    bot.resetAccount();
    showToast('Kraken paper bot account reset.');
  });
  $('#kraken-settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      bot.updateSettings(values);
      showToast('Kraken paper bot settings saved. Rerun backtests before restarting.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  bot.subscribe(render);
  if (!bot.getSnapshot().markets.length) bot.scan().catch(() => {});
})();
