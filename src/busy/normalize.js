const PHASES = new Set([
  "IDLE",
  "WORK_RUNNING",
  "WORK_PAUSED",
  "BREAK_RUNNING",
  "BREAK_PAUSED",
  "UNKNOWN_ACTIVE",
]);

export function normalizeBusySnapshot(payload, now = Date.now()) {
  if (!payload || typeof payload !== "object") {
    throw new SnapshotError("Snapshot payload is missing.");
  }
  const snapshot = payload.snapshot ?? payload;
  const type = String(snapshot.type ?? "").toUpperCase();
  const timestamp = finiteNumber(payload.snapshot_timestamp_ms) ?? now;

  if (type === "NOT_STARTED") {
    return normalized({ phase: "IDLE", type, timestamp, now });
  }

  const paused = Boolean(snapshot.is_paused);
  const sessionId = snapshot.card_id ?? null;

  if (type === "INFINITE") {
    return normalized({
      phase: paused ? "WORK_PAUSED" : "WORK_RUNNING",
      type,
      timestamp,
      now,
      paused,
      sessionId,
    });
  }

  if (type === "SIMPLE") {
    const remainingMs = requiredNonNegative(snapshot.time_left_ms, "time_left_ms");
    return normalized({
      phase: paused ? "WORK_PAUSED" : "WORK_RUNNING",
      type,
      timestamp,
      now,
      paused,
      sessionId,
      remainingMs,
      durationMs: finiteNumber(snapshot.total_time_ms) ?? remainingMs,
    });
  }

  if (type === "INTERVAL") {
    const remainingMs = requiredNonNegative(
      snapshot.current_interval_time_left_ms,
      "current_interval_time_left_ms",
    );
    const durationMs = requiredNonNegative(
      snapshot.current_interval_time_total_ms,
      "current_interval_time_total_ms",
    );
    const settings = snapshot.interval_settings ?? {};
    const workMs = finiteNumber(settings.interval_work_ms);
    const restMs = finiteNumber(settings.interval_rest_ms);
    const interval = finiteNumber(snapshot.current_interval);
    let phaseKind = "unknown";

    if (workMs != null && restMs != null && workMs !== restMs) {
      if (durationMs === workMs) phaseKind = "work";
      if (durationMs === restMs) phaseKind = "break";
    }
    if (phaseKind === "unknown" && interval != null) {
      phaseKind = interval % 2 === 1 ? "work" : "break";
    }

    const phase = phaseKind === "work"
      ? paused ? "WORK_PAUSED" : "WORK_RUNNING"
      : phaseKind === "break"
        ? paused ? "BREAK_PAUSED" : "BREAK_RUNNING"
        : "UNKNOWN_ACTIVE";

    return normalized({
      phase,
      type,
      timestamp,
      now,
      paused,
      sessionId,
      remainingMs,
      durationMs,
      intervalIndex: interval,
      intervalWorkMs: workMs,
      intervalRestMs: restMs,
    });
  }

  throw new SnapshotError(`Unknown BUSY snapshot type: ${type || "missing"}.`);
}

function normalized({
  phase,
  type,
  timestamp,
  now,
  paused = false,
  sessionId = null,
  remainingMs = null,
  durationMs = null,
  intervalIndex = null,
  intervalWorkMs = null,
  intervalRestMs = null,
}) {
  if (!PHASES.has(phase)) throw new SnapshotError(`Invalid normalized phase: ${phase}`);
  const snapshotAgeMs = paused || remainingMs == null
    ? 0
    : Math.max(0, now - Math.min(timestamp, now));
  const currentRemainingMs = remainingMs == null
    ? null
    : paused
      ? remainingMs
      : Math.max(0, remainingMs - snapshotAgeMs);
  return {
    phase,
    snapshotType: type,
    sessionId,
    paused,
    phaseDurationMs: durationMs,
    intervalIndex,
    intervalWorkMs,
    intervalRestMs,
    remainingMs: currentRemainingMs,
    expectedTransitionAt: currentRemainingMs == null || paused ? null : now + currentRemainingMs,
    lastSnapshotTimestamp: timestamp,
    lastSuccessAt: now,
    connectionHealth: "connected",
    error: null,
  };
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requiredNonNegative(value, field) {
  const number = finiteNumber(value);
  if (number == null || number < 0) throw new SnapshotError(`Snapshot field ${field} is invalid.`);
  return number;
}

export class SnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = "SnapshotError";
    this.code = "BAD_RESPONSE";
  }
}
