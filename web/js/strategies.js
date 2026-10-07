const { createApp } = Vue;

const DEFAULT_SNAPSHOT = {
  market: { seed: 42, days: 400, start: 100, drift: 0.0004, vol: 0.012 },
  strategy: { type: "ma_cross", fast: 10, slow: 30 },
  trade: {
    cash: 100000, feeRate: 0.0005, slippageBp: 5, positionRatio: 1,
    stopMode: "fixed", stopLoss: 0.05, takeProfit: 0.15,
    atrN: 14, atrStopMult: 2, atrTargetMult: 4, atrVolN: 50, volLowMult: 0.8, volHighMult: 1.5,
  },
};

const app = createApp({
  data() {
    return {
      role: localStorage.getItem("bt_role") || "author",
      user: localStorage.getItem("bt_user") || "alice",
      strategies: [],
      busy: false,
      err: "",
      newName: "",
      editing: null,       // { sid, v, text, note }
      editErr: "",
      reviewComments: {},
      historyFor: null,    // { sid, v, runs }
      result: null,
    };
  },
  computed: {
    pendingList() {
      const out = [];
      for (const s of this.strategies) {
        for (const v of s.versions) {
          if (v.status === "pending" && s.author !== this.user) {
            out.push({ sid: s.id, name: s.name, author: s.author, v: v.v, note: v.note, submitted_at: v.submitted_at, snapshot: v.snapshot });
          }
        }
      }
      return out;
    },
  },
  methods: {
    headers() { return { "x-role": this.role, "x-user": this.user }; },
    fmtTime(t) { return t ? t.slice(0, 16).replace("T", " ") : "—"; },
    fmtSnap(snap) { return JSON.stringify(snap, null, 2); },
    async guard(fn) {
      this.busy = true;
      this.err = "";
      try { await fn(); } catch (e) { this.err = e.message; } finally { this.busy = false; }
    },
    async load() {
      const r = await API.strategies.list(this.headers());
      this.strategies = r.strategies;
    },
    onRoleChange() {
      localStorage.setItem("bt_role", this.role);
      localStorage.setItem("bt_user", this.user);
      this.editing = null;
      this.historyFor = null;
      this.result = null;
      this.guard(() => this.load());
    },
    createStrategy() {
      this.guard(async () => {
        await API.strategies.create({ name: this.newName, snapshot: DEFAULT_SNAPSHOT }, this.headers());
        this.newName = "";
        await this.load();
      });
    },
    addVersion(s, from) {
      this.guard(async () => {
        await API.strategies.addVersion(s.id, { from }, this.headers());
        await this.load();
      });
    },
    startEdit(s, v) {
      this.editing = { sid: s.id, v: v.v, text: JSON.stringify(v.snapshot, null, 2), note: v.note || "" };
      this.editErr = "";
    },
    saveEdit(s) {
      let snap;
      try { snap = JSON.parse(this.editing.text); } catch (e) { this.editErr = "JSON 解析失败：" + e.message; return; }
      this.guard(async () => {
        await API.strategies.updateDraft(s.id, this.editing.v, { snapshot: snap, note: this.editing.note }, this.headers());
        this.editing = null;
        await this.load();
      });
    },
    submit(s, v) { this.guard(() => API.strategies.action(s.id, v.v, "submit", {}, this.headers()).then(() => this.load())); },
    retract(s, v) { this.guard(() => API.strategies.action(s.id, v.v, "retract", {}, this.headers()).then(() => this.load())); },
    reopen(s, v) { this.guard(() => API.strategies.action(s.id, v.v, "reopen", {}, this.headers()).then(() => this.load())); },
    withdraw(s, v) {
      this.guard(async () => {
        await API.strategies.action(s.id, v.v, "withdraw", {}, this.headers());
        await this.load();
      });
    },
    review(item, action) {
      const key = item.sid + "-" + item.v;
      const comment = this.reviewComments[key] || "";
      if (action === "reject" && !comment) { this.err = "驳回必须填写评审意见"; return; }
      this.guard(async () => {
        await API.strategies.action(item.sid, item.v, "review", { action, comment }, this.headers());
        this.reviewComments[key] = "";
        await this.load();
      });
    },
    runVersion(s, v) {
      this.guard(async () => {
        const r = await API.strategies.action(s.id, v.v, "run", {}, this.headers());
        this.result = r;
        this.$nextTick(() => {
          if (this.$refs.echart) Charts.series(this.$refs.echart, r.equity, { color: "#4f8cff" });
          if (this.$refs.dchart) Charts.series(this.$refs.dchart, r.drawdown, { color: "#e2533e", baseline: 0 });
          if (this.$refs.mchart && r.mc.quantiles) Charts.band(this.$refs.mchart, r.mc.quantiles, {});
        });
        await this.load();
      });
    },
    toggleHistory(sid, v) {
      if (this.historyFor && this.historyFor.sid === sid && this.historyFor.v === v) { this.historyFor = null; return; }
      const s = this.strategies.find(x => x.id === sid);
      const ver = s && s.versions.find(x => x.v === v);
      this.historyFor = ver ? { sid, v, runs: ver.runs.slice().reverse() } : null;
    },
    viewRun(s, v, run) {
      this.result = {
        name: s.name, version: v, status_label: "历史记录", run_id: run.id, run_at: run.at,
        stats: run.stats, trades: [], equity: run.equity, drawdown: [],
        mc: { quantiles: null, prob_loss: run.mc_prob_loss, seed: run.mc_seed },
      };
      this.$nextTick(() => {
        if (this.$refs.echart) Charts.series(this.$refs.echart, run.equity, { color: "#4f8cff" });
        if (this.$refs.dchart) Charts.series(this.$refs.dchart, [], {}); // 历史记录不含回撤序列，清空残留
      });
    },
    openInWorkbench(v) {
      localStorage.setItem("bt_open_snapshot", JSON.stringify(v.snapshot));
      location.href = "/";
    },
  },
  mounted() {
    localStorage.setItem("bt_role", this.role);
    localStorage.setItem("bt_user", this.user);
    this.guard(() => this.load());
  },
});

app.mount("#app");
