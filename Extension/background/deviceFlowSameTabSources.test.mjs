import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createDeviceFlowSameTabSourceStore } from "./deviceFlowSameTabSources.mjs";

function memoryStorage() {
  let data = {};
  return {
    async get(keys) {
      const result = {};
      for (const key of keys) if (Object.hasOwn(data, key)) result[key] = structuredClone(data[key]);
      return result;
    },
    async set(values) {
      data = { ...data, ...structuredClone(values) };
    },
  };
}

const source = {
  tabId: 7,
  sourceOrigin: "https://phishing.example",
};

test("same-tab source survives a worker restart and is consumed exactly once", async () => {
  const storage = memoryStorage();
  await createDeviceFlowSameTabSourceStore(storage, { now: () => 1_000 }).record(source);

  const restarted = createDeviceFlowSameTabSourceStore(storage, { now: () => 1_500 });
  assert.deepEqual(await restarted.consume(7), {
    ...source,
    createdAt: 1_000,
    expiresAt: 61_000,
  });
  assert.equal(await restarted.consume(7), null);
});

test("a commit consumes source attribution so it cannot attach to a later visit", async () => {
  const store = createDeviceFlowSameTabSourceStore(memoryStorage(), { now: () => 1_000 });
  await store.record(source);
  assert.equal((await store.consume(7)).sourceOrigin, source.sourceOrigin);
  assert.equal(await store.consume(7), null);
});

test("expired source attribution is rejected", async () => {
  let time = 1_000;
  const store = createDeviceFlowSameTabSourceStore(memoryStorage(), { now: () => time, ttlMs: 100 });
  await store.record(source);
  time = 1_101;
  assert.equal(await store.consume(7), null);
});

test("discardTab prevents a failed navigation from leaving attribution behind", async () => {
  const store = createDeviceFlowSameTabSourceStore(memoryStorage(), { now: () => 1_000 });
  await store.record(source);
  assert.equal(await store.discardTab(7), true);
  assert.equal(await store.consume(7), null);
});

test("the worker snapshots every web navigation and delegates final transition classification", async () => {
  const worker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  assert.match(worker, /onBeforeNavigate\.addListener[\s\S]{0,300}prepareSameTabDeviceFlowSource/);
  assert.match(worker, /sameTabDeviceFlowSources\.record\(\{[\s\S]{0,100}sourceOrigin/);
  assert.match(worker, /sameTabDeviceFlowSources\.consume\(details\.tabId\)[\s\S]{0,200}classifyDeviceFlowNavigation\(details\)/);
  assert.doesNotMatch(worker, /details\.transitionType !== "link"/);
  assert.doesNotMatch(worker, /sameTabNavigationSources/);
});
