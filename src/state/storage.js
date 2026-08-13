import { extensionApi } from "../shared/platform.js";
import { DEFAULT_RUNTIME, DEFAULT_SETTINGS, STORAGE_KEYS } from "./defaults.js";
import { compactCycleHistory } from "./history.js";

export async function loadState() {
  const api = extensionApi();
  const stored = await api.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.SITES,
    STORAGE_KEYS.SITES_BACKUP,
    STORAGE_KEYS.RUNTIME,
    STORAGE_KEYS.DIAGNOSTICS,
    STORAGE_KEYS.HISTORY,
  ]);
  const storedSettings = stored[STORAGE_KEYS.SETTINGS];
  const settings = mergeSettings(storedSettings);
  const primarySites = stored[STORAGE_KEYS.SITES];
  const backupSites = stored[STORAGE_KEYS.SITES_BACKUP];
  const sites = cloneSites(Array.isArray(primarySites)
    ? primarySites
    : Array.isArray(backupSites)
      ? backupSites
      : []);
  const storedHistory = Array.isArray(stored[STORAGE_KEYS.HISTORY])
    ? stored[STORAGE_KEYS.HISTORY]
    : [];
  const history = compactCycleHistory(storedHistory);

  if (!sameSites(primarySites, sites) || !sameSites(backupSites, sites)) {
    await api.storage.local.set({
      [STORAGE_KEYS.SITES]: sites,
      [STORAGE_KEYS.SITES_BACKUP]: sites,
    });
  }

  if (history.length !== storedHistory.length
    || history.some((record, index) => record.id !== storedHistory[index]?.id)) {
    await api.storage.local.set({ [STORAGE_KEYS.HISTORY]: history });
  }

  return {
    settings,
    sites,
    runtime: { ...DEFAULT_RUNTIME, ...(stored[STORAGE_KEYS.RUNTIME] ?? {}) },
    diagnostics: Array.isArray(stored[STORAGE_KEYS.DIAGNOSTICS])
      ? stored[STORAGE_KEYS.DIAGNOSTICS]
      : [],
    history,
  };
}

export function mergeSettings(stored) {
  const storedConnection = stored?.connection ?? {};
  const cloudToken = storedConnection.transport === "cloud"
    ? String(storedConnection.token ?? "")
    : "";
  return {
    ...DEFAULT_SETTINGS,
    ...(stored ?? {}),
    schemaVersion: DEFAULT_SETTINGS.schemaVersion,
    connection: { ...DEFAULT_SETTINGS.connection, token: cloudToken },
    behavior: { ...DEFAULT_SETTINGS.behavior, ...(stored?.behavior ?? {}) },
    polling: { ...DEFAULT_SETTINGS.polling, ...(stored?.polling ?? {}) },
    appearance: { ...DEFAULT_SETTINGS.appearance, ...(stored?.appearance ?? {}) },
    timer: { ...DEFAULT_SETTINGS.timer, ...(stored?.timer ?? {}) },
    developer: { ...DEFAULT_SETTINGS.developer, ...(stored?.developer ?? {}) },
  };
}

export async function saveSettings(settings) {
  await extensionApi().storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

export async function saveSites(sites) {
  const savedSites = cloneSites(sites);
  await extensionApi().storage.local.set({
    [STORAGE_KEYS.SITES]: savedSites,
    [STORAGE_KEYS.SITES_BACKUP]: savedSites,
  });
}

export async function saveRuntime(runtime) {
  await extensionApi().storage.local.set({ [STORAGE_KEYS.RUNTIME]: runtime });
}

export async function saveDiagnostics(entries) {
  await extensionApi().storage.local.set({ [STORAGE_KEYS.DIAGNOSTICS]: entries.slice(-100) });
}

export async function saveHistory(entries) {
  await extensionApi().storage.local.set({ [STORAGE_KEYS.HISTORY]: entries.slice(-10000) });
}

function cloneSites(sites) {
  return (Array.isArray(sites) ? sites : []).map((site) => ({ ...site }));
}

function sameSites(value, sites) {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(sites);
}
