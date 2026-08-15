import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyManualLogoSelection,
  applyManualSiteMutation,
  compensateRevisionedEntry,
  compensateTrustedMutedCommit,
  createStorageDomain,
  DomainQueue,
  enforceTrustedVariantCap,
  MAX_STORED_SCORES,
  MAX_TRUSTED_VARIANTS_PER_FQDN,
  normalizeFqdn,
  removeAllManualSiteEntries,
  removeManualSiteEntries,
  repairTrustedMutedLists,
} from "./storageQueues.mjs";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A minimal stand-in for chrome.storage.local: get()/set() round trip through
// structuredClone so a caller can never hold a live reference into the
// backing store across an await, exactly like the real API.
function createFakeStorageArea(initial = {}) {
  let backing = structuredClone(initial);
  const area = {
    writes: 0,
    async get(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of keyList) result[key] = backing[key];
      return structuredClone(result);
    },
    async set(patch) {
      area.writes += 1;
      backing = { ...backing, ...structuredClone(patch) };
    },
    dump() {
      return structuredClone(backing);
    },
  };
  return area;
}

function findByFqdn(list, fqdn) {
  return list.find((entry) => entry.fqdn === fqdn) ?? null;
}

function createTrustedMutedDomain(storageArea) {
  return createStorageDomain({
    storageArea,
    keys: ["trusted_list", "muted_list"],
    load(data) {
      return {
        state: {
          trusted_list: Array.isArray(data.trusted_list) ? data.trusted_list : [],
          muted_list: Array.isArray(data.muted_list) ? data.muted_list : [],
        },
        dirty: false,
      };
    },
    persist: (state) => ({ trusted_list: state.trusted_list, muted_list: state.muted_list }),
  });
}

function createHistoryDomain(storageArea) {
  return createStorageDomain({
    storageArea,
    keys: ["analysis_history"],
    load(data) {
      return { state: { history: Array.isArray(data.analysis_history) ? data.analysis_history : [] }, dirty: false };
    },
    persist: (state) => ({ analysis_history: state.history }),
  });
}

// =============================================================================
// DomainQueue — the underlying FIFO serializer.
// =============================================================================

test("DomainQueue: queued tasks run strictly one at a time, in FIFO order", async () => {
  const queue = new DomainQueue();
  const order = [];
  let concurrentCount = 0;
  let maxConcurrent = 0;
  const makeTask = (label, ms) => async () => {
    concurrentCount += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrentCount);
    await delay(ms);
    order.push(label);
    concurrentCount -= 1;
    return label;
  };

  const results = await Promise.all([
    queue.run(makeTask("a", 15)),
    queue.run(makeTask("b", 5)),
    queue.run(makeTask("c", 1)),
  ]);

  assert.deepEqual(order, ["a", "b", "c"], "tasks must commit in the order they were queued, not the order their delays expire");
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.equal(maxConcurrent, 1, "no two tasks on the same domain may ever run concurrently");
});

test("DomainQueue: a rejected task does not block tasks queued after it", async () => {
  const queue = new DomainQueue();
  const first = queue.run(async () => {
    throw new Error("boom");
  });
  const second = queue.run(async () => "still runs");

  await assert.rejects(first, /boom/);
  assert.equal(await second, "still runs");
});

// =============================================================================
// add/add — two independent additions to the shared trusted+muted domain.
// =============================================================================

test("add/add: concurrent additions to the shared trusted+muted domain both land", async () => {
  const storageArea = createFakeStorageArea({ trusted_list: [], muted_list: [] });
  const withDomain = createTrustedMutedDomain(storageArea);

  const addTrusted = (fqdn) => withDomain((state) => {
    state.trusted_list = [...state.trusted_list, { fqdn }];
    return { value: undefined, changed: true };
  });

  await Promise.all([addTrusted("a.example"), addTrusted("b.example")]);

  const dump = storageArea.dump();
  assert.deepEqual(dump.trusted_list.map((entry) => entry.fqdn).sort(), ["a.example", "b.example"]);
});

// =============================================================================
// add/remove — an addition and a removal on the same shared domain.
// =============================================================================

test("add/remove: a concurrent add and remove on the shared domain never lose either update", async () => {
  const storageArea = createFakeStorageArea({
    trusted_list: [{ fqdn: "old.example" }],
    muted_list: [],
  });
  const withDomain = createTrustedMutedDomain(storageArea);

  const addMuted = withDomain((state) => {
    state.muted_list = [...state.muted_list, { fqdn: "new.example" }];
    return { value: undefined, changed: true };
  });
  const removeTrusted = withDomain((state) => {
    state.trusted_list = state.trusted_list.filter((entry) => entry.fqdn !== "old.example");
    return { value: undefined, changed: true };
  });

  await Promise.all([addMuted, removeTrusted]);

  const dump = storageArea.dump();
  assert.deepEqual(dump.trusted_list, []);
  assert.deepEqual(dump.muted_list.map((entry) => entry.fqdn), ["new.example"]);
});

// =============================================================================
// move/refresh — "move to trusted" touches both keys; it must share one
// domain with a same-time trusted-only refresh so neither reads a stale
// snapshot of the other's half-applied change.
// =============================================================================

test("move/refresh: moving a muted entry to trusted and refreshing an existing trusted entry both survive", async () => {
  const storageArea = createFakeStorageArea({
    trusted_list: [{ fqdn: "existing.example", score: 1 }],
    muted_list: [{ fqdn: "moved.example" }],
  });
  const withDomain = createTrustedMutedDomain(storageArea);

  const move = withDomain((state) => {
    const entry = findByFqdn(state.muted_list, "moved.example");
    state.muted_list = state.muted_list.filter((item) => item.fqdn !== "moved.example");
    state.trusted_list = [...state.trusted_list, { ...entry }];
    return { value: undefined, changed: true };
  });
  const refresh = withDomain((state) => {
    const entry = findByFqdn(state.trusted_list, "existing.example");
    entry.score = 2;
    return { value: undefined, changed: true };
  });

  await Promise.all([move, refresh]);

  const dump = storageArea.dump();
  assert.deepEqual(dump.muted_list, []);
  assert.ok(findByFqdn(dump.trusted_list, "moved.example") !== null, "the moved entry must be present in trusted_list");
  assert.equal(findByFqdn(dump.trusted_list, "existing.example").score, 2, "the concurrent refresh must not be lost");
});

// =============================================================================
// refresh rollback — a job that commits a targeted, identity/version-stamped
// change must be able to compensate it later WITHOUT restoring a full stale
// snapshot, so a legitimate change committed in between is never erased.
// =============================================================================

function commitTrustedUpdate(withDomain, fqdn, patch) {
  return withDomain((state) => {
    const entry = findByFqdn(state.trusted_list, fqdn);
    const before = { ...entry };
    const revision = `revision-${Math.random().toString(36).slice(2)}`;
    Object.assign(entry, patch, { storage_revision: revision });
    return {
      value: { isNew: false, fqdn, variantId: entry.variant_id, revision, before },
      changed: true,
    };
  });
}

function compensateTrustedCommit(withDomain, commit) {
  return withDomain((state) => {
    const outcome = compensateRevisionedEntry(state.trusted_list, commit);
    state.trusted_list = outcome.entries;
    return { value: outcome.changed ? "reverted" : "skipped", changed: outcome.changed };
  });
}

test("refresh rollback: compensation reverts cleanly when nothing else touched the entry afterward", async () => {
  const storageArea = createFakeStorageArea({
    trusted_list: [{ fqdn: "site.example", variant_id: "variant-1", storage_revision: "revision-0", score: 1 }],
    muted_list: [],
  });
  const withDomain = createTrustedMutedDomain(storageArea);

  const commit = await commitTrustedUpdate(withDomain, "site.example", { score: 2 });
  const outcome = await compensateTrustedCommit(withDomain, commit);

  assert.equal(outcome, "reverted");
  assert.equal(findByFqdn(storageArea.dump().trusted_list, "site.example").score, 1);
});

test("refresh rollback: a newer trusted commit rotates the revision and cannot be erased", async () => {
  const storageArea = createFakeStorageArea({
    trusted_list: [{ fqdn: "site.example", variant_id: "variant-1", storage_revision: "revision-0", score: 1 }],
    muted_list: [],
  });
  const withDomain = createTrustedMutedDomain(storageArea);

  const commitA = await commitTrustedUpdate(withDomain, "site.example", { score: 2 });
  await commitTrustedUpdate(withDomain, "site.example", { score: 3 });
  const outcome = await compensateTrustedCommit(withDomain, commitA);

  assert.equal(outcome, "skipped");
  assert.equal(findByFqdn(storageArea.dump().trusted_list, "site.example").score, 3);
});

test("refresh rollback: a newer user-word edit rotates the revision and survives compensation", async () => {
  const storageArea = createFakeStorageArea({
    trusted_list: [{
      fqdn: "site.example",
      variant_id: "variant-1",
      storage_revision: "revision-0",
      user_words: [],
      score: 1,
    }],
    muted_list: [],
  });
  const withDomain = createTrustedMutedDomain(storageArea);

  const staleCommit = await commitTrustedUpdate(withDomain, "site.example", { score: 2 });
  await withDomain((state) => {
    const entry = findByFqdn(state.trusted_list, "site.example");
    entry.user_words = ["important"];
    entry.storage_revision = "revision-user-edit";
    return { value: undefined, changed: true };
  });
  const outcome = await compensateTrustedCommit(withDomain, staleCommit);

  assert.equal(outcome, "skipped");
  assert.deepEqual(findByFqdn(storageArea.dump().trusted_list, "site.example").user_words, ["important"]);
});

test("refresh rollback: a revised new entry is not deleted by stale compensation", async () => {
  const storageArea = createFakeStorageArea({
    trusted_list: [{
      fqdn: "site.example",
      variant_id: "variant-1",
      storage_revision: "revision-user-edit",
      user_words: ["important"],
    }],
    muted_list: [],
  });
  const withDomain = createTrustedMutedDomain(storageArea);
  const staleCommit = {
    isNew: true,
    fqdn: "site.example",
    variantId: "variant-1",
    revision: "revision-created",
  };

  const outcome = await compensateTrustedCommit(withDomain, staleCommit);

  assert.equal(outcome, "skipped");
  assert.ok(findByFqdn(storageArea.dump().trusted_list, "site.example") !== null);
});

// =============================================================================
// concurrent history appends — every append must survive, none overwritten.
// =============================================================================

test("concurrent history appends: every record survives, none overwritten", async () => {
  const storageArea = createFakeStorageArea({ analysis_history: [] });
  const withHistory = createHistoryDomain(storageArea);

  const append = (record) => withHistory((state) => {
    state.history = [...state.history, record];
    return { value: undefined, changed: true };
  });

  await Promise.all([append("r1"), append("r2"), append("r3"), append("r4"), append("r5")]);

  assert.deepEqual(storageArea.dump().analysis_history.slice().sort(), ["r1", "r2", "r3", "r4", "r5"]);
});

// =============================================================================
// clear/append — deterministic FIFO ordering: clear wipes what preceded it in
// the queue, but never discards what is queued after it.
// =============================================================================

test("clear/append: operations commit in queue order, neither silently discarded", async () => {
  const storageArea = createFakeStorageArea({ analysis_history: ["existing"] });
  const withHistory = createHistoryDomain(storageArea);

  const append = (record) => withHistory((state) => {
    state.history = [...state.history, record];
    return { value: undefined, changed: true };
  });
  const clear = () => withHistory((state) => {
    state.history = [];
    return { value: undefined, changed: true };
  });

  // Queued in this order: append("mid-flight"), clear(), append("after-clear").
  await Promise.all([append("mid-flight"), clear(), append("after-clear")]);

  assert.deepEqual(storageArea.dump().analysis_history, ["after-clear"]);
});

// =============================================================================
// Normalization/migration writes must be serialized through the same queue
// as ordinary mutations, not applied as a side effect of a plain read.
// =============================================================================

test("createStorageDomain: a dirty load() forces a persist even when the mutator itself reports no change", async () => {
  const storageArea = createFakeStorageArea({ settings: { developer_mode: false, device_code_auth: "invalid" } });
  const withSettings = createStorageDomain({
    storageArea,
    keys: ["settings"],
    load(data) {
      const raw = data.settings ?? {};
      const developer_mode = raw.developer_mode === true;
      const device_code_auth = raw.device_code_auth === "allowed" ? "allowed" : "blocked";
      return {
        state: { ...raw, developer_mode, device_code_auth },
        dirty: device_code_auth !== raw.device_code_auth,
      };
    },
    persist: (settings) => ({ settings }),
  });

  const result = await withSettings(() => ({ value: "read-only", changed: false }));

  assert.equal(result, "read-only");
  assert.equal(
    storageArea.dump().settings.device_code_auth,
    "blocked",
    "the invariant fix-up must be persisted even though the caller made no change of its own"
  );
});

test("createStorageDomain: concurrent mutators on the same domain each see the previous commit, not a stale read", async () => {
  const storageArea = createFakeStorageArea({ trusted_list: [{ fqdn: "site.example", visits: 0 }], muted_list: [] });
  const withDomain = createTrustedMutedDomain(storageArea);

  const increment = () => withDomain((state) => {
    const entry = findByFqdn(state.trusted_list, "site.example");
    entry.visits += 1;
    return { value: undefined, changed: true };
  });

  await Promise.all(Array.from({ length: 10 }, () => increment()));

  assert.equal(findByFqdn(storageArea.dump().trusted_list, "site.example").visits, 10);
});

test("settings disable and diagnostic append are linearized on one shared queue", async () => {
  const storageArea = createFakeStorageArea({
    settings: { developer_mode: true },
    analysis_history: [],
  });
  const sharedQueue = new DomainQueue();
  const withSettings = createStorageDomain({
    storageArea,
    queue: sharedQueue,
    keys: ["settings"],
    load: (data) => ({ state: data.settings, dirty: false }),
    persist: (settings) => ({ settings }),
  });
  const withDiagnostics = createStorageDomain({
    storageArea,
    queue: sharedQueue,
    keys: ["settings", "analysis_history"],
    load: (data) => ({
      state: { settings: data.settings, history: data.analysis_history },
      dirty: false,
    }),
    persist: (state) => ({ settings: state.settings, analysis_history: state.history }),
  });

  const disable = withSettings((settings) => {
    settings.developer_mode = false;
    return { value: undefined, changed: true };
  });
  const append = withDiagnostics((state) => {
    if (state.settings.developer_mode !== true) return { value: false, changed: false };
    state.history = [...state.history, "must-not-land"];
    return { value: true, changed: true };
  });

  assert.deepEqual(await Promise.all([disable, append]), [undefined, false]);
  assert.deepEqual(storageArea.dump().analysis_history, []);
});

// =============================================================================
// TRUSTED/MUTED INVARIANTS — issue #12. Two trusted entries sharing an fqdn are
// legitimate variants, not duplicates; everything else about the two lists is
// an invariant the repair enforces on every read.
// =============================================================================

function createIdFactory() {
  let counter = 0;
  return () => `generated-${++counter}`;
}

function repair(data) {
  return repairTrustedMutedLists(data, { newId: createIdFactory() });
}

function trustedVariant(fqdn, variantId, extra = {}) {
  return {
    fqdn,
    variant_id: variantId,
    storage_revision: `revision-${variantId}`,
    user_words: [],
    scores: [],
    ...extra,
  };
}

// The service worker's own trusted/muted domain: the repair runs inside load(),
// so a fix-up is persisted through this queue instead of leaking out of a read.
function createRepairingTrustedMutedDomain(storageArea) {
  const newId = createIdFactory();
  return createStorageDomain({
    storageArea,
    keys: ["trusted_list", "muted_list"],
    load(data) {
      const { trusted_list, muted_list, changed } = repairTrustedMutedLists(data, { newId });
      return { state: { trusted_list, muted_list }, dirty: changed };
    },
    persist: (state) => ({ trusted_list: state.trusted_list, muted_list: state.muted_list }),
  });
}

test("repair: two reference variants of one fqdn are kept, and nothing is rewritten", () => {
  const trusted = [
    trustedVariant("site.example", "variant-1"),
    trustedVariant("site.example", "variant-2"),
    trustedVariant("other.example", "variant-3"),
  ];

  const repaired = repair({ trusted_list: trusted, muted_list: [] });

  assert.equal(repaired.changed, false, "entries already satisfying the invariants must not be rewritten");
  assert.deepEqual(repaired.trusted_list.map((entry) => entry.variant_id), ["variant-1", "variant-2", "variant-3"]);
  repaired.trusted_list.forEach((entry, index) => {
    assert.equal(entry, trusted[index], "an untouched entry must be returned as the same object");
  });
});

test("repair: a third variant of one fqdn cannot remain, keeping the manual reference and the most recent capture", () => {
  const repaired = repair({
    trusted_list: [
      trustedVariant("site.example", "oldest-automatic", { updated_at: "2026-01-01T00:00:00.000Z" }),
      trustedVariant("site.example", "manual", { logo_source: "manual", updated_at: "2025-01-01T00:00:00.000Z" }),
      trustedVariant("site.example", "newest-automatic", { updated_at: "2026-06-01T00:00:00.000Z" }),
    ],
    muted_list: [],
  });

  assert.equal(repaired.changed, true);
  assert.equal(repaired.trusted_list.length, MAX_TRUSTED_VARIANTS_PER_FQDN);
  assert.deepEqual(
    repaired.trusted_list.map((entry) => entry.variant_id),
    ["manual", "newest-automatic"],
    "a manually chosen reference is preserved; the oldest automatic capture is the one evicted"
  );
});

test("repair: variants with no dates keep their stored order when the cap evicts", () => {
  const repaired = repair({
    trusted_list: [
      trustedVariant("site.example", "first"),
      trustedVariant("site.example", "second"),
      trustedVariant("site.example", "third"),
    ],
    muted_list: [],
  });

  assert.deepEqual(repaired.trusted_list.map((entry) => entry.variant_id), ["first", "second"]);
});

test("repair: the most recent capture is kept even when a variant is dated only by its last score", () => {
  const repaired = repair({
    trusted_list: [
      trustedVariant("site.example", "scored-old", { scores: [{ datetime: "2025-01-01T00:00:00.000Z" }] }),
      trustedVariant("site.example", "undated"),
      trustedVariant("site.example", "scored-new", { scores: [{ datetime: "2026-01-01T00:00:00.000Z" }] }),
    ],
    muted_list: [],
  });

  assert.deepEqual(repaired.trusted_list.map((entry) => entry.variant_id), ["scored-old", "scored-new"]);
});

test("repair: invalid entries are dropped and fqdns are normalized", () => {
  const repaired = repair({
    trusted_list: [
      null,
      "site.example",
      [],
      { variant_id: "no-fqdn" },
      { fqdn: "   ", variant_id: "blank-fqdn" },
      { fqdn: 42, variant_id: "numeric-fqdn" },
      trustedVariant(" Site.EXAMPLE ", "variant-1"),
    ],
    muted_list: [null, { muted_until: "forever" }, { fqdn: "MUTED.example" }],
  });

  assert.equal(repaired.changed, true);
  assert.deepEqual(repaired.trusted_list.map((entry) => entry.fqdn), ["site.example"]);
  assert.deepEqual(repaired.muted_list.map((entry) => entry.fqdn), ["muted.example"]);
});

test("repair: a non-array list is replaced by one and reported as a change", () => {
  const repaired = repair({ trusted_list: { "site.example": {} }, muted_list: "muted.example" });

  assert.equal(repaired.changed, true);
  assert.deepEqual(repaired.trusted_list, []);
  assert.deepEqual(repaired.muted_list, []);
});

test("repair: unwritten lists need no repair", () => {
  const repaired = repair({});

  assert.equal(repaired.changed, false, "a fresh profile must not be written to just because it was read");
  assert.deepEqual(repaired.trusted_list, []);
  assert.deepEqual(repaired.muted_list, []);
});

test("repair: missing variant ids and storage revisions are backfilled, uniquely within an fqdn group", () => {
  const repaired = repair({
    trusted_list: [
      { fqdn: "site.example" },
      { fqdn: "site.example", variant_id: "", storage_revision: "" },
      { fqdn: "other.example", variant_id: "shared", storage_revision: "revision-a" },
      { fqdn: "other.example", variant_id: "shared", storage_revision: "revision-b" },
    ],
    muted_list: [],
  });

  assert.equal(repaired.changed, true);
  for (const entry of repaired.trusted_list) {
    assert.ok(typeof entry.variant_id === "string" && entry.variant_id.length > 0);
    assert.ok(typeof entry.storage_revision === "string" && entry.storage_revision.length > 0);
  }
  const identities = repaired.trusted_list.map((entry) => `${entry.fqdn}#${entry.variant_id}`);
  assert.equal(new Set(identities).size, identities.length, "each retained variant needs its own pipeline identity");
  assert.equal(repaired.trusted_list[2].variant_id, "shared", "the first holder of an id keeps it");
  assert.notEqual(repaired.trusted_list[3].variant_id, "shared", "the colliding duplicate is reissued");
});

test("repair: a duplicate muted fqdn is collapsed to the first entry", () => {
  const repaired = repair({
    trusted_list: [],
    muted_list: [
      { fqdn: "site.example", muted_until: "forever" },
      { fqdn: "site.example", muted_until: "next_login" },
      { fqdn: "other.example", muted_until: "forever" },
    ],
  });

  assert.equal(repaired.changed, true);
  assert.deepEqual(repaired.muted_list.map((entry) => entry.fqdn), ["site.example", "other.example"]);
  assert.equal(repaired.muted_list[0].muted_until, "forever");
});

test("repair: an fqdn in both lists stays muted only, matching the runtime check order", () => {
  const repaired = repair({
    trusted_list: [
      trustedVariant("both.example", "variant-1"),
      trustedVariant("both.example", "variant-2"),
      trustedVariant("trusted.example", "variant-3"),
    ],
    muted_list: [{ fqdn: "both.example", muted_until: "forever" }],
  });

  assert.equal(repaired.changed, true);
  assert.deepEqual(repaired.trusted_list.map((entry) => entry.fqdn), ["trusted.example"]);
  assert.deepEqual(repaired.muted_list.map((entry) => entry.fqdn), ["both.example"]);
});

test("repair: malformed optional fields are defaulted or discarded, and a screenshot is never retained", () => {
  const repaired = repair({
    trusted_list: [
      trustedVariant("site.example", "variant-1", {
        user_words: "not-a-list",
        ocr_words: null,
        scores: { latest: {} },
        logo_regions: "not-a-list",
        logo_features: 7,
        dinov2_embedding: { 0: 0.5 },
        screenshot: { dataUrl: "data:image/png;base64,AAAA" },
      }),
    ],
    muted_list: [{ fqdn: "muted.example", user_words: "not-a-list" }],
  });

  const [trusted] = repaired.trusted_list;
  assert.equal(repaired.changed, true);
  assert.deepEqual(trusted.user_words, [], "a list every consumer iterates is defaulted, not dropped");
  assert.deepEqual(trusted.ocr_words, []);
  assert.deepEqual(trusted.scores, []);
  assert.equal("logo_regions" in trusted, false, "an optional detection field is discarded when malformed");
  assert.equal("logo_features" in trusted, false);
  assert.equal("dinov2_embedding" in trusted, false);
  assert.equal("screenshot" in trusted, false, "analysis input is never part of a stored record");
  assert.deepEqual(repaired.muted_list[0].user_words, []);
});

test("repair: malformed array elements are filtered or cause unsafe detection fields to be discarded", () => {
  const validScore = { datetime: "2026-01-01T00:00:00.000Z" };
  const repaired = repair({
    trusted_list: [trustedVariant("site.example", "variant-1", {
      user_words: ["keep", null, 7],
      ocr_words: [{ text: "bad" }, "brand"],
      scores: [null, validScore, []],
      logo_regions: [null],
      logo_features: [{ index: 0, region: null }],
      dinov2_embedding: [0.5, Number.NaN],
    })],
    muted_list: [],
  });

  const [trusted] = repaired.trusted_list;
  assert.deepEqual(trusted.user_words, ["keep"]);
  assert.deepEqual(trusted.ocr_words, ["brand"]);
  assert.deepEqual(trusted.scores, [validScore]);
  assert.equal("logo_regions" in trusted, false);
  assert.equal("logo_features" in trusted, false);
  assert.equal("dinov2_embedding" in trusted, false);
});

test("repair: minimally valid manual regions and features are preserved", () => {
  const region = { source: "manual", x: 1, y: 2, width: 30, height: 20 };
  const trusted = trustedVariant("site.example", "variant-1", {
    logo_regions: [region],
    logo_features: [{ index: 0, region, ocr: { text: "Brand", tokens: ["brand"] } }],
    dinov2_embedding: [0.1, 0.2],
  });

  const repaired = repair({ trusted_list: [trusted], muted_list: [] });

  assert.equal(repaired.changed, false);
  assert.equal(repaired.trusted_list[0], trusted);
});

test("repair: invalid muted_until values become forever", () => {
  const repaired = repair({
    trusted_list: [],
    muted_list: [{ fqdn: "site.example", muted_until: "unexpected" }],
  });

  assert.equal(repaired.changed, true);
  assert.equal(repaired.muted_list[0].muted_until, "forever");
});

test("normalizeFqdn: browser-canonical hostnames are kept and non-host inputs are rejected", () => {
  assert.equal(normalizeFqdn(" BÜCHER.example "), "xn--bcher-kva.example");
  assert.equal(normalizeFqdn("Login.Example.COM"), "login.example.com");
  assert.equal(normalizeFqdn("login.example.com."), "login.example.com");
  for (const invalid of [
    "https://example.com", "user@example.com", "example.com/path", "example.com:443",
    "bad host", "bad_host.example", "empty..label", "-leading.example", "trailing-.example",
  ]) {
    assert.equal(normalizeFqdn(invalid), null, invalid);
  }
});

test("compensation restores the mute removed by the exact trusted commit", () => {
  const mutedBefore = { fqdn: "site.example", muted_until: "forever" };
  const commit = {
    isNew: true,
    fqdn: "site.example",
    variantId: "variant-1",
    revision: "revision-1",
    mutedBefore,
    mutedIndex: 0,
  };
  const outcome = compensateTrustedMutedCommit(
    [trustedVariant("site.example", "variant-1", { storage_revision: "revision-1" })],
    [],
    commit
  );

  assert.equal(outcome.changed, true);
  assert.deepEqual(outcome.trustedEntries, []);
  assert.deepEqual(outcome.mutedEntries, [mutedBefore]);
});

test("compensation cannot restore a stale mute over a newer same-fqdn mutation", () => {
  const newerMute = { fqdn: "site.example", muted_until: "next_login" };
  const outcome = compensateTrustedMutedCommit(
    [],
    [newerMute],
    {
      isNew: true,
      fqdn: "site.example",
      variantId: "variant-1",
      revision: "revision-1",
      mutedBefore: { fqdn: "site.example", muted_until: "forever" },
      mutedIndex: 0,
    }
  );

  assert.equal(outcome.changed, false);
  assert.deepEqual(outcome.mutedEntries, [newerMute]);
});

test("repair: repairing malformed legacy storage twice produces no further changes", () => {
  const legacy = {
    trusted_list: [
      null,
      { fqdn: "SITE.example", screenshot: {}, user_words: "oops" },
      { fqdn: "site.example", variant_id: "kept", logo_source: "manual" },
      { fqdn: "site.example", variant_id: "kept", updated_at: "2026-01-01T00:00:00.000Z" },
      { fqdn: "site.example", updated_at: "2020-01-01T00:00:00.000Z" },
      { fqdn: "muted.example", variant_id: "overlap" },
    ],
    muted_list: [{ fqdn: "muted.example" }, { fqdn: "muted.example", muted_until: "next_login" }, 5],
  };

  const first = repair(legacy);
  const second = repair({ trusted_list: first.trusted_list, muted_list: first.muted_list });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false, "the repair must be idempotent");
  assert.deepEqual(second.trusted_list, first.trusted_list);
  assert.deepEqual(second.muted_list, first.muted_list);
  assert.equal(first.trusted_list.length, MAX_TRUSTED_VARIANTS_PER_FQDN);
  assert.deepEqual(first.muted_list.map((entry) => entry.fqdn), ["muted.example"]);
  assert.equal(
    first.trusted_list.every((entry) => entry.fqdn === "site.example"),
    true,
    "the muted fqdn keeps no trusted variant"
  );
});

test("repair: the fix-up is persisted through the trusted/muted queue exactly once", async () => {
  const storageArea = createFakeStorageArea({
    trusted_list: [{ fqdn: "site.example" }],
    muted_list: [{ fqdn: "muted.example" }, { fqdn: "muted.example" }],
  });
  const withDomain = createRepairingTrustedMutedDomain(storageArea);
  const read = () => withDomain((state) => ({ value: state, changed: false }));

  await read();
  const writesAfterRepair = storageArea.writes;
  const second = await read();

  assert.equal(writesAfterRepair, 1, "a read-only caller still commits the repair");
  assert.equal(storageArea.writes, writesAfterRepair, "a repaired store is not rewritten on every later read");
  const dump = storageArea.dump();
  assert.equal(dump.muted_list.length, 1);
  assert.ok(dump.trusted_list[0].variant_id.length > 0);
  assert.equal(dump.trusted_list[0].variant_id, second.trusted_list[0].variant_id);
});

test("repair: a concurrent mutation is not lost to the repair, nor the repair to it", async () => {
  const storageArea = createFakeStorageArea({
    trusted_list: [{ fqdn: "legacy.example" }],
    muted_list: [],
  });
  const withDomain = createRepairingTrustedMutedDomain(storageArea);

  const read = withDomain(() => ({ value: undefined, changed: false }));
  const add = withDomain((state) => {
    state.trusted_list = [...state.trusted_list, { fqdn: "added.example", variant_id: "added", storage_revision: "r" }];
    return { value: undefined, changed: true };
  });
  await Promise.all([read, add]);

  const dump = storageArea.dump();
  assert.deepEqual(dump.trusted_list.map((entry) => entry.fqdn), ["legacy.example", "added.example"]);
  assert.ok(dump.trusted_list[0].variant_id.length > 0, "the backfilled id survives the concurrent addition");
});

test("enforceTrustedVariantCap: an append site cannot leave a third variant stored", () => {
  const existing = [
    trustedVariant("site.example", "manual", { logo_source: "manual", updated_at: "2025-01-01T00:00:00.000Z" }),
    trustedVariant("site.example", "older", { updated_at: "2026-01-01T00:00:00.000Z" }),
    trustedVariant("other.example", "untouched"),
  ];
  const appended = trustedVariant("site.example", "newest", { updated_at: "2026-06-01T00:00:00.000Z" });

  const capped = enforceTrustedVariantCap([...existing, appended]);

  assert.deepEqual(
    capped.map((entry) => entry.variant_id),
    ["manual", "untouched", "newest"],
    "the appended variant is kept alongside the manual reference; the older automatic one is evicted"
  );
  assert.equal(enforceTrustedVariantCap(capped), capped, "a list already within the cap is returned untouched");
});

test("service-worker storage protocol is trusted, bounded, and returns targeted mutation results", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const settingsPage = await readFile(new URL("../settings/settings.js", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

  assert.match(serviceWorker, /setAccessLevel\(\{ accessLevel: "TRUSTED_CONTEXTS" \}\)/);
  assert.match(serviceWorker, /SETTINGS_MESSAGE_TYPES\.has\(message\?\.type\) && !isSettingsSender\(sender\)/);
  assert.match(serviceWorker, /SETTINGS_MESSAGE_TYPES = new Set\(\[[\s\S]*?"open_logo_selector"/);
  assert.match(serviceWorker, /sendResponse\(invalidSettingsRequest\("forbidden"\)\)/);
  assert.match(serviceWorker, /word\.length <= MAX_USER_WORD_LENGTH/);
  assert.match(serviceWorker, /ALLOWED_MUTED_UNTIL\.has\(value\)/);
  assert.match(serviceWorker, /if \(listType === "trusted"\) touchTrustedEntry\(entry\)/);
  assert.match(serviceWorker, /Object\.hasOwn\(raw, "regex_exclusions"\)/);
  assert.match(serviceWorker, /return \{ mode, excluded_domains \}/);
  assert.doesNotMatch(settingsPage, /regex_exclusions|regex exclusion/i);
  const warningOpenStart = serviceWorker.indexOf("async function openClickfixWarning");
  const warningCreate = serviceWorker.indexOf("clickfixWarnings.createWarning", warningOpenStart);
  const sourceLiveness = serviceWorker.indexOf("isClickfixSourceDocumentAlive(warning)", warningCreate);
  const warningTabCreate = serviceWorker.indexOf("chrome.tabs.create", sourceLiveness);
  assert.ok(warningOpenStart >= 0 && warningCreate > warningOpenStart);
  assert.ok(sourceLiveness > warningCreate && warningTabCreate > sourceLiveness);
  const clickfixRequestStart = serviceWorker.indexOf('case "clickfix_clipboard_request"');
  const clickfixRequestEnd = serviceWorker.indexOf('case "open_clickfix_settings"', clickfixRequestStart);
  const clickfixRequest = serviceWorker.slice(clickfixRequestStart, clickfixRequestEnd);
  assert.match(
    clickfixRequest,
    /withSettings\(async \(state\) => \{[\s\S]*?detectClickfixCommand[\s\S]*?if \(decision\.action === "allow"\) \{[\s\S]*?await writeClickfixClipboardText\(message\.text\)/,
    "classification and allowed writes must remain serialized with settings mutations"
  );
  assert.doesNotMatch(serviceWorker, /getSettingsRenderState/);
  assert.doesNotMatch(serviceWorker, /case "get_settings_state"/);
  assert.doesNotMatch(serviceWorker, /value: \{ \.\.\.state \}/);
  assert.equal((serviceWorker.match(/chrome\.storage\.local\.set\(/g) ?? []).length, 1);
  const startupRepairIndex = serviceWorker.indexOf("void getStorage().catch");
  assert.ok(startupRepairIndex > serviceWorker.indexOf("const withTrustedMuted ="));
  assert.ok(startupRepairIndex > serviceWorker.indexOf("const withSettings ="));
  assert.ok(startupRepairIndex > serviceWorker.indexOf("async function getStorage()"));
  // setAccessLevel needs 102, chrome.offscreen needs 109, content_scripts
  // `world: "MAIN"` needs 111, and runtime.getContexts (used to coordinate
  // the one MV3 offscreen document) needs 116.
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.doesNotMatch(settingsPage, /chrome\.storage\.local\.set/);
  assert.doesNotMatch(settingsPage, /tag\.innerHTML/);
});

test("split-incognito workers reject diagnostics before shared local storage is opened", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const writerStart = serviceWorker.indexOf("async function appendAnalysisHistory(record)");
  const writerEnd = serviceWorker.indexOf("function isDeveloperModeEnabled()", writerStart);

  assert.ok(writerStart >= 0 && writerEnd > writerStart);
  const writer = serviceWorker.slice(writerStart, writerEnd);
  const incognitoGuard = writer.indexOf("chrome.extension.inIncognitoContext === true");
  const sharedStorageTransaction = writer.indexOf("withDiagnosticsState");
  assert.ok(
    incognitoGuard >= 0 && sharedStorageTransaction > incognitoGuard,
    "incognito diagnostics must be rejected before the shared storage.local transaction"
  );
});

test("every trusted/muted write site keeps the two lists mutually exclusive and within the variant cap", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  // Issue #7 moved the manual-logo write out of the service worker and into
  // applyManualLogoSelection, so both files are checked for the same invariant.
  const storageQueues = await readFile(new URL("./storageQueues.mjs", import.meta.url), "utf8");

  // The one read path into the domain repairs the invariants before any
  // mutator sees the lists, and reports the repair as a persistable change.
  assert.match(serviceWorker, /repairTrustedMutedLists\(data, \{\s*newId: newStorageRevision,?\s*\}\)/);
  assert.match(serviceWorker, /dirty: changed/);

  // Muting drops the trusted variants; trusting drops the muted entry. Since
  // issue #90 every explicit add commits through applyManualLogoSelection, so
  // the trust side of the invariant lives in storageQueues.mjs alone.
  assert.match(
    serviceWorker,
    /state\.trusted_list = state\.trusted_list\.filter\(\(entry\) => entry\.fqdn !== origin\.fqdn\)/
  );
  assert.match(
    storageQueues,
    /state\.muted_list = state\.muted_list\.filter\(\(item\) => item\.fqdn !== addition\.origin\.fqdn\)/
  );

  // Every append to trusted_list runs through the cap, so no write site can
  // leave a third variant stored for one fqdn.
  for (const [label, source] of [["service_worker.js", serviceWorker], ["storageQueues.mjs", storageQueues]]) {
    assert.equal(
      (source.match(/state\.trusted_list = \[\s*\.\.\.state\.trusted_list,/g) ?? []).length,
      0,
      `an append in ${label} that bypasses enforceTrustedVariantCap could leave a third variant stored`
    );
  }
  // Automatic refresh is the service worker's only remaining direct append:
  // the explicit add's append moved into applyManualLogoSelection with issue
  // #90, and move-muted-to-trusted stopped appending eagerly with issue #8 —
  // it now confirms through that same add path. storageQueues keeps two: the
  // add/confirm append and the manual Advanced Settings add (issue #93).
  assert.equal((serviceWorker.match(/enforceTrustedVariantCap\(\[/g) ?? []).length, 1);
  assert.equal((storageQueues.match(/enforceTrustedVariantCap\(\[/g) ?? []).length, 2);
});

test("the winning trusted variant identity is propagated into diagnostics", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const pipeline = await readFile(
    new URL("../../src/detection/core/pipeline/runDetection.ts", import.meta.url),
    "utf8"
  );

  assert.match(pipeline, /matchedReferenceId: winnerRow\?\.imgPath \?\? ""/);
  assert.match(pipeline, /matchedVariantId: winnerRow\?\.variantId \?\? ""/);
  assert.match(serviceWorker, /matched_variant_id: result\.best_match_variant_id/);
  // Issue #90 debugging: the proposal-path stats the pipeline computes reach
  // the stored history record instead of being dropped at the boundary.
  assert.match(serviceWorker, /query_stats: pipeline\?\.queryStats \?\? null/);
  assert.match(serviceWorker, /variant_id: entry\.variant_id \?\? \"\"/);
  // The winner carries its own identity, so the record reads it straight off
  // the pipeline winner rather than re-finding the matching perTrusted row by
  // reference id (and, failing that, by fqdn and an exact score comparison).
  assert.match(serviceWorker, /variant_id: winner\.matchedVariantId \?\? ""/);
  assert.match(serviceWorker, /reference_id: winner\.matchedReferenceId \?\? ""/);
  // Every comparison-table row still names the variant it scored, not just
  // the fqdn: two variants of one fqdn are separate candidates.
  assert.match(serviceWorker, /variant_id: candidate\.variantId \?\? ""/);
});

// A page's address can carry a session token, a password-reset code or a
// single-use login link. None of it explains a verdict, so no record holds
// more of the address than its hostname -- and the larger records earlier
// versions wrote are discarded rather than left to be exported or evicted.
test("analysis history stores the analysed host and discards legacy records", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const settingsPage = await readFile(new URL("../settings/settings.js", import.meta.url), "utf8");

  const records = serviceWorker.slice(
    serviceWorker.indexOf("async function buildAnalysisRecord("),
    serviceWorker.indexOf("function compactOrigin(")
  );
  assert.doesNotMatch(records, /\burl\b/);
  assert.match(records, /origin: compactOrigin\(origin\)/);
  // A job that died before checkOrigin ran still names its host.
  assert.match(serviceWorker, /origin: job\.origin \?\? webOriginOf\(job\.url\)/);
  assert.match(serviceWorker, /origin: compactOrigin\(job\.origin \?\? webOriginOf\(job\.url\)\)/);
  // parseOrigin keeps the hostname and protocol and drops the rest.
  assert.match(serviceWorker, /function webOriginOf\(url\) \{\n\s+const parsed = parseOrigin\(url\);/);

  // Stored records written before this are discarded on load; a v2 record
  // receives only the URL-field repair needed during the transition.
  assert.match(serviceWorker, /const history = sanitizeAnalysisHistory\(stored\)/);
  assert.match(serviceWorker, /record\.schema_version !== ANALYSIS_HISTORY_SCHEMA/);
  assert.match(serviceWorker, /const \{ url, \.\.\.withoutUrl \} = record/);
  assert.doesNotMatch(settingsPage, /record\.url/);
});

// A diagnostic record explains a verdict; it is not a transcript of the page.
// The matched, fuzzy and rejected token lists carry the OCR evidence, so the
// page's own text -- the largest and most sensitive thing the record could
// hold, and previously copied into every candidate -- is never persisted.
test("analysis history keeps the OCR evidence without transcribing the page", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const settingsPage = await readFile(new URL("../settings/settings.js", import.meta.url), "utf8");
  const pipeline = await readFile(
    new URL("../../src/detection/core/pipeline/runDetection.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(pipeline, /ocrText/);
  assert.doesNotMatch(serviceWorker, /page_text/);
  assert.doesNotMatch(settingsPage, /page_text/);
  assert.match(serviceWorker, /matched_tokens: ocr\.matchedTokens/);
  assert.match(serviceWorker, /rejected_ui_tokens: ocr\.rejectedUiTokens/);

  // Full diagnostics for the winner only; the rest are comparison-table rows.
  assert.match(serviceWorker, /winner: pipeline === null \? null : compactWinner\(pipeline\.winner\)/);
  assert.match(serviceWorker, /candidates: pipeline\?\.perTrusted\?\.slice\(1\)\.map\(/);
  assert.match(pipeline, /const winnerRow = perTrusted\[0\]/);
  assert.doesNotMatch(
    serviceWorker.slice(serviceWorker.indexOf("function compactCandidate(")),
    /query_ocr_text|normalized_score|matched_tokens/
  );
  assert.doesNotMatch(settingsPage, /Compared logo|Candidate references|Query stats|Timings \(ms\)|DINOv2|Rejected small/);
});

test("the pipeline reads trusted records defensively, keyed by variant rather than fqdn", async () => {
  const trustedSource = await readFile(
    new URL("../../src/detection/browser/chromeTrustedSource.ts", import.meta.url),
    "utf8"
  );
  const settingsPage = await readFile(new URL("../settings/settings.js", import.meta.url), "utf8");

  assert.match(trustedSource, /id: trustedVariantIdentity\(fqdn, variantId\)/);
  assert.match(trustedSource, /JSON\.stringify\(\[fqdn, variantId \?\? null\]\)/);
  assert.match(trustedSource, /seenIds\.has\(entry\.id\)/);
  assert.match(trustedSource, /logoFeatureArray\(stored\.logo_features\)/);
  assert.doesNotMatch(trustedSource, /id: entry\.fqdn/);

  // Settings stays a read-only consumer: it falls back on an unexpected shape
  // rather than repairing (or writing) anything.
  assert.match(settingsPage, /if \(key === "trusted_list" \|\| key === "muted_list"\) return asEntryList\(value\)/);
  assert.match(settingsPage, /renderList\("trusted-list", renderedState\.trusted_list, "trusted"\)/);
  assert.match(settingsPage, /renderList\("muted-list", renderedState\.muted_list, "muted"\)/);
  assert.doesNotMatch(settingsPage, /renderScores|score-tbody/);
  assert.doesNotMatch(settingsPage, /chrome\.runtime\.sendMessage\(\{ type: "repair/);
});

// =============================================================================
// Issue #7: a manual logo save reports where it landed, so the selector flow
// completes only when the intended variant actually holds the reference.
// =============================================================================

const manualLogo = Object.freeze({
  logo_image: "data:image/png;base64,AAAA",
  logo_regions: [{ source: "manual", x: 1, y: 2, width: 30, height: 20 }],
  logo_features: [{ index: 1, region: { source: "manual", x: 1, y: 2, width: 30, height: 20 } }],
  ocr_words: ["brand"],
  dinov2_embedding: [0.1, 0.2],
});

function manualSelectionInput(extra = {}) {
  return {
    fqdn: "site.example",
    targetVariantId: "variant-1",
    logo: manualLogo,
    timestamp: "2026-07-29T10:00:00.000Z",
    storageRevision: "revision-new",
    ...extra,
  };
}

function additionFor(fqdn, variantId) {
  return {
    origin: { fqdn, etld1: fqdn, protocol: "https", ocrDomain: fqdn.split(".")[0] },
    variantId,
    scores: [{ datetime: "2026-07-29T10:00:00.000Z", global_score: 0.4 }],
    lastVisited: "29/07/2026",
  };
}

test("manual logo: the targeted variant is updated and reported as saved", () => {
  const target = trustedVariant("site.example", "variant-1", { logo_source: "automatic" });
  const before = { ...target };
  const other = trustedVariant("other.example", "variant-9");
  const state = { trusted_list: [target, other], muted_list: [] };

  const result = applyManualLogoSelection(state, manualSelectionInput());

  assert.deepEqual(result, {
    status: "saved",
    variantId: "variant-1",
    changed: true,
    commit: {
      isNew: false,
      fqdn: "site.example",
      variantId: "variant-1",
      revision: "revision-new",
      before,
    },
  });
  assert.equal(target.logo_source, "manual");
  assert.equal(target.logo_image, manualLogo.logo_image);
  assert.deepEqual(target.ocr_words, ["brand"]);
  assert.deepEqual(target.dinov2_embedding, [0.1, 0.2]);
  assert.equal(target.updated_at, "2026-07-29T10:00:00.000Z");
  // The revision rotates so a concurrent compensation cannot revert this write.
  assert.equal(target.storage_revision, "revision-new");
  assert.deepEqual(other, trustedVariant("other.example", "variant-9"), "other entries are untouched");
});

test("manual logo: a variant deleted during processing is reported, not silently dropped", () => {
  const state = { trusted_list: [trustedVariant("site.example", "another-variant")], muted_list: [] };

  const result = applyManualLogoSelection(state, manualSelectionInput());

  assert.deepEqual(result, { status: "entry_missing", changed: false });
  assert.equal(state.trusted_list.length, 1);
  assert.equal(state.trusted_list[0].logo_source, undefined, "nothing was written");
});

test("manual logo: an emptied trusted list is reported as missing rather than saved", () => {
  const state = { trusted_list: [], muted_list: [] };

  const result = applyManualLogoSelection(state, manualSelectionInput());

  assert.deepEqual(result, { status: "entry_missing", changed: false });
});

test("manual logo: an add flow appends the variant and unmutes the fqdn", () => {
  const state = {
    trusted_list: [],
    muted_list: [{ fqdn: "site.example", muted_until: "forever" }, { fqdn: "keep.example" }],
  };

  const result = applyManualLogoSelection(state, manualSelectionInput({
    targetVariantId: undefined,
    addition: additionFor("site.example", "variant-new"),
  }));

  assert.deepEqual(result, {
    status: "saved",
    variantId: "variant-new",
    changed: true,
    commit: {
      isNew: true,
      fqdn: "site.example",
      variantId: "variant-new",
      revision: "revision-new",
      mutedBefore: { fqdn: "site.example", muted_until: "forever" },
      mutedIndex: 0,
    },
  });
  const [saved] = state.trusted_list;
  assert.equal(saved.variant_id, "variant-new");
  assert.equal(saved.logo_source, "manual");
  assert.equal(saved.ocr_domain, "site");
  assert.equal(saved.last_visited, "29/07/2026");
  assert.deepEqual(state.muted_list.map((entry) => entry.fqdn), ["keep.example"]);
});

test("manual logo: a move preserves muted metadata and strips mute-only state", () => {
  const muted = {
    fqdn: "site.example",
    etld1: "site.example",
    protocol: "https",
    source_url: "https://site.example/login",
    manual_entry: true,
    user_words: ["account", "secure"],
    muted_until: "forever",
    needs_reference_capture: true,
    custom_note: "keep me",
  };
  const state = {
    trusted_list: [],
    muted_list: [muted, { fqdn: "keep.example", muted_until: "forever" }],
  };
  const addition = { ...additionFor("site.example", "variant-new"), moveFromMuted: true };

  const result = applyManualLogoSelection(state, manualSelectionInput({
    targetVariantId: undefined,
    addition,
  }));

  assert.equal(result.status, "saved");
  assert.deepEqual(result.commit.mutedBefore, muted);
  assert.deepEqual(state.muted_list, [{ fqdn: "keep.example", muted_until: "forever" }]);
  assert.equal(state.trusted_list.length, 1);
  const [saved] = state.trusted_list;
  assert.equal(saved.manual_entry, true, "manual-entry provenance survives the move");
  assert.deepEqual(saved.user_words, ["account", "secure"]);
  assert.equal(saved.custom_note, "keep me");
  assert.equal(saved.logo_source, "manual");
  assert.equal(saved.logo_image, manualLogo.logo_image);
  assert.equal(saved.muted_until, undefined);
  assert.equal(saved.needs_reference_capture, undefined);
});

test("manual logo: a stale move cannot create trusted state after its muted source vanished", () => {
  const state = { trusted_list: [], muted_list: [] };
  const before = structuredClone(state);

  const result = applyManualLogoSelection(state, manualSelectionInput({
    targetVariantId: undefined,
    addition: { ...additionFor("site.example", "variant-new"), moveFromMuted: true },
  }));

  assert.deepEqual(result, { status: "entry_missing", changed: false });
  assert.deepEqual(state, before);
});

test("manual logo: a duplicate move cannot overwrite an existing trusted variant", () => {
  const existing = trustedVariant("site.example", "variant-existing", { logo_image: "original" });
  const state = {
    trusted_list: [existing],
    muted_list: [{ fqdn: "site.example", muted_until: "forever", manual_entry: true }],
  };
  const before = structuredClone(state);

  const result = applyManualLogoSelection(state, manualSelectionInput({
    targetVariantId: undefined,
    addition: { ...additionFor("site.example", "variant-new"), moveFromMuted: true },
  }));

  assert.deepEqual(result, { status: "entry_missing", changed: false });
  assert.deepEqual(state, before);
});

test("manual logo: an add flow refreshes an fqdn that is already trusted", () => {
  const existing = trustedVariant("site.example", "variant-1");
  const before = { ...existing };
  const state = { trusted_list: [existing], muted_list: [] };

  const result = applyManualLogoSelection(state, manualSelectionInput({
    targetVariantId: undefined,
    addition: additionFor("site.example", "variant-new"),
  }));

  assert.deepEqual(result, {
    status: "saved",
    variantId: "variant-1",
    changed: true,
    commit: {
      isNew: false,
      fqdn: "site.example",
      variantId: "variant-1",
      revision: "revision-new",
      before,
    },
  });
  assert.equal(state.trusted_list.length, 1, "the site is refreshed, not duplicated");
  assert.equal(existing.logo_source, "manual");
});

test("manual logo: refreshing an already-trusted fqdn still records the analysis snapshot", () => {
  // Issue #90 routes every explicit add through this path; the old inline
  // commit appended the score snapshot and bumped the visit date, and an add
  // that finds the site already trusted must keep doing both.
  const existing = trustedVariant("site.example", "variant-1");
  existing.scores = Array.from({ length: MAX_STORED_SCORES }, (_unused, index) => ({
    datetime: `2026-01-0${index + 1}T00:00:00.000Z`,
    global_score: index,
  }));
  const state = { trusted_list: [existing], muted_list: [] };
  const addition = additionFor("site.example", "variant-new");

  const result = applyManualLogoSelection(state, manualSelectionInput({
    targetVariantId: undefined,
    addition,
  }));

  assert.equal(result.status, "saved");
  assert.equal(existing.scores.length, MAX_STORED_SCORES, "older snapshots roll off at the cap");
  assert.deepEqual(existing.scores.at(-1), addition.scores[0]);
  assert.equal(existing.last_visited, addition.lastVisited);
});

test("manual logo: a variant-targeted selection never rewrites scores or visit date", () => {
  // The settings "modify logo" flow passes no addition; its refresh is the
  // reference only.
  const existing = trustedVariant("site.example", "variant-1");
  existing.scores = [{ datetime: "2026-01-01T00:00:00.000Z", global_score: 1 }];
  existing.last_visited = "01012026";
  const state = { trusted_list: [existing], muted_list: [] };

  const result = applyManualLogoSelection(state, manualSelectionInput());

  assert.equal(result.status, "saved");
  assert.deepEqual(existing.scores, [{ datetime: "2026-01-01T00:00:00.000Z", global_score: 1 }]);
  assert.equal(existing.last_visited, "01012026");
});

test("manual logo: an updated variant can be compensated from its commit metadata", () => {
  const original = trustedVariant("site.example", "variant-1", {
    logo_source: "automatic",
    logo_image: "old-image",
  });
  const state = {
    trusted_list: [original, trustedVariant("keep.example", "variant-2")],
    muted_list: [{ fqdn: "muted.example", muted_until: "forever" }],
  };
  const before = structuredClone(state);

  const result = applyManualLogoSelection(state, manualSelectionInput());
  const compensated = compensateTrustedMutedCommit(
    state.trusted_list,
    state.muted_list,
    result.commit
  );

  assert.equal(compensated.changed, true);
  assert.deepEqual(compensated.trustedEntries, before.trusted_list);
  assert.deepEqual(compensated.mutedEntries, before.muted_list);
});

test("manual logo: a new variant can be compensated and restores its prior mute", () => {
  const state = {
    trusted_list: [trustedVariant("keep.example", "variant-2")],
    muted_list: [
      { fqdn: "first.example", muted_until: "forever" },
      { fqdn: "site.example", muted_until: "next_login" },
      { fqdn: "last.example", muted_until: "forever" },
    ],
  };
  const before = structuredClone(state);

  const result = applyManualLogoSelection(state, manualSelectionInput({
    targetVariantId: undefined,
    addition: additionFor("site.example", "variant-new"),
  }));
  const compensated = compensateTrustedMutedCommit(
    state.trusted_list,
    state.muted_list,
    result.commit
  );

  assert.equal(compensated.changed, true);
  assert.deepEqual(compensated.trustedEntries, before.trusted_list);
  assert.deepEqual(compensated.mutedEntries, before.muted_list);
});

test("manual logo: a variant evicted by the per-fqdn cap is never reported as saved", () => {
  // Every slot is already held by a manual reference dated after this save, so
  // the cap ranks the appended variant last and drops it.
  const held = Array.from({ length: MAX_TRUSTED_VARIANTS_PER_FQDN }, (_unused, index) =>
    trustedVariant("site.example", `held-${index}`, {
      logo_source: "manual",
      updated_at: "2027-01-01T00:00:00.000Z",
    })
  );
  const state = { trusted_list: held, muted_list: [{ fqdn: "site.example" }] };

  const result = applyManualLogoSelection(state, manualSelectionInput({
    targetVariantId: "gone-variant",
    addition: additionFor("site.example", "variant-new"),
  }));

  assert.deepEqual(result, { status: "variant_capped", changed: false });
  assert.equal(state.trusted_list, held, "no partial write is left behind");
  assert.equal(state.muted_list.length, 1, "the mute is not lifted for a save that did not land");
});

test("manual logo: the selector flow only completes on a saved outcome", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");

  assert.match(serviceWorker, /if \(outcome\.status !== "saved"\) return \{ ok: false, code: outcome\.status \}/);
  // The overlay is answered with a code; the selector maps codes to its own
  // text, so background error strings never reach the page.
  assert.match(serviceWorker, /return \{ ok: false, code: "capture_failed" \}/);
  assert.match(serviceWorker, /return \{ ok: false, code: "preprocess_failed" \}/);
  assert.match(serviceWorker, /return \{ ok: false, code: "save_failed" \}/);
  assert.match(serviceWorker, /logo_selector_prepare_capture/);
  assert.match(serviceWorker, /logo_selector_capture_complete/);
  assert.match(serviceWorker, /async function injectLogoSelector[\s\S]*?await cancelLogoSelectorSession\(tabId, session\.sessionId\)/);
  assert.doesNotMatch(serviceWorker, /cancelLogoSelectorSession\(updatedTabId\)/);
  assert.doesNotMatch(serviceWorker, /logo_selector_error|sendErrorToSelector/);
});

test("moving a muted site to trusted launches the interactive confirmation, not a silent capture", async () => {
  // Issue #8: move-muted-to-trusted no longer writes the lists or defers an
  // unvalidated logo capture to a later visit. It opens the site in a new tab
  // and records that the tab is a confirmation flow; the entry stays muted
  // until the user confirms a logo there.
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const moveCase = serviceWorker.slice(
    serviceWorker.indexOf('case "move_muted_to_trusted"'),
    serviceWorker.indexOf('case "add_manual_site"')
  );

  assert.doesNotMatch(moveCase, /needs_reference_capture/, "no deferred silent capture");
  assert.doesNotMatch(moveCase, /state\.trusted_list =/, "no eager trusted write");
  assert.doesNotMatch(moveCase, /state\.muted_list =/, "the entry stays muted until confirmation");

  // Opens a blank tab, persists its intent, and only then navigates it. This
  // ordering prevents a fast cached/file page from asking before it is armed.
  assert.match(moveCase, /chrome\.tabs\.create\(\{ url: "about:blank", active: true \}\)/);
  assert.match(moveCase, /entry\.protocol === "file" && isFileUrl\(entry\.source_url\)/);
  assert.match(moveCase, /trustedAddIntents\.set\(newTab\.id, \{ fqdn, settingsTabId: tabId \}\)/);
  assert.match(moveCase, /chrome\.tabs\.update\(newTab\.id, \{ url \}\)/);
  assert.ok(
    moveCase.indexOf("trustedAddIntents.set(newTab.id") < moveCase.indexOf("chrome.tabs.update(newTab.id"),
    "the durable intent must be written before destination navigation"
  );
  assert.match(moveCase, /trustedAddIntents\.discardTab\(newTab\.id\)/, "failed startup clears the intent");
  assert.match(moveCase, /chrome\.tabs\.remove\(newTab\.id\)/, "failed startup closes the unusable tab");

  // The add-to-trusted flow the tab then runs reads that intent, scoped to the
  // tab's current fqdn, and for a move closes the tab and refocuses Settings.
  const addCase = serviceWorker.slice(
    serviceWorker.indexOf('case "add_to_trusted"'),
    serviceWorker.indexOf('case "get_trusted_add_intent"')
  );
  assert.match(addCase, /trustedAddIntents\.get\(tabId\)/);
  assert.match(addCase, /moveIntent !== null && moveIntent\.fqdn === parsedOrigin\.fqdn/);
  assert.match(addCase, /closeTabOnComplete: isMoveToTrusted/);
  assert.match(addCase, /settingsTabId: moveIntent\.settingsTabId/);
  assert.match(addCase, /moveFromMuted: true/, "the atomic commit knows this is a real move");
  assert.ok(
    addCase.indexOf("abortTrustedAddIntent(tabId)") < addCase.indexOf("if (!settled) throw error"),
    "capture and detection failures must abort before they are rethrown"
  );

  const navigationErrorHandler = serviceWorker.slice(
    serviceWorker.indexOf("chrome.webNavigation.onErrorOccurred.addListener"),
    serviceWorker.indexOf("async function prepareSameTabDeviceFlowSource")
  );
  assert.match(navigationErrorHandler, /if \(details\.frameId !== 0\) return/);
  assert.match(navigationErrorHandler, /abortTrustedAddIntent\(details\.tabId\)/);
});

test("a forced initial reference capture bypasses the drift threshold", async () => {
  // The needs_reference_capture marker now originates only from the manual
  // Advanced Settings add (issue #93), which has no screenshot at add time.
  // refreshTrustedEntry still honours it: it captures once on the next visit
  // regardless of drift, and never clears the marker without a usable logo.
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const storageQueues = await readFile(new URL("./storageQueues.mjs", import.meta.url), "utf8");
  const refresh = serviceWorker.slice(
    serviceWorker.indexOf("async function refreshTrustedEntry"),
    serviceWorker.indexOf("async function checkSelectorSession")
  );

  assert.match(storageQueues, /needs_reference_capture: true/);
  assert.ok(
    refresh.indexOf("entry.needs_reference_capture === true") < refresh.indexOf("if (!drifted)"),
    "the marker must bypass the normal drift threshold"
  );
  assert.match(refresh, /pending\?\.needs_reference_capture !== true/);
  assert.match(refresh, /Object\.assign\(pending, referenceFields/);
  assert.match(refresh, /delete pending\.needs_reference_capture/);
  assert.match(refresh, /isInitiatingDocumentCurrent\(tabId, job\.documentId\)/);
  assert.match(refresh, /await compensateTrustedCommit\(commit\)/);

  const noLogo = refresh.indexOf("no usable logo was found");
  const markerClear = refresh.indexOf("delete pending.needs_reference_capture");
  assert.ok(noLogo !== -1 && noLogo < markerClear, "an unusable capture must return without clearing the marker");
});

// A navigation invalidates the leaving page's icon state. That has to happen
// at the navigation, not after the storage round trips in the same handler:
// held that long it can land after the arriving page has already asserted its
// own badge and wipe it. The device-code advisory is the one that always lost
// that race, because content.js asserts it as soon as the page loads.
test("a navigation invalidates the icon before anything in the handler is awaited", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const updatedCase = serviceWorker.slice(
    serviceWorker.indexOf("chrome.tabs.onUpdated.addListener"),
    serviceWorker.indexOf("chrome.tabs.onActivated.addListener")
  );

  const invalidate = updatedCase.indexOf("invalidateActionFeedback(updatedTabId)");
  const firstAwait = updatedCase.indexOf("await ");
  assert.ok(invalidate !== -1 && firstAwait !== -1);
  assert.ok(invalidate < firstAwait, "the icon must be invalidated before the first await");
});

// Issue #82 -- a setting that weakens protection must not survive out of sight
// once its control is hidden again, so turning Advanced Settings off returns
// every dev-gated choice to its secure default in the same write.
test("turning developer mode off resets every dev-gated setting", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const developerModeCase = serviceWorker.slice(
    serviceWorker.indexOf('case "set_developer_mode"'),
    serviceWorker.indexOf('case "set_device_code_auth"')
  );

  assert.match(developerModeCase, /state\.device_code_auth = "blocked"/);
  assert.match(developerModeCase, /state\.clickfix = \{ \.\.\.state\.clickfix, mode: "strict" \}/);

  // Each reset must also be a reason to persist, or a page that reopens later
  // reads back the weakened value.
  assert.match(developerModeCase, /state\.device_code_auth !== "blocked"/);
  assert.match(developerModeCase, /state\.clickfix\.mode !== "strict"/);

  // The domains and endpoints those modes reference are kept -- only an
  // explicit reset discards them.
  assert.doesNotMatch(developerModeCase, /excluded_domains|device_flow_user_endpoints/);
});

// Issue #93 -- the phishing-warning bypass is gone. Neither the setting, the
// one-time per-tab authorization, nor either interstitial's proceed handler
// may survive anywhere in the worker; a stored allow_phishing_bypass value is
// migrated out on the first settings read.
test("the service worker carries no phishing or device-code bypass path", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");

  assert.doesNotMatch(serviceWorker, /set_phishing_bypass|phishing_proceed|device_flow_continue/);
  assert.doesNotMatch(serviceWorker, /\.bypass_by_tab|bypassAuthorized|allow_bypass|acknowledgeRelationship/);
  assert.doesNotMatch(serviceWorker, /phishing_bypassed/);
  assert.match(serviceWorker, /delete settings\.allow_phishing_bypass/);
  assert.match(serviceWorker, /Object\.hasOwn\(raw, "allow_phishing_bypass"\)/);
});

// Issue #93 §8 -- trusted/muted status affects only the phishing pipeline.
// Device-code protection is decided before either list is consulted (for
// muted and trusted sites alike), and ClickFix never reads the lists at all.
test("device-code and ClickFix protections run independently of trusted/muted status", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const runPipeline = serviceWorker.slice(
    serviceWorker.indexOf('case "run_pipeline"'),
    serviceWorker.indexOf('case "analysis_client_timed_out"')
  );

  const deviceFlowCheck = runPipeline.indexOf("evaluateDeviceFlow(tabId, currentUrl)");
  const mutedCheck = runPipeline.indexOf("origin.in_muted_list");
  const trustedCheck = runPipeline.indexOf("origin.in_trusted_list");
  assert.ok(deviceFlowCheck !== -1 && mutedCheck !== -1 && trustedCheck !== -1);
  assert.ok(deviceFlowCheck < mutedCheck, "a muted hostname must not suppress a device-code warning");
  assert.ok(deviceFlowCheck < trustedCheck, "a trusted hostname must not suppress a device-code warning");

  const clickfixPolicy = await readFile(new URL("../content/clickfix-policy.js", import.meta.url), "utf8");
  assert.doesNotMatch(clickfixPolicy, /trusted_list|muted_list/);
  const clipboardCase = serviceWorker.slice(
    serviceWorker.indexOf('case "clickfix_clipboard_request"'),
    serviceWorker.indexOf('case "open_clickfix_settings"')
  );
  assert.doesNotMatch(clipboardCase, /trusted_list|muted_list|in_trusted_list|in_muted_list/);
});

// Issue #93 -- "Reset to default settings" also removes the trusted/muted
// entries created through the Advanced Settings controls, through the same
// serialized trusted+muted queue as every other list mutation.
test("reset to defaults removes manual entries through the trusted/muted queue", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const resetCase = serviceWorker.slice(
    serviceWorker.indexOf('case "reset_advanced_settings"'),
    serviceWorker.indexOf('case "set_banner_font_size"')
  );

  assert.match(resetCase, /withTrustedMuted/);
  assert.match(resetCase, /removeAllManualSiteEntries\(state\)/);
});

test("a manual logo selection clears a moved entry's capture marker", () => {
  const entry = trustedVariant("site.example", "variant-1", { needs_reference_capture: true });
  const state = { trusted_list: [entry], muted_list: [] };

  const result = applyManualLogoSelection(state, manualSelectionInput());

  assert.equal(result.status, "saved");
  assert.equal("needs_reference_capture" in entry, false);
});

test("ordinary origins require an HTTP(S) URL with a hostname", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const parseOrigin = serviceWorker.slice(
    serviceWorker.indexOf("function parseOrigin("),
    serviceWorker.indexOf("function isFileUrl(")
  );

  assert.match(parseOrigin, /parsedUrl\.protocol !== "http:" && parsedUrl\.protocol !== "https:"\) return null/);
  assert.match(parseOrigin, /if \(hostname === ""\) return null/);
  assert.match(serviceWorker, /const currentUrl = senderUrl;/);
  assert.doesNotMatch(serviceWorker, /message\.url/);
});

test("permitted file pages use list storage but remain origin mismatches", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const contentScript = await readFile(new URL("../content/content.js", import.meta.url), "utf8");

  const filePermissionHelper = serviceWorker.slice(
    serviceWorker.indexOf("async function isFileScanPermitted("),
    serviceWorker.indexOf("// File references use a stable storage key")
  );
  assert.doesNotMatch(filePermissionHelper, /developer_mode|isDeveloperModeEnabled/);
  assert.match(serviceWorker, /chrome\.extension\.isAllowedFileSchemeAccess\(\)/);
  assert.match(serviceWorker, /const fqdn = `file-\$\{digest\.slice\(0, 24\)\}\.local`/);
  assert.match(serviceWorker, /origin_mismatch: fileOrigin !== null \|\|/);
  assert.match(serviceWorker, /const parsedOrigin = await parseListOrigin\(currentUrl\)/);
  assert.match(serviceWorker, /const origin = await parseListOrigin\(senderUrl\)/);
  assert.match(serviceWorker, /origin\.protocol === "https"/);
  assert.doesNotMatch(serviceWorker, /fileScan && verdict === "phishing"/);
  assert.doesNotMatch(contentScript, /url: window\.location\.href/);
});

// =============================================================================
// MANUAL SITE MANAGEMENT (issue #93) — Advanced Settings adds exact hostnames
// straight onto the shared trusted/muted records, with provenance for reset.
// =============================================================================

function manualMutationInput(extra = {}) {
  return {
    listType: "trusted",
    origin: { fqdn: "login.example.com", etld1: "example.com", ocrDomain: "example" },
    timestamp: "2026-08-08T10:00:00.000Z",
    newId: createIdFactory(),
    ...extra,
  };
}

function mutedEntry(fqdn, extra = {}) {
  return { fqdn, etld1: fqdn, protocol: "https", muted_until: "forever", user_words: [], scores: [], ...extra };
}

test("manual add: a trusted hostname lands with provenance and a pending reference", () => {
  const state = { trusted_list: [], muted_list: [] };

  const result = applyManualSiteMutation(state, manualMutationInput());

  assert.deepEqual(result, { status: "saved", changed: true });
  assert.equal(state.trusted_list.length, 1);
  const entry = state.trusted_list[0];
  assert.equal(entry.fqdn, "login.example.com");
  assert.equal(entry.etld1, "example.com");
  assert.equal(entry.protocol, "https");
  assert.equal(entry.manual_entry, true);
  assert.equal(entry.needs_reference_capture, true, "no screenshot is owed at add time — the next visit captures it");
  assert.equal("logo_image" in entry, false);
  assert.deepEqual(entry.scores, []);
  assert.equal("last_visited" in entry, false, "a Settings action is not a site visit");
});

test("manual add: a muted hostname lands muted forever with provenance", () => {
  const state = { trusted_list: [], muted_list: [] };

  const result = applyManualSiteMutation(state, manualMutationInput({ listType: "muted" }));

  assert.deepEqual(result, { status: "saved", changed: true });
  const entry = state.muted_list[0];
  assert.equal(entry.fqdn, "login.example.com");
  assert.equal(entry.muted_until, "forever");
  assert.equal(entry.manual_entry, true);
  assert.equal("last_visited" in entry, false, "a Settings action is not a site visit");
});

test("manual add: duplicates are rejected without touching the lists or their provenance", () => {
  const state = { trusted_list: [trustedVariant("login.example.com", "variant-1")], muted_list: [] };

  const result = applyManualSiteMutation(state, manualMutationInput());

  assert.deepEqual(result, { status: "already_trusted", changed: false });
  assert.equal("manual_entry" in state.trusted_list[0], false, "an in-page entry must not become manually added");

  const mutedState = { trusted_list: [], muted_list: [mutedEntry("login.example.com")] };
  const mutedResult = applyManualSiteMutation(mutedState, manualMutationInput({ listType: "muted" }));
  assert.deepEqual(mutedResult, { status: "already_muted", changed: false });
  assert.equal("manual_entry" in mutedState.muted_list[0], false);
});

test("manual add: a muted hostname moves to trusted keeping its own provenance", () => {
  const state = {
    trusted_list: [],
    muted_list: [mutedEntry("login.example.com", {
      user_words: ["word"], manual_entry: true, last_visited: "03032026",
    })],
  };

  const result = applyManualSiteMutation(state, manualMutationInput());

  assert.equal(result.status, "saved");
  assert.deepEqual(state.muted_list, []);
  const entry = state.trusted_list[0];
  assert.equal(entry.manual_entry, true);
  assert.equal(entry.needs_reference_capture, true);
  assert.deepEqual(entry.user_words, ["word"], "a move keeps the record's words like the Muted tab's move");
  assert.equal(entry.last_visited, "03032026", "a real visit date survives the move");
});

test("manual add: moving an in-page record never marks it as manually added", () => {
  const state = { trusted_list: [], muted_list: [mutedEntry("login.example.com")] };

  const result = applyManualSiteMutation(state, manualMutationInput());

  assert.equal(result.status, "saved");
  assert.equal("manual_entry" in state.trusted_list[0], false, "reset must keep what in-page flows created");

  const reverse = {
    trusted_list: [trustedVariant("other.example.com", "variant-1")],
    muted_list: [],
  };
  const reverseResult = applyManualSiteMutation(reverse, manualMutationInput({
    listType: "muted",
    origin: { fqdn: "other.example.com", etld1: "example.com", ocrDomain: "example" },
  }));
  assert.equal(reverseResult.status, "saved");
  assert.equal("manual_entry" in reverse.muted_list[0], false);
});

test("manual add: muting removes every trusted variant atomically", () => {
  const state = {
    trusted_list: [
      trustedVariant("login.example.com", "variant-1", { manual_entry: true, last_visited: "02022026" }),
      trustedVariant("login.example.com", "variant-2", { manual_entry: true }),
      trustedVariant("other.example", "variant-3"),
    ],
    muted_list: [],
  };

  const result = applyManualSiteMutation(state, manualMutationInput({ listType: "muted" }));

  assert.equal(result.status, "saved");
  assert.deepEqual(state.trusted_list.map((entry) => entry.fqdn), ["other.example"]);
  assert.equal(state.muted_list[0].muted_until, "forever");
  assert.equal(state.muted_list[0].manual_entry, true);
  assert.equal(state.muted_list[0].last_visited, "02022026", "a real visit date survives the move");
});

test("manual edit: an atomic replacement that reuses nothing from the old hostname", () => {
  const state = {
    trusted_list: [trustedVariant("old.example", "variant-1", {
      manual_entry: true,
      logo_image: "data:image/png;base64,OLD",
      ocr_words: ["old"],
      dinov2_embedding: [0.1],
      scores: [{ global_score: 2 }],
      user_words: ["word"],
    })],
    muted_list: [],
  };

  const result = applyManualSiteMutation(state, manualMutationInput({ previousFqdn: "old.example" }));

  assert.equal(result.status, "saved");
  assert.equal(state.trusted_list.length, 1);
  const entry = state.trusted_list[0];
  assert.equal(entry.fqdn, "login.example.com");
  assert.equal(entry.manual_entry, true, "provenance survives the edit");
  assert.equal(entry.needs_reference_capture, true, "the new hostname owes a fresh reference");
  for (const field of ["logo_image", "ocr_words", "dinov2_embedding"]) {
    assert.equal(field in entry, false, `${field} must not be carried over from the previous hostname`);
  }
  assert.deepEqual(entry.scores, []);
  assert.deepEqual(entry.user_words, []);
  assert.equal("last_visited" in entry, false, "editing to a new hostname must not invent a visit");
});

test("manual edit: a hostname already in the same list is rejected, including itself", () => {
  const state = {
    trusted_list: [
      trustedVariant("old.example", "variant-1", { manual_entry: true }),
      trustedVariant("login.example.com", "variant-2"),
    ],
    muted_list: [],
  };

  const conflicting = applyManualSiteMutation(state, manualMutationInput({ previousFqdn: "old.example" }));
  assert.deepEqual(conflicting, { status: "already_trusted", changed: false });
  assert.equal(state.trusted_list.length, 2, "a rejected edit must not remove the old entry");

  const toItself = applyManualSiteMutation(state, manualMutationInput({
    previousFqdn: "old.example",
    origin: { fqdn: "old.example", etld1: "old.example", ocrDomain: "old" },
  }));
  assert.deepEqual(toItself, { status: "already_trusted", changed: false });
});

test("manual edit: only an entry with manual provenance can be edited", () => {
  const state = { trusted_list: [trustedVariant("old.example", "variant-1")], muted_list: [] };

  const result = applyManualSiteMutation(state, manualMutationInput({ previousFqdn: "old.example" }));

  assert.deepEqual(result, { status: "not_found", changed: false });
  assert.equal(state.trusted_list.length, 1);
});

test("manual edit: a new hostname in the opposite list follows the atomic move rules", () => {
  const state = {
    trusted_list: [trustedVariant("old.example", "variant-1", { manual_entry: true })],
    muted_list: [mutedEntry("login.example.com")],
  };

  const result = applyManualSiteMutation(state, manualMutationInput({ previousFqdn: "old.example" }));

  assert.equal(result.status, "saved");
  assert.deepEqual(state.muted_list, []);
  assert.equal(state.trusted_list.length, 1);
  assert.equal(state.trusted_list[0].fqdn, "login.example.com");
  assert.equal("manual_entry" in state.trusted_list[0], false, "the existing destination keeps its in-page provenance");
  removeAllManualSiteEntries(state);
  assert.equal(state.trusted_list[0].fqdn, "login.example.com", "Reset must keep the original in-page entry");
});

test("manual capacity: bounded per list, counting manual hostnames only", () => {
  const state = {
    trusted_list: [
      trustedVariant("a.example", "variant-a", { manual_entry: true }),
      trustedVariant("b.example", "variant-b", { manual_entry: true }),
      trustedVariant("inpage.example", "variant-c"),
    ],
    muted_list: [],
  };

  const rejected = applyManualSiteMutation(state, manualMutationInput({ maxManualSites: 2 }));
  assert.deepEqual(rejected, { status: "too_many_sites", changed: false });

  // An edit replaces one manual hostname with another, so it fits the cap.
  const edited = applyManualSiteMutation(state, manualMutationInput({
    previousFqdn: "a.example",
    maxManualSites: 2,
  }));
  assert.equal(edited.status, "saved");
});

test("manual removal drops every variant of a manual hostname and nothing else", () => {
  const state = {
    trusted_list: [
      trustedVariant("site.example", "variant-1", { manual_entry: true }),
      trustedVariant("site.example", "variant-2"),
      trustedVariant("inpage.example", "variant-3"),
    ],
    muted_list: [mutedEntry("inpagemute.example")],
  };

  assert.equal(removeManualSiteEntries(state, "trusted", "site.example"), true);
  assert.deepEqual(state.trusted_list.map((entry) => entry.fqdn), ["inpage.example"]);
  assert.equal(removeManualSiteEntries(state, "trusted", "inpage.example"), false, "in-page records stay untouchable");
  assert.equal(removeManualSiteEntries(state, "muted", "inpagemute.example"), false);
  assert.equal(state.muted_list.length, 1);
});

test("reset removal drops manual entries with every variant they accumulated", () => {
  const state = {
    trusted_list: [
      trustedVariant("manual.example", "variant-1", { manual_entry: true }),
      trustedVariant("manual.example", "variant-2"),
      trustedVariant("inpage.example", "variant-3"),
    ],
    muted_list: [
      mutedEntry("manualmute.example", { manual_entry: true }),
      mutedEntry("inpagemute.example"),
    ],
  };

  assert.equal(removeAllManualSiteEntries(state), true);
  assert.deepEqual(state.trusted_list.map((entry) => entry.fqdn), ["inpage.example"]);
  assert.deepEqual(state.muted_list.map((entry) => entry.fqdn), ["inpagemute.example"]);
  assert.equal(removeAllManualSiteEntries(state), false, "a second pass reports no change");
});

test("repair keeps manual provenance on stored entries", () => {
  const trusted = [trustedVariant("site.example", "variant-1", { manual_entry: true })];
  const muted = [mutedEntry("muted.example", { manual_entry: true })];

  const result = repairTrustedMutedLists({ trusted_list: trusted, muted_list: muted }, { newId: createIdFactory() });

  assert.equal(result.changed, false, "provenance alone must never trigger a repair rewrite");
  assert.equal(result.trusted_list[0].manual_entry, true);
  assert.equal(result.muted_list[0].manual_entry, true);
});

test("a manual file reference keeps its source URL", () => {
  const fqdn = "file-0123456789abcdef01234567.local";
  const addition = additionFor(fqdn, "variant-file");
  addition.origin.protocol = "file";
  addition.origin.ocrDomain = "";
  addition.origin.sourceUrl = "file:///home/user/login.html";
  const state = { trusted_list: [], muted_list: [] };

  const result = applyManualLogoSelection(state, manualSelectionInput({
    fqdn,
    targetVariantId: undefined,
    addition,
  }));

  assert.equal(result.status, "saved");
  assert.equal(state.trusted_list[0].source_url, addition.origin.sourceUrl);
});

// =============================================================================
// Issue #88 — frame ownership and state-aware navigation interruption.
//
// This logic lives in the service worker's own event listeners and message
// handler, which cannot be loaded under plain Node (chrome.* at module scope,
// TypeScript imports). It is pinned here the same way the rest of the worker's
// invariants are: against the source itself.
// =============================================================================

test("only the top document can own an analysis job", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");

  assert.match(
    serviceWorker,
    /function isTopFrameSender\(sender\) \{\s*return sender\?\.id === chrome\.runtime\.id && sender\.frameId === 0;/
  );
  for (const messageType of ["run_pipeline", "add_to_trusted"]) {
    const caseStart = serviceWorker.indexOf(`case "${messageType}": {`);
    const guard = serviceWorker.indexOf("if (!isTopFrameSender(sender)) return;", caseStart);
    const jobStart = serviceWorker.indexOf("startJob(", caseStart);
    assert.ok(caseStart >= 0 && guard > caseStart, `${messageType} must reject non-top-frame senders`);
    assert.ok(jobStart > guard, `${messageType} must reject them before any job exists`);
  }
});

test("a run_pipeline job is anchored to the authoritative top frame, not the sender snapshot", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const caseStart = serviceWorker.indexOf('case "run_pipeline": {');
  const caseEnd = serviceWorker.indexOf('case "child_frame_login_detected": {', caseStart);
  const resolved = serviceWorker.indexOf("const topFrame = await resolveTopFrame(tabId, sender.documentId);", caseStart);
  const documentGuard = serviceWorker.indexOf("topFrame?.documentId !== sender.documentId", resolved);
  const lifecycleGuard = serviceWorker.indexOf('topFrame?.documentLifecycle !== "active"', resolved);
  const jobStart = serviceWorker.indexOf("const job = startJob(", documentGuard);

  assert.ok(resolved > caseStart, "the current top frame is resolved before the job is created");
  assert.ok(documentGuard > resolved, "a request from an already replaced document is rejected");
  assert.ok(lifecycleGuard > documentGuard, "a non-active top document is rejected");
  assert.ok(jobStart > documentGuard);
  assert.match(
    serviceWorker.slice(jobStart, jobStart + 260),
    /currentUrl,\s*"detection",\s*topFrame\.documentId/,
    "the job stores the resolved frame's URL and documentId"
  );
  assert.match(
    serviceWorker.slice(caseStart, jobStart),
    /return \{ error: true, code: "analysis_failed" \};/,
    "an unresolvable or stale sender receives a terminal response"
  );
  assert.doesNotMatch(
    serviceWorker.slice(caseStart, caseEnd),
    /topFrame\?\.url \?\? senderUrl|topFrame\?\.documentId \?\? sender\?\.documentId/,
    "sender snapshots are never accepted as an authoritative fallback"
  );
});

// The SPA race: the login form and the route change happen in one task, so
// run_pipeline can be accepted either before or after the browser's own
// notifications about that route arrive. Both orderings resolve the same way
// because the decision is a comparison of stored state, not of arrival order.
test("navigation notifications describing the active job's own state never interrupt it", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");

  // The state matrix itself is behavior-tested in navigationState.test.mjs;
  // this keeps only the worker-to-module wiring pinned here.
  assert.match(
    serviceWorker,
    /import \{[\s\S]*?cancellationPresentation,[\s\S]*?jobMatchesAddress,[\s\S]*?jobMatchesSameDocumentState,[\s\S]*?\} from "\.\/navigationState\.mjs";/
  );
  assert.match(
    serviceWorker,
    /function isActiveJobAddress\(tabId, url\) \{\s*return jobMatchesAddress\(activeJobFor\(tabId\), url\);\s*\}/
  );
  assert.match(
    serviceWorker,
    /function isActiveJobSameDocumentState\(details\) \{\s*return jobMatchesSameDocumentState\(activeJobFor\(details\.tabId\), details\);\s*\}/
  );

  // tabs.onUpdated: the capture guard and the cancellation both stand down on
  // an address that is already the job's own.
  const tabsUpdated = serviceWorker.indexOf("chrome.tabs.onUpdated.addListener");
  const tabsCaptureGuard = serviceWorker.indexOf(
    "if (!isActiveJobAddress(updatedTabId, changeInfo.url)) {\n      captureTracker.interruptTab(updatedTabId);",
    tabsUpdated
  );
  assert.ok(tabsCaptureGuard > tabsUpdated);
  assert.match(
    serviceWorker,
    /function interruptForNavigation\(tabId, url\) \{[\s\S]*?if \(job\.url === url\) return;[\s\S]*?cancelJobForNavigation\(tabId, job, "address_changed", url\);/
  );

  // History API / fragment events additionally require the same document.
  const sameDocumentEvents = serviceWorker.indexOf(
    "for (const event of [chrome.webNavigation.onHistoryStateUpdated, chrome.webNavigation.onReferenceFragmentUpdated])"
  );
  const historyGuard = serviceWorker.indexOf("if (!isActiveJobSameDocumentState(details)) {", sameDocumentEvents);
  const historyCapture = serviceWorker.indexOf("captureTracker.interruptTab(details.tabId);", historyGuard);
  const historyCancel = serviceWorker.indexOf("interruptForSameDocumentNavigation(details);", historyCapture);
  const historyForward = serviceWorker.indexOf("handleDeviceFlowHistoryChange(details.tabId, details.url)", historyCancel);
  assert.ok(historyGuard > sameDocumentEvents);
  assert.ok(historyCapture > historyGuard && historyCancel > historyCapture);
  assert.ok(
    historyForward > historyCancel,
    "page_history_changed is forwarded whether or not the event was already represented"
  );
  assert.match(
    serviceWorker,
    /function interruptForSameDocumentNavigation\(details\) \{[\s\S]*?if \(isActiveJobSameDocumentState\(details\)\) return;\s*cancelJobForNavigation\(details\.tabId, job, "address_changed", details\.url\);/
  );

  // onCommitted stays the authoritative guard for a replacement document at
  // the same address: it interrupts unconditionally and invalidates on the
  // documentId alone.
  const committed = serviceWorker.indexOf("chrome.webNavigation.onCommitted.addListener");
  const committedCapture = serviceWorker.indexOf("captureTracker.interruptTab(details.tabId);", committed);
  const committedInvalidate = serviceWorker.indexOf("interruptForCommittedDocument(details);", committedCapture);
  assert.ok(committedCapture > committed && committedInvalidate > committedCapture);
  assert.match(
    serviceWorker,
    /function interruptForCommittedDocument\(details\) \{[\s\S]*?if \(job\.documentId !== details\.documentId\) \{\s*cancelJobForNavigation\(details\.tabId, job, "address_changed", details\.url\);/
  );
});

// Issue #2: an ordinary top-level navigation or document replacement cancels
// the in-flight job silently -- no interrupted banner, no interruption tab --
// while a surviving same-document script gets a scoped non-warning reset. The
// presentation matrix and content lifecycle are behavior-tested in
// navigationState.test.mjs and content.test.js; this test pins worker wiring.
test("the worker routes navigation cancellation and late verdict delivery through the silent policy", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");

  // The navigation helper opts into both parts of the silent contract.
  assert.match(
    serviceWorker,
    /function cancelJobForNavigation\(tabId, job, reasonHint, reanalyseUrl\) \{\s*return cancelJob\(tabId, job, reasonHint, \{\s*interruptionMode: "silent",\s*resetContent: true,\s*reanalyseUrl,/
  );

  // Content reset and warning/interstitial delivery are mutually exclusive.
  assert.match(
    serviceWorker,
    /if \(presentation\.resetContent\) \{[\s\S]*?type: "analysis_cancelled_silently",[\s\S]*?if \(presentation\.notifyInterrupted\) \{[\s\S]*?type: "analysis_interrupted",/
  );

  // Every commit-time invalidation goes through the same helper.
  const validate = serviceWorker.indexOf("async function validateJobForCommit");
  const validateEnd = serviceWorker.indexOf("\nfunction finishJob", validate);
  const validateBody = serviceWorker.slice(validate, validateEnd);
  assert.equal(validateBody.match(/cancelJobForNavigation\(/g)?.length, 3);

  // Final delivery is document-scoped, and a rejected delivery cannot promote
  // the cancellation to a warning in the validation-to-send race window.
  assert.match(
    serviceWorker,
    /async function sendValidatedBanner[\s\S]*?sendJobDocumentMessage\(tabId, job,[\s\S]*?response\?\.accepted !== true[\s\S]*?interruptionMode: "silent",\s*resetContent: true,/
  );
  assert.match(
    serviceWorker,
    /if \(commit === "document_replaced"\) \{[\s\S]*?cancelJobForNavigation\(tabId, job, "document_replaced", job\.url\);/
  );
});

test("a child-frame login report is validated and forwarded to the top document alone", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const caseStart = serviceWorker.indexOf('case "child_frame_login_detected": {');
  const caseEnd = serviceWorker.indexOf('case "analysis_client_timed_out": {', caseStart);
  assert.ok(caseStart >= 0 && caseEnd > caseStart);
  const handler = serviceWorker.slice(caseStart, caseEnd);

  assert.match(handler, /if \(sender\?\.id !== chrome\.runtime\.id\) return;/);
  assert.match(handler, /if \(!Number\.isInteger\(tabId\)\) return;/);
  assert.match(handler, /if \(!Number\.isInteger\(sender\.frameId\) \|\| sender\.frameId <= 0\) return;/);
  assert.match(handler, /typeof sender\.documentId !== "string" \|\| sender\.documentId === ""/);
  assert.match(handler, /if \(sender\.documentLifecycle !== "active"\) return;/);
  assert.match(
    handler,
    /chrome\.webNavigation\.getFrame\(\{\s*tabId,\s*frameId: sender\.frameId,\s*documentId: sender\.documentId,\s*\}\)\.catch\(\(\) => null\)/,
    "the exact reporting document must still resolve"
  );
  assert.match(
    handler,
    /if \(senderFrame\?\.documentId !== sender\.documentId \|\|\s*senderFrame\?\.documentLifecycle !== "active"\) return;/,
    "unresolvable, replaced and non-active child documents are rejected"
  );
  assert.match(handler, /topFrame\?\.documentLifecycle !== "active"\) return;/);
  assert.match(
    handler,
    /chrome\.tabs\.sendMessage\(\s*tabId,\s*\{ type: "embedded_login_detected" \},\s*\{ documentId: topDocumentId \}/,
    "the report is delivered to the current top document, never broadcast to every frame"
  );
  assert.doesNotMatch(handler, /startJob|activeJobs|show_banner/, "a child frame can never own pipeline state");

  // The watcher must reach sandboxed srcdoc, about:blank and replacement
  // documents, which is exactly what these two flags buy.
  const frameWatcher = manifest.content_scripts.find((entry) => entry.js.includes("content/login-frame.js"));
  assert.ok(frameWatcher, "the child-frame watcher must be declared");
  assert.deepEqual(frameWatcher.js, ["content/login-detector.js", "content/login-frame.js"]);
  assert.equal(frameWatcher.all_frames, true);
  assert.equal(frameWatcher.match_about_blank, undefined);
  assert.equal(frameWatcher.match_origin_as_fallback, true);
  assert.equal(frameWatcher.run_at, "document_idle");
  assert.equal(frameWatcher.css, undefined, "no banner styling belongs in a child frame");
  assert.ok(
    manifest.content_scripts.every((entry) => entry.match_about_blank === undefined),
    "match_origin_as_fallback supersedes match_about_blank"
  );

  // The top-document entry stays top-only: the full lifecycle is never run in
  // every frame.
  const topDocument = manifest.content_scripts.find((entry) => entry.js.includes("content/content.js"));
  assert.equal(topDocument.all_frames, undefined);
});
