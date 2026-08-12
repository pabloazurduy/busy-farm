import { permissionPatternForHost } from "../shared/site.js";

export const DEFAULT_SITE_SET_VERSION = 1;

export const DEFAULT_SITE_HOSTS = Object.freeze([
  "instagram.com",
  "facebook.com",
  "youtube.com",
  "linkedin.com",
  "news.ycombinator.com",
  "reddit.com",
  "amazon.nl",
  "amazon.com",
  "bol.com",
]);

export function mergeDefaultSites(sites, now = new Date().toISOString()) {
  const merged = Array.isArray(sites) ? sites.map((site) => ({ ...site })) : [];

  for (const hostname of DEFAULT_SITE_HOSTS) {
    const existing = merged.find((site) => site.hostname === hostname);
    if (existing) {
      existing.includeSubdomains = true;
      existing.permissionPattern = permissionPatternForHost(hostname, true);
      continue;
    }
    merged.push({
      id: `default-${hostname.replaceAll(".", "-")}`,
      hostname,
      includeSubdomains: true,
      permissionPattern: permissionPatternForHost(hostname, true),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  return merged;
}
