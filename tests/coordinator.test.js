import test from "node:test";
import assert from "node:assert/strict";

import { STORAGE_KEYS } from "../src/state/defaults.js";

test("coordinator follows a simulated BUSY work-to-break transition", async (context) => {
  const stored = {
    [STORAGE_KEYS.SETTINGS]: {
      connection: { transport: "usb", baseUrl: "http://10.0.4.20/api", token: "" },
      developer: { simulation: "work" },
    },
    [STORAGE_KEYS.SITES]: [{
      id: "rule-1",
      hostname: "example.com",
      includeSubdomains: true,
      permissionPattern: "*://*.example.com/*",
      enabled: true,
    }],
  };
  let requestListener;
  const tabUpdates = [];
  const badgeTexts = [];
  const badgeColors = [];
  globalThis.browser = firefoxMock(stored, {
    onRequest(listener) { requestListener = listener; },
    onTabUpdate(id, update) { tabUpdates.push({ id, update }); },
    onBadgeText(details) { badgeTexts.push(details.text); },
    onBadgeColor(details) { badgeColors.push(details.color); },
  });
  context.after(() => { delete globalThis.browser; });

  const { Coordinator } = await import("../src/background/coordinator.js");
  const coordinator = new Coordinator();
  coordinator.schedule = () => {};
  await coordinator.initialize();
  await coordinator.pollOnce();

  assert.equal(coordinator.runtime.phase, "WORK_RUNNING");
  assert.equal(coordinator.runtime.blockingActive, true);
  assert.match(
    requestListener({ url: "https://news.example.com/article", tabId: 7 }).redirectUrl,
    /pages\/blocked\/index\.html\?host=example\.com/,
  );
  assert.deepEqual(requestListener({ url: "https://notexample.com", tabId: 8 }), {});

  await coordinator.setSimulation("break");
  await coordinator.pollOnce();
  assert.equal(coordinator.runtime.phase, "BREAK_RUNNING");
  assert.equal(coordinator.runtime.blockingActive, false);
  assert.deepEqual(tabUpdates, []);

  const colorsBeforeIdle = badgeColors.length;
  await coordinator.setSimulation("idle");
  await coordinator.pollOnce();
  assert.equal(coordinator.runtime.phase, "IDLE");
  assert.equal(badgeTexts.at(-1), null);
  assert.equal(badgeColors.length, colorsBeforeIdle);
});

test("coordinator requires explicit origin permission before adding a rule", async (context) => {
  const stored = {};
  const mock = firefoxMock(stored, { hasPermission: false });
  globalThis.browser = mock;
  context.after(() => { delete globalThis.browser; });
  const moduleUrl = new URL(`../src/background/coordinator.js?permission-test=${Date.now()}`, import.meta.url);
  const { Coordinator } = await import(moduleUrl);
  const coordinator = new Coordinator();
  coordinator.schedule = () => {};
  await coordinator.initialize();
  const response = await coordinator.handleMessage({
    type: "ADD_SITE",
    payload: { hostname: "example.com", includeSubdomains: true },
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "PERMISSION_MISSING");
});

test("coordinator counts separate completed timers that reuse a BUSY card ID", async (context) => {
  const stored = {
    [STORAGE_KEYS.SETTINGS]: {
      connection: {
        transport: "cloud",
        baseUrl: "https://api.busy.app/busybar",
        token: "test-token",
      },
    },
  };
  const snapshots = [
    simpleSnapshot("reused-card"),
    idleSnapshot(),
    simpleSnapshot("reused-card"),
    idleSnapshot(),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => snapshots.shift(),
  });
  globalThis.browser = firefoxMock(stored);
  context.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.browser;
  });

  const moduleUrl = new URL(`../src/background/coordinator.js?history-test=${Date.now()}`, import.meta.url);
  const { Coordinator } = await import(moduleUrl);
  const coordinator = new Coordinator();
  coordinator.schedule = () => {};
  await coordinator.initialize();

  await coordinator.pollOnce();
  const firstRunId = coordinator.runtime.runId;
  await coordinator.pollOnce();
  await coordinator.pollOnce();
  const secondRunId = coordinator.runtime.runId;
  await coordinator.pollOnce();

  assert.notEqual(firstRunId, secondRunId);
  assert.equal(coordinator.history.length, 2);
  assert.equal(stored[STORAGE_KEYS.HISTORY].length, 2);
});

test("coordinator releases blocking while BUSY waits at zero", async (context) => {
  const now = Date.now();
  const stored = {
    [STORAGE_KEYS.SETTINGS]: {
      connection: {
        transport: "cloud",
        baseUrl: "https://api.busy.app/busybar",
        token: "test-token",
      },
    },
    [STORAGE_KEYS.SITES]: [{
      id: "rule-1",
      hostname: "example.com",
      includeSubdomains: true,
      permissionPattern: "*://*.example.com/*",
      enabled: true,
    }],
    [STORAGE_KEYS.RUNTIME]: {
      phase: "WORK_RUNNING",
      connectionHealth: "connected",
      sourceTransport: "cloud",
      snapshotType: "SIMPLE",
      sessionId: "completed-card",
      runId: "local-run-a",
      paused: false,
      phaseDurationMs: 25 * 60_000,
      remainingMs: 1000,
      expectedTransitionAt: now + 1000,
      lastSnapshotTimestamp: now - 1000,
      lastSuccessAt: now - 1000,
      blockingActive: true,
    },
  };
  let requestListener;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => simpleSnapshot("completed-card"),
  });
  globalThis.browser = firefoxMock(stored, {
    onRequest(listener) { requestListener = listener; },
  });
  context.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.browser;
  });

  const moduleUrl = new URL(`../src/background/coordinator.js?complete-test=${Date.now()}`, import.meta.url);
  const { Coordinator } = await import(moduleUrl);
  const coordinator = new Coordinator();
  coordinator.schedule = () => {};
  await coordinator.initialize();

  assert.match(
    requestListener({ url: "https://example.com/distraction", tabId: 7 }).redirectUrl,
    /pages\/blocked\/index\.html/,
  );
  await coordinator.pollOnce();

  assert.equal(coordinator.runtime.phase, "WORK_COMPLETE");
  assert.equal(coordinator.runtime.blockingActive, false);
  assert.deepEqual(requestListener({ url: "https://example.com/distraction", tabId: 7 }), {});
  assert.equal(coordinator.history.length, 1);
});

function simpleSnapshot(cardId) {
  return {
    snapshot: {
      type: "SIMPLE",
      card_id: cardId,
      time_left_ms: 0,
      total_time_ms: 25 * 60_000,
      is_paused: false,
    },
    snapshot_timestamp_ms: Date.now(),
  };
}

function idleSnapshot() {
  return {
    snapshot: { type: "NOT_STARTED" },
    snapshot_timestamp_ms: Date.now(),
  };
}

function firefoxMock(stored, hooks = {}) {
  const noOpEvent = { addListener() {} };
  return {
    runtime: {
      getManifest: () => ({ manifest_version: 2 }),
      getURL: (path) => `moz-extension://busy-forest/${path}`,
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
      async setBadgeText(details) { hooks.onBadgeText?.(details); },
      async setBadgeBackgroundColor(details) { hooks.onBadgeColor?.(details); },
      async setTitle() {},
    },
    webRequest: {
      onBeforeRequest: {
        addListener(listener) { hooks.onRequest?.(listener); },
      },
    },
    tabs: {
      async query() { return []; },
      async update(id, update) { hooks.onTabUpdate?.(id, update); },
      async goBack() {},
    },
    permissions: {
      async contains() { return hooks.hasPermission !== false; },
      async remove() { return true; },
      onRemoved: noOpEvent,
    },
  };
}
