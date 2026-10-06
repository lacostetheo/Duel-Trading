// Real-time price feeds.
// - Oil, Brent, gold, EUR/USD: Yahoo Finance (slightly delayed, identical for every player).
// - Bitcoin: Binance (real time, 24/7), with its public market-data mirror and Yahoo as backups.
// - Simulation: realistic random walk (trends and ranges) when the market is closed or unreachable,
//   always started from the latest real price so it stays believable.
// Each feed builds one-minute candles (with volume) and emits a "tick" event on every new price.
// Bitcoin also has an order book (live from Binance, or simulated in simulation mode): "book" event.
// "depth" = lots absorbed without notable slippage, for assets without a public order book.
const { EventEmitter } = require('events');
const { fetchWithTimeout } = require('./http');

const ASSETS = {
  oil: { id: 'oil', name: 'WTI Crude Oil', short: 'WTI', source: 'yahoo', symbol: 'CL=F', contract: 100, unit: 'barrels', pip: 0.01, digits: 2, spread: 0.03, maxLev: 10, dailyVol: 0.022, sim: 68, depth: 20, simVol: 900 },
  brent: { id: 'brent', name: 'Brent Crude Oil', short: 'BRENT', source: 'yahoo', symbol: 'BZ=F', contract: 100, unit: 'barrels', pip: 0.01, digits: 2, spread: 0.03, maxLev: 10, dailyVol: 0.02, sim: 71, depth: 15, simVol: 500 },
  eurusd: { id: 'eurusd', name: 'EUR / USD', short: 'EURUSD', source: 'yahoo', symbol: 'EURUSD=X', contract: 100000, unit: '€', pip: 0.0001, digits: 5, spread: 0.00012, maxLev: 30, dailyVol: 0.005, sim: 1.17, eurNotional: true, depth: 30, simVol: 1500 },
  gold: { id: 'gold', name: 'Gold', short: 'GOLD', source: 'yahoo', symbol: 'GC=F', contract: 100, unit: 'ounces', pip: 0.1, digits: 2, spread: 0.4, maxLev: 20, dailyVol: 0.012, sim: 3780, depth: 10, simVol: 400 },
  btc: { id: 'btc', name: 'Bitcoin', short: 'BTC', source: 'binance', symbol: 'BTCUSDT', yahoo: 'BTC-USD', contract: 1, unit: 'BTC', pip: 1, digits: 1, spread: 15, maxLev: 2, dailyVol: 0.03, sim: 80000, depth: 5, simVol: 60, book: true },
};

const MIN = 60000;
const round = (v, d) => Number(v.toFixed(d));

async function yahooCandles(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const json = await (await fetchWithTimeout(url, 6000)).json();
  const res = json.chart.result[0];
  const q = res.indicators.quote[0];
  const candles = (res.timestamp || [])
    .map((t, i) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] || 0 }))
    .filter((c) => c.o != null && c.h != null && c.l != null && c.c != null);
  return { candles, price: res.meta.regularMarketPrice, time: (res.meta.regularMarketTime || 0) * 1000 };
}

// Binance's main API is geo-blocked in some regions (US hosts); the data-api mirror serves the same market data.
const BINANCE_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];
let binanceHost = BINANCE_HOSTS[0];

async function binanceGet(path, ms) {
  try {
    return await (await fetchWithTimeout(binanceHost + path, ms)).json();
  } catch (e) {
    const other = BINANCE_HOSTS.find((h) => h !== binanceHost);
    const j = await (await fetchWithTimeout(other + path, ms)).json();
    binanceHost = other; // stick with the host that works
    return j;
  }
}

async function binanceCandles(symbol, limit = 240) {
  const k = await binanceGet(`/api/v3/klines?symbol=${symbol}&interval=1m&limit=${limit}`, limit > 10 ? 6000 : 4000);
  return k.map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: Math.round(+x[5] * 100) / 100 }));
}

async function binanceDepth(symbol) {
  const j = await binanceGet(`/api/v3/depth?symbol=${symbol}&limit=1000`, 4000);
  const conv = (rows) => rows.map((r) => [+r[0], +r[1]]);
  return { bids: conv(j.bids), asks: conv(j.asks) };
}

// Coinbase: second live source for bitcoin (candles + order book) when Binance is unreachable.
const COINBASE = 'https://api.exchange.coinbase.com/products/BTC-USD';

async function coinbaseCandles(limit = 240) {
  const k = await (await fetchWithTimeout(`${COINBASE}/candles?granularity=60`, limit > 10 ? 6000 : 4000)).json();
  return k.slice(0, limit).reverse().map((x) => ({ t: x[0] * 1000, o: x[3], h: x[2], l: x[1], c: x[4], v: Math.round(x[5] * 100) / 100 }));
}

async function coinbaseDepth() {
  const j = await (await fetchWithTimeout(`${COINBASE}/book?level=2`, 5000)).json();
  const conv = (rows) => rows.slice(0, 1000).map((r) => [+r[0], +r[1]]);
  return { bids: conv(j.bids), asks: conv(j.asks) };
}

const EXCHANGES = {
  binance: { label: 'BINANCE', candles: (a, n) => binanceCandles(a.symbol, n), depth: (a) => binanceDepth(a.symbol) },
  coinbase: { label: 'COINBASE', candles: (a, n) => coinbaseCandles(n), depth: () => coinbaseDepth() },
};

// Latest real price seen for each asset, used to start simulations from the actual market level.
const lastReal = {};

async function spotPrice(asset) {
  if (lastReal[asset.id]) return lastReal[asset.id];
  const tries = [async () => (await yahooCandles(asset.yahoo || asset.symbol)).price];
  if (asset.source === 'binance') {
    tries.unshift(
      async () => +(await binanceGet(`/api/v3/ticker/price?symbol=${asset.symbol}`, 4000)).price,
      async () => +(await (await fetchWithTimeout(`${COINBASE}/ticker`, 4000)).json()).price,
    );
  }
  for (const t of tries) {
    try {
      const p = await t();
      if (Number.isFinite(p) && p > 0) return p;
    } catch { /* next source */ }
  }
  return asset.sim;
}

// "Round" aggregation step (1, 2, 5, 10, 20, 50…) to show ~22 levels per side.
function niceStep(x) {
  const e = 10 ** Math.floor(Math.log10(x));
  const m = x / e;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e;
}

// Stable pseudo-random value (same price + same time window = same size) for a believable simulated book.
function hash01(a, b) {
  let h = Math.imul(a | 0, 2654435761) ^ Math.imul(b | 0, 1597334677);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

class Feed extends EventEmitter {
  constructor(asset, mode) {
    super();
    this.asset = asset;
    this.mode = mode; // 'live' | 'sim'
    this.candles = [];
    this.price = null;
    this.lastUpdate = 0; // timestamp of the last price change received from the source
    this.status = 'starting'; // 'live' | 'delayed' | 'closed' | 'sim' | 'error'
    this.users = 0;
    this.timer = null;
    this.failures = 0;
    this.exchange = null; // bitcoin: 'binance' | 'coinbase' (null = Yahoo)
    this.errors = []; // why live sources failed, shown on /api/status
    this.spreadMult = 1; // the spread widens when the market gets volatile
    this.book = null; // aggregated book for display
    this.bookRaw = null; // full-depth book used to fill orders (slippage)
    this.bookAt = 0;
  }

  get hasBook() {
    return !!this.asset.book && (this.mode === 'sim' || (!!this.exchange && this.status === 'live'));
  }

  // Loads recent history and determines whether the market is open.
  async init() {
    if (this.mode === 'live') {
      // Bitcoin: Binance, then Coinbase (both real time with an order book), then Yahoo. Other assets: Yahoo.
      const sources = this.asset.source === 'binance' ? ['binance', 'coinbase', 'yahoo'] : ['yahoo'];
      for (const src of sources) {
        try {
          if (src === 'yahoo') {
            const r = await yahooCandles(this.asset.yahoo || this.asset.symbol);
            this.candles = r.candles.slice(-240);
            this.price = r.price ?? this.candles[this.candles.length - 1]?.c;
            // No quote for over 20 minutes: market closed (weekend, daily break…).
            this.status = Date.now() - r.time > 20 * MIN ? 'closed' : 'delayed';
            this.exchange = null;
          } else {
            this.candles = await EXCHANGES[src].candles(this.asset, 240);
            this.price = this.candles[this.candles.length - 1]?.c;
            this.status = 'live';
            this.exchange = src;
          }
          if (!this.price || this.candles.length < 5) throw new Error('not enough history');
          this.lastUpdate = Date.now();
          lastReal[this.asset.id] = this.price;
          return;
        } catch (e) {
          this.errors.push(`${src}: ${e.message}`);
        }
      }
      console.warn(`[duel] ${this.asset.symbol} feed unavailable (${this.errors.join(' | ')}) → simulation`);
      this.fallback = true; // retried on the next game (see getFeed)
    }
    this.initSim(await spotPrice(this.asset));
  }

  // ------------------------------------------------------------------ Simulation
  initSim(target) {
    this.mode = 'sim';
    this.status = 'sim';
    const a = this.asset;
    this.simState = { trend: 0, anchor: target, regimeUntil: 0 };
    let p = target;
    const start = Math.floor(Date.now() / MIN) * MIN - 240 * MIN;
    this.candles = [];
    for (let i = 0; i < 240; i++) {
      const o = p;
      let h = o;
      let l = o;
      for (let s = 0; s < 12; s++) {
        p = this.simStep(p, 5);
        h = Math.max(h, p);
        l = Math.min(l, p);
      }
      this.candles.push({ t: start + i * MIN, o, h, l, c: p, v: this.simVolume(o, h, l) * 60 });
    }
    // Rescale the history so it ends exactly on the real price.
    const k = target / p;
    for (const c of this.candles) for (const f of ['o', 'h', 'l', 'c']) c[f] = round(c[f] * k, a.digits);
    this.simState.anchor = target;
    this.price = target;
  }

  // Simulated volume per second: the more the market moves, the more it trades.
  simVolume(o, h, l) {
    const a = this.asset;
    const move = (h - l) / o / (a.dailyVol * 0.05);
    return Math.round((a.simVol / 60) * (0.4 + Math.random() * 0.8) * (0.6 + Math.min(4, move)) * 100) / 100;
  }

  // One simulation step of "dt" seconds, alternating trending and ranging regimes.
  simStep(p, dt) {
    const a = this.asset;
    const st = this.simState;
    const now = Date.now();
    if (!st.regimeUntil || st.regimeSteps <= 0) {
      const r = Math.random();
      st.trend = r < 0.35 ? 0 : (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random());
      st.anchor = p;
      st.regimeSteps = Math.round((180 + Math.random() * 420) / dt);
      st.regimeUntil = now;
    }
    st.regimeSteps--;
    // Slightly amplified volatility to keep the game lively.
    const sigma = a.dailyVol * 2.2 * Math.sqrt(dt / 86400);
    const drift = st.trend * sigma * 0.12;
    const pull = st.trend === 0 ? ((st.anchor - p) / p) * 0.02 : 0; // in a range, the price reverts to the middle
    const shock = (Math.random() + Math.random() + Math.random() - 1.5) * 1.4 * sigma;
    return p * (1 + drift + pull + shock);
  }

  // ------------------------------------------------------------------ Price loop
  start() {
    this.users++;
    if (this.timer) return;
    const period = this.mode === 'sim' ? 1000 : this.exchange ? 1000 : 2500;
    const loop = async () => {
      try {
        await this.poll();
        this.failures = 0;
      } catch (e) {
        this.failures++;
        if (this.failures === 3) console.warn(`[duel] ${this.asset.symbol}: ${e.message}`);
      }
      if (this.users > 0) this.timer = setTimeout(loop, this.failures > 3 ? 8000 : period);
      else this.timer = null;
    };
    this.timer = setTimeout(loop, 200);
  }

  stop() {
    this.users = Math.max(0, this.users - 1);
  }

  async poll() {
    let price;
    let volume = 0;
    if (this.mode === 'sim') {
      const prev = this.price;
      price = this.simStep(this.price, 1);
      volume = this.simVolume(prev, Math.max(prev, price), Math.min(prev, price));
    } else if (this.exchange) {
      // Exact exchange candles (price + volume); the last one is still forming.
      const ks = await EXCHANGES[this.exchange].candles(this.asset, 2);
      for (const k of ks) this.mergeCandle(k);
      price = ks[ks.length - 1].c;
    } else {
      const r = await yahooCandles(this.asset.yahoo || this.asset.symbol);
      price = r.price;
      if (Date.now() - r.time > 20 * MIN) this.status = 'closed';
      else if (this.status === 'closed') this.status = 'delayed';
      this.yahooVol = new Map(r.candles.slice(-3).map((k) => [k.t, k.v]));
    }
    if (!Number.isFinite(price)) return;
    if (this.mode !== 'sim') lastReal[this.asset.id] = price;
    if (price !== this.price) this.lastUpdate = Date.now();
    this.price = price;
    if (!(this.exchange && this.mode !== 'sim')) this.pushCandle(Date.now(), price, volume);
    this.updateSpread();
    // Fire and forget: a slow order-book request must never delay the price.
    if (this.hasBook && !this.bookBusy) {
      this.bookBusy = true;
      this.updateBook().catch(() => {}).finally(() => { this.bookBusy = false; });
    }
    this.emit('tick', { t: Date.now(), mid: round(price, this.asset.digits + 1), candle: this.candles[this.candles.length - 1] });
  }

  mergeCandle(k) {
    const last = this.candles[this.candles.length - 1];
    if (last && last.t === k.t) Object.assign(last, k);
    else if (!last || k.t > last.t) {
      this.candles.push({ ...k });
      if (this.candles.length > 600) this.candles.shift();
    }
  }

  // Dynamic spread: range of the last 3 candles vs the median of the last hour (×1 to ×3).
  updateSpread() {
    const c = this.candles;
    if (c.length < 20) return;
    const ranges = c.slice(-61, -1).map((k) => k.h - k.l).sort((x, y) => x - y);
    const med = ranges[Math.floor(ranges.length / 2)] || 0;
    const recent = c.slice(-3).reduce((s, k) => s + (k.h - k.l), 0) / 3;
    const target = med > 0 ? Math.max(1, Math.min(3, recent / med / 1.3)) : 1;
    // Smoothed so the spread does not jump from one second to the next.
    this.spreadMult = Math.round((this.spreadMult * 0.8 + target * 0.2) * 100) / 100;
  }

  // ------------------------------------------------------------------ Order book (bitcoin)
  async updateBook() {
    const now = Date.now();
    if (this.mode === 'sim') this.bookRaw = this.simBook(this.price, now);
    else {
      if (now - this.bookAt < 1900) return; // every 2 seconds (API rate limits)
      this.bookRaw = await EXCHANGES[this.exchange].depth(this.asset);
    }
    this.bookAt = now;
    this.book = this.aggregateBook(this.bookRaw);
    this.emit('book', this.book);
  }

  simBook(mid, now) {
    const win = Math.floor(now / 15000); // walls move slowly
    const side = (dir) => {
      const rows = [];
      const first = dir > 0 ? Math.floor(mid) + 1 : Math.ceil(mid) - 1;
      for (let i = 0; i < 400; i++) {
        const px = first + dir * i;
        let q = 0.01 + hash01(px, win + i) ** 3 * 0.9 * Math.exp(-i / 160);
        if (px % 100 === 0) q += 1.5 + hash01(px, win) * 5;
        if (px % 500 === 0) q += 4 + hash01(px, win + 7) * 10;
        if (hash01(px * 7, Math.floor(now / 45000)) > 0.997) q += 3 + hash01(px, 3) * 12; // occasional large resting order
        rows.push([px, Math.round(q * 1000) / 1000]);
      }
      return rows;
    };
    return { bids: side(-1), asks: side(1) };
  }

  aggregateBook(raw) {
    if (!raw || !raw.bids.length || !raw.asks.length) return null;
    const bestBid = raw.bids[0][0];
    const bestAsk = raw.asks[0][0];
    const span = Math.min(bestBid - raw.bids[raw.bids.length - 1][0], raw.asks[raw.asks.length - 1][0] - bestAsk);
    const step = niceStep(Math.max(span / 22, 0.5));
    const agg = (rows, dir) => {
      const map = new Map();
      for (const [px, q] of rows) {
        const b = dir < 0 ? Math.floor(px / step) * step : Math.ceil(px / step) * step;
        map.set(b, (map.get(b) || 0) + q);
      }
      return [...map.entries()].sort((x, y) => (dir < 0 ? y[0] - x[0] : x[0] - y[0])).slice(0, 22).map(([p, q]) => [p, Math.round(q * 1000) / 1000]);
    };
    const bids = agg(raw.bids, -1);
    const asks = agg(raw.asks, 1);
    const all = [...bids, ...asks].map((x) => x[1]).sort((x, y) => x - y);
    const median = all[Math.floor(all.length / 2)] || 0;
    const sum = (rows) => rows.reduce((s, x) => s + x[1], 0);
    const bidQ = sum(bids);
    const askQ = sum(asks);
    return {
      t: Date.now(),
      step,
      bids,
      asks,
      bestBid,
      bestAsk,
      wall: Math.max(median * 4, 1e-9), // size above which a level counts as a "wall"
      imbalance: bidQ + askQ ? Math.round((bidQ / (bidQ + askQ)) * 100) : 50,
      sim: this.mode === 'sim',
      src: this.exchange ? EXCHANGES[this.exchange].label : null,
    };
  }

  // Slippage (in price) to fill "qty" units at market by walking the real book.
  walkBook(side, qty) {
    const rows = side === 'buy' ? this.bookRaw?.asks : this.bookRaw?.bids;
    if (!rows || !rows.length) return null;
    let left = qty;
    let cost = 0;
    let last = rows[0][0];
    for (const [px, q] of rows) {
      const take = Math.min(left, q);
      cost += take * px;
      left -= take;
      last = px;
      if (left <= 1e-12) break;
    }
    // Book exhausted: the remainder fills even further away.
    if (left > 1e-12) cost += left * (last + (last - rows[0][0]) * (1 + left / qty));
    return Math.abs(cost / qty - rows[0][0]);
  }

  pushCandle(t, p, vol = 0) {
    const d = this.asset.digits;
    const bucket = Math.floor(t / MIN) * MIN;
    const last = this.candles[this.candles.length - 1];
    if (last && last.t === bucket) {
      last.h = round(Math.max(last.h, p), d);
      last.l = round(Math.min(last.l, p), d);
      last.c = round(p, d);
      last.v = round((last.v || 0) + vol, 2);
      if (this.yahooVol?.has(bucket)) last.v = this.yahooVol.get(bucket);
    } else {
      const o = last ? last.c : round(p, d);
      if (last && this.yahooVol?.has(last.t)) last.v = this.yahooVol.get(last.t);
      this.candles.push({ t: bucket, o, h: round(Math.max(o, p), d), l: round(Math.min(o, p), d), c: round(p, d), v: round(vol, 2) });
      if (this.candles.length > 600) this.candles.shift();
    }
  }
}

// One shared feed per asset and mode (several games can use it).
const feeds = new Map();
async function getFeed(assetId, mode) {
  const asset = ASSETS[assetId];
  if (!asset) throw new Error('unknown asset');
  const key = `${assetId}|${mode}`;
  let f = feeds.get(key);
  // A live feed that fell back to simulation is retried once nobody is using it any more.
  if (f && f.fallback && f.users === 0 && Date.now() - f.createdAt > MIN) f = null;
  if (!f) {
    f = new Feed(asset, mode);
    f.createdAt = Date.now();
    feeds.set(key, f);
    f.ready = f.init();
  }
  await f.ready;
  return f;
}

// EUR/USD rate used to convert P&L into euros (refreshed every 10 minutes).
let eurusd = { rate: 1.17, at: 0 };
async function eurRate() {
  if (Date.now() - eurusd.at < 10 * MIN) return eurusd.rate;
  try {
    const r = await yahooCandles('EURUSD=X');
    if (r.price) eurusd = { rate: r.price, at: Date.now() };
  } catch {
    eurusd.at = Date.now();
  }
  return eurusd.rate;
}

// Diagnostics: which source each feed uses, and why live sources failed.
function feedStatus() {
  return [...feeds.values()].map((f) => ({
    asset: f.asset.id, mode: f.mode, status: f.status, source: f.exchange || (f.mode === 'sim' ? 'simulation' : 'yahoo'),
    price: f.price, players: f.users, errors: f.errors,
  }));
}

module.exports = { ASSETS, getFeed, eurRate, feedStatus };
