import test from "node:test";
import assert from "node:assert/strict";

import { buildTimerCommand } from "../src/busy/control.js";

const NOW = 1_800_000_000_000;
const BAR_SETTINGS = {
  theme: "custom-theme",
  show_work_phase_only: true,
  trigger_smart_home: true,
};

test("starts a one-to-sixty minute focus timer while preserving Bar settings", () => {
  const result = buildTimerCommand({
    snapshot: { type: "NOT_STARTED", busy_bar_settings: BAR_SETTINGS },
    snapshot_timestamp_ms: NOW - 1000,
  }, "start", {
    durationMinutes: 35,
    now: NOW,
    createId: () => "new-card-id",
  });

  assert.deepEqual(result, {
    snapshot: {
      type: "SIMPLE",
      card_id: "new-card-id",
      time_left_ms: 35 * 60_000,
      is_paused: false,
      busy_bar_settings: BAR_SETTINGS,
    },
    snapshot_timestamp_ms: NOW,
  });
  assert.throws(() => buildTimerCommand({ snapshot: { type: "NOT_STARTED" } }, "start", {
    durationMinutes: 0,
  }), { code: "INVALID_TIMER_DURATION" });
}
);

test("pauses a running timer without restoring time from a cached Cloud snapshot", () => {
  const result = buildTimerCommand({
    snapshot: {
      type: "SIMPLE",
      card_id: "active-card",
      time_left_ms: 20 * 60_000,
      is_paused: false,
      busy_bar_settings: BAR_SETTINGS,
    },
    snapshot_timestamp_ms: NOW - 5 * 60_000,
  }, "pause", { now: NOW });

  assert.equal(result.snapshot.time_left_ms, 15 * 60_000);
  assert.equal(result.snapshot.is_paused, true);
  assert.deepEqual(result.snapshot.busy_bar_settings, BAR_SETTINGS);
});

test("resumes an interval timer without changing its remaining time or configuration", () => {
  const intervalSettings = {
    type: "INTERVAL",
    interval_work_ms: 25 * 60_000,
    interval_rest_ms: 5 * 60_000,
    interval_work_cycles_count: 4,
    is_autostart_enabled: false,
  };
  const result = buildTimerCommand({
    snapshot: {
      type: "INTERVAL",
      card_id: "interval-card",
      current_interval: 3,
      current_interval_time_total_ms: 25 * 60_000,
      current_interval_time_left_ms: 12 * 60_000,
      is_paused: true,
      interval_settings: intervalSettings,
      busy_bar_settings: BAR_SETTINGS,
    },
    snapshot_timestamp_ms: NOW - 30 * 60_000,
  }, "resume", { now: NOW });

  assert.equal(result.snapshot.is_paused, false);
  assert.equal(result.snapshot.current_interval_time_left_ms, 12 * 60_000);
  assert.deepEqual(result.snapshot.interval_settings, intervalSettings);
});

test("cancels an active timer with a NOT_STARTED snapshot", () => {
  const result = buildTimerCommand({
    snapshot: {
      type: "INFINITE",
      card_id: "infinite-card",
      is_paused: false,
      busy_bar_settings: BAR_SETTINGS,
    },
    snapshot_timestamp_ms: NOW,
  }, "cancel", { now: NOW });

  assert.deepEqual(result, {
    snapshot: { type: "NOT_STARTED", busy_bar_settings: BAR_SETTINGS },
    snapshot_timestamp_ms: NOW,
  });
});

test("rejects timer actions that do not match the current state", () => {
  assert.throws(() => buildTimerCommand({ snapshot: { type: "NOT_STARTED" } }, "pause"), {
    code: "TIMER_NOT_ACTIVE",
  });
  assert.throws(() => buildTimerCommand({
    snapshot: { type: "SIMPLE", card_id: "card", time_left_ms: 1000, is_paused: true },
  }, "pause"), { code: "TIMER_ALREADY_PAUSED" });
  assert.throws(() => buildTimerCommand({
    snapshot: { type: "SIMPLE", card_id: "card", time_left_ms: 1000, is_paused: false },
  }, "resume"), { code: "TIMER_NOT_PAUSED" });
});
