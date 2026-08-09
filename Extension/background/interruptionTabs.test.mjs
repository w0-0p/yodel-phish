import assert from "node:assert/strict";
import { test } from "node:test";

import { createInterruptionTabs } from "./interruptionTabs.mjs";

function createHarness({ storeError, updateError, readyTimeoutMs = 1_000 } = {}) {
  const calls = { stored: [], removedStored: [], removedTabs: [], updates: [] };
  const tabs = {
    async get() { return { windowId: 7 }; },
    async create() { return { id: 42 }; },
    async update(tabId, update) {
      calls.updates.push({ tabId, update });
      if (updateError !== undefined) throw updateError;
      return { id: tabId };
    },
    async remove(tabId) { calls.removedTabs.push(tabId); },
  };
  const coordinator = createInterruptionTabs({
    tabs,
    interruptionUrl: "chrome-extension://test/interstitial.html?kind=interrupted",
    readyTimeoutMs,
    async store(entry) {
      if (storeError !== undefined) throw storeError;
      calls.stored.push(entry);
    },
    async removeStored(tabId) { calls.removedStored.push(tabId); },
  });
  const open = () => coordinator.open({
    analysedTabId: 9,
    entry: { analysedTabId: 9, jobId: "job-1" },
    isCurrent: () => true,
  });
  return { calls, coordinator, open };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("an interruption tab succeeds only after its actionable UI acknowledges readiness", async () => {
  const { calls, coordinator, open } = createHarness();
  const resultPromise = open();
  await nextTurn();

  assert.equal(coordinator.isWaiting(42), true);
  assert.equal(coordinator.acknowledgeReady(42), true);
  assert.deepEqual(await resultPromise, { ok: true, tabId: 42 });
  assert.equal(calls.stored[0].interruptionTabId, 42);
  assert.deepEqual(calls.removedStored, []);
  assert.deepEqual(calls.removedTabs, []);
});

test("a navigation failure removes both the stored decision and its temporary tab", async () => {
  const failure = new Error("navigation failed");
  const { calls, open } = createHarness({ updateError: failure });

  assert.deepEqual(await open(), { ok: false, error: failure });
  assert.deepEqual(calls.removedStored, [42]);
  assert.deepEqual(calls.removedTabs, [42]);
});

test("a storage failure removes the temporary tab without inventing stored state", async () => {
  const failure = new Error("storage failed");
  const { calls, open } = createHarness({ storeError: failure });

  assert.deepEqual(await open(), { ok: false, error: failure });
  assert.deepEqual(calls.removedStored, []);
  assert.deepEqual(calls.removedTabs, [42]);
});

test("a decision UI that never becomes ready times out and is cleaned up", async () => {
  const { calls, open } = createHarness({ readyTimeoutMs: 5 });

  assert.deepEqual(await open(), { ok: false });
  assert.deepEqual(calls.removedStored, [42]);
  assert.deepEqual(calls.removedTabs, [42]);
});

test("losing the decision tab while it loads cancels readiness and cleans up", async () => {
  const { calls, coordinator, open } = createHarness();
  const resultPromise = open();
  await nextTurn();

  coordinator.cancelWait(42);

  assert.deepEqual(await resultPromise, { ok: false });
  assert.deepEqual(calls.removedStored, [42]);
  assert.deepEqual(calls.removedTabs, [42]);
});
