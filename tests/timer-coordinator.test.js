import test from "node:test";
import assert from "node:assert/strict";

import { STORAGE_KEYS } from "../src/state/defaults.js";

const NOW = 1_800_000_000_000;

test("cancelling through the coordinator does not add a completed chicken", async (context) => {
  const stored = {
    [STORAGE_KEYS.SETTINGS]: {
      connection: {
        transport: "cloud",
        baseUrl: "https://api.busy.app/busybar",
        token: "write-token",
      },
    },
    [STORAGE_KEYS.RUNTIME]: {
      phase: "WORK_RUNNING",
      connectionHealth: "connected",
      sourceTransport: "cloud",
      snapshotType: "SIMPLE",
      sessionId: "cancelled-card",
      paused: false,
      phaseDurationMs: 25 * 60_000,
      remainingMs: 5000,
      expectedTransitionAt: NOW + 5000,
      lastSnapshotTimestamp: NOW - 1000,
      lastSuccessAt: NOW - 1000,
      blockingActive: false,
    },
  };
  const methods = [];
  const responses = [
    {
      snapshot: {
        type: "SIMPLE",
        card_id: "cancelled-card",
        time_left_ms: 5000,
        is_paused: false,
        busy_bar_settings: {
          theme: "on_air",
          show_work_phase_only: false,
          trigger_smart_home: false,
        },
      },
      snapshot_timestamp_ms: NOW - 1000,
    },
    { success: true },
    {
      snapshot: {
        type: "NOT_STARTED",
        busy_bar_settings: {
          theme: "on_air",
          show_work_phase_only: false,
          trigger_smart_home: false,
        },
      },
      snapshot_timestamp_ms: NOW,
    },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    methods.push(options.method);
    return { ok: true, status: 200, json: async () => responses.shift() };
  };
  globalThis.browser = firefoxMock(stored);
  context.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.browser;
  });

  const moduleUrl = new URL(`../src/background/coordinator.js?cancel-test=${Date.now()}`, import.meta.url);
  const { Coordinator } = await import(moduleUrl);
  const coordinator = new Coordinator();
  coordinator.schedule = () => {};
  await coordinator.initialize();

  const result = await coordinator.controlTimer("cancel");

  assert.deepEqual(methods, ["GET", "PUT", "GET"]);
  assert.equal(result.runtime.phase, "IDLE");
  assert.equal(result.history.length, 0);
});

function firefoxMock(stored) {
  const noOpEvent = { addListener() {} };
  return {
    runtime: {
      getManifest: () => ({ manifest_version: 2 }),
      getURL: (path) => `moz-extension://busy-farm/${path}`,
    },
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]]));
        },
        async set(values) { Object.assign(stored, structuredClone(values)); },
      },
    },
    alarms: { async get() { return null; }, async create() {} },
    browserAction: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setTitle() {},
    },
    webRequest: { onBeforeRequest: { addListener() {} } },
    tabs: { async query() { return []; }, async update() {}, async goBack() {} },
    permissions: {
      async contains() { return true; },
      async remove() { return true; },
      onRemoved: noOpEvent,
    },
  };
}
