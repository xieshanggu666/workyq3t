"use strict";
const { rng } = require("./market");

function simulate(equity, nPaths, nSteps, seed) {
  const paths = Math.max(20, Math.min(2000, nPaths || 200));
  const steps = Math.max(10, Math.min(2000, nSteps || 252));
  const rand = rng(seed == null ? 7 : seed);
  const rets = [];
  for (let i = 1; i < equity.length; i++) {
    if (equity[i - 1] > 0 && equity[i] > 0) rets.push(Math.log(equity[i] / equity[i - 1]));
  }
  if (!rets.length) return { quantiles: null, prob_loss: null, paths: [] };
  const start = equity[0];
  const all = [];
  for (let p = 0; p < paths; p++) {
    const path = new Array(steps + 1);
    path[0] = start;
    for (let s = 1; s <= steps; s++) {
      const r = rets[Math.floor(rand() * rets.length)];
      path[s] = path[s - 1] * Math.exp(r);
    }
    all.push(path);
  }
  const quantiles = { p5: new Array(steps + 1), p50: new Array(steps + 1), p95: new Array(steps + 1) };
  for (let s = 0; s <= steps; s++) {
    const col = all.map(p => p[s]).sort((a, b) => a - b);
    const idx5 = Math.min(col.length - 1, Math.max(0, Math.floor(col.length * 0.05)));
    const idx50 = Math.min(col.length - 1, Math.max(0, Math.floor(col.length * 0.5)));
    const idx95 = Math.min(col.length - 1, Math.max(0, Math.floor(col.length * 0.95)));
    quantiles.p5[s] = col[idx5];
    quantiles.p50[s] = col[idx50];
    quantiles.p95[s] = col[idx95];
  }
  const finals = all.map(p => p[steps]);
  const probLoss = finals.filter(f => f < start).length / finals.length;
  return {
    quantiles,
    prob_loss: probLoss,
    paths: all.slice(0, 12),
    start,
    steps,
  };
}

module.exports = { simulate };
