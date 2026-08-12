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
  globalThis.browser = firefoxMock(stored, {
    onRequest(listener) { requestListener = listener; },
    onTabUpdate(id, update) { tabUpdates.push({ id, update }); },
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
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
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
