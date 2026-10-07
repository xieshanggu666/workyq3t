"use strict";

function logReturns(equity) {
  const r = [];
  for (let i = 1; i < equity.length; i++) {
    if (equity[i - 1] > 0 && equity[i] > 0) r.push(Math.log(equity[i] / equity[i - 1]));
  }
  return r;
}

function avg(a) {
  if (!a.length) return 0;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

function std(a) {
  if (a.length < 2) return 0;
  const m = avg(a);
  const v = a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
  return Math.sqrt(Math.max(0, v));
}

function maxDrawdown(equity) {
  let peak = equity[0];
  let maxDD = 0;
  let peakIdx = 0;
  let start = 0;
  let end = 0;
  for (let i = 1; i < equity.length; i++) {
    if (equity[i] > peak) {
      peak = equity[i];
      peakIdx = i;
    }
    const dd = equity[i] / peak - 1;
    if (dd < maxDD) {
      maxDD = dd;
      start = peakIdx;
      end = i;
    }
  }
  return { maxDD, start, end };
}

function summarize(equity, opts) {
  const o = opts || {};
  const ppy = o.periodsPerYear || 252;
  const riskFree = o.riskFree == null ? 0.02 : o.riskFree;
  const n = equity.length;
  const initial = equity[0];
  const final = equity[n - 1];
  const years = (n - 1) / ppy;
  const totalReturn = final / initial - 1;
  const cagr = years > 0 ? Math.pow(final / initial, 1 / years) - 1 : 0;
  const rets = logReturns(equity);
  const sd = std(rets);
  const annVol = sd * Math.sqrt(ppy);
  const sharpe = annVol > 0 ? (cagr - riskFree) / annVol : 0;
  const down = rets.filter(r => r < 0);
  const downStd = Math.sqrt(avg(down.map(r => r * r)));
  const sortino = downStd > 0 ? (cagr - riskFree) / (downStd * Math.sqrt(ppy)) : 0;
  const dd = maxDrawdown(equity);
  const calmar = dd.maxDD < 0 ? cagr / Math.abs(dd.maxDD) : 0;

  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  for (const r of rets) {
    if (r > 0) { wins++; grossWin += r; } else if (r < 0) grossLoss += -r;
  }
  const winRate = rets.length ? wins / rets.length : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  return {
    total_return: totalReturn,
    cagr,
    ann_vol: annVol,
    sharpe,
    sortino,
    max_drawdown: dd.maxDD,
    dd_start: dd.start,
    dd_end: dd.end,
    calmar,
    win_rate: winRate,
    profit_factor: profitFactor,
    bars: n,
  };
}

module.exports = { summarize, maxDrawdown, logReturns };
