import test from "node:test";
import assert from "node:assert/strict";

import { normalizeBusySnapshot } from "../src/busy/normalize.js";

const NOW = 1_800_000_000_000;

test("normalizes an idle snapshot", () => {
  const result = normalizeBusySnapshot({ snapshot: { type: "NOT_STARTED" }, snapshot_timestamp_ms: NOW - 5 }, NOW);
  assert.equal(result.phase, "IDLE");
  assert.equal(result.blockingActive, undefined);
  assert.equal(result.lastSnapshotTimestamp, NOW - 5);
  assert.equal(result.expectedTransitionAt, null);
});

test("normalizes running and paused simple timers", () => {
  const running = normalizeBusySnapshot({
    snapshot: { type: "SIMPLE", card_id: "session", time_left_ms: 90_000, is_paused: false },
    snapshot_timestamp_ms: NOW,
  }, NOW);
  assert.equal(running.phase, "WORK_RUNNING");
  assert.equal(running.remainingMs, 90_000);
  assert.equal(running.expectedTransitionAt, NOW + 90_000);
  assert.equal(running.phaseDurationMs, 90_000);

  const paused = normalizeBusySnapshot({
    snapshot: { type: "SIMPLE", card_id: "session", time_left_ms: 80_000, is_paused: true },
    snapshot_timestamp_ms: NOW,
  }, NOW);
  assert.equal(paused.phase, "WORK_PAUSED");
  assert.equal(paused.expectedTransitionAt, null);
});

test("deducts the age of a cached Cloud snapshot from a running timer", () => {
  const fifteenMinutes = 15 * 60 * 1000;
  const thirtyFiveMinutes = 35 * 60 * 1000;
  const result = normalizeBusySnapshot({
    snapshot: {
      type: "INTERVAL",
      card_id: "cached-cloud-session",
      current_interval: 0,
      current_interval_time_total_ms: thirtyFiveMinutes,
      current_interval_time_left_ms: thirtyFiveMinutes,
      is_paused: false,
      interval_settings: {
        interval_work_ms: thirtyFiveMinutes,
        interval_rest_ms: 5 * 60 * 1000,
      },
    },
    snapshot_timestamp_ms: NOW - fifteenMinutes,
  }, NOW);

  assert.equal(result.remainingMs, 20 * 60 * 1000);
  assert.equal(result.expectedTransitionAt, NOW + 20 * 60 * 1000);
});

test("does not deduct snapshot age while a timer is paused", () => {
  const result = normalizeBusySnapshot({
    snapshot: { type: "SIMPLE", card_id: "paused", time_left_ms: 20 * 60 * 1000, is_paused: true },
    snapshot_timestamp_ms: NOW - 15 * 60 * 1000,
  }, NOW);

  assert.equal(result.remainingMs, 20 * 60 * 1000);
  assert.equal(result.expectedTransitionAt, null);
});

test("marks a work timer complete when BUSY remains at zero", () => {
  const result = normalizeBusySnapshot({
    snapshot: {
      type: "SIMPLE",
      card_id: "completed-card",
      time_left_ms: 25 * 60_000,
      total_time_ms: 25 * 60_000,
      is_paused: false,
    },
    snapshot_timestamp_ms: NOW - 30 * 60_000,
  }, NOW);

  assert.equal(result.phase, "WORK_COMPLETE");
  assert.equal(result.remainingMs, 0);
  assert.equal(result.expectedTransitionAt, NOW - 5 * 60_000);
});

test("does not treat a completed break as completed work", () => {
  const result = normalizeBusySnapshot({
    snapshot: {
      type: "INTERVAL",
      card_id: "break-card",
      current_interval: 1,
      current_interval_time_total_ms: 5 * 60_000,
      current_interval_time_left_ms: 0,
      is_paused: false,
      interval_settings: {
        interval_work_ms: 25 * 60_000,
        interval_rest_ms: 5 * 60_000,
      },
    },
    snapshot_timestamp_ms: NOW,
  }, NOW);

  assert.equal(result.phase, "BREAK_RUNNING");
  assert.equal(result.remainingMs, 0);
});

test("normalizes an infinite work timer", () => {
  const result = normalizeBusySnapshot({
    snapshot: { type: "INFINITE", card_id: "deep-work", is_paused: false },
    snapshot_timestamp_ms: NOW,
  }, NOW);
  assert.equal(result.phase, "WORK_RUNNING");
  assert.equal(result.remainingMs, null);
});

test("identifies interval work and break phases by configured duration", () => {
  const common = {
    type: "INTERVAL",
    card_id: "pomodoro",
    current_interval_time_left_ms: 50_000,
    is_paused: false,
    interval_settings: { interval_work_ms: 120_000, interval_rest_ms: 60_000 },
  };
  const work = normalizeBusySnapshot({ snapshot: { ...common, current_interval: 0, current_interval_time_total_ms: 120_000 } }, NOW);
  const rest = normalizeBusySnapshot({ snapshot: { ...common, current_interval: 1, current_interval_time_total_ms: 60_000 } }, NOW);
  assert.equal(work.phase, "WORK_RUNNING");
  assert.equal(rest.phase, "BREAK_RUNNING");
});

test("falls back to BUSY's zero-based interval parity when durations are ambiguous", () => {
  const snapshot = {
    type: "INTERVAL",
    card_id: "pomodoro",
    current_interval_time_total_ms: 60_000,
    current_interval_time_left_ms: 50_000,
    is_paused: false,
    interval_settings: { interval_work_ms: 60_000, interval_rest_ms: 60_000 },
  };
  assert.equal(normalizeBusySnapshot({ snapshot: { ...snapshot, current_interval: 0 } }, NOW).phase, "WORK_RUNNING");
  assert.equal(normalizeBusySnapshot({ snapshot: { ...snapshot, current_interval: 1 } }, NOW).phase, "BREAK_RUNNING");
  assert.equal(normalizeBusySnapshot({ snapshot: { ...snapshot, current_interval: 2 } }, NOW).phase, "WORK_RUNNING");
});

test("rejects unknown types and malformed countdown values", () => {
  assert.throws(() => normalizeBusySnapshot({ snapshot: { type: "FUTURE_MODE" } }, NOW), { code: "BAD_RESPONSE" });
  assert.throws(() => normalizeBusySnapshot({ snapshot: { type: "SIMPLE", time_left_ms: -1 } }, NOW), { code: "BAD_RESPONSE" });
  assert.throws(() => normalizeBusySnapshot({ snapshot: { type: "SIMPLE", time_left_ms: null } }, NOW), { code: "BAD_RESPONSE" });
});
