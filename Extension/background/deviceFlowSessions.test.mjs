import test from "node:test";
import assert from "node:assert/strict";

import {
  DEVICE_FLOW_MAX_ACTIVE,
  DEVICE_FLOW_MAX_ACTIVE_PER_SOURCE_TAB,
  createDeviceFlowStore,
} from "./deviceFlowSessions.mjs";

function memoryStorage(initial = {}) {
  let data = structuredClone(initial);
  return {
    async get(keys) {
      await Promise.resolve();
      const requested = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of requested) {
        if (Object.hasOwn(data, key)) result[key] = structuredClone(data[key]);
      }
      return result;
    },
    async set(values) {
      await Promise.resolve();
      data = { ...data, ...structuredClone(values) };
    },
    dump() {
      return structuredClone(data);
    },
  };
}

function relationshipInput(overrides = {}) {
  return { sourceTabId: 1, targetTabId: 2, sourceOrigin: "https://evil.example", ...overrides };
}

test("createRelationship stores a record and getRelationship returns it", async () => {
  const store = createDeviceFlowStore(memoryStorage(), { now: () => 1_000 });
  const created = await store.createRelationship(relationshipInput());

  assert.deepEqual(created, {
    sourceTabId: 1,
    sourceFrameId: 0,
    targetTabId: 2,
    sourceOrigin: "https://evil.example",
    provider: null,
    returnPath: null,
    createdAt: 1_000,
    expiresAt: 1_000 + 15 * 60 * 1000,
  });
  assert.throws(() => { created.provider = "tampered"; }, "records must be frozen snapshots");

  const fetched = await store.getRelationship(2);
  assert.deepEqual(fetched, created);
});

test("a created-target relationship retains the initiating frame id", async () => {
  const store = createDeviceFlowStore(memoryStorage(), { now: () => 1_000 });
  const created = await store.createRelationship(relationshipInput({ sourceFrameId: 7 }));
  assert.equal(created.sourceFrameId, 7);
  assert.equal((await store.getRelationship(2)).sourceFrameId, 7);
});

test("creating a relationship twice for the same target tab is idempotent", async () => {
  const store = createDeviceFlowStore(memoryStorage(), { now: () => 1_000 });
  const first = await store.createRelationship(relationshipInput());
  const second = await store.createRelationship(relationshipInput({ sourceTabId: 99 }));
  assert.deepEqual(second, first, "an existing relationship for the tab must not be replaced");
});
test("recordSourceOrigin replaces the temporary opener label", async () => {
  const store = createDeviceFlowStore(memoryStorage(), { now: () => 1_000 });
  await store.createRelationship(relationshipInput({ sourceOrigin: "unknown" }));
  const updated = await store.recordSourceOrigin(2, "https://evil.example");
  assert.equal(updated.sourceOrigin, "https://evil.example");
  const fetched = await store.getRelationship(2);
  assert.equal(fetched.sourceOrigin, "https://evil.example");
});


test("recordMatch sets the provider and return path without disturbing timestamps", async () => {
  const store = createDeviceFlowStore(memoryStorage(), { now: () => 1_000 });
  await store.createRelationship(relationshipInput());

  const matched = await store.recordMatch(2, {
    provider: "GitHub",
    returnPath: { hostname: "github.com", path: "/login/device" },
  });

  assert.equal(matched.provider, "GitHub");
  assert.deepEqual(matched.returnPath, { hostname: "github.com", path: "/login/device" });
  assert.equal(matched.createdAt, 1_000);
});

test("recordMatch on an unknown target tab returns null", async () => {
  const store = createDeviceFlowStore(memoryStorage(), { now: () => 1_000 });
  const result = await store.recordMatch(404, { provider: "GitHub", returnPath: { hostname: "github.com", path: "/login/device" } });
  assert.equal(result, null);
});

// Issue #93 removed the interstitial's proceed action. The `acknowledged`
// bypass flag went with it: a record persisted by an earlier version still
// loads, but the flag is dropped rather than honored.
test("a stored pre-#93 acknowledged record survives without its bypass flag", async () => {
  const storageArea = memoryStorage({
    device_flow_relationships: {
      relationships_by_target_tab: {
        2: {
          sourceTabId: 1,
          sourceFrameId: 0,
          targetTabId: 2,
          sourceOrigin: "https://evil.example",
          provider: "GitHub",
          returnPath: { hostname: "github.com", path: "/login/device" },
          acknowledged: true,
          createdAt: 1_000,
          expiresAt: 1_000 + 60_000,
        },
      },
    },
  });
  const store = createDeviceFlowStore(storageArea, { now: () => 1_500 });

  const relationship = await store.getRelationship(2);
  assert.equal(relationship.provider, "GitHub");
  assert.equal("acknowledged" in relationship, false, "the obsolete bypass flag must not survive normalization");
});

test("discardRelationship removes exactly the targeted tab's record", async () => {
  const store = createDeviceFlowStore(memoryStorage(), { now: () => 1_000 });
  await store.createRelationship(relationshipInput({ targetTabId: 2 }));
  await store.createRelationship(relationshipInput({ targetTabId: 3 }));

  assert.equal(await store.discardRelationship(2), true);
  assert.equal(await store.getRelationship(2), null);
  assert.notEqual(await store.getRelationship(3), null);
  assert.equal(await store.discardRelationship(2), false, "already-removed is reported, not thrown");
});

test("closing the source keeps a live target relationship; closing the target removes it", async () => {
  const store = createDeviceFlowStore(memoryStorage(), { now: () => 1_000 });
  await store.createRelationship(relationshipInput({ sourceTabId: 1, targetTabId: 2 }));
  await store.createRelationship(relationshipInput({ sourceTabId: 5, targetTabId: 6 }));

  assert.equal(await store.discardTab(1), 0);
  assert.notEqual(await store.getRelationship(2), null);

  assert.equal(await store.discardTab(6), 1);
  assert.equal(await store.getRelationship(6), null);
});

test("a relationship expires after its TTL and is pruned on read", async () => {
  let time = 1_000;
  const storageArea = memoryStorage();
  const store = createDeviceFlowStore(storageArea, { now: () => time, ttlMs: 1_000 });
  await store.createRelationship(relationshipInput());

  time += 999;
  assert.notEqual(await store.getRelationship(2), null);

  time += 2;
  assert.equal(await store.getRelationship(2), null, "an expired relationship must not be returned");
  const stored = storageArea.dump().device_flow_relationships;
  assert.deepEqual(stored.relationships_by_target_tab, {}, "the expired record is pruned from storage, not just hidden");
});

test("nextExpiry reports the earliest active expiry and null once empty", async () => {
  const store = createDeviceFlowStore(memoryStorage(), { now: () => 1_000, ttlMs: 5_000 });
  assert.equal(await store.nextExpiry(), null);
  await store.createRelationship(relationshipInput({ targetTabId: 2 }));
  assert.equal(await store.nextExpiry(), 6_000);
  await store.discardRelationship(2);
  assert.equal(await store.nextExpiry(), null);
});

test("a service-worker restart survives via the shared storage area, not in-memory state", async () => {
  const storageArea = memoryStorage();
  const beforeRestart = createDeviceFlowStore(storageArea, { now: () => 1_000 });
  await beforeRestart.createRelationship(relationshipInput());
  await beforeRestart.recordMatch(2, { provider: "GitHub", returnPath: { hostname: "github.com", path: "/login/device" } });

  // A brand-new store instance stands in for the worker restarting.
  const afterRestart = createDeviceFlowStore(storageArea, { now: () => 1_500 });
  const relationship = await afterRestart.getRelationship(2);
  assert.equal(relationship.provider, "GitHub");
  assert.equal(relationship.sourceOrigin, "https://evil.example");
});
test("the per-source cap evicts the oldest relationship instead of rejecting the new target", async () => {
  let time = 1_000;
  const store = createDeviceFlowStore(memoryStorage(), { now: () => time });
  for (let i = 0; i < DEVICE_FLOW_MAX_ACTIVE_PER_SOURCE_TAB; i += 1) {
    await store.createRelationship(relationshipInput({ sourceTabId: 1, targetTabId: 100 + i }));
    time += 1;
  }
  const created = await store.createRelationship(relationshipInput({ sourceTabId: 1, targetTabId: 999 }));
  assert.notEqual(created, null);
  assert.equal(await store.getRelationship(100), null);
  assert.notEqual(await store.getRelationship(999), null);
});

test("the global cap evicts the oldest relationship instead of rejecting the new target", async () => {
  let time = 1_000;
  const store = createDeviceFlowStore(memoryStorage(), { now: () => time });
  for (let i = 0; i < DEVICE_FLOW_MAX_ACTIVE; i += 1) {
    await store.createRelationship(relationshipInput({ sourceTabId: 10 + i, targetTabId: 1_000 + i }));
    time += 1;
  }
  const created = await store.createRelationship(relationshipInput({ sourceTabId: 999, targetTabId: 9_999 }));
  assert.notEqual(created, null);
  assert.equal(await store.getRelationship(1_000), null);
  assert.notEqual(await store.getRelationship(9_999), null);
});

test("multiple independent target tabs are tracked separately", async () => {
  const store = createDeviceFlowStore(memoryStorage(), { now: () => 1_000 });
  await store.createRelationship(relationshipInput({ sourceTabId: 1, targetTabId: 2 }));
  await store.createRelationship(relationshipInput({ sourceTabId: 3, targetTabId: 4 }));

  const first = await store.getRelationship(2);
  const second = await store.getRelationship(4);
  assert.equal(first.sourceTabId, 1);
  assert.equal(second.sourceTabId, 3);
});

test("invalid input is rejected with a thrown error rather than corrupting storage", async () => {
  const store = createDeviceFlowStore(memoryStorage(), { now: () => 1_000 });
  await assert.rejects(() => store.createRelationship({ sourceTabId: 1, targetTabId: -1, sourceOrigin: "https://evil.example" }));
  await assert.rejects(() => store.createRelationship({ sourceTabId: 1, sourceFrameId: -1, targetTabId: 2, sourceOrigin: "https://evil.example" }));
  await assert.rejects(() => store.createRelationship({ sourceTabId: 1, targetTabId: 2, sourceOrigin: "" }));
  await assert.rejects(() => store.getRelationship("not-a-tab-id"));
});
