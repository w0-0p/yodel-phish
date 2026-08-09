// =============================================================================
// DEVICE-CODE PHISHING REGISTRY — issue #39.
//
// OAuth device-code flows (Microsoft, GitHub, Google, Facebook, Docker, ...)
// use authentic identity-provider pages, but an attacker can start the flow
// on their own device and trick a victim into entering the attacker's code on
// the real provider page. This module holds no chrome.* dependency and no
// side effects: it is pure URL matching, so both the service worker and its
// tests can exercise it directly.
//
// Matching is deliberately exact: parsed hostname equality (not a suffix/
// subdomain check like ClickFix's domain exclusions -- a device-login entry
// point is one specific host, not a whole registrable domain) and parsed path
// equality allowing only one optional trailing slash. Query string and
// fragment are never inspected for matching, so ordering, extra parameters,
// and a prepopulated user_code cannot affect whether a URL matches.
// =============================================================================

import { parse } from "tldts";

export const MAX_DEVICE_FLOW_ENTRIES = 100; // cap on stored user-added endpoints
export const MAX_DEVICE_FLOW_HOSTNAME_LENGTH = 253;
export const MAX_DEVICE_FLOW_PATH_LENGTH = 200;

// Built-in endpoints ship as code and are read-only in Advanced Settings.
// User-added endpoints ({ id, hostname, path }, no provider label) are stored
// in settings and matched exactly the same way (service_worker.js).
// Trusted initiators are an explicit security policy. In particular, endpoint
// membership and a shared provider display label never grant initiator trust.
const MS_ENTRA_TRUSTED_INITIATORS = Object.freeze(["microsoft.com", "microsoftonline.com"]);
const MS_CONSUMER_TRUSTED_INITIATORS = Object.freeze(["microsoft.com", "live.com"]);
const GITHUB_TRUSTED_INITIATORS = Object.freeze(["github.com"]);
const GOOGLE_TRUSTED_INITIATORS = Object.freeze(["google.com"]);
const FACEBOOK_TRUSTED_INITIATORS = Object.freeze(["facebook.com"]);
const DOCKER_TRUSTED_INITIATORS = Object.freeze(["docker.com"]);

export const DEFAULT_DEVICE_FLOW_REGISTRY = Object.freeze([
  { id: "seed-ms-entra-1", provider: "Microsoft Entra", hostname: "login.microsoftonline.com", path: "/common/oauth2/deviceauth", trustedInitiatorDomains: MS_ENTRA_TRUSTED_INITIATORS },
  { id: "seed-ms-entra-2", provider: "Microsoft Entra", hostname: "microsoft.com", path: "/devicelogin", trustedInitiatorDomains: MS_ENTRA_TRUSTED_INITIATORS },
  { id: "seed-ms-entra-3", provider: "Microsoft Entra", hostname: "aka.ms", path: "/devicelogin", trustedInitiatorDomains: MS_ENTRA_TRUSTED_INITIATORS },
  { id: "seed-ms-consumer-1", provider: "Microsoft consumer/Xbox/Minecraft", hostname: "microsoft.com", path: "/link", trustedInitiatorDomains: MS_CONSUMER_TRUSTED_INITIATORS },
  { id: "seed-ms-consumer-2", provider: "Microsoft consumer/Xbox/Minecraft", hostname: "aka.ms", path: "/remoteconnect", trustedInitiatorDomains: MS_CONSUMER_TRUSTED_INITIATORS },
  { id: "seed-ms-consumer-3", provider: "Microsoft consumer/Xbox/Minecraft", hostname: "login.live.com", path: "/oauth20_remoteconnect.srf", trustedInitiatorDomains: MS_CONSUMER_TRUSTED_INITIATORS },
  { id: "seed-github-1", provider: "GitHub", hostname: "github.com", path: "/login/device", trustedInitiatorDomains: GITHUB_TRUSTED_INITIATORS },
  { id: "seed-google-1", provider: "Google", hostname: "www.google.com", path: "/device", trustedInitiatorDomains: GOOGLE_TRUSTED_INITIATORS },
  { id: "seed-google-2", provider: "Google", hostname: "accounts.google.com", path: "/o/oauth2/device/usercode", trustedInitiatorDomains: GOOGLE_TRUSTED_INITIATORS },
  { id: "seed-facebook-1", provider: "Facebook", hostname: "facebook.com", path: "/device", trustedInitiatorDomains: FACEBOOK_TRUSTED_INITIATORS },
  { id: "seed-docker-1", provider: "Docker", hostname: "login.docker.com", path: "/activate", trustedInitiatorDomains: DOCKER_TRUSTED_INITIATORS },
].map(Object.freeze));

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function canonicalizeHostname(hostname) {
  return String(hostname ?? "").toLowerCase().replace(/\.$/, "");
}

// Only ONE optional trailing slash is stripped -- "/a//" still differs from "/a/".
export function canonicalizePath(pathname) {
  const path = String(pathname ?? "");
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export function isValidDeviceFlowHostname(value) {
  if (typeof value !== "string") return false;
  const hostname = canonicalizeHostname(value.trim());
  return hostname.length > 0 && hostname.length <= MAX_DEVICE_FLOW_HOSTNAME_LENGTH && HOSTNAME_RE.test(hostname);
}

export function isValidDeviceFlowPath(value) {
  return typeof value === "string" && value.length > 1 && value.length <= MAX_DEVICE_FLOW_PATH_LENGTH &&
    value.startsWith("/") && !value.includes("?") && !value.includes("#") && !/\s/.test(value);
}

// Canonical storage form for one exact endpoint. Keeping this normalization
// beside the parser makes settings repair and new user input obey the same
// rules instead of merely validating a canonical copy and retaining raw data.
export function normalizeDeviceFlowEndpointParts(hostnameValue, pathValue) {
  if (typeof hostnameValue !== "string" || typeof pathValue !== "string") return null;
  const hostname = canonicalizeHostname(hostnameValue.trim());
  const path = canonicalizePath(pathValue);
  if (!isValidDeviceFlowHostname(hostname) || !isValidDeviceFlowPath(path)) return null;
  return { hostname, path };
}

// Parses one user-entered endpoint string ("login.example.com/device" or a
// full https URL). The scheme defaults to https; query and fragment are
// dropped; hostname and path are canonicalized. Returns { hostname, path }
// or null when the input is not an https endpoint with both parts.
export function parseDeviceFlowEndpointInput(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_DEVICE_FLOW_HOSTNAME_LENGTH + MAX_DEVICE_FLOW_PATH_LENGTH + 8) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return normalizeDeviceFlowEndpointParts(parsed.hostname, parsed.pathname);
}

// Returns the matching registry entry, or null. Only https is recognized --
// a real device-code page is never served over plain http.
export function matchDeviceFlowEndpoint(url, registry) {
  if (!Array.isArray(registry) || registry.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const hostname = canonicalizeHostname(parsed.hostname);
  const path = canonicalizePath(parsed.pathname);
  return registry.find((entry) =>
    canonicalizeHostname(entry.hostname) === hostname && canonicalizePath(entry.path) === path
  ) ?? null;
}

// Built-ins trust only their audited read-only allowlist. User endpoints have
// no provider label and trust only their own registrable domain by default.
// Comparing parsed registrable domains avoids unsafe string-suffix matching.
export function isTrustedDeviceFlowInitiator(sourceOrigin, match) {
  if (match === null || typeof match !== "object") return false;

  let sourceUrl;
  try {
    sourceUrl = new URL(sourceOrigin);
  } catch {
    return false;
  }
  if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") return false;

  const sourceDomain = registrableDomain(sourceUrl.hostname);
  if (sourceDomain === null) return false;

  if (match.provider !== undefined) {
    return Array.isArray(match.trustedInitiatorDomains) &&
      match.trustedInitiatorDomains.includes(sourceDomain);
  }

  const endpointDomain = registrableDomain(match.hostname);
  return endpointDomain !== null && sourceDomain === endpointDomain;
}

function registrableDomain(hostname) {
  const canonical = canonicalizeHostname(hostname);
  if (!isValidDeviceFlowHostname(canonical)) return null;
  return parse(canonical, { allowPrivateDomains: true }).domain ?? canonical;
}
