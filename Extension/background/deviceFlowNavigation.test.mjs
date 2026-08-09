import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  DEVICE_FLOW_UNKNOWN_SOURCE,
  classifyDeviceFlowNavigation,
  resolveDeviceFlowSourceOrigin,
} from "./deviceFlowNavigation.mjs";

test("document-driven and future transition types retain page attribution", () => {
  for (const details of [
    { transitionType: "link" },
    { transitionType: "form_submit" },
    { transitionType: "link", transitionQualifiers: ["client_redirect"] },
    { transitionType: "link", transitionQualifiers: ["server_redirect"] },
    { transitionType: "future_document_transition" },
  ]) {
    assert.equal(classifyDeviceFlowNavigation(details), "page");
  }
});

test("browser UI transition evidence is classified as direct", () => {
  for (const transitionType of [
    "typed",
    "auto_bookmark",
    "generated",
    "start_page",
    "keyword",
    "keyword_generated",
  ]) {
    assert.equal(classifyDeviceFlowNavigation({ transitionType }), "direct");
  }
  assert.equal(classifyDeviceFlowNavigation({
    transitionType: "link",
    transitionQualifiers: ["client_redirect", "from_address_bar"],
  }), "direct", "address-bar evidence takes priority over page-looking evidence");
});

test("reload and history navigation preserve existing provenance", () => {
  assert.equal(classifyDeviceFlowNavigation({ transitionType: "reload" }), "preserve");
  assert.equal(classifyDeviceFlowNavigation({
    transitionType: "link",
    transitionQualifiers: ["forward_back"],
  }), "preserve");
});

test("a child-frame opener is resolved from that frame, never the top-level tab", async () => {
  const frameQueries = [];
  let tabReads = 0;
  const origin = await resolveDeviceFlowSourceOrigin(
    { sourceTabId: 12, sourceFrameId: 4 },
    {
      getFrame: async (query) => {
        frameQueries.push(query);
        return { url: "https://evil.example/embedded" };
      },
      getTab: async () => {
        tabReads += 1;
        return { url: "https://microsoft.com/" };
      },
    }
  );
  assert.equal(origin, "https://evil.example");
  assert.deepEqual(frameQueries, [{ tabId: 12, frameId: 4 }]);
  assert.equal(tabReads, 0);
});

test("source resolution remains pending until the initiating frame is available", async () => {
  let releaseFrame;
  let settled = false;
  const resolution = resolveDeviceFlowSourceOrigin(
    { sourceTabId: 12, sourceFrameId: 4 },
    {
      getFrame: () => new Promise((resolve) => {
        releaseFrame = resolve;
      }),
      getTab: async () => ({ url: "https://microsoft.com/" }),
    }
  ).then((origin) => {
    settled = true;
    return origin;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  releaseFrame({ url: "https://login.microsoftonline.com/embedded" });
  assert.equal(await resolution, "https://login.microsoftonline.com");
});

test("a missing child frame stays unknown instead of inheriting the top tab's trust", async () => {
  let tabReads = 0;
  const origin = await resolveDeviceFlowSourceOrigin(
    { sourceTabId: 12, sourceFrameId: 4 },
    {
      getFrame: async () => null,
      getTab: async () => {
        tabReads += 1;
        return { url: "https://microsoft.com/" };
      },
    }
  );
  assert.equal(origin, DEVICE_FLOW_UNKNOWN_SOURCE);
  assert.equal(tabReads, 0);
});

test("a missing top frame may safely fall back to the top-level tab URL", async () => {
  const origin = await resolveDeviceFlowSourceOrigin(
    { sourceTabId: 12, sourceFrameId: 0 },
    {
      getFrame: async () => null,
      getTab: async () => ({ url: "https://github.com/settings" }),
    }
  );
  assert.equal(origin, "https://github.com");
});

test("opaque, malformed, and invalid source details stay unknown", async () => {
  const dependencies = {
    getFrame: async () => ({ url: "about:blank" }),
    getTab: async () => null,
  };
  assert.equal(await resolveDeviceFlowSourceOrigin(
    { sourceTabId: 1, sourceFrameId: 1 },
    dependencies
  ), DEVICE_FLOW_UNKNOWN_SOURCE);
  assert.equal(await resolveDeviceFlowSourceOrigin(
    { sourceTabId: -1, sourceFrameId: 0 },
    dependencies
  ), DEVICE_FLOW_UNKNOWN_SOURCE);
});

test("the service worker waits for created-target source preparation before evaluation", async () => {
  const worker = await readFile(new URL("./service_worker.js", import.meta.url), "utf8");
  const committed = worker.indexOf("chrome.webNavigation.onCommitted.addListener");
  const preparationRead = worker.indexOf(
    "createdDeviceFlowTargetPreparations.get(details.tabId)",
    committed
  );
  const preparationAwait = worker.indexOf("Promise.resolve(createdTargetPreparation)", preparationRead);
  const evaluation = worker.indexOf("handleDeviceFlowCommit(details.tabId, details.url)", preparationAwait);
  assert.ok(committed >= 0 && preparationRead > committed);
  assert.ok(preparationAwait > preparationRead);
  assert.ok(evaluation > preparationAwait);

  const created = worker.indexOf("async function recordDeviceFlowNavigationTarget");
  const frameStored = worker.indexOf("sourceFrameId: details.sourceFrameId", created);
  const sourceResolved = worker.indexOf("resolveDeviceFlowRelationshipSource(relationship)", frameStored);
  assert.ok(frameStored > created);
  assert.ok(sourceResolved > frameStored);
});
