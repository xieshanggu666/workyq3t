"use strict";
const fs = require("fs");
const path = require("path");
const market = require("./market");
const bt = require("./backtest");
const metrics = require("./metrics");
const mc = require("./montecarlo");

// 版本状态机：
//   draft（草稿，可编辑）→ submit → pending（送审待评审）
//   pending → approve → published（评审通过，发布）
//   pending → reject  → rejected（驳回退回，附评审意见）
//   pending → retract → draft（作者撤回送审）
//   rejected → reopen → draft（退回后重新打开修订）
//   published → withdraw → withdrawn（撤回：历史运行结果保留不变，旧版仍可直接回测）
const STATUS_LABEL = {
  draft: "草稿",
  pending: "待评审",
  published: "已发布",
  rejected: "已驳回",
  withdrawn: "已撤回",
};

const STRATEGY_TYPES = ["ma_cross", "rsi", "boll", "buy_hold"];

function clone(o) {
  return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
}
function now() {
  return new Date().toISOString();
}
function fail(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}
const round2 = v => Math.round(v * 100) / 100;
const round4 = v => Math.round(v * 10000) / 10000;

// 参数快照 = 行情参数 + 策略参数 + 交易参数三段。
// 一次快照同时驱动回测、风险指标与蒙特卡洛，三者永不分别取参。
function normalizeSnapshot(snap) {
  if (!snap || typeof snap !== "object") throw fail(400, "参数快照缺失");
  const st = snap.strategy || {};
  if (!STRATEGY_TYPES.includes(st.type)) throw fail(400, "未知策略类型: " + (st.type || "(空)"));
  const out = {
    market: clone(snap.market) || {},
    strategy: clone(st),
    trade: clone(snap.trade) || {},
  };
  const d = out.market.days;
  if (d != null && (!(d >= 10) || d > 5000)) throw fail(400, "交易日数需在 10~5000 之间");
  return out;
}

function createStore(file) {
  let data = { seq: 0, runSeq: 0, strategies: [] };
  if (file && fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.seq = data.seq || 0;
    data.runSeq = data.runSeq || 0;
    data.strategies = data.strategies || [];
  }

  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  }

  function find(id, v) {
    const s = data.strategies.find(x => x.id === id);
    if (!s) throw fail(404, "策略不存在: " + id);
    if (v == null) return { s, ver: null };
    const ver = s.versions.find(x => x.v === Number(v));
    if (!ver) throw fail(404, `策略 ${id} 不存在版本 v${v}`);
    return { s, ver };
  }

  function requireAuthor(s, user) {
    if (!user || s.author !== user) throw fail(403, "仅策略作者本人可执行此操作");
  }

  // 可见性：作者见自己的全部版本；评审员见全部；投资者只见已发布版本
  function visibleVersions(s, role, user) {
    if (role === "reviewer" || (user && s.author === user)) return s.versions;
    return s.versions.filter(v => v.status === "published");
  }

  function view(s, role, user) {
    const vs = visibleVersions(s, role, user);
    return {
      id: s.id,
      name: s.name,
      author: s.author,
      created_at: s.created_at,
      mine: !!user && s.author === user,
      versions: vs.map(v => ({ ...clone(v), status_label: STATUS_LABEL[v.status] })),
    };
  }

  const store = {
    data,
    save,

    list(role, user) {
      return data.strategies
        .map(s => view(s, role, user))
        .filter(s => s.versions.length > 0);
    },

    get(id, role, user) {
      const { s } = find(id);
      const v = view(s, role, user);
      if (!v.versions.length) throw fail(403, "该策略暂无可见版本");
      return v;
    },

    // 作者建档：初始为 v1 草稿
    create({ name, user, snapshot, note }) {
      if (!user) throw fail(403, "请先设置用户名");
      if (!name || !String(name).trim()) throw fail(400, "策略名称不能为空");
      const snap = normalizeSnapshot(snapshot);
      const s = {
        id: "s" + ++data.seq,
        name: String(name).trim(),
        author: user,
        created_at: now(),
        versions: [
          {
            v: 1,
            status: "draft",
            snapshot: snap,
            note: note || "",
            created_at: now(),
            submitted_at: null,
            reviewed_by: null,
            review_comment: null,
            reviewed_at: null,
            published_at: null,
            withdrawn_at: null,
            runs: [],
          },
        ],
      };
      data.strategies.push(s);
      save();
      return view(s, "author", user);
    },

    // 基于任一既有版本的快照派生新草稿版本（默认最新版）
    addVersion(id, { user, from }) {
      const { s } = find(id);
      requireAuthor(s, user);
      const src = from != null ? find(id, from).ver : s.versions[s.versions.length - 1];
      const ver = {
        v: Math.max(...s.versions.map(x => x.v)) + 1,
        status: "draft",
        snapshot: clone(src.snapshot),
        note: "",
        created_at: now(),
        submitted_at: null,
        reviewed_by: null,
        review_comment: null,
        reviewed_at: null,
        published_at: null,
        withdrawn_at: null,
        runs: [],
      };
      s.versions.push(ver);
      save();
      return view(s, "author", user);
    },

    // 仅草稿可编辑；送审后快照即冻结
    updateDraft(id, v, { user, snapshot, note }) {
      const { s, ver } = find(id, v);
      requireAuthor(s, user);
      if (ver.status !== "draft") throw fail(409, "仅草稿状态可编辑，当前为「" + STATUS_LABEL[ver.status] + "」");
      ver.snapshot = normalizeSnapshot(snapshot);
      if (note != null) ver.note = String(note);
      save();
      return view(s, "author", user);
    },

    submit(id, v, user) {
      const { s, ver } = find(id, v);
      requireAuthor(s, user);
      if (ver.status !== "draft") throw fail(409, "仅草稿可送审");
      ver.status = "pending";
      ver.submitted_at = now();
      ver.reviewed_by = null;
      ver.review_comment = null;
      ver.reviewed_at = null;
      save();
      return view(s, "author", user);
    },

    // 作者撤回送审：回到草稿可继续编辑
    retract(id, v, user) {
      const { s, ver } = find(id, v);
      requireAuthor(s, user);
      if (ver.status !== "pending") throw fail(409, "仅待评审版本可撤回送审");
      ver.status = "draft";
      ver.submitted_at = null;
      save();
      return view(s, "author", user);
    },

    // 评审员通过后发布或驳回退回；评审独立性：不能评审自己撰写的策略
    review(id, v, { user, action, comment }) {
      const { s, ver } = find(id, v);
      if (s.author === user) throw fail(403, "不能评审自己撰写的策略");
      if (ver.status !== "pending") throw fail(409, "该版本不在待评审状态");
      if (action === "approve") {
        ver.status = "published";
        ver.published_at = now();
      } else if (action === "reject") {
        if (!comment || !String(comment).trim()) throw fail(400, "驳回必须填写评审意见");
        ver.status = "rejected";
      } else {
        throw fail(400, "未知评审动作: " + action);
      }
      ver.reviewed_by = user;
      ver.review_comment = comment ? String(comment) : null;
      ver.reviewed_at = now();
      save();
      return view(s, "reviewer", user);
    },

    // 驳回退回后作者重新打开，回到草稿修订
    reopen(id, v, user) {
      const { s, ver } = find(id, v);
      requireAuthor(s, user);
      if (ver.status !== "rejected") throw fail(409, "仅已驳回版本可重新打开");
      ver.status = "draft";
      save();
      return view(s, "author", user);
    },

    // 撤回已发布版本：只改状态，历史运行结果原样保留
    withdraw(id, v, user, role) {
      const { s, ver } = find(id, v);
      if (s.author !== user && role !== "reviewer") throw fail(403, "仅作者本人或评审员可撤回");
      if (ver.status !== "published") throw fail(409, "仅已发布版本可撤回");
      ver.status = "withdrawn";
      ver.withdrawn_at = now();
      save();
      return view(s, role === "reviewer" ? "reviewer" : "author", user);
    },

    // 从版本快照运行：回测 + 风险指标 + 蒙特卡洛共用同一份参数快照。
    // 投资者只能运行已发布版本；作者/评审员可直接回测任意旧版。
    // 每次运行追加一条不可变历史记录，撤回不影响已记录的结果。
    run(id, v, { role, user }) {
      const { s, ver } = find(id, v);
      const isAuthor = !!user && s.author === user;
      const isReviewer = role === "reviewer";
      if (!isAuthor && !isReviewer && ver.status !== "published") {
        throw fail(403, "投资者只能运行已发布版本");
      }
      const snap = ver.snapshot;
      const m = market.generateMarket(snap.market || {});
      const r = bt.backtest(m, { ...(snap.trade || {}), strategy: clone(snap.strategy) || {} });
      const stats = metrics.summarize(r.equity, {});
      const mcSeed = (snap.market && snap.market.seed != null ? snap.market.seed : 7) + 1;
      const sim = mc.simulate(r.equity, 300, 252, mcSeed);

      const runRec = {
        id: "r" + ++data.runSeq,
        at: now(),
        by: user || "匿名",
        stats,
        final_equity: round2(r.final_equity),
        total_return: round4(r.total_return),
        trades_count: r.trades.length,
        mc_prob_loss: sim.prob_loss == null ? null : round4(sim.prob_loss),
        mc_seed: mcSeed,
        equity: r.equity.map((val, i) => [i, round2(val)]),
      };
      ver.runs.push(runRec);
      save();

      return {
        strategy_id: s.id,
        name: s.name,
        version: ver.v,
        status: ver.status,
        status_label: STATUS_LABEL[ver.status],
        run_id: runRec.id,
        run_at: runRec.at,
        run_by: runRec.by,
        dates: m.dates,
        equity: runRec.equity,
        drawdown: r.drawdown.map((val, i) => [i, round4(val)]),
        trades: r.trades,
        stats,
        final_equity: runRec.final_equity,
        total_return: runRec.total_return,
        mc: sim.quantiles
          ? {
              quantiles: {
                p5: sim.quantiles.p5.map((val, i) => [i, round2(val)]),
                p50: sim.quantiles.p50.map((val, i) => [i, round2(val)]),
                p95: sim.quantiles.p95.map((val, i) => [i, round2(val)]),
              },
              prob_loss: runRec.mc_prob_loss,
              seed: mcSeed,
              steps: sim.steps,
            }
          : { quantiles: null, prob_loss: null, seed: mcSeed, steps: 0 },
      };
    },
  };
  return store;
}

module.exports = { createStore, STATUS_LABEL, STRATEGY_TYPES, normalizeSnapshot };
