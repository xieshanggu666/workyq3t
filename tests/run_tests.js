"use strict";
const assert = require("assert");
const market = require("../engine/market");
const ind = require("../engine/indicators");
const bt = require("../engine/backtest");
const metrics = require("../engine/metrics");
const mc = require("../engine/montecarlo");

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok  -", name);
  } catch (e) {
    failed++;
    console.log("FAIL -", name, "::", e.message);
  }
}

t("sma 手算正确", () => {
  const v = [1, 2, 3, 4, 5];
  const s = ind.sma(v, 3);
  assert.strictEqual(s[2], 2);
  assert.strictEqual(s[3], 3);
  assert.strictEqual(s[4], 4);
  assert.strictEqual(s[1], null);
});

t("ema 首值等于输入首值", () => {
  const e = ind.ema([10, 20, 30], 3);
  assert.strictEqual(e[0], 10);
  assert(e[2] > 20 && e[2] < 30);
});

t("rsi 单调上涨接近 100", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const r = ind.rsi(up, 14);
  assert(r[29] > 99);
});

t("rsi 单调下跌接近 0", () => {
  const dn = Array.from({ length: 30 }, (_, i) => 200 - i);
  const r = ind.rsi(dn, 14);
  assert(r[29] < 1);
});

t("macd 信号线为 line 的平滑", () => {
  const v = [10, 11, 12, 11, 13, 14, 13, 15, 16, 17, 16, 18, 19, 20, 21];
  const m = ind.macd(v, 3, 6, 4);
  assert.strictEqual(m.line.length, v.length);
  assert.strictEqual(m.signal.length, v.length);
  assert(m.signal[14] != null);
});

t("bollinger 上下轨对称", () => {
  const v = Array.from({ length: 30 }, (_, i) => 100 + (i % 5));
  const b = ind.bollinger(v, 10, 2);
  for (let i = 9; i < 30; i++) {
    assert(b.upper[i] > b.mid[i]);
    assert(b.lower[i] < b.mid[i]);
    assert(Math.abs((b.upper[i] - b.mid[i]) - (b.mid[i] - b.lower[i])) < 1e-9);
  }
});

t("atr 正值且首 n-1 为 null", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ high: 100 + i, low: 95 + i, close: 98 + i }));
  const a = ind.atr(rows, 14);
  assert.strictEqual(a[12], null);
  assert(a[13] > 0);
  for (let i = 14; i < 20; i++) assert(a[i] > 0);
});

t("行情生成确定性（同种子同结果）", () => {
  const a = market.generateMarket({ seed: 7, days: 100 });
  const b = market.generateMarket({ seed: 7, days: 100 });
  assert.deepStrictEqual(a.rows, b.rows);
  assert.strictEqual(a.dates.length, 100);
});

t("行情价格恒正且高低有序", () => {
  const m = market.generateMarket({ seed: 3, days: 300, vol: 0.03 });
  for (const r of m.rows) {
    assert(r.high >= Math.max(r.open, r.close));
    assert(r.low <= Math.min(r.open, r.close));
    assert(r.open > 0 && r.close > 0);
  }
});

t("前复权缩放历史价格", () => {
  const m = market.generateMarket({ seed: 1, days: 100 });
  const adj = market.adjustForward(m.rows, 50, 0.5);
  assert(Math.abs(adj[49].close * 1.5 - m.rows[49].close) < 1e-9);
  assert.strictEqual(adj[50].close, m.rows[50].close);
});

t("信号延迟一日于开盘成交", () => {
  const rows = [
    { date: "2023-01-01", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "2023-01-02", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "2023-01-03", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "2023-01-04", open: 50, high: 55, low: 48, close: 52, volume: 1 },
    { date: "2023-01-05", open: 52, high: 56, low: 50, close: 54, volume: 1 },
    { date: "2023-01-06", open: 54, high: 58, low: 52, close: 56, volume: 1 },
  ];
  const signal = [0, 0, 1, 1, 0, 0];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].entry_price, 50);
  assert.strictEqual(r.trades[0].entry_idx, 3);
  assert.strictEqual(r.trades[0].exit_price, 54);
  assert.strictEqual(r.trades[0].exit_idx, 5);
});

t("止损触发价处理跳空", () => {
  const rows = [
    { date: "d1", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d2", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d3", open: 100, high: 101, low: 85, close: 90, volume: 1 },
    { date: "d4", open: 85, high: 90, low: 80, close: 86, volume: 1 },
  ];
  const signal = [0, 1, 1, 0];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, stopLoss: 0.1, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].reason, "止损");
  assert.strictEqual(r.trades[0].entry_price, 100);
  assert.strictEqual(r.trades[0].exit_price, 85);
});

t("止损无跳空时按止损价成交", () => {
  const rows = [
    { date: "d1", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d2", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d3", open: 100, high: 101, low: 85, close: 90, volume: 1 },
    { date: "d4", open: 95, high: 96, low: 85, close: 90, volume: 1 },
  ];
  const signal = [0, 1, 1, 0];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, stopLoss: 0.1, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].exit_price, 90);
  assert.strictEqual(r.trades[0].reason, "止损");
});

t("止损平仓当日不再重新开仓", () => {
  const rows = [
    { date: "d1", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d2", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d3", open: 100, high: 101, low: 85, close: 90, volume: 1 },
    { date: "d4", open: 95, high: 96, low: 85, close: 90, volume: 1 },
    { date: "d5", open: 90, high: 92, low: 88, close: 91, volume: 1 },
  ];
  const signal = [0, 1, 1, 1, 0];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, stopLoss: 0.1, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
});

t("手续费与滑点计入成本", () => {
  const rows = [
    { date: "d1", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "d2", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "d3", open: 10, high: 11, low: 9, close: 10, volume: 1 },
  ];
  const signal = [0, 1, 0];
  const r0 = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, strategy: {} }, signal);
  const r1 = bt.backtest({ rows }, { cash: 10000, feeRate: 0.01, slippageBp: 100, strategy: {} }, signal);
  assert(r1.final_equity < r0.final_equity);
});

t("买入持有权益随收盘价变化", () => {
  const rows = [
    { date: "d1", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d2", open: 100, high: 110, low: 99, close: 110, volume: 1 },
  ];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, strategy: { type: "buy_hold" } });
  assert.strictEqual(r.final_equity, 11000);
});

t("最大回撤计算正确", () => {
  const eq = [100, 120, 110, 130, 90];
  const dd = metrics.maxDrawdown(eq);
  assert(Math.abs(dd.maxDD - (90 / 130 - 1)) < 1e-9);
  assert.strictEqual(dd.start, 3);
  assert.strictEqual(dd.end, 4);
});

t("指标汇总总收益与年化", () => {
  const eq = [100, 100, 100, 121];
  const s = metrics.summarize(eq, { periodsPerYear: 3 });
  assert(Math.abs(s.total_return - 0.21) < 1e-9);
  assert(Math.abs(s.cagr - Math.pow(1.21, 1) + 1) < 1e-9);
});

t("夏普在有波动时有限", () => {
  const eq = [100, 102, 101, 104, 103, 106];
  const s = metrics.summarize(eq, { periodsPerYear: 252, riskFree: 0 });
  assert(Number.isFinite(s.sharpe));
});

t("蒙特卡洛分位数单调", () => {
  const eq = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
  const r = mc.simulate(eq, 500, 50, 11);
  assert.strictEqual(r.quantiles.p5.length, 51);
  for (let i = 0; i <= 50; i++) {
    assert(r.quantiles.p5[i] <= r.quantiles.p50[i] + 1e-9);
    assert(r.quantiles.p50[i] <= r.quantiles.p95[i] + 1e-9);
  }
  assert(r.prob_loss >= 0 && r.prob_loss <= 1);
});

t("蒙特卡洛确定性", () => {
  const eq = [100, 101, 102, 103, 104];
  const a = mc.simulate(eq, 50, 20, 5);
  const b = mc.simulate(eq, 50, 20, 5);
  assert.deepStrictEqual(a.quantiles, b.quantiles);
});

t("均线金叉策略生成非零信号", () => {
  const m = market.generateMarket({ seed: 9, days: 400 });
  const sig = bt.buildSignal(m.rows, { type: "ma_cross", fast: 10, slow: 30 });
  assert(sig.some(v => v === 1));
  assert(sig.some(v => v === 0));
});

t("回测总体运行无异常", () => {
  const m = market.generateMarket({ seed: 21, days: 600 });
  const r = bt.backtest(m, {
    cash: 100000, feeRate: 0.0005, slippageBp: 5, stopLoss: 0.05, takeProfit: 0.2,
    strategy: { type: "boll", bbN: 20, bbK: 2 },
  });
  assert.strictEqual(r.equity.length, 600);
  assert(Number.isFinite(r.final_equity));
  const s = metrics.summarize(r.equity, {});
  assert(Number.isFinite(s.sharpe));
});

t("旧参数（固定止损止盈）结果逐位复现", () => {
  const m = market.generateMarket({ seed: 21, days: 600 });
  const r = bt.backtest(m, {
    cash: 100000, feeRate: 0.0005, slippageBp: 5, stopLoss: 0.05, takeProfit: 0.2,
    strategy: { type: "boll", bbN: 20, bbK: 2 },
  });
  assert.strictEqual(r.trades.length, 9);
  assert.strictEqual(r.final_equity, 117293.21490464684);
  assert.strictEqual(r.equity[300], 118780.39399849842);
  // 固定模式同样输出统一字段，历史解释一致
  const t0 = r.trades[0];
  assert.strictEqual(t0.stop_mode, "fixed");
  assert.strictEqual(t0.atr_ref, null);
  assert.strictEqual(t0.reason, "止损");
  assert(Math.abs(t0.stop_price - t0.entry_price * 0.95) < 1e-9);
});

t("ATR 模式按入场前 ATR 计算触发价", () => {
  // TR 恒为 2，ATR=2；i=19 以 open=119 入场，refIdx=18
  const rows = Array.from({ length: 20 }, (_, i) => ({ date: "d" + i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
  rows.push({ date: "d20", open: 119, high: 120, low: 114, close: 115, volume: 1 });
  const signal = new Array(20).fill(0).concat([1]);
  signal[18] = 1;
  const r = bt.backtest({ rows }, { cash: 100000, feeRate: 0, slippageBp: 0, stopMode: "atr", atrStopMult: 2, atrTargetMult: 4, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].reason, "止损");
  assert.strictEqual(r.trades[0].stop_mode, "atr");
  assert.strictEqual(r.trades[0].atr_ref, 2);
  assert.strictEqual(r.trades[0].stop_price, 115);
  assert.strictEqual(r.trades[0].exit_price, 115);
});

t("ATR 模式跳空越过止损按开盘价成交", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ date: "d" + i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
  rows.push({ date: "d20", open: 110, high: 111, low: 109, close: 110, volume: 1 }); // 开盘 110 < 止损 115
  const signal = new Array(20).fill(0).concat([1]);
  signal[18] = 1;
  const r = bt.backtest({ rows }, { cash: 100000, feeRate: 0, slippageBp: 0, stopMode: "atr", atrStopMult: 2, strategy: {} }, signal);
  assert.strictEqual(r.trades[0].reason, "止损");
  assert.strictEqual(r.trades[0].exit_price, 110);
});

t("高波动状态放宽止损止盈距离", () => {
  const atrArr = Array.from({ length: 40 }, () => 1).concat(Array.from({ length: 10 }, () => 1.5));
  const volArr = bt.volStateSeries(atrArr, 50, 0.7, 1.3);
  assert.strictEqual(volArr[49].state, "高波动");
  const s = bt.resolveStops({
    mode: "atr", entryPrice: 100, refIdx: 49, atrArr, volArr,
    stopLoss: 0, takeProfit: 0, atrStopMult: 2, atrTargetMult: 4, lowMult: 0.8, highMult: 1.5,
  });
  assert.strictEqual(s.volMult, 1.5);
  assert.strictEqual(s.stopPrice, 95.5);   // 100 - 1.5*2*1.5
  assert.strictEqual(s.targetPrice, 109);    // 100 + 1.5*4*1.5
});

t("ATR 预热期数据不足时回退固定比例", () => {
  const atrArr = new Array(50).fill(null);
  const volArr = bt.volStateSeries(atrArr, 50, 0.7, 1.3);
  const s = bt.resolveStops({
    mode: "atr", entryPrice: 100, refIdx: 5, atrArr, volArr,
    stopLoss: 0.05, takeProfit: 0.2, atrStopMult: 2, atrTargetMult: 4, lowMult: 0.8, highMult: 1.5,
  });
  assert.strictEqual(s.atrRef, null);
  assert.strictEqual(s.stopPrice, 95);
  assert.strictEqual(s.targetPrice, 120);
});

t("ATR 模式不使用未来数据（截断行情结果一致）", () => {
  const m = market.generateMarket({ seed: 5, days: 500 });
  const opts = { cash: 100000, feeRate: 0.0005, slippageBp: 5, stopMode: "atr", strategy: { type: "ma_cross", fast: 10, slow: 30 } };
  const full = bt.backtest(m, opts);
  const cut = { rows: m.rows.slice(0, 200) };
  const r2 = bt.backtest(cut, opts);
  for (let i = 0; i < 200; i++) assert.strictEqual(r2.equity[i], full.equity[i]);
  // 所有 ATR 交易引用的 ATR 都来自入场之前
  for (const tr of full.trades) {
    if (tr.stop_mode !== "atr" || tr.atr_ref == null) continue;
    assert(tr.entry_idx >= 1);
  }
});

t("ATR 模式全链路回测与风险指标正常", () => {
  const m = market.generateMarket({ seed: 11, days: 800, vol: 0.018 });
  const r = bt.backtest(m, {
    cash: 100000, feeRate: 0.0005, slippageBp: 5, stopMode: "atr",
    atrN: 14, atrStopMult: 2, atrTargetMult: 4, atrVolN: 50,
    strategy: { type: "boll", bbN: 20, bbK: 2 },
  });
  assert.strictEqual(r.equity.length, 800);
  assert(Number.isFinite(r.final_equity));
  for (const tr of r.trades) {
    assert(["止损", "止盈", "信号平仓"].includes(tr.reason));
    assert(["低波动", "正常", "高波动"].includes(tr.vol_state));
    assert(tr.stop_price >= 0 && tr.target_price >= 0);
  }
  const s = metrics.summarize(r.equity, {});
  assert(Number.isFinite(s.sharpe) && Number.isFinite(s.max_drawdown));
});

t("追踪模式止损随上涨逐日上移并按追踪价退出", () => {
  // TR 恒为 2，ATR=2；i=20 以 open=120 入场，refIdx=19
  const rows = Array.from({ length: 20 }, (_, i) => ({ date: "d" + i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
  rows.push({ date: "d20", open: 120, high: 121, low: 119, close: 120, volume: 1 });
  rows.push({ date: "d21", open: 121, high: 122, low: 120, close: 121, volume: 1 });
  rows.push({ date: "d22", open: 122, high: 123, low: 121, close: 122, volume: 1 });
  rows.push({ date: "d23", open: 123, high: 124, low: 122, close: 123, volume: 1 });
  // 回落：最低 118.5 高于入场锁定止损 116，但低于已追踪上移的止损 119
  rows.push({ date: "d24", open: 122, high: 123, low: 118.5, close: 119, volume: 1 });
  const signal = new Array(25).fill(0);
  for (let i = 19; i < 25; i++) signal[i] = 1; // 持仓期间信号保持做多
  const r = bt.backtest({ rows }, { cash: 100000, feeRate: 0, slippageBp: 0, stopMode: "trail", atrStopMult: 2, atrTargetMult: 4, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
  const tr = r.trades[0];
  assert.strictEqual(tr.stop_mode, "trail");
  assert.strictEqual(tr.stop_init, 116);   // 入场当日：120 − 2×2
  assert.strictEqual(tr.target_init, 128); // 入场当日：120 + 2×4
  assert.strictEqual(tr.stop_price, 119);  // 逐日追踪至 最高收盘 123 − 2×2
  assert.strictEqual(tr.stop_updates, 3);  // 116 → 117 → 118 → 119
  assert.strictEqual(tr.reason, "止损");
  assert.strictEqual(tr.exit_price, 119);  // 入场锁定的 116 不会触发，追踪价 119 触发
});

t("追踪规则只紧不松且止盈随波动逐日收放", () => {
  const atrArr = new Array(60).fill(2);
  const volArr = bt.volStateSeries(atrArr, 50, 0.7, 1.3);
  const cur = bt.resolveStops({
    mode: "trail", entryPrice: 100, refIdx: 55, atrArr, volArr,
    stopLoss: 0, takeProfit: 0, atrStopMult: 2, atrTargetMult: 4, lowMult: 0.8, highMult: 1.5,
  });
  assert.strictEqual(cur.stopPrice, 96);
  assert.strictEqual(cur.targetPrice, 108);
  // 价格上涨：止损上移至 105 − 2×2 = 101
  bt.updateTrailStops(cur, { refIdx: 56, atrArr, volArr, highWater: 105, entryPrice: 100, atrStopMult: 2, atrTargetMult: 4, lowMult: 0.8, highMult: 1.5 });
  assert.strictEqual(cur.stopPrice, 101);
  // 波动放大（ATR 2→4、高波动乘数 1.5）：止损候选 105 − 4×2×1.5 = 93 更低 → 保持 101 不放松；止盈放宽至 100 + 4×4×1.5 = 124
  const atrArr2 = atrArr.slice(); atrArr2[57] = 4;
  const volArr2 = atrArr.map((_, i) => (i === 57 ? { state: "高波动", ratio: 2 } : { state: "正常", ratio: 1 }));
  bt.updateTrailStops(cur, { refIdx: 57, atrArr: atrArr2, volArr: volArr2, highWater: 105, entryPrice: 100, atrStopMult: 2, atrTargetMult: 4, lowMult: 0.8, highMult: 1.5 });
  assert.strictEqual(cur.stopPrice, 101);
  assert.strictEqual(cur.targetPrice, 124);
  assert.strictEqual(cur.atrRef, 4);
  assert.strictEqual(cur.volState, "高波动");
  // 波动回落（ATR 1、低波动乘数 0.8）：止损收紧至 105 − 1×2×0.8 = 103.4；止盈收窄至 100 + 1×4×0.8 = 103.2
  const atrArr3 = atrArr.slice(); atrArr3[58] = 1;
  const volArr3 = atrArr.map((_, i) => (i === 58 ? { state: "低波动", ratio: 0.5 } : { state: "正常", ratio: 1 }));
  bt.updateTrailStops(cur, { refIdx: 58, atrArr: atrArr3, volArr: volArr3, highWater: 105, entryPrice: 100, atrStopMult: 2, atrTargetMult: 4, lowMult: 0.8, highMult: 1.5 });
  assert(Math.abs(cur.stopPrice - 103.4) < 1e-9);
  assert(Math.abs(cur.targetPrice - 103.2) < 1e-9);
});

t("追踪模式不使用未来数据（截断行情结果一致）", () => {
  const m = market.generateMarket({ seed: 5, days: 500 });
  const opts = { cash: 100000, feeRate: 0.0005, slippageBp: 5, stopMode: "trail", strategy: { type: "ma_cross", fast: 10, slow: 30 } };
  const full = bt.backtest(m, opts);
  const cut = { rows: m.rows.slice(0, 200) };
  const r2 = bt.backtest(cut, opts);
  for (let i = 0; i < 200; i++) assert.strictEqual(r2.equity[i], full.equity[i]);
});

t("固定与 ATR 模式初始价等于锁定价且调整次数为 0", () => {
  const m = market.generateMarket({ seed: 21, days: 600 });
  const base = { cash: 100000, feeRate: 0.0005, slippageBp: 5, stopLoss: 0.05, takeProfit: 0.2, strategy: { type: "boll", bbN: 20, bbK: 2 } };
  for (const r of [bt.backtest(m, base), bt.backtest(m, { ...base, stopMode: "atr", atrStopMult: 2, atrTargetMult: 4 })]) {
    assert(r.trades.length > 0);
    for (const tr of r.trades) {
      assert.strictEqual(tr.stop_updates, 0);
      assert.strictEqual(tr.stop_init, tr.stop_price);
      assert.strictEqual(tr.target_init, tr.target_price);
    }
  }
});

t("追踪模式全链路：权益曲线、风险指标与蒙特卡洛同步", () => {
  const m = market.generateMarket({ seed: 11, days: 800, vol: 0.018 });
  const r = bt.backtest(m, {
    cash: 100000, feeRate: 0.0005, slippageBp: 5, stopMode: "trail",
    atrN: 14, atrStopMult: 2, atrTargetMult: 4, atrVolN: 50,
    strategy: { type: "boll", bbN: 20, bbK: 2 },
  });
  assert.strictEqual(r.equity.length, 800);
  assert(Number.isFinite(r.final_equity));
  assert(r.trades.length > 0);
  for (const tr of r.trades) {
    assert.strictEqual(tr.stop_mode, "trail");
    assert(tr.stop_price >= tr.stop_init - 1e-9); // 止损只紧不松
    assert(Number.isFinite(tr.stop_price) && Number.isFinite(tr.target_price));
  }
  const s = metrics.summarize(r.equity, {});
  assert(Number.isFinite(s.sharpe) && Number.isFinite(s.max_drawdown));
  const sim = mc.simulate(r.equity, 200, 60, 13);
  assert.strictEqual(sim.quantiles.p50.length, 61);
  assert(sim.prob_loss >= 0 && sim.prob_loss <= 1);
});

// ===== 策略版本与审核发布工作流 =====
const { createStore } = require("../engine/strategies");

function mkSnap(slow) {
  return {
    market: { seed: 42, days: 400, start: 100, drift: 0.0004, vol: 0.012 },
    strategy: { type: "ma_cross", fast: 10, slow: slow || 30 },
    trade: { cash: 100000, feeRate: 0.0005, slippageBp: 5, stopLoss: 0.05, takeProfit: 0.15 },
  };
}
function approvedStore(slow) {
  const store = createStore(null);
  store.create({ name: "双均线", user: "alice", snapshot: mkSnap(slow) });
  store.submit("s1", 1, "alice");
  store.review("s1", 1, { user: "bob", action: "approve" });
  return store;
}

t("草稿→送审→发布全流程状态流转", () => {
  const store = createStore(null);
  const s = store.create({ name: "双均线", user: "alice", snapshot: mkSnap() });
  assert.strictEqual(s.id, "s1");
  assert.strictEqual(s.versions[0].status, "draft");
  assert.strictEqual(s.versions[0].v, 1);
  store.updateDraft("s1", 1, { user: "alice", snapshot: mkSnap(50), note: "放慢慢线" });
  assert.strictEqual(store.get("s1", "author", "alice").versions[0].snapshot.strategy.slow, 50);
  store.submit("s1", 1, "alice");
  assert.strictEqual(store.get("s1", "author", "alice").versions[0].status, "pending");
  // 送审后快照冻结，不可再编辑
  assert.throws(() => store.updateDraft("s1", 1, { user: "alice", snapshot: mkSnap() }), /草稿状态/);
  const pub = store.review("s1", 1, { user: "bob", action: "approve" });
  assert.strictEqual(pub.versions[0].status, "published");
  assert(pub.versions[0].published_at);
});

t("驳回退回→重新打开→再送审", () => {
  const store = createStore(null);
  store.create({ name: "双均线", user: "alice", snapshot: mkSnap() });
  store.submit("s1", 1, "alice");
  assert.throws(() => store.review("s1", 1, { user: "bob", action: "reject" }), /评审意见/);
  store.review("s1", 1, { user: "bob", action: "reject", comment: "止损过宽" });
  const v = store.get("s1", "author", "alice").versions[0];
  assert.strictEqual(v.status, "rejected");
  assert.strictEqual(v.review_comment, "止损过宽");
  store.reopen("s1", 1, "alice");
  assert.strictEqual(store.get("s1", "author", "alice").versions[0].status, "draft");
  store.submit("s1", 1, "alice");
  store.review("s1", 1, { user: "bob", action: "approve" });
  assert.strictEqual(store.get("s1", "author", "alice").versions[0].status, "published");
});

t("权限：非作者不可编辑，作者不可自审，投资者不可见未发布版本", () => {
  const store = createStore(null);
  store.create({ name: "双均线", user: "alice", snapshot: mkSnap() });
  assert.throws(() => store.updateDraft("s1", 1, { user: "carol", snapshot: mkSnap() }), /作者本人/);
  assert.throws(() => store.submit("s1", 1, "carol"), /作者本人/);
  store.submit("s1", 1, "alice");
  assert.throws(() => store.review("s1", 1, { user: "alice", action: "approve" }), /自己撰写/);
  // 投资者在列表与详情中都看不到未发布版本
  assert.strictEqual(store.list("investor", "carol").length, 0);
  assert.throws(() => store.get("s1", "investor", "carol"), /403|可见/);
  // 评审员可见待审版本
  assert.strictEqual(store.list("reviewer", "bob")[0].versions[0].status, "pending");
});

t("投资者只能运行已发布版本", () => {
  const store = createStore(null);
  store.create({ name: "双均线", user: "alice", snapshot: mkSnap() });
  assert.throws(() => store.run("s1", 1, { role: "investor", user: "carol" }), /已发布版本/);
  // 作者可试算自己的草稿
  const draft = store.run("s1", 1, { role: "author", user: "alice" });
  assert.strictEqual(draft.status, "draft");
  store.submit("s1", 1, "alice");
  store.review("s1", 1, { user: "bob", action: "approve" });
  const pub = store.run("s1", 1, { role: "investor", user: "carol" });
  assert.strictEqual(pub.status, "published");
  assert.strictEqual(pub.run_by, "carol");
});

t("回测、风险指标与蒙特卡洛共用同一参数快照", () => {
  const store = approvedStore();
  const run = store.run("s1", 1, { role: "investor", user: "carol" });
  // 用同一快照直接调引擎，三者必须逐位一致
  const snap = mkSnap();
  const m = market.generateMarket(snap.market);
  const r = bt.backtest(m, { ...snap.trade, strategy: snap.strategy });
  const s = metrics.summarize(r.equity, {});
  const sim = mc.simulate(r.equity, 300, 252, snap.market.seed + 1);
  assert.strictEqual(run.final_equity, Math.round(r.final_equity * 100) / 100);
  assert.strictEqual(run.stats.sharpe, s.sharpe);
  assert.strictEqual(run.stats.max_drawdown, s.max_drawdown);
  assert.strictEqual(run.mc.prob_loss, Math.round(sim.prob_loss * 10000) / 10000);
  assert.strictEqual(run.mc.seed, snap.market.seed + 1);
  assert.strictEqual(run.equity.length, r.equity.length);
});

t("撤回不改历史结果，旧版仍可直接回测", () => {
  const store = approvedStore();
  store.run("s1", 1, { role: "investor", user: "carol" });
  store.run("s1", 1, { role: "author", user: "alice" });
  const before = store.get("s1", "author", "alice").versions[0].runs.map(r => r.id);
  store.withdraw("s1", 1, "alice");
  const after = store.get("s1", "author", "alice").versions[0];
  assert.strictEqual(after.status, "withdrawn");
  assert.deepStrictEqual(after.runs.map(r => r.id), before); // 历史结果原样保留
  // 投资者不再可见、不可运行已撤回版本
  assert.strictEqual(store.list("investor", "carol").length, 0);
  assert.throws(() => store.run("s1", 1, { role: "investor", user: "carol" }), /已发布版本/);
  // 作者/评审员仍可直接回测旧版
  const r1 = store.run("s1", 1, { role: "author", user: "alice" });
  const r2 = store.run("s1", 1, { role: "reviewer", user: "bob" });
  assert.strictEqual(r1.final_equity, r2.final_equity);
  assert.strictEqual(store.get("s1", "author", "alice").versions[0].runs.length, before.length + 2);
});

t("派生新版本不影响已发布快照，新旧版本均可独立回测", () => {
  const store = approvedStore(30);
  store.addVersion("s1", { user: "alice" });
  store.updateDraft("s1", 2, { user: "alice", snapshot: mkSnap(50) });
  const s = store.get("s1", "author", "alice");
  assert.strictEqual(s.versions[0].snapshot.strategy.slow, 30); // v1 已发布快照不变
  assert.strictEqual(s.versions[1].snapshot.strategy.slow, 50);
  const r1 = store.run("s1", 1, { role: "investor", user: "carol" });
  const r2 = store.run("s1", 2, { role: "author", user: "alice" });
  assert.notStrictEqual(r1.final_equity, r2.final_equity);
  // 投资者只见 v1（已发布），作者见全部
  const inv = store.list("investor", "carol")[0];
  assert.strictEqual(inv.versions.length, 1);
  assert.strictEqual(inv.versions[0].v, 1);
});

t("策略库持久化后可完整重载", () => {
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const f = path.join(os.tmpdir(), "strategies-test-" + process.pid + ".json");
  try {
    const a = createStore(f);
    a.create({ name: "双均线", user: "alice", snapshot: mkSnap() });
    a.submit("s1", 1, "alice");
    a.review("s1", 1, { user: "bob", action: "approve" });
    a.run("s1", 1, { role: "investor", user: "carol" });
    const b = createStore(f);
    const v = b.get("s1", "author", "alice").versions[0];
    assert.strictEqual(v.status, "published");
    assert.strictEqual(v.runs.length, 1);
    assert.strictEqual(v.snapshot.strategy.slow, 30);
  } finally {
    try { fs.unlinkSync(f); } catch (e) {}
  }
});

// ===== 实盘跟踪计划 =====
const { createPlanStore } = require("../engine/liveplans");

// 造一个「双均线 v1 已发布」的策略库 + 空计划库
function liveSetup() {
  const strategies = createStore(null);
  strategies.create({ name: "双均线", user: "alice", snapshot: mkSnap() });
  strategies.submit("s1", 1, "alice");
  strategies.review("s1", 1, { user: "bob", action: "approve" });
  const plans = createPlanStore(null, strategies);
  return { strategies, plans };
}
function activePlan() {
  const ctx = liveSetup();
  ctx.plans.create({ name: "十月实盘", user: "alice", strategy_id: "s1", version: 1, note: "首月" });
  ctx.plans.submit("p1", "alice");
  ctx.plans.review("p1", { user: "bob", action: "approve" });
  return ctx;
}

t("计划建档：仅策略作者可为已发布版本创建", () => {
  const { strategies, plans } = liveSetup();
  // 非作者创建被拒绝
  assert.throws(() => plans.create({ name: "跟踪", user: "carol", strategy_id: "s1", version: 1 }), /作者本人/);
  // 未发布版本不可建档
  strategies.create({ name: "布林带", user: "alice", snapshot: mkSnap() }); // s2 v1 草稿
  assert.throws(() => plans.create({ name: "跟踪", user: "alice", strategy_id: "s2", version: 1 }), /已发布/);
  // 缺名称/缺版本
  assert.throws(() => plans.create({ name: "", user: "alice", strategy_id: "s1", version: 1 }), /名称/);
  assert.throws(() => plans.create({ name: "跟踪", user: "alice", strategy_id: "s1" }), /版本号/);
  const p = plans.create({ name: "十月实盘", user: "alice", strategy_id: "s1", version: 1, note: "首月" });
  assert.strictEqual(p.id, "p1");
  assert.strictEqual(p.status, "draft");
  assert.strictEqual(p.strategy_name, "双均线");
  assert.strictEqual(p.version, 1);
});

t("计划审核流：送审→驳回→重开→通过开始跟踪", () => {
  const { plans } = liveSetup();
  plans.create({ name: "十月实盘", user: "alice", strategy_id: "s1", version: 1 });
  plans.submit("p1", "alice");
  assert.strictEqual(plans.get("p1", "author", "alice").status, "pending");
  // 评审独立性：不能审核自己创建的计划；驳回必填意见
  assert.throws(() => plans.review("p1", { user: "alice", action: "approve" }), /自己创建/);
  assert.throws(() => plans.review("p1", { user: "bob", action: "reject" }), /评审意见/);
  plans.review("p1", { user: "bob", action: "reject", comment: "先小资金验证" });
  assert.strictEqual(plans.get("p1", "author", "alice").status, "rejected");
  plans.reopen("p1", "alice");
  plans.submit("p1", "alice");
  const act = plans.review("p1", { user: "bob", action: "approve" });
  assert.strictEqual(act.status, "active");
  assert(act.activated_at);
  // 撤回送审路径
  plans.create({ name: "十一月实盘", user: "alice", strategy_id: "s1", version: 1 });
  plans.submit("p2", "alice");
  plans.retract("p2", "alice");
  assert.strictEqual(plans.get("p2", "author", "alice").status, "draft");
});

t("投资者记录每日持仓与收益：校验、同日覆盖、仅跟踪中可记", () => {
  const { plans } = liveSetup();
  plans.create({ name: "十月实盘", user: "alice", strategy_id: "s1", version: 1 });
  // 非跟踪中不可记录
  assert.throws(() => plans.record("p1", { user: "carol", date: "2026-10-01", position: 1, equity: 100000 }), /跟踪中/);
  plans.submit("p1", "alice");
  plans.review("p1", { user: "bob", action: "approve" });
  // 字段校验
  assert.throws(() => plans.record("p1", { user: "", date: "2026-10-01", position: 1, equity: 100000 }), /用户名/);
  assert.throws(() => plans.record("p1", { user: "carol", date: "10-01", position: 1, equity: 100000 }), /YYYY-MM-DD/);
  assert.throws(() => plans.record("p1", { user: "carol", date: "2026-10-01", position: 1.2, equity: 100000 }), /0~1/);
  assert.throws(() => plans.record("p1", { user: "carol", date: "2026-10-01", position: 0.5, equity: -3 }), /正数/);
  plans.record("p1", { user: "carol", date: "2026-10-01", position: 1, equity: 100000 });
  // 同一投资者同一日重复提交 → 覆盖更新，不新增
  plans.record("p1", { user: "carol", date: "2026-10-01", position: 0.8, equity: 100100, note: "修正" });
  const d = plans.get("p1", "investor", "carol");
  assert.strictEqual(d.entries.length, 1);
  assert.strictEqual(d.entries[0].position, 0.8);
  assert.strictEqual(d.entries[0].equity, 100100);
  assert.strictEqual(d.entries[0].note, "修正");
  assert.strictEqual(d.entries_count, 1);
  assert.strictEqual(d.participants, 1);
});

t("暂停保留历史并回写策略统计（手算核对）", () => {
  const { strategies, plans } = activePlan();
  plans.record("p1", { user: "carol", date: "2026-10-01", position: 1, equity: 100000 });
  plans.record("p1", { user: "carol", date: "2026-10-02", position: 1, equity: 102000 });
  plans.record("p1", { user: "carol", date: "2026-10-03", position: 0.5, equity: 99000 });
  plans.record("p1", { user: "dave", date: "2026-10-01", position: 0.8, equity: 50000 });
  plans.record("p1", { user: "dave", date: "2026-10-02", position: 0.8, equity: 55000 });
  // 非作者且非评审员不可暂停
  assert.throws(() => plans.pause("p1", "carol", "investor"), /可暂停/);
  const paused = plans.pause("p1", "alice", "author");
  assert.strictEqual(paused.status, "paused");
  assert.strictEqual(paused.entries.length, 5); // 历史原样保留
  const st = paused.stats;
  assert.strictEqual(st.participants, 2);
  assert.strictEqual(st.entries, 5);
  assert.strictEqual(st.days, 3);
  assert.strictEqual(st.first_date, "2026-10-01");
  assert.strictEqual(st.last_date, "2026-10-03");
  // carol: 99000/100000-1 ≈ -0.01，回撤 99000/102000-1 ≈ -0.0294；dave: 55000/50000-1 = 0.1
  assert.strictEqual(st.avg_return, 0.045);
  assert.strictEqual(st.best_return, 0.1);
  assert.strictEqual(st.worst_return, -0.01);
  assert.strictEqual(st.max_drawdown, -0.0294);
  assert.strictEqual(st.avg_position, 0.82); // (1+1+0.5+0.8+0.8)/5
  assert.strictEqual(st.by_user.length, 2);
  // 统计回写策略版本：不可变追加，既有回测历史不受影响
  const v = strategies.get("s1", "author", "alice").versions[0];
  assert.strictEqual(v.live_stats.length, 1);
  assert.strictEqual(v.live_stats[0].plan_id, "p1");
  assert.strictEqual(v.live_stats[0].plan_name, "十月实盘");
  assert.strictEqual(v.live_stats[0].participants, 2);
  assert.strictEqual(v.live_stats[0].avg_return, 0.045);
  assert.strictEqual(v.live_stats[0].max_drawdown, -0.0294);
  // 暂停后不可再记录、不可重复暂停
  assert.throws(() => plans.record("p1", { user: "carol", date: "2026-10-04", position: 1, equity: 100000 }), /跟踪中/);
  assert.throws(() => plans.pause("p1", "alice", "author"), /跟踪中/);
});

t("计划可见性：投资者仅见已审核计划，暂停后历史仍可见", () => {
  const { plans } = liveSetup();
  plans.create({ name: "十月实盘", user: "alice", strategy_id: "s1", version: 1 });
  assert.strictEqual(plans.list("investor", "carol").length, 0);
  assert.throws(() => plans.get("p1", "investor", "carol"), /不可见/);
  assert.strictEqual(plans.list("reviewer", "bob").length, 1);
  plans.submit("p1", "alice");
  plans.review("p1", { user: "bob", action: "approve" });
  assert.strictEqual(plans.list("investor", "carol").length, 1);
  // 评审员可暂停；空计划暂停时统计为空值
  const paused = plans.pause("p1", "bob", "reviewer");
  assert.strictEqual(paused.stats.participants, 0);
  assert.strictEqual(paused.stats.avg_return, null);
  assert.strictEqual(plans.list("investor", "carol").length, 1); // 已暂停仍可见（历史保留）
  assert.strictEqual(plans.list("investor", "carol")[0].status, "paused");
});

t("计划与回写统计持久化后可完整重载", () => {
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const sf = path.join(os.tmpdir(), "strategies-live-test-" + process.pid + ".json");
  const pf = path.join(os.tmpdir(), "liveplans-test-" + process.pid + ".json");
  try {
    const strategies = createStore(sf);
    strategies.create({ name: "双均线", user: "alice", snapshot: mkSnap() });
    strategies.submit("s1", 1, "alice");
    strategies.review("s1", 1, { user: "bob", action: "approve" });
    const plans = createPlanStore(pf, strategies);
    plans.create({ name: "十月实盘", user: "alice", strategy_id: "s1", version: 1 });
    plans.submit("p1", "alice");
    plans.review("p1", { user: "bob", action: "approve" });
    plans.record("p1", { user: "carol", date: "2026-10-01", position: 1, equity: 100000 });
    plans.record("p1", { user: "carol", date: "2026-10-02", position: 0.6, equity: 103000 });
    plans.pause("p1", "alice", "author");
    // 重载：计划、每日记录、回写到策略版本的统计都应完整恢复
    const strategies2 = createStore(sf);
    const plans2 = createPlanStore(pf, strategies2);
    const p = plans2.get("p1", "author", "alice");
    assert.strictEqual(p.status, "paused");
    assert.strictEqual(p.entries.length, 2);
    assert.strictEqual(p.stats.participants, 1);
    assert.strictEqual(p.stats.avg_return, 0.03);
    const v = strategies2.get("s1", "author", "alice").versions[0];
    assert.strictEqual(v.live_stats.length, 1);
    assert.strictEqual(v.live_stats[0].avg_return, 0.03);
  } finally {
    try { fs.unlinkSync(sf); } catch (e) {}
    try { fs.unlinkSync(pf); } catch (e) {}
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
