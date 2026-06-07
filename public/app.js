const state = {
  route: "overview",
  config: null,
  search: "",
  settings: loadSettings()
};

const view = document.querySelector("#view");
const toast = document.querySelector("#toast");
const searchInput = document.querySelector("#globalSearch");

document.querySelector("#refreshButton").addEventListener("click", () => render());
searchInput.addEventListener("input", debounce((event) => {
  state.search = event.target.value.trim();
  render();
}, 250));
window.addEventListener("hashchange", () => route());

init();

async function init() {
  state.config = await api("/api/config");
  route();
}

function route() {
  const raw = location.hash.replace(/^#/, "") || "overview";
  state.route = raw;
  document.querySelectorAll(".tabs a").forEach((link) => link.classList.toggle("active", link.dataset.route === raw.split("/")[0]));
  render();
}

async function render() {
  try {
    const [name, id] = state.route.split("/");
    if (name === "overview") return renderOverview();
    if (name === "problems") return id ? renderProblemDetail(id) : renderProblems();
    if (name === "hosts") return id ? renderHostDetail(id) : renderHosts();
    if (name === "dashboards") return renderDashboards();
    if (name === "settings") return renderSettings();
    location.hash = "#overview";
  } catch (error) {
    view.innerHTML = errorPanel(error.message || "Unable to load view.");
  }
}

async function renderOverview() {
  view.innerHTML = loading("Overview");
  const data = await api(`/api/overview${query({ search: state.search })}`);
  const activeTotal = data.bySeverity.reduce((sum, item) => sum + item.count, 0);
  view.innerHTML = `
    ${head("Overview", "Live state from Zabbix, shaped for fast checks from any screen.")}
    <section class="grid stats">
      ${stat("Active problems", activeTotal)}
      ${stat("Enabled hosts", data.hosts.enabled)}
      ${stat("Critical hosts", data.hosts.critical.length)}
      ${stat("Grafana", data.grafana.enabled ? "On" : "Off")}
    </section>
    <section class="grid split" style="margin-top:12px">
      <div class="panel">
        <div class="panel-head"><h2>Active Problems</h2><a class="button" href="#problems">Open</a></div>
        <div class="list">${data.activeProblems.map(problemCard).join("") || empty("No active problems.")}</div>
      </div>
      <div class="grid">
        <div class="panel">
          <div class="panel-head"><h2>Severity</h2></div>
          <div class="severity-row" style="padding:12px">${data.bySeverity.map(severityPill).join("")}</div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Quick WAN</h2></div>
          <div class="card">${grafanaOrFallback("wan", "WAN graph area")}</div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Critical Hosts</h2></div>
          <div class="list">${data.hosts.critical.map(hostCard).join("") || empty("No hosts with active problems.")}</div>
        </div>
      </div>
    </section>
    <section class="panel" style="margin-top:12px">
      <div class="panel-head"><h2>Recent Events</h2><a class="button" href="#problems">Problems</a></div>
      <div class="list">${data.recentEvents.map(problemCard).join("") || empty("No recent events.")}</div>
    </section>
  `;
  drawDemoGraphs();
}

async function renderProblems() {
  view.innerHTML = loading("Problems");
  const filters = getFilters();
  const problems = await api(`/api/problems${query(filters)}`);
  view.innerHTML = `
    ${head("Problems", "Current Zabbix problems with severity, acknowledgement, host, item, and operational data.")}
    ${problemFilters(filters)}
    <section class="panel">
      <div class="panel-head"><h2>${problems.length} Current Problems</h2></div>
      <div class="list">${problems.map(problemCard).join("") || empty("No matching current problems.")}</div>
    </section>
  `;
  bindFilters();
}

async function renderProblemDetail(eventid) {
  view.innerHTML = loading("Problem");
  const data = await api(`/api/problems/${encodeURIComponent(eventid)}`);
  const problem = data.problem;
  view.innerHTML = `
    ${head("Problem Detail", escapeHtml(problem.name))}
    <section class="grid split">
      <div class="panel">
        <div class="panel-head"><h2>Event ${problem.eventid}</h2><span class="severity sev-${problem.severity}">${problem.severityName}</span></div>
        <div class="list">
          ${kv("Host", problem.host ? `<a href="#hosts/${problem.host.hostid}">${escapeHtml(problem.host.name)}</a>` : "Unknown")}
          ${kv("Item", problem.item?.name || "Unknown")}
          ${kv("Latest value", latest(problem.item))}
          ${kv("Operational data", problem.opdata || "None")}
          ${kv("Duration", duration(problem.durationSeconds))}
          ${kv("Acknowledged", problem.acknowledged ? "Yes" : "No")}
          <div class="card">
            <h3>Acknowledge</h3>
            <textarea id="ackMessage" rows="3" placeholder="Message"></textarea>
            <div class="actions" style="margin-top:8px">
              <button class="button primary" id="ackButton" ${state.config.readOnly ? "disabled" : ""}>Acknowledge</button>
              ${state.config.readOnly ? `<span class="meta">Read-only mode</span>` : ""}
            </div>
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Trigger</h2></div>
        <div class="list">
          ${kv("Expression", data.trigger?.expression || "Unavailable")}
          ${kv("Tags", tags(problem.tags))}
          ${grafanaLink(problem)}
        </div>
      </div>
    </section>
  `;
  document.querySelector("#ackButton")?.addEventListener("click", async () => {
    await api(`/api/problems/${encodeURIComponent(eventid)}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({ message: document.querySelector("#ackMessage").value })
    });
    notify("Problem acknowledged.");
    renderProblemDetail(eventid);
  });
}

async function renderHosts() {
  view.innerHTML = loading("Hosts");
  const hosts = await api(`/api/hosts${query({ search: state.search })}`);
  view.innerHTML = `
    ${head("Hosts", "Availability, groups, tags, and active problem counts from Zabbix.")}
    <section class="grid hosts-grid">${hosts.map(hostCard).join("") || empty("No hosts found.")}</section>
  `;
}

async function renderHostDetail(hostid) {
  view.innerHTML = loading("Host");
  const data = await api(`/api/hosts/${encodeURIComponent(hostid)}`);
  view.innerHTML = `
    ${head(data.host.name, `${data.host.groups.map((group) => group.name).join(" · ") || "No groups"} · ${data.host.status}`)}
    <section class="grid split">
      <div class="panel">
        <div class="panel-head"><h2>Active Problems</h2></div>
        <div class="list">${data.problems.map(problemCard).join("") || empty("No active problems for this host.")}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Latest Values</h2></div>
        <div class="list">${data.latestValues.map(valueCard).join("") || empty("No latest values returned.")}</div>
      </div>
    </section>
    <section class="panel" style="margin-top:12px">
      <div class="panel-head"><h2>Graphs</h2></div>
      <div class="list">
        ${data.latestValues.slice(0, 3).map((item) => `<div class="card"><h3>${escapeHtml(item.name)}</h3><canvas class="graph" data-itemid="${item.itemid}"></canvas></div>`).join("") || empty("No graphable items.")}
        ${grafanaHostPanel(data.host)}
      </div>
    </section>
  `;
  document.querySelectorAll("canvas[data-itemid]").forEach((canvas) => drawGraph(canvas));
}

function renderDashboards() {
  const cards = state.settings.dashboards.length ? state.settings.dashboards : defaultDashboards();
  view.innerHTML = `
    ${head("Dashboards", state.config.grafana.enabled ? "Grafana panels use configured mappings." : "Zabbix history graphs are shown when Grafana is disabled.")}
    <section class="grid dash-grid">
      ${cards.map((card) => dashboardCard(card)).join("")}
    </section>
  `;
  drawDemoGraphs();
}

function renderSettings() {
  view.innerHTML = `
    ${head("Settings", "Runtime secrets are configured by environment variables on the server.")}
    <section class="grid split">
      <div class="panel">
        <div class="panel-head"><h2>Zabbix API</h2></div>
        <div class="list">
          ${kv("Configured", state.config.zabbixConfigured ? "Yes" : "No")}
          ${kv("Read-only mode", state.config.readOnly ? "On" : "Off")}
          <div class="card meta">Set ZABBIX_API_URL, ZABBIX_USERNAME, and ZABBIX_PASSWORD in Docker environment variables.</div>
          <button class="button" id="diagnosticsButton" type="button">Test Zabbix Connection</button>
          <div id="diagnosticsResult"></div>
        </div>
      </div>
      <form class="panel" id="settingsForm">
        <div class="panel-head"><h2>Grafana And Layout</h2></div>
        <div class="list">
          ${kv("Grafana enabled", state.config.grafana.enabled ? "Yes" : "No")}
          ${field("Dashboard UID", "grafanaUid", state.settings.grafanaUid)}
          ${field("WAN panel ID", "wanPanelId", state.settings.wanPanelId)}
          ${field("Default time range", "timeRange", state.settings.timeRange)}
          ${field("Mobile density", "mobileDensity", state.settings.mobileDensity)}
          <button class="button primary" type="submit">Save Settings</button>
        </div>
      </form>
    </section>
  `;
  document.querySelector("#settingsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    state.settings = { ...state.settings, ...Object.fromEntries(form.entries()) };
    saveSettings();
    notify("Settings saved.");
  });
  document.querySelector("#diagnosticsButton").addEventListener("click", runDiagnostics);
}

async function runDiagnostics() {
  const target = document.querySelector("#diagnosticsResult");
  target.innerHTML = `<div class="empty">Testing...</div>`;
  try {
    const result = await api("/api/diagnostics/zabbix", {}, 20000);
    target.innerHTML = `
      ${kv("Configured", result.configured ? "Yes" : "No")}
      ${kv("API URL", result.apiUrl || "Not set")}
      ${kv("Zabbix version", result.version || "Unavailable")}
      ${kv("Login", result.login ? "OK" : "Not tested")}
    `;
  } catch (error) {
    target.innerHTML = errorPanel(error.message);
  }
}

function problemFilters(filters) {
  return `
    <form class="filters" id="filters">
      ${select("severity", filters.severity, [["", "All severity"], ["5", "Disaster"], ["4", "High"], ["3", "Average"], ["2", "Warning"], ["1", "Information"]])}
      ${select("acknowledged", filters.acknowledged, [["", "Any ack"], ["false", "Unacknowledged"], ["true", "Acknowledged"]])}
      ${field("Host group ID", "groupids", filters.groupids || "")}
      ${field("Tag", "tag", filters.tag || "")}
      <button class="button" type="submit">Apply</button>
    </form>
  `;
}

function bindFilters() {
  document.querySelector("#filters")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const params = new URLSearchParams(new FormData(event.target));
    location.hash = `#problems?${params.toString()}`;
  });
}

function getFilters() {
  const [, qs] = state.route.split("?");
  const filters = Object.fromEntries(new URLSearchParams(qs || ""));
  if (state.search) filters.search = state.search;
  return filters;
}

function problemCard(problem) {
  return `
    <article class="problem-card sev-${problem.severity}">
      <div class="problem-top">
        <a class="problem-title" href="#problems/${problem.eventid}">${escapeHtml(problem.name)}</a>
        <span class="severity sev-${problem.severity}">${problem.severityName}</span>
      </div>
      <div class="meta">${problem.host ? `<a href="#hosts/${problem.host.hostid}">${escapeHtml(problem.host.name)}</a>` : "Unknown host"} · ${duration(problem.durationSeconds)} · ${problem.acknowledged ? "Acknowledged" : "Unacknowledged"}</div>
      <div class="meta">${escapeHtml(problem.item?.name || "No item")} ${latest(problem.item)}</div>
      ${problem.opdata ? `<div>${escapeHtml(problem.opdata)}</div>` : ""}
      ${tags(problem.tags)}
    </article>
  `;
}

function hostCard(host) {
  return `
    <article class="host-card">
      <div class="host-top">
        <a class="host-title" href="#hosts/${host.hostid}">${escapeHtml(host.name)}</a>
        <span class="severity ${host.activeProblems ? "sev-5" : "sev-1"}">${host.activeProblems} problems</span>
      </div>
      <div class="meta">${host.status} · agent ${host.available}</div>
      ${tags([...(host.groups || []).map((group) => ({ tag: "group", value: group.name })), ...(host.tags || [])])}
    </article>
  `;
}

function valueCard(item) {
  return `
    <article class="value-card">
      <strong>${escapeHtml(item.name)}</strong>
      <span>${latest(item)}</span>
      <span class="meta">${escapeHtml(item.key)} · ${item.lastclock ? new Date(item.lastclock * 1000).toLocaleString() : "No clock"}</span>
    </article>
  `;
}

function dashboardCard(card) {
  const url = state.config.grafana.enabled && state.settings.grafanaUid && card.panelId
    ? `/api/grafana/panel-url${query({ uid: state.settings.grafanaUid, panelId: card.panelId, from: state.settings.timeRange || "now-6h", to: "now", host: card.host || "", item: card.item || "", interface: card.interface || "" })}`
    : null;
  return `<article class="panel"><div class="panel-head"><h2>${escapeHtml(card.title)}</h2></div><div class="card" data-panel-url="${url || ""}">${grafanaOrFallback(card.key, card.title)}</div></article>`;
}

function grafanaOrFallback(key, title) {
  const panel = key === "wan" ? state.settings.wanPanelId : "";
  if (state.config?.grafana.enabled && state.settings.grafanaUid && panel) {
    const src = `/embed/grafana/panel${query({ uid: state.settings.grafanaUid, panelId: panel, from: state.settings.timeRange, to: "now" })}`;
    return `<iframe class="grafana-frame" title="${escapeHtml(title)}" src="${src}"></iframe>`;
  }
  return `<canvas class="graph" data-demo="${escapeHtml(key)}"></canvas><p class="meta">Grafana disabled or unmapped. Zabbix history graphs appear on host detail pages.</p>`;
}

function grafanaHostPanel(host) {
  if (!state.config.grafana.enabled || !state.settings.grafanaUid) return "";
  const src = `/embed/grafana/panel${query({ uid: state.settings.grafanaUid, panelId: state.settings.hostPanelId || state.settings.wanPanelId, from: state.settings.timeRange, to: "now", host: host.name })}`;
  return `<div class="card"><h3>Grafana</h3><iframe class="grafana-frame" title="Grafana host panel" src="${src}"></iframe></div>`;
}

function grafanaLink(problem) {
  if (!state.config.grafana.enabled || !state.settings.grafanaUid) return "";
  const params = query({ uid: state.settings.grafanaUid, host: problem.host?.name || "", item: problem.item?.name || "", from: "now-6h", to: "now" });
  return `<a class="button" href="/link/grafana/dashboard${params}" target="_blank" rel="noreferrer">Open Grafana dashboard</a>`;
}

async function drawGraph(canvas) {
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * devicePixelRatio);
  canvas.height = Math.floor(rect.height * devicePixelRatio);
  ctx.scale(devicePixelRatio, devicePixelRatio);
  let points = [];
  if (canvas.dataset.itemid) {
    const data = await api(`/api/items/${canvas.dataset.itemid}/graph?range=6h`);
    points = data.points;
  } else {
    points = Array.from({ length: 36 }, (_, index) => ({ value: 40 + Math.sin(index / 3) * 20 + Math.random() * 10 }));
  }
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.strokeStyle = "#6cc7d8";
  ctx.lineWidth = 2;
  ctx.beginPath();
  const values = points.map((point) => Number(point.value)).filter(Number.isFinite);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  values.forEach((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * rect.width;
    const y = rect.height - ((value - min) / Math.max(max - min, 1)) * (rect.height - 18) - 9;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function head(title, subtitle) {
  return `<header class="page-head"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle || "")}</p></div></header>`;
}

function stat(label, value) {
  return `<article class="card stat"><span class="label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function severityPill(item) {
  const names = ["Not classified", "Information", "Warning", "Average", "High", "Disaster"];
  return `<a class="severity-pill sev-${item.severity}" href="#problems?severity=${item.severity}"><span class="meta">${names[item.severity]}</span><strong>${item.count}</strong></a>`;
}

function kv(label, value) {
  return `<div class="card"><div class="meta">${escapeHtml(label)}</div><div>${typeof value === "string" ? value : escapeHtml(value)}</div></div>`;
}

function field(label, name, value) {
  return `<label class="field"><span>${escapeHtml(label)}</span><input class="control" name="${name}" value="${escapeHtml(value || "")}"></label>`;
}

function select(name, value, options) {
  return `<label class="field"><span>${escapeHtml(name)}</span><select class="control" name="${name}">${options.map(([val, label]) => `<option value="${val}" ${String(value || "") === val ? "selected" : ""}>${label}</option>`).join("")}</select></label>`;
}

function tags(tagsList = []) {
  if (!tagsList.length) return "";
  return `<div class="tags">${tagsList.slice(0, 8).map((tag) => `<span class="tag">${escapeHtml(tag.tag)}${tag.value ? `:${escapeHtml(tag.value)}` : ""}</span>`).join("")}</div>`;
}

function latest(item) {
  if (!item) return "";
  return `${escapeHtml(item.latestValue || "n/a")}${item.units ? ` ${escapeHtml(item.units)}` : ""}`;
}

function duration(seconds) {
  const units = [["d", 86400], ["h", 3600], ["m", 60]];
  for (const [unit, size] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit}`;
  }
  return `${Math.max(0, seconds)}s`;
}

function loading(title) {
  return `${head(title, "Loading current data.")}<div class="empty">Loading...</div>`;
}

function empty(message) {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

function errorPanel(message) {
  return `
    <div class="empty">
      <strong>Could not load data.</strong><br>
      ${escapeHtml(message)}<br><br>
      Open Settings and use Test Zabbix Connection, or check the container logs.
    </div>
  `;
}

async function api(path, options = {}, timeoutMs = 18000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { headers: { "content-type": "application/json" }, signal: controller.signal, ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed with HTTP ${response.status}`);
    return payload;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Request timed out while waiting for the backend.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function query(params) {
  const cleaned = Object.fromEntries(Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== ""));
  const qs = new URLSearchParams(cleaned).toString();
  return qs ? `?${qs}` : "";
}

function loadSettings() {
  const fallback = {
    grafanaUid: "",
    wanPanelId: "",
    hostPanelId: "",
    timeRange: "now-6h",
    mobileDensity: "comfortable",
    dashboards: defaultDashboards()
  };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem("nichhome-settings") || "{}") };
  } catch {
    return fallback;
  }
}

function saveSettings() {
  localStorage.setItem("nichhome-settings", JSON.stringify(state.settings));
}

function defaultDashboards() {
  return [
    { key: "wan", title: "WAN Health", panelId: "" },
    { key: "core", title: "Core Hosts", panelId: "" },
    { key: "services", title: "Services", panelId: "" }
  ];
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2600);
}

function drawDemoGraphs() {
  requestAnimationFrame(() => document.querySelectorAll("canvas[data-demo]").forEach((canvas) => drawGraph(canvas)));
}

function debounce(fn, wait) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}
