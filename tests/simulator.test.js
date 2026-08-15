import test from "node:test";
import assert from "node:assert/strict";

import { isSnapshotPath, snapshotFor, startMode } from "./simulator/server.mjs";

const START = 10_000;

test("simulator exposes every supported snapshot route", () => {
  assert.equal(isSnapshotPath("/api/busybar/busy/snapshot"), true);
  assert.equal(isSnapshotPath("/busybar/busy/snapshot"), true);
  assert.equal(isSnapshotPath("/busy/snapshot"), true);
  assert.equal(isSnapshotPath("/api/status"), false);
});

test("simulator creates official-shaped idle and work snapshots", () => {
  const idle = snapshotFor(startMode("idle", START), START + 100);
  assert.equal(idle.snapshot.type, "NOT_STARTED");
  assert.equal(idle.snapshot_timestamp_ms, START + 100);

  const work = snapshotFor(startMode("work", START), START + 1_000);
  assert.equal(work.snapshot.type, "SIMPLE");
  assert.equal(work.snapshot.is_paused, false);
  assert.equal(work.snapshot.time_left_ms, 25 * 60 * 1000 - 1_000);
});

test("simulator creates paused, infinite, and break snapshots", () => {
  assert.equal(snapshotFor(startMode("paused", START), START + 500).snapshot.is_paused, true);
  assert.equal(snapshotFor(startMode("infinite", START), START + 500).snapshot.type, "INFINITE");
  const rest = snapshotFor(startMode("break", START), START + 500).snapshot;
  assert.equal(rest.type, "INTERVAL");
  assert.equal(rest.current_interval, 1);
  assert.equal(rest.current_interval_time_total_ms, rest.interval_settings.interval_rest_ms);
});
