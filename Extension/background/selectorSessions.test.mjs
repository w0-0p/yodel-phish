import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createCaptureTracker,
  createSelectorSessionStore,
  emptySelectorState,
  normalizeSelectorState,
  SELECTOR_STATE_KEY,
  selectorSessionStatus,
} from "./selectorSessions.mjs";

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

function createStore(storageArea = createFakeStorageArea()) {
  let counter = 0;
  return {
    storageArea,
    store: createSelectorSessionStore(storageArea, {
      newSessionId: () => `session-${(counter += 1)}`,
    }),
  };
}

// Issue #90: an add-to-trusted session carries the add payload and YOLO's
// candidate boxes itself — there is no separate pending-add record any more.
const addPayload = Object.freeze({
  origin: { fqdn: "bank.example", etld1: "bank.example", ocrDomain: "bank", protocol: "https" },
  scores: { global_score: 0.4, ocr_score: 0.2 },
});

const addCandidates = Object.freeze([
  { xRatio: 0.05, yRatio: 0.04, widthRatio: 0.12, heightRatio: 0.05, score: 0.62 },
  { xRatio: 0.7, yRatio: 0.02, widthRatio: 0.08, heightRatio: 0.04, score: 0.18 },
]);

// =============================================================================
// Durability — the flow must survive the worker being discarded mid-selection.
// =============================================================================

test("a session started before a worker restart is still there afterwards", async () => {
  const { storageArea, store } = createStore();
  const started = await store.start(7, { fqdn: "bank.example", variantId: "variant-1", closeTabOnComplete: true });

  // A fresh store over the same storage area is what a restarted service
  // worker gets: no in-memory state, only what was persisted.
  const restarted = createSelectorSessionStore(storageArea);
  const session = await restarted.get(7);

  assert.deepEqual(session, {
    fqdn: "bank.example",
    variantId: "variant-1",
    closeTabOnComplete: true,
    sessionId: started.sessionId,
  });
});

test("an add session carries its payload and candidates across a worker restart", async () => {
  const { storageArea, store } = createStore();
  const started = await store.start(3, {
    fqdn: addPayload.origin.fqdn,
    add: addPayload,
    candidates: addCandidates,
    closeTabOnComplete: false,
  });

  const restarted = createSelectorSessionStore(storageArea);
  const session = await restarted.get(3);

  assert.equal(session.sessionId, started.sessionId);
  assert.deepEqual(session.add.scores, { global_score: 0.4, ocr_score: 0.2 });
  assert.deepEqual(session.candidates, addCandidates);
});

test("an add session stays far below what session storage can cheaply rewrite", async () => {
  const { storageArea, store } = createStore();
  await store.start(3, {
    fqdn: addPayload.origin.fqdn,
    add: addPayload,
    candidates: addCandidates,
    closeTabOnComplete: false,
  });

  const stored = storageArea.dump()[SELECTOR_STATE_KEY].sessions_by_tab["3"];
  assert.deepEqual(
    Object.keys(stored).sort(),
    ["add", "candidates", "closeTabOnComplete", "fqdn", "sessionId"]
  );
  assert.deepEqual(Object.keys(stored.add).sort(), ["origin", "scores"]);
  // The analysis result -- screenshot data url included -- is far too large to
  // belong in session storage; candidate boxes are a handful of numbers each.
  assert.equal(JSON.stringify(stored).length < 1500, true);
});

test("sessions are kept per tab", async () => {
  const { store } = createStore();
  await store.start(1, { fqdn: "one.example", closeTabOnComplete: false });
  await store.start(2, { fqdn: "two.example", closeTabOnComplete: true });

  assert.equal((await store.get(1)).fqdn, "one.example");
  assert.equal((await store.get(2)).fqdn, "two.example");
  assert.equal(await store.get(99), null);

  await store.discardTab(2);
  assert.equal(await store.get(2), null);
  assert.equal((await store.get(1)).fqdn, "one.example", "closing one tab leaves other tabs alone");
});

test("concurrent updates to the session state are serialized, not lost", async () => {
  const { store } = createStore();

  await Promise.all([
    store.start(1, { fqdn: "one.example", closeTabOnComplete: false }),
    store.start(2, { fqdn: "two.example", add: addPayload, candidates: addCandidates, closeTabOnComplete: false }),
    store.start(3, { fqdn: "three.example", closeTabOnComplete: true }),
  ]);

  assert.equal((await store.get(1)).fqdn, "one.example");
  assert.deepEqual((await store.get(2)).add, addPayload);
  assert.equal((await store.get(3)).fqdn, "three.example");
});

// =============================================================================
// Session identity — a leftover overlay must not act on a newer session.
// =============================================================================

test("each session gets its own id, and starting one replaces the tab's previous session", async () => {
  const { store } = createStore();
  const first = await store.start(5, { fqdn: "one.example", closeTabOnComplete: false });
  const second = await store.start(5, { fqdn: "two.example", closeTabOnComplete: false });

  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal((await store.get(5)).sessionId, second.sessionId);
});

test("ending a session with a stale id leaves the current session alone", async () => {
  const { store } = createStore();
  const first = await store.start(5, { fqdn: "one.example", closeTabOnComplete: false });
  const second = await store.start(5, { fqdn: "two.example", closeTabOnComplete: false });

  assert.equal(await store.end(5, first.sessionId), null, "the stale overlay's cancel is refused");
  assert.equal((await store.get(5)).sessionId, second.sessionId);

  const ended = await store.end(5, second.sessionId);
  assert.equal(ended.sessionId, second.sessionId, "the session is returned so teardown runs once");
  assert.equal(await store.get(5), null);
  assert.equal(await store.end(5, second.sessionId), null, "a second cancel has nothing left to tear down");
});

test("ending without an id ends whatever session the tab has", async () => {
  const { store } = createStore();
  await store.start(5, { fqdn: "one.example", closeTabOnComplete: true });

  const ended = await store.end(5);

  assert.equal(ended.fqdn, "one.example");
  assert.equal(await store.get(5), null);
});

test("a confirmation attempt is durable and only its session can start it", async () => {
  const { storageArea, store } = createStore();
  const session = await store.start(5, { fqdn: "one.example", closeTabOnComplete: false });

  assert.equal(await store.beginAttempt(5, "stale-session"), null);
  const attempt = await store.beginAttempt(5, session.sessionId);

  assert.notEqual(attempt.attemptId, session.sessionId);
  assert.deepEqual(await createSelectorSessionStore(storageArea).get(5), attempt);
});

test("only the latest attempt can complete, and completing removes the session", async () => {
  const { storageArea, store } = createStore();
  const session = await store.start(5, {
    fqdn: "bank.example",
    add: addPayload,
    candidates: addCandidates,
    closeTabOnComplete: false,
  });
  const first = await store.beginAttempt(5, session.sessionId);
  const latest = await store.beginAttempt(5, session.sessionId);

  assert.equal(await store.completeAttempt(5, session.sessionId, first.attemptId), null);
  assert.equal(await store.completeAttempt(5, "stale-session", latest.attemptId), null);
  assert.equal((await store.get(5)).attemptId, latest.attemptId);

  const completed = await store.completeAttempt(5, session.sessionId, latest.attemptId);
  const stored = storageArea.dump()[SELECTOR_STATE_KEY];
  assert.equal(completed.attemptId, latest.attemptId);
  assert.deepEqual(completed.add, addPayload, "the save runs from the completed session's own payload");
  assert.equal(stored.sessions_by_tab["5"], undefined);

  const restarted = createSelectorSessionStore(storageArea);
  assert.equal(await restarted.get(5), null);
});

// =============================================================================
// Site binding — a tab id is not proof of what is on screen.
// =============================================================================

const boundSession = Object.freeze({ sessionId: "session-1", fqdn: "bank.example" });

test("a current session on its own active tab is usable", () => {
  assert.equal(
    selectorSessionStatus(boundSession, { sessionId: "session-1", tabActive: true, tabFqdn: "bank.example" }),
    "ok"
  );
});

test("a message from another session, or with no session at all, is inactive", () => {
  const live = { sessionId: "session-1", tabActive: true, tabFqdn: "bank.example" };
  assert.equal(selectorSessionStatus(null, live), "selector_inactive");
  assert.equal(selectorSessionStatus(undefined, live), "selector_inactive");
  assert.equal(selectorSessionStatus(boundSession, { ...live, sessionId: "session-2" }), "selector_inactive");
  assert.equal(selectorSessionStatus(boundSession, { ...live, sessionId: undefined }), "selector_inactive");
  assert.equal(selectorSessionStatus(boundSession, { ...live, sessionId: "" }), "selector_inactive");
  assert.equal(selectorSessionStatus(boundSession, {}), "selector_inactive");
});

test("an attempt id is enforced when supplied, while ordinary session checks may omit it", () => {
  const session = { ...boundSession, attemptId: "attempt-1" };
  const live = { sessionId: "session-1", tabActive: true, tabFqdn: "bank.example" };

  assert.equal(selectorSessionStatus(session, { ...live, attemptId: "attempt-1" }), "ok");
  assert.equal(selectorSessionStatus(session, live), "ok");
  assert.equal(selectorSessionStatus(session, { ...live, attemptId: "attempt-2" }), "selector_inactive");
  assert.equal(
    selectorSessionStatus(session, {
      sessionId: "session-1",
      attemptId: "attempt-2",
      tabActive: false,
      tabFqdn: "phish.example",
    }),
    "selector_inactive"
  );
});

test("a background tab is refused: captureVisibleTab would record another page", () => {
  assert.equal(
    selectorSessionStatus(boundSession, { sessionId: "session-1", tabActive: false, tabFqdn: "bank.example" }),
    "tab_inactive"
  );
  assert.equal(
    selectorSessionStatus(boundSession, { sessionId: "session-1", tabActive: undefined, tabFqdn: "bank.example" }),
    "tab_inactive"
  );
});

test("a tab that navigated away from the intended site is refused", () => {
  const active = { sessionId: "session-1", tabActive: true };
  assert.equal(selectorSessionStatus(boundSession, { ...active, tabFqdn: "phish.example" }), "page_changed");
  // A subdomain is a different host, and an unparseable url proves nothing.
  assert.equal(selectorSessionStatus(boundSession, { ...active, tabFqdn: "login.bank.example" }), "page_changed");
  assert.equal(selectorSessionStatus(boundSession, { ...active, tabFqdn: undefined }), "page_changed");
});

test("a changed page is reported before the tab's active state", () => {
  assert.equal(
    selectorSessionStatus(boundSession, { sessionId: "session-1", tabActive: false, tabFqdn: "phish.example" }),
    "page_changed"
  );
});

// =============================================================================
// Capture guards — an away-and-back transition must remain observable.
// =============================================================================

test("a capture guard ignores unrelated activity and requires the same tab and window", () => {
  const tracker = createCaptureTracker();
  const guard = tracker.begin(7, 3);

  tracker.interruptTab(8);
  tracker.interruptWindow(4);
  assert.equal(tracker.isCurrent(guard, 7, 3), true);
  assert.equal(tracker.isCurrent(guard, 8, 3), false);
  assert.equal(tracker.isCurrent(guard, 7, 4), false);

  tracker.end(guard);
  assert.equal(tracker.isCurrent(guard, 7, 3), false);
});

test("tab and window interruptions stay sticky after returning to the original page", () => {
  const tracker = createCaptureTracker();
  const switched = tracker.begin(7, 3);
  const navigated = tracker.begin(8, 4);

  tracker.interruptWindow(3);
  tracker.interruptTab(8);

  assert.equal(tracker.isCurrent(switched, 7, 3), false, "switching back cannot revive the capture");
  assert.equal(tracker.isCurrent(navigated, 8, 4), false, "navigating back cannot revive the capture");
});

// =============================================================================
// Stored shape — session storage can come back as anything.
// =============================================================================

test("a damaged or absent stored state reads as empty rather than throwing", () => {
  assert.deepEqual(normalizeSelectorState(undefined), emptySelectorState());
  assert.deepEqual(normalizeSelectorState(null), emptySelectorState());
  assert.deepEqual(normalizeSelectorState("nonsense"), emptySelectorState());
  assert.deepEqual(normalizeSelectorState({ sessions_by_tab: [] }), emptySelectorState());
  // A pending_adds_by_tab map left behind by a pre-issue-#90 version is
  // silently dropped rather than resurrected.
  assert.deepEqual(
    normalizeSelectorState({ sessions_by_tab: {}, pending_adds_by_tab: { 3: { origin: {} } } }),
    emptySelectorState()
  );
  assert.deepEqual(
    normalizeSelectorState({ sessions_by_tab: { 1: null, 2: "no", 3: ["no"], 4: { fqdn: "ok.example" } } }),
    { sessions_by_tab: { 4: { fqdn: "ok.example" } } }
  );
});

test("a store reading a damaged state still works", async () => {
  const storageArea = createFakeStorageArea({ [SELECTOR_STATE_KEY]: "corrupted" });
  const store = createSelectorSessionStore(storageArea);

  assert.equal(await store.get(1), null);
  const started = await store.start(1, { fqdn: "bank.example", closeTabOnComplete: false });
  assert.equal((await store.get(1)).sessionId, started.sessionId);
});

// =============================================================================
// Wiring — the checks have to be applied at every step that can act.
// =============================================================================

test("the confirmation path owns one attempt before capture, after capture, and at commit time", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");

  assert.match(serviceWorker, /const attempt = await selectorSessions\.beginAttempt\(tabId, sessionId\)/);
  const checks = serviceWorker.match(/await checkSelectorSession\(tabId, sessionId, attemptId\)/g) ?? [];
  assert.equal(checks.length, 3, "capture, post-capture and commit must each verify the same attempt");
  assert.match(serviceWorker, /const documentId = sender\?\.documentId/);
  assert.match(serviceWorker, /const beforeCapture = await checkSelectorSession[\s\S]{0,120}?beforeCapture\.status !== "ok"/);
  assert.match(serviceWorker, /afterCapture = await checkSelectorSession\(tabId, sessionId, attemptId\)/);
  assert.match(serviceWorker, /if \(afterCapture\.status !== "ok"\)/);
  assert.match(
    serviceWorker,
    /withTrustedMuted\(async \(state\) => \{[\s\S]{0,500}?const beforeSave = await checkSelectorSession\(tabId, sessionId, attemptId\)/
  );
  assert.match(serviceWorker, /if \(!\(await isInitiatingDocumentCurrent\(tabId, documentId\)\)\) \{\s*return \{ value: \{ status: "page_changed"/);
  // Each check re-reads stored ownership, and the save uses the freshest session.
  assert.match(serviceWorker, /const session = await selectorSessions\.get\(tabId\);\s*\n\s*let tab;/);
  assert.match(serviceWorker, /const session = beforeSave\.session/);

  // The live tab URL decides the fqdn -- never the fqdn the overlay sent.
  assert.match(serviceWorker, /const tabOrigin = parseOrigin\(tabUrl\) \?\? await parseFileOrigin\(tabUrl\)/);
  assert.match(serviceWorker, /tabFqdn: tabOrigin\?\.fqdn/);
  assert.match(serviceWorker, /tabActive: tab\.active/);

  // Completion owns session and pending-add cleanup. If ownership changed after
  // the trusted write, only that exact write is compensated.
  assert.match(serviceWorker, /session = await selectorSessions\.completeAttempt\(tabId, sessionId, attemptId\)/);
  const cleanupFailure = serviceWorker.indexOf("Logo selector session cleanup failed after saving");
  const ownershipCheck = serviceWorker.indexOf("if (session === null)", cleanupFailure);
  const cleanupRecovery = serviceWorker.slice(cleanupFailure, ownershipCheck);
  assert.notEqual(cleanupFailure, -1);
  assert.notEqual(ownershipCheck, -1);
  assert.match(cleanupRecovery, /session = outcome\.session/);
  assert.match(cleanupRecovery, /void selectorSessions\.completeAttempt\(tabId, sessionId, attemptId\)/);
  assert.doesNotMatch(cleanupRecovery, /return \{ ok: false/, "cleanup failure cannot turn a committed save into a retry");
  assert.match(
    serviceWorker,
    /if \(session === null\) \{[\s\S]{0,250}?await compensateTrustedCommit\(outcome\.commit\)/
  );

  // Session state lives in storage, not in worker memory.
  assert.match(serviceWorker, /createSelectorSessionStore\(chrome\.storage\.session\)/);
  assert.doesNotMatch(serviceWorker, /new Map\(\)[^\n]*selector/i);
  assert.doesNotMatch(serviceWorker, /selectorTabIds|pendingTrustedAdds/);
});

test("every visible-tab capture uses the shared sticky guard", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const screenshotSource = await readFile(
    new URL("../../src/detection/browser/screenshotSource.ts", import.meta.url),
    "utf8"
  );

  assert.match(serviceWorker, /const captureTracker = createCaptureTracker\(\)/);
  assert.match(serviceWorker, /new ChromeScreenshotSource\(captureTracker\)/);
  // Issue #88 narrowed this one guard: a URL notification restating the active
  // job's own address is a late report of the navigation that job was started
  // for, not a navigation away from it. Every other address still interrupts.
  assert.match(
    serviceWorker,
    /if \(changeInfo\.url !== undefined\) \{[\s\S]{0,320}?if \(!isActiveJobAddress\(updatedTabId, changeInfo\.url\)\) \{\s*captureTracker\.interruptTab\(updatedTabId\);/
  );
  assert.match(
    serviceWorker,
    /chrome\.tabs\.onActivated\.addListener\(\(\{ windowId \}\) => \{\s*captureTracker\.interruptWindow\(windowId\)/
  );
  assert.match(serviceWorker, /\[chrome\.tabs\.onAttached, chrome\.tabs\.onDetached\]/);
  assert.match(serviceWorker, /chrome\.webNavigation\.onCommitted\.addListener/);
  assert.equal(
    (serviceWorker.match(/screenshotSource\.captureVisibleTab\(tabId\)/g) ?? []).length,
    2,
    "analysis and manual selection must use the same screenshot source"
  );
  assert.doesNotMatch(serviceWorker, /chrome\.tabs\.captureVisibleTab\(/);

  assert.equal((screenshotSource.match(/await chrome\.tabs\.captureVisibleTab\(/g) ?? []).length, 1);
  assert.match(screenshotSource, /const guard = this\.captures\.begin\(tabId, before\.windowId\)/);
  assert.match(screenshotSource, /const after = await chrome\.tabs\.get\(tabId\)/);
  assert.match(screenshotSource, /after\.active !== true[\s\S]{0,180}!this\.captures\.isCurrent\(guard, tabId, after\.windowId\)/);
  assert.match(screenshotSource, /finally \{\s*this\.captures\.end\(guard\)/);
  assert.match(serviceWorker, /captureError\?\.code === "capture_interrupted"/);
});

test("document identity scopes verdict delivery and guards capture-derived trusted writes", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const validateStart = serviceWorker.indexOf("async function validateJobForCommit");
  const validateEnd = serviceWorker.indexOf("function finishJob", validateStart);
  const validate = serviceWorker.slice(validateStart, validateEnd);
  assert.match(validate, /isInitiatingDocumentCurrent\(tabId, job\.documentId\)/);
  assert.match(
    serviceWorker,
    /chrome\.tabs\.sendMessage\(tabId, scopedMessage, \{ documentId: job\.documentId \}\)/
  );

  assert.equal(
    (serviceWorker.match(/await isInitiatingDocumentCurrent\(tabId,/g) ?? []).length,
    3,
    "final verdicts, manual selections (which explicit adds now run through) and automatic refreshes are document-bound"
  );

  const refreshStart = serviceWorker.indexOf("async function refreshTrustedEntry");
  const refreshEnd = serviceWorker.indexOf("async function checkSelectorSession", refreshStart);
  const refresh = serviceWorker.slice(refreshStart, refreshEnd);
  const preprocess = refresh.indexOf("const preprocessed = await preprocessTrustedReference");
  const noLogo = refresh.indexOf("preprocessed.logo_region === null", preprocess);
  const write = refresh.indexOf("const commit = await withTrustedMuted", noLogo);
  assert.ok(preprocess >= 0 && noLogo > preprocess && write > noLogo);
  assert.match(refresh.slice(write), /isInitiatingDocumentCurrent\(tabId, job\.documentId\)/);

  assert.doesNotMatch(serviceWorker, /captureIntegrity|sampleCapturePixels|capture_unusable/);
});

test("the selector overlay is injected with its session id and answers with it", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const selector = await readFile(new URL("../logo-selector/logo-selector.js", import.meta.url), "utf8");

  assert.match(serviceWorker, /args: \[session\.fqdn, session\.sessionId, session\.candidates \?\? \[\]\]/);
  assert.match(serviceWorker, /window\.__YP_SELECTOR_CONFIG__ = \{ fqdn: fqdnVal, sessionId: sessionIdVal, candidates: candidatesVal \}/);
  assert.match(selector, /const sessionId = config\.sessionId \?\? ""/);
  assert.match(serviceWorker, /cancelLogoSelectorSession\(tabId, message\.sessionId\)/);
});

// =============================================================================
// Issue #90: an explicit add is always validated by the user before anything
// is encoded or written; cancelling flushes the attempt back to the unknown
// banner.
// =============================================================================

test("an explicit add defers every trusted write to the selector confirmation", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");

  const addStart = serviceWorker.indexOf('case "add_to_trusted"');
  const addEnd = serviceWorker.indexOf('case "add_to_muted"', addStart);
  assert.ok(addStart >= 0 && addEnd > addStart);
  const addCase = serviceWorker.slice(addStart, addEnd);

  // Candidates are proposed for the user with the human-review floor; the add
  // case itself never preprocesses a crop, writes the trusted list, or shows a
  // verdict banner — the selector session takes over from here.
  assert.match(addCase, /proposeTrustedAddCandidates\(result\.screenshot, tabId, job\.jobId\)/);
  assert.match(addCase, /selectorSessions\.start\(tabId, \{\s*fqdn: parsedOrigin\.fqdn,\s*add: \{\s*origin: parsedOrigin,\s*scores: scoreSnapshot\(result\),\s*\.\.\.\(isMoveToTrusted \? \{ moveFromMuted: true \} : \{\}\),\s*\},\s*candidates,/);
  assert.match(addCase, /await injectLogoSelector\(tabId\)/);
  assert.doesNotMatch(addCase, /preprocessTrustedReference|withTrustedMuted|sendValidatedBanner/);

  // The pending-add bridge is gone: the session itself carries the payload.
  assert.doesNotMatch(serviceWorker, /PendingAdd|pending_adds_by_tab|select_logo_for_trusted_add|add_logo_not_found/);

  // Cancelling an add-flow session restores the unknown banner, the state the
  // "Add to trusted" button started from.
  const cancelStart = serviceWorker.indexOf("async function cancelLogoSelectorSession");
  const cancelEnd = serviceWorker.indexOf("async function focusOrOpenSettings", cancelStart);
  assert.ok(cancelStart >= 0 && cancelEnd > cancelStart);
  const cancel = serviceWorker.slice(cancelStart, cancelEnd);
  assert.match(cancel, /verdict: "unknown"/);
});
