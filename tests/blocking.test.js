import test from "node:test";
import assert from "node:assert/strict";

test("Chromium blocking uses scoped dynamic navigation rules", async (context) => {
  const updates = [];
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ manifest_version: 3 }),
      getURL: (path) => `chrome-extension://busy-forest/${path}`,
    },
    declarativeNetRequest: {
      async getDynamicRules() { return []; },
      async updateDynamicRules(change) { updates.push(change); },
    },
    tabs: { async query() { return []; }, async update() {}, async goBack() {} },
  };
  context.after(() => { delete globalThis.chrome; });

  const { BlockEngine } = await import("../src/blocking/engine.js");
  const engine = new BlockEngine();
  await engine.initialize(true, [
    { hostname: "example.com", includeSubdomains: true, enabled: true },
    { hostname: "exact.test", includeSubdomains: false, enabled: true },
    { hostname: "off.test", includeSubdomains: true, enabled: false },
  ]);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].addRules.length, 2);
  assert.equal(updates[0].addRules[0].condition.urlFilter, "||example.com^");
  assert.equal(updates[0].addRules[0].condition.resourceTypes[0], "main_frame");
  assert.equal(updates[0].addRules[1].condition.regexFilter, "^https?://exact\\.test(:[0-9]+)?(/|$)");
  assert.equal(updates[0].addRules[0].action.redirect.extensionPath, "/pages/blocked/index.html");

  await engine.update(true, [
    { hostname: "example.com", includeSubdomains: true, enabled: true },
    { hostname: "exact.test", includeSubdomains: false, enabled: true },
  ], { enforceTabs: false });
  assert.equal(updates.length, 1, "unchanged rules should not be rewritten on every poll");

  await engine.update(false, []);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1].addRules, []);
});
