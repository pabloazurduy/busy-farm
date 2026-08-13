export class BusyClient {
  constructor(connection, { timeoutMs = 1800, fetchImpl = globalThis.fetch } = {}) {
    this.connection = connection;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  snapshotUrl() {
    const base = normalizeBaseUrl(this.connection.baseUrl);
    if (/\/busybar$/i.test(base)) return `${base}/busy/snapshot`;
    if (/\/busybar\/busy$/i.test(base)) return `${base}/snapshot`;
    return `${base}/busybar/busy/snapshot`;
  }

  async getSnapshot(externalSignal) {
    return this.requestSnapshot("GET", null, externalSignal);
  }

  async setSnapshot(payload, externalSignal) {
    return this.requestSnapshot("PUT", payload, externalSignal);
  }

  async requestSnapshot(method, payload, externalSignal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort("timeout"), this.timeoutMs);
    const startedAt = Date.now();

    try {
      // Native fetch is a branded browser method in some extension worker
      // contexts. Calling it as `this.fetchImpl(...)` binds `this` to the
      // BusyClient instance and Chromium rejects the call as an illegal
      // invocation. Explicitly use the global browser context instead.
      const response = await Reflect.apply(this.fetchImpl, globalThis, [
        this.snapshotUrl(),
        {
          method,
          headers: this.headers(payload != null),
          ...(payload == null ? {} : { body: JSON.stringify(payload) }),
          cache: "no-store",
          signal: controller.signal,
        },
      ]);
      if (response.status === 401 || response.status === 403) {
        throw new BusyClientError("BUSY rejected the configured credential.", "AUTH_REJECTED", response.status);
      }
      if (!response.ok) {
        throw new BusyClientError(`BUSY returned HTTP ${response.status}.`, "HTTP_ERROR", response.status);
      }
      let responsePayload;
      try {
        responsePayload = await response.json();
      } catch {
        throw new BusyClientError("BUSY returned invalid JSON.", "BAD_RESPONSE", response.status);
      }
      return { payload: responsePayload, latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (error instanceof BusyClientError) throw error;
      if (controller.signal.aborted) {
        throw new BusyClientError("BUSY did not respond in time.", "TIMEOUT");
      }
      throw new BusyClientError(error.message || "BUSY is unreachable.", "NETWORK_ERROR");
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }

  headers(hasJsonBody = false) {
    const headers = { Accept: "application/json" };
    if (hasJsonBody) headers["Content-Type"] = "application/json";
    const token = String(this.connection.token ?? "").trim();
    if (!token) return headers;
    if (this.connection.transport === "cloud") {
      headers.Authorization = `Bearer ${token}`;
    } else if (this.connection.transport === "lan") {
      headers["X-Api-Token"] = token;
    }
    return headers;
  }
}

export function normalizeBaseUrl(value) {
  const parsed = new URL(String(value).trim());
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new BusyClientError("BUSY must use http or https.", "INVALID_ENDPOINT");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

export class BusyClientError extends Error {
  constructor(message, code, status = null) {
    super(message);
    this.name = "BusyClientError";
    this.code = code;
    this.status = status;
  }
}
