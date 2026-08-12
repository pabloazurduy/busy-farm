import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SITE_HOSTS,
  mergeDefaultSites,
} from "../src/state/default-sites.js";

const EXPECTED_HOSTS = [
  "instagram.com",
  "facebook.com",
  "youtube.com",
  "linkedin.com",
  "news.ycombinator.com",
  "reddit.com",
  "amazon.nl",
  "amazon.com",
  "bol.com",
];

test("defines the requested default block list", () => {
  assert.deepEqual(DEFAULT_SITE_HOSTS, EXPECTED_HOSTS);
  const sites = mergeDefaultSites([], "2026-08-12T00:00:00.000Z");
  assert.deepEqual(sites.map((site) => site.hostname), EXPECTED_HOSTS);
  assert.ok(sites.every((site) => site.enabled && site.includeSubdomains));
});

test("default-site migration is idempotent and preserves existing state", () => {
  const original = [{
    id: "existing-instagram",
    hostname: "instagram.com",
    includeSubdomains: false,
    permissionPattern: "*://instagram.com/*",
    enabled: false,
  }];
  const once = mergeDefaultSites(original);
  const twice = mergeDefaultSites(once);

  assert.equal(once.length, EXPECTED_HOSTS.length);
  assert.equal(twice.length, EXPECTED_HOSTS.length);
  assert.equal(once[0].id, "existing-instagram");
  assert.equal(once[0].enabled, false);
  assert.equal(once[0].includeSubdomains, true);
  assert.equal(once[0].permissionPattern, "*://*.instagram.com/*");
});
