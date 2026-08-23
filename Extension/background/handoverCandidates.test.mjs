import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  HANDOVER_ACTIVATION_TTL_MS,
  HANDOVER_CANDIDATE_TTL_MS,
  HANDOVER_STATE_KEY,
  MAX_HANDOVER_CANDIDATES,
  classifyHandoverCommit,
  createHandoverCandidateStore,
  handoverIdentity,
  identityHostname,
} from "./handoverCandidates.mjs";

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
    snapshot() {
      return structuredClone(data);
    },
  };
}

function storeAt(storage, timeRef, overrides = {}) {
  return createHandoverCandidateStore(storage, { now: () => timeRef.value, ...overrides });
}

const SOURCE = "https://login.microsoftonline.com";
const DESTINATION = "https://login.live.com";

async function armedCandidate(store, { sourceTabId = 7, targetTabId = 7 } = {}) {
  const activation = await store.recordActivation({
    tabId: sourceTabId,
    documentId: "doc-source",
    sourceOrigin: SOURCE,
  });
  const consumed = await store.consumeActivation(sourceTabId, {
    documentId: "doc-source",
    sourceOrigin: SOURCE,
  });
  assert.ok(consumed, "the activation should be consumable for its own document");
  return store.createCandidate({
    sourceTabId,
    targetTabId,
    sourceDocumentId: consumed.documentId,
    sourceOrigin: consumed.sourceOrigin,
    activationAt: activation.createdAt,
  });
}

// =============================================================================
// Identity: protocol + normalized FQDN, HTTPS only.
// =============================================================================

test("identity keeps scheme and host and drops port, path, query and fragment", () => {
  assert.equal(handoverIdentity("https://Login.Example.com:8443/oauth?state=123#frag"), "https://login.example.com");
  assert.equal(handoverIdentity("https://login.example.com"), "https://login.example.com");
  assert.equal(handoverIdentity("https://login.example.com./path"), "https://login.example.com",
    "a trailing root dot is not a different normalized FQDN");
  assert.equal(identityHostname("https://login.example.com"), "login.example.com");
});

test("only HTTPS produces an identity", () => {
  assert.equal(handoverIdentity("http://login.example.com"), null, "HTTP is a different identity and never qualifies");
  assert.equal(handoverIdentity("file:///tmp/login.html"), null);
  assert.equal(handoverIdentity("chrome://settings"), null);
  assert.equal(handoverIdentity("not a url"), null);
  assert.equal(handoverIdentity("https://bad_host.example"), null, "malformed DNS labels are rejected");
});

test("sibling hostnames and subdomains are different identities", () => {
  assert.notEqual(handoverIdentity("https://other.example.com"), handoverIdentity("https://login.example.com"));
  assert.notEqual(handoverIdentity("https://sub.login.example.com"), handoverIdentity("https://login.example.com"));
});

// =============================================================================
// Commit classification.
// =============================================================================

test("browser-driven navigation classifies as direct or preserve", () => {
  assert.equal(classifyHandoverCommit({ transitionType: "typed", transitionQualifiers: [] }), "direct");
  assert.equal(classifyHandoverCommit({ transitionType: "auto_bookmark", transitionQualifiers: [] }), "direct");
  assert.equal(classifyHandoverCommit({ transitionType: "link", transitionQualifiers: ["from_address_bar"] }), "direct");
  assert.equal(classifyHandoverCommit({ transitionType: "reload", transitionQualifiers: [] }), "preserve");
  assert.equal(classifyHandoverCommit({ transitionType: "link", transitionQualifiers: ["forward_back"] }), "preserve");
});

test("document-driven navigation classifies as page or client_redirect", () => {
  assert.equal(classifyHandoverCommit({ transitionType: "link", transitionQualifiers: [] }), "page");
  assert.equal(classifyHandoverCommit({ transitionType: "form_submit", transitionQualifiers: [] }), "page");
  assert.equal(
    classifyHandoverCommit({ transitionType: "link", transitionQualifiers: ["client_redirect"] }),
    "client_redirect"
  );
  assert.equal(classifyHandoverCommit({}), "page", "unknown future transition types stay document-driven");
});

// =============================================================================
// Activation window: five seconds, exact source document.
// =============================================================================

test("an activation is consumed exactly once, for its exact document and origin", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);
  await store.recordActivation({ tabId: 7, documentId: "doc-a", sourceOrigin: SOURCE });

  assert.equal(await store.consumeActivation(7, { documentId: "doc-b", sourceOrigin: SOURCE }), null,
    "a replaced source document must not spend the activation");
  assert.equal(await store.consumeActivation(7, { documentId: "doc-a", sourceOrigin: DESTINATION }), null,
    "a different source identity must not spend the activation");

  const consumed = await store.consumeActivation(7, { documentId: "doc-a", sourceOrigin: SOURCE });
  assert.equal(consumed.sourceOrigin, SOURCE);
  assert.equal(consumed.expiresAt, 1_000 + HANDOVER_ACTIVATION_TTL_MS);
  assert.equal(await store.consumeActivation(7, { documentId: "doc-a", sourceOrigin: SOURCE }), null);
});

test("an activation that produced no navigation within five seconds expires without effect", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);
  await store.recordActivation({ tabId: 7, documentId: "doc-a", sourceOrigin: SOURCE });

  time.value = 1_000 + HANDOVER_ACTIVATION_TTL_MS + 1;
  assert.equal(await store.consumeActivation(7, { documentId: "doc-a", sourceOrigin: SOURCE }), null);
});

test("the activation window is anchored to service-worker receipt time", async () => {
  const time = { value: 4_000 };
  const store = storeAt(memoryStorage(), time);
  const recorded = await store.recordActivation({
    tabId: 7,
    documentId: "doc-a",
    sourceOrigin: SOURCE,
    createdAt: 1_000,
  });
  assert.equal(recorded.createdAt, 1_000);
  assert.equal(recorded.expiresAt, 1_000 + HANDOVER_ACTIVATION_TTL_MS);

  time.value = 1_000 + HANDOVER_ACTIVATION_TTL_MS + 1;
  assert.equal(await store.recordActivation({
    tabId: 8,
    documentId: "doc-b",
    sourceOrigin: SOURCE,
    createdAt: 1_000,
  }), null, "late processing cannot revive an expired activity receipt");
});

test("a fresh activity report re-arms the window for the same document", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);
  await store.recordActivation({ tabId: 7, documentId: "doc-a", sourceOrigin: SOURCE });
  time.value = 5_500;
  await store.recordActivation({ tabId: 7, documentId: "doc-a", sourceOrigin: SOURCE });

  time.value = 9_000;
  const consumed = await store.consumeActivation(7, { documentId: "doc-a", sourceOrigin: SOURCE });
  assert.equal(consumed.createdAt, 5_500);
});

// =============================================================================
// Candidate lifecycle: two minutes from activation, bound destination.
// =============================================================================

test("a candidate gets an unguessable id and a lifetime anchored to the activation", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);
  const candidate = await armedCandidate(store);

  assert.match(candidate.candidateId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(candidate.expiresAt, 1_000 + HANDOVER_CANDIDATE_TTL_MS);
  assert.equal(candidate.destinationDocumentId, null);
  assert.equal(candidate.destinationOrigin, null);
});

test("binding requires a live HTTPS identity different from the source", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);

  await armedCandidate(store);
  const bound = await store.bindDestination(7, { documentId: "doc-dest", destinationOrigin: DESTINATION });
  assert.equal(bound.destinationOrigin, DESTINATION);
  assert.equal(bound.destinationDocumentId, "doc-dest");

  await armedCandidate(store);
  assert.equal(await store.bindDestination(7, { documentId: "doc-dest", destinationOrigin: SOURCE }), null,
    "a destination equal to the source identity is not a handover");
  assert.equal(await store.getCandidate(7), null, "the same-identity bind removes the candidate fail-closed");

  await armedCandidate(store);
  assert.equal(await store.bindDestination(7, { documentId: "doc-dest", destinationOrigin: "http://login.live.com" }), null);
  assert.equal(await store.getCandidate(7), null, "a non-HTTPS destination removes the candidate fail-closed");
});

test("a client-redirect re-bind never extends the candidate lifetime", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);
  await armedCandidate(store);
  await store.bindDestination(7, { documentId: "doc-a", destinationOrigin: DESTINATION });

  time.value = 60_000;
  const rebound = await store.bindDestination(7, { documentId: "doc-b", destinationOrigin: "https://account.live.com" });
  assert.equal(rebound.expiresAt, 1_000 + HANDOVER_CANDIDATE_TTL_MS, "redirects must never extend the lifetime");

  time.value = 1_000 + HANDOVER_CANDIDATE_TTL_MS + 1;
  assert.equal(await store.bindDestination(7, { documentId: "doc-c", destinationOrigin: DESTINATION }), null,
    "an expired candidate cannot be re-bound");
});

test("document-scoped lookup answers only the bound destination document", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);
  await armedCandidate(store);
  assert.equal(await store.getCandidateForDocument(7, "doc-dest"), null, "an unbound candidate answers no document");
  await store.bindDestination(7, { documentId: "doc-dest", destinationOrigin: DESTINATION });

  assert.equal((await store.getCandidateForDocument(7, "doc-dest")).destinationOrigin, DESTINATION);
  assert.equal(await store.getCandidateForDocument(7, "doc-other"), null);

  time.value = 1_000 + HANDOVER_CANDIDATE_TTL_MS + 1;
  assert.equal(await store.getCandidateForDocument(7, "doc-dest"), null, "an expired candidate is invisible");
});

test("a new-tab candidate keys by target tab and keeps both tab ids", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);
  const candidate = await armedCandidate(store, { sourceTabId: 7, targetTabId: 9 });

  assert.equal(candidate.sourceTabId, 7);
  assert.equal(candidate.targetTabId, 9);
  assert.equal(await store.getCandidate(7), null);
  assert.equal((await store.getCandidate(9)).candidateId, candidate.candidateId);
});

// =============================================================================
// Action consumption: exact candidate, exact document, exact tab.
// =============================================================================

test("an action consumes exactly the current candidate from its bound document", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);
  const candidate = await armedCandidate(store);
  await store.bindDestination(7, { documentId: "doc-dest", destinationOrigin: DESTINATION });

  assert.equal(await store.consumeCandidateForAction(7, { candidateId: "stale-id", documentId: "doc-dest" }), null);
  assert.equal(await store.consumeCandidateForAction(7, { candidateId: candidate.candidateId, documentId: "doc-other" }), null);
  assert.ok(await store.getCandidate(7), "a rejected action must not spend the candidate");

  const consumed = await store.consumeCandidateForAction(7, {
    candidateId: candidate.candidateId,
    documentId: "doc-dest",
  });
  assert.equal(consumed.candidateId, candidate.candidateId);
  assert.equal(await store.getCandidate(7), null, "a consumed candidate is gone");
});

test("an expired candidate id is rejected even when it matches", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);
  const candidate = await armedCandidate(store);
  await store.bindDestination(7, { documentId: "doc-dest", destinationOrigin: DESTINATION });

  time.value = 1_000 + HANDOVER_CANDIDATE_TTL_MS + 1;
  assert.equal(await store.consumeCandidateForAction(7, {
    candidateId: candidate.candidateId,
    documentId: "doc-dest",
  }), null);
});

// =============================================================================
// Invalidation, expiry collection, tab cleanup.
// =============================================================================

test("takeCandidate atomically invalidates a bound candidate and returns its document", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);
  const candidate = await armedCandidate(store);
  await store.bindDestination(7, { documentId: "doc-dest", destinationOrigin: DESTINATION });

  const invalidated = await store.takeCandidate(7);
  assert.equal(invalidated.candidateId, candidate.candidateId);
  assert.equal(invalidated.destinationDocumentId, "doc-dest");
  assert.equal(await store.getCandidate(7), null);
  assert.equal(await store.takeCandidate(7), null);
});

test("closing a tab discards its candidate and its pending activation", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);
  await store.recordActivation({ tabId: 3, documentId: "doc-x", sourceOrigin: SOURCE });
  await armedCandidate(store, { sourceTabId: 7, targetTabId: 9 });

  assert.equal(await store.discardTab(9), true);
  assert.equal(await store.getCandidate(9), null);
  assert.equal(await store.discardTab(3), true);
  assert.equal(await store.consumeActivation(3, { documentId: "doc-x", sourceOrigin: SOURCE }), null);
});

test("expired candidates are collected once, with their binding, for notification", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);
  await armedCandidate(store);
  await store.bindDestination(7, { documentId: "doc-dest", destinationOrigin: DESTINATION });
  assert.equal(await store.nextExpiry(), 1_000 + HANDOVER_CANDIDATE_TTL_MS);

  assert.deepEqual(await store.takeExpired(), [], "nothing expires before the deadline");
  time.value = 1_000 + HANDOVER_CANDIDATE_TTL_MS + 1;
  const expired = await store.takeExpired();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].destinationDocumentId, "doc-dest");
  assert.deepEqual(await store.takeExpired(), []);
  assert.equal(await store.nextExpiry(), null);
});

// =============================================================================
// Durability and fail-closed normalization.
// =============================================================================

test("a candidate survives an MV3 worker restart", async () => {
  const storage = memoryStorage();
  const time = { value: 1_000 };
  const first = storeAt(storage, time);
  const candidate = await armedCandidate(first);
  await first.bindDestination(7, { documentId: "doc-dest", destinationOrigin: DESTINATION });

  const restarted = storeAt(storage, { value: 30_000 });
  const restored = await restarted.getCandidateForDocument(7, "doc-dest");
  assert.equal(restored.candidateId, candidate.candidateId);
  assert.equal(restored.sourceOrigin, SOURCE);
});

test("malformed stored state normalizes fail-closed", async () => {
  const storage = memoryStorage();
  await storage.set({
    [HANDOVER_STATE_KEY]: {
      activations_by_tab: "garbage",
      candidates_by_target_tab: {
        7: { candidateId: "x" }, // missing everything else
        8: {
          candidateId: "y",
          sourceTabId: 8,
          targetTabId: 8,
          sourceDocumentId: "doc",
          sourceOrigin: "http://not-https.example", // invalid identity
          destinationDocumentId: null,
          destinationOrigin: null,
          activationAt: 1_000,
          expiresAt: 2_000,
        },
        9: {
          candidateId: "z",
          sourceTabId: 9,
          targetTabId: 9,
          sourceDocumentId: "doc",
          sourceOrigin: SOURCE,
          destinationDocumentId: "doc-dest",
          destinationOrigin: SOURCE, // destination may never equal the source
          activationAt: 1_000,
          expiresAt: 2_000,
        },
      },
    },
  });

  const store = storeAt(storage, { value: 1_500 });
  assert.equal(await store.getCandidate(7), null);
  assert.equal(await store.getCandidate(8), null);
  assert.equal(await store.getCandidate(9), null);
  assert.equal(await store.nextExpiry(), null);
});

test("a stored lifetime longer than the TTL is rejected", async () => {
  const storage = memoryStorage();
  await storage.set({
    [HANDOVER_STATE_KEY]: {
      activations_by_tab: {},
      candidates_by_target_tab: {
        7: {
          candidateId: "long",
          sourceTabId: 7,
          targetTabId: 7,
          sourceDocumentId: "doc",
          sourceOrigin: SOURCE,
          destinationDocumentId: null,
          destinationOrigin: null,
          activationAt: 1_000,
          expiresAt: 1_000 + HANDOVER_CANDIDATE_TTL_MS * 10,
        },
      },
    },
  });
  assert.equal(await storeAt(storage, { value: 1_500 }).getCandidate(7), null);
});

test("no full authentication URLs are persisted", async () => {
  const storage = memoryStorage();
  const time = { value: 1_000 };
  const store = storeAt(storage, time);
  // The identities the service worker stores are already reduced by
  // handoverIdentity; prove the reduction and the stored payload agree.
  const source = handoverIdentity("https://login.microsoftonline.com:8443/authorize?client_id=abc&state=SECRET#top");
  await store.recordActivation({ tabId: 7, documentId: "doc-a", sourceOrigin: source });
  const consumed = await store.consumeActivation(7, { documentId: "doc-a", sourceOrigin: source });
  await store.createCandidate({
    sourceTabId: 7,
    targetTabId: 7,
    sourceDocumentId: consumed.documentId,
    sourceOrigin: consumed.sourceOrigin,
    activationAt: consumed.createdAt,
  });
  await store.bindDestination(7, {
    documentId: "doc-b",
    destinationOrigin: handoverIdentity("https://login.live.com/oauth?code=SECRET"),
  });

  const persisted = JSON.stringify(storage.snapshot());
  assert.doesNotMatch(persisted, /SECRET|authorize|oauth|client_id|8443/);
  assert.match(persisted, /https:\/\/login\.microsoftonline\.com/);
  assert.match(persisted, /https:\/\/login\.live\.com/);
});

test("the candidate cap evicts the oldest, never grows unbounded", async () => {
  const time = { value: 1_000 };
  const store = storeAt(memoryStorage(), time);
  for (let index = 0; index < MAX_HANDOVER_CANDIDATES + 5; index += 1) {
    time.value = 1_000 + index;
    await armedCandidate(store, { sourceTabId: index, targetTabId: index });
  }
  assert.equal(await store.getCandidate(0), null, "the oldest candidates are evicted at capacity");
  assert.ok(await store.getCandidate(MAX_HANDOVER_CANDIDATES + 4));
});

// =============================================================================
// Service-worker wiring (source guard): the store's decisions are unit-tested
// above; these pin the Chrome event wiring that cannot run under plain Node.
// =============================================================================

test("the worker prepares candidates on navigation events and binds them on commit", async () => {
  const worker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  assert.match(worker, /onBeforeNavigate\.addListener[\s\S]{0,900}prepareHandoverSameTabCandidate/);
  assert.match(worker, /onCreatedNavigationTarget\.addListener[\s\S]{0,600}prepareHandoverNavigationTarget/);
  // A fast commit waits for preparation, and destination lookup waits for the
  // resulting binding rather than overtaking it at document_idle.
  assert.match(worker, /const handoverBinding = Promise\.resolve\(handoverPreparation\)[\s\S]{0,200}handleHandoverCommit\(details\)/);
  assert.match(worker, /handoverCommitBindings\.get\(tabId\)[\s\S]{0,200}await binding\.catch/);
  // Runtime activity receipt is published before asynchronous validation and
  // claimed by preparation for the exact source document.
  assert.match(worker, /trackHandoverActivityRecording\([\s\S]{0,300}handling/);
  assert.match(worker, /waitForHandoverActivityRecording\(sourceTabId, source\.documentId\)/);
  assert.match(worker, /prepareHandoverNavigationTarget[\s\S]{0,200}sourceFrameId !== 0\) return/);
});

test("the worker invalidates candidates on history, errors, replacement and closure", async () => {
  const worker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  assert.match(worker, /invalidateHandoverForHistoryChange\(details\)/);
  assert.match(worker, /onErrorOccurred\.addListener[\s\S]{0,1600}invalidateHandoverCandidate\(details\.tabId\)/);
  assert.match(worker, /type: "handover_invalidated"/);
  assert.match(worker, /chrome\.tabs\.onReplaced\.addListener/);
  assert.match(worker, /handoverCandidates\.discardTab\(removedTabId\)/);
});

test("the worker owns authoritative expiry through chrome.alarms", async () => {
  const worker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  assert.match(worker, /chrome\.alarms\.create\(HANDOVER_EXPIRY_ALARM/);
  assert.match(worker, /takeExpired\(\)[\s\S]{0,400}type: "handover_expired"/);
});

test("the worker validates activity and actions against the authoritative frame", async () => {
  const worker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  assert.match(worker, /case "handover_user_activity":[\s\S]{0,1400}resolveHandoverSource/);
  assert.match(worker, /function resolveHandoverSource[\s\S]{0,600}in_trusted_list[\s\S]{0,200}in_muted_list/);
  assert.match(worker, /case "resolve_handover_candidate":[\s\S]{0,800}getCandidateForDocument/);
  assert.match(worker, /case "resolve_handover_candidate":[\s\S]{0,1800}trustedIdentity[\s\S]{0,300}origin\.in_muted_list/);
  assert.match(worker, /trustedIdentity = origin\.valid === true && origin\.in_trusted_list &&\s*origin\.protocol_matches/);
  assert.match(worker, /case "handover_add_to_trusted":\s*case "handover_analyse_normally":\s*case "handover_leave":[\s\S]{0,700}consumeCandidateForAction/);
  assert.match(worker, /chrome\.tabs\.goBack/);
  assert.match(worker, /return \{ ok: await leaveHandoverDestination\(tabId, candidate\) \}/,
    "a failed leave must be reported so content can fall back to analysis");
});
