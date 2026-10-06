// Défi trading : connexion à la partie (SSE), ticket d'ordre avec calcul du risque, positions, classement,
// analyse technique.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fr = (v, d = 2) => Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const eur = (v) => `${fr(v, 2)} €`;
  const signed = (v, suffix = ' €') => `${v >= 0 ? '+' : ''}${fr(v, 2)}${suffix}`;
  const cls = (v) => (v >= 0 ? 'up' : 'down');
  // Lecture tolérante des champs : « 0,5 » (clavier français) comme « 0.5 ».
  const num = (id) => Number(String($(id).value).replace(',', '.').replace(/[^\d.]/g, ''));
  const setNum = (id, v, d) => { $(id).value = Number(v).toFixed(d).replace('.', ','); };

  let session = null; // { code, token, playerId, name }
  let es = null;
  let game = null; // dernier état complet
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
  const seenWalls = new Map();
  let loadedCandlesFor = null;
  // Écart entre l'horloge du serveur et celle de cet appareil (un téléphone peut avoir quelques secondes, voire minutes, d'écart).
  let clockOffset = 0;
  const serverNow = () => Date.now() + clockOffset;
  const syncClock = (d) => {
    if (d && d.now) clockOffset = d.now - Date.now();
    return d;
  };
  const seenFeed = new Set();
  const seenCoach = new Set();

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
    onDrawings: (list, created) => {
      saveDrawings(list);
      if (created) explainDrawing(created);
    },
    onTool: (tool) => setToolButtons(tool),
  });

  window.__tradeChart = chart; // accès pour les tests automatisés

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
    } catch { /* audio indisponible */ }
  }

  const store = {
    get() { try { return JSON.parse(sessionStorage.getItem('echo.trade')); } catch { return null; } },
    set(v) { try { sessionStorage.setItem('echo.trade', JSON.stringify(v)); } catch { /* indisponible */ } },
    clear() { try { sessionStorage.removeItem('echo.trade'); } catch { /* indisponible */ } },
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

  // ------------------------------------------------------------------ Connexion à une partie
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
        toast('Partie introuvable ou terminée.', 'bad');
        showLobbyForms();
      }
    };
  }

  async function onRematch({ code }) {
    if (game && (game.solo || session.playerId === game.hostId)) return; // le créateur a déjà reçu son accès
    try {
      const j = await post('/api/game/join', { code, name: session.name });
      $('results').hidden = true;
      connect({ ...j, name: session.name });
      toast('Nouvelle partie rejointe.', 'good');
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  // ------------------------------------------------------------------ État complet
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
      runCoach(true);
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
    $('lev').title = `Levier maximum : ×${asset.maxLev}`;
    const lev = Math.min(5, asset.maxLev);
    $('lev').value = lev;
    const price = game.bid || (game.candles.length ? game.candles[game.candles.length - 1].c : 1);
    const notionalPerLot = asset.eurNotional ? asset.contract : (price * asset.contract) / game.rate;
    // Taille par défaut : environ 20 000 € d'exposition, sans jamais bloquer plus de 60 % du capital en marge.
    const exposure = Math.min(20000, 10000 * lev * 0.6);
    setNum('lots', Math.max(0.01, Math.round((exposure / notionalPerLot) * 100) / 100), 2);
    $('pipInfo').textContent = `1 pip = ${fr(asset.pip, asset.digits)}`;
    userEditedStops = false;
  }

  function setSource(src) {
    const b = $('srcBadge');
    const map = {
      live: ['TEMPS RÉEL', 'tag live'],
      delayed: ['EN DIRECT (léger différé)', 'tag live'],
      closed: ['MARCHÉ FERMÉ', 'tag warn'],
      sim: ['SIMULATION', 'tag warn'],
      error: ['SIMULATION', 'tag warn'],
    };
    const [txt, c] = map[src] || ['—', 'tag'];
    b.textContent = txt;
    b.className = c;
  }

  // ------------------------------------------------------------------ Nouveau prix
  function applyTick(t) {
    checkLineCross(bid, t.bid);
    if (t.spreadMult) setSpread(t.spreadMult);
    setQuote(t.bid, t.ask);
    setSource(t.source);
    if (t.candle) {
      chart.updateCandle(t.candle);
      if (t.candle.t !== lastCandleT) {
        lastCandleT = t.candle.t;
        runCoach(false);
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
        $('chg').innerHTML = `<span class="${cls(chg)}">${signed(chg, ' %')}</span> depuis le départ`;
      }
    }
    chart.setQuote(b, a);
  }

  function setSpread(m) {
    spreadMult = m;
    const el = $('spreadInfo');
    el.hidden = m < 1.3;
    if (m >= 1.3) el.textContent = `spread ×${fr(m, 1)} (marché agité)`;
  }

  // ------------------------------------------------------------------ Carnet d'ordres (Bitcoin)
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
    $('bookSrc').textContent = b.sim ? 'SIMULÉ' : 'BINANCE · DIRECT';
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
    $('bookMid').innerHTML = `${fr(mid, 1)}<small>niveaux de ${fr(b.step, dStep)} $</small>`;
    $('imbBar').style.width = `${b.imbalance}%`;
    $('imbBuy').textContent = `Achat ${b.imbalance} %`;
    $('imbSell').textContent = `Vente ${100 - b.imbalance} %`;
    bookCoach(b, mid);
  }

  // Le coach signale les gros murs proches et un carnet très déséquilibré (sans répétition).
  function bookCoach(b, mid) {
    if (!coachOn || game?.status !== 'running') return;
    const now = Date.now();
    for (const [side, rows] of [['achat', b.bids], ['vente', b.asks]]) {
      for (const [px, q] of rows) {
        if (q < b.wall * 1.5 || Math.abs(px - mid) / mid > 0.002) continue;
        const key = `${side}${px}`;
        if (now - (seenWalls.get(key) || 0) < 5 * 60000) continue;
        seenWalls.set(key, now);
        addCoach(side === 'achat'
          ? `Mur acheteur : ${fr(q, 1)} BTC à ${fr(px, 0)} $. Soutien tant qu’il n’est pas absorbé ou retiré.`
          : `Mur vendeur : ${fr(q, 1)} BTC à ${fr(px, 0)} $. Résistance probable ; s’il est absorbé, la hausse peut s’accélérer.`, 'info');
      }
    }
    const key = b.imbalance >= 70 ? 'imb-buy' : b.imbalance <= 30 ? 'imb-sell' : null;
    if (key && now - (seenWalls.get(key) || 0) > 3 * 60000) {
      seenWalls.set(key, now);
      addCoach(key === 'imb-buy'
        ? `Carnet déséquilibré à l’achat : ${b.imbalance} % des quantités affichées. Indice de soutien, non garanti.`
        : `Carnet déséquilibré à la vente : ${100 - b.imbalance} % des quantités affichées.`, 'info');
    }
  }

  // ------------------------------------------------------------------ Coach
  function runCoach(initial) {
    const prev = analysis;
    analysis = Coach.analyze(chart.raw);
    chart.setAnalysis(analysis, coachOn);
    if (!analysis) return;
    // Suggestion de SL/TP à partir de la volatilité, tant que le joueur n'a pas modifié les valeurs.
    if (!userEditedStops && analysis.atr) {
      const minPips = Math.ceil(asset.spread / asset.pip) + 2;
      const sl = Math.max(minPips, Math.round((analysis.atr * 1.5) / asset.pip));
      $('slPips').value = sl;
      $('tpPips').value = sl * 2;
    }
    if (initial) return;
    for (const ev of Coach.events(prev, analysis, asset.digits)) {
      if (seenCoach.has(ev.key)) continue;
      seenCoach.add(ev.key);
      addCoach(ev.text, ev.kind);
    }
  }

  // Les notes d'analyse ne sont plus affichées (l'analyse reste dessinée sur le graphique).
  function addCoach() {}

  // ------------------------------------------------------------------ Fil du direct
  // Événements de la partie : seuls ceux qui comptent s'affichent, en notification brève.
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
    $('wPlayers').innerHTML = game.players.map((p) => `<li><i style="background:${p.color}"></i>${esc(p.name)}${p.id === game.hostId ? ' <small class="muted">créateur</small>' : ''}</li>`).join('');
    $('wInfo').textContent = `${asset.name} · ${game.duration} minutes · 10 000 € chacun`;
    const host = session.playerId === game.hostId;
    $('btnStart').hidden = !host;
    $('wGuest').hidden = host;
    const warn = { closed: 'Marché fermé : le prix ne bougera pas. Choisir le Bitcoin (ouvert 24 h/24) ou le mode Simulation.', error: 'Source de prix indisponible : la partie utilisera une simulation réaliste.', sim: 'Mode simulation : prix réalistes générés par ECHO.' }[game.source];
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
        ? `Lien d’invitation${renderLobby.lan ? ' (même Wi-Fi)' : ''} :<br><code>${esc(base)}/?code=${game.code}</code>`
        : `Code à saisir dans « Rejoindre » : <b>${game.code}</b>.`;
    } else $('wInvite').textContent = '';
  }

  // ------------------------------------------------------------------ Classement, compte, positions
  function renderBoard() {
    if (!game) return;
    const rows = game.players.map((p) => ({ ...p, b: board.find((x) => x.id === p.id) })).sort((x, y) => (y.b?.equity ?? 0) - (x.b?.equity ?? 0));
    const lead = rows.length > 1 && rows[0].b && rows[1].b && rows[0].b.equity !== rows[1].b.equity ? rows[0].id : null;
    $('board').innerHTML = rows.map((p) => `<div class="pl-chip ${p.id === lead ? 'lead' : ''}"><i style="background:${p.color}"></i><b>${esc(p.name)}${p.id === session?.playerId ? ' (toi)' : ''}</b><span class="${cls(p.b?.pct ?? 0)}">${signed(p.b?.pct ?? 0, ' %')}</span></div>`).join('');
  }

  function renderAccount() {
    const a = myBoard();
    const p = me();
    if (!a || !p) return;
    $('accEquity').textContent = eur(a.equity);
    $('accPct').textContent = signed(a.pct, ' %');
    $('accPct').className = cls(a.pct);
    $('accBalance').textContent = eur(a.equity - a.floating);
    $('accFloat').textContent = signed(a.floating);
    $('accFloat').className = cls(a.floating);
    $('accUsed').textContent = eur(a.used);
    $('accFree').textContent = eur(a.free);
    $('accLevel').textContent = a.level == null ? '—' : `${fr(a.level, 0)} %`;
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
          <td class="side-${p.side}">${p.side === 'buy' ? 'ACHAT' : 'VENTE'}</td>
          <td>${fr(p.lots, 2)}</td><td>×${p.leverage}</td><td>${fr(p.open, d)}</td>
          <td class="sl">${p.sl == null ? '—' : fr(p.sl, d)}${p.trail ? ' <small class="muted">suiv.</small>' : ''}</td><td>${p.tp == null ? '—' : fr(p.tp, d)}</td>
          <td class="pnl ${cls(p.pnl)}">${signed(p.pnl)}</td>
          <td><div class="mg">
            <button class="x-btn" data-be="${p.id}" ${inProfit(p) && p.sl !== p.open ? '' : 'disabled'} title="Stop au prix d’entrée">BE</button>
            <button class="x-btn" data-half="${p.id}" ${p.lots >= 0.02 ? '' : 'disabled'} title="Encaisser la moitié de la position">½</button>
            <button class="x-btn ${p.trail ? 'on' : ''}" data-trail="${p.id}" title="Stop suiveur">Suiv.</button>
            <button class="x-btn" data-close="${p.id}" title="Fermer la position">Fermer</button>
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
    // Ordres en attente (la distance change à chaque prix)
    $('ordersWrap').hidden = !orders.length;
    const oKey = orders.map((o) => `${o.id}:${o.price}:${o.kind}`).join('|');
    const dist = (o) => `${Math.round(Math.abs((o.side === 'buy' ? ask : bid) - o.price) / asset.pip)} pips`;
    if (full || oKey !== ordKey) {
      ordKey = oKey;
      $('orders').innerHTML = orders.map((o) => `
        <tr data-id="${o.id}">
          <td class="side-${o.side}">${o.side === 'buy' ? 'ACHAT' : 'VENTE'} ${o.kind === 'limit' ? 'LIMITE' : 'STOP'}</td>
          <td>${fr(o.lots, 2)}</td><td>×${o.leverage}</td><td>${fr(o.price, d)}</td>
          <td>${o.sl == null ? '—' : fr(o.sl, d)}</td><td>${o.tp == null ? '—' : fr(o.tp, d)}</td>
          <td class="dist">${dist(o)}</td>
          <td><button class="x-btn" data-cancel="${o.id}">Annuler</button></td>
        </tr>`).join('');
    } else {
      for (const o of orders) {
        const cell = $('orders').querySelector(`tr[data-id="${o.id}"] .dist`);
        if (cell) cell.textContent = dist(o);
      }
    }
  }

  // ------------------------------------------------------------------ Ticket d'ordre : risque et conseils
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
    // Glissement estimé d'un ordre au marché (le serveur calcule le vrai au moment de l'exécution).
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

  // Type d'ordre en attente selon le prix choisi (même règle que le serveur).
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
    $('sizeInfo').textContent = `= ${fr(t.lots * asset.contract, asset.contract >= 100 ? 0 : 2)} ${asset.unit} · 1 pip = ${fr(t.pipValue, 2)} €`;
    const riskPct = t.risk != null ? (t.risk / equity) * 100 : null;
    const rr = t.slOn && t.tpOn ? t.tpP / t.slP : null;
    $('risk').innerHTML = `
      <div><span>Exposition</span><b>${eur(t.notional)}</b></div>
      <div><span>Marge bloquée</span><b class="${t.margin > free ? 'down' : ''}">${eur(t.margin)}</b></div>
      <div><span>Perte si SL touché</span><b class="down">${t.risk == null ? 'non plafonnée' : `−${eur(t.risk)} (${fr(riskPct, 1)} %)`}</b></div>
      <div><span>Gain si TP touché</span><b class="up">${t.reward == null ? '—' : `+${eur(Math.max(0, t.reward))}`}</b></div>
      ${t.slip / asset.pip >= 1 ? `<div class="rr"><span>Glissement estimé (liquidité)</span><b class="down">≈ ${Math.round(t.slip / asset.pip)} pips · ${eur(t.slipCost)}</b></div>` : ''}
      <div class="rr"><span>Ratio gain / risque</span><b class="${rr == null ? '' : rr >= 1.5 ? 'up' : 'down'}">${rr == null ? '—' : `1 pour ${fr(rr, 1)}`}</b></div>`;
    if (t.pending) {
      const kb = pendingKind('buy', t.oPrice);
      const ks = pendingKind('sell', t.oPrice);
      $('ordKind').textContent = t.oPrice > 0 ? `→ achat ${kb === 'limit' ? 'LIMITE' : kb === 'stop' ? 'STOP' : '—'} · vente ${ks === 'limit' ? 'LIMITE' : ks === 'stop' ? 'STOP' : '—'}` : '';
    }
    const canTrade = game?.status === 'running' && serverNow() >= game.startedAt && !me()?.liquidated;
    const pk = (side) => (t.pending ? pendingKind(side, t.oPrice) : 'market');
    $('btnBuy').disabled = !canTrade || !pk('buy');
    $('btnSell').disabled = !canTrade || !pk('sell');
    const label = (side, k) => (k === 'market' ? (side === 'buy' ? 'ACHETER' : 'VENDRE') : `${side === 'buy' ? 'ACHAT' : 'VENTE'} ${k === 'limit' ? 'LIMITE' : k === 'stop' ? 'STOP' : ''}`);
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
      if (r) toast(`Ordre ${side === 'buy' ? 'd’achat' : 'de vente'} ${pendingKind(side, entry) === 'limit' ? 'limite' : 'stop'} placé à ${fr(entry, asset.digits)}`, 'good');
      return;
    }
    const r = await act({ type: 'open', side, lots: t.lots, leverage: t.lev, sl, tp });
    if (r) {
      toast(`${side === 'buy' ? 'Achat' : 'Vente'} exécuté${side === 'buy' ? '' : 'e'}`, 'good');
    }
  }

  // ------------------------------------------------------------------ Résultats
  function renderResults(r) {
    if (renderResults.done === game.code) return;
    renderResults.done = game.code;
    $('results').hidden = false;
    const medals = ['1', '2', '3', '4'];
    const m = r.market;
    $('resMarket').textContent = `Pendant la partie, ${asset.name} a varié de ${signed(m.move, ' %')} (plus haut ${fr(m.high, asset.digits)}, plus bas ${fr(m.low, asset.digits)}).`;
    $('resRanking').innerHTML = r.ranking.map((p, i) => `
      <div class="rank ${i === 0 ? 'first' : ''}">
        <div class="medal">${medals[i] || ''}</div>
        <div>
          <h3>${esc(p.name)} <em class="${cls(p.pct)}">${signed(p.pct, ' %')}</em> <small class="muted">${eur(p.equity)}</small></h3>
          <div class="stats">
            <span>Trades <b>${p.trades}</b></span>
            <span>Gagnants <b>${p.winRate == null ? '—' : p.winRate + ' %'}</b></span>
            <span>Meilleur <b>${p.best == null ? '—' : signed(p.best)}</b></span>
            <span>Pire <b>${p.worst == null ? '—' : signed(p.worst)}</b></span>
            <span>Avec SL <b>${p.slUsage == null ? '—' : p.slUsage + ' %'}</b></span>
            <span>Ratio moyen <b>${p.avgRR == null ? '—' : '1 pour ' + fr(p.avgRR, 1)}</b></span>
            <span>Perte max <b>${fr(p.maxDD, 1)} %</b></span>
          </div>
          <div class="badges">${p.badges.map((b) => `<span class="badge" title="${esc(b.desc)}">${esc(b.name)}</span>`).join('')}</div>
          ${p.tips.length ? `<ul class="tips">${p.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        </div>
      </div>`).join('');
    $('btnRematch').hidden = session.playerId !== game.hostId;
    $('btnRematch').textContent = game.solo ? 'Rejouer' : 'Revanche';
    $('resRecord').hidden = true;
    if (game.solo && r.ranking[0]) saveRecord(r.ranking[0].pct);
  }

  // Record personnel en solo, par actif et par durée (gardé sur cet appareil).
  function saveRecord(pct) {
    const key = `${asset.id}|${game.duration}`;
    let rec = {};
    try { rec = JSON.parse(localStorage.getItem('echo.tradeRecords')) || {}; } catch { /* indisponible */ }
    const prev = rec[key];
    const el = $('resRecord');
    el.hidden = false;
    if (prev == null || pct > prev) {
      rec[key] = pct;
      try { localStorage.setItem('echo.tradeRecords', JSON.stringify(rec)); } catch { /* indisponible */ }
      el.className = 'record new';
      el.textContent = prev == null ? `Record ${asset.name} · ${game.duration} min : ${signed(pct, ' %')}` : `Nouveau record : ${signed(pct, ' %')} (ancien : ${signed(prev, ' %')})`;
    } else {
      el.className = 'record';
      el.textContent = `Record ${asset.name} · ${game.duration} min : ${signed(prev, ' %')}`;
    }
  }

  // ------------------------------------------------------------------ Dessins d'analyse
  const drawKey = () => `echo.drawings.${asset?.id || 'x'}`;
  function loadDrawings() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(drawKey())) || []; } catch { /* indisponible */ }
    chart.setDrawings(list);
    setToolButtons(null);
  }
  function saveDrawings(list) {
    try { localStorage.setItem(drawKey(), JSON.stringify(list.slice(-50))); } catch { /* indisponible */ }
  }
  function setToolButtons(tool) {
    document.querySelectorAll('#tools [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  }
  const pxTxt = (v) => fr(v, asset.digits);
  // Petit retour pédagogique quand on trace une ligne.
  function explainDrawing(d) {
    if (d.type === 'h') {
      // Rebond = une bougie vient au contact puis clôture du même côté ; traversée = la clôture change de côté.
      const atr = analysis?.atr || 0;
      const tol = Math.max(atr * 0.25, asset.pip * 3);
      let bounces = 0;
      let crosses = 0;
      let side = 0;
      let touching = false;
      for (const k of chart.raw) {
        const s2 = Math.sign(k.c - d.p1) || side;
        const near = k.l - tol <= d.p1 && k.h + tol >= d.p1;
        if (side && s2 !== side) crosses++;
        else if (near && !touching && side) bounces++;
        touching = near;
        side = s2;
      }
      const where = bid != null && d.p1 > bid ? 'résistance' : 'support';
      const px = pxTxt(d.p1);
      if (crosses > bounces) addCoach(`Ligne ${px} : ${crosses} traversées pour ${bounces} rebond${bounces > 1 ? 's' : ''}. Niveau non respecté.`, 'warn');
      else if (bounces >= 3) addCoach(`Ligne ${px} (${where}) : ${bounces} rebonds. Niveau respecté ; alerte en cas de franchissement.`, 'good');
      else addCoach(`Ligne ${px} (${where}) : ${bounces} rebond${bounces > 1 ? 's' : ''}. Niveau peu testé.`, 'info');
    } else if (d.type === 't') {
      const up = d.t2 > d.t1 ? d.p2 > d.p1 : d.p1 > d.p2;
      addCoach(up ? 'Oblique haussière : une clôture en dessous signale un affaiblissement.' : 'Oblique baissière : une clôture au-dessus signale un possible retournement.', 'info');
    } else if (d.type === 'f') {
      addCoach('Retracement de Fibonacci : réactions fréquentes sur 38,2 %, 50 % et 61,8 %.', 'info');
    } else if (d.type === 'r') {
      addCoach('Zone tracée.', 'info');
    }
  }
  // Alerte quand le prix traverse une de tes lignes horizontales.
  function checkLineCross(prev, cur) {
    if (prev == null || cur == null || prev === cur) return;
    for (const d of chart.drawings) {
      if (d.type !== 'h') continue;
      if ((prev < d.p1 && cur >= d.p1) || (prev > d.p1 && cur <= d.p1)) {
        const now = Date.now();
        if (d.lastAlert && now - d.lastAlert < 30000) continue;
        d.lastAlert = now;
        const upx = cur > prev;
        addCoach(`Franchissement ${upx ? 'haussier' : 'baissier'} de la ligne ${pxTxt(d.p1)}. Confirmation à la clôture de la bougie.`, 'warn');
        toast(`Ligne ${pxTxt(d.p1)} franchie ${upx ? 'à la hausse' : 'à la baisse'}`);
        beep(upx);
      }
    }
  }

  // ------------------------------------------------------------------ Minuteur et compte à rebours
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

  // ------------------------------------------------------------------ Événements de l'interface
  // Bouton utilisé pour créer (e.submitter n'existe pas sur les vieux Safari).
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
    if (ds.be) act({ type: 'breakeven', id: ds.be }).then((r) => r && addCoach('Stop déplacé au prix d’entrée : position sans risque (hors glissement).', 'good'));
    if (ds.trail) {
      const p = myBoard()?.positions.find((x) => x.id === ds.trail);
      if (!p) return;
      if (p.trail) { act({ type: 'trail', id: p.id, distance: null }); return; }
      // Distance : celle du SL actuel, sinon 1,5 × la volatilité moyenne d'une bougie.
      const cur = p.side === 'buy' ? bid : ask;
      const dist = Math.max(asset.pip * 3, p.sl != null ? Math.abs(cur - p.sl) : (analysis?.atr || asset.pip * 20) * 1.5);
      act({ type: 'trail', id: p.id, distance: Number(dist.toFixed(asset.digits + 1)) }).then((r) => r && addCoach(`Stop suiveur activé à ${Math.round(dist / asset.pip)} pips du prix.`, 'good'));
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
    toast('Cliquer sur le graphique au prix voulu');
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
    if (!t.slOn) { toast('Activer le stop-loss pour calculer la taille.', 'bad'); return; }
    const equity = myBoard()?.equity ?? 10000;
    const rate = game?.rate || 1.17;
    const perLot = ((t.slP * asset.pip + asset.spread * spreadMult) * asset.contract) / rate;
    let lots = Math.max(0.01, Math.floor(((equity * Number(b.dataset.risk)) / 100 / perLot) * 100) / 100);
    // Plafond : ce que la marge libre permet avec le levier choisi.
    const free = myBoard()?.free ?? 10000;
    const perLotMargin = t.margin / t.lots;
    const maxLots = Math.floor(((free * 0.95) / perLotMargin) * 100) / 100;
    const capped = lots > maxLots;
    if (capped) lots = Math.max(0.01, maxLots);
    setNum('lots', lots, 2);
    renderTicket();
    toast(capped
      ? `Taille plafonnée à ${fr(lots, 2)} lot par la marge disponible.`
      : `Taille ajustée : ${fr(lots, 2)} lot${lots > 1 ? 's' : ''} pour risquer ${b.dataset.risk.replace('.', ',')} % au SL.`, capped ? '' : 'good');
  };
  // Indicateurs (choix mémorisés sur l'appareil)
  let indPrefs = { ma20: true, ma50: false, bb: false, rsi: true, vol: true, liq: true };
  try { indPrefs = { ...indPrefs, ...JSON.parse(localStorage.getItem('echo.tradeInd') || '{}') }; } catch { /* indisponible */ }
  chart.setIndicators(indPrefs);
  document.querySelectorAll('#indMenu input').forEach((cb) => {
    cb.checked = !!indPrefs[cb.dataset.ind];
    cb.onchange = () => {
      indPrefs[cb.dataset.ind] = cb.checked;
      chart.setIndicators(indPrefs);
      try { localStorage.setItem('echo.tradeInd', JSON.stringify(indPrefs)); } catch { /* indisponible */ }
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
      if (!chart.deleteSelected() && chart.drawings.length && confirm('Effacer tous les dessins de ce graphique ?')) chart.clearDrawings();
      return;
    }
    const tool = chart.tool === b.dataset.tool ? null : b.dataset.tool;
    chart.setTool(tool);
    setToolButtons(tool);
    const touch = matchMedia('(pointer: coarse)').matches;
    if (tool) toast(touch
      ? { h: 'Toucher le graphique au prix voulu', t: 'Glisser d’un point à l’autre', r: 'Glisser pour tracer la zone', f: 'Glisser du creux au sommet' }[tool]
      : { h: 'Cliquer au prix de la ligne', t: 'Cliquer-glisser d’un point à l’autre', r: 'Cliquer-glisser pour tracer la zone', f: 'Cliquer-glisser du creux au sommet' }[tool]);
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
    try { localStorage.setItem('echo.tradeLearned', '1'); } catch { /* indisponible */ }
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

  // ------------------------------------------------------------------ Démarrage
  (async function init() {
    // Formulaires : on passe par .elements (form.name désigne le nom du formulaire, pas le champ).
    const fields = (id) => $(id).elements;
    const params = new URLSearchParams(location.search);
    if (params.get('code')) {
      // Lien d'invitation : seul le formulaire « Rejoindre » est utile.
      fields('formJoin').code.value = params.get('code');
      $('formCreate').hidden = true;
      document.querySelector('.lobby-cols').style.gridTemplateColumns = '1fr';
    }
    try {
      const saved = localStorage.getItem('echo.tradeName');
      if (saved) { fields('formCreate').name.value = saved; fields('formJoin').name.value = saved; }
      if (!localStorage.getItem('echo.tradeLearned')) openLearn();
    } catch { /* indisponible */ }
    // Derniers réglages de création (actif, durée, prix) retenus d'une partie à l'autre.
    try {
      const prefs = JSON.parse(localStorage.getItem('echo.tradeCreate') || '{}');
      for (const k of ['asset', 'duration', 'mode']) if (prefs[k]) fields('formCreate')[k].value = prefs[k];
    } catch { /* indisponible */ }
    for (const k of ['asset', 'duration', 'mode']) {
      fields('formCreate')[k].addEventListener('change', () => {
        const f = fields('formCreate');
        try { localStorage.setItem('echo.tradeCreate', JSON.stringify({ asset: f.asset.value, duration: f.duration.value, mode: f.mode.value })); } catch { /* indisponible */ }
      });
    }
    for (const f of ['formCreate', 'formJoin']) {
      fields(f).name.addEventListener('change', (e) => { try { localStorage.setItem('echo.tradeName', e.target.value); } catch { /* indisponible */ } });
    }
    const s = store.get();
    if (s && s.code) connect(s);
    else showLobbyForms();
  })();
})();
