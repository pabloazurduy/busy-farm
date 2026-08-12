import { formatDuration, phaseLabel, transportLabel, friendlyError } from "../../shared/format.js";
import { MESSAGE } from "../../shared/messages.js";
import { addStorageListener, extensionApi, openOptionsPage, sendMessage } from "../../shared/platform.js";
import { permissionPatternForHost } from "../../shared/site.js";
import { STORAGE_KEYS } from "../../state/defaults.js";

const api = extensionApi();
const elements = Object.fromEntries([
  "instrument", "transport", "phase", "timer", "blocking-copy", "blocked-count", "error",
  "browser-warning", "current-host", "current-detail", "current-action", "last-update",
  "refresh", "settings", "timer-dial", "progress-value",
].map((id) => [id.replace(/-([a-z])/g, (_, character) => character.toUpperCase()), document.getElementById(id)]));

let state = null;
let currentTab = null;
let refreshQueued = false;

elements.refresh.addEventListener("click", () => refresh(true));
elements.settings.addEventListener("click", () => openOptionsPage());
elements.currentAction.addEventListener("click", addCurrentSite);
addStorageListener(handleStorageChanges);
setInterval(renderClock, 250);

await refresh(false);

async function refresh(forcePoll) {
  elements.refresh.disabled = true;
  try {
    state = await request(forcePoll ? MESSAGE.REFRESH : MESSAGE.GET_STATE);
    currentTab = await request(MESSAGE.GET_CURRENT_TAB);
    render();
    hideError();
  } catch (error) {
    showError(friendlyError(error));
  } finally {
    elements.refresh.disabled = false;
  }
}

function queueRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    refresh(false);
  }, 120);
}

function handleStorageChanges(changes, areaName) {
  if (areaName !== "local") return;
  if (state && changes[STORAGE_KEYS.RUNTIME]?.newValue) {
    state.runtime = { ...state.runtime, ...changes[STORAGE_KEYS.RUNTIME].newValue };
    render();
  }
  if (changes[STORAGE_KEYS.SETTINGS] || changes[STORAGE_KEYS.SITES]) queueRefresh();
}

function render() {
  if (!state) return;
  const runtime = state.runtime;
  elements.phase.textContent = phaseLabel(runtime.phase);
  elements.transport.textContent = `${transportLabel(runtime.sourceTransport)} · ${runtime.connectionHealth}`;
  elements.instrument.dataset.mode = modeFor(runtime.phase);
  elements.blockingCopy.textContent = runtime.blockingActive ? "Distractions blocked" : blockingCopy(runtime.phase);
  const enabled = state.sites.filter((site) => site.enabled !== false).length;
  elements.blockedCount.textContent = `${enabled} ${enabled === 1 ? "rule" : "rules"}`;
  elements.lastUpdate.textContent = runtime.lastSuccessAt
    ? `Updated ${new Date(runtime.lastSuccessAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    : "No snapshot yet";

  elements.browserWarning.classList.toggle("hidden", state.platform.reliableRealtimePolling);
  elements.browserWarning.textContent = "Chromium may poll less often when no extension page is open. Firefox is the recommended always-on build.";
  renderCurrentTab();
  renderClock();
}

function renderClock() {
  if (!state) return;
  const runtime = state.runtime;
  let remaining = runtime.remainingMs;
  if (!runtime.paused && runtime.expectedTransitionAt != null) {
    remaining = Math.max(0, runtime.expectedTransitionAt - Date.now());
  }
  elements.timer.textContent = remaining == null
    ? runtime.phase === "IDLE" ? "READY" : "--:--"
    : formatDuration(remaining);
  elements.timer.classList.toggle("word", remaining == null);
  const duration = Number(runtime.phaseDurationMs);
  const ratio = remaining != null && Number.isFinite(duration) && duration > 0
    ? Math.max(0, Math.min(1, (duration - remaining) / duration))
    : 0;
  const circumference = 2 * Math.PI * 118;
  elements.progressValue.style.strokeDasharray = String(circumference);
  elements.progressValue.style.strokeDashoffset = String(circumference * (1 - ratio));
  elements.timerDial.setAttribute("aria-label", `${elements.phase.textContent}, ${Math.round(ratio * 100)}% complete`);
}

function renderCurrentTab() {
  if (!currentTab?.supported) {
    elements.currentHost.textContent = "Unavailable";
    elements.currentDetail.textContent = currentTab?.reason ?? "This page cannot be added.";
    elements.currentAction.disabled = true;
    return;
  }
  elements.currentHost.textContent = currentTab.hostname;
  const listed = Boolean(currentTab.matchingSite);
  elements.currentDetail.textContent = listed ? "Already covered by your block list." : "Not on your block list.";
  elements.currentAction.textContent = listed ? "Added" : "Add";
  elements.currentAction.disabled = listed;
}

async function addCurrentSite() {
  if (!currentTab?.supported) return;
  elements.currentAction.disabled = true;
  try {
    const pattern = permissionPatternForHost(currentTab.hostname, true);
    const granted = await api.permissions.request({ origins: [pattern] });
    if (!granted) throw Object.assign(new Error("Site access was not granted."), { code: "PERMISSION_MISSING" });
    state = await request(MESSAGE.ADD_SITE, { hostname: currentTab.hostname, includeSubdomains: true });
    currentTab.matchingSite = state.sites.find((site) => site.hostname === currentTab.hostname) ?? null;
    render();
    hideError();
  } catch (error) {
    showError(error.message);
    elements.currentAction.disabled = false;
  }
}

function modeFor(phase) {
  if (phase === "WORK_RUNNING") return "focus";
  if (phase.includes("PAUSED")) return "paused";
  if (phase.includes("BREAK")) return "break";
  if (phase === "IDLE") return "idle";
  return "disconnected";
}

function blockingCopy(phase) {
  if (phase.includes("BREAK")) return "Break window";
  if (phase.includes("PAUSED")) return "Timer paused";
  if (phase === "IDLE") return "Ready for focus";
  return "Monitoring BUSY";
}

async function request(type, payload = {}) {
  const response = await sendMessage(type, payload);
  if (!response?.ok) throw Object.assign(new Error(response?.error?.message ?? "The extension did not respond."), response?.error);
  return response.data;
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.classList.remove("hidden");
}

function hideError() {
  elements.error.classList.add("hidden");
}
