"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const market = require("./engine/market");
const bt = require("./engine/backtest");
const metrics = require("./engine/metrics");
const mc = require("./engine/montecarlo");
const { createStore } = require("./engine/strategies");
const { createPlanStore } = require("./engine/liveplans");

const arg = process.argv.find(a => a.startsWith("--port="));
const PORT = arg ? parseInt(arg.slice(7), 10) : parseInt(process.env.PORT || "8073", 10);
const WEB = path.join(__dirname, "web");
const strategies = createStore(path.join(__dirname, "data", "strategies.json"));
const plans = createPlanStore(path.join(__dirname, "data", "liveplans.json"), strategies);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => {
      buf += c;
      if (buf.length > 2e6) req.destroy();
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/api/system" && req.method === "GET") {
      return json(res, 200, { name: "invest-backtest", version: 1, title: "个人投资回测与风险分析平台" });
    }
    if (p === "/api/market" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const m = market.generateMarket(body || {});
      return json(res, 200, { dates: m.dates, rows: m.rows });
    }
    if (p === "/api/indicators" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const rows = body.rows || [];
      const close = rows.map(r => r.close);
      const out = {};
      if (body.ma) out.ma = ind_sma(close, body.ma);
      if (body.rsi) out.rsi = ind_rsi(close, body.rsi);
      if (body.bb) out.bb = ind_boll(close, body.bb);
      return json(res, 200, out);
    }
    if (p === "/api/backtest" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const m = market.generateMarket(body.market || {});
      const r = bt.backtest(m, body.options || {});
      const stats = metrics.summarize(r.equity, body.options || {});
      const equityPts = r.equity.map((v, i) => [i, Math.round(v * 100) / 100]);
      const ddPts = r.drawdown.map((v, i) => [i, Math.round(v * 10000) / 10000]);
      return json(res, 200, {
        dates: m.dates,
        rows: m.rows,
        equity: equityPts,
        drawdown: ddPts,
        trades: r.trades,
        stats,
        final_equity: Math.round(r.final_equity * 100) / 100,
        total_return: Math.round(r.total_return * 10000) / 10000,
      });
    }
    if (p === "/api/montecarlo" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const r = mc.simulate(body.equity || [], body.nPaths, body.nSteps, body.seed);
      if (!r.quantiles) return json(res, 200, { quantiles: null, prob_loss: null, paths: [] });
      return json(res, 200, {
        quantiles: {
          p5: r.quantiles.p5.map((v, i) => [i, Math.round(v * 100) / 100]),
          p50: r.quantiles.p50.map((v, i) => [i, Math.round(v * 100) / 100]),
          p95: r.quantiles.p95.map((v, i) => [i, Math.round(v * 100) / 100]),
        },
        prob_loss: Math.round(r.prob_loss * 10000) / 10000,
        paths: r.paths.slice(0, 8).map(pathArr => pathArr.map((v, i) => [i, Math.round(v * 100) / 100])),
        start: r.start,
        steps: r.steps,
      });
    }

    // 策略库：版本管理 + 审核发布工作流。角色经 x-role / x-user 头头（或 body 字段）传入，
    // 缺省按投资者（最小权限）处理。
    const mStrat = p.match(/^\/api\/strategies(?:\/([^/]+)(?:\/versions(?:\/(\d+)(?:\/(\w+))?)?)?)?$/);
    if (mStrat && (p === "/api/strategies" || mStrat[1])) {
      const body = req.method === "POST" || req.method === "PUT" ? JSON.parse((await readBody(req)) || "{}") : {};
      const role = req.headers["x-role"] || body.role || url.searchParams.get("role") || "investor";
      const user = req.headers["x-user"] || body.user || url.searchParams.get("user") || "";
      const [, id, v, action] = mStrat;
      if (p === "/api/strategies" && req.method === "GET") {
        return json(res, 200, { strategies: strategies.list(role, user) });
      }
      if (p === "/api/strategies" && req.method === "POST") {
        return json(res, 201, strategies.create({ name: body.name, user, snapshot: body.snapshot, note: body.note }));
      }
      if (id && v == null && req.method === "GET") {
        return json(res, 200, strategies.get(id, role, user));
      }
      if (id && p.endsWith("/versions") && req.method === "POST") {
        return json(res, 201, strategies.addVersion(id, { user, from: body.from }));
      }
      if (id && v != null && !action && req.method === "PUT") {
        return json(res, 200, strategies.updateDraft(id, v, { user, snapshot: body.snapshot, note: body.note }));
      }
      if (id && v != null && action && req.method === "POST") {
        if (action === "submit") return json(res, 200, strategies.submit(id, v, user));
        if (action === "retract") return json(res, 200, strategies.retract(id, v, user));
        if (action === "reopen") return json(res, 200, strategies.reopen(id, v, user));
        if (action === "withdraw") return json(res, 200, strategies.withdraw(id, v, user, role));
        if (action === "review") {
          if (role !== "reviewer") return json(res, 403, { error: "仅评审员可执行评审" });
          return json(res, 200, strategies.review(id, v, { user, action: body.action, comment: body.comment }));
        }
        if (action === "run") return json(res, 200, strategies.run(id, v, { role, user }));
        return json(res, 404, { error: "unknown action: " + action });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // 实盘跟踪计划：作者建档 → 评审员审核 → 投资者记录每日持仓与收益 → 暂停回写策略统计。
    // 角色同样经 x-role / x-user 头传入，缺省按投资者处理。
    const mPlan = p.match(/^\/api\/plans(?:\/([^/]+)(?:\/(\w+))?)?$/);
    if (mPlan && (p === "/api/plans" || mPlan[1])) {
      const body = req.method === "POST" || req.method === "PUT" ? JSON.parse((await readBody(req)) || "{}") : {};
      const role = req.headers["x-role"] || body.role || url.searchParams.get("role") || "investor";
      const user = req.headers["x-user"] || body.user || url.searchParams.get("user") || "";
      const [, id, action] = mPlan;
      if (p === "/api/plans" && req.method === "GET") {
        return json(res, 200, { plans: plans.list(role, user) });
      }
      if (p === "/api/plans" && req.method === "POST") {
        return json(res, 201, plans.create({ name: body.name, user, strategy_id: body.strategy_id, version: body.version, note: body.note }));
      }
      if (id && !action && req.method === "GET") {
        return json(res, 200, plans.get(id, role, user));
      }
      if (id && action && req.method === "POST") {
        if (action === "entries") {
          return json(res, 201, plans.record(id, { user, date: body.date, position: body.position, equity: body.equity, note: body.note }));
        }
        if (action === "submit") return json(res, 200, plans.submit(id, user));
        if (action === "retract") return json(res, 200, plans.retract(id, user));
        if (action === "reopen") return json(res, 200, plans.reopen(id, user));
        if (action === "pause") return json(res, 200, plans.pause(id, user, role));
        if (action === "review") {
          if (role !== "reviewer") return json(res, 403, { error: "仅评审员可执行评审" });
          return json(res, 200, plans.review(id, { user, action: body.action, comment: body.comment }));
        }
        return json(res, 404, { error: "unknown action: " + action });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    let f = p === "/" ? "/index.html" : p;
    const fp = path.normalize(path.join(WEB, f));
    if (!fp.startsWith(WEB)) return json(res, 403, { error: "forbidden" });
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      return fs.createReadStream(fp).pipe(res);
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
});

const { sma: ind_sma, rsi: ind_rsi, bollinger: ind_boll } = require("./engine/indicators");

server.listen(PORT, "127.0.0.1", () => {
  console.log(`invest-backtest running at http://127.0.0.1:${PORT}`);
});
