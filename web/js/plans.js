const { createApp } = Vue;

function todayStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const app = createApp({
  data() {
    return {
      role: localStorage.getItem("bt_role") || "investor",
      user: localStorage.getItem("bt_user") || "carol",
      plans: [],
      strategies: [],      // 作者建计划时选取「我的已发布版本」
      busy: false,
      err: "",
      newPlan: { key: "", name: "", note: "" },
      reviewComments: {},
      expanded: null,      // 展开明细的计划 id
      detail: null,        // 展开的计划详情（含每日记录）
      recordFor: null,     // 正在记录的计划 id
      record: { date: "", position: 1, equity: null, note: "" },
    };
  },
  computed: {
    myPublished() {
      const out = [];
      for (const s of this.strategies) {
        if (!s.mine) continue;
        for (const v of s.versions) {
          if (v.status === "published") {
            out.push({ key: s.id + ":" + v.v, sid: s.id, v: v.v, label: `${s.name}（${s.id} · v${v.v}）` });
          }
        }
      }
      return out;
    },
    pendingList() {
      return this.plans.filter(p => p.status === "pending" && p.author !== this.user);
    },
    myEntries() {
      if (!this.detail || !this.detail.entries) return [];
      return this.detail.entries
        .filter(e => e.user === this.user)
        .slice()
        .sort((a, b) => (a.date < b.date ? -1 : 1));
    },
  },
  methods: {
    headers() { return { "x-role": this.role, "x-user": this.user }; },
    fmtTime(t) { return t ? t.slice(0, 16).replace("T", " ") : "—"; },
    pct(v) { return v == null ? "—" : (v * 100).toFixed(2) + "%"; },
    async guard(fn) {
      this.busy = true;
      this.err = "";
      try { await fn(); } catch (e) { this.err = e.message; } finally { this.busy = false; }
    },
    async load() {
      const r = await API.plans.list(this.headers());
      this.plans = r.plans;
      if (this.role === "author") {
        const s = await API.strategies.list(this.headers());
        this.strategies = s.strategies;
      }
    },
    onRoleChange() {
      localStorage.setItem("bt_role", this.role);
      localStorage.setItem("bt_user", this.user);
      this.expanded = null;
      this.detail = null;
      this.recordFor = null;
      this.guard(() => this.load());
    },
    createPlan() {
      this.guard(async () => {
        const [sid, v] = this.newPlan.key.split(":");
        await API.plans.create(
          { name: this.newPlan.name, strategy_id: sid, version: Number(v), note: this.newPlan.note },
          this.headers()
        );
        this.newPlan = { key: "", name: "", note: "" };
        await this.load();
      });
    },
    act(p, action) {
      this.guard(async () => {
        await API.plans.action(p.id, action, {}, this.headers());
        await this.load();
        if (this.expanded === p.id) await this.refreshDetail(p);
      });
    },
    review(p, action) {
      const comment = this.reviewComments[p.id] || "";
      if (action === "reject" && !comment) { this.err = "驳回必须填写评审意见"; return; }
      this.guard(async () => {
        await API.plans.action(p.id, "review", { action, comment }, this.headers());
        this.reviewComments[p.id] = "";
        await this.load();
      });
    },
    startRecord(p) {
      this.recordFor = this.recordFor === p.id ? null : p.id;
      this.record = { date: todayStr(), position: 1, equity: null, note: "" };
    },
    saveRecord(p) {
      this.guard(async () => {
        await API.plans.record(p.id, { ...this.record }, this.headers());
        this.recordFor = null;
        await this.load();
        if (this.expanded === p.id) await this.refreshDetail(p);
      });
    },
    async refreshDetail(p) {
      this.detail = await API.plans.get(p.id, this.headers());
      this.$nextTick(() => this.drawMine());
    },
    toggleDetail(p) {
      if (this.expanded === p.id) { this.expanded = null; this.detail = null; return; }
      this.expanded = p.id;
      this.guard(() => this.refreshDetail(p));
    },
    drawMine() {
      // canvas 位于 v-for 内，Vue3 下 ref 为数组
      const c = Array.isArray(this.$refs.eqchart) ? this.$refs.eqchart[0] : this.$refs.eqchart;
      if (c && this.myEntries.length) {
        Charts.series(c, this.myEntries.map((e, i) => [i, e.equity]), { color: "#4f8cff" });
      }
    },
  },
  mounted() {
    localStorage.setItem("bt_role", this.role);
    localStorage.setItem("bt_user", this.user);
    this.guard(() => this.load());
  },
});

app.mount("#app");
