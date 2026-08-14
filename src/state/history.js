const MAX_HISTORY = 10000;
const COMPLETION_TOLERANCE_MS = 15000;
const TIMER_PHASES = new Set([
  "WORK_RUNNING",
  "WORK_PAUSED",
  "BREAK_RUNNING",
  "BREAK_PAUSED",
  "UNKNOWN_ACTIVE",
]);

export function resolveCycleRunId(
  previous,
  current,
  observedAt = Date.now(),
  createId = defaultRunId,
) {
  if (!current || !TIMER_PHASES.has(current.phase)) return null;
  if (continuesSameRun(previous, current, observedAt)) return previous.runId;
  return createId();
}

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
  const existing = compactCycleHistory(history);
  if (!candidates.length) return existing;
  const keys = new Set(existing.map(logicalCycleKey));
  const additions = compactCycleHistory(candidates)
    .filter((record) => record
      && !keys.has(logicalCycleKey(record))
      && !existing.some((stored) => matchesLegacyObservation(stored, record)));
  if (!additions.length) return existing;
  return [...existing, ...additions]
    .sort((a, b) => a.completedAt - b.completedAt)
    .slice(-MAX_HISTORY);
}

export function compactCycleHistory(history) {
  const source = Array.isArray(history) ? history : [];
  const records = source
    .filter((record) => record && Number.isFinite(Number(record.completedAt)))
    .sort((a, b) => a.completedAt - b.completedAt);
  const compacted = [];
  const keys = new Set();

  for (const record of records) {
    const key = logicalCycleKey(record);
    if (keys.has(key)) continue;
    keys.add(key);
    compacted.push(record);
  }
  const result = compacted.slice(-MAX_HISTORY);
  const unchanged = result.length === source.length
    && result.every((record, index) => record === source[index]);
  return unchanged ? source : result;
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
      records.push(makeRecord(sessionId, current.runId, interval, startedAt, cursor, durationMs));
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
  return makeRecord(
    previous.sessionId,
    previous.runId,
    intervalIndex,
    startedAt,
    completedAt,
    durationMs,
  );
}

function makeRecord(sessionId, runId, intervalIndex, startedAt, completedAt, durationMs) {
  const completionBucket = Math.round(completedAt / 30000);
  const kind = intervalIndex
    ? `interval:${intervalIndex}`
    : sessionId
      ? "simple"
      : `simple:${completionBucket}`;
  return {
    id: `${runId ?? sessionId ?? "timer"}:${kind}`,
    sessionId: sessionId ?? null,
    runId: runId ?? null,
    intervalIndex: intervalIndex ?? null,
    startedAt: Number.isFinite(startedAt) ? Math.round(startedAt) : null,
    completedAt: Math.round(completedAt),
    durationMs: durationMs ? Math.round(durationMs) : null,
  };
}

function logicalCycleKey(record) {
  if (record.runId && positiveInteger(record.intervalIndex)) {
    return `${record.runId}:interval:${record.intervalIndex}`;
  }
  if (record.runId && record.intervalIndex == null) {
    return `${record.runId}:simple`;
  }
  // Records written before per-run IDs are ambiguous: BUSY can reuse the same
  // card ID for separate timers. Preserve their original IDs rather than
  // destructively folding potentially valid completions together again.
  if (record.id) return String(record.id);
  if (record.sessionId && positiveInteger(record.intervalIndex)) {
    return `${record.sessionId}:interval:${record.intervalIndex}`;
  }
  if (record.sessionId && record.intervalIndex == null) {
    return `${record.sessionId}:simple`;
  }
  return String(record.id ?? `legacy:${record.completedAt}`);
}

function continuesSameRun(previous, current, observedAt) {
  if (!previous?.runId || previous.phase === "IDLE") return false;
  if (!TIMER_PHASES.has(previous.phase) && previous.phase !== "DISCONNECTED") return false;
  if (!previous.sessionId || previous.sessionId !== current.sessionId) return false;
  if (previous.snapshotType !== current.snapshotType) return false;

  const previousInterval = positiveInteger(previous.intervalIndex);
  const currentInterval = positiveInteger(current.intervalIndex);
  if (previousInterval || currentInterval) {
    if (!previousInterval || !currentInterval || currentInterval < previousInterval) return false;
    if (currentInterval > previousInterval) return true;
  }

  if (positiveNumber(previous.phaseDurationMs) !== positiveNumber(current.phaseDurationMs)) {
    return false;
  }
  return !remainingTimeWasReset(previous, current, observedAt);
}

function remainingTimeWasReset(previous, current, observedAt) {
  const currentRemaining = nonNegativeNumber(current.remainingMs);
  const previousRemaining = previous.paused || previous.expectedTransitionAt == null
    ? nonNegativeNumber(previous.remainingMs)
    : Math.max(0, previous.expectedTransitionAt - observedAt);
  if (currentRemaining == null || previousRemaining == null) return false;
  return currentRemaining > previousRemaining + COMPLETION_TOLERANCE_MS;
}

function matchesLegacyObservation(stored, candidate) {
  if (!candidate?.runId || stored?.runId) return false;
  if (!stored.sessionId || stored.sessionId !== candidate.sessionId) return false;
  if ((positiveInteger(stored.intervalIndex) ?? null)
    !== (positiveInteger(candidate.intervalIndex) ?? null)) return false;
  return Math.abs(Number(stored.completedAt) - Number(candidate.completedAt))
    <= COMPLETION_TOLERANCE_MS;
}

function defaultRunId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveInteger(value) {
  const number = positiveNumber(value);
  return number && Number.isInteger(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function uniqueById(records) {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}
