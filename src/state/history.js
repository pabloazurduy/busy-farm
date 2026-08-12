const MAX_HISTORY = 10000;
const COMPLETION_TOLERANCE_MS = 15000;

export function completedCycleRecords(previous, current, observedAt = Date.now()) {
  if (!current || current.connectionHealth !== "connected") return [];

  const candidates = current.snapshotType === "INTERVAL"
    ? recordsFromCurrentInterval(current)
    : [];

  const transition = recordFromTransition(previous, current, observedAt);
  if (transition) candidates.push(transition);
  return uniqueById(candidates);
}

export function mergeCycleHistory(history, candidates) {
  const existing = Array.isArray(history) ? history : [];
  if (!candidates.length) return existing;
  const ids = new Set(existing.map((record) => record.id));
  const additions = candidates.filter((record) => record && !ids.has(record.id));
  if (!additions.length) return existing;
  return [...existing, ...additions]
    .sort((a, b) => a.completedAt - b.completedAt)
    .slice(-MAX_HISTORY);
}

export function historySince(history, period, now = Date.now()) {
  const days = period === "year" ? 365 : period === "month" ? 30 : 7;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return (Array.isArray(history) ? history : []).filter((record) => record.completedAt >= cutoff);
}

function recordsFromCurrentInterval(current) {
  const index = positiveInteger(current.intervalIndex);
  const workMs = positiveNumber(current.intervalWorkMs);
  const restMs = positiveNumber(current.intervalRestMs);
  const sessionId = current.sessionId;
  if (!index || !workMs || !restMs || !sessionId || current.expectedTransitionAt == null) return [];

  let cursor = current.expectedTransitionAt - current.phaseDurationMs;
  const records = [];
  for (let interval = index - 1; interval >= 1; interval -= 1) {
    const durationMs = interval % 2 === 1 ? workMs : restMs;
    const startedAt = cursor - durationMs;
    if (interval % 2 === 1) {
      records.push(makeRecord(sessionId, interval, startedAt, cursor, durationMs));
    }
    cursor = startedAt;
  }
  return records;
}

function recordFromTransition(previous, current, observedAt) {
  if (!previous || !String(previous.phase ?? "").startsWith("WORK_")) return null;
  const movedToBreak = String(current.phase ?? "").startsWith("BREAK_");
  const naturallyEnded = current.phase === "IDLE"
    && !previous.paused
    && previous.expectedTransitionAt != null
    && previous.expectedTransitionAt <= observedAt + COMPLETION_TOLERANCE_MS;
  if (!movedToBreak && !naturallyEnded) return null;

  const completedAt = previous.expectedTransitionAt != null
    ? Math.min(observedAt, previous.expectedTransitionAt)
    : observedAt;
  const durationMs = positiveNumber(previous.phaseDurationMs);
  const startedAt = durationMs ? completedAt - durationMs : null;
  const intervalIndex = positiveInteger(previous.intervalIndex);
  return makeRecord(previous.sessionId, intervalIndex, startedAt, completedAt, durationMs);
}

function makeRecord(sessionId, intervalIndex, startedAt, completedAt, durationMs) {
  const completionBucket = Math.round(completedAt / 30000);
  const kind = intervalIndex
    ? `interval:${intervalIndex}:${completionBucket}`
    : `simple:${completionBucket}`;
  return {
    id: `${sessionId ?? "timer"}:${kind}`,
    sessionId: sessionId ?? null,
    intervalIndex: intervalIndex ?? null,
    startedAt: Number.isFinite(startedAt) ? Math.round(startedAt) : null,
    completedAt: Math.round(completedAt),
    durationMs: durationMs ? Math.round(durationMs) : null,
  };
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveInteger(value) {
  const number = positiveNumber(value);
  return number && Number.isInteger(number) ? number : null;
}

function uniqueById(records) {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}
