import { createStorageDomain } from "./storageQueues.mjs";

export const DEVICE_FLOW_SAME_TAB_SOURCE_KEY = "device_flow_same_tab_sources";
export const DEVICE_FLOW_SAME_TAB_SOURCE_TTL_MS = 60 * 1000;
const MAX_PENDING_SOURCES = 200;

// Persists the short onBeforeNavigate -> onCommitted handoff. Capturing the
// source independently of the initial target preserves attribution through a
// server redirect whose final committed URL is a Device Code endpoint. The
// in-memory promise used by service_worker.js only preserves event ordering;
// this store is the source of truth when MV3 suspends between those events.
export function createDeviceFlowSameTabSourceStore(
  storageArea,
  { ttlMs = DEVICE_FLOW_SAME_TAB_SOURCE_TTL_MS, now = () => Date.now() } = {}
) {
  if (storageArea === null || typeof storageArea !== "object" ||
      typeof storageArea.get !== "function" || typeof storageArea.set !== "function") {
    throw new TypeError("A chrome.storage.session-compatible storage area is required");
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be positive");

  const withState = createStorageDomain({
    storageArea,
    keys: [DEVICE_FLOW_SAME_TAB_SOURCE_KEY],
    load(data) {
      const currentTime = now();
      if (!Number.isFinite(currentTime)) throw new TypeError("now() must return a finite number");
      const source = plainObject(data?.[DEVICE_FLOW_SAME_TAB_SOURCE_KEY])
        ? data[DEVICE_FLOW_SAME_TAB_SOURCE_KEY]
        : {};
      const state = {};
      let dirty = !plainObject(data?.[DEVICE_FLOW_SAME_TAB_SOURCE_KEY]);
      for (const [key, value] of Object.entries(source)) {
        if (!validRecord(key, value, currentTime, ttlMs)) {
          dirty = true;
          continue;
        }
        state[key] = {
          tabId: value.tabId,
          sourceOrigin: value.sourceOrigin,
          createdAt: value.createdAt,
          expiresAt: value.expiresAt,
        };
        if (Object.hasOwn(value, "endpointKey")) dirty = true;
      }
      return { state, dirty };
    },
    persist: (state) => ({ [DEVICE_FLOW_SAME_TAB_SOURCE_KEY]: state }),
  });

  return {
    async record({ tabId, sourceOrigin }) {
      requireTabId(tabId);
      requireString(sourceOrigin, "sourceOrigin");
      return withState((state) => {
        if (state[String(tabId)] === undefined && Object.keys(state).length >= MAX_PENDING_SOURCES) {
          delete state[oldestKey(state)];
        }
        const createdAt = now();
        const record = { tabId, sourceOrigin, createdAt, expiresAt: createdAt + ttlMs };
        state[String(tabId)] = record;
        return { value: Object.freeze({ ...record }), changed: true };
      });
    },

    // Every commit consumes the one pending navigation for this tab, so stale
    // attribution can never attach to a later visit.
    async consume(tabId) {
      requireTabId(tabId);
      return withState((state) => {
        const key = String(tabId);
        const record = state[key];
        if (record === undefined) return { value: null, changed: false };
        delete state[key];
        return { value: Object.freeze({ ...record }), changed: true };
      });
    },

    async discardTab(tabId) {
      requireTabId(tabId);
      return withState((state) => {
        const key = String(tabId);
        if (state[key] === undefined) return { value: false, changed: false };
        delete state[key];
        return { value: true, changed: true };
      });
    },
  };
}

function validRecord(key, value, currentTime, ttlMs) {
  return plainObject(value) &&
    String(value.tabId) === key &&
    Number.isInteger(value.tabId) && value.tabId >= 0 &&
    typeof value.sourceOrigin === "string" && value.sourceOrigin.length > 0 &&
    Number.isFinite(value.createdAt) && Number.isFinite(value.expiresAt) &&
    value.expiresAt > currentTime &&
    value.expiresAt > value.createdAt &&
    value.expiresAt - value.createdAt <= ttlMs;
}

function oldestKey(state) {
  return Object.entries(state).reduce(
    (oldest, entry) => oldest === null || entry[1].createdAt < oldest[1].createdAt ? entry : oldest,
    null
  )[0];
}

function requireTabId(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError("tabId must be a non-negative integer");
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
