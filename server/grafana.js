export class GrafanaClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  settings() {
    return {
      enabled: this.config.grafanaConfigured,
      baseUrl: this.config.grafanaConfigured ? this.config.grafanaUrl : "",
      authProxy: Boolean(this.config.grafanaApiKey)
    };
  }

  panelUrl({ uid, panelId, from = "now-6h", to = "now", vars = {}, kiosk = true }) {
    if (!this.config.grafanaConfigured || !uid || !panelId) return null;
    const url = new URL(`/d-solo/${encodeURIComponent(uid)}/nichhome`, this.config.grafanaUrl);
    url.searchParams.set("panelId", panelId);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    if (kiosk) url.searchParams.set("kiosk", "1");
    for (const [key, value] of Object.entries(vars)) {
      if (value) url.searchParams.set(`var-${key}`, value);
    }
    return url.toString();
  }

  dashboardUrl({ uid, vars = {}, from = "now-6h", to = "now" }) {
    if (!this.config.grafanaConfigured || !uid) return null;
    const url = new URL(`/d/${encodeURIComponent(uid)}/nichhome`, this.config.grafanaUrl);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    for (const [key, value] of Object.entries(vars)) {
      if (value) url.searchParams.set(`var-${key}`, value);
    }
    return url.toString();
  }

  async proxy(path) {
    if (!this.config.grafanaConfigured) {
      const error = new Error("Grafana is disabled.");
      error.status = 404;
      throw error;
    }
    const upstream = new URL(path, this.config.grafanaUrl);
    const headers = {};
    if (this.config.grafanaApiKey) headers.authorization = `Bearer ${this.config.grafanaApiKey}`;
    const response = await this.fetch(upstream, { headers });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") || "application/octet-stream",
      body: Buffer.from(await response.arrayBuffer())
    };
  }
}
