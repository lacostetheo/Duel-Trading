// Candlestick chart (canvas, no dependencies).
// Redraws only on demand (new price, hover, drag) to stay smooth.
(function () {
  const MIN = 60000;
  const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const fr = (v, d) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  class TradeChart {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts; // { digits, onDrag(posId, kind, price), onDrawings(list, created), onTool(tool) }
      this.raw = [];
      this.candles = [];
      this.tf = 1;
      this.visible = 90;
      this.bid = null;
      this.ask = null;
      this.positions = [];
      this.orders = []; // pending orders
      this.book = null; // aggregated order book (bitcoin)
      this.ind = { ma20: false, ma50: false, bb: false, rsi: true, vol: true, liq: true };
      this.calc = null; // indicators computed on the displayed candles
      this.pick = null; // pick a price by clicking (pending order)
      this.analysis = null;
      this.showCoach = true;
      this.hover = null;
      this.drag = null;
      // User drawings, in market coordinates (time, price) so they follow zoom and timeframe.
      this.drawings = [];
      this.tool = null; // 'h' horizontal line, 't' trend line, 'r' zone, 'f' Fibonacci
      this.draft = null; // drawing in progress
      this.placing = false; // two-click drawing
      this.selected = -1;
      this.edit = null; // moving a drawing or a handle
      this.frame = 0;
      this.colors();
      this.resize();
      new ResizeObserver(() => { this.resize(); this.request(); }).observe(canvas);
      window.addEventListener('themechange', () => { this.colors(); this.request(); });
      this.bind();
    }

    colors() {
      const c = Theme.colors();
      this.C = {
        up: c.green, down: c.red, text: c.text, muted: c.muted, border: c.border, strong: c.strong,
        accent: c.accent, accentRgb: c.accentRgb, amber: `rgb(${c.amber})`, amberRgb: c.amber, surface: c.surface,
        font: c.font, num: c.fontNum, greenRgb: c.greenRgb, redRgb: c.redRgb,
      };
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = Math.max(1, r.width);
      this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    request() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.draw();
      });
    }

    // ------------------------------------------------------------------ Data
    setCandles(list) {
      this.raw = list.slice();
      this.aggregate();
      this.request();
    }

    updateCandle(k) {
      const last = this.raw[this.raw.length - 1];
      if (last && last.t === k.t) this.raw[this.raw.length - 1] = { ...k };
      else if (!last || k.t > last.t) {
        this.raw.push({ ...k });
        if (this.raw.length > 600) this.raw.shift();
      }
      this.aggregate(true);
      this.request();
    }

    setTimeframe(tf) {
      this.tf = tf;
      this.aggregate();
      this.request();
    }

    aggregate(onlyLast) {
      this.aggregateCandles(onlyLast);
      this.compute();
    }

    compute() {
      const closes = this.candles.map((k) => k.c);
      const C = window.Coach;
      if (!C || !C.sma) return;
      this.calc = {
        ma20: this.ind.ma20 ? C.sma(closes, 20) : null,
        ma50: this.ind.ma50 ? C.sma(closes, 50) : null,
        bb: this.ind.bb ? C.bollinger(closes, 20, 2) : null,
        rsi: this.ind.rsi ? C.rsi(closes, 14) : null,
        hasVol: this.candles.some((k) => k.v > 0),
      };
    }

    setIndicators(ind) {
      this.ind = { ...this.ind, ...ind };
      this.compute();
      this.request();
    }

    setOrders(list) {
      if (this.drag) return;
      this.orders = list || [];
      this.request();
    }

    setBook(book) {
      this.book = book;
      this.request();
    }

    // Next click on the chart picks a price (null to cancel).
    pickPrice(cb) {
      this.pick = cb;
      this.canvas.style.cursor = cb ? 'copy' : 'crosshair';
      this.request();
    }

    aggregateCandles(onlyLast) {
      if (this.tf === 1) {
        this.candles = this.raw;
        return;
      }
      const span = this.tf * MIN;
      const out = onlyLast && this.candles.length ? this.candles.slice(0, -1) : [];
      const startIdx = onlyLast && out.length ? this.raw.findIndex((k) => k.t >= out[out.length - 1].t + span) : 0;
      for (let i = Math.max(0, startIdx); i < this.raw.length; i++) {
        const k = this.raw[i];
        const b = Math.floor(k.t / span) * span;
        const last = out[out.length - 1];
        if (last && last.t === b) {
          last.h = Math.max(last.h, k.h);
          last.l = Math.min(last.l, k.l);
          last.c = k.c;
        } else out.push({ t: b, o: k.o, h: k.h, l: k.l, c: k.c });
      }
      this.candles = out;
    }

    setQuote(bid, ask) {
      this.bid = bid;
      this.ask = ask;
      this.request();
    }

    setPositions(list) {
      if (this.drag) return; // do not disturb a drag in progress
      this.positions = list;
      this.request();
    }

    setAnalysis(a, show) {
      this.analysis = a;
      this.showCoach = show;
      this.request();
    }

    // ------------------------------------------------------------------ Geometry
    layout() {
      const pad = { l: 8, r: 76, t: 14, b: 24 };
      const c = this.candles.slice(-this.visible);
      if (!c.length) return null;
      const first = this.candles.length - c.length; // index of the first visible candle in this.candles
      // RSI pane below the main chart
      const rsiH = this.calc && this.calc.rsi ? Math.round(Math.min(130, Math.max(60, this.h * 0.2))) : 0;
      const bottom = this.h - pad.b - (rsiH ? rsiH + 10 : 0);
      let min = Math.min(...c.map((k) => k.l));
      let max = Math.max(...c.map((k) => k.h));
      // Keep Bollinger Bands and moving averages fully visible
      if (this.calc) {
        for (const arr of [this.calc.bb && this.calc.bb.up, this.calc.bb && this.calc.bb.dn, this.calc.ma20, this.calc.ma50]) {
          if (!arr) continue;
          for (let i = first; i < arr.length; i++) {
            if (arr[i] == null) continue;
            if (arr[i] < min) min = arr[i];
            if (arr[i] > max) max = arr[i];
          }
        }
      }
      // Include nearby position lines so they stay visible.
      for (const p of [...this.positions, ...this.orders.map((o) => ({ open: o.price, sl: o.sl, tp: o.tp }))]) {
        for (const v of [p.open, p.sl, p.tp]) {
          if (v == null) continue;
          const span = max - min;
          if (v > min - span && v < max + span) {
            min = Math.min(min, v);
            max = Math.max(max, v);
          }
        }
      }
      const span = max - min || max * 0.001 || 1;
      min -= span * 0.08;
      max += span * 0.08;
      const plotW = this.w - pad.l - pad.r;
      const step = plotW / this.visible;
      const offset = this.visible - c.length; // missing candles on the left
      return {
        pad, c, min, max, step, offset, first, bottom, rsiH,
        X: (i) => pad.l + (i + offset + 0.5) * step,
        Y: (v) => pad.t + (1 - (v - min) / (max - min)) * (bottom - pad.t),
        V: (y) => min + (1 - (y - pad.t) / (bottom - pad.t)) * (max - min),
        TX: (t) => {
          // x position of a timestamp (for analysis overlays)
          const first = c[0].t;
          const span2 = this.tf * MIN;
          return pad.l + ((t - first) / span2 + offset + 0.5) * step;
        },
      };
    }

    // ------------------------------------------------------------------ Dessin
    draw() {
      const { ctx, w, h, C } = this;
      ctx.clearRect(0, 0, w, h);
      const L = this.layout();
      if (!L) return;
      this.L = L;
      this.labels = [];
      const d = this.opts.digits;
      const { pad, c, X, Y } = L;
      const right = w - pad.r;

      // Grid and price scale
      ctx.font = `500 11px ${C.num}`;
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 1;
      const ticks = 6;
      ctx.beginPath();
      for (let i = 0; i <= ticks; i++) {
        const y = Math.round(pad.t + ((L.bottom - pad.t) * i) / ticks) + 0.5;
        ctx.moveTo(pad.l, y);
        ctx.lineTo(right, y);
      }
      ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.textAlign = 'left';
      for (let i = 0; i <= ticks; i++) {
        const y = pad.t + ((L.bottom - pad.t) * i) / ticks;
        ctx.fillText(fr(L.V(y), d), right + 8, y);
      }
      // Time labels
      ctx.textAlign = 'center';
      const every = Math.max(1, Math.round(90 / L.step / 5)) * 5;
      c.forEach((k, i) => {
        const dt = new Date(k.t);
        if ((dt.getMinutes() % (every * this.tf)) === 0 || i === 0) {
          const x = X(i);
          if (x > pad.l + 20 && x < right - 20) ctx.fillText(dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), x, h - 10);
        }
      });

      if (this.book) this.drawDepth(L);
      if (this.calc && this.calc.hasVol && this.ind.vol) this.drawVolume(L);
      if (this.ind.liq && this.analysis && this.analysis.liquidity) this.drawLiquidity(L);
      if (this.showCoach && this.analysis) this.drawCoach(L);
      this.drawOverlays(L);

      // Candles
      const bw = Math.max(1, L.step * 0.7);
      for (let i = 0; i < c.length; i++) {
        const k = c[i];
        const x = X(i);
        const up = k.c >= k.o;
        ctx.strokeStyle = up ? C.up : C.down;
        ctx.fillStyle = up ? C.up : C.down;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, Y(k.h));
        ctx.lineTo(Math.round(x) + 0.5, Y(k.l));
        ctx.stroke();
        const y1 = Y(Math.max(k.o, k.c));
        const y2 = Y(Math.min(k.o, k.c));
        ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
      }

      this.drawDrawings(L);
      this.flushLabels(L);

      // Positions (entry, SL, TP) and pending orders
      for (const p of this.positions) this.drawPosition(L, p);
      for (const o of this.orders) this.drawOrder(L, o);
      if (L.rsiH) this.drawRsi(L);

      // Current bid / ask
      if (this.bid != null) {
        this.hLine(Y(this.bid), C.down, [2, 3], fr(this.bid, d), C.down);
        if (this.ask != null) this.hLine(Y(this.ask), C.up, [2, 3], fr(this.ask, d), C.up, true);
      }

      // Crosshair
      if (this.hover && !this.drag) this.drawCrosshair(L);
    }

    // Moving averages and Bollinger Bands
    drawOverlays(L) {
      const k = this.calc;
      if (!k) return;
      const { ctx } = this;
      const line = (arr, color, width, dash) => {
        if (!arr) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(dash || []);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < L.c.length; i++) {
          const v = arr[L.first + i];
          if (v == null) continue;
          const x = L.X(i);
          const y = L.Y(v);
          if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
      };
      if (k.bb) {
        // Fill between the bands
        ctx.fillStyle = `rgba(${this.C.accentRgb},0.06)`;
        ctx.beginPath();
        const idx = [];
        for (let i = 0; i < L.c.length; i++) if (k.bb.up[L.first + i] != null) idx.push(i);
        idx.forEach((i, j) => (j ? ctx.lineTo(L.X(i), L.Y(k.bb.up[L.first + i])) : ctx.moveTo(L.X(i), L.Y(k.bb.up[L.first + i]))));
        for (let j = idx.length - 1; j >= 0; j--) ctx.lineTo(L.X(idx[j]), L.Y(k.bb.dn[L.first + idx[j]]));
        ctx.fill();
        line(k.bb.up, `rgba(${this.C.accentRgb},0.55)`, 1);
        line(k.bb.dn, `rgba(${this.C.accentRgb},0.55)`, 1);
        line(k.bb.mid, `rgba(${this.C.accentRgb},0.4)`, 1, [3, 3]);
      }
      line(k.ma20, '#f0a500', 1.8);
      line(k.ma50, '#b37feb', 1.8);
    }

    // Volume: subtle bars at the bottom of the main chart
    drawVolume(L) {
      const { ctx, C } = this;
      const vols = L.c.map((k) => k.v || 0);
      const maxV = Math.max(...vols);
      if (!maxV) return;
      const hMax = (L.bottom - L.pad.t) * 0.16;
      const bw = Math.max(1, L.step * 0.7);
      for (let i = 0; i < L.c.length; i++) {
        const k = L.c[i];
        const hh = (vols[i] / maxV) * hMax;
        ctx.fillStyle = k.c >= k.o ? `rgba(${C.greenRgb},0.22)` : `rgba(${C.redRgb},0.22)`;
        ctx.fillRect(L.X(i) - bw / 2, L.bottom - hh, bw, hh);
      }
    }

    // Order-book depth: horizontal histogram along the price scale
    drawDepth(L) {
      const { ctx, C } = this;
      const b = this.book;
      const right = this.w - L.pad.r;
      const rows = [...b.bids.map((r) => [...r, 'bid']), ...b.asks.map((r) => [...r, 'ask'])];
      const maxQ = Math.max(...rows.map((r) => r[1]));
      if (!maxQ) return;
      const maxW = Math.min(140, (right - L.pad.l) * 0.28);
      for (const [px, q, side] of rows) {
        const y0 = L.Y(side === 'bid' ? px + b.step : px);
        const y1 = L.Y(side === 'bid' ? px : px - b.step);
        const top = Math.min(y0, y1);
        const hh = Math.max(1, Math.abs(y1 - y0) - 1);
        if (top > L.bottom || top + hh < L.pad.t) continue;
        const wall = q >= b.wall;
        const ww = (q / maxQ) * maxW;
        ctx.fillStyle = side === 'bid' ? `rgba(${C.greenRgb},${wall ? 0.4 : 0.14})` : `rgba(${C.redRgb},${wall ? 0.4 : 0.14})`;
        ctx.fillRect(right - ww, top, ww, hh);
        if (wall && hh >= 9) {
          ctx.font = `700 10px ${C.num}`;
          ctx.fillStyle = side === 'bid' ? C.up : C.down;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(`wall ${fr(q, 1)} BTC`, right - ww - 4, top + hh / 2);
        }
      }
    }

    // Liquidity zones (stops clustered above highs / below lows)
    drawLiquidity(L) {
      const { ctx, C } = this;
      const right = this.w - L.pad.r;
      const band = (this.analysis.atr || 0) * 0.15; // in price units (the 4 px minimum height is handled below)
      for (const z of this.analysis.liquidity) {
        const x0 = Math.max(L.pad.l, L.TX(z.from));
        const y0 = L.Y(z.price + (z.side === 'above' ? band : 0));
        const y1 = L.Y(z.price - (z.side === 'above' ? 0 : band));
        if (y1 < L.pad.t || y0 > L.bottom) continue;
        const top = Math.max(L.pad.t, Math.min(y0, y1));
        const hh = Math.min(L.bottom - top, Math.max(4, Math.abs(y1 - y0)));
        ctx.fillStyle = 'rgba(56,189,248,0.13)';
        ctx.fillRect(x0, top, right - x0, hh);
        ctx.strokeStyle = 'rgba(56,189,248,0.7)';
        ctx.setLineDash([1, 3]);
        ctx.beginPath();
        const yl = Math.round(L.Y(z.price)) + 0.5;
        ctx.moveTo(x0, yl);
        ctx.lineTo(right, yl);
        ctx.stroke();
        ctx.setLineDash([]);
        this.queueLabel(yl, `Liquidity${z.count > 1 ? ` ×${z.count}` : ''} ${fr(z.price, this.opts.digits)}`, 'rgb(14,116,164)');
      }
    }

    // RSI pane
    drawRsi(L) {
      const { ctx, C } = this;
      const right = this.w - L.pad.r;
      const top = L.bottom + 10;
      const bot = this.h - L.pad.b;
      const Yr = (v) => top + (1 - v / 100) * (bot - top);
      ctx.strokeStyle = C.border;
      ctx.strokeRect(L.pad.l + 0.5, top + 0.5, right - L.pad.l, bot - top);
      ctx.fillStyle = `rgba(${C.redRgb},0.07)`;
      ctx.fillRect(L.pad.l, Yr(100), right - L.pad.l, Yr(70) - Yr(100));
      ctx.fillStyle = `rgba(${C.greenRgb},0.07)`;
      ctx.fillRect(L.pad.l, Yr(30), right - L.pad.l, Yr(0) - Yr(30));
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = C.muted;
      ctx.beginPath();
      for (const v of [70, 30]) {
        ctx.moveTo(L.pad.l, Math.round(Yr(v)) + 0.5);
        ctx.lineTo(right, Math.round(Yr(v)) + 0.5);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `500 10px ${C.num}`;
      ctx.fillStyle = C.muted;
      ctx.textAlign = 'left';
      ctx.fillText('70', right + 8, Yr(70));
      ctx.fillText('30', right + 8, Yr(30));
      const arr = this.calc.rsi;
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      let last = null;
      for (let i = 0; i < L.c.length; i++) {
        const v = arr[L.first + i];
        if (v == null) continue;
        last = v;
        if (started) ctx.lineTo(L.X(i), Yr(v)); else { ctx.moveTo(L.X(i), Yr(v)); started = true; }
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      if (last != null) {
        const col = last >= 70 ? C.down : last <= 30 ? C.up : C.accent;
        ctx.fillStyle = col;
        ctx.fillRect(right + 2, Yr(last) - 8, 40, 16);
        ctx.fillStyle = '#fff';
        ctx.font = `700 10px ${C.num}`;
        ctx.fillText(fr(last, 0), right + 7, Yr(last));
        ctx.fillStyle = C.muted;
        ctx.font = `600 10px ${C.font}`;
        ctx.fillText(`RSI 14${last >= 70 ? ' · overbought' : last <= 30 ? ' · oversold' : ''}`, L.pad.l + 6, top + 9);
      }
    }

    drawOrder(L, o) {
      const { ctx, C } = this;
      const d = this.opts.digits;
      const right = this.w - L.pad.r;
      const buy = o.side === 'buy';
      const price = this.drag && this.drag.id === o.id ? this.drag.price : o.price;
      const shift = price - o.price;
      const y = L.Y(price);
      const col = buy ? C.up : C.down;
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.9;
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(L.pad.l, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      // Attached SL / TP (more subtle)
      ctx.lineWidth = 1;
      ctx.setLineDash([1, 4]);
      for (const [v, c2] of [[o.sl, C.down], [o.tp, C.up]]) {
        if (v == null) continue;
        ctx.strokeStyle = c2;
        ctx.beginPath();
        ctx.moveTo(L.pad.l + 4, L.Y(v + shift));
        ctx.lineTo(right, L.Y(v + shift));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const label = `${buy ? 'BUY' : 'SELL'} ${o.kind === 'limit' ? 'LIMIT' : 'STOP'} ${fr(o.lots, 2)} @ ${fr(price, d)} ⇕`;
      ctx.font = `700 11px ${C.font}`;
      const tw = ctx.measureText(label).width + 12;
      ctx.fillStyle = C.surface;
      ctx.strokeStyle = col;
      ctx.beginPath();
      const x0 = right - 6 - tw; // on the right, like positions (the left edge is reserved for levels)
      ctx.roundRect ? ctx.roundRect(x0, y - 9, tw, 18, 4) : ctx.rect(x0, y - 9, tw, 18);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.fillText(label, x0 + 6, y);
    }

    hLine(y, color, dash, label, labelBg, above) {
      const { ctx, w } = this;
      const right = w - this.L.pad.r;
      ctx.strokeStyle = color;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      ctx.moveTo(this.L.pad.l, Math.round(y) + 0.5);
      ctx.lineTo(right, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      if (label) {
        ctx.font = `700 11px ${this.C.num}`;
        const tw = ctx.measureText(label).width + 10;
        const yy = above ? y - 9 : y + (dash ? 9 : 0);
        ctx.fillStyle = labelBg;
        ctx.fillRect(right + 2, yy - 9, Math.max(tw, 70), 18);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.fillText(label, right + 7, yy);
      }
    }

    tag(x, y, text, bg, fg = '#fff') {
      const { ctx } = this;
      ctx.font = `700 11px ${this.C.font}`;
      const tw = ctx.measureText(text).width + 12;
      if (this.L) x = Math.max(x, this.L.pad.l + tw); // never overflow on the left (small screens)
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x - tw, y - 9, tw, 18, 4) : ctx.rect(x - tw, y - 9, tw, 18);
      ctx.fill();
      ctx.fillStyle = fg;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x - tw + 6, y);
    }

    drawPosition(L, p) {
      const { ctx, C } = this;
      const d = this.opts.digits;
      const right = this.w - L.pad.r;
      const buy = p.side === 'buy';
      const y = L.Y(p.open);
      ctx.strokeStyle = buy ? C.up : C.down;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(L.pad.l, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      const pnl = p.pnl != null ? ` ${p.pnl >= 0 ? '+' : '−'}€${fr(Math.abs(p.pnl), 2)}` : '';
      this.tag(right - 6, y, `${buy ? 'BUY' : 'SELL'} ${fr(p.lots, 2)} ×${p.leverage}${pnl}`, buy ? C.up : C.down);
      for (const kind of ['sl', 'tp']) {
        const v = this.drag && this.drag.id === p.id && this.drag.kind === kind ? this.drag.price : p[kind];
        if (v == null) continue;
        const yy = L.Y(v);
        const col = kind === 'sl' ? C.down : C.up;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(L.pad.l, yy);
        ctx.lineTo(right, yy);
        ctx.stroke();
        ctx.lineWidth = 1;
        this.tag(this.w - L.pad.r - 6, yy, `${kind === 'sl' && p.trail ? 'TRAILING SL' : kind.toUpperCase()} ${fr(v, d)}${kind === 'sl' && p.trail ? '' : ' ⇕'}`, col);
      }
    }

    // Level labels: stacked on the left edge, above the candles, never overlapping.
    queueLabel(y, text, color) {
      if (!this.L || y < this.L.pad.t || y > this.L.bottom) return;
      (this.labels || (this.labels = [])).push({ y, text, color });
    }

    flushLabels(L) {
      const list = (this.labels || []).sort((a, b) => a.y - b.y);
      this.labels = [];
      if (!list.length) return;
      const { ctx } = this;
      const H = 17;
      // Push apart labels that are too close (downwards, then back up if they overflow)
      for (let i = 1; i < list.length; i++) list[i].ly = Math.max(list[i].y, (list[i - 1].ly ?? list[i - 1].y) + H + 2);
      list[0].ly = list[0].ly ?? list[0].y;
      const over = list[list.length - 1].ly + H / 2 - L.bottom;
      if (over > 0) for (const l of list) l.ly -= over;
      ctx.font = `700 10.5px ${this.C.font}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (const l of list) {
        const x = L.pad.l + 4;
        const tw = ctx.measureText(l.text).width + 12;
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = l.color;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x, l.ly - H / 2, tw, H, 4) : ctx.rect(x, l.ly - H / 2, tw, H);
        ctx.fill();
        ctx.globalAlpha = 1;
        // Small connector to the real level when the label was shifted
        if (Math.abs(l.ly - l.y) > 2) {
          ctx.strokeStyle = l.color;
          ctx.beginPath();
          ctx.moveTo(x + tw, l.ly);
          ctx.lineTo(x + tw + 10, l.y);
          ctx.stroke();
        }
        ctx.fillStyle = '#fff';
        ctx.fillText(l.text, x + 6, l.ly);
      }
    }

    drawCoach(L) {
      const { ctx, C } = this;
      const a = this.analysis;
      const right = this.w - L.pad.r;
      const d = this.opts.digits;
      // Range
      if (a.range) {
        const x0 = Math.max(L.pad.l, L.TX(a.range.from));
        const y0 = L.Y(a.range.top);
        const y1 = L.Y(a.range.bottom);
        ctx.fillStyle = `rgba(${C.accentRgb},0.08)`;
        ctx.fillRect(x0, y0, right - x0, y1 - y0);
        ctx.strokeStyle = `rgba(${C.accentRgb},0.45)`;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, right - x0, y1 - y0);
        ctx.setLineDash([]);
        this.queueLabel(y0, 'Range high', `rgba(${C.accentRgb},0.9)`);
        this.queueLabel(y1, 'Range low', `rgba(${C.accentRgb},0.9)`);
      }
      // Support / resistance
      for (const l of a.levels) {
        const y = L.Y(l.price);
        if (y < L.pad.t || y > L.bottom) continue;
        const col = l.type === 'resistance' ? C.down : C.up;
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.75;
        ctx.setLineDash([2, 5]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(L.pad.l, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        ctx.globalAlpha = 1;
        this.queueLabel(y, `${l.type === 'resistance' ? 'Resistance' : 'Support'} ${fr(l.price, d)} · ${l.touches}×`, col);
      }
      // Trend
      if (a.trend) {
        const x0 = L.TX(a.trend.t0);
        const x1 = L.TX(a.trend.t1);
        const slope = (a.trend.p1 - a.trend.p0) / (x1 - x0 || 1);
        const xe = right;
        ctx.strokeStyle = C.amber;
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 5]);
        ctx.beginPath();
        ctx.moveTo(x0, L.Y(a.trend.p0));
        ctx.lineTo(xe, L.Y(a.trend.p0 + slope * (xe - x0)));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
      }
      // Candle patterns
      ctx.font = `700 10px ${C.font}`;
      ctx.textAlign = 'center';
      for (const p of a.patterns) {
        const x = L.TX(p.t);
        if (x < L.pad.l || x > right) continue;
        const bull = p.bull === true;
        const bear = p.bull === false;
        const y = bear ? L.Y(p.price) - 14 : L.Y(p.price) + 14;
        ctx.fillStyle = bull ? C.up : bear ? C.down : C.amber;
        ctx.beginPath();
        if (bear) { ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y - 4); ctx.lineTo(x, y + 2); } else { ctx.moveTo(x - 4, y + 4); ctx.lineTo(x + 4, y + 4); ctx.lineTo(x, y - 2); }
        ctx.fill();
        // Pattern name: shown in the crosshair readout on hover, not on the chart.
      }
    }

    // ------------------------------------------------------------------ User drawings
    setDrawings(list) {
      this.drawings = Array.isArray(list) ? list.slice() : [];
      this.selected = -1;
      this.request();
    }

    setTool(tool) {
      this.tool = tool || null;
      this.draft = null;
      this.placing = false;
      this.canvas.style.cursor = 'crosshair';
      this.request();
    }

    deleteSelected() {
      if (this.selected < 0) return false;
      this.drawings.splice(this.selected, 1);
      this.selected = -1;
      this.changed();
      return true;
    }

    clearDrawings() {
      this.drawings = [];
      this.selected = -1;
      this.changed();
    }

    changed(created) {
      this.request();
      if (this.opts.onDrawings) this.opts.onDrawings(this.drawings.slice(), created || null);
    }

    commitDraft() {
      const d = this.draft;
      this.draft = null;
      this.placing = false;
      this.tool = null;
      if (this.opts.onTool) this.opts.onTool(null);
      if (!d) return;
      this.drawings.push(d);
      this.selected = this.drawings.length - 1;
      this.changed(d);
    }

    tAt(L, x) {
      return L.c[0].t + ((x - L.pad.l) / L.step - L.offset - 0.5) * this.tf * MIN;
    }

    // Market point under the pointer, snapped to the nearby candle's open / high / low / close.
    pointAt(L, x, y) {
      const i = Math.round((x - L.pad.l) / L.step - 0.5 - L.offset);
      const k = L.c[i];
      if (k) {
        let best = null;
        for (const v of [k.h, k.l, k.o, k.c]) {
          const dy = Math.abs(L.Y(v) - y);
          if (dy <= 10 && (!best || dy < best.dy)) best = { dy, v };
        }
        if (best) return { t: k.t, p: best.v };
      }
      return { t: this.tAt(L, x), p: L.V(y) };
    }

    shape(L, d) {
      const a = { x: L.TX(d.t1), y: L.Y(d.p1) };
      const b = d.type === 'h' ? null : { x: L.TX(d.t2), y: L.Y(d.p2) };
      return { a, b };
    }

    fibLevels(d) {
      return FIB.map((r) => ({ r, p: d.p2 - (d.p2 - d.p1) * r }));
    }

    drawDrawings(L) {
      const list = this.draft ? [...this.drawings, this.draft] : this.drawings;
      if (!list.length) return;
      const { ctx, C } = this;
      const right = this.w - L.pad.r;
      const dg = this.opts.digits;
      ctx.save();
      ctx.beginPath();
      ctx.rect(L.pad.l, L.pad.t, right - L.pad.l, L.bottom - L.pad.t);
      ctx.clip();
      list.forEach((d, i) => {
        const sel = i === this.selected || d === this.draft;
        const { a, b } = this.shape(L, d);
        ctx.strokeStyle = C.accent;
        ctx.fillStyle = C.accent;
        ctx.lineWidth = sel ? 2.5 : 1.8;
        ctx.beginPath();
        if (d.type === 'h') {
          ctx.moveTo(L.pad.l, Math.round(a.y) + 0.5);
          ctx.lineTo(right, Math.round(a.y) + 0.5);
          ctx.stroke();
        } else if (d.type === 't') {
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        } else if (d.type === 'r') {
          ctx.fillStyle = `rgba(${C.accentRgb},0.12)`;
          ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        } else if (d.type === 'f') {
          const x0 = Math.min(a.x, b.x);
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = `600 10px ${C.num}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          for (const lv of this.fibLevels(d)) {
            const y = Math.round(L.Y(lv.p)) + 0.5;
            const key = lv.r === 0.618 || lv.r === 0.5;
            ctx.strokeStyle = key ? C.amber : `rgba(${C.accentRgb},0.75)`;
            ctx.lineWidth = key ? 1.6 : 1;
            ctx.beginPath();
            ctx.moveTo(x0, y);
            ctx.lineTo(right, y);
            ctx.stroke();
            ctx.fillStyle = key ? C.amber : C.accent;
            ctx.fillText(`${fr(lv.r * 100, 1)} % · ${fr(lv.p, dg)}`, x0 + 4, y - 2);
          }
          ctx.textBaseline = 'middle';
        }
        if (sel) {
          ctx.fillStyle = C.surface;
          ctx.strokeStyle = C.accent;
          ctx.lineWidth = 2;
          for (const pt of d.type === 'h' ? [{ x: L.pad.l + 60, y: a.y }] : [a, b]) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
      });
      ctx.restore();
      ctx.lineWidth = 1;
      // Horizontal-line labels on the price scale
      for (const d of list) {
        if (d.type !== 'h') continue;
        const y = L.Y(d.p1);
        if (y < L.pad.t || y > L.bottom) continue;
        ctx.font = `700 11px ${C.num}`;
        ctx.fillStyle = C.accent;
        ctx.fillRect(right + 2, y - 9, 72, 18);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.fillText(fr(d.p1, dg), right + 7, y);
      }
    }

    // Drawing under the pointer: { i, handle } (handle = 0 or 1 for an end point, null for the body).
    hitDrawing(x, y) {
      const L = this.L;
      if (!L) return null;
      const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) <= 10;
      const segDist = (p, a, b) => {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const l2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
        return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
      };
      const pt = { x, y };
      for (let i = this.drawings.length - 1; i >= 0; i--) {
        const d = this.drawings[i];
        const { a, b } = this.shape(L, d);
        if (d.type === 'h') {
          if (Math.abs(y - a.y) <= 7) return { i, handle: null };
          continue;
        }
        if (near(pt, a)) return { i, handle: 0 };
        if (near(pt, b)) return { i, handle: 1 };
        if (d.type === 't' && segDist(pt, a, b) <= 7) return { i, handle: null };
        if (d.type === 'r' && x >= Math.min(a.x, b.x) - 4 && x <= Math.max(a.x, b.x) + 4 && y >= Math.min(a.y, b.y) - 4 && y <= Math.max(a.y, b.y) + 4) return { i, handle: null };
        if (d.type === 'f' && x >= Math.min(a.x, b.x) - 4 && (segDist(pt, a, b) <= 7 || this.fibLevels(d).some((lv) => Math.abs(L.Y(lv.p) - y) <= 5))) return { i, handle: null };
      }
      return null;
    }

    drawCrosshair(L) {
      const { ctx, C, hover } = this;
      const right = this.w - L.pad.r;
      const d = this.opts.digits;
      if (hover.x < L.pad.l || hover.x > right) return;
      ctx.strokeStyle = C.muted;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(hover.x, L.pad.t);
      ctx.lineTo(hover.x, this.h - L.pad.b);
      if (hover.y > L.bottom) {
        // Hovering the RSI pane: no price label.
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }
      ctx.moveTo(L.pad.l, hover.y);
      ctx.lineTo(right, hover.y);
      ctx.stroke();
      ctx.setLineDash([]);
      this.hLabel(hover.y, fr(L.V(hover.y), d));
      const i = Math.round((hover.x - L.pad.l) / L.step - 0.5 - L.offset);
      const k = L.c[i];
      if (k) {
        const t = new Date(k.t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const pat = this.showCoach && this.analysis && this.tf === 1 ? this.analysis.patterns.find((p) => p.t === k.t) : null;
        const txt = `${t}   O ${fr(k.o, d)}   H ${fr(k.h, d)}   L ${fr(k.l, d)}   C ${fr(k.c, d)}${pat ? `   ·  ${pat.name}` : ''}`;
        ctx.font = `600 12px ${C.num}`;
        ctx.textAlign = 'left';
        ctx.fillStyle = C.surface;
        ctx.fillRect(L.pad.l + 4, L.pad.t, ctx.measureText(txt).width + 12, 20);
        ctx.fillStyle = k.c >= k.o ? C.up : C.down;
        ctx.fillText(txt, L.pad.l + 10, L.pad.t + 10);
      }
    }

    hLabel(y, text) {
      const { ctx, C } = this;
      const right = this.w - this.L.pad.r;
      ctx.font = `700 11px ${C.num}`;
      ctx.fillStyle = C.strong;
      ctx.fillRect(right + 2, y - 9, 72, 18);
      ctx.fillStyle = C.surface;
      ctx.textAlign = 'left';
      ctx.fillText(text, right + 7, y);
    }

    // ------------------------------------------------------------------ Interactions
    hitLine(y) {
      if (!this.L) return null;
      const tol = this.touch ? 14 : 7; // a finger is less precise than a mouse
      for (const o of this.orders) {
        if (Math.abs(this.L.Y(o.price) - y) <= tol) return { id: o.id, kind: 'order', side: o.side, price: o.price };
      }
      for (const p of this.positions) {
        for (const kind of ['sl', 'tp']) {
          if (kind === 'sl' && p.trail) continue;
          if (p[kind] != null && Math.abs(this.L.Y(p[kind]) - y) <= tol) return { id: p.id, kind, side: p.side, price: p[kind] };
        }
      }
      return null;
    }

    bind() {
      const cv = this.canvas;
      const pos = (e) => {
        const r = cv.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };
      const busyAt = (p) => this.pick || this.tool || this.placing || this.hitLine(p.y) || this.hitDrawing(p.x, p.y);
      cv.addEventListener('pointermove', (e) => {
        const p = pos(e);
        this.hover = p;
        const L = this.L;
        if (this.drag) {
          this.drag.price = Number(L.V(p.y).toFixed(this.opts.digits));
        } else if (this.draft && L) {
          const q = this.pointAt(L, p.x, p.y);
          if (this.draft.type !== 'h') {
            this.draft.t2 = q.t;
            this.draft.p2 = q.p;
          }
        } else if (this.edit && L) {
          const d = this.drawings[this.edit.i];
          const o = this.edit.orig;
          if (this.edit.handle === null) {
            const dt = this.tAt(L, p.x) - this.tAt(L, this.edit.x0);
            const dp = L.V(p.y) - L.V(this.edit.y0);
            d.p1 = o.p1 + dp;
            if (d.type !== 'h') {
              d.t1 = o.t1 + dt;
              d.t2 = o.t2 + dt;
              d.p2 = o.p2 + dp;
            }
          } else {
            const q = this.pointAt(L, p.x, p.y);
            d[`t${this.edit.handle + 1}`] = q.t;
            d[`p${this.edit.handle + 1}`] = q.p;
          }
          this.edit.moved = true;
        } else if (this.pick) {
          cv.style.cursor = 'copy';
        } else if (!this.tool) {
          const hd = this.hitDrawing(p.x, p.y);
          cv.style.cursor = this.hitLine(p.y) ? 'ns-resize' : hd ? (hd.handle === null ? 'move' : 'pointer') : 'crosshair';
        }
        this.request();
      });
      cv.addEventListener('pointerleave', () => {
        if (!this.drag && !this.edit) {
          this.hover = null;
          this.request();
        }
      });
      cv.addEventListener('pointerdown', (e) => {
        const p = pos(e);
        const L = this.L;
        if (!L) return;
        this.touch = e.pointerType === 'touch';
        this.hover = p;
        if (this.pick && p.y <= L.bottom) {
          const cb = this.pick;
          this.pickPrice(null);
          this.skipUp = true;
          e.preventDefault();
          cb(Number(L.V(p.y).toFixed(this.opts.digits)));
          return;
        }
        // Second click of a two-click drawing
        if (this.placing) {
          this.placing = false;
          this.commitDraft();
          this.skipUp = true;
          e.preventDefault();
          return;
        }
        if (this.tool) {
          const q = this.pointAt(L, p.x, p.y);
          this.draft = { type: this.tool, t1: q.t, p1: q.p, t2: q.t, p2: q.p };
          if (this.tool === 'h') {
            this.commitDraft();
            this.skipUp = true;
          } else {
            this.creating = { x: p.x, y: p.y };
            cv.setPointerCapture(e.pointerId);
          }
          e.preventDefault();
          this.request();
          return;
        }
        const hit = this.hitLine(p.y);
        if (hit) {
          this.drag = hit;
          cv.setPointerCapture(e.pointerId);
          e.preventDefault();
          return;
        }
        const hd = this.hitDrawing(p.x, p.y);
        if (hd) {
          this.selected = hd.i;
          this.edit = { ...hd, x0: p.x, y0: p.y, orig: { ...this.drawings[hd.i] } };
          cv.setPointerCapture(e.pointerId);
          e.preventDefault();
        } else if (this.selected >= 0) {
          this.selected = -1;
        }
        this.request();
      });
      const up = (e) => {
        if (e.pointerType === 'touch') this.hover = null;
        if (cv.hasPointerCapture && cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
        if (this.skipUp) {
          this.skipUp = false;
        } else if (this.drag) {
          const dr = this.drag;
          this.drag = null;
          this.opts.onDrag(dr.id, dr.kind, dr.price);
        } else if (this.creating) {
          const c = this.creating;
          this.creating = null;
          // Single click: finish the drawing on the next click (handy with a mouse).
          if (Math.hypot(e.clientX - cv.getBoundingClientRect().left - c.x, e.clientY - cv.getBoundingClientRect().top - c.y) < 6) this.placing = true;
          else this.commitDraft();
        } else if (this.edit) {
          const moved = this.edit.moved;
          this.edit = null;
          if (moved) this.changed();
        }
        this.request();
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('dblclick', (e) => {
        const p = pos(e);
        const hd = this.hitDrawing(p.x, p.y);
        if (hd) {
          this.selected = hd.i;
          this.deleteSelected();
        }
      });
      // On phones, a finger scrolls the page unless it grabs a line or is drawing.
      cv.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        const r = cv.getBoundingClientRect();
        if (t && busyAt({ x: t.clientX - r.left, y: t.clientY - r.top })) e.preventDefault();
      }, { passive: false });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.visible = Math.max(30, Math.min(240, Math.round(this.visible * (e.deltaY > 0 ? 1.15 : 0.87))));
        this.request();
      }, { passive: false });
    }
  }

  window.TradeChart = TradeChart;
})();
