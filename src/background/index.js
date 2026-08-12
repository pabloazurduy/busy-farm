import { Coordinator, POLL_ALARM } from "./coordinator.js";
import { extensionApi } from "../shared/platform.js";

const api = extensionApi();
const coordinator = new Coordinator();
const ready = coordinator.initialize().catch((error) => {
  console.error("Busy Farm failed to initialize", error);
  throw error;
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ready
    .then(() => coordinator.handleMessage(message, sender))
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      error: { code: error.code ?? "INITIALIZATION_ERROR", message: error.message },
    }));
  return true;
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) ready.then(() => coordinator.pollOnce());
});

api.runtime.onStartup.addListener(() => {
  ready.then(() => coordinator.pollOnce());
});

api.runtime.onInstalled.addListener(() => {
  ready.then(() => coordinator.ensureAlarm());
});

api.permissions.onRemoved.addListener(() => {
  ready.then(() => coordinator.pollOnce());
});
