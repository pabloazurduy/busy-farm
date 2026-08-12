import { extensionApi } from "../shared/platform.js";
import { DEFAULT_RUNTIME, DEFAULT_SETTINGS, STORAGE_KEYS } from "./defaults.js";

export async function loadState() {
  const api = extensionApi();
  const stored = await api.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.SITES,
    STORAGE_KEYS.RUNTIME,
    STORAGE_KEYS.DIAGNOSTICS,
    STORAGE_KEYS.HISTORY,
  ]);
  const storedSettings = stored[STORAGE_KEYS.SETTINGS];
  let settings = mergeSettings(storedSettings);
  let sites = Array.isArray(stored[STORAGE_KEYS.SITES]) ? stored[STORAGE_KEYS.SITES] : [];

  if (Number(storedSettings?.removedDefaultSitesVersion ?? 0) < 1) {
    // Remove only rules created by the retired bundled-site migration. Rules
    // created manually keep their own IDs and are intentionally preserved.
    sites = removeRetiredBundledRules(sites);
    settings = { ...settings, removedDefaultSitesVersion: 1 };
    await api.storage.local.set({
      [STORAGE_KEYS.SETTINGS]: settings,
      [STORAGE_KEYS.SITES]: sites,
    });
  }

  return {
    settings,
    sites,
    runtime: { ...DEFAULT_RUNTIME, ...(stored[STORAGE_KEYS.RUNTIME] ?? {}) },
    diagnostics: Array.isArray(stored[STORAGE_KEYS.DIAGNOSTICS])
      ? stored[STORAGE_KEYS.DIAGNOSTICS]
      : [],
    history: Array.isArray(stored[STORAGE_KEYS.HISTORY])
      ? stored[STORAGE_KEYS.HISTORY]
      : [],
  };
}

export function removeRetiredBundledRules(sites) {
  return (Array.isArray(sites) ? sites : [])
    .filter((site) => !String(site.id ?? "").startsWith("default-"));
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
    developer: { ...DEFAULT_SETTINGS.developer, ...(stored?.developer ?? {}) },
  };
}

export async function saveSettings(settings) {
  await extensionApi().storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

export async function saveSites(sites) {
  await extensionApi().storage.local.set({ [STORAGE_KEYS.SITES]: sites });
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
