const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const POPUP_SOURCE = readFileSync(path.join(__dirname, "popup.js"), "utf8");
const POPUP_HTML = readFileSync(path.join(__dirname, "popup.html"), "utf8");
const MANIFEST = JSON.parse(readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
const WORKER_SOURCE = readFileSync(path.join(__dirname, "../background/service_worker.js"), "utf8");

class FakeElement {
  constructor() {
    this.disabled = false;
    this.hidden = false;
    this.textContent = "";
    this.attributes = new Map();
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  click() {
    const listener = this.listeners.get("click");
    assert.ok(listener, "element must have a click listener");
    listener.call(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

function loadPopup({ tabs = [{ id: 17 }], response = { started: true } } = {}) {
  const elements = new Map([
    ["run-analysis", new FakeElement()],
    ["open-settings", new FakeElement()],
    ["report-issue", new FakeElement()],
    ["report-panel", new FakeElement()],
    ["status", new FakeElement()],
  ]);
  elements.get("report-panel").hidden = true;
  elements.get("status").hidden = true;

  const calls = { closes: 0, messages: [], options: 0, queries: [] };
  const chrome = {
    runtime: {
      openOptionsPage() {
        calls.options += 1;
      },
      async sendMessage(message) {
        calls.messages.push(message);
        return response;
      },
    },
    tabs: {
      async query(query) {
        calls.queries.push(query);
        return tabs;
      },
    },
  };
  const context = {
    chrome,
    document: {
      getElementById(id) {
        return elements.get(id) ?? null;
      },
    },
    window: {
      close() {
        calls.closes += 1;
      },
    },
  };
  vm.runInNewContext(POPUP_SOURCE, context, { filename: "popup.js" });
  return { calls, elements };
}

async function settleClick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("the manifest registers the action popup and its status is a live region", () => {
  assert.equal(MANIFEST.action.default_popup, "popup/popup.html");
  assert.match(POPUP_HTML, /id="status"[^>]*role="status"[^>]*aria-live="polite"/);
});

test("the manifest uses split incognito mode for extension-owned warning tabs", () => {
  assert.equal(MANIFEST.incognito, "split");
});

test("Run manual analysis targets the active tab and closes after starting", async () => {
  const popup = loadPopup();
  popup.elements.get("run-analysis").click();
  await settleClick();

  assert.equal(popup.calls.queries.length, 1);
  assert.equal(popup.calls.queries[0].active, true);
  assert.equal(popup.calls.queries[0].currentWindow, true);
  assert.equal(popup.calls.messages.length, 1);
  assert.equal(popup.calls.messages[0].type, "request_manual_analysis");
  assert.equal(popup.calls.messages[0].tabId, 17);
  assert.equal(popup.calls.closes, 1);
});

test("a manual-analysis refusal stays visible and permits retry", async () => {
  const popup = loadPopup({ response: { started: false, message: "This page cannot be checked." } });
  const button = popup.elements.get("run-analysis");
  const status = popup.elements.get("status");
  button.click();
  await settleClick();

  assert.equal(popup.calls.closes, 0);
  assert.equal(button.disabled, false);
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, "This page cannot be checked.");
});

test("a missing active tab shows a retryable popup error", async () => {
  const popup = loadPopup({ tabs: [] });
  const button = popup.elements.get("run-analysis");
  const status = popup.elements.get("status");
  button.click();
  await settleClick();

  assert.equal(popup.calls.messages.length, 0);
  assert.equal(button.disabled, false);
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, "Could not start the analysis. Try again.");
});

test("Open settings uses the options page and closes the popup", () => {
  const popup = loadPopup();
  popup.elements.get("open-settings").click();
  assert.equal(popup.calls.options, 1);
  assert.equal(popup.calls.closes, 1);
});

test("Report an issue toggles its contact panel and expanded state", () => {
  const popup = loadPopup();
  const button = popup.elements.get("report-issue");
  const panel = popup.elements.get("report-panel");

  button.click();
  assert.equal(panel.hidden, false);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  button.click();
  assert.equal(panel.hidden, true);
  assert.equal(button.getAttribute("aria-expanded"), "false");
});

test("the worker accepts manual-analysis requests only from the exact popup page", () => {
  assert.match(WORKER_SOURCE, /message\?\.type === "request_manual_analysis" && !isPopupSender\(sender\)/);
  const functionSource = WORKER_SOURCE.match(/function isPopupSender\(sender\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource, "isPopupSender must remain independently checkable");
  const isPopupSender = vm.runInNewContext(`${functionSource}; isPopupSender`, {
    chrome: { runtime: { id: "extension-id" } },
    POPUP_PAGE_URL: "chrome-extension://extension-id/popup/popup.html",
  });

  assert.equal(isPopupSender({ id: "extension-id", url: "chrome-extension://extension-id/popup/popup.html" }), true);
  assert.equal(isPopupSender({ id: "other-extension", url: "chrome-extension://extension-id/popup/popup.html" }), false);
  assert.equal(isPopupSender({ id: "extension-id", url: "https://example.test/" }), false);
});

