// Technical analysis: support/resistance, ranges, trend, candle patterns, RSI, moving averages
// and liquidity zones, drawn on the chart.
// Purely local and deterministic: two players looking at the same candles see the same analysis.
(function () {
  
  function atr(c, n = 14) {
    let s = 0;
    let k = 0;
    for (let i = Math.max(1, c.length - n); i < c.length; i++) {
      s += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
      k++;
    }
    return k ? s / k : 0;
  }

  // Local highs and lows (higher / lower than the w candles on each side).
  function pivots(c, w = 3) {
    const out = [];
    for (let i = w; i < c.length - w; i++) {
      let hi = true;
      let lo = true;
      for (let j = i - w; j <= i + w; j++) {
        if (j === i) continue;
        if (c[j].h >= c[i].h) hi = false;
        if (c[j].l <= c[i].l) lo = false;
      }
      if (hi) out.push({ i, p: c[i].h, kind: 'high' });
      if (lo) out.push({ i, p: c[i].l, kind: 'low' });
    }
    return out;
  }

  function levels(c, a, price) {
    const piv = pivots(c.slice(-150));
    const tol = a * 0.35;
    const clusters = [];
    for (const p of piv.sort((x, y) => x.p - y.p)) {
      const last = clusters[clusters.length - 1];
      if (last && p.p - last.max <= tol) {
        last.items.push(p);
        last.max = p.p;
      } else clusters.push({ items: [p], max: p.p });
    }
    const lv = clusters
      .filter((k) => k.items.length >= 2 && k.items.length <= 8)
      .map((k) => ({ price: k.items.reduce((s, x) => s + x.p, 0) / k.items.length, touches: k.items.length }))
      .map((l) => ({ ...l, type: l.price >= price ? 'resistance' : 'support' }));
    const res = lv.filter((l) => l.type === 'resistance').sort((x, y) => x.price - y.price).slice(0, 2);
    const sup = lv.filter((l) => l.type === 'support').sort((x, y) => y.price - x.price).slice(0, 2);
    return [...res, ...sup];
  }

  // ------------------------------------------------------------------ Indicators (arrays aligned with candles)
  function sma(vals, n) {
    const out = new Array(vals.length).fill(null);
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= n) sum -= vals[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function bollinger(vals, n = 20, k = 2) {
    const mid = sma(vals, n);
    const up = new Array(vals.length).fill(null);
    const dn = new Array(vals.length).fill(null);
    for (let i = n - 1; i < vals.length; i++) {
      let v = 0;
      for (let j = i - n + 1; j <= i; j++) v += (vals[j] - mid[i]) ** 2;
      const sd = Math.sqrt(v / n);
      up[i] = mid[i] + k * sd;
      dn[i] = mid[i] - k * sd;
    }
    return { mid, up, dn };
  }

  // RSI 14 (Wilder smoothing), from 0 to 100.
  function rsi(vals, n = 14) {
    const out = new Array(vals.length).fill(null);
    if (vals.length <= n) return out;
    let g = 0;
    let l = 0;
    for (let i = 1; i <= n; i++) {
      const d = vals[i] - vals[i - 1];
      if (d > 0) g += d; else l -= d;
    }
    g /= n;
    l /= n;
    out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < vals.length; i++) {
      const d = vals[i] - vals[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  // Liquidity zones: above highs and below lows that are still intact, where traders' stops
  // (and breakout entry orders) cluster. Price often goes looking for them.
  function liquidity(c, a) {
    const w = c.slice(-120, -1);
    const off = c.length - 1 - w.length;
    const piv = pivots(w, 3);
    const tol = a * 0.3;
    const zones = [];
    for (const kind of ['high', 'low']) {
      const pts = piv.filter((p) => p.kind === kind).sort((x, y) => x.p - y.p);
      const groups = [];
      for (const p of pts) {
        const g = groups[groups.length - 1];
        if (g && p.p - g.max <= tol) { g.items.push(p); g.max = p.p; } else groups.push({ items: [p], min: p.p, max: p.p });
      }
      for (const g of groups) {
        const firstI = Math.min(...g.items.map((x) => x.i));
        const lvl = kind === 'high' ? g.max : g.min;
        // Still intact: no candle has closed beyond it since.
        const after = w.slice(firstI + 1);
        const taken = after.some((k) => (kind === 'high' ? k.c > lvl + a * 0.05 : k.c < lvl - a * 0.05));
        if (taken) continue;
        zones.push({ side: kind === 'high' ? 'above' : 'below', price: lvl, count: g.items.length, from: c[off + firstI].t });
      }
    }
    const price = c[c.length - 1].c;
    const above = zones.filter((z) => z.side === 'above' && z.price > price).sort((x, y) => x.price - y.price).slice(0, 2);
    const below = zones.filter((z) => z.side === 'below' && z.price < price).sort((x, y) => y.price - x.price).slice(0, 2);
    return [...above, ...below];
  }

  function regression(vals) {
    const n = vals.length;
    let sx = 0; let sy = 0; let sxy = 0; let sxx = 0;
    vals.forEach((y, x) => { sx += x; sy += y; sxy += x * y; sxx += x * x; });
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
    return { slope, intercept: (sy - slope * sx) / n };
  }

  function findRange(c, a) {
    const N = 24;
    if (c.length < N + 2) return null;
    const w = c.slice(-N - 1, -1); // closed candles
    const top = Math.max(...w.map((x) => x.h));
    const bottom = Math.min(...w.map((x) => x.l));
    const width = top - bottom;
    if (!a || width > a * 6 || width < a * 1.5) return null;
    const nearTop = w.filter((x) => top - x.h <= width * 0.2).length;
    const nearBottom = w.filter((x) => x.l - bottom <= width * 0.2).length;
    const { slope } = regression(w.map((x) => x.c));
    if (nearTop < 2 || nearBottom < 2 || Math.abs(slope * N) > width * 0.45) return null;
    return { top, bottom, from: w[0].t, to: c[c.length - 1].t };
  }

  function findTrend(c, a) {
    const N = 30;
    if (c.length < N + 2 || !a) return null;
    const w = c.slice(-N - 1, -1);
    const { slope, intercept } = regression(w.map((x) => x.c));
    const strength = (slope * N) / a;
    if (Math.abs(strength) < 3) return null;
    return {
      dir: slope > 0 ? 'up' : 'down',
      t0: w[0].t, p0: intercept, t1: w[w.length - 1].t, p1: intercept + slope * (N - 1),
      strength,
    };
  }

  const PATTERNS = {
    doji: { name: 'Doji', desc: 'Open ≈ close: buyers and sellers are balanced. A sign of indecision, often before a change of direction.' },
    hammer: { name: 'Hammer', bull: true, desc: 'Long lower wick: sellers pushed the price down but buyers brought it back. Possible rebound.' },
    star: { name: 'Shooting star', bull: false, desc: 'Long upper wick: buyers pushed up but sellers took back control. Possible pullback.' },
    bullEngulf: { name: 'Bullish engulfing', bull: true, desc: 'A green candle fully engulfs the previous red one: buyers take control.' },
    bearEngulf: { name: 'Bearish engulfing', bull: false, desc: 'A red candle fully engulfs the previous green one: sellers take control.' },
    bigUp: { name: 'Strong green candle', bull: true, desc: 'Full body with almost no wicks: strong buying pressure.' },
    bigDown: { name: 'Strong red candle', bull: false, desc: 'Full body with almost no wicks: strong selling pressure.' },
  };

  function patternAt(c, i, a) {
    const k = c[i];
    const p = c[i - 1];
    if (!k || !p || !a) return null;
    const range = k.h - k.l;
    if (range < a * 0.6) return null;
    const body = Math.abs(k.c - k.o);
    const upper = k.h - Math.max(k.o, k.c);
    const lower = Math.min(k.o, k.c) - k.l;
    const pBody = Math.abs(p.c - p.o);
    const falling = c[i - 3] && c[i - 1].c < c[i - 3].c;
    const rising = c[i - 3] && c[i - 1].c > c[i - 3].c;
    if (p.c < p.o && k.c > k.o && k.c >= p.o && k.o <= p.c && body > pBody * 1.1) return 'bullEngulf';
    if (p.c > p.o && k.c < k.o && k.c <= p.c && k.o >= p.o && body > pBody * 1.1) return 'bearEngulf';
    if (lower >= body * 2 && upper <= range * 0.2 && falling) return 'hammer';
    if (upper >= body * 2 && lower <= range * 0.2 && rising) return 'star';
    if (body <= range * 0.1 && range >= a * 0.8) return 'doji';
    if (body >= range * 0.85 && range >= a * 1.6) return k.c > k.o ? 'bigUp' : 'bigDown';
    return null;
  }

  // Full analysis (run on every new candle, not on every tick).
  function analyze(candles) {
    const c = candles;
    if (c.length < 20) return null;
    const a = atr(c.slice(0, -1));
    const price = c[c.length - 1].c;
    // Candle patterns: only the most recent ones, without close repeats, to stay readable.
    let patterns = [];
    for (let i = Math.max(4, c.length - 30); i < c.length - 1; i++) {
      const key = patternAt(c, i, a);
      if (!key) continue;
      const prevSame = patterns[patterns.length - 1];
      if (prevSame && prevSame.key === key && i - prevSame.i <= 4) continue;
      patterns.push({ t: c[i].t, key, ...PATTERNS[key], price: PATTERNS[key].bull === false ? c[i].h : c[i].l, i });
    }
    patterns = patterns.slice(-5);
    // Indicators on closed candles
    const closes = c.slice(0, -1).map((k) => k.c);
    const r = rsi(closes);
    const m20 = sma(closes, 20);
    const m50 = sma(closes, 50);
    const n = closes.length - 1;
    const ind = { rsi: r[n], rsiPrev: r[n - 1], ma20: m20[n], ma50: m50[n], ma20Prev: m20[n - 1], ma50Prev: m50[n - 1] };
    return { atr: a, price, levels: levels(c, a, price), range: findRange(c, a), trend: findTrend(c, a), patterns, lastClosed: c[c.length - 2], ind, liquidity: liquidity(c, a) };
  }

  window.Coach = { analyze, atr, sma, bollinger, rsi };
})();
