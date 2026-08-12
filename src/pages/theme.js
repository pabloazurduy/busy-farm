import { extensionApi } from "../shared/platform.js";
import { STORAGE_KEYS } from "../state/defaults.js";

const api = extensionApi();

applyStoredTheme();
api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEYS.SETTINGS]) return;
  applyTheme(changes[STORAGE_KEYS.SETTINGS].newValue?.appearance?.theme);
});

async function applyStoredTheme() {
  const stored = await api.storage.local.get(STORAGE_KEYS.SETTINGS);
  applyTheme(stored[STORAGE_KEYS.SETTINGS]?.appearance?.theme);
}

function applyTheme(theme) {
  const selected = new Set(["light", "dark"]).has(theme) ? theme : "system";
  if (selected === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = selected;
}
