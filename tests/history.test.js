import test from "node:test";
import assert from "node:assert/strict";

import {
  compactCycleHistory,
  completedCycleRecords,
  historySince,
  mergeCycleHistory,
} from "../src/state/history.js";

const NOW = 1_800_000_000_000;

test("reconstructs completed work intervals in the current BUSY session", () => {
  const records = completedCycleRecords(null, {
    phase: "WORK_RUNNING",
    connectionHealth: "connected",
    snapshotType: "INTERVAL",
    sessionId: "session-a",
    intervalIndex: 5,
    intervalWorkMs: 25 * 60_000,
    intervalRestMs: 5 * 60_000,
    phaseDurationMs: 25 * 60_000,
    expectedTransitionAt: NOW + 20 * 60_000,
  }, NOW);

  assert.deepEqual(records.map((record) => record.intervalIndex), [3, 1]);
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
    intervalIndex: 3,
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
  assert.equal(history[0].id, "paused-session:interval:1");
});

test("compacts duplicate interval records created by earlier versions", () => {
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

  assert.equal(history.length, 1);
  assert.equal(history[0].id, "session-a:interval:1");
  assert.equal(history[0].completedAt, NOW - 60_000);
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
