import test from "node:test";
import assert from "node:assert/strict";

import { BusyClient, normalizeBaseUrl } from "../src/busy/client.js";

test("constructs local and cloud snapshot URLs", () => {
  assert.equal(new BusyClient({ baseUrl: "http://10.0.4.20/api", transport: "usb" }).snapshotUrl(), "http://10.0.4.20/api/busybar/busy/snapshot");
  assert.equal(new BusyClient({ baseUrl: "https://api.busy.app/busybar/", transport: "cloud" }).snapshotUrl(), "https://api.busy.app/busybar/busy/snapshot");
  assert.equal(new BusyClient({ baseUrl: "http://device/api/busybar/busy", transport: "lan" }).snapshotUrl(), "http://device/api/busybar/busy/snapshot");
});

test("uses the documented authentication header for LAN and cloud", () => {
  assert.deepEqual(new BusyClient({ transport: "usb", token: "ignored" }).headers(), { Accept: "application/json" });
  assert.deepEqual(new BusyClient({ transport: "lan", token: "1234" }).headers(), { Accept: "application/json", "X-Api-Token": "1234" });
  assert.deepEqual(new BusyClient({ transport: "cloud", token: "abc" }).headers(), { Accept: "application/json", Authorization: "Bearer abc" });
});

test("fetches and returns JSON payloads", async () => {
  let request;
  const client = new BusyClient(
    { baseUrl: "http://device/api", transport: "lan", token: "secret" },
    { fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ snapshot: { type: "NOT_STARTED" } }) };
    } },
  );
  const result = await client.getSnapshot();
  assert.equal(request.url, "http://device/api/busybar/busy/snapshot");
  assert.equal(request.options.headers["X-Api-Token"], "secret");
  assert.equal(result.payload.snapshot.type, "NOT_STARTED");
});

test("invokes fetch with the browser global instead of the client instance", async () => {
  let receiver;
  const fetchImpl = function () {
    receiver = this;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ snapshot: { type: "NOT_STARTED" } }),
    });
  };

  const client = new BusyClient(
    { baseUrl: "https://api.busy.app/busybar", transport: "cloud", token: "test" },
    { fetchImpl },
  );
  await client.getSnapshot();

  assert.equal(receiver, globalThis);
});

test("maps authentication and malformed JSON failures", async () => {
  const unauthorized = new BusyClient(
    { baseUrl: "http://device/api", transport: "lan" },
    { fetchImpl: async () => ({ ok: false, status: 403 }) },
  );
  await assert.rejects(unauthorized.getSnapshot(), { code: "AUTH_REJECTED", status: 403 });

  const malformed = new BusyClient(
    { baseUrl: "http://device/api", transport: "usb" },
    { fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } }) },
  );
  await assert.rejects(malformed.getSnapshot(), { code: "BAD_RESPONSE" });
});

test("normalizes a base URL and rejects non-http protocols", () => {
  assert.equal(normalizeBaseUrl("https://example.com/api/?ignored=yes#hash"), "https://example.com/api");
  assert.throws(() => normalizeBaseUrl("file:///tmp/device"), { code: "INVALID_ENDPOINT" });
});
