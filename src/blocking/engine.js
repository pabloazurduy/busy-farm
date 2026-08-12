import { extensionApi, isFirefoxBuild, runtimeUrl } from "../shared/platform.js";
import { findMatchingSite } from "../shared/site.js";

const CHROMIUM_RULE_START = 51000;

export class BlockEngine {
  constructor() {
    this.api = extensionApi();
    this.active = false;
    this.sites = [];
    this.originalUrls = new Map();
    this.listenerRegistered = false;
    this.onBeforeRequest = this.onBeforeRequest.bind(this);
  }

  async initialize(active, sites) {
    this.active = Boolean(active);
    this.sites = enabledSites(sites);
    if (isFirefoxBuild()) this.registerFirefoxListener();
    else await this.syncChromiumRules();
  }

  async update(active, sites, { enforceTabs = true, restoreTabs = true } = {}) {
    const wasActive = this.active;
    const previousSignature = siteSignature(this.sites);
    this.active = Boolean(active);
    this.sites = enabledSites(sites);
    const sitesChanged = previousSignature !== siteSignature(this.sites);

    if (!isFirefoxBuild() && (wasActive !== this.active || sitesChanged)) {
      await this.syncChromiumRules();
    }

    if (this.active && sitesChanged) await this.restoreNoLongerBlockedTabs();
    if (this.active && enforceTabs) await this.enforceExistingTabs();
    if (wasActive && !this.active) {
      if (restoreTabs) await this.restoreTabs();
      else this.originalUrls.clear();
    }
  }

  registerFirefoxListener() {
    if (this.listenerRegistered) return;
    this.api.webRequest.onBeforeRequest.addListener(
      this.onBeforeRequest,
      { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
      ["blocking"],
    );
    this.listenerRegistered = true;
  }

  onBeforeRequest(details) {
    if (!this.active) return {};
    const site = findMatchingSite(details.url, this.sites);
    if (!site) return {};
    if (details.tabId >= 0) this.originalUrls.set(details.tabId, details.url);
    return { redirectUrl: this.blockedUrl(site.hostname) };
  }

  blockedUrl(hostname = "") {
    const url = new URL(runtimeUrl("pages/blocked/index.html"));
    if (hostname) url.searchParams.set("host", hostname);
    return url.toString();
  }

  async enforceExistingTabs() {
    const tabs = await this.api.tabs.query({});
    const updates = [];
    for (const tab of tabs) {
      if (tab.id == null || !tab.url || tab.url.startsWith(runtimeUrl(""))) continue;
      const site = findMatchingSite(tab.url, this.sites);
      if (!site) continue;
      this.originalUrls.set(tab.id, tab.url);
      updates.push(this.api.tabs.update(tab.id, { url: this.blockedUrl(site.hostname) }).catch(() => null));
    }
    await Promise.all(updates);
  }

  async restoreTabs() {
    const blockedPrefix = runtimeUrl("pages/blocked/index.html");
    const tabs = await this.api.tabs.query({});
    const restores = [];
    for (const tab of tabs) {
      if (tab.id == null || !tab.url?.startsWith(blockedPrefix)) continue;
      const original = this.originalUrls.get(tab.id);
      if (original) {
        restores.push(this.api.tabs.update(tab.id, { url: original }).catch(() => null));
      }
    }
    await Promise.all(restores);
    this.originalUrls.clear();
  }

  async restoreNoLongerBlockedTabs() {
    const restores = [];
    for (const [tabId, original] of this.originalUrls) {
      if (findMatchingSite(original, this.sites)) continue;
      this.originalUrls.delete(tabId);
      restores.push(this.api.tabs.update(tabId, { url: original }).catch(() => null));
    }
    await Promise.all(restores);
  }

  async restoreTab(tabId) {
    if (tabId == null) return false;
    const original = this.originalUrls.get(tabId);
    if (original && !this.active) {
      this.originalUrls.delete(tabId);
      await this.api.tabs.update(tabId, { url: original });
      return true;
    }
    if (!this.active && this.api.tabs.goBack) {
      try {
        await this.api.tabs.goBack(tabId);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  async syncChromiumRules() {
    const dnr = this.api.declarativeNetRequest;
    if (!dnr) return;
    const existing = await dnr.getDynamicRules();
    const removeRuleIds = existing
      .filter((rule) => rule.id >= CHROMIUM_RULE_START && rule.id < CHROMIUM_RULE_START + 10000)
      .map((rule) => rule.id);
    const addRules = this.active ? this.sites.map(toChromiumRule) : [];
    await dnr.updateDynamicRules({ removeRuleIds, addRules });
  }
}

function enabledSites(sites) {
  return (Array.isArray(sites) ? sites : []).filter((site) => site.enabled !== false);
}

function siteSignature(sites) {
  return sites
    .map((site) => `${site.hostname}:${site.includeSubdomains ? "wildcard" : "exact"}`)
    .sort()
    .join("|");
}

function toChromiumRule(site, index) {
  const escaped = site.hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const condition = site.includeSubdomains
    ? { urlFilter: `||${site.hostname}^`, resourceTypes: ["main_frame"] }
    : { regexFilter: `^https?://${escaped}(:[0-9]+)?(/|$)`, resourceTypes: ["main_frame"] };
  return {
    id: CHROMIUM_RULE_START + index,
    priority: 1,
    action: { type: "redirect", redirect: { extensionPath: "/pages/blocked/index.html" } },
    condition,
  };
}
