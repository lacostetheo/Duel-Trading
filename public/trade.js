// DUEL client: game connection (SSE), order ticket with risk maths, positions, leaderboard and technical analysis.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fr = (v, d = 2) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const eur = (v) => `${v < 0 ? '−' : ''}€${fr(Math.abs(v), 2)}`;
  // Signed value: money by default (+€12.30), or a number with a suffix (+1.25%).
  const signed = (v, suffix = '€') => (suffix === '€' ? `${v >= 0 ? '+' : '−'}€${fr(Math.abs(v), 2)}` : `${v >= 0 ? '+' : ''}${fr(v, 2)}${suffix}`);
  const cls = (v) => (v >= 0 ? 'up' : 'down');
  // Lenient number parsing: accepts "0.5", "0,5" and "112,592.5".
  const num = (id) => {
    const raw = String($(id).value).trim();
    const norm = raw.includes('.') ? raw.replace(/,/g, '') : raw.replace(',', '.');
    return Number(norm.replace(/[^\d.]/g, ''));
  };
  const setNum = (id, v, d) => { $(id).value = Number(v).toFixed(d); };

  let session = null; // { code, token, playerId, name }
  let es = null;
  let game = null; // latest full state
  let asset = null;
  let bid = null;
  let ask = null;
  let board = [];
  let analysis = null;
  let lastCandleT = 0;
  let coachOn = true;
  let userEditedStops = false;
  let orderType = 'market'; // 'market' | 'pending'
  let spreadMult = 1;
  let book = null;
  let loadedCandlesFor = null;
  // Offset between the server clock and this device's clock (a phone can be seconds or even minutes off).
  let clockOffset = 0;
  const serverNow = () => Date.now() + clockOffset;
  const syncClock = (d) => {
    if (d && d.now) clockOffset = d.now - Date.now();
    return d;
  };
  const seenFeed = new Set();

  const chart = new TradeChart($('chart'), {
    digits: 2,
    onDrag: (id, kind, price) => {
      if (kind === 'order') {
        act({ type: 'moveOrder', id, price });
        return;
      }
      const pos = myBoard()?.positions.find((p) => p.id === id);
      if (!pos) return;
      act({ type: 'modify', id, sl: kind === 'sl' ? price : pos.sl, tp: kind === 'tp' ? price : pos.tp });
    },
    onDrawings: (list) => saveDrawings(list),
    onTool: (tool) => setToolButtons(tool),
  });

  window.__tradeChart = chart; // exposed for automated tests

  // ------------------------------------------------------------------ Utilitaires
  function toast(text, kind = '') {
    const t = $('toast');
    t.textContent = text;
    t.className = `toast ${kind}`;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  function beep(up) {
    try {
      const ac = beep.ac || (beep.ac = new (window.AudioContext || window.webkitAudioContext)());
      const o = ac.createOscillator();
      const g = ac.createGain();
      const f = up ? [660, 990] : [440, 260];
      o.frequency.setValueAtTime(f[0], ac.currentTime);
      o.frequency.exponentialRampToValueAtTime(f[1], ac.currentTime + 0.18);
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, ac.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.28);
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 0.3);
    } catch { /* audio unavailable */ }
  }

  const store = {
    get() { try { return JSON.parse(sessionStorage.getItem('duel.trade')); } catch { return null; } },
    set(v) { try { sessionStorage.setItem('duel.trade', JSON.stringify(v)); } catch { /* storage unavailable */ } },
    clear() { try { sessionStorage.removeItem('duel.trade'); } catch { /* storage unavailable */ } },
  };

  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `Erreur ${r.status}`);
    return j;
  }

  async function act(body) {
    try {
      return await post(`/api/game/${session.code}/action`, { token: session.token, ...body });
    } catch (e) {
      toast(e.message, 'bad');
      beep(false);
      return null;
    }
  }

  const me = () => game?.players.find((p) => p.id === session?.playerId);
  const myBoard = () => board.find((b) => b.id === session?.playerId);

  // ------------------------------------------------------------------ Connecting to a game
  function connect(s) {
    session = s;
    store.set(s);
    if (es) es.close();
    loadedCandlesFor = null;
    es = new EventSource(`/api/game/${s.code}/stream?token=${encodeURIComponent(s.token)}`);
    const parse = (e) => syncClock(JSON.parse(e.data));
    es.addEventListener('hello', parse);
    es.addEventListener('state', (e) => applyState(parse(e)));
    es.addEventListener('tick', (e) => applyTick(parse(e)));
    es.addEventListener('feed', (e) => addFeed(parse(e)));
    es.addEventListener('rematch', (e) => onRematch(parse(e)));
    es.addEventListener('book', (e) => applyBook(JSON.parse(e.data)));
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        store.clear();
        toast('Game not found or already over.', 'bad');
        showLobbyForms();
      }
    };
  }

  async function onRematch({ code }) {
    if (game && (game.solo || session.playerId === game.hostId)) return; // the host already received its access
    try {
      const j = await post('/api/game/join', { code, name: session.name });
      $('results').hidden = true;
      connect({ ...j, name: session.name });
      toast('Joined the new game.', 'good');
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  // ------------------------------------------------------------------ Full state
  function applyState(s) {
    const first = !game || game.code !== s.code;
    game = s;
    asset = s.asset;
    if (first) {
      setupAsset();
      loadDrawings();
      document.body.classList.toggle('solo', !!s.solo);
      book = null;
      chart.setBook(null);
      document.body.classList.toggle('has-book', !!s.asset.book);
      $('bookPanel').hidden = !s.asset.book;
      requestAnimationFrame(() => chart.resize && (chart.resize(), chart.request()));
    }
    if (s.book) applyBook(s.book);
    if (s.spreadMult) setSpread(s.spreadMult);
    if (loadedCandlesFor !== s.code) {
      chart.setCandles(s.candles);
      lastCandleT = s.candles.length ? s.candles[s.candles.length - 1].t : 0;
      runCoach();
      loadedCandlesFor = s.code;
    }
    if (s.bid != null) setQuote(s.bid, s.ask);
    setSource(s.source);
    board = s.players.filter((p) => p.account).map((p) => ({ id: p.id, ...p.account }));
    for (const f of s.feed) addFeed(f, true);
    renderLobby();
    renderBoard();
    renderAccount();
    renderPositions(true);
    renderTicket();
    if (s.status === 'ended' && s.results) renderResults(s.results);
  }

  function setupAsset() {
    chart.opts.digits = asset.digits;
    $('assetName').textContent = asset.name;
    $('lev').max = asset.maxLev;
    $('lev').title = `Maximum leverage: ×${asset.maxLev}`;
    const lev = Math.min(5, asset.maxLev);
    $('lev').value = lev;
    const price = game.bid || (game.candles.length ? game.candles[game.candles.length - 1].c : 1);
    const notionalPerLot = asset.eurNotional ? asset.contract : (price * asset.contract) / game.rate;
    // Default size: about €20,000 exposure, never locking more than 60% of equity as margin.
    const exposure = Math.min(20000, 10000 * lev * 0.6);
    setNum('lots', Math.max(0.01, Math.round((exposure / notionalPerLot) * 100) / 100), 2);
    $('pipInfo').textContent = `1 pip = ${fr(asset.pip, asset.digits)}`;
    userEditedStops = false;
  }

  function setSource(src) {
    const b = $('srcBadge');
    const map = {
      live: ['LIVE', 'tag live'],
      delayed: ['LIVE (slight delay)', 'tag live'],
      closed: ['MARKET CLOSED', 'tag warn'],
      sim: ['SIMULATED', 'tag warn'],
      error: ['SIMULATED', 'tag warn'],
    };
    const [txt, c] = map[src] || ['—', 'tag'];
    b.textContent = txt;
    b.className = c;
  }

  // ------------------------------------------------------------------ New price
  function applyTick(t) {
    checkLineCross(bid, t.bid);
    if (t.spreadMult) setSpread(t.spreadMult);
    setQuote(t.bid, t.ask);
    setSource(t.source);
    if (t.candle) {
      chart.updateCandle(t.candle);
      if (t.candle.t !== lastCandleT) {
        lastCandleT = t.candle.t;
        runCoach();
      }
    }
    if (t.board) {
      board = t.board;
      renderBoard();
      renderAccount();
      renderPositions(false);
    }
    renderTicket();
  }

  function setQuote(b, a) {
    bid = b;
    ask = a;
    const d = asset.digits;
    $('bid').textContent = fr(b, d);
    $('ask').textContent = fr(a, d);
    $('sellPx').textContent = fr(b, d);
    $('buyPx').textContent = fr(a, d);
    if (game?.startedAt && game.candles.length) {
      const ref = chart.raw.find((k) => k.t >= Math.floor(game.startedAt / 60000) * 60000) || chart.raw[0];
      if (ref && game.status !== 'lobby') {
        const chg = ((b - ref.o) / ref.o) * 100;
        $('chg').innerHTML = `<span class="${cls(chg)}">${signed(chg, '%')}</span> since start`;
      }
    }
    chart.setQuote(b, a);
  }

  function setSpread(m) {
    spreadMult = m;
    const el = $('spreadInfo');
    el.hidden = m < 1.3;
    if (m >= 1.3) el.textContent = `spread ×${fr(m, 1)} (volatile market)`;
  }

  // ------------------------------------------------------------------ Order book (bitcoin)
  let bookFrame = 0;
  function applyBook(b) {
    book = b;
    if (bookFrame) return;
    bookFrame = requestAnimationFrame(() => {
      bookFrame = 0;
      renderBook();
    });
  }

  function renderBook() {
    const b = book;
    if (!b || !asset || !asset.book) return;
    chart.setBook(b);
    $('bookSrc').textContent = b.sim ? 'SIMULATED' : `${b.src || 'BINANCE'} · LIVE`;
    $('bookSrc').className = b.sim ? 'tag warn' : 'tag live';
    const N = 14;
    const asks = b.asks.slice(0, N);
    const bids = b.bids.slice(0, N);
    const maxQ = Math.max(...asks.map((r) => r[1]), ...bids.map((r) => r[1]), 1e-9);
    const dStep = b.step >= 1 ? 0 : 1;
    const row = (r, side) => `<div class="bk ${side}${r[1] >= b.wall ? ' wall' : ''}"><i style="width:${((r[1] / maxQ) * 100).toFixed(1)}%"></i><span>${fr(r[0], dStep)}</span><span>${fr(r[1], 3)}</span></div>`;
    $('bookAsks').innerHTML = asks.slice().reverse().map((r) => row(r, 'ask')).join('');
    $('bookBids').innerHTML = bids.map((r) => row(r, 'bid')).join('');
    const mid = (b.bestBid + b.bestAsk) / 2;
    $('bookMid').innerHTML = `${fr(mid, 1)}<small>$${fr(b.step, dStep)} levels</small>`;
    $('imbBar').style.width = `${b.imbalance}%`;
    $('imbBuy').textContent = `Bids ${b.imbalance}%`;
    $('imbSell').textContent = `Asks ${100 - b.imbalance}%`;
  }

  // ------------------------------------------------------------------ Technical analysis
  function runCoach() {
    analysis = Coach.analyze(chart.raw);
    chart.setAnalysis(analysis, coachOn);
    if (!analysis) return;
    // Suggest SL/TP from volatility until the player edits the values.
    if (!userEditedStops && analysis.atr) {
      const minPips = Math.ceil(asset.spread / asset.pip) + 2;
      const sl = Math.max(minPips, Math.round((analysis.atr * 1.5) / asset.pip));
      $('slPips').value = sl;
      $('tpPips').value = sl * 2;
    }
  }

  // ------------------------------------------------------------------ Game events
  // Game events: only the ones that matter are shown, as brief toasts.
  function addFeed(f, silent) {
    const key = f.id + '|' + (game?.code || '');
    if (seenFeed.has(key)) return;
    seenFeed.add(key);
    if (silent) return;
    const mine = f.player === session?.playerId;
    if (mine && ['tp', 'sl', 'stopout'].includes(f.kind)) {
      beep(f.pnl >= 0);
      toast(f.text, f.pnl >= 0 ? 'good' : 'bad');
    } else if (mine && ['margin', 'liquidation'].includes(f.kind)) toast(f.text, 'bad');
    else if (['lead', 'time'].includes(f.kind)) toast(f.text);
  }

  // ------------------------------------------------------------------ Salle d'attente
  function showLobbyForms() {
    $('lobby').hidden = false;
    $('lobbyForms').hidden = false;
    $('waiting').hidden = true;
  }

  async function renderLobby() {
    if (game.status !== 'lobby') {
      $('lobby').hidden = true;
      return;
    }
    $('lobby').hidden = false;
    $('lobbyForms').hidden = true;
    $('waiting').hidden = false;
    $('wCode').textContent = game.code;
    $('wPlayers').innerHTML = game.players.map((p) => `<li><i style="background:${p.color}"></i>${esc(p.name)}${p.id === game.hostId ? ' <small class="muted">host</small>' : ''}</li>`).join('');
    $('wInfo').textContent = `${asset.name} · ${game.duration} minutes · €10,000 each`;
    const host = session.playerId === game.hostId;
    $('btnStart').hidden = !host;
    $('wGuest').hidden = host;
    const warn = { closed: 'Market closed: the price will not move. Pick Bitcoin (open 24/7) or simulated prices.', error: 'Price feed unavailable: the game will use a realistic simulation.', sim: 'Simulated prices: realistic market generated by the server.' }[game.source];
    $('wWarn').hidden = !warn;
    $('wWarn').textContent = warn || '';
    if (host) {
      if (renderLobby.base === undefined) {
        try {
          const j = await (await fetch('/api/game/lan')).json();
          renderLobby.base = j.local ? j.urls[0] || '' : location.origin;
          renderLobby.lan = j.local;
        } catch { renderLobby.base = ''; }
      }
      const base = renderLobby.base;
      $('wInvite').innerHTML = base
        ? `Invite link${renderLobby.lan ? ' (same Wi-Fi)' : ''}:<br><code>${esc(base)}/?code=${game.code}</code>`
        : `Code to enter under “Join”: <b>${game.code}</b>.`;
    } else $('wInvite').textContent = '';
  }

  // ------------------------------------------------------------------ Leaderboard, account, positions
  function renderBoard() {
    if (!game) return;
    const rows = game.players.map((p) => ({ ...p, b: board.find((x) => x.id === p.id) })).sort((x, y) => (y.b?.equity ?? 0) - (x.b?.equity ?? 0));
    const lead = rows.length > 1 && rows[0].b && rows[1].b && rows[0].b.equity !== rows[1].b.equity ? rows[0].id : null;
    $('board').innerHTML = rows.map((p) => `<div class="pl-chip ${p.id === lead ? 'lead' : ''}"><i style="background:${p.color}"></i><b>${esc(p.name)}${p.id === session?.playerId ? ' (you)' : ''}</b><span class="${cls(p.b?.pct ?? 0)}">${signed(p.b?.pct ?? 0, '%')}</span></div>`).join('');
  }

  function renderAccount() {
    const a = myBoard();
    const p = me();
    if (!a || !p) return;
    $('accEquity').textContent = eur(a.equity);
    $('accPct').textContent = signed(a.pct, '%');
    $('accPct').className = cls(a.pct);
    $('accBalance').textContent = eur(a.equity - a.floating);
    $('accFloat').textContent = signed(a.floating);
    $('accFloat').className = cls(a.floating);
    $('accUsed').textContent = eur(a.used);
    $('accFree').textContent = eur(a.free);
    $('accLevel').textContent = a.level == null ? '—' : `${fr(a.level, 0)}%`;
    $('accLevel').className = a.level != null && a.level < 150 ? 'down' : '';
  }

  let posKey = '';
  let ordKey = '';
  const inProfit = (p) => (p.side === 'buy' ? bid > p.open : ask < p.open);
  function renderPositions(full) {
    const a = myBoard();
    const list = a ? a.positions : [];
    const orders = a ? a.orders || [] : [];
    chart.setPositions(list);
    chart.setOrders(orders);
    $('noPos').hidden = list.length > 0 || orders.length > 0;
    const d = asset?.digits ?? 2;
    const key = list.map((p) => `${p.id}:${p.lots}:${p.sl}:${p.tp}:${p.trail}:${inProfit(p)}`).join('|');
    if (full || key !== posKey) {
      posKey = key;
      $('positions').innerHTML = list.map((p) => `
        <tr data-id="${p.id}">
          <td class="side-${p.side}">${p.side === 'buy' ? 'BUY' : 'SELL'}</td>
          <td>${fr(p.lots, 2)}</td><td>×${p.leverage}</td><td>${fr(p.open, d)}</td>
          <td class="sl">${p.sl == null ? '—' : fr(p.sl, d)}${p.trail ? ' <small class="muted">trail</small>' : ''}</td><td>${p.tp == null ? '—' : fr(p.tp, d)}</td>
          <td class="pnl ${cls(p.pnl)}">${signed(p.pnl)}</td>
          <td><div class="mg">
            <button class="x-btn" data-be="${p.id}" ${inProfit(p) && p.sl !== p.open ? '' : 'disabled'} title="Move stop to entry price">BE</button>
            <button class="x-btn" data-half="${p.id}" ${p.lots >= 0.02 ? '' : 'disabled'} title="Close half of the position">½</button>
            <button class="x-btn ${p.trail ? 'on' : ''}" data-trail="${p.id}" title="Trailing stop">Trail</button>
            <button class="x-btn" data-close="${p.id}" title="Close the position">Close</button>
          </div></td>
        </tr>`).join('');
    } else {
      for (const p of list) {
        const cell = $('positions').querySelector(`tr[data-id="${p.id}"] .pnl`);
        if (cell) {
          cell.textContent = signed(p.pnl);
          cell.className = `pnl ${cls(p.pnl)}`;
        }
      }
    }
    // Pending orders (distance changes with every price)
    $('ordersWrap').hidden = !orders.length;
    const oKey = orders.map((o) => `${o.id}:${o.price}:${o.kind}`).join('|');
    const dist = (o) => `${Math.round(Math.abs((o.side === 'buy' ? ask : bid) - o.price) / asset.pip)} pips`;
    if (full || oKey !== ordKey) {
      ordKey = oKey;
      $('orders').innerHTML = orders.map((o) => `
        <tr data-id="${o.id}">
          <td class="side-${o.side}">${o.side === 'buy' ? 'BUY' : 'SELL'} ${o.kind === 'limit' ? 'LIMIT' : 'STOP'}</td>
          <td>${fr(o.lots, 2)}</td><td>×${o.leverage}</td><td>${fr(o.price, d)}</td>
          <td>${o.sl == null ? '—' : fr(o.sl, d)}</td><td>${o.tp == null ? '—' : fr(o.tp, d)}</td>
          <td class="dist">${dist(o)}</td>
          <td><button class="x-btn" data-cancel="${o.id}">Cancel</button></td>
        </tr>`).join('');
    } else {
      for (const o of orders) {
        const cell = $('orders').querySelector(`tr[data-id="${o.id}"] .dist`);
        if (cell) cell.textContent = dist(o);
      }
    }
  }

  // ------------------------------------------------------------------ Order ticket: risk maths
  function ticket() {
    const lots = Math.max(0.01, Math.round((num('lots') || 0) * 100) / 100);
    const lev = Number($('lev').value);
    const slOn = $('slOn').checked;
    const tpOn = $('tpOn').checked;
    const slP = Math.max(1, Math.round(num('slPips')) || 0);
    const tpP = Math.max(1, Math.round(num('tpPips')) || 0);
    const rate = game?.rate || 1.17;
    const pending = orderType === 'pending';
    const oPrice = num('ordPrice');
    const price = pending && oPrice > 0 ? oPrice : ask || 1;
    const pipValue = (asset.pip * asset.contract * lots) / rate;
    const notional = asset.eurNotional ? asset.contract * lots : (price * asset.contract * lots) / rate;
    const margin = notional / lev;
    const spreadCost = (asset.spread * spreadMult * asset.contract * lots) / rate;
    // Estimated market-order slippage (the server computes the real one at execution).
    const slip = pending ? 0 : estSlip(lots);
    const slipCost = (slip * asset.contract * lots) / rate;
    return { lots, lev, slOn, tpOn, slP, tpP, pipValue, notional, margin, spreadCost, slip, slipCost, pending, oPrice, risk: slOn ? slP * pipValue + spreadCost + slipCost : null, reward: tpOn ? tpP * pipValue - spreadCost - slipCost : null };
  }

  function estSlip(lots) {
    const qty = lots * asset.contract;
    if (book && asset.book) {
      let left = qty;
      let cost = 0;
      let last = book.asks[0]?.[0] || 0;
      for (const [px, q] of book.asks) {
        const take = Math.min(left, q);
        cost += take * (px - book.step / 2);
        left -= take;
        last = px;
        if (left <= 0) break;
      }
      if (left > 0) cost += left * last;
      return Math.max(0, cost / qty - book.bestAsk);
    }
    return asset.spread * 0.5 * Math.pow(lots / (asset.depth || 20), 1.5) * spreadMult;
  }

  // Pending order type for the chosen price (same rule as the server).
  function pendingKind(side, price) {
    if (!(price > 0) || bid == null) return null;
    if (side === 'buy') return price < ask ? 'limit' : price > ask ? 'stop' : null;
    return price > bid ? 'limit' : price < bid ? 'stop' : null;
  }

  function renderTicket() {
    if (!asset || bid == null) return;
    const t = ticket();
    const a = myBoard();
    const equity = a?.equity ?? 10000;
    const free = a?.free ?? 10000;
    $('levVal').textContent = `×${t.lev}`;
    $('levVal').className = t.lev > asset.maxLev * 0.7 ? 'hot' : '';
    $('sizeInfo').textContent = `= ${fr(t.lots * asset.contract, asset.contract >= 100 ? 0 : 2)} ${asset.unit} · 1 pip = ${eur(t.pipValue)}`;
    const riskPct = t.risk != null ? (t.risk / equity) * 100 : null;
    const rr = t.slOn && t.tpOn ? t.tpP / t.slP : null;
    $('risk').innerHTML = `
      <div><span>Exposure</span><b>${eur(t.notional)}</b></div>
      <div><span>Margin required</span><b class="${t.margin > free ? 'down' : ''}">${eur(t.margin)}</b></div>
      <div><span>Loss at SL</span><b class="down">${t.risk == null ? 'unlimited' : `−${eur(t.risk)} (${fr(riskPct, 1)}%)`}</b></div>
      <div><span>Gain at TP</span><b class="up">${t.reward == null ? '—' : `+${eur(Math.max(0, t.reward))}`}</b></div>
      ${t.slip / asset.pip >= 1 ? `<div class="rr"><span>Estimated slippage</span><b class="down">≈ ${Math.round(t.slip / asset.pip)} pips · ${eur(t.slipCost)}</b></div>` : ''}
      <div class="rr"><span>Reward / risk</span><b class="${rr == null ? '' : rr >= 1.5 ? 'up' : 'down'}">${rr == null ? '—' : `1 : ${fr(rr, 1)}`}</b></div>`;
    if (t.pending) {
      const kb = pendingKind('buy', t.oPrice);
      const ks = pendingKind('sell', t.oPrice);
      $('ordKind').textContent = t.oPrice > 0 ? `→ buy ${kb === 'limit' ? 'LIMIT' : kb === 'stop' ? 'STOP' : '—'} · sell ${ks === 'limit' ? 'LIMIT' : ks === 'stop' ? 'STOP' : '—'}` : '';
    }
    const canTrade = game?.status === 'running' && serverNow() >= game.startedAt && !me()?.liquidated;
    const pk = (side) => (t.pending ? pendingKind(side, t.oPrice) : 'market');
    $('btnBuy').disabled = !canTrade || !pk('buy');
    $('btnSell').disabled = !canTrade || !pk('sell');
    const label = (side, k) => (k === 'market' ? (side === 'buy' ? 'BUY' : 'SELL') : `${side === 'buy' ? 'BUY' : 'SELL'} ${k === 'limit' ? 'LIMIT' : k === 'stop' ? 'STOP' : ''}`);
    const setBtn = (id, side, pxId, px) => {
      const k = pk(side);
      const html = `${label(side, k)}<small id="${pxId}">${fr(px, asset.digits)}</small>`;
      if ($(id).innerHTML !== html) $(id).innerHTML = html;
    };
    setBtn('btnBuy', 'buy', 'buyPx', t.pending && t.oPrice > 0 ? t.oPrice : ask);
    setBtn('btnSell', 'sell', 'sellPx', t.pending && t.oPrice > 0 ? t.oPrice : bid);
  }

  async function sendOrder(side) {
    const t = ticket();
    const d = asset.digits + 1;
    const entry = t.pending ? t.oPrice : side === 'buy' ? ask : bid;
    const dir = side === 'buy' ? 1 : -1;
    const sl = t.slOn ? Number((entry - dir * t.slP * asset.pip).toFixed(d)) : null;
    const tp = t.tpOn ? Number((entry + dir * t.tpP * asset.pip).toFixed(d)) : null;
    if (t.pending) {
      const r = await act({ type: 'order', side, price: entry, lots: t.lots, leverage: t.lev, sl, tp });
      if (r) toast(`${side === 'buy' ? 'Buy' : 'Sell'} ${pendingKind(side, entry) === 'limit' ? 'limit' : 'stop'} order placed at ${fr(entry, asset.digits)}`, 'good');
      return;
    }
    const r = await act({ type: 'open', side, lots: t.lots, leverage: t.lev, sl, tp });
    if (r) {
      toast(`${side === 'buy' ? 'Buy' : 'Sell'} order filled`, 'good');
    }
  }

  // ------------------------------------------------------------------ Results
  function renderResults(r) {
    if (renderResults.done === game.code) return;
    renderResults.done = game.code;
    $('results').hidden = false;
    const medals = ['1', '2', '3', '4'];
    const m = r.market;
    $('resMarket').textContent = `During the game, ${asset.name} moved ${signed(m.move, '%')} (high ${fr(m.high, asset.digits)}, low ${fr(m.low, asset.digits)}).`;
    $('resRanking').innerHTML = r.ranking.map((p, i) => `
      <div class="rank ${i === 0 ? 'first' : ''}">
        <div class="medal">${medals[i] || ''}</div>
        <div>
          <h3>${esc(p.name)} <em class="${cls(p.pct)}">${signed(p.pct, '%')}</em> <small class="muted">${eur(p.equity)}</small></h3>
          <div class="stats">
            <span>Trades <b>${p.trades}</b></span>
            <span>Win rate <b>${p.winRate == null ? '—' : p.winRate + '%'}</b></span>
            <span>Best <b>${p.best == null ? '—' : signed(p.best)}</b></span>
            <span>Worst <b>${p.worst == null ? '—' : signed(p.worst)}</b></span>
            <span>With SL <b>${p.slUsage == null ? '—' : p.slUsage + '%'}</b></span>
            <span>Avg reward/risk <b>${p.avgRR == null ? '—' : '1 : ' + fr(p.avgRR, 1)}</b></span>
            <span>Max drawdown <b>${fr(p.maxDD, 1)}%</b></span>
          </div>
          <div class="badges">${p.badges.map((b) => `<span class="badge" title="${esc(b.desc)}">${esc(b.name)}</span>`).join('')}</div>
          ${p.tips.length ? `<ul class="tips">${p.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        </div>
      </div>`).join('');
    $('btnRematch').hidden = session.playerId !== game.hostId;
    $('btnRematch').textContent = game.solo ? 'Play again' : 'Rematch';
    $('resRecord').hidden = true;
    if (game.solo && r.ranking[0]) saveRecord(r.ranking[0].pct);
  }

  // Solo personal best, per asset and duration (stored on this device).
  function saveRecord(pct) {
    const key = `${asset.id}|${game.duration}`;
    let rec = {};
    try { rec = JSON.parse(localStorage.getItem('duel.tradeRecords')) || {}; } catch { /* storage unavailable */ }
    const prev = rec[key];
    const el = $('resRecord');
    el.hidden = false;
    if (prev == null || pct > prev) {
      rec[key] = pct;
      try { localStorage.setItem('duel.tradeRecords', JSON.stringify(rec)); } catch { /* storage unavailable */ }
      el.className = 'record new';
      el.textContent = prev == null ? `Best score · ${asset.name} · ${game.duration} min: ${signed(pct, '%')}` : `New personal best: ${signed(pct, '%')} (previous: ${signed(prev, '%')})`;
    } else {
      el.className = 'record';
      el.textContent = `Personal best · ${asset.name} · ${game.duration} min: ${signed(prev, '%')}`;
    }
  }

  // ------------------------------------------------------------------ Dessins d'analyse
  const drawKey = () => `duel.drawings.${asset?.id || 'x'}`;
  function loadDrawings() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(drawKey())) || []; } catch { /* storage unavailable */ }
    chart.setDrawings(list);
    setToolButtons(null);
  }
  function saveDrawings(list) {
    try { localStorage.setItem(drawKey(), JSON.stringify(list.slice(-50))); } catch { /* storage unavailable */ }
  }
  function setToolButtons(tool) {
    document.querySelectorAll('#tools [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  }
  const pxTxt = (v) => fr(v, asset.digits);
  // Alert when the price crosses one of your horizontal lines.
  function checkLineCross(prev, cur) {
    if (prev == null || cur == null || prev === cur) return;
    for (const d of chart.drawings) {
      if (d.type !== 'h') continue;
      if ((prev < d.p1 && cur >= d.p1) || (prev > d.p1 && cur <= d.p1)) {
        const now = Date.now();
        if (d.lastAlert && now - d.lastAlert < 30000) continue;
        d.lastAlert = now;
        const upx = cur > prev;
        toast(`Line ${pxTxt(d.p1)} crossed ${upx ? 'upward' : 'downward'}`);
        beep(upx);
      }
    }
  }

  // ------------------------------------------------------------------ Timer and countdown
  setInterval(() => {
    if (!game) return;
    const now = serverNow();
    if (game.status === 'running' && now < game.startedAt) {
      $('countdown').hidden = false;
      $('countNum').textContent = Math.ceil((game.startedAt - now) / 1000);
    } else $('countdown').hidden = true;
    let left = game.status === 'lobby' ? game.duration * 60000 : game.status === 'running' ? game.endsAt - Math.max(now, game.startedAt) : 0;
    left = Math.max(0, left);
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    $('timer').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    $('timer').classList.toggle('hurry', game.status === 'running' && left < 60000);
  }, 250);

  // ------------------------------------------------------------------ UI events
  // Which button submitted the form (e.submitter is missing on old Safari).
  let createMode = 'duel';
  document.querySelectorAll('#formCreate [name=go]').forEach((b) => b.addEventListener('click', () => { createMode = b.value; }));
  $('formCreate').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const solo = (e.submitter?.value || createMode) === 'solo';
    $('lobbyErr').textContent = '';
    try {
      const j = await post('/api/game/create', { name: f.get('name'), asset: f.get('asset'), duration: f.get('duration'), mode: f.get('mode'), solo });
      connect({ ...j, name: f.get('name') });
    } catch (err) {
      $('lobbyErr').textContent = err.message;
    }
  };
  $('formJoin').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    $('lobbyErr').textContent = '';
    try {
      const j = await post('/api/game/join', { code: f.get('code'), name: f.get('name') });
      connect({ ...j, name: f.get('name') });
    } catch (err) {
      $('lobbyErr').textContent = err.message;
    }
  };
  $('btnStart').onclick = () => act({ type: 'start' });
  $('btnBuy').onclick = () => sendOrder('buy');
  $('btnSell').onclick = () => sendOrder('sell');
  $('btnCloseAll').onclick = () => act({ type: 'closeAll' });
  $('positions').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const ds = b.dataset;
    if (ds.close) act({ type: 'close', id: ds.close });
    if (ds.half) act({ type: 'partial', id: ds.half });
    if (ds.be) act({ type: 'breakeven', id: ds.be }).then((r) => r && toast('Stop moved to entry price.', 'good'));
    if (ds.trail) {
      const p = myBoard()?.positions.find((x) => x.id === ds.trail);
      if (!p) return;
      if (p.trail) { act({ type: 'trail', id: p.id, distance: null }); return; }
      // Distance: the current SL distance, otherwise 1.5 × the average candle range.
      const cur = p.side === 'buy' ? bid : ask;
      const dist = Math.max(asset.pip * 3, p.sl != null ? Math.abs(cur - p.sl) : (analysis?.atr || asset.pip * 20) * 1.5);
      act({ type: 'trail', id: p.id, distance: Number(dist.toFixed(asset.digits + 1)) }).then((r) => r && toast(`Trailing stop set ${Math.round(dist / asset.pip)} pips from price.`, 'good'));
    }
  };
  $('orders').onclick = (e) => {
    const id = e.target.closest('button')?.dataset.cancel;
    if (id) act({ type: 'cancelOrder', id });
  };
  $('otype').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    orderType = b.dataset.type;
    document.querySelectorAll('#otype button').forEach((x) => x.classList.toggle('active', x === b));
    $('pendingField').hidden = orderType !== 'pending';
    if (orderType === 'pending' && !(num('ordPrice') > 0) && bid != null) setNum('ordPrice', bid, asset.digits);
    renderTicket();
  };
  $('btnPick').onclick = () => {
    toast('Click the chart at the desired price');
    chart.pickPrice((price) => {
      setNum('ordPrice', price, asset.digits);
      renderTicket();
    });
  };
  $('ordPrice').addEventListener('input', renderTicket);
  $('riskPick').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const t = ticket();
    if (!t.slOn) { toast('Enable the stop-loss to size the position.', 'bad'); return; }
    const equity = myBoard()?.equity ?? 10000;
    const rate = game?.rate || 1.17;
    const perLot = ((t.slP * asset.pip + asset.spread * spreadMult) * asset.contract) / rate;
    let lots = Math.max(0.01, Math.floor(((equity * Number(b.dataset.risk)) / 100 / perLot) * 100) / 100);
    // Cap: what the free margin allows at the chosen leverage.
    const free = myBoard()?.free ?? 10000;
    const perLotMargin = t.margin / t.lots;
    const maxLots = Math.floor(((free * 0.95) / perLotMargin) * 100) / 100;
    const capped = lots > maxLots;
    if (capped) lots = Math.max(0.01, maxLots);
    setNum('lots', lots, 2);
    renderTicket();
    toast(capped
      ? `Size capped at ${fr(lots, 2)} lot by available margin.`
      : `Size set to ${fr(lots, 2)} lot${lots > 1 ? 's' : ''} to risk ${b.dataset.risk}% at the stop.`, capped ? '' : 'good');
  };
  // Indicators (choices remembered on this device)
  let indPrefs = { ma20: true, ma50: false, bb: false, rsi: true, vol: true, liq: true };
  try { indPrefs = { ...indPrefs, ...JSON.parse(localStorage.getItem('duel.tradeInd') || '{}') }; } catch { /* storage unavailable */ }
  chart.setIndicators(indPrefs);
  document.querySelectorAll('#indMenu input').forEach((cb) => {
    cb.checked = !!indPrefs[cb.dataset.ind];
    cb.onchange = () => {
      indPrefs[cb.dataset.ind] = cb.checked;
      chart.setIndicators(indPrefs);
      try { localStorage.setItem('duel.tradeInd', JSON.stringify(indPrefs)); } catch { /* storage unavailable */ }
    };
  });
  $('btnInd').onclick = (e) => {
    e.stopPropagation();
    $('indMenu').hidden = !$('indMenu').hidden;
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.ind-wrap')) $('indMenu').hidden = true;
  });
  document.querySelectorAll('.stepper button[data-lots]').forEach((b) => {
    b.onclick = () => {
      setNum('lots', Math.max(0.01, Math.round(((num('lots') || 0) + Number(b.dataset.lots)) * 100) / 100), 2);
      renderTicket();
    };
  });
  for (const id of ['lots', 'lev', 'slOn', 'tpOn']) $(id).addEventListener('input', renderTicket);
  for (const id of ['slPips', 'tpPips']) $(id).addEventListener('input', () => { userEditedStops = true; renderTicket(); });
  $('tf').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    document.querySelectorAll('#tf button').forEach((x) => x.classList.toggle('active', x === b));
    chart.setTimeframe(Number(b.dataset.tf));
  };
  $('tools').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'toolDel') {
      if (!chart.deleteSelected() && chart.drawings.length && confirm('Clear all drawings on this chart?')) chart.clearDrawings();
      return;
    }
    const tool = chart.tool === b.dataset.tool ? null : b.dataset.tool;
    chart.setTool(tool);
    setToolButtons(tool);
    const touch = matchMedia('(pointer: coarse)').matches;
    if (tool) toast(touch
      ? { h: 'Tap the chart at the desired price', t: 'Drag from one point to another', r: 'Drag to draw the zone', f: 'Drag from the low to the high' }[tool]
      : { h: 'Click at the line price', t: 'Click and drag from one point to another', r: 'Click and drag to draw the zone', f: 'Click and drag from the low to the high' }[tool]);
  };
  $('tgCoach').onclick = () => {
    coachOn = !coachOn;
    $('tgCoach').classList.toggle('on', coachOn);
    $('legend').hidden = !coachOn;
    chart.setAnalysis(analysis, coachOn);
    renderTicket();
  };
  const openLearn = () => { $('learn').hidden = false; };
  $('btnLearn').onclick = openLearn;
  $('btnLearn2').onclick = openLearn;
  $('btnLearnOk').onclick = () => {
    $('learn').hidden = true;
    try { localStorage.setItem('duel.tradeLearned', '1'); } catch { /* storage unavailable */ }
  };
  $('btnCloseRes').onclick = () => { $('results').hidden = true; };
  $('btnRematch').onclick = async () => {
    const j = await act({ type: 'rematch' });
    if (j && j.code) {
      $('results').hidden = true;
      connect({ code: j.code, token: j.token, playerId: j.playerId, name: session.name });
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === 'Escape') {
      $('learn').hidden = true;
      $('indMenu').hidden = true;
      chart.pickPrice(null);
      chart.setTool(null);
      setToolButtons(null);
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && chart.deleteSelected()) e.preventDefault();
  });

  // ------------------------------------------------------------------ Startup
  (async function init() {
    // Forms: use .elements (form.name is the form's own name, not the field).
    const fields = (id) => $(id).elements;
    const params = new URLSearchParams(location.search);
    if (params.get('code')) {
      // Invite link: only the Join form is relevant.
      fields('formJoin').code.value = params.get('code');
      $('formCreate').hidden = true;
      document.querySelector('.lobby-cols').style.gridTemplateColumns = '1fr';
    }
    try {
      const saved = localStorage.getItem('duel.tradeName');
      if (saved) { fields('formCreate').name.value = saved; fields('formJoin').name.value = saved; }
      if (!localStorage.getItem('duel.tradeLearned')) openLearn();
    } catch { /* storage unavailable */ }
    // Remember the last create settings (asset, duration, prices) between games.
    try {
      const prefs = JSON.parse(localStorage.getItem('duel.tradeCreate') || '{}');
      for (const k of ['asset', 'duration', 'mode']) if (prefs[k]) fields('formCreate')[k].value = prefs[k];
    } catch { /* storage unavailable */ }
    for (const k of ['asset', 'duration', 'mode']) {
      fields('formCreate')[k].addEventListener('change', () => {
        const f = fields('formCreate');
        try { localStorage.setItem('duel.tradeCreate', JSON.stringify({ asset: f.asset.value, duration: f.duration.value, mode: f.mode.value })); } catch { /* storage unavailable */ }
      });
    }
    for (const f of ['formCreate', 'formJoin']) {
      fields(f).name.addEventListener('change', (e) => { try { localStorage.setItem('duel.tradeName', e.target.value); } catch { /* storage unavailable */ } });
    }
    const s = store.get();
    if (s && s.code) connect(s);
    else showLobbyForms();
  })();
})();
