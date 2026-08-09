// =============================================================================
// DEVICE-CODE FLOW PROVENANCE — issue #39.
//
// chrome.webNavigation.onCreatedNavigationTarget fires when a page opens a new
// tab or window; the relationship between that source tab and the new target
// tab is recorded immediately, before any analysis of either page finishes.
// An MV3 service worker can be suspended and restarted between that moment
// and the target tab's own navigation to a recognized device-login endpoint,
// so the minimum state needed to reconnect them lives in chrome.storage.session
// rather than an in-memory Map.
//
// One relationship exists per target tab (a tab is opened by exactly one
// source), so records are keyed by target tab id rather than a generated
// request id. Every operation is serialized through one FIFO queue (see
// storageQueues.mjs) and normalizes + prunes expired records on every read.
// =============================================================================

import { createStorageDomain } from "./storageQueues.mjs";

export const DEVICE_FLOW_STATE_KEY = "device_flow_relationships";
export const DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
export const DEVICE_FLOW_MAX_ACTIVE = 200;
export const DEVICE_FLOW_MAX_ACTIVE_PER_SOURCE_TAB = 10;

/**
 * Creates a durable provenance store backed by a chrome.storage.session-
 * compatible object (`get(keys)` and `set(values)`).
 *
 * Returned API:
 *   createRelationship(input)
 *   getRelationship(targetTabId)
 *   recordSourceOrigin(targetTabId, sourceOrigin)
 *   recordMatch(targetTabId, { provider, returnPath })
 *   discardRelationship(targetTabId)
 *   discardTab(tabId)
 *   nextExpiry()
 *   pruneExpired()
 */
export function createDeviceFlowStore(storageArea, { ttlMs = DEVICE_FLOW_TTL_MS, now = () => Date.now(), queue } = {}) {
  requireStorageArea(storageArea);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("Device-flow TTL must be a positive finite number");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const withState = createStorageDomain({
    storageArea,
    keys: [DEVICE_FLOW_STATE_KEY],
    load(data) {
      const currentTime = currentTimeFrom(now);
      return normalizeState(data?.[DEVICE_FLOW_STATE_KEY], currentTime, ttlMs);
    },
    persist: (state) => ({ [DEVICE_FLOW_STATE_KEY]: cloneStateForStorage(state) }),
    ...(queue === undefined ? {} : { queue }),
  });

  return {
    /** Creates a relationship, evicting the oldest relevant record at capacity. */
    async createRelationship(input) {
      const fields = normalizeNewRelationship(input);
      return withState((state) => {
        const key = String(fields.targetTabId);
        const existing = state.relationships_by_target_tab[key];
        if (existing !== undefined) return { value: immutableRecord(existing), changed: false };

        const records = state.relationships_by_target_tab;
        const activeForSourceTab = Object.values(records)
          .filter((record) => record.sourceTabId === fields.sourceTabId);
        if (activeForSourceTab.length >= DEVICE_FLOW_MAX_ACTIVE_PER_SOURCE_TAB) {
          delete records[oldestRelationshipKey(records, (record) => record.sourceTabId === fields.sourceTabId)];
        }
        if (Object.keys(records).length >= DEVICE_FLOW_MAX_ACTIVE) {
          delete records[oldestRelationshipKey(records)];
        }

        const createdAt = state.current_time;
        const record = {
          ...fields,
          provider: null,
          returnPath: null,
          createdAt,
          expiresAt: createdAt + ttlMs,
        };
        records[key] = record;
        return { value: immutableRecord(record), changed: true };
      });
    },

    async getRelationship(targetTabId) {
      requireTabId(targetTabId, "targetTabId");
      return withState((state) => {
        const record = state.relationships_by_target_tab[String(targetTabId)] ?? null;
        return { value: record === null ? null : immutableRecord(record), changed: false };
      });
    },

    /** Replaces the temporary generic origin once Chrome exposes the source tab. */
    async recordSourceOrigin(targetTabId, sourceOrigin) {
      requireTabId(targetTabId, "targetTabId");
      if (!validNonEmptyString(sourceOrigin)) throw new TypeError("sourceOrigin must be a non-empty string");
      return withState((state) => {
        const key = String(targetTabId);
        const record = state.relationships_by_target_tab[key];
        if (record === undefined) return { value: null, changed: false };
        if (record.sourceOrigin === sourceOrigin) return { value: immutableRecord(record), changed: false };
        const updated = { ...record, sourceOrigin };
        state.relationships_by_target_tab[key] = updated;
        return { value: immutableRecord(updated), changed: true };
      });
    },

    /** Records the matched provider and the URL to return to on acknowledgment. */
    async recordMatch(targetTabId, { provider, returnPath }) {
      requireTabId(targetTabId, "targetTabId");
      if (!validNonEmptyString(provider)) throw new TypeError("provider must be a non-empty string");
      if (!validReturnPath(returnPath)) throw new TypeError("returnPath must be { hostname, path }");
      return withState((state) => {
        const key = String(targetTabId);
        const record = state.relationships_by_target_tab[key];
        if (record === undefined) return { value: null, changed: false };
        const updated = { ...record, provider, returnPath: { ...returnPath } };
        state.relationships_by_target_tab[key] = updated;
        return { value: immutableRecord(updated), changed: true };
      });
    },

    /** Explicit removal -- navigation outside the flow, or an explicit leave. */
    async discardRelationship(targetTabId) {
      requireTabId(targetTabId, "targetTabId");
      return withState((state) => {
        const key = String(targetTabId);
        if (state.relationships_by_target_tab[key] === undefined) return { value: false, changed: false };
        delete state.relationships_by_target_tab[key];
        return { value: true, changed: true };
      });
    },

    /** Removes the relationship owned by a closed target tab. */
    async discardTab(tabId) {
      requireTabId(tabId, "tabId");
      return withState((state) => {
        let removed = 0;
        for (const [key, record] of Object.entries(state.relationships_by_target_tab)) {
          if (record.targetTabId === tabId) {
            delete state.relationships_by_target_tab[key];
            removed += 1;
          }
        }
        return { value: removed, changed: removed > 0 };
      });
    },

    /** Returns the earliest active expiry, or null when none remain. */
    async nextExpiry() {
      return withState((state) => {
        let earliest = null;
        for (const record of Object.values(state.relationships_by_target_tab)) {
          if (earliest === null || record.expiresAt < earliest) earliest = record.expiresAt;
        }
        return { value: earliest, changed: false };
      });
    },

    /** Explicitly prunes expired records; all other methods prune on read too. */
    async pruneExpired() {
      return withState((state) => ({ value: state.pruned_on_load, changed: false }));
    },
  };
}

function normalizeNewRelationship(input) {
  if (!isPlainObject(input)) throw new TypeError("relationship input must be an object");
  requireTabId(input.sourceTabId, "sourceTabId");
  requireTabId(input.targetTabId, "targetTabId");
  const sourceFrameId = input.sourceFrameId ?? 0;
  requireTabId(sourceFrameId, "sourceFrameId");
  if (!validNonEmptyString(input.sourceOrigin)) throw new TypeError("sourceOrigin must be a non-empty string");
  return {
    sourceTabId: input.sourceTabId,
    sourceFrameId,
    targetTabId: input.targetTabId,
    sourceOrigin: input.sourceOrigin,
  };
}

function normalizeState(value, currentTime, ttlMs) {
  const source = isPlainObject(value) && isPlainObject(value.relationships_by_target_tab)
    ? value.relationships_by_target_tab
    : {};
  const relationshipsByTargetTab = Object.create(null);
  let dirty = !isPlainObject(value) || !isPlainObject(value.relationships_by_target_tab);
  let pruned = 0;
  const retainedPerSourceTab = new Map();

  for (const [key, candidate] of Object.entries(source)) {
    const record = normalizeStoredRecord(key, candidate, ttlMs);
    if (record === null || record.expiresAt <= currentTime) {
      dirty = true;
      pruned += 1;
      continue;
    }
    if (candidate.sourceFrameId === undefined) dirty = true;
    const retainedForTab = retainedPerSourceTab.get(record.sourceTabId) ?? 0;
    if (Object.keys(relationshipsByTargetTab).length >= DEVICE_FLOW_MAX_ACTIVE ||
        retainedForTab >= DEVICE_FLOW_MAX_ACTIVE_PER_SOURCE_TAB) {
      dirty = true;
      pruned += 1;
      continue;
    }
    relationshipsByTargetTab[key] = record;
    retainedPerSourceTab.set(record.sourceTabId, retainedForTab + 1);
  }

  return {
    state: {
      relationships_by_target_tab: relationshipsByTargetTab,
      pruned_on_load: pruned,
      current_time: currentTime,
    },
    dirty,
  };
}

function normalizeStoredRecord(key, value, ttlMs) {
  if (!isPlainObject(value) || String(value.targetTabId) !== key) return null;
  if (!validTabId(value.sourceTabId) || !validTabId(value.targetTabId)) return null;
  const sourceFrameId = value.sourceFrameId ?? 0;
  if (!validTabId(sourceFrameId)) return null;
  if (!validNonEmptyString(value.sourceOrigin)) return null;
  if (value.provider !== null && !validNonEmptyString(value.provider)) return null;
  if (value.returnPath !== null && !validReturnPath(value.returnPath)) return null;
  if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt)) return null;
  if (value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > ttlMs) return null;

  return {
    sourceTabId: value.sourceTabId,
    sourceFrameId,
    targetTabId: value.targetTabId,
    sourceOrigin: value.sourceOrigin,
    provider: value.provider,
    // A record stored before issue #93 carries an `acknowledged` bypass flag;
    // it is deliberately not copied, so it can never downgrade a block again.
    returnPath: value.returnPath === null ? null : { ...value.returnPath },
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function validReturnPath(value) {
  return isPlainObject(value) && validNonEmptyString(value.hostname) && validNonEmptyString(value.path);
}
function oldestRelationshipKey(records, predicate = () => true) {
  let oldestKey = null;
  let oldestCreatedAt = Infinity;
  for (const [key, record] of Object.entries(records)) {
    if (!predicate(record)) continue;
    if (record.createdAt < oldestCreatedAt || (record.createdAt === oldestCreatedAt && oldestKey === null)) {
      oldestKey = key;
      oldestCreatedAt = record.createdAt;
    }
  }
  if (oldestKey === null) throw new Error("No relationship is available for eviction");
  return oldestKey;
}


function cloneStateForStorage(state) {
  const relationshipsByTargetTab = {};
  for (const [key, record] of Object.entries(state.relationships_by_target_tab)) {
    relationshipsByTargetTab[key] = { ...record, returnPath: record.returnPath === null ? null : { ...record.returnPath } };
  }
  return { relationships_by_target_tab: relationshipsByTargetTab };
}

function immutableRecord(record) {
  return Object.freeze({ ...record, returnPath: record.returnPath === null ? null : Object.freeze({ ...record.returnPath }) });
}

function currentTimeFrom(now) {
  const currentTime = now();
  if (!Number.isFinite(currentTime)) throw new TypeError("now() must return a finite number");
  return currentTime;
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

function validNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
