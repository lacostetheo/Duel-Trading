// Game engine: the server is the referee (prices, order execution, SL/TP, margin, ranking).
// Players receive live state through an SSE stream (/api/game/:code/stream) and send their orders
// via POST (/api/game/:code/action).
const crypto = require('crypto');
const { ASSETS, getFeed, eurRate } = require('./feeds');

const START_CAPITAL = 10000;
const STOP_OUT = 50; // margin level (%) below which positions are force-closed
const MARGIN_CALL = 100;
const COLORS = ['#4c9dff', '#e06bd0', '#f0a500', '#3fb950'];
const games = new Map();
const MAX_GAMES = 200; // public server: cap on simultaneous games

const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const round = (v, d = 2) => Number(v.toFixed(d));
const fr = (v, d = 2) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (v) => `${v < 0 ? '−' : ''}€${fr(Math.abs(v))}`;
const signedMoney = (v) => `${v >= 0 ? '+' : '−'}€${fr(Math.abs(v))}`;
const signedPct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

function newCode() {
  let code;
  do code = String(1000 + Math.floor(Math.random() * 9000)); while (games.has(code));
  return code;
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, liquidated: p.liquidated };
}

// ------------------------------------------------------------------ Account maths
function quotes(game, mid) {
  const half = (game.asset.spread * (game.source.spreadMult || 1)) / 2;
  return { bid: round(mid - half, game.asset.digits + 1), ask: round(mid + half, game.asset.digits + 1) };
}

function pnlEUR(game, pos, bid, ask) {
  return pnlAt(game, pos, pos.side === 'buy' ? bid : ask, pos.lots);
}

function pnlAt(game, pos, exit, lots) {
  const diff = (exit - pos.open) * (pos.side === 'buy' ? 1 : -1);
  return (diff * game.asset.contract * lots) / game.rate;
}

// Market-order slippage (in price): real order book for bitcoin, otherwise a depth model
// (small order = almost none, large order = much more, and more when the market is volatile).
function slippage(game, side, lots) {
  const a = game.asset;
  const fromBook = game.source.hasBook ? game.source.walkBook(side, lots * a.contract) : null;
  if (fromBook != null) return fromBook;
  return a.spread * 0.5 * Math.pow(lots / a.depth, 1.5) * (game.source.spreadMult || 1);
}

// Market fill price, slippage included.
function marketFill(game, side, lots, bid, ask) {
  const slip = slippage(game, side, lots);
  const d = game.asset.digits + 1;
  return { price: round(side === 'buy' ? ask + slip : bid - slip, d), slip };
}

const pips = (game, v) => Math.round(v / game.asset.pip);

function notionalEUR(game, price, lots) {
  return game.asset.eurNotional ? game.asset.contract * lots : (price * game.asset.contract * lots) / game.rate;
}

function account(game, p, bid, ask) {
  const open = p.positions.map((x) => ({ ...x, pnl: round(pnlEUR(game, x, bid, ask)) }));
  const floating = open.reduce((s, x) => s + x.pnl, 0);
  const equity = p.balance + floating;
  const used = p.positions.reduce((s, x) => s + x.margin, 0);
  return {
    balance: round(p.balance),
    equity: round(equity),
    floating: round(floating),
    used: round(used),
    free: round(equity - used),
    level: used ? round((equity / used) * 100, 0) : null,
    pct: round(((equity - START_CAPITAL) / START_CAPITAL) * 100, 2),
    positions: open,
    orders: p.orders,
  };
}

// ------------------------------------------------------------------ Diffusion (SSE)
// Every message carries the server time, so devices whose clock is off
// (e.g. a guest's phone) can sync their countdown to it.
function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify({ ...data, now: Date.now() })}\n\n`);
}

function broadcast(game, event, data) {
  for (const c of game.clients) send(c.res, event, data);
}

function feedEvent(game, kind, text, extra = {}) {
  const ev = { id: ++game.feedSeq, t: Date.now(), kind, text, ...extra };
  game.feed.push(ev);
  if (game.feed.length > 200) game.feed.shift();
  broadcast(game, 'feed', ev);
}

// Full state sent on connection and after every action.
function snapshot(game) {
  const { bid, ask } = game.mid ? quotes(game, game.mid) : { bid: null, ask: null };
  return {
    code: game.code,
    status: game.status,
    asset: game.asset,
    source: game.source.status,
    duration: game.duration,
    solo: game.solo,
    startedAt: game.startedAt,
    endsAt: game.endsAt,
    hostId: game.hostId,
    capital: START_CAPITAL,
    rate: game.rate,
    bid,
    ask,
    candles: game.source.candles.slice(-240),
    spreadMult: game.source.spreadMult,
    book: game.source.hasBook ? game.source.book : null,
    players: [...game.players.values()].map((p) => ({ ...publicPlayer(p), account: bid ? account(game, p, bid, ask) : null, closed: p.closed.slice(-30) })),
    feed: game.feed.slice(-40),
    results: game.results || null,
  };
}

function scoreboard(game, bid, ask) {
  return [...game.players.values()].map((p) => {
    const a = account(game, p, bid, ask);
    return { id: p.id, equity: a.equity, pct: a.pct, floating: a.floating, used: a.used, free: a.free, level: a.level, positions: a.positions, orders: a.orders };
  });
}

// ------------------------------------------------------------------ Game lifecycle
async function createGame({ name, assetId, duration, mode, solo }) {
  if (games.size >= MAX_GAMES) throw new Error('Server is full right now: please try again in a few minutes.');
  const asset = ASSETS[assetId] || ASSETS.oil;
  const source = await getFeed(asset.id, mode === 'sim' ? 'sim' : 'live');
  const code = newCode();
  const host = makePlayer(name, 0);
  const game = {
    code,
    asset,
    source,
    duration: [5, 10, 30, 60].includes(Number(duration)) ? Number(duration) : 30,
    solo: !!solo,
    status: 'lobby',
    createdAt: Date.now(),
    startedAt: null,
    endsAt: null,
    hostId: host.id,
    players: new Map([[host.id, host]]),
    clients: new Set(),
    feed: [],
    feedSeq: 0,
    mid: source.price,
    rate: await eurRate(),
    leader: null,
  };
  source.start();
  game.onTick = (tick) => onTick(game, tick);
  source.on('tick', game.onTick);
  game.onBook = (book) => broadcast(game, 'book', book);
  source.on('book', game.onBook);
  games.set(code, game);
  if (game.solo) feedEvent(game, 'info', `Solo game · ${host.name} · ${asset.name}.`);
  else feedEvent(game, 'info', `${host.name} created game ${code} on ${asset.name}.`);
  // Clean up abandoned games.
  game.idle = setTimeout(() => endGame(game, true), 3 * 3600 * 1000);
  if (game.solo) startGame(game);
  return { code, token: host.token, playerId: host.id };
}

function makePlayer(name, i) {
  return {
    id: rid(4),
    token: rid(16),
    name: String(name || 'Player').trim().slice(0, 16) || 'Player',
    color: COLORS[i % COLORS.length],
    balance: START_CAPITAL,
    positions: [],
    orders: [], // pending orders (limit / stop)
    closed: [],
    stats: { filled: 0, breakeven: 0, trail: 0, partial: 0, slipCost: 0 },
    liquidated: false,
    peak: START_CAPITAL,
    maxDD: 0,
    marginCalled: false,
  };
}

function joinGame(code, name) {
  const game = games.get(code);
  if (!game) throw new Error('Game not found: check the code.');
  if (game.solo) throw new Error('This is a solo game: it cannot be joined.');
  if (game.status !== 'lobby') throw new Error('The game has already started.');
  if (game.players.size >= 4) throw new Error('The game is full (4 players maximum).');
  const p = makePlayer(name, game.players.size);
  game.players.set(p.id, p);
  feedEvent(game, 'info', `${p.name} joined the game.`);
  broadcast(game, 'state', snapshot(game));
  return { code, token: p.token, playerId: p.id };
}

function startGame(game) {
  if (game.status !== 'lobby') return;
  game.status = 'running';
  game.startedAt = Date.now() + 3000; // 3-second countdown
  game.endsAt = game.startedAt + game.duration * 60000;
  feedEvent(game, 'start', `Starting in 3 s · ${game.asset.name} · ${game.duration} min${game.solo ? ' · solo' : ''}.`);
  broadcast(game, 'state', snapshot(game));
  game.warned = false;
  game.endTimer = setInterval(() => {
    const left = game.endsAt - Date.now();
    if (!game.warned && left <= 5 * 60000 && game.duration > 5) {
      game.warned = true;
      feedEvent(game, 'time', '5 minutes left.');
    }
    if (left <= 0) endGame(game);
  }, 1000);
}

function endGame(game, silent = false) {
  if (game.status === 'ended') return;
  clearInterval(game.endTimer);
  clearTimeout(game.idle);
  if (game.status === 'running' && game.mid) {
    const { bid, ask } = quotes(game, game.mid);
    for (const p of game.players.values()) {
      p.orders = [];
      for (const pos of [...p.positions]) closePosition(game, p, pos, bid, ask, 'fin');
    }
  }
  game.status = 'ended';
  game.results = results(game);
  if (!silent) {
    const w = game.results.ranking[0];
    if (game.solo && w) feedEvent(game, 'end', `Game over · ${signedPct(w.pct)}.`);
    else feedEvent(game, 'end', w ? `Game over. ${w.name} finishes first at ${signedPct(w.pct)}.` : 'Game over.');
    broadcast(game, 'state', snapshot(game));
  }
  game.source.off('tick', game.onTick);
  game.source.off('book', game.onBook);
  game.source.stop();
  // Keep the finished game available for 2 hours.
  setTimeout(() => games.delete(game.code), 2 * 3600 * 1000);
}

// ------------------------------------------------------------------ Engine: on every new price
function onTick(game, tick) {
  game.mid = tick.mid;
  const { bid, ask } = quotes(game, tick.mid);
  const running = game.status === 'running' && Date.now() >= game.startedAt;
  if (running) {
    for (const p of game.players.values()) {
      // Pending orders
      for (const o of [...p.orders]) {
        const hit = o.side === 'buy' ? (o.kind === 'limit' ? ask <= o.price : ask >= o.price) : (o.kind === 'limit' ? bid >= o.price : bid <= o.price);
        if (hit) fillOrder(game, p, o, bid, ask);
      }
      // Stop-loss (filled at market: may slip) / take-profit (limit: at the price or better)
      for (const pos of [...p.positions]) {
        const px = pos.side === 'buy' ? bid : ask;
        if (pos.sl != null && (pos.side === 'buy' ? px <= pos.sl : px >= pos.sl)) {
          const f = marketFill(game, pos.side === 'buy' ? 'sell' : 'buy', pos.lots, bid, ask);
          closePosition(game, p, pos, bid, ask, 'sl', f);
        } else if (pos.tp != null && (pos.side === 'buy' ? px >= pos.tp : px <= pos.tp)) closePosition(game, p, pos, bid, ask, 'tp');
      }
      // Trailing stops: the SL follows the price at a fixed distance and never moves back.
      const dg = game.asset.digits + 1;
      for (const pos of p.positions) {
        if (!pos.trail) continue;
        const cand = round(pos.side === 'buy' ? bid - pos.trail : ask + pos.trail, dg);
        if (pos.sl == null || (pos.side === 'buy' ? cand > pos.sl : cand < pos.sl)) pos.sl = cand;
      }
      // Margin call and stop-out
      let a = account(game, p, bid, ask);
      if (a.level != null && a.level < MARGIN_CALL && !p.marginCalled) {
        p.marginCalled = true;
        feedEvent(game, 'margin', `Margin call · ${p.name}: margin level below 100%.`, { player: p.id });
      }
      if (a.level != null && a.level >= MARGIN_CALL * 1.2) p.marginCalled = false;
      while (a.level != null && a.level < STOP_OUT && p.positions.length) {
        const worst = a.positions.reduce((w, x) => (x.pnl < w.pnl ? x : w));
        const wp = p.positions.find((x) => x.id === worst.id);
        closePosition(game, p, wp, bid, ask, 'stopout', marketFill(game, wp.side === 'buy' ? 'sell' : 'buy', wp.lots, bid, ask));
        a = account(game, p, bid, ask);
      }
      if (a.equity <= 0 && !p.liquidated) {
        p.liquidated = true;
        feedEvent(game, 'liquidation', `Liquidation · ${p.name}: account wiped out.`, { player: p.id });
      }
      // Maximum drawdown from peak
      p.peak = Math.max(p.peak, a.equity);
      p.maxDD = Math.max(p.maxDD, ((p.peak - a.equity) / p.peak) * 100);
    }
    // Leader change
    const board = scoreboard(game, bid, ask).sort((x, y) => y.equity - x.equity);
    if (game.players.size > 1 && board[0] && board[0].equity !== board[1]?.equity && board[0].id !== game.leader) {
      if (game.leader) feedEvent(game, 'lead', `${game.players.get(board[0].id).name} takes the lead.`, { player: board[0].id });
      game.leader = board[0].id;
    }
  }
  broadcast(game, 'tick', {
    t: tick.t, bid, ask, candle: tick.candle, source: game.source.status, spreadMult: game.source.spreadMult,
    board: running || game.status === 'lobby' ? scoreboard(game, bid, ask) : null,
  });
}

// ------------------------------------------------------------------ Orders
function checkOrderParams(game, p, { side, lots, leverage }) {
  if (game.status !== 'running' || Date.now() < game.startedAt) throw new Error('The game has not started yet.');
  if (p.liquidated) throw new Error('Your account has been liquidated.');
  if (!['buy', 'sell'].includes(side)) throw new Error('Invalid side.');
  lots = round(Number(lots), 2);
  leverage = Math.round(Number(leverage));
  if (!(lots >= 0.01 && lots <= 100)) throw new Error('Invalid size (0.01 to 100 lots).');
  if (!(leverage >= 1 && leverage <= game.asset.maxLev)) throw new Error(`Invalid leverage (1 to ${game.asset.maxLev}).`);
  return { lots, leverage };
}

const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

function openPosition(game, p, body) {
  const { lots, leverage } = checkOrderParams(game, p, body);
  const { side } = body;
  if (p.positions.length >= 10) throw new Error('10 open positions maximum.');
  const { bid, ask } = quotes(game, game.mid);
  const sl = numOrNull(body.sl);
  const tp = numOrNull(body.tp);
  if (sl != null && !(side === 'buy' ? sl < bid : sl > ask)) throw new Error(`The stop-loss must be ${side === 'buy' ? 'below' : 'above'} the current price.`);
  if (tp != null && !(side === 'buy' ? tp > ask : tp < bid)) throw new Error(`The take-profit must be ${side === 'buy' ? 'above' : 'below'} the current price.`);
  const fill = marketFill(game, side, lots, bid, ask);
  return createPosition(game, p, { side, lots, leverage, sl, tp, open: fill.price, slip: fill.slip, via: 'market' });
}

function createPosition(game, p, { side, lots, leverage, sl, tp, open, slip = 0, via }) {
  const { bid, ask } = quotes(game, game.mid);
  const margin = notionalEUR(game, open, lots) / leverage;
  const a = account(game, p, bid, ask);
  if (margin > a.free) throw new Error(`Insufficient margin: ${money(margin)} required, ${money(a.free)} available.`);
  const slipEUR = round((slip * game.asset.contract * lots) / game.rate);
  p.stats.slipCost += slipEUR;
  const pos = { id: rid(4), side, lots, leverage, open, sl, tp, margin: round(margin), at: Date.now(), trail: null, slip: pips(game, slip) };
  p.positions.push(pos);
  const d = game.asset.digits;
  const how = via === 'limit' ? ' (limit order filled)' : via === 'stop' ? ' (stop order triggered)' : '';
  const slipTxt = pos.slip >= 1 ? ` · slippage ${pos.slip} pip${pos.slip > 1 ? 's' : ''} (${money(slipEUR)})` : '';
  feedEvent(game, 'open', `${p.name} ${side === 'buy' ? 'buys' : 'sells'} ${fr(lots)} lot${lots > 1 ? 's' : ''} ×${leverage} at ${fr(open, d)}${how}${sl != null ? ` · SL ${fr(sl, d)}` : ' · no SL'}${tp != null ? ` · TP ${fr(tp, d)}` : ''}${slipTxt}`, { player: p.id, side });
  return pos;
}

// ------------------------------------------------------------------ Pending orders
// Buying below the price = "limit" (waiting for a pullback), above = "stop" (waiting for a breakout). Reversed for sells.
function orderKind(side, price, bid, ask) {
  if (side === 'buy') return price < ask ? 'limit' : price > ask ? 'stop' : null;
  return price > bid ? 'limit' : price < bid ? 'stop' : null;
}

function checkStops(side, price, sl, tp) {
  if (sl != null && !(side === 'buy' ? sl < price : sl > price)) throw new Error(`The stop-loss must be ${side === 'buy' ? 'below' : 'above'} the order price.`);
  if (tp != null && !(side === 'buy' ? tp > price : tp < price)) throw new Error(`The take-profit must be ${side === 'buy' ? 'above' : 'below'} the order price.`);
}

const kindLabel = (o) => `a ${o.side === 'buy' ? 'buy' : 'sell'} ${o.kind === 'limit' ? 'limit' : 'stop'} order`;

function placeOrder(game, p, body) {
  const { lots, leverage } = checkOrderParams(game, p, body);
  const { side } = body;
  if (p.orders.length >= 10) throw new Error('10 pending orders maximum.');
  const price = round(Number(body.price), game.asset.digits + 1);
  if (!(price > 0)) throw new Error('Invalid order price.');
  const { bid, ask } = quotes(game, game.mid);
  const kind = orderKind(side, price, bid, ask);
  if (!kind) throw new Error('That is the current price: place a market order instead.');
  const sl = numOrNull(body.sl);
  const tp = numOrNull(body.tp);
  checkStops(side, price, sl, tp);
  const o = { id: rid(4), side, kind, price, lots, leverage, sl, tp, at: Date.now() };
  p.orders.push(o);
  feedEvent(game, 'order', `${p.name} places ${kindLabel(o)} for ${fr(lots)} lot${lots > 1 ? 's' : ''} at ${fr(price, game.asset.digits)}.`, { player: p.id });
  return o;
}

function moveOrder(game, p, { id, price }) {
  const o = p.orders.find((x) => x.id === id);
  if (!o) throw new Error('Order not found.');
  const np = round(Number(price), game.asset.digits + 1);
  const { bid, ask } = quotes(game, game.mid);
  const kind = orderKind(o.side, np, bid, ask);
  if (!(np > 0) || !kind) throw new Error('Invalid order price.');
  // SL and TP move with the order (same distance).
  const delta = np - o.price;
  const dg = game.asset.digits + 1;
  o.price = np;
  o.kind = kind;
  if (o.sl != null) o.sl = round(o.sl + delta, dg);
  if (o.tp != null) o.tp = round(o.tp + delta, dg);
}

function fillOrder(game, p, o, bid, ask) {
  p.orders = p.orders.filter((x) => x.id !== o.id);
  let open;
  let slip = 0;
  if (o.kind === 'limit') open = o.side === 'buy' ? Math.min(ask, o.price) : Math.max(bid, o.price); // at the price or better
  else {
    // A stop becomes a market order: it may slip.
    slip = slippage(game, o.side, o.lots);
    open = o.side === 'buy' ? Math.max(ask, o.price) + slip : Math.min(bid, o.price) - slip;
  }
  try {
    if (p.positions.length >= 10) throw new Error('10 open positions maximum');
    createPosition(game, p, { ...o, open: round(open, game.asset.digits + 1), slip, via: o.kind });
    p.stats.filled++;
  } catch (e) {
    feedEvent(game, 'bad', `${p.name}'s order was cancelled when triggered: ${e.message.split(':')[0].toLowerCase()}.`, { player: p.id });
  }
}

function closePosition(game, p, pos, bid, ask, reason, fill, lots) {
  if (!pos) return;
  const part = lots != null && lots < pos.lots;
  const qty = part ? lots : pos.lots;
  const close = fill ? fill.price : pos.side === 'buy' ? bid : ask;
  if (fill) p.stats.slipCost += round((fill.slip * game.asset.contract * qty) / game.rate);
  const pnl = round(pnlAt(game, pos, close, qty));
  p.balance += pnl;
  if (part) {
    pos.margin = round(pos.margin * (1 - qty / pos.lots));
    pos.lots = round(pos.lots - qty, 2);
  } else p.positions = p.positions.filter((x) => x.id !== pos.id);
  const riskPlanned = pos.sl != null ? Math.abs(pos.open - pos.sl) : null;
  const rewardPlanned = pos.tp != null ? Math.abs(pos.tp - pos.open) : null;
  p.closed.push({ ...pos, lots: qty, close, pnl, reason, closedAt: Date.now(), rr: riskPlanned && rewardPlanned ? round(rewardPlanned / riskPlanned, 2) : null });
  const labels = { sl: 'stop-loss hit', tp: 'take-profit hit', manual: 'position closed', partial: 'half closed', stopout: 'stopped out (insufficient margin)', fin: 'end of game' };
  if (reason !== 'fin') {
    const slipPips = fill ? pips(game, fill.slip) : 0;
    feedEvent(game, reason === 'partial' ? 'manual' : reason, `${p.name}: ${labels[reason]} → ${signedMoney(pnl)}${slipPips >= 1 ? ` (slippage ${slipPips} pip${slipPips > 1 ? 's' : ''})` : ''}`, { player: p.id, pnl });
  }
}

function modifyPosition(game, p, { id, sl, tp }) {
  const pos = p.positions.find((x) => x.id === id);
  if (!pos) throw new Error('Position introuvable.');
  const { bid, ask } = quotes(game, game.mid);
  const nsl = sl === '' || sl == null ? null : Number(sl);
  const ntp = tp === '' || tp == null ? null : Number(tp);
  if (nsl != null && !(pos.side === 'buy' ? nsl < bid : nsl > ask)) throw new Error('Stop-loss on the wrong side of the price.');
  if (ntp != null && !(pos.side === 'buy' ? ntp > ask : ntp < bid)) throw new Error('Take-profit on the wrong side of the price.');
  // Moving the SL by hand disables the trailing stop, otherwise it would immediately take over again.
  if (pos.trail && nsl !== pos.sl) pos.trail = null;
  pos.sl = nsl;
  pos.tp = ntp;
}

async function action(code, body) {
  const game = games.get(code);
  if (!game) throw new Error('Game not found.');
  const p = [...game.players.values()].find((x) => x.token === body.token);
  if (!p) throw new Error('Unknown player.');
  const { bid, ask } = quotes(game, game.mid);
  switch (body.type) {
    case 'start':
      if (p.id !== game.hostId) throw new Error('Only the host can start the game.');
      startGame(game);
      break;
    case 'open':
      openPosition(game, p, body);
      break;
    case 'close': {
      const pos = p.positions.find((x) => x.id === body.id);
      if (pos) closePosition(game, p, pos, bid, ask, 'manual', marketFill(game, pos.side === 'buy' ? 'sell' : 'buy', pos.lots, bid, ask));
      break;
    }
    case 'closeAll':
      for (const pos of [...p.positions]) closePosition(game, p, pos, bid, ask, 'manual', marketFill(game, pos.side === 'buy' ? 'sell' : 'buy', pos.lots, bid, ask));
      break;
    case 'partial': {
      // Close half: lock in part of the gain and let the rest run.
      const pos = p.positions.find((x) => x.id === body.id);
      if (!pos) throw new Error('Position introuvable.');
      const half = Math.floor((pos.lots / 2) * 100) / 100;
      if (half < 0.01) throw new Error('Position too small to be split in half.');
      closePosition(game, p, pos, bid, ask, 'partial', marketFill(game, pos.side === 'buy' ? 'sell' : 'buy', half, bid, ask), half);
      p.stats.partial++;
      break;
    }
    case 'breakeven': {
      // Stop to entry: the trade can no longer lose money (slippage aside).
      const pos = p.positions.find((x) => x.id === body.id);
      if (!pos) throw new Error('Position introuvable.');
      if (pos.side === 'buy' ? bid <= pos.open : ask >= pos.open) throw new Error('Position not in profit yet: cannot move the stop to entry.');
      pos.sl = pos.open;
      p.stats.breakeven++;
      feedEvent(game, 'info', `${p.name} moves the stop to entry.`, { player: p.id });
      break;
    }
    case 'trail': {
      const pos = p.positions.find((x) => x.id === body.id);
      if (!pos) throw new Error('Position introuvable.');
      const dist = numOrNull(body.distance);
      if (dist != null && !(dist >= game.asset.pip * 2)) throw new Error('Trailing stop distance too small.');
      pos.trail = dist;
      if (dist != null) {
        p.stats.trail++;
        const cand = round(pos.side === 'buy' ? bid - dist : ask + dist, game.asset.digits + 1);
        if (pos.sl == null || (pos.side === 'buy' ? cand > pos.sl : cand < pos.sl)) pos.sl = cand;
      }
      break;
    }
    case 'order':
      placeOrder(game, p, body);
      break;
    case 'cancelOrder':
      p.orders = p.orders.filter((x) => x.id !== body.id);
      break;
    case 'moveOrder':
      moveOrder(game, p, body);
      break;
    case 'modify':
      modifyPosition(game, p, body);
      break;
    case 'end':
      if (p.id !== game.hostId) throw new Error('Only the host can end the game.');
      endGame(game);
      return { ok: true };
    case 'rematch': {
      // Rematch: same asset and duration; the other players are invited automatically.
      if (p.id !== game.hostId) throw new Error('Only the host can start a rematch.');
      const g = await createGame({ name: p.name, assetId: game.asset.id, duration: game.duration, mode: game.source.mode, solo: game.solo });
      broadcast(game, 'rematch', { code: g.code });
      return g;
    }
    default:
      throw new Error('Unknown action.');
  }
  broadcast(game, 'state', snapshot(game));
  return { ok: true };
}

function stream(code, token, res) {
  const game = games.get(code);
  if (!game) return false;
  const p = [...game.players.values()].find((x) => x.token === token);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 1500\n\n');
  const client = { res, playerId: p?.id || null };
  game.clients.add(client);
  send(res, 'hello', { playerId: client.playerId });
  send(res, 'state', snapshot(game));
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => {
    clearInterval(ping);
    game.clients.delete(client);
  });
  return true;
}

// ------------------------------------------------------------------ End-of-game report
function results(game) {
  const ranking = [...game.players.values()].map((p) => {
    const trades = p.closed;
    const wins = trades.filter((t) => t.pnl > 0);
    const withSL = trades.filter((t) => t.sl != null);
    const rrs = trades.map((t) => t.rr).filter((x) => x != null);
    const equity = p.balance;
    const badges = [];
    if (trades.length && withSL.length === trades.length) badges.push({ name: 'Always a stop', desc: 'A stop-loss on every trade.' });
    if (rrs.length && rrs.reduce((a, b) => a + b, 0) / rrs.length >= 2) badges.push({ name: 'Reward/risk ≥ 2', desc: 'Average reward-to-risk ratio of 2 or more.' });
    if (trades.length >= 3 && wins.length / trades.length >= 0.7) badges.push({ name: 'Win rate ≥ 70%', desc: '70% winning trades or more.' });
    if (p.liquidated) badges.push({ name: 'Liquidated', desc: 'The account was wiped out: leverage too high.' });
    if (p.maxDD < 2 && trades.length) badges.push({ name: 'Drawdown < 2%', desc: 'Maximum drawdown from peak below 2%.' });
    if (p.stats.filled) badges.push({ name: 'Pending orders', desc: 'Entries through limit or stop orders.' });
    if (p.stats.breakeven || p.stats.trail || p.stats.partial) badges.push({ name: 'Active management', desc: 'Stop to entry, trailing stop or partial close.' });
    const tips = [];
    if (trades.length && withSL.length < trades.length) tips.push(`${trades.length - withSL.length} trade(s) without a stop-loss: unlimited downside.`);
    if (rrs.length && rrs.reduce((a, b) => a + b, 0) / rrs.length < 1) tips.push('Targets smaller than the risk taken: aim for at least 1.5 times the risk.');
    if (p.maxDD > 10) tips.push(`Maximum drawdown of ${p.maxDD.toFixed(1)}%: reduce position size or leverage.`);
    if (trades.length > 25) tips.push('Many trades: the spread is paid on every entry. Be more selective.');
    if (p.stats.slipCost > 20) tips.push(`Slippage paid: ${money(p.stats.slipCost)}. For large sizes, prefer limit orders or split the order.`);
    if (!trades.length) tips.push('No trades this game.');
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      equity: round(equity),
      pct: round(((equity - START_CAPITAL) / START_CAPITAL) * 100, 2),
      trades: trades.length,
      winRate: trades.length ? round((wins.length / trades.length) * 100, 0) : null,
      best: trades.length ? round(Math.max(...trades.map((t) => t.pnl))) : null,
      worst: trades.length ? round(Math.min(...trades.map((t) => t.pnl))) : null,
      slUsage: trades.length ? round((withSL.length / trades.length) * 100, 0) : null,
      avgRR: rrs.length ? round(rrs.reduce((a, b) => a + b, 0) / rrs.length, 2) : null,
      maxDD: round(p.maxDD, 1),
      badges,
      tips,
    };
  }).sort((a, b) => b.equity - a.equity);
  const from = Math.floor((game.startedAt || 0) / 60000) * 60000;
  const c = game.source.candles.filter((x) => x.t >= from);
  const move = c.length > 1 ? ((c[c.length - 1].c - c[0].o) / c[0].o) * 100 : 0;
  return { ranking, market: { move: round(move, 2), high: c.length ? Math.max(...c.map((x) => x.h)) : null, low: c.length ? Math.min(...c.map((x) => x.l)) : null } };
}

function info(code) {
  const g = games.get(code);
  return g ? { code: g.code, status: g.status, asset: g.asset.name, players: [...g.players.values()].map((p) => p.name), duration: g.duration } : null;
}

module.exports = { createGame, joinGame, action, stream, info, ASSETS };
