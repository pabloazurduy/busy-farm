import test from "node:test";
import assert from "node:assert/strict";

import { blockingDecision, disconnectedRuntime } from "../src/busy/policy.js";
import { DEFAULT_SETTINGS } from "../src/state/defaults.js";

const settings = structuredClone(DEFAULT_SETTINGS);
const NOW = 2_000_000;

test("blocks work but not idle or break", () => {
  assert.equal(blockingDecision({ phase: "WORK_RUNNING" }, settings, NOW), true);
  assert.equal(blockingDecision({ phase: "IDLE" }, settings, NOW), false);
  assert.equal(blockingDecision({ phase: "BREAK_RUNNING" }, settings, NOW), false);
});

test("paused work follows the preference", () => {
  assert.equal(blockingDecision({ phase: "WORK_PAUSED" }, settings, NOW), false);
  const strict = structuredClone(settings);
  strict.behavior.blockWhilePaused = true;
  assert.equal(blockingDecision({ phase: "WORK_PAUSED" }, strict, NOW), true);
});

test("a timed session remains blocked briefly through a disconnect", () => {
  const runtime = {
    phase: "DISCONNECTED",
    blockingActive: true,
    lastSuccessAt: NOW - 5_000,
    expectedTransitionAt: NOW + 10_000,
  };
  assert.equal(blockingDecision(runtime, settings, NOW), true);
  assert.equal(blockingDecision(runtime, settings, NOW + 10_000 + settings.behavior.timedDisconnectPaddingMs + 1), false);
});

test("an infinite session uses a bounded disconnect grace period", () => {
  const runtime = {
    phase: "DISCONNECTED",
    blockingActive: true,
    lastSuccessAt: NOW,
    expectedTransitionAt: null,
  };
  assert.equal(blockingDecision(runtime, settings, NOW + settings.behavior.infiniteDisconnectGraceMs), true);
  assert.equal(blockingDecision(runtime, settings, NOW + settings.behavior.infiniteDisconnectGraceMs + 1), false);
});

test("disconnectedRuntime preserves the previous timer evidence", () => {
  const previous = { phase: "WORK_RUNNING", blockingActive: true, remainingMs: 40_000, lastSuccessAt: NOW };
  const next = disconnectedRuntime(previous, { code: "TIMEOUT", message: "slow" }, NOW + 5_000);
  assert.equal(next.phase, "DISCONNECTED");
  assert.equal(next.remainingMs, 40_000);
  assert.deepEqual(next.error, { code: "TIMEOUT", message: "slow", at: NOW + 5_000 });
});
