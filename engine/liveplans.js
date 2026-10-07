"use strict";
const fs = require("fs");
const path = require("path");
const metrics = require("./metrics");

// 实盘跟踪计划状态机（与策略版本工作流同构）：
//   draft（草稿）→ submit → pending（待审核）
//   pending → approve → active（跟踪中：投资者按已发布策略记录每日持仓与收益）
//   pending → reject  → rejected（驳回退回，附评审意见）
//   pending → retract → draft（作者撤回送审）
//   rejected → reopen → draft（退回后重新打开）
//   active → pause → paused（暂停：每日记录历史保留，统计回写策略版本 live_stats）
const STATUS_LABEL = {
  draft: "草稿",
  pending: "待审核",
  active: "跟踪中",
  rejected: "已驳回",
  paused: "已暂停",
};

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
const round4 = v => Math.round(v * 10000) / 10000;

function validDate(d) {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + "T00:00:00Z"));
}

function createPlanStore(file, strategies) {
  let data = { seq: 0, entrySeq: 0, plans: [] };
  if (file && fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.seq = data.seq || 0;
    data.entrySeq = data.entrySeq || 0;
    data.plans = data.plans || [];
  }

  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  }

  function find(id) {
    const p = data.plans.find(x => x.id === id);
    if (!p) throw fail(404, "计划不存在: " + id);
    return p;
  }

  function requireAuthor(p, user) {
    if (!user || p.author !== user) throw fail(403, "仅计划创建者本人可执行此操作");
  }

  // 可见性：创建者见自己的全部计划；评审员见全部；投资者只见已审核（跟踪中/已暂停）
  function visible(p, role, user) {
    if (role === "reviewer" || (user && p.author === user)) return true;
    return p.status === "active" || p.status === "paused";
  }

  function view(p, role, user, withEntries) {
    const out = {
      id: p.id,
      name: p.name,
      strategy_id: p.strategy_id,
      version: p.version,
      strategy_name: p.strategy_name,
      author: p.author,
      note: p.note,
      status: p.status,
      status_label: STATUS_LABEL[p.status],
      created_at: p.created_at,
      submitted_at: p.submitted_at,
      reviewed_by: p.reviewed_by,
      review_comment: p.review_comment,
      reviewed_at: p.reviewed_at,
      activated_at: p.activated_at,
      paused_at: p.paused_at,
      paused_by: p.paused_by,
      mine: !!user && p.author === user,
      entries_count: p.entries.length,
      participants: new Set(p.entries.map(e => e.user)).size,
      stats: clone(p.stats),
    };
    if (withEntries) {
      out.entries = clone(p.entries).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.user < b.user ? -1 : 1));
    }
    return out;
  }

  // 汇总每日记录：先按投资者各自计算区间收益/回撤/平均仓位，再聚合成计划级统计
  function computeStats(plan) {
    const byUser = new Map();
    const dates = new Set();
    let posSum = 0;
    for (const e of plan.entries) {
      dates.add(e.date);
      posSum += e.position;
      if (!byUser.has(e.user)) byUser.set(e.user, []);
      byUser.get(e.user).push(e);
    }
    const users = [];
    const rets = [];
    const dds = [];
    for (const [user, list] of byUser) {
      list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const eq = list.map(e => e.equity);
      const ret = eq[eq.length - 1] / eq[0] - 1;
      const dd = metrics.maxDrawdown(eq).maxDD;
      rets.push(ret);
      dds.push(dd);
      users.push({
        user,
        entries: list.length,
        first_date: list[0].date,
        last_date: list[list.length - 1].date,
        total_return: round4(ret),
        max_drawdown: round4(dd),
        avg_position: round4(list.reduce((s, e) => s + e.position, 0) / list.length),
      });
    }
    const days = [...dates].sort();
    const n = users.length;
    return {
      participants: n,
      entries: plan.entries.length,
      days: days.length,
      first_date: days[0] || null,
      last_date: days[days.length - 1] || null,
      avg_return: n ? round4(rets.reduce((s, x) => s + x, 0) / n) : null,
      best_return: n ? round4(Math.max(...rets)) : null,
      worst_return: n ? round4(Math.min(...rets)) : null,
      max_drawdown: n ? round4(Math.min(...dds)) : null,
      avg_position: plan.entries.length ? round4(posSum / plan.entries.length) : null,
      by_user: users,
    };
  }

  const store = {
    data,
    save,

    list(role, user) {
      return data.plans.filter(p => visible(p, role, user)).map(p => view(p, role, user, false));
    },

    get(id, role, user) {
      const p = find(id);
      if (!visible(p, role, user)) throw fail(403, "该计划暂不可见");
      return view(p, role, user, true);
    },

    // 作者建档：仅能为「我的策略」的已发布版本创建跟踪计划，初始为草稿
    create({ name, user, strategy_id, version, note }) {
      if (!user) throw fail(403, "请先设置用户名");
      if (!name || !String(name).trim()) throw fail(400, "计划名称不能为空");
      if (!strategy_id) throw fail(400, "缺少策略ID");
      if (version == null) throw fail(400, "缺少策略版本号");
      const { s, ver } = strategies._ref(strategy_id, version);
      if (!ver) throw fail(404, `策略 ${strategy_id} 不存在版本 v${version}`);
      if (s.author !== user) throw fail(403, "仅策略作者本人可为其策略创建跟踪计划");
      if (ver.status !== "published") throw fail(409, "仅「已发布」的策略版本可创建实盘跟踪计划");
      const p = {
        id: "p" + ++data.seq,
        name: String(name).trim(),
        strategy_id: s.id,
        version: ver.v,
        strategy_name: s.name,
        author: user,
        note: note ? String(note) : "",
        status: "draft",
        created_at: now(),
        submitted_at: null,
        reviewed_by: null,
        review_comment: null,
        reviewed_at: null,
        activated_at: null,
        paused_at: null,
        paused_by: null,
        entries: [],
        stats: null,
      };
      data.plans.push(p);
      save();
      return view(p, "author", user, true);
    },

    submit(id, user) {
      const p = find(id);
      requireAuthor(p, user);
      if (p.status !== "draft") throw fail(409, "仅草稿可送审");
      p.status = "pending";
      p.submitted_at = now();
      p.reviewed_by = null;
      p.review_comment = null;
      p.reviewed_at = null;
      save();
      return view(p, "author", user, true);
    },

    // 作者撤回送审：回到草稿
    retract(id, user) {
      const p = find(id);
      requireAuthor(p, user);
      if (p.status !== "pending") throw fail(409, "仅待审核计划可撤回送审");
      p.status = "draft";
      p.submitted_at = null;
      save();
      return view(p, "author", user, true);
    },

    // 评审员通过后开始跟踪或驳回退回；评审独立性：不能审核自己创建的计划
    review(id, { user, action, comment }) {
      const p = find(id);
      if (p.author === user) throw fail(403, "不能审核自己创建的计划");
      if (p.status !== "pending") throw fail(409, "该计划不在待审核状态");
      if (action === "approve") {
        p.status = "active";
        p.activated_at = now();
      } else if (action === "reject") {
        if (!comment || !String(comment).trim()) throw fail(400, "驳回必须填写评审意见");
        p.status = "rejected";
      } else {
        throw fail(400, "未知评审动作: " + action);
      }
      p.reviewed_by = user;
      p.review_comment = comment ? String(comment) : null;
      p.reviewed_at = now();
      save();
      return view(p, "reviewer", user, true);
    },

    // 驳回退回后作者重新打开，回到草稿
    reopen(id, user) {
      const p = find(id);
      requireAuthor(p, user);
      if (p.status !== "rejected") throw fail(409, "仅已驳回计划可重新打开");
      p.status = "draft";
      save();
      return view(p, "author", user, true);
    },

    // 暂停跟踪：每日记录历史原样保留，统计作为不可变记录回写策略版本
    pause(id, user, role) {
      const p = find(id);
      if (p.author !== user && role !== "reviewer") throw fail(403, "仅计划创建者或评审员可暂停");
      if (p.status !== "active") throw fail(409, "仅跟踪中的计划可暂停");
      p.status = "paused";
      p.paused_at = now();
      p.paused_by = user || "匿名";
      p.stats = computeStats(p);
      strategies.recordLiveStats(p.strategy_id, p.version, {
        plan_id: p.id,
        plan_name: p.name,
        plan_author: p.author,
        at: p.paused_at,
        by: p.paused_by,
        participants: p.stats.participants,
        entries: p.stats.entries,
        days: p.stats.days,
        first_date: p.stats.first_date,
        last_date: p.stats.last_date,
        avg_return: p.stats.avg_return,
        best_return: p.stats.best_return,
        worst_return: p.stats.worst_return,
        max_drawdown: p.stats.max_drawdown,
        avg_position: p.stats.avg_position,
      });
      save();
      return view(p, role === "reviewer" ? "reviewer" : "author", user, true);
    },

    // 投资者记录每日持仓与收益：同一投资者同一日重复提交视为更新当日记录
    record(id, { user, date, position, equity, note }) {
      const p = find(id);
      if (!user) throw fail(403, "请先设置用户名");
      if (p.status !== "active") throw fail(409, "仅跟踪中的计划可记录每日持仓与收益");
      if (!validDate(date)) throw fail(400, "日期格式应为 YYYY-MM-DD");
      const pos = Number(position);
      if (!(pos >= 0 && pos <= 1)) throw fail(400, "持仓比例需在 0~1 之间");
      const eq = Number(equity);
      if (!isFinite(eq) || !(eq > 0)) throw fail(400, "当日权益需为正数");
      let e = p.entries.find(x => x.user === user && x.date === date);
      if (e) {
        e.position = pos;
        e.equity = eq;
        e.note = note ? String(note) : "";
        e.recorded_at = now();
      } else {
        e = {
          id: "e" + ++data.entrySeq,
          user,
          date,
          position: pos,
          equity: eq,
          note: note ? String(note) : "",
          recorded_at: now(),
        };
        p.entries.push(e);
      }
      save();
      return view(p, "investor", user, true);
    },
  };
  return store;
}

module.exports = { createPlanStore, STATUS_LABEL };
