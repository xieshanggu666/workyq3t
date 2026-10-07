const Charts = {
  _fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    return { ctx, w: r.width, h: r.height };
  },

  kline(canvas, rows, overlays) {
    const { ctx, w, h } = this._fit(canvas);
    if (!rows || !rows.length) return;
    const pad = { l: 46, r: 8, t: 8, b: 18 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const n = rows.length;
    const lo = Math.min(...rows.map(r => r.low));
    const hi = Math.max(...rows.map(r => r.high));
    const range = hi - lo || 1;
    const x = i => pad.l + (i + 0.5) * (pw / n);
    const y = v => pad.t + (1 - (v - lo) / range) * ph;
    const cw = Math.max(1, pw / n * 0.7);

    ctx.strokeStyle = "#26324a"; ctx.fillStyle = "#1a2233"; ctx.strokeRect(pad.l, pad.t, pw, ph);
    for (let g = 0; g <= 4; g++) {
      const gy = pad.t + g * ph / 4;
      ctx.strokeStyle = "#1a2233"; ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(w - pad.r, gy); ctx.stroke();
      ctx.fillStyle = "#66748c"; ctx.font = "10px monospace";
      const val = hi - g * range / 4;
      ctx.fillText(val.toFixed(2), 4, gy + 3);
    }
    rows.forEach((r, i) => {
      const up = r.close >= r.open;
      ctx.strokeStyle = up ? "#e2533e" : "#34a853";
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.moveTo(x(i), y(r.high)); ctx.lineTo(x(i), y(r.low)); ctx.stroke();
      const bodyTop = y(Math.max(r.open, r.close));
      const bodyH = Math.max(1, Math.abs(y(r.open) - y(r.close)));
      ctx.fillRect(x(i) - cw / 2, bodyTop, cw, bodyH);
    });
    if (overlays) {
      for (const ov of overlays) {
        ctx.strokeStyle = ov.color; ctx.lineWidth = 1.2;
        ctx.beginPath();
        let started = false;
        ov.data.forEach((v, i) => {
          if (v == null) { started = false; return; }
          const px = x(i), py = y(v);
          if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        });
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    const step = Math.max(1, Math.floor(n / 8));
    for (let i = 0; i < n; i += step) {
      ctx.fillStyle = "#66748c"; ctx.font = "10px monospace";
      ctx.fillText(rows[i].date.slice(5), x(i) - 14, h - 5);
    }
  },

  series(canvas, data, opts) {
    const { ctx, w, h } = this._fit(canvas);
    if (!data || !data.length) return;
    const o = opts || {};
    const pad = { l: 46, r: 8, t: 8, b: 18 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const ys = data.map(d => (Array.isArray(d) ? d[1] : d));
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    const padR = (hi - lo) * 0.08 || 1;
    lo -= padR; hi += padR;
    const range = hi - lo || 1;
    const x = i => pad.l + (data.length === 1 ? pw / 2 : i * (pw / (data.length - 1)));
    const y = v => pad.t + (1 - (v - lo) / range) * ph;
    ctx.strokeStyle = "#26324a"; ctx.strokeRect(pad.l, pad.t, pw, ph);
    ctx.strokeStyle = o.color || "#4f8cff"; ctx.lineWidth = 1.6;
    ctx.beginPath();
    data.forEach((d, i) => {
      const px = x(i), py = y(d[1]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    if (o.baseline != null) {
      ctx.strokeStyle = "#5a6780"; ctx.setLineDash([4, 4]);
      const by = y(o.baseline);
      ctx.beginPath(); ctx.moveTo(pad.l, by); ctx.lineTo(w - pad.r, by); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "#66748c"; ctx.font = "10px monospace";
    ctx.fillText((hi - padR).toFixed(0), 4, pad.t + 10);
    ctx.fillText((lo + padR).toFixed(0), 4, h - pad.b - 4);
  },

  band(canvas, bands, opts) {
    const { ctx, w, h } = this._fit(canvas);
    const o = opts || {};
    const keys = o.keys || ["p95", "p50", "p5"];
    if (!bands || !bands.p50 || !bands.p50.length) return;
    const pad = { l: 46, r: 8, t: 8, b: 18 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const all = keys.flatMap(k => bands[k].map(d => d[1]));
    let lo = Math.min(...all), hi = Math.max(...all);
    const padR = (hi - lo) * 0.06 || 1;
    lo -= padR; hi += padR;
    const range = hi - lo || 1;
    const n = bands.p50.length;
    const x = i => pad.l + (n === 1 ? pw / 2 : i * (pw / (n - 1)));
    const y = v => pad.t + (1 - (v - lo) / range) * ph;
    const colors = { p95: "#2b3d63", p50: "#7a5cff", p5: "#2b3d63" };
    const fillPts = (k) => bands[k].map((d, i) => [x(i), y(d[1])]);
    ctx.fillStyle = "rgba(79,140,255,0.15)";
    const hiLine = fillPts("p95"), loLine = fillPts("p5");
    ctx.beginPath();
    hiLine.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
    for (let i = loLine.length - 1; i >= 0; i--) ctx.lineTo(loLine[i][0], loLine[i][1]);
    ctx.closePath(); ctx.fill();
    for (const k of keys) {
      ctx.strokeStyle = colors[k]; ctx.lineWidth = k === "p50" ? 2 : 1;
      ctx.beginPath();
      bands[k].forEach((d, i) => {
        const px = x(i), py = y(d[1]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
    ctx.strokeStyle = "#26324a"; ctx.strokeRect(pad.l, pad.t, pw, ph);
  },
};
