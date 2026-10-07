const { createApp } = Vue;

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

const app = createApp({
  data() {
    return {
      role: localStorage.getItem("bt_role") || "author",
      user: localStorage.getItem("bt_user") || "alice",
      plans: [],
      publishedOptions: [],
      busy: false,
      err: "",
      newPlan: { name: "", ref: "", note: "" },
      reviewComments: {},
      detailFor: null,     // 展开详情的计划 id
      detail: null,        // 详情（含 entries 与统计）
      entry: { date: todayStr(), position: 0.5, equity: 100000, note: "" },
      curveUser: "__agg__",
    };
  },
  computed: {
    listTitle() {
      return this.role === "reviewer" ? "全部计划" : this.role === "author" ? "我的计划与公开计划" : "跟踪计划";
    },
    pendingList() {
      return this.plans.filter(p => p.status === "pending" && p.author !== this.user);
    },
    recentEntries() {
      return this.detail ? this.detail.entries.slice(-30).reverse() : [];
    },
    curvePoints() {
      if (!this.detail) return [];
      if (this.curveUser === "__agg__") {
        return (this.detail.stats.aggregate && this.detail.stats.aggregate.curve) || [];
      }
      return this.detail.entries.filter(e => e.user === this.curveUser).map((e, i) => [i, e.equity]);
    },
  },
  methods: {
    headers() { return { "x-role": this.role, "x-user": this.user }; },
    fmtTime(t) { return t ? t.slice(0, 16).replace("T", " ") : "—"; },
    async guard(fn) {
      this.busy = true;
      this.err = "";
      try { await fn(); } catch (e) { this.err = e.message; } finally { this.busy = false; }
    },
    async load() {
      const r = await API.plans.list(this.headers());
      this.plans = r.plans;
    },
    async loadPublished() {
      const r = await API.strategies.list(this.headers());
      const out = [];
      for (const s of r.strategies) {
        for (const v of s.versions) {
          if (v.status === "published") out.push({ ref: s.id + ":" + v.v, label: `${s.name}（${s.id} v${v.v}）` });
        }
      }
      this.publishedOptions = out;
    },
    onRoleChange() {
      localStorage.setItem("bt_role", this.role);
      localStorage.setItem("bt_user", this.user);
      this.detailFor = null;
      this.detail = null;
      this.guard(async () => { await this.load(); await this.loadPublished(); });
    },
    createPlan() {
      this.guard(async () => {
        const [sid, v] = this.newPlan.ref.split(":");
        await API.plans.create({ name: this.newPlan.name, strategy_id: sid, strategy_v: Number(v), note: this.newPlan.note }, this.headers());
        this.newPlan = { name: "", ref: "", note: "" };
        await this.load();
      });
    },
    act(p, action) {
      this.guard(async () => {
        await API.plans.action(p.id, action, {}, this.headers());
        if (this.detailFor === p.id) this.detail = await API.plans.get(p.id, this.headers());
        await this.load();
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
    toggleDetail(p) {
      if (this.detailFor === p.id) { this.detailFor = null; this.detail = null; return; }
      this.guard(async () => {
        const d = await API.plans.get(p.id, this.headers());
        this.detail = d;
        this.detailFor = p.id;
        this.curveUser = d.stats.aggregate ? "__agg__" : (d.stats.investors[0] ? d.stats.investors[0].user : "");
        this.entry = { date: todayStr(), position: 0.5, equity: 100000, note: "" };
        this.$nextTick(() => this.drawCurve());
      });
    },
    recordEntry() {
      this.guard(async () => {
        this.detail = await API.plans.record(this.detailFor, { ...this.entry }, this.headers());
        this.$nextTick(() => this.drawCurve());
        await this.load();
      });
    },
    drawCurve() {
      let c = this.$refs.pchart;
      if (Array.isArray(c)) c = c[0];
      if (!c) return;
      Charts.series(c, this.curvePoints, { color: "#4f8cff" });
    },
  },
  mounted() {
    localStorage.setItem("bt_role", this.role);
    localStorage.setItem("bt_user", this.user);
    this.guard(async () => { await this.load(); await this.loadPublished(); });
  },
});

app.mount("#app");
