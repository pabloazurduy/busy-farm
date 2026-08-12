import test from "node:test";
import assert from "node:assert/strict";

import {
  findMatchingSite,
  matchesSite,
  normalizeSiteInput,
  permissionPatternForEndpoint,
} from "../src/shared/site.js";

test("normalizes a URL to a lower-case hostname and wildcard permission", () => {
  assert.deepEqual(normalizeSiteInput(" HTTPS://News.Example.COM/path?q=1 "), {
    hostname: "news.example.com",
    includeSubdomains: true,
    permissionPattern: "*://*.news.example.com/*",
  });
});

test("does not wildcard IP addresses", () => {
  assert.deepEqual(normalizeSiteInput("192.168.1.20", { includeSubdomains: true }), {
    hostname: "192.168.1.20",
    includeSubdomains: false,
    permissionPattern: "*://192.168.1.20/*",
  });
});

test("rejects non-web schemes and credentials", () => {
  assert.throws(() => normalizeSiteInput("ftp://example.com"), { code: "UNSUPPORTED_SCHEME" });
  assert.throws(() => normalizeSiteInput("https://user:pass@example.com"), { code: "CREDENTIALS_IN_URL" });
});

test("subdomain matching is boundary safe", () => {
  const site = { hostname: "example.com", includeSubdomains: true, enabled: true };
  assert.equal(matchesSite("example.com", site), true);
  assert.equal(matchesSite("www.example.com", site), true);
  assert.equal(matchesSite("notexample.com", site), false);
  assert.equal(matchesSite("example.com.evil.test", site), false);
});

test("disabled and exact-only sites do not overmatch", () => {
  assert.equal(matchesSite("www.example.com", { hostname: "example.com", includeSubdomains: false }), false);
  assert.equal(matchesSite("example.com", { hostname: "example.com", includeSubdomains: true, enabled: false }), false);
});

test("findMatchingSite ignores internal and invalid URLs", () => {
  const sites = [{ hostname: "example.com", includeSubdomains: true, enabled: true }];
  assert.equal(findMatchingSite("https://a.example.com/read", sites), sites[0]);
  assert.equal(findMatchingSite("about:config", sites), null);
  assert.equal(findMatchingSite("not a url", sites), null);
});

test("endpoint permission is restricted to protocol and host", () => {
  assert.equal(permissionPatternForEndpoint("http://127.0.0.1:8787/api"), "http://127.0.0.1/*");
  assert.equal(permissionPatternForEndpoint("https://api.busy.app/busybar"), "https://api.busy.app/*");
  assert.throws(() => permissionPatternForEndpoint("file:///tmp/api"), { code: "UNSUPPORTED_ENDPOINT" });
});
