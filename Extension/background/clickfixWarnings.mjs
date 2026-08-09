// =============================================================================
// CLICKFIX WARNING SESSIONS
//
// A warning is opened in an extension-owned tab, while the clipboard request
// originates in a web-page frame. MV3 may suspend the service worker between
// those two steps, so the minimum state needed to finish the decision lives in
// chrome.storage.session rather than an in-memory Map.
//
// Every operation is serialized through one FIFO queue. This makes binding,
// consuming, expiry pruning, and tab cleanup atomic read-modify-write actions
// even when browser events arrive concurrently. Records are copied on ingress
// and returned as deeply frozen snapshots; callers never receive a reference
// to the mutable storage state.
//
// Active records are capped globally and per source tab. Successful opens are
// also recorded in a short, persisted per-source sliding window, so restarting
// an MV3 worker cannot reset the warning-open rate limit. Every operation
// normalizes both collections, pruning expired records and stale timestamps.
// =============================================================================

import { createStorageDomain } from "./storageQueues.mjs";

export const CLICKFIX_WARNING_STATE_KEY = "clickfix_warning_sessions";
export const CLICKFIX_WARNING_TTL_MS = 5 * 60 * 1000;
export const CLICKFIX_WARNING_MAX_ACTIVE = 32;
export const CLICKFIX_WARNING_MAX_ACTIVE_PER_SOURCE_TAB = 3;
export const CLICKFIX_WARNING_OPEN_RATE_LIMIT = 3;
export const CLICKFIX_WARNING_OPEN_RATE_WINDOW_MS = 10 * 1000;

const CLICKFIX_MODES = new Set(["strict", "warn"]);
const MAX_ID_LENGTH = 128;

/**
 * Creates a durable warning-session store backed by a chrome.storage.session-
 * compatible object (`get(keys)` and `set(values)`).
 *
 * Returned API:
 *   createWarning(input)
 *   bindWarningTab(requestId, warningTabId)
 *   getWarning(requestId, warningTabId)
 *   consumeWarning(requestId, warningTabId)
 *   discardWarning(requestId)
 *   discardTab(tabId)
 *   discardSourceDocument(sourceTabId, sourceFrameId, currentDocumentId?)
 *   discardWarningTab(warningTabId)
 *   nextExpiry()
 *   pruneExpired()
 */
export function createClickfixWarningStore(storageArea, {
  ttlMs = CLICKFIX_WARNING_TTL_MS,
  now = () => Date.now(),
  cryptoApi = globalThis.crypto,
  queue,
} = {}) {
  requireStorageArea(storageArea);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError("ClickFix warning TTL must be a positive finite number");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (cryptoApi === null || typeof cryptoApi !== "object" || typeof cryptoApi.randomUUID !== "function") {
    throw new TypeError("cryptoApi.randomUUID is required");
  }

  const withState = createStorageDomain({
    storageArea,
    keys: [CLICKFIX_WARNING_STATE_KEY],
    load(data) {
      const currentTime = currentTimeFrom(now);
      return normalizeState(data?.[CLICKFIX_WARNING_STATE_KEY], currentTime, ttlMs);
    },
    persist: (state) => ({
      [CLICKFIX_WARNING_STATE_KEY]: cloneStateForStorage(state),
    }),
    ...(queue === undefined ? {} : { queue }),
  });

  return {
    /**
     * Creates an unbound warning record and returns its immutable snapshot, or
     * null when an active-session cap or the durable open-rate limit is hit.
     */
    async createWarning(input) {
      const fields = normalizeNewWarning(input);
      return withState((state) => {
        if (Object.keys(state.warnings_by_id).length >= CLICKFIX_WARNING_MAX_ACTIVE) {
          return { value: null, changed: false };
        }

        let activeForSourceTab = 0;
        for (const record of Object.values(state.warnings_by_id)) {
          if (record.sourceTabId === fields.sourceTabId) activeForSourceTab += 1;
        }
        if (activeForSourceTab >= CLICKFIX_WARNING_MAX_ACTIVE_PER_SOURCE_TAB) {
          return { value: null, changed: false };
        }

        const sourceKey = String(fields.sourceTabId);
        const recentOpens = state.warning_open_timestamps_by_source_tab[sourceKey] ?? [];
        if (recentOpens.length >= CLICKFIX_WARNING_OPEN_RATE_LIMIT) {
          return { value: null, changed: false };
        }

        const requestId = uniqueRequestId(state.warnings_by_id, cryptoApi);
        const createdAt = state.current_time;
        const stored = {
          requestId,
          ...fields,
          warningTabId: null,
          createdAt,
          expiresAt: createdAt + ttlMs,
        };
        state.warnings_by_id[requestId] = cloneRecord(stored);
        state.warning_open_timestamps_by_source_tab[sourceKey] = [...recentOpens, createdAt];
        return { value: immutableRecord(stored), changed: true };
      });
    },

    /**
     * Binds the extension warning tab exactly once. Repeating the same binding
     * is idempotent; attempting to move a session to another tab is rejected.
     */
    async bindWarningTab(requestId, warningTabId) {
      requireRequestId(requestId);
      requireTabId(warningTabId, "warningTabId");
      return withState((state) => {
        const record = state.warnings_by_id[requestId] ?? null;
        if (record === null) return { value: null, changed: false };
        if (record.warningTabId !== null && record.warningTabId !== warningTabId) {
          return { value: null, changed: false };
        }
        if (record.warningTabId === warningTabId) {
          return { value: immutableRecord(record), changed: false };
        }
        const bound = { ...record, warningTabId };
        state.warnings_by_id[requestId] = bound;
        return { value: immutableRecord(bound), changed: true };
      });
    },

    /** Returns a warning only to the exact warning tab to which it was bound. */
    async getWarning(requestId, warningTabId) {
      requireRequestId(requestId);
      requireTabId(warningTabId, "warningTabId");
      return withState((state) => {
        const record = matchingWarning(state, requestId, warningTabId);
        return {
          value: record === null ? null : immutableRecord(record),
          changed: false,
        };
      });
    },

    /**
     * Atomically returns and removes a warning for its bound warning tab.
     * A request from any other tab neither sees nor consumes the record.
     */
    async consumeWarning(requestId, warningTabId) {
      requireRequestId(requestId);
      requireTabId(warningTabId, "warningTabId");
      return withState((state) => {
        const record = matchingWarning(state, requestId, warningTabId);
        if (record === null) return { value: null, changed: false };
        delete state.warnings_by_id[requestId];
        return { value: immutableRecord(record), changed: true };
      });
    },

    /** Removes a warning regardless of whether its UI tab was bound yet. */
    async discardWarning(requestId) {
      requireRequestId(requestId);
      return withState((state) => {
        if (state.warnings_by_id[requestId] === undefined) {
          return { value: false, changed: false };
        }
        delete state.warnings_by_id[requestId];
        return { value: true, changed: true };
      });
    },

    /** Removes every warning in which the closed tab is source or warning UI. */
    async discardTab(tabId) {
      requireTabId(tabId, "tabId");
      return withState((state) => {
        let removed = 0;
        for (const [requestId, record] of Object.entries(state.warnings_by_id)) {
          if (record.sourceTabId === tabId || record.warningTabId === tabId) {
            delete state.warnings_by_id[requestId];
            removed += 1;
          }
        }
        return { value: removed, changed: removed > 0 };
      });
    },

    /**
     * Removes stale warnings for one source frame after navigation. When a
     * current document id is supplied its records are retained; omitting it
     * removes every warning originating in the frame.
     */
    async discardSourceDocument(sourceTabId, sourceFrameId, currentDocumentId) {
      requireTabId(sourceTabId, "sourceTabId");
      requireFrameId(sourceFrameId);
      if (currentDocumentId !== undefined) {
        requireNonEmptyString(currentDocumentId, "currentDocumentId");
      }
      return withState((state) => {
        let removed = 0;
        for (const [requestId, record] of Object.entries(state.warnings_by_id)) {
          const matchesFrame = record.sourceTabId === sourceTabId &&
            record.sourceFrameId === sourceFrameId;
          const isReplacedDocument = currentDocumentId === undefined ||
            record.sourceDocumentId !== currentDocumentId;
          if (matchesFrame && isReplacedDocument) {
            delete state.warnings_by_id[requestId];
            removed += 1;
          }
        }
        return { value: removed, changed: removed > 0 };
      });
    },

    /** Removes warnings whose extension-owned UI tab was closed or replaced. */
    async discardWarningTab(warningTabId) {
      requireTabId(warningTabId, "warningTabId");
      return withState((state) => {
        let removed = 0;
        for (const [requestId, record] of Object.entries(state.warnings_by_id)) {
          if (record.warningTabId === warningTabId) {
            delete state.warnings_by_id[requestId];
            removed += 1;
          }
        }
        return { value: removed, changed: removed > 0 };
      });
    },

    /** Returns the earliest active warning expiry, or null when none remain. */
    async nextExpiry() {
      return withState((state) => {
        let earliest = null;
        for (const record of Object.values(state.warnings_by_id)) {
          if (earliest === null || record.expiresAt < earliest) earliest = record.expiresAt;
        }
        return { value: earliest, changed: false };
      });
    },

    /** Explicitly prunes expired records; all other methods prune on read too. */
    async pruneExpired() {
      return withState((state) => ({
        value: state.pruned_on_load,
        changed: false,
      }));
    },
  };
}

function normalizeNewWarning(input) {
  if (!isPlainObject(input)) throw new TypeError("warning input must be an object");
  requireTabId(input.sourceTabId, "sourceTabId");
  requireFrameId(input.sourceFrameId);
  requireNonEmptyString(input.sourceDocumentId, "sourceDocumentId");
  requireNonEmptyString(input.sourceUrl, "sourceUrl");
  if (!CLICKFIX_MODES.has(input.mode)) throw new TypeError("mode must be strict or warn");
  if (typeof input.text !== "string") throw new TypeError("text must be a string");

  return {
    sourceTabId: input.sourceTabId,
    sourceFrameId: input.sourceFrameId,
    sourceDocumentId: input.sourceDocumentId,
    sourceUrl: input.sourceUrl,
    mode: input.mode,
    decision: clonePlainValue(input.decision),
    text: input.text,
  };
}

function normalizeState(value, currentTime, ttlMs) {
  const source = isPlainObject(value) && isPlainObject(value.warnings_by_id)
    ? value.warnings_by_id
    : {};
  const warningsById = Object.create(null);
  const rateSource = isPlainObject(value) &&
    isPlainObject(value.warning_open_timestamps_by_source_tab)
    ? value.warning_open_timestamps_by_source_tab
    : {};
  const warningOpenTimestampsBySourceTab = Object.create(null);
  let dirty = !isPlainObject(value) || !isPlainObject(value.warnings_by_id) ||
    !isPlainObject(value.warning_open_timestamps_by_source_tab);
  let pruned = 0;
  const retainedPerSourceTab = new Map();

  for (const [requestId, candidate] of Object.entries(source)) {
    const record = normalizeStoredRecord(requestId, candidate, ttlMs);
    if (record === null || record.expiresAt <= currentTime) {
      dirty = true;
      pruned += 1;
      continue;
    }
    const retainedForTab = retainedPerSourceTab.get(record.sourceTabId) ?? 0;
    if (Object.keys(warningsById).length >= CLICKFIX_WARNING_MAX_ACTIVE ||
        retainedForTab >= CLICKFIX_WARNING_MAX_ACTIVE_PER_SOURCE_TAB) {
      dirty = true;
      pruned += 1;
      continue;
    }
    warningsById[requestId] = record;
    retainedPerSourceTab.set(record.sourceTabId, retainedForTab + 1);
  }

  for (const [sourceKey, candidate] of Object.entries(rateSource)) {
    const timestamps = normalizeRateTimestamps(sourceKey, candidate, currentTime);
    if (timestamps === null) {
      dirty = true;
      continue;
    }
    warningOpenTimestampsBySourceTab[sourceKey] = timestamps.values;
    if (timestamps.dirty) dirty = true;
  }

  return {
    state: {
      warnings_by_id: warningsById,
      warning_open_timestamps_by_source_tab: warningOpenTimestampsBySourceTab,
      pruned_on_load: pruned,
      current_time: currentTime,
    },
    dirty,
  };
}

function normalizeRateTimestamps(sourceKey, value, currentTime) {
  const sourceTabId = Number(sourceKey);
  if (!validTabId(sourceTabId) || String(sourceTabId) !== sourceKey || !Array.isArray(value)) {
    return null;
  }

  const cutoff = currentTime - CLICKFIX_WARNING_OPEN_RATE_WINDOW_MS;
  const retained = value
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > cutoff && timestamp <= currentTime)
    .sort((left, right) => left - right);
  if (retained.length === 0) return null;
  const bounded = retained.slice(-CLICKFIX_WARNING_OPEN_RATE_LIMIT);
  return {
    values: bounded,
    dirty: bounded.length !== value.length ||
      bounded.some((timestamp, index) => timestamp !== value[index]),
  };
}

function normalizeStoredRecord(requestId, value, ttlMs) {
  if (!validRequestId(requestId) || !isPlainObject(value) || value.requestId !== requestId) return null;
  if (!validTabId(value.sourceTabId) || !validFrameId(value.sourceFrameId)) return null;
  if (!validNonEmptyString(value.sourceDocumentId) || !validNonEmptyString(value.sourceUrl)) return null;
  if (value.warningTabId !== null && !validTabId(value.warningTabId)) return null;
  if (!CLICKFIX_MODES.has(value.mode) || typeof value.text !== "string") return null;
  if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt)) return null;
  if (value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > ttlMs) return null;

  let decision;
  try {
    decision = clonePlainValue(value.decision);
  } catch {
    return null;
  }
  return {
    requestId,
    sourceTabId: value.sourceTabId,
    sourceFrameId: value.sourceFrameId,
    sourceDocumentId: value.sourceDocumentId,
    sourceUrl: value.sourceUrl,
    warningTabId: value.warningTabId,
    mode: value.mode,
    decision,
    text: value.text,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function matchingWarning(state, requestId, warningTabId) {
  const record = state.warnings_by_id[requestId] ?? null;
  return record !== null && record.warningTabId === warningTabId ? record : null;
}

function uniqueRequestId(warningsById, cryptoApi) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const requestId = cryptoApi.randomUUID();
    if (!validRequestId(requestId)) throw new TypeError("cryptoApi.randomUUID returned an invalid id");
    if (!Object.hasOwn(warningsById, requestId)) return requestId;
  }
  throw new Error("Could not allocate a unique ClickFix warning request id");
}

function cloneStateForStorage(state) {
  const warningsById = {};
  for (const [requestId, record] of Object.entries(state.warnings_by_id)) {
    Object.defineProperty(warningsById, requestId, {
      value: cloneRecord(record),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const warningOpenTimestampsBySourceTab = {};
  for (const [sourceKey, timestamps] of
    Object.entries(state.warning_open_timestamps_by_source_tab)) {
    warningOpenTimestampsBySourceTab[sourceKey] = [...timestamps];
  }
  return {
    warnings_by_id: warningsById,
    warning_open_timestamps_by_source_tab: warningOpenTimestampsBySourceTab,
  };
}

function cloneRecord(record) {
  return {
    requestId: record.requestId,
    sourceTabId: record.sourceTabId,
    sourceFrameId: record.sourceFrameId,
    sourceDocumentId: record.sourceDocumentId,
    sourceUrl: record.sourceUrl,
    warningTabId: record.warningTabId,
    mode: record.mode,
    decision: clonePlainValue(record.decision),
    text: record.text,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function immutableRecord(record) {
  return deepFreeze(cloneRecord(record));
}

function clonePlainValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new TypeError("decision must be storage-safe data");
  if (seen.has(value)) throw new TypeError("decision must not be cyclic");
  seen.add(value);
  let clone;
  if (Array.isArray(value)) {
    clone = value.map((item) => clonePlainValue(item, seen));
  } else {
    if (!isPlainObject(value)) throw new TypeError("decision must contain only plain objects and arrays");
    clone = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(clone, key, {
        value: clonePlainValue(item, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  seen.delete(value);
  return clone;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((item) => deepFreeze(item, seen));
  return Object.freeze(value);
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

function requireRequestId(value) {
  if (!validRequestId(value)) throw new TypeError("requestId is invalid");
}

function validRequestId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function requireTabId(value, name) {
  if (!validTabId(value)) throw new TypeError(`${name} must be a non-negative integer`);
}

function validTabId(value) {
  return Number.isInteger(value) && value >= 0;
}

function requireFrameId(value) {
  if (!validFrameId(value)) throw new TypeError("sourceFrameId must be a non-negative integer");
}

function validFrameId(value) {
  return Number.isInteger(value) && value >= 0;
}

function requireNonEmptyString(value, name) {
  if (!validNonEmptyString(value)) throw new TypeError(`${name} must be a non-empty string`);
}

function validNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
