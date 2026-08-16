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

  assert.match(serviceWorker, /args: \[session\.fqdn, session\.sessionId, session\.candidates \?\? \[\], session\.notice \?\? null\]/);
  assert.match(serviceWorker, /window\.__YP_SELECTOR_CONFIG__ = \{\s*fqdn: fqdnVal,\s*sessionId: sessionIdVal,\s*candidates: candidatesVal,\s*notice: noticeVal,\s*\}/);
  assert.match(selector, /const sessionId = config\.sessionId \?\? ""/);
  assert.match(serviceWorker, /cancelLogoSelectorSession\(tabId, message\.sessionId\)/);

  // Issue #14: the overlay's notice is a code, mapped to fixed wording by the
  // overlay itself, exactly like a failure code -- the background never sends
  // display text into the page.
  assert.match(selector, /const NOTICE_MESSAGES = Object\.freeze\(\{/);
  assert.match(selector, /logo_search_timeout: "The logo detection took too long, please select the logo manually"/);
  assert.match(selector, /NOTICE_MESSAGES\[config\.notice\] \?\? ""/);
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
  assert.match(addCase, /openTrustedAddSelector\(tabId, job, \{ scores: scoreSnapshot\(result\), candidates \}\)/);
  assert.doesNotMatch(addCase, /preprocessTrustedReference|withTrustedMuted|sendValidatedBanner/);

  // Issue #14 moved session creation and overlay injection into the one
  // function all three routes into the selector share (automatic completion,
  // "Select logo manually", the logo-search deadline), so the session shape is
  // asserted there. A bypassed search contributes no scores.
  const openStart = serviceWorker.indexOf("async function openTrustedAddSelector");
  const openEnd = serviceWorker.indexOf("function armLogoSearchDeadline", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart);
  const openSelector = serviceWorker.slice(openStart, openEnd);
  assert.match(openSelector, /selectorSessions\.start\(tabId, \{\s*fqdn: trustedAdd\.origin\.fqdn,\s*add: \{\s*origin: trustedAdd\.origin,\s*\.\.\.\(scores === undefined \? \{\} : \{ scores \}\),/);
  assert.match(openSelector, /await injectLogoSelector\(tabId\)/);
  assert.doesNotMatch(openSelector, /preprocessTrustedReference|withTrustedMuted|sendValidatedBanner/);

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

// =============================================================================
// Issue #14 — the trusted-site flow's controls and its fallback to manual
// selection. The service worker is bundled with chrome.* dependencies, so its
// wiring is asserted against the source, the way the rest of this file asserts
// the selector's; the observable behaviour on the page side is covered in
// content.test.js.
// =============================================================================

test("the logo-search deadline is a UX fallback, not another fault limit", async () => {
  const limits = await readFile(new URL("./inferenceLimits.mjs", import.meta.url), "utf8");
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");

  // Measured from the click, so it also covers runtime startup and screenshot
  // preparation -- the 30s placement, not the 20s logo-search-only one.
  assert.match(limits, /export const TRUSTED_ADD_LOGO_SEARCH_TIMEOUT_MS = 30_000;/);
  // The fault-containment limits are untouched by it.
  assert.match(limits, /export const OFFSCREEN_REQUEST_TIMEOUT_MS = 60_000;/);
  assert.match(limits, /export const JOB_TOTAL_TIMEOUT_MS = 280_000;/);

  const armStart = serviceWorker.indexOf("function armLogoSearchDeadline");
  const armEnd = serviceWorker.indexOf("async function injectLogoSelector", armStart);
  assert.ok(armStart >= 0 && armEnd > armStart);
  const arm = serviceWorker.slice(armStart, armEnd);

  assert.match(arm, /setTimeout\([\s\S]*?TRUSTED_ADD_LOGO_SEARCH_TIMEOUT_MS\)/);
  assert.match(
    arm,
    /if \(job\.selectorOpened \|\| isJobTerminal\(job\) \|\| activeJobs\.get\(tabId\) !== job\) return;/,
    "a job that already opened its selector, ended, or was replaced is left alone"
  );
  assert.match(arm, /cancelJobForUser\(tabId, job, "logo_search_timeout"\)/);
  assert.match(arm, /openTrustedAddSelector\(tabId, job, \{ notice: "logo_search_timeout" \}\)/);
  assert.doesNotMatch(arm, /failJob|analysis_failed|recycleOffscreenDocument/, "a slow search is not a failure");
});

test("every route into the selector excludes the others, and every terminal path clears the deadline", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");

  // One synchronous claim, taken before the first await, is what keeps the
  // automatic search, "Select logo manually" and the deadline from opening two
  // selectors (or writing two sessions) for one job.
  const openSelector = serviceWorker.slice(
    serviceWorker.indexOf("async function openTrustedAddSelector"),
    serviceWorker.indexOf("function armLogoSearchDeadline")
  );
  assert.match(openSelector, /if \(job\.selectorOpened\) return false;\s*job\.selectorOpened = true;/);
  assert.ok(
    openSelector.indexOf("job.selectorOpened = true") < openSelector.indexOf("await"),
    "the claim must be taken before anything can interleave"
  );

  // Timers belong to the job, and every terminal transition goes through
  // clearJobTimeout -- completion, failure, cancellation, supersession and tab
  // closure alike.
  const clearTimeouts = serviceWorker.slice(
    serviceWorker.indexOf("function clearJobTimeout"),
    serviceWorker.indexOf("function recordLogoSearchDuration")
  );
  assert.match(clearTimeouts, /clearLogoSearchDeadline\(job\)/);
  assert.match(serviceWorker, /function markJobTerminalIfCurrent[\s\S]*?clearJobTimeout\(job\)/);
  assert.match(serviceWorker, /function finishJob[\s\S]*?clearJobTimeout\(job\)/);
});

test("the progress-banner controls end exactly their own job and open no warning UI", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");

  const cancelCase = serviceWorker.slice(
    serviceWorker.indexOf('case "cancel_current_analysis"'),
    serviceWorker.indexOf('case "select_logo_manually"')
  );
  const manualCase = serviceWorker.slice(
    serviceWorker.indexOf('case "select_logo_manually"'),
    serviceWorker.indexOf('case "add_to_muted"')
  );

  for (const [name, source] of [["cancel", cancelCase], ["manual selection", manualCase]]) {
    assert.match(source, /!isTopFrameSender\(sender\)/, `${name} is top-frame only`);
    assert.match(source, /job\.jobId !== message\.jobId/, `${name} acts on one exact job`);
    assert.match(source, /cancelJobForUser\(tabId, job, "/, `${name} ends the job it names`);
    assert.doesNotMatch(source, /scheduleInterruption|analysis_interrupted|analysis_failed/,
      `${name} is not a page change and not a failure`);
  }

  // A user cancel is silent: no interruption tab, and no reset that would make
  // the surviving document start the analysis again by itself.
  const userCancel = serviceWorker.slice(
    serviceWorker.indexOf("function cancelJobForUser"),
    serviceWorker.indexOf("function recordJobFailure")
  );
  assert.match(userCancel, /interruptionMode: "silent"/);
  assert.doesNotMatch(userCancel, /resetContent/);
  assert.match(userCancel, /recordLogoSearchDuration\(job\)/);

  // A cancelled Settings move gives back the tab it opened, and only that tab:
  // an ordinary add cancelled in a tab the user was already on keeps it.
  assert.match(cancelCase, /const wasMoveToTrusted = job\.trustedAdd\?\.moveIntent != null;/);
  assert.match(cancelCase, /if \(wasMoveToTrusted\) \{\s*await abortTrustedAddIntent\(tabId\)/);
  // The bypass never writes anything on its own -- it hands over to the
  // selector, whose confirmation is still the only thing that writes a list.
  assert.doesNotMatch(manualCase, /withTrustedMuted|applyManualLogoSelection/);
});

test("a Settings move handed to the selector is never aborted by the cancelled automatic request", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const addStart = serviceWorker.indexOf('case "add_to_trusted"');
  const addEnd = serviceWorker.indexOf('case "get_trusted_add_intent"', addStart);
  const addCase = serviceWorker.slice(addStart, addEnd);

  assert.match(
    addCase,
    /if \(isMoveToTrusted && !job\.selectorOpened\) \{\s*await abortTrustedAddIntent\(tabId\)/,
    "the original request may clean up a genuine failure, but not a manual/timeout selector handoff"
  );
});

test("logo-search durations are recorded for later tuning", async () => {
  const serviceWorker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");

  // Measured from the click for every add-to-trusted job, recorded once, and
  // carried into the diagnostics record whichever way the search ended.
  assert.match(serviceWorker, /function recordLogoSearchDuration\(job\) \{\s*if \(job\.kind !== "add_to_trusted" \|\| job\.logoSearchMs !== undefined\) return;\s*job\.logoSearchMs = Date\.now\(\) - job\.startedAt;/);
  assert.match(serviceWorker, /logoSearchMs: job\.logoSearchMs/, "a completed search reports its duration");
  assert.match(
    serviceWorker,
    /function recordCancelledDiagnostics[\s\S]*?job\.logoSearchMs === undefined \? \{\} : \{ logo_search_ms: job\.logoSearchMs \}/,
    "an abandoned search reports its duration too"
  );
  assert.match(serviceWorker, /logoSearchMs === undefined \? \{\} : \{ logo_search_ms: logoSearchMs \}/);
});
