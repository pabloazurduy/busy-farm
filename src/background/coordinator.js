import { BusyClient } from "../busy/client.js";
import { CLOUD_BASE_URL, validateTransportEndpoint } from "../busy/connection.js";
import { buildTimerCommand, MAX_TIMER_MINUTES } from "../busy/control.js";
import { normalizeBusySnapshot } from "../busy/normalize.js";
import { blockingDecision, disconnectedRuntime } from "../busy/policy.js";
import { BlockEngine } from "../blocking/engine.js";
import { DEFAULT_RUNTIME, STORAGE_KEYS } from "../state/defaults.js";
import {
  completedCycleRecords,
  mergeCycleHistory,
  resolveCycleRunId,
} from "../state/history.js";
import {
  loadState,
  mergeSettings,
  saveDiagnostics,
  saveHistory,
  saveRuntime,
  saveSettings,
  saveSites,
} from "../state/storage.js";
import { MESSAGE, fail, ok } from "../shared/messages.js";
import { actionApi, extensionApi, manifestVersion } from "../shared/platform.js";
import {
  findMatchingSite,
  newSite,
  normalizeSiteInput,
  permissionPatternForEndpoint,
} from "../shared/site.js";

export const POLL_ALARM = "busy-forest-poll";
const MAX_SITES = 1000;

export class Coordinator {
  constructor() {
    this.api = extensionApi();
    this.blockEngine = new BlockEngine();
    this.settings = null;
    this.sites = [];
    this.runtime = { ...DEFAULT_RUNTIME };
    this.diagnostics = [];
    this.history = [];
    this.pollTimer = null;
    this.pollInFlight = null;
    this.timerCommandInFlight = null;
    this.suppressedCompletionSessionId = null;
    this.failureCount = 0;
    this.stopped = false;
  }

  async initialize() {
    const state = await loadState();
    this.settings = state.settings;
    this.sites = state.sites;
    this.runtime = state.runtime;
    this.diagnostics = state.diagnostics;
    this.history = state.history;
    await this.blockEngine.initialize(this.runtime.blockingActive, this.sites);
    await this.ensureAlarm();
    await this.updateAction();
    this.schedule(50);
  }

  async ensureAlarm() {
    const alarm = await this.api.alarms.get(POLL_ALARM);
    if (!alarm) {
      await this.api.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
    }
  }

  schedule(delayMs) {
    clearTimeout(this.pollTimer);
    if (this.stopped) return;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollOnce();
      } catch (error) {
        console.error("Busy Farm poll failed", error);
      } finally {
        this.schedule(this.nextPollDelay());
      }
    }, delayMs);
  }

  nextPollDelay() {
    if (this.failureCount > 0) {
      const steps = [1000, 2000, 4000, 8000, 15000, 30000];
      return steps[Math.min(this.failureCount - 1, steps.length - 1)];
    }
    const active = new Set(["WORK_RUNNING", "WORK_PAUSED", "WORK_COMPLETE", "BREAK_RUNNING", "BREAK_PAUSED"])
      .has(this.runtime.phase);
    if (active) return this.settings.polling.activeMs;
    if (this.settings.connection.transport === "cloud") return this.settings.polling.cloudIdleMs;
    return this.settings.polling.idleMs;
  }

  async pollOnce({ connection = this.settings.connection, testOnly = false } = {}) {
    if (this.timerCommandInFlight && !testOnly) return this.timerCommandInFlight;
    if (this.pollInFlight && !testOnly) return this.pollInFlight;
    const task = this.performPoll(connection, testOnly);
    if (!testOnly) this.pollInFlight = task;
    try {
      return await task;
    } finally {
      if (!testOnly) this.pollInFlight = null;
    }
  }

  async performPoll(connection, testOnly) {
    const simulation = !testOnly ? this.settings.developer.simulation : null;
    const startedAt = Date.now();
    const priorPhase = this.runtime.phase;
    const priorHealth = this.runtime.connectionHealth;
    const priorErrorCode = this.runtime.error?.code;
    try {
      const result = simulation
        ? { payload: simulatedPayload(simulation), latencyMs: 0 }
        : await new BusyClient(connection, { timeoutMs: this.settings.polling.timeoutMs }).getSnapshot();
      const normalized = normalizeBusySnapshot(result.payload);
      if (normalized.snapshotType === "SIMPLE") {
        const sameSession = normalized.sessionId && normalized.sessionId === this.runtime.sessionId;
        const priorDuration = sameSession ? Number(this.runtime.phaseDurationMs) : 0;
        const observedDuration = Number(normalized.phaseDurationMs);
        normalized.phaseDurationMs = Math.max(
          Number.isFinite(priorDuration) ? priorDuration : 0,
          Number.isFinite(observedDuration) ? observedDuration : 0,
        ) || null;
      }
      if (testOnly) return { normalized, latencyMs: result.latencyMs };
      if (
        this.runtime.lastSnapshotTimestamp != null
        && normalized.lastSnapshotTimestamp < this.runtime.lastSnapshotTimestamp
      ) {
        await this.log("stale_snapshot", { latencyMs: result.latencyMs });
        return this.publicState();
      }
      this.failureCount = 0;
      const previousBlocking = this.runtime.blockingActive;
      const previousRuntime = this.runtime;
      normalized.runId = resolveCycleRunId(previousRuntime, normalized, startedAt);
      this.runtime = {
        ...this.runtime,
        ...normalized,
        sourceTransport: simulation ? "simulation" : connection.transport,
      };
      const completionSuppressed = this.suppressedCompletionSessionId != null
        && (previousRuntime.sessionId === this.suppressedCompletionSessionId
          || this.runtime.sessionId === this.suppressedCompletionSessionId);
      if (!simulation && !completionSuppressed) {
        const nextHistory = mergeCycleHistory(
          this.history,
          completedCycleRecords(previousRuntime, this.runtime),
        );
        if (nextHistory !== this.history) {
          this.history = nextHistory;
          await saveHistory(this.history);
        }
      }
      if (this.suppressedCompletionSessionId != null
        && (this.runtime.phase === "IDLE"
          || (this.runtime.sessionId && this.runtime.sessionId !== this.suppressedCompletionSessionId))) {
        this.suppressedCompletionSessionId = null;
      }
      this.runtime.blockingActive = blockingDecision(this.runtime, this.settings);
      await this.commitRuntime(previousBlocking);
      if (priorPhase !== this.runtime.phase || priorHealth !== this.runtime.connectionHealth) {
        await this.log("snapshot", {
          phase: this.runtime.phase,
          latencyMs: result.latencyMs,
          snapshotType: this.runtime.snapshotType,
        });
      }
      return this.publicState();
    } catch (error) {
      if (testOnly) throw error;
      this.failureCount += 1;
      const previousBlocking = this.runtime.blockingActive;
      this.runtime = disconnectedRuntime(this.runtime, error);
      this.runtime.blockingActive = blockingDecision(this.runtime, this.settings);
      await this.commitRuntime(previousBlocking);
      if (priorHealth !== "disconnected" || priorErrorCode !== (error.code ?? "NETWORK_ERROR")) {
        await this.log("poll_error", {
          code: error.code ?? "NETWORK_ERROR",
          latencyMs: Date.now() - startedAt,
        });
      }
      return this.publicState();
    }
  }

  async commitRuntime(previousBlocking) {
    await saveRuntime(this.runtime);
    const changed = previousBlocking !== this.runtime.blockingActive;
    await this.blockEngine.update(this.runtime.blockingActive, this.sites, {
      enforceTabs: this.runtime.blockingActive && changed,
      restoreTabs: this.settings.behavior.restoreTabsAfterFocus,
    });
    await this.updateAction();
  }

  async updateAction() {
    const action = actionApi();
    const remaining = this.currentRemainingMs();
    let text = null;
    let color = null;
    if (this.runtime.phase === "WORK_RUNNING") {
      text = remaining == null ? "ON" : String(Math.max(1, Math.ceil(remaining / 60000)));
      color = "#2ba896";
    } else if (this.runtime.phase.includes("BREAK")) {
      text = "B";
      color = "#d28a2d";
    } else if (this.runtime.phase === "DISCONNECTED") {
      text = "!";
      color = "#c75b64";
    }
    const titleTask = action.setTitle({
      title: `Busy Farm · ${this.runtime.phase.replaceAll("_", " ").toLowerCase()}`,
    }).catch(() => null);
    if (text == null) {
      // Firefox can retain an empty badge capsule if its text and color are
      // updated concurrently. Null explicitly removes the global MV2 badge;
      // Chromium's MV3 API uses the empty string for the equivalent reset.
      const clearedText = manifestVersion() === 2 ? null : "";
      await Promise.all([
        action.setBadgeText({ text: clearedText }).catch(() => null),
        titleTask,
      ]);
      return;
    }
    // Set the color before revealing the text to avoid a default-color flash.
    await action.setBadgeBackgroundColor({ color }).catch(() => null);
    await Promise.all([
      action.setBadgeText({ text }).catch(() => null),
      titleTask,
    ]);
  }

  currentRemainingMs() {
    if (this.runtime.paused || this.runtime.expectedTransitionAt == null) {
      return this.runtime.remainingMs;
    }
    return Math.max(0, this.runtime.expectedTransitionAt - Date.now());
  }

  publicState() {
    return {
      settings: {
        ...this.settings,
        connection: {
          ...this.settings.connection,
          token: "",
          hasToken: Boolean(this.settings.connection.token),
        },
      },
      sites: this.sites,
      runtime: { ...this.runtime, remainingMs: this.currentRemainingMs() },
      diagnostics: this.diagnostics.slice(-20),
      history: this.history,
      platform: {
        manifestVersion: manifestVersion(),
        reliableRealtimePolling: manifestVersion() === 2,
      },
    };
  }

  async handleMessage(message, sender) {
    const type = message?.type;
    const payload = message?.payload ?? {};
    try {
      switch (type) {
        case MESSAGE.GET_STATE:
          return ok(this.publicState());
        case MESSAGE.REFRESH:
          await this.pollOnce();
          return ok(this.publicState());
        case MESSAGE.TEST_CONNECTION:
          return ok(await this.testConnection(payload.connection));
        case MESSAGE.SAVE_CONNECTION:
          return ok(await this.saveConnection(payload.connection));
        case MESSAGE.SAVE_PREFERENCES:
          return ok(await this.savePreferences(payload));
        case MESSAGE.SAVE_TIMER_DURATION:
          return ok(await this.saveTimerDuration(payload.durationMinutes));
        case MESSAGE.START_TIMER:
          return ok(await this.controlTimer("start", payload));
        case MESSAGE.PAUSE_TIMER:
          return ok(await this.controlTimer("pause"));
        case MESSAGE.RESUME_TIMER:
          return ok(await this.controlTimer("resume"));
        case MESSAGE.CANCEL_TIMER:
          return ok(await this.controlTimer("cancel"));
        case MESSAGE.ADD_SITE:
          return ok(await this.addSite(payload));
        case MESSAGE.REMOVE_SITE:
          return ok(await this.removeSite(payload.id));
        case MESSAGE.TOGGLE_SITE:
          return ok(await this.toggleSite(payload.id, payload.enabled));
        case MESSAGE.UPDATE_SITE:
          return ok(await this.updateSite(payload));
        case MESSAGE.GET_CURRENT_TAB:
          return ok(await this.currentTab());
        case MESSAGE.RESTORE_TAB:
          return ok({ restored: await this.blockEngine.restoreTab(sender?.tab?.id ?? payload.tabId) });
        case MESSAGE.EXPORT_SETTINGS:
          return ok(this.exportSettings());
        case MESSAGE.IMPORT_SETTINGS:
          return ok(await this.importSettings(payload.data));
        case MESSAGE.SET_MANUAL_SIMULATION:
          return ok(await this.setSimulation(payload.phase));
        case MESSAGE.CLEAR_MANUAL_SIMULATION:
          return ok(await this.setSimulation(null));
        default:
          return fail("UNKNOWN_MESSAGE", `Unknown message type: ${type}`);
      }
    } catch (error) {
      return fail(error.code ?? "INTERNAL_ERROR", error.message ?? "The operation failed.");
    }
  }

  async saveConnection(connection) {
    const effectiveToken = String(connection?.token ?? "").trim()
      || this.settings.connection.token;
    const validated = validateConnection({ token: effectiveToken });
    await this.requireOriginPermission(permissionPatternForEndpoint(validated.baseUrl));
    this.settings = mergeSettings({
      ...this.settings,
      onboardingComplete: true,
      connection: validated,
    });
    await saveSettings(this.settings);
    this.failureCount = 0;
    this.schedule(0);
    return this.publicState();
  }

  async savePreferences(payload) {
    const behavior = payload?.behavior ?? {};
    const requestedTheme = payload?.appearance?.theme;
    const theme = new Set(["system", "light", "dark"]).has(requestedTheme)
      ? requestedTheme
      : this.settings.appearance.theme;
    this.settings = mergeSettings({
      ...this.settings,
      behavior: {
        ...this.settings.behavior,
        blockWhilePaused: Boolean(behavior.blockWhilePaused),
        restoreTabsAfterFocus: behavior.restoreTabsAfterFocus !== false,
      },
      appearance: { ...this.settings.appearance, theme },
    });
    await saveSettings(this.settings);
    const previousBlocking = this.runtime.blockingActive;
    this.runtime.blockingActive = blockingDecision(this.runtime, this.settings);
    await this.commitRuntime(previousBlocking);
    return this.publicState();
  }

  async saveTimerDuration(value) {
    const durationMinutes = Number(value);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 0 || durationMinutes > MAX_TIMER_MINUTES) {
      throw Object.assign(new Error("Choose a focus time from 0 to 60 minutes."), {
        code: "INVALID_TIMER_DURATION",
      });
    }
    this.settings = mergeSettings({
      ...this.settings,
      timer: { ...this.settings.timer, durationMinutes },
    });
    await saveSettings(this.settings);
    return this.publicState();
  }

  async controlTimer(action, payload = {}) {
    if (this.settings.developer.simulation) {
      throw Object.assign(new Error("Switch the simulator back to Live BUSY device before controlling the timer."), {
        code: "SIMULATION_ACTIVE",
      });
    }
    if (this.timerCommandInFlight) return this.timerCommandInFlight;
    const task = this.performTimerCommand(action, payload);
    this.timerCommandInFlight = task;
    try {
      return await task;
    } finally {
      this.timerCommandInFlight = null;
    }
  }

  async performTimerCommand(action, payload) {
    if (this.pollInFlight) await this.pollInFlight;
    const connection = validateConnection({ token: this.settings.connection.token });
    await this.requireOriginPermission(permissionPatternForEndpoint(connection.baseUrl));
    const client = new BusyClient(connection, { timeoutMs: this.settings.polling.timeoutMs });
    const current = await client.getSnapshot();
    const command = buildTimerCommand(current.payload, action, {
      durationMinutes: payload.durationMinutes,
    });
    await client.setSnapshot(command);
    if (action === "cancel") {
      this.suppressedCompletionSessionId = current.payload?.snapshot?.card_id ?? this.runtime.sessionId;
    }
    await this.performPoll(connection, false);
    await this.log(`timer_${action}`, action === "start"
      ? { durationMinutes: payload.durationMinutes }
      : {});
    return this.publicState();
  }

  async addSite(payload) {
    if (this.sites.length >= MAX_SITES) {
      throw Object.assign(new Error(`Busy Farm supports up to ${MAX_SITES} site rules.`), { code: "SITE_LIMIT" });
    }
    const site = newSite(payload.hostname, payload.includeSubdomains !== false);
    await this.requireOriginPermission(site.permissionPattern);
    if (this.sites.some((entry) => entry.hostname === site.hostname)) {
      const error = new Error("This site is already in the list.");
      error.code = "DUPLICATE_SITE";
      throw error;
    }
    this.sites = [...this.sites, site];
    await saveSites(this.sites);
    await this.blockEngine.update(this.runtime.blockingActive, this.sites);
    return this.publicState();
  }

  async removeSite(id) {
    const removed = this.sites.find((site) => site.id === id);
    this.sites = this.sites.filter((site) => site.id !== id);
    await saveSites(this.sites);
    await this.blockEngine.update(this.runtime.blockingActive, this.sites);
    if (removed && !this.sites.some((site) => site.permissionPattern === removed.permissionPattern)) {
      await this.api.permissions.remove({ origins: [removed.permissionPattern] }).catch(() => false);
    }
    return this.publicState();
  }

  async toggleSite(id, enabled) {
    this.sites = this.sites.map((site) => site.id === id
      ? { ...site, enabled: Boolean(enabled), updatedAt: new Date().toISOString() }
      : site);
    await saveSites(this.sites);
    await this.blockEngine.update(this.runtime.blockingActive, this.sites);
    return this.publicState();
  }

  async updateSite(payload) {
    const current = this.sites.find((site) => site.id === payload.id);
    if (!current) throw Object.assign(new Error("Site entry was not found."), { code: "SITE_NOT_FOUND" });
    const normalized = normalizeSiteInput(payload.hostname ?? current.hostname, {
      includeSubdomains: payload.includeSubdomains ?? current.includeSubdomains,
    });
    await this.requireOriginPermission(normalized.permissionPattern);
    this.sites = this.sites.map((site) => site.id === payload.id
      ? { ...site, ...normalized, enabled: payload.enabled ?? site.enabled, updatedAt: new Date().toISOString() }
      : site);
    await saveSites(this.sites);
    await this.blockEngine.update(this.runtime.blockingActive, this.sites);
    return this.publicState();
  }

  async currentTab() {
    const [tab] = await this.api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return { supported: false, reason: "No website is active." };
    let parsed;
    try {
      parsed = new URL(tab.url);
    } catch {
      return { supported: false, reason: "This page cannot be added." };
    }
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
      return { supported: false, reason: "Firefox internal pages cannot be blocked." };
    }
    return {
      supported: true,
      tabId: tab.id,
      url: tab.url,
      hostname: parsed.hostname,
      matchingSite: findMatchingSite(tab.url, this.sites),
    };
  }

  exportSettings() {
    return {
      format: "busy-farm-settings",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        behavior: { ...this.settings.behavior },
        appearance: { ...this.settings.appearance },
        timer: { ...this.settings.timer },
      },
      sites: this.sites,
    };
  }

  async importSettings(data) {
    if (!data || !new Set(["busy-farm-settings", "busy-forest-settings"]).has(data.format) || !Array.isArray(data.sites)) {
      throw Object.assign(new Error("This is not a Busy Farm settings file."), { code: "INVALID_IMPORT" });
    }
    if (data.sites.length > MAX_SITES) {
      throw Object.assign(new Error(`The import contains more than ${MAX_SITES} site rules.`), { code: "SITE_LIMIT" });
    }
    const sites = data.sites.map((entry) => {
      const normalized = normalizeSiteInput(entry.hostname, { includeSubdomains: entry.includeSubdomains });
      return {
        ...newSite(normalized.hostname, normalized.includeSubdomains),
        enabled: entry.enabled !== false,
      };
    }).filter((entry, index, entries) =>
      entries.findIndex((candidate) => candidate.hostname === entry.hostname) === index);
    await Promise.all(sites.map((site) => this.requireOriginPermission(site.permissionPattern)));
    const importedBehavior = data.settings?.behavior ?? {};
    const importedTheme = data.settings?.appearance?.theme;
    const importedDuration = Number(data.settings?.timer?.durationMinutes);
    this.settings = mergeSettings({
      ...this.settings,
      behavior: {
        ...this.settings.behavior,
        blockWhilePaused: Boolean(importedBehavior.blockWhilePaused),
        restoreTabsAfterFocus: importedBehavior.restoreTabsAfterFocus !== false,
      },
      appearance: {
        ...this.settings.appearance,
        theme: new Set(["system", "light", "dark"]).has(importedTheme)
          ? importedTheme
          : this.settings.appearance.theme,
      },
      timer: {
        ...this.settings.timer,
        durationMinutes: Number.isInteger(importedDuration) && importedDuration >= 0 && importedDuration <= MAX_TIMER_MINUTES
          ? importedDuration : this.settings.timer.durationMinutes,
      },
      developer: { ...this.settings.developer, simulation: null },
    });
    this.sites = sites;
    await Promise.all([saveSettings(this.settings), saveSites(this.sites)]);
    await this.blockEngine.update(this.runtime.blockingActive, this.sites);
    return this.publicState();
  }

  async setSimulation(phase) {
    const allowed = new Set([null, "idle", "work", "paused", "break"]);
    if (!allowed.has(phase)) throw Object.assign(new Error("Invalid simulation phase."), { code: "INVALID_PHASE" });
    this.settings = mergeSettings({
      ...this.settings,
      developer: { ...this.settings.developer, simulation: phase },
    });
    await saveSettings(this.settings);
    this.schedule(0);
    return this.publicState();
  }

  async testConnection(connection) {
    const effectiveToken = String(connection?.token ?? "").trim()
      || this.settings.connection.token;
    const validated = validateConnection({ token: effectiveToken });
    await this.requireOriginPermission(permissionPatternForEndpoint(validated.baseUrl));
    return this.pollOnce({ connection: validated, testOnly: true });
  }

  async requireOriginPermission(origin) {
    const granted = await this.api.permissions.contains({ origins: [origin] });
    if (!granted) {
      throw Object.assign(new Error("Browser permission is required for this address."), {
        code: "PERMISSION_MISSING",
      });
    }
  }

  async log(event, details = {}) {
    this.diagnostics = [
      ...this.diagnostics,
      { at: new Date().toISOString(), event, ...details },
    ].slice(-100);
    await saveDiagnostics(this.diagnostics);
  }
}

function validateConnection(connection) {
  permissionPatternForEndpoint(CLOUD_BASE_URL);
  return validateTransportEndpoint("cloud", CLOUD_BASE_URL, connection?.token);
}

function simulatedPayload(phase) {
  const now = Date.now();
  if (phase === "idle") return { snapshot: { type: "NOT_STARTED" }, snapshot_timestamp_ms: now };
  if (phase === "break") {
    return {
      snapshot: {
        type: "INTERVAL",
        card_id: "simulated-session",
        current_interval: 1,
        current_interval_time_total_ms: 300000,
        current_interval_time_left_ms: 270000,
        is_paused: false,
        interval_settings: { interval_work_ms: 1500000, interval_rest_ms: 300000 },
      },
      snapshot_timestamp_ms: now,
    };
  }
  return {
    snapshot: {
      type: "SIMPLE",
      card_id: "simulated-session",
      time_left_ms: 25 * 60 * 1000,
      is_paused: phase === "paused",
    },
    snapshot_timestamp_ms: now,
  };
}
