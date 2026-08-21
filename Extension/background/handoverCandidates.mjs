// =============================================================================
// CROSS-DOMAIN LOGIN HANDOVER — issue #24.
//
// A legitimate sign-in may move from a trusted site to a different, previously
// unknown one (login.microsoftonline.com → login.live.com). The candidate this
// store tracks means only that the user recently initiated navigation from a
// trusted page and the resulting tab reached the recorded destination — never
// that the destination is trustworthy. Trust is still granted exclusively by
// the interactive Add to trusted flow.
//
// Identity for this feature is protocol + normalized FQDN, HTTPS only. Ports,
// paths, queries and fragments are intentionally ignored, and are never
// persisted: a stored record carries origins of the "https://host" form, so no
// authentication URL (with its state/nonce query values) can end up in
// chrome.storage.session.
//
// Two record kinds share one storage key and one FIFO queue, so candidate
// updates are serialized:
//   - an activation: browser-generated user activity on an exact trusted top
//     document, valid for a five-second window;
//   - a candidate: the navigation attributed to a consumed activation, keyed
//     by target tab, alive for two minutes from the activation. Expired
//     candidates are retained (invisible to every getter) until takeExpired()
//     collects them, so the chrome.alarms owner can notify the destination
//     document that its prompt lapsed.
//
// No chrome.* dependency — `storageArea` is injected so this can be unit
// tested under plain Node, the same pattern deviceFlowSessions.mjs uses.
// =============================================================================

import { createStorageDomain, normalizeFqdn } from "./storageQueues.mjs";

export const HANDOVER_STATE_KEY = "handover_candidates";
export const HANDOVER_ACTIVATION_TTL_MS = 5_000;
export const HANDOVER_CANDIDATE_TTL_MS = 120_000;
export const MAX_HANDOVER_ACTIVATIONS = 50;
export const MAX_HANDOVER_CANDIDATES = 50;

// The feature's identity: protocol + normalized FQDN, HTTPS only. Everything
// else about the URL is dropped here, before anything can store it.
export function handoverIdentity(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const hostname = normalizeFqdn(parsed.hostname);
  if (hostname === null) return null;
  return `https://${hostname}`;
}

export function identityHostname(identity) {
  return typeof identity === "string" && identity.startsWith("https://")
    ? identity.slice("https://".length)
    : "";
}

// How a committed top-level navigation relates to a handover candidate.
// "direct" (address bar, bookmarks, typed) and "preserve" (back/forward,
// reload) both invalidate; "client_redirect" may re-bind an existing
// candidate's destination; "page" is ordinary document-driven navigation and
// may bind a prepared candidate. Unknown future transition types classify as
// "page", which can only ever bind a candidate real user activity prepared.
const DIRECT_TRANSITION_TYPES = new Set([
  "typed",
  "auto_bookmark",
  "generated",
  "start_page",
  "keyword",
  "keyword_generated",
]);

export function classifyHandoverCommit(details) {
  const qualifiers = Array.isArray(details?.transitionQualifiers)
    ? details.transitionQualifiers
    : [];
  if (qualifiers.includes("from_address_bar") || DIRECT_TRANSITION_TYPES.has(details?.transitionType)) {
    return "direct";
  }
  if (qualifiers.includes("forward_back") || details?.transitionType === "reload") {
    return "preserve";
  }
  if (qualifiers.includes("client_redirect")) return "client_redirect";
  return "page";
}

/**
 * Creates the durable handover store backed by a chrome.storage.session-
 * compatible object (`get(keys)` and `set(values)`), so an MV3 worker
 * suspension between user activity and the destination's login detection
 * cannot lose the candidate.
 */
export function createHandoverCandidateStore(storageArea, {
  activationTtlMs = HANDOVER_ACTIVATION_TTL_MS,
  candidateTtlMs = HANDOVER_CANDIDATE_TTL_MS,
  now = () => Date.now(),
  newCandidateId = () => crypto.randomUUID(),
  queue,
} = {}) {
  requireStorageArea(storageArea);
  if (!Number.isFinite(activationTtlMs) || activationTtlMs <= 0) throw new TypeError("activationTtlMs must be positive");
  if (!Number.isFinite(candidateTtlMs) || candidateTtlMs <= 0) throw new TypeError("candidateTtlMs must be positive");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const withState = createStorageDomain({
    storageArea,
    keys: [HANDOVER_STATE_KEY],
    load(data) {
      const currentTime = now();
      if (!Number.isFinite(currentTime)) throw new TypeError("now() must return a finite number");
      return normalizeState(data?.[HANDOVER_STATE_KEY], currentTime, activationTtlMs, candidateTtlMs);
    },
    persist: (state) => ({ [HANDOVER_STATE_KEY]: cloneStateForStorage(state) }),
    ...(queue === undefined ? {} : { queue }),
  });

  function liveCandidate(state, targetTabId) {
    const record = state.candidates_by_target_tab[String(targetTabId)];
    if (record === undefined || record.expiresAt <= state.current_time) return null;
    return record;
  }

  return {
    /** Arms the five-second activation window for one exact top document. */
    async recordActivation({ tabId, documentId, sourceOrigin, createdAt = now() }) {
      requireTabId(tabId, "tabId");
      requireString(documentId, "documentId");
      requireIdentity(sourceOrigin, "sourceOrigin");
      if (!Number.isFinite(createdAt)) throw new TypeError("createdAt must be a finite number");
      return withState((state) => {
        // createdAt is captured by the service worker at message receipt,
        // before authoritative-frame and trust lookups. A delayed handler may
        // never shift or revive the five-second attribution window.
        if (createdAt > state.current_time || createdAt + activationTtlMs <= state.current_time) {
          return { value: null, changed: false };
        }
        const activations = state.activations_by_tab;
        if (activations[String(tabId)] === undefined &&
            Object.keys(activations).length >= MAX_HANDOVER_ACTIVATIONS) {
          delete activations[oldestKey(activations, "createdAt")];
        }
        const record = {
          tabId,
          documentId,
          sourceOrigin,
          createdAt,
          expiresAt: createdAt + activationTtlMs,
        };
        activations[String(tabId)] = record;
        return { value: Object.freeze({ ...record }), changed: true };
      });
    },

    /**
     * Consumes the tab's activation for a beginning navigation. Matching is
     * exact: the same document and the same source identity, inside the
     * window. A mismatch consumes nothing and returns null — the record can
     * never match again once its document is gone, and it expires on its own.
     */
    async consumeActivation(tabId, { documentId, sourceOrigin }) {
      requireTabId(tabId, "tabId");
      return withState((state) => {
        const key = String(tabId);
        const record = state.activations_by_tab[key];
        if (record === undefined || record.expiresAt <= state.current_time) return { value: null, changed: false };
        if (record.documentId !== documentId || record.sourceOrigin !== sourceOrigin) {
          return { value: null, changed: false };
        }
        delete state.activations_by_tab[key];
        return { value: Object.freeze({ ...record }), changed: true };
      });
    },

    async discardActivation(tabId) {
      requireTabId(tabId, "tabId");
      return withState((state) => {
        const key = String(tabId);
        if (state.activations_by_tab[key] === undefined) return { value: false, changed: false };
        delete state.activations_by_tab[key];
        return { value: true, changed: true };
      });
    },

    /**
     * Creates the candidate a consumed activation prepared, keyed by target
     * tab and replacing whatever candidate that tab held: the newest
     * attributed navigation is the only one that may prompt. The lifetime is
     * anchored to the activation, so nothing later can extend it.
     */
    async createCandidate({ sourceTabId, targetTabId, sourceDocumentId, sourceOrigin, activationAt }) {
      requireTabId(sourceTabId, "sourceTabId");
      requireTabId(targetTabId, "targetTabId");
      requireString(sourceDocumentId, "sourceDocumentId");
      requireIdentity(sourceOrigin, "sourceOrigin");
      if (!Number.isFinite(activationAt)) throw new TypeError("activationAt must be a finite number");
      return withState((state) => {
        const candidates = state.candidates_by_target_tab;
        const key = String(targetTabId);
        if (candidates[key] === undefined && Object.keys(candidates).length >= MAX_HANDOVER_CANDIDATES) {
          delete candidates[oldestKey(candidates, "activationAt")];
        }
        const record = {
          candidateId: newCandidateId(),
          sourceTabId,
          targetTabId,
          sourceDocumentId,
          sourceOrigin,
          destinationDocumentId: null,
          destinationOrigin: null,
          activationAt,
          expiresAt: activationAt + candidateTtlMs,
        };
        candidates[key] = record;
        return { value: Object.freeze({ ...record }), changed: true };
      });
    },

    /**
     * Binds (or, for a client redirect, re-binds) the committed destination
     * document. The destination must be a live HTTPS identity different from
     * the source; anything else removes the candidate fail-closed.
     */
    async bindDestination(targetTabId, { documentId, destinationOrigin }) {
      requireTabId(targetTabId, "targetTabId");
      return withState((state) => {
        const key = String(targetTabId);
        const record = liveCandidate(state, targetTabId);
        if (record === null) return { value: null, changed: false };
        if (typeof documentId !== "string" || documentId === "" ||
            !isIdentity(destinationOrigin) || destinationOrigin === record.sourceOrigin) {
          delete state.candidates_by_target_tab[key];
          return { value: null, changed: true };
        }
        const updated = { ...record, destinationDocumentId: documentId, destinationOrigin };
        state.candidates_by_target_tab[key] = updated;
        return { value: Object.freeze({ ...updated }), changed: true };
      });
    },

    /** The tab's candidate, expired ones excluded. */
    async getCandidate(targetTabId) {
      requireTabId(targetTabId, "targetTabId");
      return withState((state) => {
        const record = liveCandidate(state, targetTabId);
        return { value: record === null ? null : Object.freeze({ ...record }), changed: false };
      });
    },

    /** The candidate bound to one exact destination document, or null. */
    async getCandidateForDocument(targetTabId, documentId) {
      requireTabId(targetTabId, "targetTabId");
      return withState((state) => {
        const record = liveCandidate(state, targetTabId);
        if (record === null || typeof documentId !== "string" || documentId === "" ||
            record.destinationDocumentId !== documentId) {
          return { value: null, changed: false };
        }
        return { value: Object.freeze({ ...record }), changed: false };
      });
    },

    /**
     * Atomically consumes the candidate for a user decision. The action must
     * name the current candidate id and come from the bound destination
     * document; a stale id or a different document consumes nothing, so an
     * old prompt's click can never spend a newer candidate.
     */
    async consumeCandidateForAction(targetTabId, { candidateId, documentId }) {
      requireTabId(targetTabId, "targetTabId");
      return withState((state) => {
        const key = String(targetTabId);
        const record = state.candidates_by_target_tab[key];
        if (record === undefined ||
            typeof candidateId !== "string" || record.candidateId !== candidateId ||
            typeof documentId !== "string" || record.destinationDocumentId !== documentId) {
          return { value: null, changed: false };
        }
        delete state.candidates_by_target_tab[key];
        if (record.expiresAt <= state.current_time) return { value: null, changed: true };
        return { value: Object.freeze({ ...record }), changed: true };
      });
    },

    async discardCandidate(targetTabId) {
      requireTabId(targetTabId, "targetTabId");
      return withState((state) => {
        const key = String(targetTabId);
        if (state.candidates_by_target_tab[key] === undefined) return { value: false, changed: false };
        delete state.candidates_by_target_tab[key];
        return { value: true, changed: true };
      });
    },

    /** Atomically removes and returns the tab's candidate for invalidation. */
    async takeCandidate(targetTabId) {
      requireTabId(targetTabId, "targetTabId");
      return withState((state) => {
        const key = String(targetTabId);
        const record = state.candidates_by_target_tab[key];
        if (record === undefined) return { value: null, changed: false };
        delete state.candidates_by_target_tab[key];
        return { value: Object.freeze({ ...record }), changed: true };
      });
    },

    /** Removes a candidate whose binding navigation failed before committing. */
    async discardCandidateIfUnbound(targetTabId) {
      requireTabId(targetTabId, "targetTabId");
      return withState((state) => {
        const key = String(targetTabId);
        const record = state.candidates_by_target_tab[key];
        if (record === undefined || record.destinationDocumentId !== null) return { value: false, changed: false };
        delete state.candidates_by_target_tab[key];
        return { value: true, changed: true };
      });
    },

    /** Tab closure: drops the tab's candidate and its pending activation. */
    async discardTab(tabId) {
      requireTabId(tabId, "tabId");
      return withState((state) => {
        let changed = false;
        for (const map of [state.activations_by_tab, state.candidates_by_target_tab]) {
          if (map[String(tabId)] !== undefined) {
            delete map[String(tabId)];
            changed = true;
          }
        }
        return { value: changed, changed };
      });
    },

    /** Earliest candidate expiry for the chrome.alarms owner, or null. */
    async nextExpiry() {
      return withState((state) => {
        let earliest = null;
        for (const record of Object.values(state.candidates_by_target_tab)) {
          if (earliest === null || record.expiresAt < earliest) earliest = record.expiresAt;
        }
        return { value: earliest, changed: false };
      });
    },

    /** Removes and returns every expired candidate, for expiry notification. */
    async takeExpired() {
      return withState((state) => {
        const expired = [];
        for (const [key, record] of Object.entries(state.candidates_by_target_tab)) {
          if (record.expiresAt <= state.current_time) {
            expired.push(Object.freeze({ ...record }));
            delete state.candidates_by_target_tab[key];
          }
        }
        return { value: expired, changed: expired.length > 0 };
      });
    },
  };
}

// Malformed stored state normalizes fail-closed: an unreadable record is a
// dropped record, never a trusted-looking one. Expired activations are dropped
// here too (nothing waits on them); expired candidates are retained for
// takeExpired() so the alarm can notify the prompt they backed.
function normalizeState(value, currentTime, activationTtlMs, candidateTtlMs) {
  const plain = isPlainObject(value) ? value : {};
  let dirty = !isPlainObject(value);

  const activations = Object.create(null);
  const activationSource = isPlainObject(plain.activations_by_tab) ? plain.activations_by_tab : {};
  if (!isPlainObject(plain.activations_by_tab) && plain.activations_by_tab !== undefined) dirty = true;
  for (const [key, candidate] of Object.entries(activationSource)) {
    const record = normalizeActivation(key, candidate, activationTtlMs);
    if (record === null || record.expiresAt <= currentTime ||
        Object.keys(activations).length >= MAX_HANDOVER_ACTIVATIONS) {
      dirty = true;
      continue;
    }
    activations[key] = record;
  }

  const candidates = Object.create(null);
  const candidateSource = isPlainObject(plain.candidates_by_target_tab) ? plain.candidates_by_target_tab : {};
  if (!isPlainObject(plain.candidates_by_target_tab) && plain.candidates_by_target_tab !== undefined) dirty = true;
  for (const [key, candidate] of Object.entries(candidateSource)) {
    const record = normalizeCandidate(key, candidate, candidateTtlMs);
    if (record === null || Object.keys(candidates).length >= MAX_HANDOVER_CANDIDATES) {
      dirty = true;
      continue;
    }
    candidates[key] = record;
  }

  return {
    state: {
      activations_by_tab: activations,
      candidates_by_target_tab: candidates,
      current_time: currentTime,
    },
    dirty,
  };
}

function normalizeActivation(key, value, ttlMs) {
  if (!isPlainObject(value) || String(value.tabId) !== key) return null;
  if (!validTabId(value.tabId)) return null;
  if (!validNonEmptyString(value.documentId)) return null;
  if (!isIdentity(value.sourceOrigin)) return null;
  if (!validLifetime(value, ttlMs)) return null;
  return {
    tabId: value.tabId,
    documentId: value.documentId,
    sourceOrigin: value.sourceOrigin,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function normalizeCandidate(key, value, ttlMs) {
  if (!isPlainObject(value) || String(value.targetTabId) !== key) return null;
  if (!validNonEmptyString(value.candidateId)) return null;
  if (!validTabId(value.sourceTabId) || !validTabId(value.targetTabId)) return null;
  if (!validNonEmptyString(value.sourceDocumentId)) return null;
  if (!isIdentity(value.sourceOrigin)) return null;
  const bound = value.destinationDocumentId !== null || value.destinationOrigin !== null;
  if (bound && (!validNonEmptyString(value.destinationDocumentId) ||
      !isIdentity(value.destinationOrigin) ||
      value.destinationOrigin === value.sourceOrigin)) {
    return null;
  }
  if (!Number.isFinite(value.activationAt) || !Number.isFinite(value.expiresAt)) return null;
  if (value.expiresAt <= value.activationAt || value.expiresAt - value.activationAt > ttlMs) return null;
  return {
    candidateId: value.candidateId,
    sourceTabId: value.sourceTabId,
    targetTabId: value.targetTabId,
    sourceDocumentId: value.sourceDocumentId,
    sourceOrigin: value.sourceOrigin,
    destinationDocumentId: bound ? value.destinationDocumentId : null,
    destinationOrigin: bound ? value.destinationOrigin : null,
    activationAt: value.activationAt,
    expiresAt: value.expiresAt,
  };
}

function validLifetime(value, ttlMs) {
  return Number.isFinite(value.createdAt) && Number.isFinite(value.expiresAt) &&
    value.expiresAt > value.createdAt && value.expiresAt - value.createdAt <= ttlMs;
}

function cloneStateForStorage(state) {
  const activations = {};
  for (const [key, record] of Object.entries(state.activations_by_tab)) activations[key] = { ...record };
  const candidates = {};
  for (const [key, record] of Object.entries(state.candidates_by_target_tab)) candidates[key] = { ...record };
  return { activations_by_tab: activations, candidates_by_target_tab: candidates };
}

function oldestKey(records, field) {
  let oldest = null;
  let oldestValue = Infinity;
  for (const [key, record] of Object.entries(records)) {
    if (record[field] < oldestValue || oldest === null) {
      oldest = key;
      oldestValue = record[field];
    }
  }
  return oldest;
}

function isIdentity(value) {
  return typeof value === "string" && value.startsWith("https://") &&
    value.length > "https://".length && handoverIdentity(value) === value;
}

function requireStorageArea(storageArea) {
  if (storageArea === null || typeof storageArea !== "object" ||
      typeof storageArea.get !== "function" || typeof storageArea.set !== "function") {
    throw new TypeError("A chrome.storage.session-compatible storage area is required");
  }
}

function requireTabId(value, name) {
  if (!validTabId(value)) throw new TypeError(`${name} must be a non-negative integer`);
}

function validTabId(value) {
  return Number.isInteger(value) && value >= 0;
}

function requireString(value, name) {
  if (!validNonEmptyString(value)) throw new TypeError(`${name} must be a non-empty string`);
}

function requireIdentity(value, name) {
  if (!isIdentity(value)) throw new TypeError(`${name} must be an https scheme+host identity`);
}

function validNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
