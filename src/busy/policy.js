export function blockingDecision(runtime, settings, now = Date.now()) {
  switch (runtime.phase) {
    case "WORK_RUNNING":
      return true;
    case "WORK_PAUSED":
      return Boolean(settings.behavior.blockWhilePaused);
    case "WORK_COMPLETE":
    case "IDLE":
    case "BREAK_RUNNING":
    case "BREAK_PAUSED":
      return false;
    case "DISCONNECTED":
    case "UNKNOWN_ACTIVE":
      return disconnectedDecision(runtime, settings, now);
    default:
      return false;
  }
}

function disconnectedDecision(runtime, settings, now) {
  if (!runtime.blockingActive || !runtime.lastSuccessAt) return false;
  if (runtime.expectedTransitionAt) {
    return now <= runtime.expectedTransitionAt + settings.behavior.timedDisconnectPaddingMs;
  }
  return now <= runtime.lastSuccessAt + settings.behavior.infiniteDisconnectGraceMs;
}

export function disconnectedRuntime(previous, error, now = Date.now()) {
  return {
    ...previous,
    phase: "DISCONNECTED",
    connectionHealth: "disconnected",
    error: {
      code: error.code ?? "NETWORK_ERROR",
      message: error.message ?? "BUSY is unreachable.",
      at: now,
    },
  };
}
