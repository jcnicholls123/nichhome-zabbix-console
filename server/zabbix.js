import { sanitize, text } from "./sanitize.js";

const SEVERITIES = ["Not classified", "Information", "Warning", "Average", "High", "Disaster"];

export class ZabbixClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.auth = null;
    this.authExpiresAt = 0;
    this.id = 1;
  }

  async call(method, params = {}, { auth = true } = {}) {
    if (!this.config.zabbixConfigured) {
      const error = new Error("Zabbix API is not configured.");
      error.status = 503;
      throw error;
    }

    const body = {
      jsonrpc: "2.0",
      method,
      params,
      id: this.id++
    };

    if (auth && !this.config.zabbixTokenAuth) body.auth = await this.login();

    try {
      return await this.post(body);
    } catch (error) {
      error.message = `Zabbix ${method} failed: ${error.message}`;
      throw error;
    }
  }

  async login() {
    if (this.config.zabbixTokenAuth) return null;
    const now = Date.now();
    if (this.auth && now < this.authExpiresAt) return this.auth;

    let result;
    try {
      result = await this.call(
        "user.login",
        {
          username: this.config.zabbixUsername,
          password: this.config.zabbixPassword
        },
        { auth: false }
      );
    } catch (error) {
      if (!/invalid parameter|unexpected parameter|username/i.test(error.message)) throw error;
      result = await this.call(
        "user.login",
        {
          user: this.config.zabbixUsername,
          password: this.config.zabbixPassword
        },
        { auth: false }
      );
    }
    this.auth = result;
    this.authExpiresAt = now + this.config.sessionTtlSeconds * 1000;
    return this.auth;
  }

  async diagnostics() {
    const result = {
      configured: this.config.zabbixConfigured,
      tokenAuth: this.config.zabbixTokenAuth,
      apiUrl: redactUrl(this.config.zabbixApiUrl),
      version: null,
      login: false
    };
    if (!this.config.zabbixConfigured) return result;

    try {
      result.version = await this.call("apiinfo.version", {}, { auth: false });
    } catch (error) {
      result.versionError = error.message;
      return result;
    }
    if (this.config.zabbixTokenAuth) {
      result.login = true;
    } else {
      try {
        await this.login();
        result.login = true;
      } catch (error) {
        result.loginError = error.message;
      }
    }
    return result;
  }

  async post(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetch(this.config.zabbixApiUrl, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`Zabbix HTTP ${response.status}`);
        error.status = 502;
        throw error;
      }
      const payload = await response.json();
      if (payload.error) {
        const message = [payload.error.message, payload.error.data].filter(Boolean).join(": ") || "Zabbix API error";
        const error = new Error(message);
        error.status = 502;
        throw error;
      }
      return sanitize(payload.result);
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error(`Zabbix API timed out after ${this.config.requestTimeoutMs}ms`);
        timeoutError.status = 504;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  headers() {
    const headers = { "content-type": "application/json" };
    if (this.config.zabbixTokenAuth) headers.authorization = `Bearer ${this.config.zabbixApiToken}`;
    return headers;
  }

  async currentProblems(filters = {}) {
    const params = {
      output: ["eventid", "objectid", "name", "severity", "clock", "acknowledged", "opdata", "r_eventid"],
      selectAcknowledges: ["userid", "clock", "message", "action"],
      selectTags: "extend",
      recent: false,
      sortfield: ["eventid"],
      sortorder: "DESC",
      limit: 100
    };
    applyProblemFilters(params, filters);
    const problems = await this.call("problem.get", params);
    return this.enrichProblems(problems);
  }

  async recentEvents(filters = {}) {
    const params = {
      output: ["eventid", "objectid", "name", "severity", "clock", "value", "acknowledged", "opdata", "r_eventid"],
      selectTags: "extend",
      source: 0,
      object: 0,
      sortfield: ["clock", "eventid"],
      sortorder: "DESC",
      limit: Number(filters.limit || 40)
    };
    applyProblemFilters(params, filters);
    const events = await this.call("event.get", params);
    return this.enrichProblems(events);
  }

  async hosts(filters = {}) {
    const params = {
      output: ["hostid", "host", "name", "status", "available", "description"],
      selectGroups: ["groupid", "name"],
      selectTags: "extend",
      selectInterfaces: ["interfaceid", "ip", "dns", "type", "main", "available"],
      selectInventory: ["location", "site_notes", "type", "os"],
      sortfield: "name",
      limit: 200
    };
    if (filters.search) params.search = { name: filters.search, host: filters.search };
    if (filters.groupids) params.groupids = String(filters.groupids).split(",");

    const hosts = await this.call("host.get", params);
    const problemCounts = await this.problemCountsByHost();
    return hosts.map((host) => normalizeHost(host, problemCounts.get(host.hostid) || 0));
  }

  async hostDetail(hostid) {
    const [hosts, problems, latestValues] = await Promise.all([
      this.call("host.get", {
        output: ["hostid", "host", "name", "status", "available", "description"],
        hostids: [hostid],
        selectGroups: ["groupid", "name"],
        selectTags: "extend",
        selectInterfaces: ["interfaceid", "ip", "dns", "type", "main", "available"],
        selectInventory: ["location", "site_notes", "type", "os"]
      }),
      this.currentProblems({ hostids: hostid }),
      this.latestValues(hostid)
    ]);
    if (!hosts[0]) {
      const error = new Error("Host not found");
      error.status = 404;
      throw error;
    }
    return { host: normalizeHost(hosts[0], problems.length), problems, latestValues };
  }

  async problemDetail(eventid) {
    const events = await this.call("event.get", {
      output: ["eventid", "objectid", "name", "severity", "clock", "value", "acknowledged", "opdata", "r_eventid"],
      eventids: [eventid],
      selectAcknowledges: "extend",
      selectTags: "extend"
    });
    if (!events[0]) {
      const error = new Error("Problem not found");
      error.status = 404;
      throw error;
    }
    const [problem] = await this.enrichProblems(events);
    const trigger = await this.trigger(problem.objectid);
    return { problem, trigger };
  }

  async trigger(triggerid) {
    const triggers = await this.call("trigger.get", {
      output: "extend",
      triggerids: [triggerid],
      selectHosts: ["hostid", "host", "name"],
      selectItems: ["itemid", "name", "key_", "lastvalue", "lastclock", "units", "value_type"]
    });
    return triggers[0] || null;
  }

  async latestValues(hostid) {
    const items = await this.call("item.get", {
      output: ["itemid", "hostid", "name", "key_", "lastvalue", "lastclock", "units", "value_type"],
      hostids: [hostid],
      monitored: true,
      sortfield: "name",
      limit: 18
    });
    return items.map(normalizeItem);
  }

  async graph(itemid, range = "6h") {
    const item = (await this.call("item.get", {
      output: ["itemid", "name", "key_", "units", "value_type"],
      itemids: [itemid]
    }))[0];
    if (!item) return { item: null, points: [] };

    const seconds = rangeToSeconds(range);
    const timeFrom = Math.floor(Date.now() / 1000) - seconds;
    const valueType = Number(item.value_type || 0);
    const useTrends = seconds > 172800 && [0, 3].includes(valueType);
    const method = useTrends ? "trend.get" : "history.get";
    const params = useTrends
      ? { output: ["clock", "value_avg"], itemids: [itemid], time_from: timeFrom, sortfield: "clock", sortorder: "ASC", limit: 240 }
      : { output: "extend", history: valueType, itemids: [itemid], time_from: timeFrom, sortfield: "clock", sortorder: "ASC", limit: 240 };
    const rows = await this.call(method, params);
    return {
      item: normalizeItem(item),
      points: rows.map((row) => ({
        clock: Number(row.clock),
        value: Number(row.value_avg ?? row.value ?? 0)
      }))
    };
  }

  async acknowledge(eventid, message) {
    if (this.config.readOnly) {
      const error = new Error("Read-only mode is enabled.");
      error.status = 403;
      throw error;
    }
    return this.call("event.acknowledge", {
      eventids: [eventid],
      action: 6,
      message: text(message, "Acknowledged from NichHome Zabbix Console").slice(0, 255)
    });
  }

  async enrichProblems(problems) {
    const triggerIds = [...new Set(problems.map((problem) => problem.objectid).filter(Boolean))];
    const triggers = triggerIds.length
      ? await this.call("trigger.get", {
          output: ["triggerid", "description", "expression"],
          triggerids: triggerIds,
          selectHosts: ["hostid", "host", "name"],
          selectItems: ["itemid", "name", "key_", "lastvalue", "lastclock", "units", "value_type"]
        })
      : [];
    const byId = new Map(triggers.map((trigger) => [trigger.triggerid, trigger]));
    return problems.map((problem) => normalizeProblem(problem, byId.get(problem.objectid)));
  }

  async problemCountsByHost() {
    const problems = await this.currentProblems();
    const counts = new Map();
    for (const problem of problems) {
      if (problem.host?.hostid) counts.set(problem.host.hostid, (counts.get(problem.host.hostid) || 0) + 1);
    }
    return counts;
  }
}

function applyProblemFilters(params, filters) {
  if (filters.severity !== undefined && filters.severity !== "") params.severities = String(filters.severity).split(",").map(Number);
  if (filters.hostids) params.hostids = String(filters.hostids).split(",");
  if (filters.groupids) params.groupids = String(filters.groupids).split(",");
  if (filters.acknowledged === "true") params.acknowledged = true;
  if (filters.acknowledged === "false") params.acknowledged = false;
  if (filters.tag) params.tags = [{ tag: filters.tag, operator: 2 }];
  if (filters.search) params.search = { name: filters.search };
}

function normalizeProblem(problem, trigger) {
  const item = normalizeItem(trigger?.items?.[0] || {});
  return {
    eventid: problem.eventid,
    objectid: problem.objectid,
    name: text(problem.name || trigger?.description, "Unnamed problem"),
    severity: Number(problem.severity || 0),
    severityName: SEVERITIES[Number(problem.severity || 0)] || "Unknown",
    clock: Number(problem.clock || 0),
    durationSeconds: Math.max(0, Math.floor(Date.now() / 1000) - Number(problem.clock || 0)),
    acknowledged: problem.acknowledged === true || problem.acknowledged === "1",
    opdata: text(problem.opdata),
    tags: Array.isArray(problem.tags) ? problem.tags.map((tag) => ({ tag: text(tag.tag), value: text(tag.value) })) : [],
    host: trigger?.hosts?.[0] ? normalizeHost(trigger.hosts[0], 0) : null,
    item,
    latestValue: item.latestValue
  };
}

function normalizeHost(host, activeProblems) {
  return {
    hostid: host.hostid,
    host: text(host.host),
    name: text(host.name || host.host),
    status: host.status === "0" || host.status === 0 ? "enabled" : "disabled",
    available: String(host.available || "0"),
    activeProblems,
    groups: Array.isArray(host.groups) ? host.groups.map((group) => ({ groupid: group.groupid, name: text(group.name) })) : [],
    tags: Array.isArray(host.tags) ? host.tags.map((tag) => ({ tag: text(tag.tag), value: text(tag.value) })) : [],
    interfaces: Array.isArray(host.interfaces) ? host.interfaces.map((iface) => ({ ...sanitize(iface), ip: text(iface.ip), dns: text(iface.dns) })) : [],
    inventory: sanitize(host.inventory || {})
  };
}

function normalizeItem(item) {
  return {
    itemid: item.itemid,
    name: text(item.name),
    key: text(item.key_),
    latestValue: text(item.lastvalue),
    lastclock: Number(item.lastclock || 0),
    units: text(item.units),
    valueType: Number(item.value_type || 0)
  };
}

function rangeToSeconds(range) {
  const match = String(range).match(/^(\d+)([hdw])$/);
  if (!match) return 21600;
  const amount = Number(match[1]);
  return amount * { h: 3600, d: 86400, w: 604800 }[match[2]];
}

function redactUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "";
  }
}
