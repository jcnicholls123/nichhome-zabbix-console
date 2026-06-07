import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { loadConfig } from "./config.js";
import { ZabbixClient } from "./zabbix.js";
import { GrafanaClient } from "./grafana.js";

export function createApp({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = loadConfig(env);
  const zabbix = new ZabbixClient(config, fetchImpl);
  const grafana = new GrafanaClient(config, fetchImpl);
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "128kb" }));
  app.use(rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false }));
  app.use(express.static("public", { extensions: ["html"] }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, zabbixConfigured: config.zabbixConfigured, grafanaEnabled: config.grafanaConfigured });
  });

  app.get("/api/config", (_req, res) => {
    res.json({
      zabbixConfigured: config.zabbixConfigured,
      grafana: grafana.settings(),
      readOnly: config.readOnly
    });
  });

  app.get("/api/diagnostics/zabbix", asyncHandler(async (_req, res) => {
    res.json(await zabbix.diagnostics());
  }));

  app.get("/api/overview", asyncHandler(async (req, res) => {
    const [problems, events, hosts] = await Promise.all([
      zabbix.currentProblems(req.query),
      zabbix.recentEvents({ limit: 12 }),
      zabbix.hosts()
    ]);
    const bySeverity = [0, 1, 2, 3, 4, 5].map((severity) => ({
      severity,
      count: problems.filter((problem) => problem.severity === severity).length
    }));
    res.json({
      bySeverity,
      activeProblems: problems.slice(0, 12),
      recentEvents: events,
      hosts: {
        total: hosts.length,
        enabled: hosts.filter((host) => host.status === "enabled").length,
        critical: hosts.filter((host) => host.activeProblems > 0).slice(0, 8)
      },
      grafana: grafana.settings()
    });
  }));

  app.get("/api/problems", asyncHandler(async (req, res) => {
    res.json(await zabbix.currentProblems(req.query));
  }));

  app.get("/api/events", asyncHandler(async (req, res) => {
    res.json(await zabbix.recentEvents(req.query));
  }));

  app.get("/api/problems/:eventid", asyncHandler(async (req, res) => {
    res.json(await zabbix.problemDetail(req.params.eventid));
  }));

  app.post("/api/problems/:eventid/acknowledge", asyncHandler(async (req, res) => {
    res.json(await zabbix.acknowledge(req.params.eventid, req.body?.message));
  }));

  app.get("/api/hosts", asyncHandler(async (req, res) => {
    res.json(await zabbix.hosts(req.query));
  }));

  app.get("/api/hosts/:hostid", asyncHandler(async (req, res) => {
    res.json(await zabbix.hostDetail(req.params.hostid));
  }));

  app.get("/api/items/:itemid/graph", asyncHandler(async (req, res) => {
    res.json(await zabbix.graph(req.params.itemid, req.query.range));
  }));

  app.get("/api/grafana/panel-url", (req, res) => {
    res.json({ url: grafana.panelUrl({ uid: req.query.uid, panelId: req.query.panelId, from: req.query.from, to: req.query.to, vars: req.query }) });
  });

  app.get("/api/grafana/dashboard-url", (req, res) => {
    res.json({ url: grafana.dashboardUrl({ uid: req.query.uid, vars: req.query, from: req.query.from, to: req.query.to }) });
  });

  app.get("/embed/grafana/panel", (req, res) => {
    const url = grafana.panelUrl({ uid: req.query.uid, panelId: req.query.panelId, from: req.query.from, to: req.query.to, vars: req.query });
    if (!url) return res.status(404).send("Grafana panel unavailable");
    return res.redirect(url);
  });

  app.get("/link/grafana/dashboard", (req, res) => {
    const url = grafana.dashboardUrl({ uid: req.query.uid, vars: req.query, from: req.query.from, to: req.query.to });
    if (!url) return res.status(404).send("Grafana dashboard unavailable");
    return res.redirect(url);
  });

  app.get("/api/grafana/proxy/*", asyncHandler(async (req, res) => {
    const proxied = await grafana.proxy(req.params[0] + (req.url.includes("?") ? `?${req.url.split("?")[1]}` : ""));
    res.status(proxied.status).type(proxied.contentType).send(proxied.body);
  }));

  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    res.status(status).json({ error: status >= 500 ? "Upstream service error" : err.message });
  });

  return app;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
