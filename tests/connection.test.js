import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOUD_BASE_URL,
  CONNECTION_PRESETS,
  connectionFailureMessage,
  normalizeTransport,
  validateTransportEndpoint,
} from "../src/busy/connection.js";

test("defines BUSY Cloud as the only connection", () => {
  assert.deepEqual(Object.keys(CONNECTION_PRESETS), ["cloud"]);
  assert.equal(CONNECTION_PRESETS.cloud.baseUrl, CLOUD_BASE_URL);
  assert.equal(normalizeTransport("usb"), "cloud");
});

test("rejects non-Cloud endpoints", () => {
  assert.throws(
    () => validateTransportEndpoint("cloud", "http://10.0.4.20/api", "token"),
    { code: "INVALID_ENDPOINT" },
  );
});

test("requires a Cloud API token", () => {
  assert.throws(
    () => validateTransportEndpoint("cloud", CLOUD_BASE_URL),
    { code: "CREDENTIAL_REQUIRED" },
  );
});

test("returns normalized connection values", () => {
  assert.deepEqual(
    validateTransportEndpoint("cloud", " https://api.busy.app/busybar ", " token "),
    { transport: "cloud", baseUrl: "https://api.busy.app/busybar", token: "token" },
  );
});

test("connection failures explain BUSY Cloud", () => {
  const error = { code: "TIMEOUT" };
  assert.match(connectionFailureMessage(error), /BUSY Cloud/i);
  assert.equal(connectionFailureMessage({ code: "AUTH_REJECTED" }), null);
});
