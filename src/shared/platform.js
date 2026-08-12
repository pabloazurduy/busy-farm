export function extensionApi() {
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api) throw new Error("WebExtension API is unavailable");
  return api;
}

export function manifestVersion() {
  return extensionApi().runtime.getManifest().manifest_version;
}

export function isFirefoxBuild() {
  return manifestVersion() === 2;
}

export function actionApi() {
  const api = extensionApi();
  return api.action ?? api.browserAction;
}

export async function sendMessage(type, payload = {}) {
  return extensionApi().runtime.sendMessage({ type, payload });
}

export function onMessage(listener) {
  extensionApi().runtime.onMessage.addListener(listener);
}

export function openOptionsPage() {
  return extensionApi().runtime.openOptionsPage();
}

export function runtimeUrl(path) {
  return extensionApi().runtime.getURL(path);
}

export function addStorageListener(listener) {
  extensionApi().storage.onChanged.addListener(listener);
}

