import test from "node:test";
import assert from "node:assert/strict";

import { CLOUD_BASE_URL } from "../src/busy/connection.js";
import { mergeSettings, removeRetiredBundledRules } from "../src/state/storage.js";

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

test("removes retired bundled rules while preserving custom rules", () => {
  const sites = removeRetiredBundledRules([
    { id: "default-old-rule", hostname: "retired.example" },
    { id: "custom-rule", hostname: "kept.example" },
  ]);

  assert.deepEqual(sites, [{ id: "custom-rule", hostname: "kept.example" }]);
});
