import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../server/app.js";

const baseEnv = {
  ZABBIX_API_URL: "https://zabbix.example/api_jsonrpc.php",
  ZABBIX_USERNAME: "console",
  ZABBIX_PASSWORD: "secret",
  APP_PORT: "3000",
  REQUEST_TIMEOUT_MS: "5000"
};

test("current problems are read through problem.get and sanitized", async () => {
  const calls = [];
  const app = createApp({ env: baseEnv, fetchImpl: mockZabbix(calls) });

  const response = await request(app).get("/api/problems").expect(200);

  assert.equal(response.body[0].name, "WAN packet loss");
  assert.equal(response.body[0].host.name, "Firewall");
  assert.equal(response.body[0].latestValue, "12");
  assert.equal(response.body[0].password, undefined);
  assert.ok(calls.some((call) => call.method === "problem.get"));
  assert.ok(calls.some((call) => call.method === "trigger.get"));
});

test("recent events are read through event.get", async () => {
  const calls = [];
  const app = createApp({ env: baseEnv, fetchImpl: mockZabbix(calls) });

  await request(app).get("/api/events").expect(200);

  assert.ok(calls.some((call) => call.method === "event.get"));
});

test("diagnostics checks Zabbix version and login", async () => {
  const calls = [];
  const app = createApp({ env: baseEnv, fetchImpl: mockZabbix(calls) });

  const response = await request(app).get("/api/diagnostics/zabbix").expect(200);

  assert.equal(response.body.configured, true);
  assert.equal(response.body.version, "7.0.0");
  assert.equal(response.body.login, true);
  assert.equal(response.body.apiUrl, "https://zabbix.example/api_jsonrpc.php");
  assert.ok(calls.some((call) => call.method === "apiinfo.version"));
  assert.ok(calls.some((call) => call.method === "user.login"));
});

test("login falls back to user parameter for older Zabbix APIs", async () => {
  const calls = [];
  const app = createApp({ env: baseEnv, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.method === "user.login" && body.params.username) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32602, message: "Invalid params.", data: "Invalid parameter \"username\"." }
        })
      };
    }
    return mockZabbix(calls)(_url, options);
  } });

  await request(app).get("/api/problems").expect(200);

  assert.ok(calls.some((call) => call.method === "user.login" && call.params.username));
  assert.ok(calls.some((call) => call.method === "user.login" && call.params.user));
});

test("acknowledge calls event.acknowledge unless read-only mode is enabled", async () => {
  const calls = [];
  const app = createApp({ env: baseEnv, fetchImpl: mockZabbix(calls) });

  await request(app).post("/api/problems/9001/acknowledge").send({ message: "Checking" }).expect(200);

  const ack = calls.find((call) => call.method === "event.acknowledge");
  assert.equal(ack.params.eventids[0], "9001");
  assert.equal(ack.params.message, "Checking");

  const readOnly = createApp({ env: { ...baseEnv, READ_ONLY: "true" }, fetchImpl: mockZabbix([]) });
  await request(readOnly).post("/api/problems/9001/acknowledge").send({ message: "Nope" }).expect(403);
});

test("Grafana disabled falls back gracefully", async () => {
  const app = createApp({ env: { ...baseEnv, GRAFANA_ENABLED: "false" }, fetchImpl: mockZabbix([]) });

  const config = await request(app).get("/api/config").expect(200);
  assert.equal(config.body.grafana.enabled, false);

  const panel = await request(app).get("/api/grafana/panel-url?uid=abc&panelId=1").expect(200);
  assert.equal(panel.body.url, null);
  await request(app).get("/embed/grafana/panel?uid=abc&panelId=1").expect(404);
});

test("Grafana enabled builds dashboard variable URLs without exposing API keys", async () => {
  const app = createApp({
    env: {
      ...baseEnv,
      GRAFANA_ENABLED: "true",
      GRAFANA_URL: "https://grafana.example",
      GRAFANA_API_KEY: "private-key"
    },
    fetchImpl: mockZabbix([])
  });

  const config = await request(app).get("/api/config").expect(200);
  assert.equal(config.body.grafana.enabled, true);
  assert.equal(JSON.stringify(config.body).includes("private-key"), false);

  const panel = await request(app).get("/api/grafana/panel-url?uid=nh&panelId=7&host=Firewall&item=Loss&interface=wan0&from=now-1h&to=now").expect(200);
  assert.match(panel.body.url, /var-host=Firewall/);
  assert.match(panel.body.url, /var-item=Loss/);
  assert.match(panel.body.url, /var-interface=wan0/);

  await request(app).get("/embed/grafana/panel?uid=nh&panelId=7").expect(302).expect("location", /grafana\.example/);
});

test("mobile layout keeps primary navigation horizontally scrollable", async () => {
  const cssResponse = await request(createApp({ env: baseEnv, fetchImpl: mockZabbix([]) })).get("/styles.css").expect(200);
  assert.match(cssResponse.text, /\.tabs\s*{/);
  assert.match(cssResponse.text, /overflow-x:\s*auto/);
  assert.match(cssResponse.text, /@media \(min-width: 720px\)/);
});

function mockZabbix(calls) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: body.id, result: resultFor(body.method, body.params) })
    };
  };
}

function resultFor(method) {
  if (method === "user.login") return "mock-session";
  if (method === "apiinfo.version") return "7.0.0";
  if (method === "problem.get" || method === "event.get") {
    return [
      {
        eventid: "9001",
        objectid: "3001",
        name: "WAN packet loss",
        severity: "5",
        clock: String(Math.floor(Date.now() / 1000) - 120),
        acknowledged: "0",
        opdata: "loss 12%",
        password: "must-not-leak",
        tags: [{ tag: "scope", value: "wan" }]
      }
    ];
  }
  if (method === "trigger.get") {
    return [
      {
        triggerid: "3001",
        description: "WAN packet loss",
        expression: "last(/Firewall/icmppingloss)>10",
        hosts: [{ hostid: "101", host: "fw01", name: "Firewall", status: "0" }],
        items: [{ itemid: "501", name: "ICMP loss", key_: "icmppingloss", lastvalue: "12", units: "%", lastclock: "100", value_type: "0" }]
      }
    ];
  }
  if (method === "host.get") {
    return [
      {
        hostid: "101",
        host: "fw01",
        name: "Firewall",
        status: "0",
        available: "1",
        groups: [{ groupid: "1", name: "Network" }],
        tags: [{ tag: "site", value: "home" }],
        interfaces: [{ interfaceid: "1", ip: "192.0.2.10", dns: "", type: "1", main: "1" }]
      }
    ];
  }
  if (method === "item.get") {
    return [
      { itemid: "501", hostid: "101", name: "ICMP loss", key_: "icmppingloss", lastvalue: "12", units: "%", lastclock: "100", value_type: "0" }
    ];
  }
  if (method === "history.get" || method === "trend.get") return [{ clock: "100", value: "12", value_avg: "12" }];
  if (method === "event.acknowledge") return { eventids: ["9001"] };
  return [];
}
