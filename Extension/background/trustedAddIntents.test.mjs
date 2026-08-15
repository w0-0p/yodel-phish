import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTrustedAddIntentStore,
  emptyTrustedAddIntents,
  normalizeTrustedAddIntents,
  TRUSTED_ADD_INTENTS_KEY,
} from "./trustedAddIntents.mjs";

// A stand-in for chrome.storage.session: get()/set() round trip through
// structuredClone, so a caller can never hold a live reference into the backing
// store across an await, exactly like the real API.
function createFakeStorageArea(initial = {}) {
  let backing = structuredClone(initial);
  return {
    async get(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of keyList) result[key] = backing[key];
      return structuredClone(result);
    },
    async set(patch) {
      backing = { ...backing, ...structuredClone(patch) };
    },
    dump() {
      return structuredClone(backing);
    },
  };
}

const intent = Object.freeze({ fqdn: "bank.example", settingsTabId: 3 });

test("an intent recorded before a worker restart is still there afterwards", async () => {
  const storageArea = createFakeStorageArea();
  const store = createTrustedAddIntentStore(storageArea);
  await store.set(7, intent);

  // A fresh store over the same storage area is what a restarted service worker
  // gets: no in-memory state, only what was persisted.
  const restarted = createTrustedAddIntentStore(storageArea);

  assert.deepEqual(await restarted.get(7), intent);
});

test("get() reports the intent without consuming, so reloads and redirects still resolve it", async () => {
  const store = createTrustedAddIntentStore(createFakeStorageArea());
  await store.set(7, intent);

  assert.deepEqual(await store.get(7), intent);
  assert.deepEqual(await store.get(7), intent, "a read must not clear the intent");
});

test("get() is null for a tab that never had an intent", async () => {
  const store = createTrustedAddIntentStore(createFakeStorageArea());

  assert.equal(await store.get(123), null);
});

test("intents are per-tab and do not leak between tabs", async () => {
  const store = createTrustedAddIntentStore(createFakeStorageArea());
  await store.set(1, { fqdn: "a.example", settingsTabId: 100 });
  await store.set(2, { fqdn: "b.example", settingsTabId: 100 });

  assert.deepEqual(await store.get(1), { fqdn: "a.example", settingsTabId: 100 });
  assert.deepEqual(await store.get(2), { fqdn: "b.example", settingsTabId: 100 }, "one tab's intent must not read as another's");
});

test("discardTab() drops a closed tab's intent", async () => {
  const store = createTrustedAddIntentStore(createFakeStorageArea());
  await store.set(5, intent);

  assert.deepEqual(await store.discardTab(5), intent, "the cleanup owner gets the intent exactly once");

  assert.equal(await store.get(5), null);
  assert.equal(await store.discardTab(5), null, "a competing cleanup cannot own it twice");
});

test("set() stores a copy, so later mutation of the argument cannot change stored state", async () => {
  const store = createTrustedAddIntentStore(createFakeStorageArea());
  const mutable = { fqdn: "bank.example", settingsTabId: 3 };
  await store.set(4, mutable);
  mutable.settingsTabId = 999;

  assert.deepEqual(await store.get(4), { fqdn: "bank.example", settingsTabId: 3 });
});

test("normalizeTrustedAddIntents repairs malformed persisted state", () => {
  assert.deepEqual(normalizeTrustedAddIntents(null), emptyTrustedAddIntents());
  assert.deepEqual(normalizeTrustedAddIntents("nonsense"), emptyTrustedAddIntents());
  assert.deepEqual(
    normalizeTrustedAddIntents({ intents_by_tab: { 7: { fqdn: "a" }, 8: "bad", 9: [1, 2] } }),
    { intents_by_tab: { 7: { fqdn: "a" } } }
  );
});

test("a corrupt stored value is read as no intents rather than throwing", async () => {
  const storageArea = createFakeStorageArea({ [TRUSTED_ADD_INTENTS_KEY]: "corrupt" });
  const store = createTrustedAddIntentStore(storageArea);

  assert.equal(await store.get(1), null);
});
