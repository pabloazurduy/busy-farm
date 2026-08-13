const MIN_TIMER_MINUTES = 1;
export const MAX_TIMER_MINUTES = 60;

const DEFAULT_BUSY_BAR_SETTINGS = Object.freeze({
  theme: "on_air",
  show_work_phase_only: false,
  trigger_smart_home: false,
});

export function buildTimerCommand(payload, action, {
  durationMinutes,
  now = Date.now(),
  createId = () => crypto.randomUUID(),
} = {}) {
  const current = snapshotFrom(payload);
  const settings = busyBarSettings(current);

  if (action === "start") {
    if (current.type !== "NOT_STARTED") {
      throw timerError("BUSY already has an active timer.", "TIMER_ALREADY_ACTIVE");
    }
    const minutes = Number(durationMinutes);
    if (!Number.isInteger(minutes) || minutes < MIN_TIMER_MINUTES || minutes > MAX_TIMER_MINUTES) {
      throw timerError("Choose a focus time between 1 and 60 minutes.", "INVALID_TIMER_DURATION");
    }
    return commandPayload({
      type: "SIMPLE",
      card_id: createId(),
      time_left_ms: minutes * 60_000,
      is_paused: false,
      busy_bar_settings: settings,
    }, now);
  }

  if (action === "cancel") {
    if (current.type === "NOT_STARTED") {
      throw timerError("There is no active BUSY timer to cancel.", "TIMER_NOT_ACTIVE");
    }
    return commandPayload({
      type: "NOT_STARTED",
      busy_bar_settings: settings,
    }, now);
  }

  if (!new Set(["pause", "resume"]).has(action)) {
    throw timerError("Unknown timer command.", "INVALID_TIMER_ACTION");
  }
  if (current.type === "NOT_STARTED" || !("is_paused" in current)) {
    throw timerError("There is no active BUSY timer to control.", "TIMER_NOT_ACTIVE");
  }
  if (action === "pause" && current.is_paused) {
    throw timerError("The BUSY timer is already paused.", "TIMER_ALREADY_PAUSED");
  }
  if (action === "resume" && !current.is_paused) {
    throw timerError("The BUSY timer is already running.", "TIMER_NOT_PAUSED");
  }

  const snapshot = current.is_paused ? { ...current } : ageRunningSnapshot(current, payload, now);
  snapshot.is_paused = action === "pause";
  snapshot.busy_bar_settings = settings;
  return commandPayload(snapshot, now);
}

function snapshotFrom(payload) {
  const snapshot = payload?.snapshot ?? payload;
  const type = String(snapshot?.type ?? "").toUpperCase();
  if (!snapshot || !type) {
    throw timerError("BUSY returned a timer state that cannot be controlled.", "BAD_RESPONSE");
  }
  return { ...snapshot, type };
}

function busyBarSettings(snapshot) {
  const settings = snapshot.busy_bar_settings;
  return settings && typeof settings === "object"
    ? { ...DEFAULT_BUSY_BAR_SETTINGS, ...settings }
    : { ...DEFAULT_BUSY_BAR_SETTINGS };
}

function ageRunningSnapshot(snapshot, payload, now) {
  const timestamp = Number(payload?.snapshot_timestamp_ms);
  const ageMs = Number.isFinite(timestamp) ? Math.max(0, now - Math.min(timestamp, now)) : 0;
  const aged = { ...snapshot };
  if (snapshot.type === "SIMPLE") {
    aged.time_left_ms = remainingAfterAge(snapshot.time_left_ms, ageMs);
  }
  if (snapshot.type === "INTERVAL") {
    aged.current_interval_time_left_ms = remainingAfterAge(snapshot.current_interval_time_left_ms, ageMs);
  }
  return aged;
}

function remainingAfterAge(value, ageMs) {
  const remaining = Number(value);
  if (!Number.isFinite(remaining) || remaining < 0) {
    throw timerError("BUSY returned an invalid remaining time.", "BAD_RESPONSE");
  }
  return Math.max(0, Math.round(remaining - ageMs));
}

function commandPayload(snapshot, now) {
  return { snapshot, snapshot_timestamp_ms: Math.round(now) };
}

function timerError(message, code) {
  return Object.assign(new Error(message), { code });
}
