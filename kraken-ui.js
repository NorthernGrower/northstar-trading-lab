(() => {
  const bot = window.NorthstarKrakenBot;
  const $ = (selector) => document.querySelector(selector);
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  let toastTimer = null;
  let selectedPairKey = null;
  let marketFilter = '';
  let detailInterval = Number(bot.getSnapshot().settings.intervalMinutes) || 5;
  let detailData = null;
  let detailLoadToken = 0;
  let detailLoading = false;
  let detailLoadingPairKey = null;
  let detailLoadError = null;
  let freshnessTimer = null;

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

  function marketTier(market) {
    const volume = Number(market.volumeUsd);
    if (Number.isFinite(volume) && volume >= 50000000) return 'MAJOR';
    if (Number.isFinite(volume) && volume >= 5000000) return 'MID';
    return 'SMALL';
  }

  function topDriver(analysis) {
    if (!analysis?.available) return '—';
    if (analysis.candlePatterns?.length) return analysis.candlePatterns[0].name;
    const strongest = [...(analysis.votes || [])].sort((a, b) => Math.abs(b.vote * b.weight) - Math.abs(a.vote * a.weight))[0];
    return strongest ? strongest.label : '—';
  }

  function signalClass(signal) {
    if (!signal) return 'muted-cell';
    if (signal === 'ENTRY READY') return 'positive';
    if (signal === 'EXIT SIGNAL') return 'negative';
    if (signal === 'BLOCKED') return 'negative';
    return 'muted-cell';
  }

  function levelCell(row, analysis, market) {
    const item = document.createElement('td');
    item.className = 'levels-cell';
    row.append(item);
    if (!analysis?.available) {
      item.textContent = '—';
      item.classList.add('muted-cell');
      return;
    }
    const target = document.createElement('span');
    target.textContent = pairPrice(analysis.targetPrice, market);
    const stop = document.createElement('span');
    stop.className = 'muted-cell';
    stop.textContent = pairPrice(analysis.stopPrice, market);
    item.append(target, stop);
  }

  function renderMarkets(snapshot) {
    const body = $('#kraken-markets-body');
    body.replaceChildren();
    const matching = snapshot.markets.filter((market) => !marketFilter
      || market.display.toLowerCase().includes(marketFilter)
      || market.base.toLowerCase().includes(marketFilter)
      || market.quote.toLowerCase().includes(marketFilter));
    const markets = matching.slice(0, 100);
    $('#kraken-market-list-count').textContent = `${snapshot.markets.length} pairs · ${snapshot.analyzedCount} scored · ${snapshot.candidateCount} entry-ready · showing ${markets.length}${marketFilter ? ` matching “${marketFilter}”` : ''} · score is a heuristic, not a probability`;
    if (!markets.length) {
      const row = document.createElement('tr');
      const item = document.createElement('td');
      item.colSpan = 9;
      item.className = 'empty-row';
      item.textContent = snapshot.scanError || 'Waiting for the first Kraken scan';
      row.append(item);
      body.append(row);
      return;
    }
    for (const market of markets) {
      const row = document.createElement('tr');
      const analysis = snapshot.latestAnalysis[market.pairKey];
      row.dataset.pairKey = market.pairKey;
      row.tabIndex = 0;
      row.classList.add('selectable-market-row');
      if (selectedPairKey === market.pairKey) row.classList.add('selected-market-row');
      cell(row, market.display, 'symbol-cell');
      cell(row, `${market.tradeScore ?? 0}/100`, market.tradeScore >= 70 ? 'positive score-cell' : market.tradeScore >= 50 ? 'score-cell' : 'muted-cell score-cell');
      cell(row, analysis?.signal || (market.eligible ? 'WAITING' : 'SCAN ONLY'), signalClass(analysis?.signal));
      cell(row, pairPrice(market.last, market), 'price-cell');
      cell(row, `${market.todayChangePct >= 0 ? '+' : ''}${market.todayChangePct.toFixed(2)}%`, signedClass(market.todayChangePct));
      cell(row, market.volumeUsd === null ? '—' : dollars(market.volumeUsd));
      cell(row, `${market.spreadBps.toFixed(2)} bps`);
      levelCell(row, analysis, market);
      cell(row, topDriver(analysis), 'detail-cell');
      if (!market.eligible) row.classList.add('excluded-market-row');
      body.append(row);
    }
  }

  function pairPrice(value, market) {
    if (!Number.isFinite(value)) return '—';
    const digits = Math.max(2, Math.min(10, Math.round(Number(market.pair_decimals) || 2)));
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
  }

  function fillList(element, values, emptyText) {
    element.replaceChildren();
    const rows = values?.length ? values : [emptyText];
    for (const value of rows) {
      const item = document.createElement('li');
      item.textContent = value;
      element.append(item);
    }
  }

  function canvasContext(canvas) {
    const bounds = canvas.getBoundingClientRect();
    const width = Math.floor(bounds.width);
    const height = Math.floor(bounds.height);
    if (width < 2 || height < 2) return null;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
    }
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    return { context, width, height };
  }

  function drawIndicatorLine(context, values, start, count, xAt, yAt, color, width = 1.2) {
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = width;
    let drawing = false;
    for (let index = 0; index < count; index += 1) {
      const value = values[start + index];
      if (!Number.isFinite(value)) { drawing = false; continue; }
      const x = xAt(index);
      const y = yAt(value);
      if (drawing) context.lineTo(x, y);
      else context.moveTo(x, y);
      drawing = true;
    }
    context.stroke();
  }

  function drawPriceChart(data, market) {
    const canvas = $('#coin-detail-chart');
    const layout = canvasContext(canvas);
    if (!layout || !data?.candles?.length) return;
    const { context: ctx, width, height } = layout;
    const candles = data.candles;
    const count = Math.min(110, candles.length);
    const start = candles.length - count;
    const visible = candles.slice(start);
    const { indicators } = data;
    const bands = indicators.bollinger || {};
    const values = [];
    for (const candle of visible) values.push(candle.high, candle.low);
    for (const series of [bands.upper, bands.lower, indicators.ema9, indicators.ema21, indicators.ema50, indicators.ema200]) {
      if (!series) continue;
      values.push(...series.slice(start).filter(Number.isFinite));
    }
    let min = Math.min(...values.filter(Number.isFinite));
    let max = Math.max(...values.filter(Number.isFinite));
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    const padding = Math.max((max - min) * .08, Math.abs(max) * .0001, 1e-8);
    min -= padding;
    max += padding;
    const left = 8;
    const right = 55;
    const top = 9;
    const bottom = 20;
    const plotWidth = Math.max(1, width - left - right);
    const plotHeight = Math.max(1, height - top - bottom);
    const xAt = (index) => left + (index + .5) * plotWidth / count;
    const yAt = (price) => top + (max - price) / (max - min) * plotHeight;

    ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let line = 0; line <= 4; line += 1) {
      const y = top + line * plotHeight / 4;
      const price = max - line * (max - min) / 4;
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(164,184,201,.10)';
      ctx.lineWidth = 1;
      ctx.moveTo(left, y);
      ctx.lineTo(width - right + 3, y);
      ctx.stroke();
      ctx.fillStyle = '#718293';
      ctx.fillText(pairPrice(price, market), width - right + 8, y);
    }

    if (bands.upper && bands.lower) {
      ctx.beginPath();
      let points = 0;
      for (let index = 0; index < count; index += 1) {
        const upper = bands.upper[start + index];
        if (!Number.isFinite(upper)) continue;
        if (points === 0) ctx.moveTo(xAt(index), yAt(upper));
        else ctx.lineTo(xAt(index), yAt(upper));
        points += 1;
      }
      for (let index = count - 1; index >= 0; index -= 1) {
        const lower = bands.lower[start + index];
        if (!Number.isFinite(lower)) continue;
        ctx.lineTo(xAt(index), yAt(lower));
        points += 1;
      }
      if (points > 2) {
        ctx.closePath();
        ctx.fillStyle = 'rgba(129,191,255,.045)';
        ctx.fill();
      }
      drawIndicatorLine(ctx, bands.upper, start, count, xAt, yAt, 'rgba(129,191,255,.42)', .8);
      drawIndicatorLine(ctx, bands.lower, start, count, xAt, yAt, 'rgba(129,191,255,.42)', .8);
    }

    const slot = plotWidth / count;
    const bodyWidth = Math.max(1.4, Math.min(7, slot * .58));
    visible.forEach((candle, index) => {
      const x = xAt(index);
      const openY = yAt(candle.open);
      const closeY = yAt(candle.close);
      const up = candle.close >= candle.open;
      const color = up ? '#67d5a4' : '#ef7b8b';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yAt(candle.high));
      ctx.lineTo(x, yAt(candle.low));
      ctx.stroke();
      const bodyTop = Math.min(openY, closeY);
      const bodyHeight = Math.max(1, Math.abs(closeY - openY));
      ctx.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
    });
    drawIndicatorLine(ctx, indicators.ema9, start, count, xAt, yAt, '#e5c96d', 1);
    drawIndicatorLine(ctx, indicators.ema21, start, count, xAt, yAt, '#69d6a5', 1.1);
    drawIndicatorLine(ctx, indicators.ema50, start, count, xAt, yAt, '#80bfff', 1.1);
    drawIndicatorLine(ctx, indicators.ema200, start, count, xAt, yAt, '#bd8df0', 1.2);

    const first = new Date(visible[0].time);
    const last = new Date(visible[visible.length - 1].time);
    ctx.fillStyle = '#6e7f90';
    ctx.textBaseline = 'bottom';
    ctx.fillText(first.toLocaleDateString([], { month: 'short', day: 'numeric' }), left, height - 2);
    const lastLabel = last.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.textAlign = 'right';
    ctx.fillText(lastLabel, width - right + 2, height - 2);
  }

  function drawRsiChart(data) {
    const layout = canvasContext($('#coin-rsi-chart'));
    if (!layout || !data?.candles?.length) return;
    const { context: ctx, width, height } = layout;
    const values = data.indicators.rsi || [];
    const count = Math.min(90, data.candles.length);
    const start = values.length - count;
    const left = 21, right = 5, top = 7, bottom = 7;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const xAt = (index) => left + (index + .5) * plotWidth / count;
    const yAt = (value) => top + (100 - value) / 100 * plotHeight;
    ctx.font = '7px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    [70, 50, 30].forEach((value) => {
      const y = yAt(value);
      ctx.beginPath(); ctx.strokeStyle = value === 50 ? 'rgba(164,184,201,.08)' : 'rgba(226,180,110,.18)';
      ctx.setLineDash(value === 50 ? [] : [3, 3]); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#758596'; ctx.fillText(String(value), 1, y);
    });
    drawIndicatorLine(ctx, values, start, count, xAt, yAt, '#82bfff', 1.3);
  }

  function drawMacdChart(data) {
    const layout = canvasContext($('#coin-macd-chart'));
    if (!layout || !data?.candles?.length) return;
    const { context: ctx, width, height } = layout;
    const macd = data.indicators.macd || [];
    const signal = data.indicators.macdSignal || [];
    const count = Math.min(90, data.candles.length);
    const start = Math.max(0, macd.length - count);
    const values = [];
    for (let index = start; index < macd.length; index += 1) {
      if (Number.isFinite(macd[index])) values.push(macd[index]);
      if (Number.isFinite(signal[index])) values.push(signal[index]);
      if (Number.isFinite(macd[index]) && Number.isFinite(signal[index])) values.push(macd[index] - signal[index]);
    }
    const range = Math.max(...values.map(Math.abs), 1e-8) * 1.15;
    const left = 4, right = 4, top = 7, bottom = 7;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const xAt = (index) => left + (index + .5) * plotWidth / count;
    const yAt = (value) => top + (range - value) / (range * 2) * plotHeight;
    const zeroY = yAt(0);
    ctx.beginPath(); ctx.strokeStyle = 'rgba(164,184,201,.14)'; ctx.moveTo(left, zeroY); ctx.lineTo(width - right, zeroY); ctx.stroke();
    const slot = plotWidth / count;
    for (let index = 0; index < count; index += 1) {
      const at = start + index;
      if (!Number.isFinite(macd[at]) || !Number.isFinite(signal[at])) continue;
      const value = macd[at] - signal[at];
      ctx.fillStyle = value >= 0 ? 'rgba(98,213,163,.75)' : 'rgba(239,123,139,.75)';
      const y = yAt(value);
      ctx.fillRect(xAt(index) - Math.max(1, slot * .32), Math.min(zeroY, y), Math.max(1, slot * .64), Math.max(1, Math.abs(zeroY - y)));
    }
    drawIndicatorLine(ctx, macd, start, count, xAt, yAt, '#82bfff', 1.1);
    drawIndicatorLine(ctx, signal, start, count, xAt, yAt, '#e5c96d', 1);
  }

  function drawDetailCharts() {
    if (!detailData?.candles?.length) {
      ['#coin-detail-chart', '#coin-rsi-chart', '#coin-macd-chart'].forEach((selector) => {
        const layout = canvasContext($(selector));
        if (layout) layout.context.clearRect(0, 0, layout.width, layout.height);
      });
      return;
    }
    const market = bot.getSnapshot().markets.find((item) => item.pairKey === detailData.pairKey) || detailData.market;
    drawPriceChart(detailData, market);
    drawRsiChart(detailData);
    drawMacdChart(detailData);
  }

  function renderCoinDetail(snapshot) {
    const panel = $('#coin-detail-panel');
    const market = snapshot.markets.find((item) => item.pairKey === selectedPairKey);
    if (!market) {
      panel.classList.add('hidden');
      $('#coins-view').classList.remove('detail-open');
      return;
    }
    panel.classList.remove('hidden');
    const hasDetail = detailData?.pairKey === market.pairKey && detailData.interval === detailInterval;
    const loadingThisPair = detailLoading && detailLoadingPairKey === market.pairKey;
    const analysis = hasDetail ? detailData.analysis : loadingThisPair ? null : snapshot.latestAnalysis[market.pairKey];
    const available = Boolean(analysis?.available);
    const intervalLabel = detailInterval >= 1440 ? `${Math.round(detailInterval / 1440)}D` : detailInterval >= 60 ? `${detailInterval / 60}H` : `${detailInterval}m`;
    $('#coin-detail-title').textContent = market.display;
    $('#coin-hero-avatar').textContent = String(market.base || market.display).slice(0, 3).toUpperCase();
    $('#coin-hero-tier').textContent = marketTier(market);
    $('#coin-hero-price').textContent = pairPrice(market.last, market);
    $('#coin-hero-change').textContent = `${market.todayChangePct >= 0 ? '+' : ''}${market.todayChangePct.toFixed(2)}% today`;
    $('#coin-hero-change').className = signedClass(market.todayChangePct);
    $('#coin-hero-volume').textContent = market.volumeUsd === null ? 'Volume unavailable' : `${dollars(market.volumeUsd)} traded`;
    $('#coin-hero-quote').textContent = `${market.quote} quote`;
    $('#coin-detail-subtitle').textContent = `Kraken public OHLC · ${intervalLabel} view · ${market.scoreGrade || 'PRELIMINARY'} · rule-generated analysis · no external AI model`;

    const lastCandle = detailData?.pairKey === market.pairKey ? detailData.candles?.[detailData.candles.length - 1] : null;
    $('#coin-chart-price').textContent = pairPrice(lastCandle?.close ?? market.last, market);
    if (lastCandle) {
      $('#coin-chart-updated').textContent = `Last closed bar ${new Date(lastCandle.time).toLocaleString()} · ${detailData.candles.length} candles`;
    } else {
      $('#coin-chart-updated').textContent = 'Latest Kraken ticker · waiting for closed-bar OHLC history';
    }
    const chartLoading = $('#coin-detail-chart-loading');
    if (hasDetail && detailData.candles.length) chartLoading.classList.add('hidden');
    else {
      chartLoading.textContent = detailLoadError?.pairKey === market.pairKey && detailLoadError.interval === detailInterval
        ? `OHLC history unavailable: ${detailLoadError.message}`
        : loadingThisPair ? 'Loading serialized Kraken public OHLC history…' : 'Select a pair to load its closed-bar chart.';
      chartLoading.classList.remove('hidden');
    }
    document.querySelectorAll('.coin-timeframe').forEach((button) => {
      const active = Number(button.dataset.interval) === detailInterval;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    const score = available ? analysis.confluenceScore : market.tradeScore ?? 0;
    $('#coin-detail-score').textContent = String(score);
    $('#coin-detail-grade').textContent = available ? analysis.signal : analysis?.reason || (market.eligible ? 'Awaiting technical scoring' : 'Scan-only quote currency');
    $('#coin-detail-score-bar').style.width = `${Math.max(0, Math.min(100, Number(score) || 0))}%`;
    $('#coin-detail-quote').textContent = market.quote;
    $('#coin-detail-volume').textContent = market.volumeUsd === null ? 'Unavailable' : dollars(market.volumeUsd);
    $('#coin-detail-spread').textContent = `${market.spreadBps.toFixed(2)} bps`;
    $('#coin-detail-change').textContent = `${market.todayChangePct >= 0 ? '+' : ''}${market.todayChangePct.toFixed(2)}%`;
    $('#coin-detail-regime').textContent = available ? analysis.regime : '—';
    $('#coin-detail-atr').textContent = available ? `${analysis.atrPct.toFixed(2)}% of price` : '—';
    $('#coin-detail-threshold').textContent = `+${snapshot.settings.entryScore} to enter · ${snapshot.settings.exitScore} to exit`;
    $('#coin-detail-stop').textContent = available ? `2×ATR ≈ ${analysis.stopPct.toFixed(2)}% below entry` : '—';
    $('#coin-detail-entry').textContent = available ? `${pairPrice(analysis.entryPrice, market)} ${market.quote}` : '—';
    $('#coin-detail-target').textContent = available ? `${pairPrice(analysis.targetPrice, market)} ${market.quote}` : '—';
    $('#coin-detail-stop-level').textContent = available ? `${pairPrice(analysis.stopPrice, market)} ${market.quote}` : '—';
    $('#coin-detail-raw-score').textContent = available ? `${analysis.score > 0 ? '+' : ''}${analysis.score} / 100` : '—';
    $('#coin-detail-confluence').textContent = available ? `${analysis.confluenceScore}/100 · ${analysis.confluenceCount} tools align` : '—';
    $('#coin-detail-wave').textContent = analysis?.waveLabel || 'No confirmed swing structure yet';
    $('#coin-detail-fib').textContent = analysis?.fib
      ? `${analysis.fib.level} retracement${analysis.fib.inZone ? ' · inside the 38.2–61.8% buy zone' : ' · outside the buy zone'}`
      : 'No confirmed swing pair to measure';

    const reasons = available ? analysis.reasons : [detailLoadError?.pairKey === market.pairKey ? detailLoadError.message : analysis?.reason || market.scoreReasons?.[0] || 'Technical scoring starts automatically on the next cycle.'];
    fillList($('#coin-detail-reasons'), reasons, 'No evidence is available yet.');
    const foundPatterns = analysis?.patterns || analysis?.candlePatterns || [];
    const patternLines = foundPatterns.map((pattern) => `${pattern.name} · ${pattern.bias} — ${pattern.note}`);
    fillList($('#coin-detail-patterns'), patternLines, 'No completed candlestick pattern on the last closed bar.');
    $('#coin-detail-patterns').querySelectorAll('li').forEach((item, index) => {
      const pattern = foundPatterns[index];
      if (pattern) item.className = pattern.bias === 'bullish' ? 'positive' : pattern.bias === 'bearish' ? 'negative' : 'muted-cell';
    });

    const factors = $('#coin-factor-breakdown');
    factors.replaceChildren();
    if (!available || !analysis.factorBreakdown?.length) {
      const empty = document.createElement('div');
      empty.className = 'muted-cell';
      empty.textContent = 'Factor scores load with sufficient closed-bar analysis.';
      factors.append(empty);
    } else {
      for (const factor of analysis.factorBreakdown) {
        const row = document.createElement('div'); row.className = 'coin-factor-row';
        const label = document.createElement('div'); label.className = 'coin-factor-name';
        const name = document.createElement('span'); name.textContent = factor.label;
        const detail = document.createElement('small'); detail.textContent = factor.detail;
        label.append(name, detail);
        const track = document.createElement('div'); track.className = 'coin-factor-track';
        const fill = document.createElement('span'); fill.style.width = `${Math.max(0, Math.min(100, factor.score))}%`; track.append(fill);
        const factorScore = document.createElement('strong'); factorScore.className = 'coin-factor-score'; factorScore.textContent = `${factor.score}/100`;
        const weight = document.createElement('span'); weight.className = 'coin-factor-weight'; weight.textContent = `${factor.weight}%`;
        row.append(label, track, factorScore, weight); factors.append(row);
      }
    }

    const diagnostics = $('#coin-detail-diagnostics');
    diagnostics.replaceChildren();
    const readings = available ? analysis.diagnostics || [] : [];
    if (!readings.length) {
      const empty = document.createElement('div'); empty.className = 'muted-cell';
      empty.textContent = 'Indicator tiles load with sufficient closed-bar analysis.'; diagnostics.append(empty);
    } else {
      for (const reading of readings) {
        const tile = document.createElement('div'); tile.className = 'coin-diagnostic';
        const label = document.createElement('span'); label.textContent = reading.label;
        const value = document.createElement('strong'); value.textContent = reading.value;
        const detail = document.createElement('small'); detail.textContent = reading.detail;
        tile.append(label, value, detail); diagnostics.append(tile);
      }
    }

    $('#coin-detail-verdict').textContent = available ? analysis.signal : 'WAIT';
    $('#coin-detail-verdict').classList.toggle('negative', analysis?.signal === 'BLOCKED' || analysis?.signal === 'EXIT SIGNAL');
    $('#coin-detail-thesis').textContent = available ? analysis.thesis : analysis?.reason || 'Detailed rule rationale appears after sufficient closed-bar analysis.';
    $('#coin-read-entry').textContent = available ? `${pairPrice(analysis.entryPrice, market)} ${market.quote}` : '—';
    $('#coin-read-target').textContent = available ? `${pairPrice(analysis.targetPrice, market)} ${market.quote}` : '—';
    $('#coin-read-stop').textContent = available ? `${pairPrice(analysis.stopPrice, market)} ${market.quote}` : '—';
    $('#coin-read-rr').textContent = available ? `${number(analysis.rewardRisk, 1)} : 1` : '—';
    $('#coin-detail-risk').textContent = analysis?.riskItems?.length ? analysis.riskItems.join(' ') : 'Risk read appears with closed-bar analysis; gaps and thin liquidity can exceed modeled stops.';
    $('#coin-detail-invalidation').textContent = analysis?.invalidation || '';

    const position = snapshot.positions.find((item) => item.pairKey === market.pairKey);
    let eligibility = '';
    if (!market.eligible) eligibility = `Not eligible: ${market.quote} is scan-only. Paper entries are restricted to USD/USDT quotes.`;
    else if (snapshot.dataStale) eligibility = 'Blocked: Kraken quotes are stale; new paper entries fail closed until a fresh scan succeeds.';
    else if (snapshot.haltedReason) eligibility = `Blocked by the paper safety halt: ${snapshot.haltedReason}.`;
    else if (position) eligibility = 'Already held in the paper account; the bot manages its stop and exit rules instead of opening another position.';
    else if (!snapshot.entriesEnabled) eligibility = 'New paper entries are paused. Existing paper positions remain managed.';
    else if (snapshot.positions.length >= snapshot.settings.maxPositions) eligibility = `Position limit reached (${snapshot.settings.maxPositions}); no new paper entry can open now.`;
    else if (!available) eligibility = 'Not scored on this interval yet; the bot requires sufficient closed candles and valid indicators.';
    else if (!analysis.tradeable) eligibility = 'Blocked by one or more configured spread, 24-hour volume, or ATR-volatility gates.';
    else if (!analysis.entryReady) eligibility = `Monitor only: the weighted vote has not cleared the +${snapshot.settings.entryScore} entry threshold.`;
    else if (detailInterval !== Number(snapshot.settings.intervalMinutes)) eligibility = `This ${intervalLabel} view meets the displayed gates, but auto-paper entries use the configured ${snapshot.settings.intervalMinutes}m interval.`;
    else eligibility = 'Meets the displayed quote, score, and market-quality gates. The rotating watchlist, open-position limit, and paper risk checks still apply.';
    $('#coin-detail-eligibility').textContent = eligibility;

    const votes = $('#coin-detail-votes');
    votes.replaceChildren();
    const rows = available ? [...analysis.votes].sort((a, b) => Math.abs(b.vote * b.weight) - Math.abs(a.vote * a.weight)) : [];
    if (!rows.length) {
      const row = document.createElement('tr'); const item = document.createElement('td');
      item.colSpan = 3; item.className = 'empty-row'; item.textContent = 'Tool votes appear once this pair has sufficient closed-bar history.';
      row.append(item); votes.append(row);
    } else {
      for (const vote of rows) {
        const row = document.createElement('tr');
        const contribution = Math.round(vote.vote * vote.weight);
        cell(row, vote.label); cell(row, vote.note, 'detail-cell');
        cell(row, `${contribution > 0 ? '+' : ''}${contribution} / ${vote.weight}`, signedClass(contribution));
        votes.append(row);
      }
    }
    window.requestAnimationFrame(drawDetailCharts);
  }

  function renderSharedSignals(snapshot) {
    const body = $('#shared-signals-body');
    body.replaceChildren();
    const rows = snapshot.markets
      .filter((market) => snapshot.latestAnalysis[market.pairKey]?.available)
      .slice(0, 15);
    if (!rows.length) {
      const row = document.createElement('tr');
      const item = document.createElement('td');
      item.colSpan = 6;
      item.className = 'empty-row';
      item.textContent = 'Kraken signals appear automatically once the background scanner scores its first pairs.';
      row.append(item);
      body.append(row);
      return;
    }
    for (const market of rows) {
      const row = document.createElement('tr');
      const analysis = snapshot.latestAnalysis[market.pairKey];
      row.dataset.pairKey = market.pairKey;
      row.tabIndex = 0;
      row.setAttribute('aria-label', `Open shared read-only analysis for ${market.display}`);
      if (selectedPairKey === market.pairKey) row.classList.add('selected-market-row');
      cell(row, market.display, 'symbol-cell');
      cell(row, `${market.tradeScore ?? 0}/100`, market.tradeScore >= 70 ? 'positive score-cell' : 'score-cell');
      cell(row, analysis.signal, signalClass(analysis.signal));
      cell(row, analysis.regime);
      cell(row, analysis.candlePatterns?.length ? analysis.candlePatterns.map((pattern) => pattern.name).join(', ') : '—', 'detail-cell');
      cell(row, `2×ATR ${analysis.stopPct.toFixed(2)}%`);
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

  function renderFreshness(snapshot) {
    const element = $('#kraken-freshness');
    if (!element) return;
    const runtime = snapshot.engineRuntime === 'node' ? 'Node host engine · ' : '';
    const interval = Math.max(20, Math.round(Number(snapshot.autoScanSeconds ?? snapshot.settings?.autoScanSeconds) || 60));
    const scannedAt = snapshot.lastScanAt ? Date.parse(snapshot.lastScanAt) : 0;
    element.classList.toggle('stale', Boolean(snapshot.dataStale));
    if (snapshot.scanning) {
      element.textContent = `${runtime}auto-scan in progress…`;
      return;
    }
    if (!scannedAt) {
      element.textContent = `${runtime}auto-scan every ${interval}s · waiting for the first quote`;
      return;
    }
    const ageSeconds = Math.max(0, Math.round((Date.now() - scannedAt) / 1000));
    if (snapshot.dataStale) {
      element.textContent = `${runtime}quotes stale · last success ${ageSeconds}s ago · retrying automatically`;
      return;
    }
    const nextIn = Math.max(0, Math.ceil((scannedAt + interval * 1000 - Date.now()) / 1000));
    element.textContent = `${runtime}auto-scan every ${interval}s · last quote ${ageSeconds}s ago · next in ${nextIn}s`;
  }

  function render(snapshot) {
    $('#kraken-market-count').textContent = number(snapshot.marketCount, 0);
    $('#kraken-eligible-count').textContent = number(snapshot.eligibleCount, 0);
    $('#kraken-analyzed-count').textContent = number(snapshot.analyzedCount, 0);
    $('#kraken-candidate-count').textContent = number(snapshot.candidateCount, 0);
    $('#kraken-equity').textContent = dollars(snapshot.equity);
    $('#kraken-daily-pnl').textContent = dollars(snapshot.dailyPnl, true);
    $('#kraken-daily-pnl').classList.toggle('positive', snapshot.dailyPnl > 0);
    $('#kraken-daily-pnl').classList.toggle('negative', snapshot.dailyPnl < 0);
    $('#kraken-drawdown').textContent = `${snapshot.drawdownPct.toFixed(2)}%`;
    $('#kraken-starting-balance').textContent = dollars(snapshot.initialBalance);

    $('#kraken-status').textContent = snapshot.scanning ? 'Refreshing all Kraken spot quotes…' : snapshot.botStatus;

    const alert = $('#kraken-alert');
    const alertText = snapshot.haltedReason
      ? `Bot halted: ${snapshot.haltedReason}. Reset the separate Kraken paper account to clear this safety halt.`
      : snapshot.dataStale
        ? 'Kraken quotes are stale, so new paper entries are blocked until a fresh scan succeeds. The background scanner retries automatically.'
        : snapshot.botError || snapshot.scanError || null;
    if (alertText) {
      alert.textContent = alertText;
      alert.classList.remove('hidden', 'alert-warning', 'alert-danger', 'alert-success');
      alert.classList.add(snapshot.haltedReason ? 'alert-danger' : 'alert-warning');
    } else {
      alert.classList.add('hidden');
    }

    const refresh = $('#kraken-refresh');
    refresh.disabled = snapshot.scanning;
    refresh.textContent = snapshot.scanning ? 'Refreshing…' : 'Refresh now';

    const toggle = $('#kraken-bot-toggle');
    toggle.textContent = snapshot.entriesEnabled ? 'Pause new entries' : 'Resume entries';
    toggle.classList.toggle('button-danger', snapshot.entriesEnabled);
    toggle.classList.toggle('button-buy', !snapshot.entriesEnabled);
    toggle.disabled = Boolean(snapshot.haltedReason) || !snapshot.marketCount;

    const form = $('#kraken-settings-form');
    for (const [name, value] of Object.entries(snapshot.settings)) {
      const input = form.elements.namedItem(name);
      if (input && document.activeElement !== input) input.value = value;
    }
    renderMarkets(snapshot);
    renderCoinDetail(snapshot);
    renderSharedSignals(snapshot);
    renderPositions(snapshot.positions);
    renderTrades(snapshot.trades);
    renderFreshness(snapshot);
  }

  $('#kraken-refresh').addEventListener('click', async () => {
    try {
      await bot.scan();
      showToast('Kraken public spot quotes refreshed.');
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $('#kraken-bot-toggle').addEventListener('click', async () => {
    try {
      await bot.setEntriesEnabled(!bot.getSnapshot().entriesEnabled);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $('#kraken-reset').addEventListener('click', async () => {
    if (!window.confirm('Reset the separate Kraken paper balance, positions, analysis and trade log?')) return;
    try {
      await bot.resetAccount();
      showToast('Kraken paper bot account reset.');
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $('#kraken-settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await bot.updateSettings(values);
      showToast('Kraken bot settings saved.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  function openCoinPage(pairKey) {
    selectedPairKey = pairKey;
    window.NorthstarSwitchMode?.('coins');
    $('#coins-view').classList.add('detail-open');
    render(bot.getSnapshot());
    $('#coin-detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeCoinPage() {
    detailLoadToken += 1;
    selectedPairKey = null;
    detailData = null;
    detailLoading = false;
    detailLoadError = null;
    $('#coins-view').classList.remove('detail-open');
    render(bot.getSnapshot());
  }

  async function loadSelectedPairDetail() {
    if (!selectedPairKey) return;
    const pairKey = selectedPairKey;
    const interval = detailInterval;
    const token = ++detailLoadToken;
    detailData = null;
    detailLoadError = null;
    detailLoading = true;
    detailLoadingPairKey = pairKey;
    render(bot.getSnapshot());
    try {
      const prioritizeForPaper = document.querySelector('.nav-item.active')?.dataset.mode !== 'live';
      const loadedDetail = await bot.loadPairDetail(pairKey, interval, prioritizeForPaper);
      if (token !== detailLoadToken) return;
      detailData = loadedDetail;
      detailLoadError = null;
    } catch (error) {
      if (token !== detailLoadToken) return;
      detailLoadError = { pairKey, interval, message: error.message || 'Kraken OHLC request failed.' };
    } finally {
      if (token === detailLoadToken) {
        detailLoading = false;
        render(bot.getSnapshot());
      }
    }
  }

  function selectPair(pairKey) {
    if (!pairKey) return;
    bot.focusPair(pairKey);
    openCoinPage(pairKey);
    loadSelectedPairDetail();
  }

  $('#kraken-market-filter').addEventListener('input', (event) => {
    marketFilter = event.target.value.trim().toLowerCase();
    render(bot.getSnapshot());
  });
  $('#kraken-markets-body').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-pair-key]');
    if (row) selectPair(row.dataset.pairKey);
  });
  $('#kraken-markets-body').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-pair-key]');
    if (!row) return;
    event.preventDefault();
    selectPair(row.dataset.pairKey);
  });
  $('#shared-signals-body').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-pair-key]');
    if (row) selectPair(row.dataset.pairKey);
  });
  $('#shared-signals-body').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-pair-key]');
    if (!row) return;
    event.preventDefault();
    selectPair(row.dataset.pairKey);
  });
  document.querySelectorAll('.coin-timeframe').forEach((button) => button.addEventListener('click', () => {
    const interval = Number(button.dataset.interval);
    if (!Number.isFinite(interval) || interval === detailInterval) return;
    detailInterval = interval;
    if (selectedPairKey) loadSelectedPairDetail();
    else render(bot.getSnapshot());
  }));
  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => {
    render(bot.getSnapshot());
    if (button.dataset.mode === 'coins') window.requestAnimationFrame(drawDetailCharts);
  }));
  $('#coin-detail-close').addEventListener('click', () => closeCoinPage());
  $('#coin-detail-back').addEventListener('click', (event) => {
    event.preventDefault();
    closeCoinPage();
  });
  $('#open-coin-scanner').addEventListener('click', () => {
    window.NorthstarSwitchMode?.('coins');
    render(bot.getSnapshot());
    window.requestAnimationFrame(drawDetailCharts);
  });

  bot.subscribe(render);
  freshnessTimer = window.setInterval(() => renderFreshness(bot.getSnapshot()), 5000);
  window.addEventListener('resize', drawDetailCharts);
  window.addEventListener('pagehide', () => window.clearInterval(freshnessTimer));
})();
