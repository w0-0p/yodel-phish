// =============================================================================
// CLICKFIX WARNING SESSIONS
//
// State before navigation (issue #29). A warning record is created already
// bound to the extension-owned tab that will display it, exactly as the
// phishing and device-code flows persist their verdict before navigating a
// known tab. There is no unbound record and no post-navigation binding step,
// so a concurrent navigation cleanup can never delete a record in the window
// between "this tab has no warning yet" and "this tab is the warning tab".
//
// The clipboard request originates in a web-page frame while the warning is
// shown in a separate tab, and MV3 may suspend the service worker between
// those two steps, so the minimum state needed to finish the decision lives in
// chrome.storage.session rather than an in-memory Map.
//
// Every operation is serialized through one FIFO queue. This makes creation,
// consumption, expiry pruning, navigation reconciliation, and tab cleanup
// atomic read-modify-write actions even when browser events arrive
// concurrently. Records are copied on ingress and returned as deeply frozen
// snapshots; callers never receive a reference to the mutable storage state.
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

// The address the warning tab is created at, before the record that authorizes
// its interstitial exists. Exported so the service worker opens the staging tab
// at exactly the address this store recognizes as expected staging navigation.
export const CLICKFIX_WARNING_STAGING_URL = "about:blank";

// "staging": created and bound to a verified about:blank document.
// "navigating": the source was revalidated and navigation was authorized.
// "active": the exact matching interstitial navigation committed.
export const CLICKFIX_WARNING_STATUSES = ["staging", "navigating", "active"];

const CLICKFIX_MODES = new Set(["strict", "warn"]);
const CLICKFIX_STATUSES = new Set(CLICKFIX_WARNING_STATUSES);
const MAX_ID_LENGTH = 128;

/**
 * Creates a durable warning-session store backed by a chrome.storage.session-
 * compatible object (`get(keys)` and `set(values)`).
 *
 * Returned API:
 *   canCreateWarning(sourceTabId)
 *   createBoundWarning(input)
 *   beginWarningTabNavigation(requestId, warningTabId)
 *   getWarning(requestId, warningTabId)
 *   consumeWarning(requestId, warningTabId)
 *   reconcileWarningTabNavigation({ warningTabId, requestId, url })
 *   abandonWarningTab(warningTabId)
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
  stagingUrl = CLICKFIX_WARNING_STAGING_URL,
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
  requireNonEmptyString(stagingUrl, "stagingUrl");

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
     * Read-only capacity probe. The authoritative decision is still made
     * atomically inside createBoundWarning; this only lets the caller avoid
     * opening a staging tab it would immediately have to close again.
     */
    async canCreateWarning(sourceTabId) {
      requireTabId(sourceTabId, "sourceTabId");
      return withState((state) => ({
        value: admissionRefusal(state, sourceTabId) === null,
        changed: false,
      }));
    },

    /**
     * Creates a warning already bound to the tab that will display it, and
     * returns its immutable snapshot — or null when an active-session cap or
     * the durable open-rate limit is hit. There is no unbound creation path:
     * every navigable record carries its warning tab from the moment it exists.
     */
    async createBoundWarning(input) {
      const fields = normalizeNewWarning(input);
      return withState((state) => {
        // A browser reuses tab ids. The warning tab is brand new, so any record
        // still claiming it belongs to a closed tab and is evicted here rather
        // than left to shadow the record being created.
        let changed = false;
        for (const [requestId, record] of Object.entries(state.warnings_by_id)) {
          if (record.warningTabId === fields.warningTabId) {
            delete state.warnings_by_id[requestId];
            changed = true;
          }
        }

        if (admissionRefusal(state, fields.sourceTabId) !== null) {
          return { value: null, changed };
        }

        const requestId = uniqueRequestId(state.warnings_by_id, cryptoApi);
        const createdAt = state.current_time;
        const sourceKey = String(fields.sourceTabId);
        const recentOpens = state.warning_open_timestamps_by_source_tab[sourceKey] ?? [];
        const stored = {
          requestId,
          ...fields,
          status: "staging",
          createdAt,
          expiresAt: createdAt + ttlMs,
        };
        state.warnings_by_id[requestId] = cloneRecord(stored);
        state.warning_open_timestamps_by_source_tab[sourceKey] = [...recentOpens, createdAt];
        return { value: immutableRecord(stored), changed: true };
      });
    },

    /**
     * Atomically authorizes the staged tab to leave its verified staging
     * document. Returning null means cleanup won the race, so the caller must
     * not navigate the tab. This closes the async source-liveness window.
     */
    async beginWarningTabNavigation(requestId, warningTabId) {
      requireRequestId(requestId);
      requireTabId(warningTabId, "warningTabId");
      return withState((state) => {
        const record = matchingWarning(state, requestId, warningTabId);
        if (record === null || record.status !== "staging") {
          return { value: null, changed: false };
        }
        const navigating = { ...record, status: "navigating" };
        state.warnings_by_id[requestId] = navigating;
        return { value: immutableRecord(navigating), changed: true };
      });
    },

    /** Returns a warning only to the exact warning tab to which it is bound. */
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

    /**
     * Reconciles either an advisory tabs.onUpdated URL or an authoritative
     * webNavigation.onCommitted document. Only a committed, matching
     * interstitial can activate a warning.
     *
     * Outcomes:
     *   "none"       no record is bound to this tab; nothing to do
     *   "staging"    the verified pre-navigation document; the record is kept
     *   "navigating" the authorized target URL was observed before commit
     *   "activated"  the exact matching interstitial committed
     *   "discarded"  an unauthorized or competing navigation removed the record
     */
    async reconcileWarningTabNavigation(navigation) {
      const { warningTabId, requestId, url, phase, documentId } =
        normalizeNavigation(navigation);
      return withState((state) => {
        const entry = warningEntryForTab(state, warningTabId);
        if (entry === null) return { value: { outcome: "none", warning: null }, changed: false };
        const [boundRequestId, record] = entry;

        if (requestId !== null) {
          if (requestId !== boundRequestId) {
            delete state.warnings_by_id[boundRequestId];
            return { value: { outcome: "discarded", warning: immutableRecord(record) }, changed: true };
          }
          if (phase === "updated") {
            if (record.status === "navigating") {
              return { value: { outcome: "navigating", warning: immutableRecord(record) }, changed: false };
            }
            if (record.status === "active") {
              return { value: { outcome: "activated", warning: immutableRecord(record) }, changed: false };
            }
            delete state.warnings_by_id[boundRequestId];
            return { value: { outcome: "discarded", warning: immutableRecord(record) }, changed: true };
          }
          if (record.status === "active") {
            return { value: { outcome: "activated", warning: immutableRecord(record) }, changed: false };
          }
          if (record.status !== "navigating") {
            delete state.warnings_by_id[boundRequestId];
            return { value: { outcome: "discarded", warning: immutableRecord(record) }, changed: true };
          }
          const active = { ...record, status: "active" };
          state.warnings_by_id[boundRequestId] = active;
          return { value: { outcome: "activated", warning: immutableRecord(active) }, changed: true };
        }

        // tabs.onUpdated has no document identity, so a late notification of
        // the original staging address is only advisory. A committed staging
        // address is safe solely when it is the exact document we bound before
        // persistence while setup is still in flight. Any committed return after
        // activation is a navigation away, even if history restores that original
        // document identity, and cannot retain the authorization.
        if (isStagingNavigation(url, stagingUrl)) {
          if (phase === "committed" &&
              (record.status === "active" || documentId !== record.stagingDocumentId)) {
            delete state.warnings_by_id[boundRequestId];
            return { value: { outcome: "discarded", warning: immutableRecord(record) }, changed: true };
          }
          return { value: { outcome: "staging", warning: immutableRecord(record) }, changed: false };
        }

        delete state.warnings_by_id[boundRequestId];
        return { value: { outcome: "discarded", warning: immutableRecord(record) }, changed: true };
      });
    },

    /**
     * Atomically removes and returns whatever record is bound to a warning tab,
     * so a caller that has to tear the tab down can also return focus to the
     * exact source tab the warning came from.
     */
    async abandonWarningTab(warningTabId) {
      requireTabId(warningTabId, "warningTabId");
      return withState((state) => {
        const entry = warningEntryForTab(state, warningTabId);
        if (entry === null) return { value: null, changed: false };
        const [requestId, record] = entry;
        delete state.warnings_by_id[requestId];
        return { value: immutableRecord(record), changed: true };
      });
    },

    /** Removes one warning by id, whatever state its tab is in. */
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
     * Removes stale warnings for one source frame after a *document
     * replacement*. When a current document id is supplied its records are
     * retained; omitting it removes every warning originating in the frame.
     *
     * Same-document navigation (History API, fragment changes) keeps the exact
     * document alive and must therefore pass that document's id, which retains
     * the immutable clipboard request bound to it (issue #29). SPAs such as
     * GitHub run late pushState()/replaceState() calls that would otherwise
     * invalidate a request the user is still deciding on.
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

// null when a new warning may be created for this source tab, otherwise the
// reason it may not. Shared by the probe and the authoritative create so the
// two can never drift apart.
function admissionRefusal(state, sourceTabId) {
  if (Object.keys(state.warnings_by_id).length >= CLICKFIX_WARNING_MAX_ACTIVE) {
    return "global_cap";
  }
  let activeForSourceTab = 0;
  for (const record of Object.values(state.warnings_by_id)) {
    if (record.sourceTabId === sourceTabId) activeForSourceTab += 1;
  }
  if (activeForSourceTab >= CLICKFIX_WARNING_MAX_ACTIVE_PER_SOURCE_TAB) {
    return "source_tab_cap";
  }
  const recentOpens = state.warning_open_timestamps_by_source_tab[String(sourceTabId)] ?? [];
  return recentOpens.length >= CLICKFIX_WARNING_OPEN_RATE_LIMIT ? "rate_limit" : null;
}

function isStagingNavigation(url, stagingUrl) {
  // An event that carries no address at all says nothing about where the tab
  // went, so it never destroys a record.
  return typeof url !== "string" || url === "" || url === stagingUrl;
}

function warningEntryForTab(state, warningTabId) {
  for (const entry of Object.entries(state.warnings_by_id)) {
    if (entry[1].warningTabId === warningTabId) return entry;
  }
  return null;
}

function normalizeNavigation(navigation) {
  if (!isPlainObject(navigation)) throw new TypeError("navigation must be an object");
  requireTabId(navigation.warningTabId, "warningTabId");
  const requestId = navigation.requestId ?? null;
  if (requestId !== null) requireRequestId(requestId);
  if (navigation.url !== undefined && navigation.url !== null && typeof navigation.url !== "string") {
    throw new TypeError("url must be a string when present");
  }
  const phase = navigation.phase ?? "updated";
  if (phase !== "updated" && phase !== "committed") {
    throw new TypeError("phase must be updated or committed");
  }
  const documentId = navigation.documentId ?? null;
  if (documentId !== null) requireNonEmptyString(documentId, "documentId");
  return { warningTabId: navigation.warningTabId, requestId, url: navigation.url, phase, documentId };
}

function normalizeNewWarning(input) {
  if (!isPlainObject(input)) throw new TypeError("warning input must be an object");
  requireTabId(input.warningTabId, "warningTabId");
  requireTabId(input.sourceTabId, "sourceTabId");
  if (input.warningTabId === input.sourceTabId) {
    throw new TypeError("warningTabId must not be the source tab");
  }
  requireFrameId(input.sourceFrameId);
  requireNonEmptyString(input.sourceDocumentId, "sourceDocumentId");
  requireNonEmptyString(input.stagingDocumentId, "stagingDocumentId");
  requireNonEmptyString(input.sourceUrl, "sourceUrl");
  if (!CLICKFIX_MODES.has(input.mode)) throw new TypeError("mode must be strict or warn");
  if (typeof input.text !== "string") throw new TypeError("text must be a string");

  return {
    warningTabId: input.warningTabId,
    sourceTabId: input.sourceTabId,
    sourceFrameId: input.sourceFrameId,
    sourceDocumentId: input.sourceDocumentId,
    stagingDocumentId: input.stagingDocumentId,
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
  const claimedWarningTabs = new Set();

  for (const [requestId, candidate] of Object.entries(source)) {
    const record = normalizeStoredRecord(requestId, candidate, ttlMs);
    if (record === null || record.expiresAt <= currentTime) {
      dirty = true;
      pruned += 1;
      continue;
    }
    // One warning tab displays exactly one warning. A second record claiming
    // the same tab can only be corruption, and keeping it would make
    // tab-scoped lookup ambiguous.
    if (claimedWarningTabs.has(record.warningTabId)) {
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
    claimedWarningTabs.add(record.warningTabId);
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
  if (!validNonEmptyString(value.stagingDocumentId)) return null;
  // Issue #29: a record with no warning tab is not a lifecycle this store can
  // produce any more. Anything claiming one is stale or corrupt state.
  if (!validTabId(value.warningTabId) || value.warningTabId === value.sourceTabId) return null;
  if (!CLICKFIX_STATUSES.has(value.status)) return null;
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
    stagingDocumentId: value.stagingDocumentId,
    sourceUrl: value.sourceUrl,
    warningTabId: value.warningTabId,
    status: value.status,
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
    stagingDocumentId: record.stagingDocumentId,
    sourceUrl: record.sourceUrl,
    warningTabId: record.warningTabId,
    status: record.status,
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
