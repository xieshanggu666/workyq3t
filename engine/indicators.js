"use strict";

function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, n) {
  const out = new Array(values.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    if (i < n) {
      gain += g;
      loss += l;
      if (i === n - 1) {
        gain /= n;
        loss /= n;
        out[i] = rsiVal(gain, loss);
      }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = rsiVal(gain, loss);
    }
  }
  return out;
}

function rsiVal(gain, loss) {
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line = values.map((_, i) => ef[i] - es[i]);
  const k = 2 / (signal + 1);
  const sig = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    prev = prev == null ? line[i] : line[i] * k + prev * (1 - k);
    sig[i] = prev;
  }
  const hist = values.map((_, i) => line[i] - sig[i]);
  return { line, signal: sig, hist };
}

function bollinger(values, n = 20, k = 2) {
  const mid = sma(values, n);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (mid[i] == null) continue;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (values[j] - mid[i]) * (values[j] - mid[i]);
    const sd = Math.sqrt(s / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

function atr(rows, n = 14) {
  const out = new Array(rows.length).fill(null);
  const trs = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (i === 0) trs[i] = r.high - r.low;
    else trs[i] = Math.max(r.high - r.low, Math.abs(r.high - rows[i - 1].close), Math.abs(r.low - rows[i - 1].close));
  }
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < n - 1) {
      sum += trs[i];
    } else if (i === n - 1) {
      sum += trs[i];
      out[i] = sum / n;
    } else {
      out[i] = (out[i - 1] * (n - 1) + trs[i]) / n;
    }
  }
  return out;
}

module.exports = { sma, ema, rsi, macd, bollinger, atr };
