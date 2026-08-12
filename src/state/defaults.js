export const STORAGE_KEYS = Object.freeze({
  SETTINGS: "busyForestSettings",
  SITES: "busyForestSites",
  RUNTIME: "busyForestRuntime",
  DIAGNOSTICS: "busyForestDiagnostics",
  HISTORY: "busyFarmHistory",
});

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 2,
  removedDefaultSitesVersion: 1,
  onboardingComplete: false,
  connection: {
    transport: "cloud",
    baseUrl: "https://api.busy.app/busybar",
    token: "",
  },
  behavior: {
    blockWhilePaused: false,
    restoreTabsAfterFocus: true,
    infiniteDisconnectGraceMs: 120000,
    timedDisconnectPaddingMs: 30000,
  },
  polling: {
    idleMs: 2000,
    activeMs: 1000,
    cloudIdleMs: 3000,
    timeoutMs: 1800,
  },
  appearance: {
    theme: "system",
  },
  developer: {
    simulation: null,
  },
});

export const DEFAULT_RUNTIME = Object.freeze({
  phase: "DISCONNECTED",
  connectionHealth: "unknown",
  sourceTransport: "cloud",
  snapshotType: null,
  sessionId: null,
  paused: false,
  phaseDurationMs: null,
  intervalIndex: null,
  intervalWorkMs: null,
  intervalRestMs: null,
  remainingMs: null,
  expectedTransitionAt: null,
  lastSuccessAt: null,
  lastSnapshotTimestamp: null,
  blockingActive: false,
  error: null,
});
