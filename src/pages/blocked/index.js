import { formatDuration, phaseLabel } from "../../shared/format.js";
import { MESSAGE } from "../../shared/messages.js";
import { sendMessage } from "../../shared/platform.js";

const elements = {
  host: document.getElementById("blocked-host"),
  remaining: document.getElementById("remaining"),
  phase: document.getElementById("phase"),
  returnButton: document.getElementById("return"),
  note: document.getElementById("status-note"),
};

const host = new URL(location.href).searchParams.get("host");
if (host) elements.host.textContent = host;

let state = null;
let restoring = false;
elements.returnButton.addEventListener("click", restore);
setInterval(renderClock, 250);
setInterval(loadState, 1000);
await loadState();

async function loadState() {
  try {
    state = await request(MESSAGE.GET_STATE);
    renderClock();
    if (
      !state.runtime.blockingActive
      && state.settings.behavior.restoreTabsAfterFocus
      && !restoring
    ) await restore();
  } catch {
    elements.note.textContent = "Waiting for the extension background process…";
  }
}

function renderClock() {
  if (!state) return;
  const runtime = state.runtime;
  let remaining = runtime.remainingMs;
  if (!runtime.paused && runtime.expectedTransitionAt != null) remaining = Math.max(0, runtime.expectedTransitionAt - Date.now());
  elements.remaining.textContent = remaining == null ? "--:--" : formatDuration(remaining);
  elements.phase.textContent = phaseLabel(runtime.phase);
  document.body.dataset.mode = modeFor(runtime.phase);
  const available = !runtime.blockingActive;
  elements.returnButton.disabled = !available;
  elements.returnButton.textContent = available ? "Return to site" : "Return when available";
  elements.note.textContent = available
    ? state.settings.behavior.restoreTabsAfterFocus
      ? "Focus is complete. Returning to your previous page."
      : "Focus is complete. You can return when you are ready."
    : runtime.connectionHealth === "disconnected"
      ? "BUSY is temporarily unreachable; the safe focus window is still active."
      : "This page will return automatically after focus.";
}

function modeFor(phase) {
  if (phase === "WORK_RUNNING") return "focus";
  if (phase.includes("PAUSED")) return "paused";
  if (phase.includes("BREAK")) return "break";
  if (phase === "IDLE") return "idle";
  return "disconnected";
}

async function restore() {
  if (restoring) return;
  restoring = true;
  try {
    const result = await request(MESSAGE.RESTORE_TAB);
    if (!result.restored) history.back();
  } catch {
    history.back();
  } finally {
    setTimeout(() => { restoring = false; }, 1000);
  }
}

async function request(type, payload = {}) {
  const response = await sendMessage(type, payload);
  if (!response?.ok) throw new Error(response?.error?.message ?? "The extension did not respond.");
  return response.data;
}
