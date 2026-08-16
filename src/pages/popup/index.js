import { formatDuration, phaseLabel, transportLabel, friendlyError } from "../../shared/format.js";
import { MESSAGE } from "../../shared/messages.js";
import { addStorageListener, extensionApi, openOptionsPage, sendMessage } from "../../shared/platform.js";
import { permissionPatternForHost } from "../../shared/site.js";
import { STORAGE_KEYS } from "../../state/defaults.js";

const MAX_DURATION_MINUTES = 60;
const RING_RADIUS = 118;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const SELECTABLE_ARC = RING_CIRCUMFERENCE * (5 / 6);
const SLIDER_START_DEGREES = 210;
const SLIDER_SPAN_DEGREES = 300;

const api = extensionApi();
const elements = Object.fromEntries([
  "instrument", "transport", "phase", "timer", "blocking-copy", "blocked-count", "error",
  "browser-warning", "current-host", "current-detail", "current-action", "last-update",
  "refresh", "settings", "timer-dial", "progress-value", "dial-slider", "dial-handle",
  "duration-tools", "edit-time", "duration-editor", "duration-minutes", "timer-controls",
  "start-timer", "pause-timer", "resume-timer", "cancel-timer", "command-state",
].map((id) => [id.replace(/-([a-z])/g, (_, character) => character.toUpperCase()), document.getElementById(id)]));
const progressTrack = document.querySelector(".progress-track");

let state = null;
let currentTab = null;
let refreshQueued = false;
let selectedMinutes = 25;
let commandBusy = false;
let commandMessage = "";
let dialDragging = false;
let durationSaveTimer = null;

elements.refresh.addEventListener("click", () => refresh(true));
elements.settings.addEventListener("click", () => openOptionsPage());
elements.currentAction.addEventListener("click", addCurrentSite);
elements.startTimer.addEventListener("click", () => runTimerCommand(MESSAGE.START_TIMER, {
  durationMinutes: selectedMinutes,
}, "Starting…", "Focus timer started on BUSY."));
elements.pauseTimer.addEventListener("click", () => runTimerCommand(
  MESSAGE.PAUSE_TIMER, {}, "Pausing…", "Timer paused.",
));
elements.resumeTimer.addEventListener("click", () => runTimerCommand(
  MESSAGE.RESUME_TIMER, {}, "Resuming…", "Timer resumed.",
));
elements.cancelTimer.addEventListener("click", () => runTimerCommand(
  MESSAGE.CANCEL_TIMER, {}, "Cancelling…", "Timer cancelled.",
));
elements.editTime.addEventListener("click", openDurationEditor);
elements.durationEditor.addEventListener("submit", submitDurationEditor);
elements.durationMinutes.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  elements.durationEditor.classList.add("hidden");
  elements.editTime.classList.remove("hidden");
  elements.editTime.focus();
});
elements.dialSlider.addEventListener("pointerdown", beginDialDrag);
elements.dialSlider.addEventListener("pointermove", updateDialDrag);
elements.dialSlider.addEventListener("pointerup", endDialDrag);
elements.dialSlider.addEventListener("pointercancel", endDialDrag);
elements.dialSlider.addEventListener("keydown", handleDialKey);
addStorageListener(handleStorageChanges);
setInterval(renderClock, 250);

await refresh(false);

async function refresh(forcePoll) {
  elements.refresh.disabled = true;
  try {
    state = await request(forcePoll ? MESSAGE.REFRESH : MESSAGE.GET_STATE);
    currentTab = await request(MESSAGE.GET_CURRENT_TAB);
    syncSelectedDuration();
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
  elements.blockingCopy.textContent = runtime.blockingActive
    ? "Distractions blocked"
    : runtime.phase === "IDLE" && selectedMinutes === 0
      ? "Turn the ring to choose a focus time"
      : blockingCopy(runtime.phase);
  const enabled = state.sites.filter((site) => site.enabled !== false).length;
  elements.blockedCount.textContent = `${enabled} ${enabled === 1 ? "rule" : "rules"}`;
  elements.lastUpdate.textContent = runtime.lastSuccessAt
    ? `Updated ${new Date(runtime.lastSuccessAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    : "No snapshot yet";

  elements.browserWarning.classList.toggle("hidden", state.platform.reliableRealtimePolling);
  elements.browserWarning.textContent = "Chromium may poll less often when no extension page is open. Firefox is the recommended always-on build.";
  renderTimerControls();
  renderCurrentTab();
  renderClock();
}

function renderClock() {
  if (!state) return;
  const runtime = state.runtime;
  const choosingDuration = runtime.phase === "IDLE";
  let remaining = runtime.remainingMs;
  if (!runtime.paused && runtime.expectedTransitionAt != null) {
    remaining = Math.max(0, runtime.expectedTransitionAt - Date.now());
  }

  if (choosingDuration) {
    elements.timer.textContent = `${String(selectedMinutes).padStart(2, "0")}:00`;
    elements.timer.classList.remove("word");
    renderDurationArc();
    return;
  }

  elements.timer.textContent = remaining == null ? "--:--" : formatDuration(remaining);
  elements.timer.classList.toggle("word", remaining == null);
  const duration = Number(runtime.phaseDurationMs);
  const ratio = runtime.phase === "WORK_COMPLETE"
    ? 1
    : remaining != null && Number.isFinite(duration) && duration > 0
      ? Math.max(0, Math.min(1, (duration - remaining) / duration))
      : 0;
  progressTrack.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  progressTrack.style.strokeDashoffset = "0";
  elements.progressValue.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  elements.progressValue.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - ratio));
  elements.dialSlider.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  elements.dialSlider.setAttribute("aria-valuetext", `${elements.phase.textContent}, ${Math.round(ratio * 100)}% complete`);
  elements.dialSlider.setAttribute("aria-label", `${elements.phase.textContent} progress`);
}

function renderDurationArc() {
  const ratio = selectedMinutes / MAX_DURATION_MINUTES;
  const gap = RING_CIRCUMFERENCE - SELECTABLE_ARC;
  progressTrack.style.strokeDasharray = `${SELECTABLE_ARC} ${gap}`;
  progressTrack.style.strokeDashoffset = "0";
  elements.progressValue.style.strokeDasharray = `${SELECTABLE_ARC * ratio} ${RING_CIRCUMFERENCE}`;
  elements.progressValue.style.strokeDashoffset = "0";

  const angle = (SLIDER_START_DEGREES + ratio * SLIDER_SPAN_DEGREES) * (Math.PI / 180);
  elements.dialHandle.style.left = `${125 + Math.sin(angle) * RING_RADIUS}px`;
  elements.dialHandle.style.top = `${125 - Math.cos(angle) * RING_RADIUS}px`;
  elements.dialSlider.setAttribute("aria-valuenow", String(selectedMinutes));
  elements.dialSlider.setAttribute("aria-valuetext", `${selectedMinutes} ${selectedMinutes === 1 ? "minute" : "minutes"}`);
  elements.editTime.textContent = `✎ Edit ${selectedMinutes} min`;
}

function renderTimerControls() {
  const runtime = state.runtime;
  const connected = runtime.connectionHealth === "connected" && runtime.sourceTransport !== "simulation";
  const choosingDuration = runtime.phase === "IDLE" && connected;
  const durationSemantic = runtime.phase === "IDLE";
  const controllable = connected && new Set(["SIMPLE", "INTERVAL", "INFINITE"]).has(runtime.snapshotType);
  const editable = choosingDuration && !commandBusy;

  elements.timerDial.classList.toggle("editable", choosingDuration);
  elements.dialSlider.tabIndex = editable ? 0 : -1;
  elements.dialSlider.setAttribute("role", durationSemantic ? "slider" : "progressbar");
  elements.dialSlider.setAttribute("aria-label", durationSemantic ? "Focus duration" : `${elements.phase.textContent} progress`);
  elements.dialSlider.setAttribute("aria-valuemin", "0");
  elements.dialSlider.setAttribute("aria-valuemax", durationSemantic ? "60" : "100");
  if (durationSemantic) {
    elements.dialSlider.setAttribute("aria-disabled", String(!editable));
  } else {
    elements.dialSlider.removeAttribute("aria-disabled");
  }
  elements.timerDial.removeAttribute("aria-label");
  elements.durationTools.classList.toggle("hidden", !choosingDuration);
  elements.timerControls.classList.toggle("hidden", !choosingDuration && !controllable);
  elements.startTimer.classList.toggle("hidden", !choosingDuration);
  elements.pauseTimer.classList.toggle("hidden", !controllable || runtime.paused);
  elements.resumeTimer.classList.toggle("hidden", !controllable || !runtime.paused);
  elements.cancelTimer.classList.toggle("hidden", !controllable);
  elements.startTimer.disabled = commandBusy || selectedMinutes < 1;
  elements.pauseTimer.disabled = commandBusy;
  elements.resumeTimer.disabled = commandBusy;
  elements.cancelTimer.disabled = commandBusy;
  elements.editTime.disabled = commandBusy;
  elements.commandState.textContent = commandMessage
    || (choosingDuration && selectedMinutes === 0 ? "Choose at least 1 minute to start." : "");
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

async function runTimerCommand(type, payload, progressMessage, successMessage) {
  if (commandBusy) return;
  commandBusy = true;
  commandMessage = progressMessage;
  render();
  hideError();
  try {
    state = await request(type, payload);
    commandMessage = successMessage;
  } catch (error) {
    commandMessage = "";
    showError(friendlyError(error));
  } finally {
    commandBusy = false;
    render();
  }
}

function beginDialDrag(event) {
  if (!elements.timerDial.classList.contains("editable") || commandBusy) return;
  const rect = elements.timerDial.getBoundingClientRect();
  const distance = Math.hypot(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2));
  if (Math.abs(distance - rect.width * (RING_RADIUS / 250)) > 28) return;
  event.preventDefault();
  dialDragging = true;
  elements.dialSlider.setPointerCapture(event.pointerId);
  updateDurationFromPointer(event);
}

function updateDialDrag(event) {
  if (!dialDragging) return;
  event.preventDefault();
  updateDurationFromPointer(event);
}

function endDialDrag(event) {
  if (!dialDragging) return;
  dialDragging = false;
  if (elements.dialSlider.hasPointerCapture(event.pointerId)) {
    elements.dialSlider.releasePointerCapture(event.pointerId);
  }
  persistSelectedDuration();
}

function updateDurationFromPointer(event) {
  const rect = elements.timerDial.getBoundingClientRect();
  const dx = event.clientX - (rect.left + rect.width / 2);
  const dy = event.clientY - (rect.top + rect.height / 2);
  const angle = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  let arcDegrees = (angle - SLIDER_START_DEGREES + 360) % 360;
  if (arcDegrees > SLIDER_SPAN_DEGREES) arcDegrees = arcDegrees < 330 ? SLIDER_SPAN_DEGREES : 0;
  setSelectedMinutes(Math.round(arcDegrees / SLIDER_SPAN_DEGREES * MAX_DURATION_MINUTES));
}

function handleDialKey(event) {
  if (!elements.timerDial.classList.contains("editable") || commandBusy) return;
  const step = event.shiftKey ? 5 : 1;
  const actions = {
    ArrowUp: selectedMinutes + step,
    ArrowRight: selectedMinutes + step,
    ArrowDown: selectedMinutes - step,
    ArrowLeft: selectedMinutes - step,
    PageUp: selectedMinutes + 5,
    PageDown: selectedMinutes - 5,
    Home: 0,
    End: MAX_DURATION_MINUTES,
  };
  if (!(event.key in actions)) return;
  event.preventDefault();
  setSelectedMinutes(actions[event.key]);
  clearTimeout(durationSaveTimer);
  durationSaveTimer = setTimeout(persistSelectedDuration, 250);
}

function openDurationEditor() {
  elements.editTime.classList.add("hidden");
  elements.durationEditor.classList.remove("hidden");
  elements.durationMinutes.value = String(selectedMinutes);
  elements.durationMinutes.focus();
  elements.durationMinutes.select();
}

async function submitDurationEditor(event) {
  event.preventDefault();
  const value = Number(elements.durationMinutes.value);
  if (!Number.isInteger(value) || value < 0 || value > MAX_DURATION_MINUTES) {
    showError("Enter a whole number from 0 to 60 minutes.");
    elements.durationMinutes.focus();
    return;
  }
  setSelectedMinutes(value);
  elements.durationEditor.classList.add("hidden");
  elements.editTime.classList.remove("hidden");
  elements.dialSlider.focus();
  await persistSelectedDuration();
}

function setSelectedMinutes(value) {
  selectedMinutes = Math.max(0, Math.min(MAX_DURATION_MINUTES, Math.round(Number(value) || 0)));
  commandMessage = "";
  render();
}

function syncSelectedDuration() {
  if (dialDragging || !elements.durationEditor.classList.contains("hidden")) return;
  const stored = Number(state?.settings?.timer?.durationMinutes);
  selectedMinutes = Number.isInteger(stored)
    ? Math.max(0, Math.min(MAX_DURATION_MINUTES, stored))
    : 25;
}

async function persistSelectedDuration() {
  try {
    state = await request(MESSAGE.SAVE_TIMER_DURATION, { durationMinutes: selectedMinutes });
    hideError();
    render();
  } catch (error) {
    showError(friendlyError(error));
  }
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
  if (phase === "WORK_COMPLETE") return "complete";
  if (phase.includes("PAUSED")) return "paused";
  if (phase.includes("BREAK")) return "break";
  if (phase === "IDLE") return "idle";
  return "disconnected";
}

function blockingCopy(phase) {
  if (phase === "WORK_COMPLETE") return "Focus complete · ready for break";
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
