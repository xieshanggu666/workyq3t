"use strict";
const fs = require("fs");
const path = require("path");
const metrics = require("./metrics");

// 计划状态机：
//   draft（草稿）→ submit → pending（送审待审核）
//   pending → approve → active（审核通过，开始跟踪）
//   pending → reject  → rejected（驳回退回，附评审意见）
//   pending → retract → draft（作者撤回送审）
//   rejected → reopen → draft（退回后重新打开修订）
//   active → pause → paused（暂停：记录冻结，历史保留，统计回写策略版本）
//   paused → resume → active（作者恢复跟踪；再次暂停会追加一条新的回写记录）
const STATUS_LABEL = {
  draft: "草稿",
  pending: "待审核",
  active: "进行中",
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
const round2 = v => Math.round(v * 100) / 100;
const round4 = v => Math.round(v * 10000) / 10000;

// 由记录条目计算实盘统计：每位投资者一条权益曲线（与回测共用同一套风险指标），
// 汇总曲线按「当日有记录投资者收益的等权平均」逐日复利。
function computeStats(entries, withCurve) {
  const byUser = {};
  for (const e of entries) (byUser[e.user] = byUser[e.user] || []).push(e);
  const investors = [];
  const returnsByDate = {};
  for (const user of Object.keys(byUser).sort()) {
    const es = byUser[user].slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const curve = es.map(e => e.equity);
    for (let i = 1; i < es.length; i++) {
      const r = es[i].equity / es[i - 1].equity - 1;
      (returnsByDate[es[i].date] = returnsByDate[es[i].date] || []).push(r);
    }
    investors.push({
      user,
      days: es.length,
      first_date: es[0].date,
      last_date: es[es.length - 1].date,
      avg_position: round4(es.reduce((s, e) => s + e.position, 0) / es.length),
      final_equity: round2(curve[curve.length - 1]),
      stats: curve.length >= 2 ? metrics.summarize(curve, {}) : null,
    });
  }
  const dates = Object.keys(returnsByDate).sort();
  let aggregate = null;
  if (dates.length) {
    const curve = [1];
    for (const d of dates) {
      const rs = returnsByDate[d];
      curve.push(curve[curve.length - 1] * (1 + rs.reduce((s, r) => s + r, 0) / rs.length));
    }
    aggregate = { days: curve.length - 1, stats: metrics.summarize(curve, {}) };
    if (withCurve) aggregate.curve = curve.map((v, i) => [i, round4(v)]);
  }
  return { investors, aggregate };
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
    if (!user || p.author !== user) throw fail(403, "仅计划作者本人可执行此操作");
  }

  // 可见性：评审员见全部；作者见自己的全部；其余（含投资者）只见进行中/已暂停
  function visible(p, role, user) {
    if (role === "reviewer" || (user && p.author === user)) return true;
    return p.status === "active" || p.status === "paused";
  }

  function cardView(p, role, user) {
    return {
      id: p.id,
      name: p.name,
      author: p.author,
      strategy_id: p.strategy_id,
      strategy_v: p.strategy_v,
      strategy_name: p.strategy_name,
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
      writebacks: clone(p.writebacks) || [],
      stats: computeStats(p.entries, false),
    };
  }

  function detailView(p, role, user) {
    const v = cardView(p, role, user);
    v.entries = clone(p.entries).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    v.stats = computeStats(p.entries, true);
    return v;
  }

  const store = {
    data,
    save,

    list(role, user) {
      return data.plans.filter(p => visible(p, role, user)).map(p => cardView(p, role, user));
    },

    get(id, role, user) {
      const p = find(id);
      if (!visible(p, role, user)) throw fail(403, "无权查看该计划");
      return detailView(p, role, user);
    },

    // 作者建档：只能挂在「已发布」的策略版本上，初始为草稿
    create({ name, user, strategy_id, strategy_v, note }) {
      if (!user) throw fail(403, "请先设置用户名");
      if (!name || !String(name).trim()) throw fail(400, "计划名称不能为空");
      if (!strategies) throw fail(500, "策略库未挂载，无法校验策略版本");
      const { s, ver } = strategies.getPublishedRef(strategy_id, strategy_v);
      const p = {
        id: "p" + ++data.seq,
        name: String(name).trim(),
        strategy_id: s.id,
        strategy_v: ver.v,
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
        writebacks: [],
        entries: [],
      };
      data.plans.push(p);
      save();
      return cardView(p, "author", user);
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
      return cardView(p, "author", user);
    },

    // 作者撤回送审：回到草稿
    retract(id, user) {
      const p = find(id);
      requireAuthor(p, user);
      if (p.status !== "pending") throw fail(409, "仅待审核计划可撤回送审");
      p.status = "draft";
      p.submitted_at = null;
      save();
      return cardView(p, "author", user);
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
      return cardView(p, "reviewer", user);
    },

    // 驳回退回后作者重新打开，回到草稿修订
    reopen(id, user) {
      const p = find(id);
      requireAuthor(p, user);
      if (p.status !== "rejected") throw fail(409, "仅已驳回计划可重新打开");
      p.status = "draft";
      save();
      return cardView(p, "author", user);
    },

    // 暂停：记录冻结，历史条目原样保留；分投资者与等权汇总统计回写关联策略版本
    // （不可变追加，版本已撤回也照常回写，历史不断档）
    pause(id, user, role) {
      const p = find(id);
      if (p.author !== user && role !== "reviewer") throw fail(403, "仅计划作者本人或评审员可暂停");
      if (p.status !== "active") throw fail(409, "仅进行中的计划可暂停");
      p.status = "paused";
      p.paused_at = now();
      p.paused_by = user || "匿名";
      const st = computeStats(p.entries, false);
      const rec = strategies.appendLiveStats(p.strategy_id, p.strategy_v, {
        plan_id: p.id,
        plan_name: p.name,
        plan_author: p.author,
        paused_at: p.paused_at,
        investors: st.investors,
        aggregate: st.aggregate,
      });
      p.writebacks.push(rec.id);
      save();
      return cardView(p, role === "reviewer" ? "reviewer" : "author", user);
    },

    // 恢复跟踪：历史条目保留，可继续记录；再次暂停会追加新的回写记录
    resume(id, user) {
      const p = find(id);
      requireAuthor(p, user);
      if (p.status !== "paused") throw fail(409, "仅已暂停计划可恢复");
      p.status = "active";
      save();
      return cardView(p, "author", user);
    },

    // 投资者记录每日持仓与收益：仅进行中可记录；
    // 同一投资者同一交易日重复记录视为修正，覆盖更新而非追加。
    record(id, { user, date, position, equity, note }) {
      const p = find(id);
      if (!user) throw fail(403, "请先设置用户名");
      if (p.status !== "active") throw fail(409, "仅进行中的计划可记录，当前为「" + STATUS_LABEL[p.status] + "」");
      const d = String(date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw fail(400, "日期格式应为 YYYY-MM-DD");
      const dt = new Date(d + "T00:00:00Z");
      if (isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== d) throw fail(400, "无效日期: " + d);
      if (d > now().slice(0, 10)) throw fail(400, "不能记录未来日期");
      const pos = Number(position);
      if (!(pos >= 0 && pos <= 1)) throw fail(400, "持仓比例需在 0~1 之间");
      const eq = Number(equity);
      if (!Number.isFinite(eq) || eq <= 0) throw fail(400, "权益必须为正数");
      const existing = p.entries.find(e => e.user === user && e.date === d);
      if (existing) {
        existing.position = pos;
        existing.equity = eq;
        existing.note = note != null ? String(note) : existing.note;
        existing.at = now();
      } else {
        p.entries.push({
          id: "e" + ++data.entrySeq,
          user,
          date: d,
          position: pos,
          equity: eq,
          note: note ? String(note) : "",
          at: now(),
        });
      }
      save();
      return detailView(p, null, user);
    },
  };
  return store;
}

module.exports = { createPlanStore, STATUS_LABEL, computeStats };
