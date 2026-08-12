export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "--:--";
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function phaseLabel(phase) {
  return {
    IDLE: "Ready",
    WORK_RUNNING: "Focus",
    WORK_PAUSED: "Paused",
    BREAK_RUNNING: "Break",
    BREAK_PAUSED: "Break paused",
    UNKNOWN_ACTIVE: "Active",
    DISCONNECTED: "Disconnected",
  }[phase] ?? "Ready";
}

export function transportLabel(transport) {
  return { usb: "USB", lan: "Local network", cloud: "BUSY Cloud" }[transport] ?? "BUSY";
}

export function friendlyError(error) {
  if (!error) return "Unknown connection error.";
  const code = error.code ?? error.name;
  const known = {
    PERMISSION_MISSING: "Firefox does not have permission to reach this BUSY address.",
    AUTH_REJECTED: "BUSY rejected the password or API token.",
    TIMEOUT: "BUSY did not respond in time.",
    BAD_RESPONSE: "BUSY returned a response this version cannot read.",
    INVALID_ENDPOINT: "The BUSY API address is not valid.",
    TRANSPORT_MISMATCH: error.message,
    CREDENTIAL_REQUIRED: error.message,
    NETWORK_ERROR: "BUSY is unreachable from this browser.",
  };
  return known[code] ?? error.message ?? "BUSY is unreachable from this browser.";
}
