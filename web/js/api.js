const API = {
  async _req(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) {
      let msg = r.statusText;
      try { const j = await r.json(); msg = j.error || j.detail || msg; } catch (e) {}
      throw new Error(msg);
    }
    return r.json();
  },
  system() { return this._req("/api/system"); },
  market(params) {
    return this._req("/api/market", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  },
  backtest(market, options) {
    return this._req("/api/backtest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market, options }),
    });
  },
  montecarlo(equity, nPaths, nSteps, seed) {
    return this._req("/api/montecarlo", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ equity, nPaths, nSteps, seed }),
    });
  },
  strategies: {
    list(headers) {
      return API._req("/api/strategies", { headers: headers || {} });
    },
    create(body, headers) {
      return API._req("/api/strategies", {
        method: "POST", headers: { "Content-Type": "application/json", ...(headers || {}) },
        body: JSON.stringify(body),
      });
    },
    addVersion(id, body, headers) {
      return API._req(`/api/strategies/${id}/versions`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(headers || {}) },
        body: JSON.stringify(body || {}),
      });
    },
    updateDraft(id, v, body, headers) {
      return API._req(`/api/strategies/${id}/versions/${v}`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...(headers || {}) },
        body: JSON.stringify(body),
      });
    },
    action(id, v, action, body, headers) {
      return API._req(`/api/strategies/${id}/versions/${v}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(headers || {}) },
        body: JSON.stringify(body || {}),
      });
    },
  },
  plans: {
    list(headers) {
      return API._req("/api/plans", { headers: headers || {} });
    },
    create(body, headers) {
      return API._req("/api/plans", {
        method: "POST", headers: { "Content-Type": "application/json", ...(headers || {}) },
        body: JSON.stringify(body),
      });
    },
    get(id, headers) {
      return API._req(`/api/plans/${id}`, { headers: headers || {} });
    },
    action(id, action, body, headers) {
      return API._req(`/api/plans/${id}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(headers || {}) },
        body: JSON.stringify(body || {}),
      });
    },
    record(id, body, headers) {
      return API._req(`/api/plans/${id}/entries`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(headers || {}) },
        body: JSON.stringify(body),
      });
    },
  },
};
