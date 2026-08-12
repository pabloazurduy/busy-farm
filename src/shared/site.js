const HTTP_SCHEMES = new Set(["http:", "https:"]);

export function normalizeSiteInput(input, { includeSubdomains = true } = {}) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new SiteInputError("Enter a website or domain.", "EMPTY_SITE");

  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new SiteInputError("That does not look like a valid website.", "INVALID_SITE");
  }

  if (!HTTP_SCHEMES.has(parsed.protocol)) {
    throw new SiteInputError("Only http and https websites can be blocked.", "UNSUPPORTED_SCHEME");
  }
  if (parsed.username || parsed.password) {
    throw new SiteInputError("Remove the username or password from this address.", "CREDENTIALS_IN_URL");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253 || hostname.includes("..")) {
    throw new SiteInputError("That hostname is not valid.", "INVALID_HOSTNAME");
  }

  return {
    hostname,
    includeSubdomains: Boolean(includeSubdomains) && !isIpAddress(hostname),
    permissionPattern: permissionPatternForHost(hostname, includeSubdomains),
  };
}

export function permissionPatternForHost(hostname, includeSubdomains = true) {
  const host = String(hostname).toLowerCase();
  const wildcard = Boolean(includeSubdomains) && !isIpAddress(host);
  return `*://${wildcard ? "*." : ""}${host}/*`;
}

export function permissionPatternForEndpoint(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl).trim());
  } catch {
    throw new SiteInputError("Enter a complete BUSY API address.", "INVALID_ENDPOINT");
  }
  if (!HTTP_SCHEMES.has(parsed.protocol)) {
    throw new SiteInputError("The BUSY API address must use http or https.", "UNSUPPORTED_ENDPOINT");
  }
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export function matchesSite(urlOrHost, site) {
  let host = String(urlOrHost ?? "").toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return false;
    }
  }
  const rule = String(site.hostname ?? "").toLowerCase();
  if (!rule || site.enabled === false) return false;
  return host === rule || (site.includeSubdomains && host.endsWith(`.${rule}`));
}

export function findMatchingSite(url, sites) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!HTTP_SCHEMES.has(parsed.protocol)) return null;
  return sites.find((site) => matchesSite(parsed.hostname, site)) ?? null;
}

export function newSite(input, includeSubdomains = true) {
  const normalized = normalizeSiteInput(input, { includeSubdomains });
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `site-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    hostname: normalized.hostname,
    includeSubdomains: normalized.includeSubdomains,
    permissionPattern: normalized.permissionPattern,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function isIpAddress(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

export class SiteInputError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SiteInputError";
    this.code = code;
  }
}

