import test from "node:test";
import assert from "node:assert/strict";

import {
  compactCycleHistory,
  completedCycleRecords,
  historySince,
  mergeCycleHistory,
  resolveCycleRunId,
} from "../src/state/history.js";

const NOW = 1_800_000_000_000;

test("reconstructs completed work intervals in the current BUSY session", () => {
  const records = completedCycleRecords(null, {
    phase: "WORK_RUNNING",
    connectionHealth: "connected",
    snapshotType: "INTERVAL",
    sessionId: "session-a",
    intervalIndex: 4,
    intervalWorkMs: 25 * 60_000,
    intervalRestMs: 5 * 60_000,
    phaseDurationMs: 25 * 60_000,
    expectedTransitionAt: NOW + 20 * 60_000,
  }, NOW);

  assert.deepEqual(records.map((record) => record.intervalIndex), [2, 0]);
  assert.equal(records.every((record) => record.durationMs === 25 * 60_000), true);
});

test("records a completed simple timer only when it ends naturally", () => {
  const previous = {
    phase: "WORK_RUNNING",
    snapshotType: "SIMPLE",
    sessionId: "simple-a",
    paused: false,
    phaseDurationMs: 20 * 60_000,
    expectedTransitionAt: NOW - 500,
  };
  const idle = { phase: "IDLE", connectionHealth: "connected", snapshotType: "NOT_STARTED" };
  assert.equal(completedCycleRecords(previous, idle, NOW).length, 1);
  assert.equal(completedCycleRecords({ ...previous, expectedTransitionAt: NOW + 60_000 }, idle, NOW).length, 0);
});

test("merges without duplicating observations and filters periods", () => {
  const recent = { id: "recent", completedAt: NOW - 2 * 86400000 };
  const old = { id: "old", completedAt: NOW - 40 * 86400000 };
  const merged = mergeCycleHistory([recent], [recent, old]);
  assert.equal(merged.length, 2);
  assert.deepEqual(historySince(merged, "week", NOW), [recent]);
  assert.equal(historySince(merged, "year", NOW).length, 2);
});

test("pause and resume do not duplicate an already completed interval", () => {
  const base = {
    phase: "WORK_RUNNING",
    connectionHealth: "connected",
    snapshotType: "INTERVAL",
    sessionId: "paused-session",
    runId: "local-run-a",
    intervalIndex: 2,
    intervalWorkMs: 25 * 60_000,
    intervalRestMs: 5 * 60_000,
    phaseDurationMs: 25 * 60_000,
  };
  const firstObservation = completedCycleRecords(null, {
    ...base,
    expectedTransitionAt: NOW + 20 * 60_000,
  }, NOW);
  const afterResume = completedCycleRecords(null, {
    ...base,
    expectedTransitionAt: NOW + 30 * 60_000,
  }, NOW + 10 * 60_000);

  const history = mergeCycleHistory(firstObservation, afterResume);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, "local-run-a:interval:0");
});

test("keeps one run across BUSY's zero-based work-to-break transition", () => {
  const work = {
    phase: "WORK_RUNNING",
    connectionHealth: "connected",
    snapshotType: "INTERVAL",
    sessionId: "interval-card",
    runId: "local-run-a",
    paused: false,
    intervalIndex: 0,
    intervalWorkMs: 25 * 60_000,
    intervalRestMs: 5 * 60_000,
    phaseDurationMs: 25 * 60_000,
    remainingMs: 0,
    expectedTransitionAt: NOW,
  };
  const rest = {
    ...work,
    phase: "BREAK_RUNNING",
    intervalIndex: 1,
    phaseDurationMs: 5 * 60_000,
    remainingMs: 5 * 60_000,
    expectedTransitionAt: NOW + 5 * 60_000,
  };

  const runId = resolveCycleRunId(work, rest, NOW, () => "unexpected-new-run");
  const records = completedCycleRecords(work, { ...rest, runId }, NOW);

  assert.equal(runId, "local-run-a");
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "local-run-a:interval:0");
});

test("keeps the same local run ID while a timer is paused and resumed", () => {
  const paused = {
    phase: "WORK_PAUSED",
    connectionHealth: "connected",
    snapshotType: "SIMPLE",
    sessionId: "reused-card",
    runId: "local-run-a",
    paused: true,
    phaseDurationMs: 25 * 60_000,
    remainingMs: 12 * 60_000,
    expectedTransitionAt: null,
  };
  const resumed = {
    ...paused,
    phase: "WORK_RUNNING",
    paused: false,
    expectedTransitionAt: NOW + 12 * 60_000,
  };

  assert.equal(
    resolveCycleRunId(paused, resumed, NOW, () => "unexpected-new-run"),
    "local-run-a",
  );
});

test("counts separate timers when BUSY reuses the same card ID", () => {
  const idle = {
    phase: "IDLE",
    connectionHealth: "connected",
    snapshotType: "NOT_STARTED",
    sessionId: null,
    runId: null,
  };
  const work = {
    phase: "WORK_RUNNING",
    connectionHealth: "connected",
    snapshotType: "SIMPLE",
    sessionId: "reused-card",
    paused: false,
    phaseDurationMs: 25 * 60_000,
    remainingMs: 0,
  };
  const firstRunId = resolveCycleRunId(idle, work, NOW, () => "local-run-a");
  const first = completedCycleRecords(
    { ...work, runId: firstRunId, expectedTransitionAt: NOW },
    idle,
    NOW,
  );
  const secondRunId = resolveCycleRunId(idle, work, NOW + 60 * 60_000, () => "local-run-b");
  const second = completedCycleRecords(
    { ...work, runId: secondRunId, expectedTransitionAt: NOW + 60 * 60_000 },
    idle,
    NOW + 60 * 60_000,
  );

  const history = mergeCycleHistory(first, second);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((record) => record.id), [
    "local-run-a:simple",
    "local-run-b:simple",
  ]);
});

test("detects a new timer if the idle state was missed between polls", () => {
  const previous = {
    phase: "WORK_RUNNING",
    snapshotType: "SIMPLE",
    sessionId: "reused-card",
    runId: "local-run-a",
    paused: false,
    phaseDurationMs: 25 * 60_000,
    remainingMs: 1000,
    expectedTransitionAt: NOW + 1000,
  };
  const restarted = {
    ...previous,
    runId: null,
    remainingMs: 25 * 60_000,
    expectedTransitionAt: NOW + 25 * 60_000,
  };

  assert.equal(
    resolveCycleRunId(previous, restarted, NOW + 2000, () => "local-run-b"),
    "local-run-b",
  );
});

test("preserves ambiguous records created by earlier versions", () => {
  const history = compactCycleHistory([
    {
      id: "session-a:interval:1:60000000",
      sessionId: "session-a",
      intervalIndex: 1,
      completedAt: NOW - 60_000,
    },
    {
      id: "session-a:interval:1:60000020",
      sessionId: "session-a",
      intervalIndex: 1,
      completedAt: NOW + 10 * 60_000,
    },
  ]);

  assert.equal(history.length, 2);
  assert.deepEqual(history.map((record) => record.id), [
    "session-a:interval:1:60000000",
    "session-a:interval:1:60000020",
  ]);
});

test("does not duplicate a legacy observation when assigning its first run ID", () => {
  const legacy = {
    id: "session-a:interval:1",
    sessionId: "session-a",
    intervalIndex: 1,
    completedAt: NOW,
  };
  const upgraded = {
    ...legacy,
    id: "local-run-a:interval:1",
    runId: "local-run-a",
    completedAt: NOW + 1000,
  };

  assert.equal(mergeCycleHistory([legacy], [upgraded]).length, 1);
});

test("does not duplicate a first work interval recorded as simple by the old index parser", () => {
  const oldRecord = {
    id: "local-run-a:simple",
    sessionId: "session-a",
    runId: "local-run-a",
    intervalIndex: null,
    completedAt: NOW,
  };
  const corrected = {
    ...oldRecord,
    id: "local-run-a:interval:0",
    intervalIndex: 0,
    completedAt: NOW + 1000,
  };

  assert.equal(mergeCycleHistory([oldRecord], [corrected]).length, 1);
});

test("leaves clean history unchanged to avoid rewriting storage every poll", () => {
  const history = [{
    id: "session-a:interval:1",
    sessionId: "session-a",
    intervalIndex: 1,
    completedAt: NOW,
  }];

  assert.equal(compactCycleHistory(history), history);
  assert.equal(mergeCycleHistory(history, []), history);
});
