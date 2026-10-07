"use strict";

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function generateMarket(opts) {
  const days = Math.max(60, Math.min(2000, opts.days || 500));
  const start = opts.start || 100;
  const seed = opts.seed == null ? 42 : opts.seed;
  const drift = opts.drift == null ? 0.0004 : opts.drift;
  const vol = opts.vol == null ? 0.012 : opts.vol;
  const rand = rng(seed);
  const dates = [];
  const rows = [];
  let d = new Date(2023, 0, 2);
  let price = start;
  let regime = 0;
  for (let i = 0; i < days; i++) {
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (rand() < 0.02) regime = rand() < 0.5 ? 0 : 1;
    const v = vol * (regime === 1 ? 2.4 : 1) * (0.6 + rand() * 0.8);
    const r = drift + (rand() - 0.5) * 2 * v;
    const open = price;
    const close = open * (1 + r);
    const hi = Math.max(open, close) * (1 + rand() * v * 0.5);
    const lo = Math.min(open, close) * (1 - rand() * v * 0.5);
    const volume = Math.round((2000 + rand() * 8000) * (1 + Math.abs(r) / Math.max(v, 1e-9) * 0.4));
    rows.push({ date: iso, open: round4(open), high: round4(hi), low: round4(lo), close: round4(close), volume });
    dates.push(iso);
    price = close;
    d.setDate(d.getDate() + 1);
  }
  return { dates, rows };
}

function adjustForward(rows, splitIdx, ratio) {
  const factor = 1 + ratio;
  return rows.map((r, i) => {
    if (i >= splitIdx) return { ...r };
    return {
      ...r,
      open: round4(r.open / factor),
      high: round4(r.high / factor),
      low: round4(r.low / factor),
      close: round4(r.close / factor),
    };
  });
}

module.exports = { generateMarket, adjustForward, rng };
