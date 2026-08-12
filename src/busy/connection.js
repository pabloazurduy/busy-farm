export const CLOUD_BASE_URL = "https://api.busy.app/busybar";

export const CONNECTION_PRESETS = Object.freeze({
  cloud: Object.freeze({
    baseUrl: CLOUD_BASE_URL,
    placeholder: CLOUD_BASE_URL,
    credentialRequired: true,
  }),
});

export function normalizeTransport(value) {
  return "cloud";
}

export function validateTransportEndpoint(transportValue, baseUrl, token = "") {
  const transport = normalizeTransport(transportValue);
  let parsed;
  try {
    parsed = new URL(String(baseUrl ?? "").trim());
  } catch {
    throw new ConnectionConfigError("Enter a complete BUSY API address.", "INVALID_ENDPOINT");
  }

  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new ConnectionConfigError("The BUSY API address must use http or https.", "INVALID_ENDPOINT");
  }

  const normalizedBaseUrl = parsed.toString().replace(/\/$/, "");
  if (normalizedBaseUrl !== CLOUD_BASE_URL) {
    throw new ConnectionConfigError("Busy Farm uses the fixed BUSY Cloud API address.", "INVALID_ENDPOINT");
  }

  if (!String(token).trim()) {
    throw new ConnectionConfigError("BUSY Cloud API token is required.", "CREDENTIAL_REQUIRED");
  }

  return { transport, baseUrl: CLOUD_BASE_URL, token: String(token).trim() };
}

export function connectionFailureMessage(error) {
  if (!new Set(["NETWORK_ERROR", "TIMEOUT"]).has(error?.code)) return null;
  return "BUSY Cloud could not be reached. Confirm that the physical Bar is online in your BUSY account and that the Cloud API token is valid.";
}

export class ConnectionConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ConnectionConfigError";
    this.code = code;
  }
}
