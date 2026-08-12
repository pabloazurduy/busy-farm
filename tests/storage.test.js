import test from "node:test";
import assert from "node:assert/strict";

import { CLOUD_BASE_URL } from "../src/busy/connection.js";
import { loadState, mergeSettings, saveSites } from "../src/state/storage.js";
import { STORAGE_KEYS } from "../src/state/defaults.js";

test("a saved Cloud token survives settings-schema updates", () => {
  const settings = mergeSettings({
    schemaVersion: 1,
    connection: {
      transport: "cloud",
      baseUrl: CLOUD_BASE_URL,
      token: "stored-cloud-token",
    },
  });

  assert.equal(settings.connection.transport, "cloud");
  assert.equal(settings.connection.baseUrl, CLOUD_BASE_URL);
  assert.equal(settings.connection.token, "stored-cloud-token");
  assert.equal(settings.schemaVersion, 2);
});

test("legacy non-Cloud credentials are not migrated as Cloud tokens", () => {
  const settings = mergeSettings({
    connection: {
      transport: "lan",
      baseUrl: "http://192.168.1.20/api",
      token: "local-password",
    },
  });

  assert.equal(settings.connection.transport, "cloud");
  assert.equal(settings.connection.token, "");
});

test("saved site rules survive state reloads regardless of their legacy IDs", async (context) => {
  const stored = {
    [STORAGE_KEYS.SITES]: [{ id: "default-old-rule", hostname: "kept.example" }],
  };
  globalThis.browser = storageMock(stored);
  context.after(() => { delete globalThis.browser; });

  const state = await loadState();
  assert.deepEqual(state.sites, stored[STORAGE_KEYS.SITES]);
  assert.deepEqual(stored[STORAGE_KEYS.SITES_BACKUP], state.sites);
});

test("site storage writes a local backup and can restore from it", async (context) => {
  const stored = {};
  globalThis.browser = storageMock(stored);
  context.after(() => { delete globalThis.browser; });
  const sites = [{ id: "custom-rule", hostname: "kept.example" }];

  await saveSites(sites);
  assert.deepEqual(stored[STORAGE_KEYS.SITES], sites);
  assert.deepEqual(stored[STORAGE_KEYS.SITES_BACKUP], sites);
  delete stored[STORAGE_KEYS.SITES];
  assert.deepEqual((await loadState()).sites, sites);
});

function storageMock(stored) {
  return {
    runtime: { getManifest: () => ({ manifest_version: 2 }) },
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]]));
        },
        async set(values) { Object.assign(stored, structuredClone(values)); },
      },
    },
  };
}
