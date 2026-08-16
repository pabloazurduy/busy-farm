import { formatDuration, phaseLabel, friendlyError } from "../../shared/format.js";
import {
  CLOUD_BASE_URL,
  connectionFailureMessage,
  validateTransportEndpoint,
} from "../../busy/connection.js";
import { MESSAGE } from "../../shared/messages.js";
import { addStorageListener, extensionApi, sendMessage } from "../../shared/platform.js";
import { normalizeSiteInput } from "../../shared/site.js";
import { STORAGE_KEYS } from "../../state/defaults.js";
import { historySince } from "../../state/history.js";

const api = extensionApi();
const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "global-error", "chromium-note", "live-pill", "live-phase", "live-time", "connection-form",
  "token", "token-status", "test-connection",
  "save-connection", "connection-state", "connection-result", "site-form", "site-host",
  "site-subdomains", "site-list", "site-empty", "site-count", "block-paused", "restore-tabs",
  "theme-select",
  "preference-state", "simulation", "export", "import-trigger", "import-file", "diagnostic-list",
  "farm-count", "farm-title", "farm-subtitle", "farm-field", "chicken-yard", "farm-empty", "farm-days",
].map((id) => [id.replace(/-([a-z])/g, (_, character) => character.toUpperCase()), byId(id)]));

let state = null;
let storageRefreshQueued = false;
let preferenceTimer = null;
let farmPeriod = "week";

elements.connectionForm.addEventListener("submit", (event) => { event.preventDefault(); saveConnection(); });
elements.testConnection.addEventListener("click", testConnection);
elements.siteForm.addEventListener("submit", addSite);
elements.blockPaused.addEventListener("change", savePreferences);
elements.restoreTabs.addEventListener("change", savePreferences);
elements.themeSelect.addEventListener("change", savePreferences);
elements.simulation.addEventListener("change", setSimulation);
elements.export.addEventListener("click", exportSettings);
elements.importTrigger.addEventListener("click", () => elements.importFile.click());
elements.importFile.addEventListener("change", importSettings);
for (const button of document.querySelectorAll(".period-tab")) {
  button.addEventListener("click", () => {
    farmPeriod = button.dataset.period;
    for (const tab of document.querySelectorAll(".period-tab")) {
      const active = tab === button;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-pressed", String(active));
    }
    renderFarm();
  });
}
addStorageListener(handleStorageChanges);
setInterval(renderLiveClock, 250);

await loadState({ hydrateForm: true });

async function loadState({ hydrateForm = false, clearError = hydrateForm } = {}) {
  try {
    state = await request(MESSAGE.GET_STATE);
    if (hydrateForm) hydrateConnectionForm();
    renderState();
    if (clearError) hideGlobalError();
  } catch (error) {
    showGlobalError(friendlyError(error));
  }
}

function hydrateConnectionForm() {
  elements.token.value = "";
  elements.tokenStatus.textContent = state.settings.connection.hasToken
    ? "A credential is saved. Leave this field empty to keep it."
    : "No credential saved.";
  elements.blockPaused.checked = state.settings.behavior.blockWhilePaused;
  elements.restoreTabs.checked = state.settings.behavior.restoreTabsAfterFocus;
  elements.themeSelect.value = state.settings.appearance.theme ?? "system";
  elements.simulation.value = state.settings.developer.simulation ?? "";
}

function renderState() {
  if (!state) return;
  document.body.dataset.mode = modeFor(state.runtime.phase);
  elements.chromiumNote.classList.toggle("hidden", state.platform.reliableRealtimePolling);
  elements.connectionState.textContent = state.runtime.connectionHealth === "connected"
    ? "Connected · BUSY Cloud"
    : "Not connected";
  renderLiveClock();
  renderSites();
  renderFarm();
  renderDiagnostics();
}

function renderFarm() {
  const records = historySince(state?.history ?? [], farmPeriod);
  const labels = { week: "The past 7 days", month: "The past 30 days", year: "The past year" };
  elements.farmTitle.textContent = labels[farmPeriod];
  elements.farmCount.textContent = `${records.length} ${records.length === 1 ? "chicken" : "chickens"}`;
  elements.farmSubtitle.textContent = "Each chicken is one completed BUSY focus cycle.";
  elements.farmEmpty.classList.toggle("hidden", records.length > 0);
  elements.chickenYard.replaceChildren();

  for (const [index, record] of records.entries()) {
    const chicken = document.createElement("div");
    chicken.className = "chicken";
    chicken.style.setProperty("--slot", String(index));
    chicken.style.setProperty("--tilt", `${((hash(record.id) % 9) - 4) * 0.7}deg`);
    chicken.setAttribute("role", "img");
    chicken.setAttribute("aria-label", `Focus cycle completed ${new Date(record.completedAt).toLocaleString()}`);
    chicken.title = new Date(record.completedAt).toLocaleString();
    chicken.innerHTML = '<i class="chicken-body"></i><i class="chicken-wing"></i><i class="chicken-head"></i><i class="chicken-comb"></i><i class="chicken-beak"></i><i class="chicken-leg left"></i><i class="chicken-leg right"></i>';
    elements.chickenYard.append(chicken);
  }

  elements.farmDays.replaceChildren();
  const groups = groupRecordsByDay(records).slice(0, 8);
  for (const group of groups) {
    const row = document.createElement("div");
    row.className = "farm-day";
    const date = document.createElement("strong");
    date.textContent = group.label;
    const flock = document.createElement("span");
    flock.textContent = `${"●".repeat(Math.min(group.count, 12))}${group.count > 12 ? " +" : ""}`;
    flock.setAttribute("aria-label", `${group.count} completed cycles`);
    const count = document.createElement("em");
    count.textContent = `${group.count} ${group.count === 1 ? "cycle" : "cycles"}`;
    row.append(date, flock, count);
    elements.farmDays.append(row);
  }
}

function groupRecordsByDay(records) {
  const groups = new Map();
  for (const record of [...records].sort((a, b) => b.completedAt - a.completedAt)) {
    const date = new Date(record.completedAt);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        label: date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }),
        count: 0,
      });
    }
    groups.get(key).count += 1;
  }
  return [...groups.values()];
}

function hash(value) {
  return [...String(value)].reduce((result, character) => ((result * 31) + character.charCodeAt(0)) >>> 0, 7);
}

function modeFor(phase) {
  if (phase === "WORK_RUNNING") return "focus";
  if (phase === "WORK_COMPLETE") return "complete";
  if (phase.includes("PAUSED")) return "paused";
  if (phase.includes("BREAK")) return "break";
  if (phase === "IDLE") return "idle";
  return "disconnected";
}

function renderLiveClock() {
  if (!state) return;
  const runtime = state.runtime;
  let remaining = runtime.remainingMs;
  if (!runtime.paused && runtime.expectedTransitionAt != null) remaining = Math.max(0, runtime.expectedTransitionAt - Date.now());
  elements.livePhase.textContent = phaseLabel(runtime.phase);
  elements.liveTime.textContent = remaining == null ? "--:--" : formatDuration(remaining);
  elements.livePill.classList.toggle("active", runtime.connectionHealth === "connected");
}

function renderSites() {
  elements.siteList.replaceChildren();
  const sites = state.sites;
  elements.siteEmpty.classList.toggle("hidden", sites.length > 0);
  const enabled = sites.filter((site) => site.enabled !== false).length;
  elements.siteCount.textContent = `${enabled} active / ${sites.length} total`;

  for (const site of sites) {
    const row = document.createElement("div");
    row.className = `site-row${site.enabled === false ? " disabled" : ""}`;

    const toggle = document.createElement("label");
    toggle.className = "switch";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = site.enabled !== false;
    checkbox.setAttribute("aria-label", `Enable ${site.hostname}`);
    const track = document.createElement("span");
    toggle.append(checkbox, track);
    checkbox.addEventListener("change", async () => {
      try {
        state = await request(MESSAGE.TOGGLE_SITE, { id: site.id, enabled: checkbox.checked });
        renderState();
      } catch (error) { showGlobalError(error.message); }
    });

    const copy = document.createElement("div");
    const name = document.createElement("div");
    name.className = "site-name";
    name.textContent = site.hostname;
    const meta = document.createElement("span");
    meta.className = "site-meta";
    meta.textContent = site.includeSubdomains ? "Domain and all subdomains" : "Exact domain only";
    copy.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "site-actions";
    const remove = document.createElement("button");
    remove.className = "button quiet small danger";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      try {
        state = await request(MESSAGE.REMOVE_SITE, { id: site.id });
        renderState();
      } catch (error) { showGlobalError(error.message); }
    });
    actions.append(remove);
    row.append(toggle, copy, actions);
    elements.siteList.append(row);
  }
}

async function addSite(event) {
  event.preventDefault();
  try {
    const normalized = normalizeSiteInput(elements.siteHost.value, { includeSubdomains: elements.siteSubdomains.checked });
    const granted = await api.permissions.request({ origins: [normalized.permissionPattern] });
    if (!granted) throw Object.assign(new Error("Site access was not granted."), { code: "PERMISSION_MISSING" });
    state = await request(MESSAGE.ADD_SITE, normalized);
    elements.siteHost.value = "";
    renderState();
    hideGlobalError();
  } catch (error) {
    showGlobalError(error.message);
  }
}

async function testConnection() {
  await withConnectionButtons(async () => {
    const connection = connectionFromForm();
    const result = await request(MESSAGE.TEST_CONNECTION, { connection });
    showConnectionResult(`Connected in ${result.latencyMs} ms · ${phaseLabel(result.normalized.phase)}`, "success");
  });
}

async function saveConnection() {
  await withConnectionButtons(async () => {
    const connection = connectionFromForm();
    state = await request(MESSAGE.SAVE_CONNECTION, { connection });
    elements.token.value = "";
    elements.tokenStatus.textContent = state.settings.connection.hasToken
      ? "A credential is saved. Leave this field empty to keep it."
      : "No credential saved.";
    showConnectionResult("Connection settings saved. Monitoring has started.", "success");
    renderState();
  });
}

async function withConnectionButtons(operation) {
  elements.testConnection.disabled = true;
  elements.saveConnection.disabled = true;
  try {
    await operation();
    hideGlobalError();
  } catch (error) {
    showConnectionResult(
      connectionFailureMessage(error) ?? friendlyError(error),
      "error",
    );
  } finally {
    elements.testConnection.disabled = false;
    elements.saveConnection.disabled = false;
  }
}

function connectionFromForm() {
  const connection = {
    transport: "cloud",
    baseUrl: CLOUD_BASE_URL,
    token: elements.token.value,
  };
  const storedTokenApplies = state?.settings.connection.hasToken
    && state.settings.connection.transport === "cloud";
  validateTransportEndpoint(
    connection.transport,
    connection.baseUrl,
    connection.token || (storedTokenApplies ? "saved-credential" : ""),
  );
  return connection;
}

function showConnectionResult(message, type) {
  elements.connectionResult.textContent = message;
  elements.connectionResult.className = `notice ${type}`;
}

async function savePreferences() {
  clearTimeout(preferenceTimer);
  elements.preferenceState.textContent = "Saving…";
  try {
    state = await request(MESSAGE.SAVE_PREFERENCES, {
      behavior: {
        blockWhilePaused: elements.blockPaused.checked,
        restoreTabsAfterFocus: elements.restoreTabs.checked,
      },
      appearance: { theme: elements.themeSelect.value },
    });
    elements.preferenceState.textContent = "Saved";
    preferenceTimer = setTimeout(() => { elements.preferenceState.textContent = ""; }, 1800);
  } catch (error) {
    showGlobalError(error.message);
  }
}

async function setSimulation() {
  try {
    const phase = elements.simulation.value || null;
    state = await request(phase ? MESSAGE.SET_MANUAL_SIMULATION : MESSAGE.CLEAR_MANUAL_SIMULATION, { phase });
    renderState();
    hideGlobalError();
  } catch (error) { showGlobalError(error.message); }
}

async function exportSettings() {
  try {
    const data = await request(MESSAGE.EXPORT_SETTINGS);
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `busy-farm-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showGlobalError(error.message); }
}

async function importSettings() {
  const [file] = elements.importFile.files;
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const origins = [...new Set((data.sites ?? []).map((site) =>
      normalizeSiteInput(site.hostname, { includeSubdomains: site.includeSubdomains }).permissionPattern))];
    if (origins.length) {
      const granted = await api.permissions.request({ origins });
      if (!granted) throw new Error("Site permissions were not granted, so nothing was imported.");
    }
    state = await request(MESSAGE.IMPORT_SETTINGS, { data });
    hydrateConnectionForm();
    renderState();
    hideGlobalError();
  } catch (error) {
    showGlobalError(error instanceof SyntaxError ? "That file is not valid JSON." : error.message);
  } finally {
    elements.importFile.value = "";
  }
}

function renderDiagnostics() {
  elements.diagnosticList.replaceChildren();
  const entries = [...state.diagnostics].reverse();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "field-hint";
    empty.textContent = "No diagnostic events yet.";
    elements.diagnosticList.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "diagnostic-row";
    const at = document.createElement("span");
    at.textContent = new Date(entry.at).toLocaleString();
    const event = document.createElement("strong");
    event.textContent = entry.event;
    const detail = document.createElement("span");
    detail.textContent = Object.entries(entry)
      .filter(([key]) => !new Set(["at", "event"]).has(key))
      .map(([key, value]) => `${key}=${value}`)
      .join(" · ") || "—";
    row.append(at, event, detail);
    elements.diagnosticList.append(row);
  }
}

function queueStateRefresh() {
  if (storageRefreshQueued) return;
  storageRefreshQueued = true;
  setTimeout(async () => {
    storageRefreshQueued = false;
    await loadState();
  }, 140);
}

function handleStorageChanges(changes, areaName) {
  if (areaName !== "local") return;
  if (state && changes[STORAGE_KEYS.RUNTIME]?.newValue) {
    state.runtime = { ...state.runtime, ...changes[STORAGE_KEYS.RUNTIME].newValue };
    renderLiveClock();
    elements.connectionState.textContent = state.runtime.connectionHealth === "connected"
      ? `Connected · ${state.runtime.sourceTransport}`
      : "Not connected";
  }
  if (
    changes[STORAGE_KEYS.SETTINGS]
    || changes[STORAGE_KEYS.SITES]
    || changes[STORAGE_KEYS.DIAGNOSTICS]
    || changes[STORAGE_KEYS.HISTORY]
  ) queueStateRefresh();
}

async function request(type, payload = {}) {
  const response = await sendMessage(type, payload);
  if (!response?.ok) throw Object.assign(new Error(response?.error?.message ?? "The extension did not respond."), response?.error);
  return response.data;
}

function showGlobalError(message) {
  elements.globalError.textContent = message;
  elements.globalError.classList.remove("hidden");
}

function hideGlobalError() {
  elements.globalError.classList.add("hidden");
}
