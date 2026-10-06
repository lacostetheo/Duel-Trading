// Analyse technique : supports/résistances, ranges, tendance, figures de bougies, RSI, moyennes mobiles,
// zones de liquidité ; notes courtes affichées dans l'onglet Analyse et contrôles avant chaque ordre.
// Calcul purement local et déterministe : deux joueurs qui voient les mêmes bougies voient les mêmes analyses.
(function () {
  const fr = (v, d) => Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

  function atr(c, n = 14) {
    let s = 0;
    let k = 0;
    for (let i = Math.max(1, c.length - n); i < c.length; i++) {
      s += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
      k++;
    }
    return k ? s / k : 0;
  }

  // Sommets et creux locaux (plus haut / plus bas que les w bougies de chaque côté).
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

  // ------------------------------------------------------------------ Indicateurs (tableaux alignés sur les bougies)
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

  // RSI 14 (lissage de Wilder), entre 0 et 100.
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

  // Zones de liquidité : au-dessus des sommets et sous les creux encore intacts, là où s'accumulent
  // les stops des traders (et les ordres d'entrée sur cassure). Le prix va souvent les « chercher ».
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
        // Encore intacte : aucune bougie n'a clôturé au-delà depuis.
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
    const w = c.slice(-N - 1, -1); // bougies clôturées
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
    doji: { name: 'Doji', desc: 'Ouverture ≈ fermeture : acheteurs et vendeurs s’équilibrent. Signe d’hésitation, souvent avant un changement de direction.' },
    hammer: { name: 'Marteau', bull: true, desc: 'Longue mèche basse : les vendeurs ont poussé le prix vers le bas, mais les acheteurs l’ont ramené. Signal de rebond possible.' },
    star: { name: 'Étoile filante', bull: false, desc: 'Longue mèche haute : les acheteurs ont poussé, mais les vendeurs ont repris la main. Signal de repli possible.' },
    bullEngulf: { name: 'Avalement haussier', bull: true, desc: 'Une bougie verte « avale » entièrement la rouge précédente : les acheteurs prennent le contrôle.' },
    bearEngulf: { name: 'Avalement baissier', bull: false, desc: 'Une bougie rouge « avale » la verte précédente : les vendeurs prennent le contrôle.' },
    bigUp: { name: 'Grande bougie verte', bull: true, desc: 'Bougie pleine sans presque de mèches : forte pression acheteuse.' },
    bigDown: { name: 'Grande bougie rouge', bull: false, desc: 'Bougie pleine sans presque de mèches : forte pression vendeuse.' },
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

  // Analyse complète (appelée à chaque nouvelle bougie, pas à chaque tick).
  function analyze(candles) {
    const c = candles;
    if (c.length < 20) return null;
    const a = atr(c.slice(0, -1));
    const price = c[c.length - 1].c;
    // Figures de bougies : seulement les plus récentes et sans répétition rapprochée, pour rester lisible.
    let patterns = [];
    for (let i = Math.max(4, c.length - 30); i < c.length - 1; i++) {
      const key = patternAt(c, i, a);
      if (!key) continue;
      const prevSame = patterns[patterns.length - 1];
      if (prevSame && prevSame.key === key && i - prevSame.i <= 4) continue;
      patterns.push({ t: c[i].t, key, ...PATTERNS[key], price: PATTERNS[key].bull === false ? c[i].h : c[i].l, i });
    }
    patterns = patterns.slice(-5);
    // Indicateurs sur les bougies clôturées
    const closes = c.slice(0, -1).map((k) => k.c);
    const r = rsi(closes);
    const m20 = sma(closes, 20);
    const m50 = sma(closes, 50);
    const n = closes.length - 1;
    const ind = { rsi: r[n], rsiPrev: r[n - 1], ma20: m20[n], ma50: m50[n], ma20Prev: m20[n - 1], ma50Prev: m50[n - 1] };
    return { atr: a, price, levels: levels(c, a, price), range: findRange(c, a), trend: findTrend(c, a), patterns, lastClosed: c[c.length - 2], ind, liquidity: liquidity(c, a) };
  }

  // Messages du coach quand quelque chose d'intéressant apparaît sur la dernière bougie clôturée.
  function events(prev, cur, digits) {
    const out = [];
    if (!cur) return out;
    const k = cur.lastClosed;
    const f = (v) => fr(v, digits);
    if (cur.range && !(prev && prev.range)) {
      out.push({ kind: 'info', key: `range-${f(cur.range.top)}`, text: `Range ${f(cur.range.bottom)} – ${f(cur.range.top)}. Approche classique : achat près du bas, vente près du haut, stop de l’autre côté de la borne.` });
    }
    if (prev && prev.range && k) {
      if (k.c > prev.range.top + cur.atr * 0.1) out.push({ kind: 'good', speak: true, key: `bo-up-${f(prev.range.top)}`, text: `Cassure haussière du range à ${f(prev.range.top)}. Le mouvement peut s’accélérer ; les fausses cassures sont fréquentes, garder un stop.` });
      else if (k.c < prev.range.bottom - cur.atr * 0.1) out.push({ kind: 'bad', speak: true, key: `bo-dn-${f(prev.range.bottom)}`, text: `Cassure baissière du range à ${f(prev.range.bottom)}. Les acheteurs du range sont piégés, la baisse peut s’accélérer.` });
    }
    if (cur.trend && (!prev || !prev.trend || prev.trend.dir !== cur.trend.dir)) {
      out.push({ kind: cur.trend.dir === 'up' ? 'good' : 'bad', key: `trend-${cur.trend.dir}-${k && k.t}`, text: cur.trend.dir === 'up'
        ? 'Tendance haussière : sommets et creux ascendants. Privilégier les achats sur repli.'
        : 'Tendance baissière : sommets et creux descendants. Les achats à contre-tendance sont risqués.' });
    }
    if (k) {
      for (const l of cur.levels) {
        const near = Math.abs((l.type === 'resistance' ? k.h : k.l) - l.price) <= cur.atr * 0.25;
        const rejected = l.type === 'resistance' ? k.c < l.price : k.c > l.price;
        if (near && rejected) {
          out.push({ kind: 'warn', key: `test-${l.type}-${f(l.price)}-${k.t}`, speak: l.touches >= 3, text: l.type === 'resistance'
            ? `Rejet sur la résistance ${f(l.price)} (${l.touches + 1}e test). Si elle cède, le mouvement peut s’accélérer.`
            : `Rebond sur le support ${f(l.price)} (${l.touches + 1}e test). Niveau défendu par les acheteurs.` });
        }
      }
      // RSI : entrée en zone extrême
      const { rsi: rv, rsiPrev: rp, ma20, ma50, ma20Prev, ma50Prev } = cur.ind || {};
      if (rv != null && rp != null) {
        if (rv >= 70 && rp < 70) out.push({ kind: 'warn', key: `rsi-hi-${k.t}`, text: `RSI ${fr(rv, 0)} : surachat (> 70). Hausse rapide, essoufflement possible ; pas un signal de vente à lui seul en tendance forte.` });
        if (rv <= 30 && rp > 30) out.push({ kind: 'warn', key: `rsi-lo-${k.t}`, text: `RSI ${fr(rv, 0)} : survente (< 30). Rebond possible, à confirmer (bougie haussière, support).` });
      }
      // Croisement des moyennes mobiles 20 et 50
      if (ma20 != null && ma50 != null && ma20Prev != null && ma50Prev != null) {
        if (ma20Prev <= ma50Prev && ma20 > ma50) out.push({ kind: 'good', key: `mx-up-${k.t}`, text: 'Croisement haussier : la MM20 passe au-dessus de la MM50.' });
        if (ma20Prev >= ma50Prev && ma20 < ma50) out.push({ kind: 'bad', key: `mx-dn-${k.t}`, text: 'Croisement baissier : la MM20 passe sous la MM50.' });
      }
      // Chasse aux stops : une mèche traverse une zone de liquidité puis le prix clôture en deçà.
      for (const z of (prev && prev.liquidity) || []) {
        if (z.side === 'above' && k.h > z.price && k.c < z.price) out.push({ kind: 'warn', speak: true, key: `sweep-${f(z.price)}`, text: `Chasse aux stops au-dessus de ${f(z.price)} : mèche au-delà du sommet puis clôture en dessous. Retournement baissier fréquent.` });
        if (z.side === 'below' && k.l < z.price && k.c > z.price) out.push({ kind: 'warn', speak: true, key: `sweep-${f(z.price)}`, text: `Chasse aux stops sous ${f(z.price)} : mèche sous le creux puis clôture au-dessus. Rebond fréquent.` });
      }
      const pat = cur.patterns.find((p) => p.t === k.t);
      if (pat) out.push({ kind: pat.bull === true ? 'good' : pat.bull === false ? 'bad' : 'info', key: `pat-${k.t}`, text: `${pat.name} : ${pat.desc}` });
    }
    return out;
  }

  // Conseils affichés dans le ticket d'ordre, selon le contexte du graphique.
  function hints(side, cur, price, digits = 2) {
    const out = [];
    if (!cur) return out;
    const a = cur.atr;
    const res = cur.levels.filter((l) => l.type === 'resistance')[0];
    const sup = cur.levels.filter((l) => l.type === 'support')[0];
    if (side === 'buy') {
      if (res && res.price - price < a * 0.7) out.push({ kind: 'warn', text: 'Achat juste sous une résistance : risque de rejet. Attendre la cassure ou réduire l’objectif.' });
      if (sup && price - sup.price < a * 0.7) out.push({ kind: 'good', text: 'Achat près d’un support : stop juste en dessous.' });
      if (cur.trend && cur.trend.dir === 'down') out.push({ kind: 'warn', text: 'Achat contre la tendance baissière.' });
      if (cur.trend && cur.trend.dir === 'up') out.push({ kind: 'good', text: 'Achat dans le sens de la tendance haussière.' });
    } else {
      if (sup && price - sup.price < a * 0.7) out.push({ kind: 'warn', text: 'Vente juste au-dessus d’un support : risque de rebond.' });
      if (res && res.price - price < a * 0.7) out.push({ kind: 'good', text: 'Vente près d’une résistance : stop juste au-dessus.' });
      if (cur.trend && cur.trend.dir === 'up') out.push({ kind: 'warn', text: 'Vente contre la tendance haussière.' });
      if (cur.trend && cur.trend.dir === 'down') out.push({ kind: 'good', text: 'Vente dans le sens de la tendance baissière.' });
    }
    const rv = cur.ind && cur.ind.rsi;
    if (rv != null && side === 'buy' && rv >= 70) out.push({ kind: 'warn', text: `RSI ${fr(rv, 0)} (surachat) : achat après une forte hausse.` });
    if (rv != null && side === 'sell' && rv <= 30) out.push({ kind: 'warn', text: `RSI ${fr(rv, 0)} (survente) : vente après une forte baisse.` });
    const liq = (cur.liquidity || []).find((z) => Math.abs(z.price - price) < a * 0.6);
    if (liq) out.push({ kind: 'warn', text: `Zone de liquidité à ${fr(liq.price, digits)} : éviter d’y placer le stop (mèches fréquentes).` });
    if (cur.range) {
      const pos = (price - cur.range.bottom) / (cur.range.top - cur.range.bottom);
      if (side === 'buy' && pos > 0.7) out.push({ kind: 'warn', text: 'Achat dans le haut du range.' });
      if (side === 'sell' && pos < 0.3) out.push({ kind: 'warn', text: 'Vente dans le bas du range.' });
    }
    return out;
  }

  window.Coach = { analyze, events, hints, atr, sma, bollinger, rsi };
})();
