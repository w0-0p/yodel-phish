// content.js is a classic script (no import/export), so it can be require()d
// directly under plain Node once document/window/chrome are stubbed well
// enough for its top-level code (MutationObserver setup, the init() IIFE) to
// run without throwing. This lets the jobId staleness guards on inbound
// messages -- the "a terminal message belonging to an older job must not
// alter the current UI" requirement -- be verified
// directly against the real listener function, without a browser.
//
// Coverage deliberately stops at that contract: full end-to-end behavior
// (actual banner DOM, actual background round-trips) needs a real browser or
// a much heavier DOM shim, and is out of scope here.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  DETECTION_ATTRIBUTES,
  VISUAL_ATTRIBUTES,
  collectOpenShadowRoots,
} = require("./login-detector.js");

const CONTENT_SCRIPT_PATH = require.resolve("./content.js");

function createFakeButton() {
  const listeners = new Map();
  return {
    hidden: false,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    click() {
      listeners.get("click")?.();
    },
  };
}

function createFakeElement(tagName) {
  // A message is built from segments (plain text plus emphasized runs), so the
  // node accumulates appended text and reports the joined result. `history`
  // records one entry per completed message, not per segment.
  const messageNode = {
    history: [],
    _text: "",
    _open: false,
    get textContent() { return this._text; },
    set textContent(value) {
      this._text = value;
      this._open = false; // a clear ends the previous message
      if (value !== "") this.history.push(value);
    },
    append(...nodes) {
      nodes.forEach((node) => this.appendChild(node));
    },
    appendChild(node) {
      this._text += typeof node === "string" ? node : node.textContent;
      if (this._open) {
        this.history[this.history.length - 1] = this._text;
      } else {
        this.history.push(this._text);
        this._open = true;
      }
      return node;
    },
  };
  return {
    _messageNode: messageNode,
    _renders: 0,
    _html: "",
    _removed: false,
    _attributes: {},
    _buttons: new Map(),
    tagName,
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    disabled: false,
    hidden: false,
    // Enough for the <strong>/<u> wrappers a banner message builds around its
    // emphasized segments.
    textContent: "",
    appendChild(node) {
      this.textContent += typeof node === "string" ? node : node.textContent;
      return node;
    },
    setAttribute(name, value) {
      this._attributes[name] = String(value);
      if (name === "data-verdict") this.dataset.verdict = value;
    },
    getAttribute(name) {
      return this._attributes[name] ?? null;
    },
    getBoundingClientRect() {
      return { width: 10, height: 10, x: 0, y: 0 };
    },
    querySelector(selector) {
      return selector === ".yp-message" ? messageNode : this._buttons.get(selector) ?? null;
    },
    querySelectorAll(selector) {
      const matches = selector
        .split(",")
        .map((part) => this._buttons.get(part.trim()))
        .filter(Boolean);
      return [...new Set(matches)];
    },
    addEventListener() {},
    removeEventListener() {},
    remove() {
      this._removed = true;
    },
    prepend() {},
    set innerHTML(value) {
      this._renders += 1;
      this._html = value;
      this._buttons = new Map();
      for (const match of value.matchAll(/<button class="([^"]+)"/g)) {
        const button = createFakeButton();
        for (const className of match[1].split(/\s+/)) {
          this._buttons.set(`.${className}`, button);
        }
      }
    },
  };
}

// Loads a fresh instance of content.js with a minimal DOM/chrome stub.
// content.js consumes the heuristic through the login-detector.js global;
// these lifecycle tests drive it with `loginState.isLoginPage`, read live, so
// they can verify that automatic entry remains gated while an explicit
// `manual_trigger` bypasses the heuristic. The heuristic itself is covered
// directly in login-detector.test.js.
function loadContentScript({
  url = "https://example.test/login",
  deviceFlow = { active: false },
  deviceFlowRejects = false,
  bodyChildren = [],
} = {}) {
  const sentMessages = [];
  let onMessageListener = null;
  const loginState = { isLoginPage: false };

  const submitListeners = new Set();
  const documentListenerTypes = [];
  // Emphasis in a banner message is real <strong>/<u>/<br> elements, so the
  // only way to see it is to record what was created.
  const createdElements = [];
  let lastPrepended = null;
  let prependCount = 0;
  const fakeBody = createFakeElement("body");
  fakeBody.prepend = (node) => {
    lastPrepended = node;
    prependCount += 1;
  };
  // The Shadow-root walk reads `children`/`shadowRoot`, so the body needs a
  // real (if tiny) tree to walk. `bodyChildren` is what tests populate.
  fakeBody.children = bodyChildren;

  const fakeDocument = {
    title: "",
    body: fakeBody,
    images: [],
    getAnimations: () => [],
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    createElement(tag) {
      const element = createFakeElement(tag);
      createdElements.push(element);
      return element;
    },
    createTextNode(text) {
      return { textContent: text };
    },
    // The submission guard is a capture-phase "submit" listener on the
    // document, so installing and removing it is observable here.
    addEventListener(type, listener) {
      documentListenerTypes.push(type);
      if (type === "submit") submitListeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "submit") submitListeners.delete(listener);
    },
  };

  const sendMessageBehaviors = new Map();
  // init() queries this before any DOM-based login detection (issue #39); the
  // default answers "no device-flow risk" so every other test is unaffected.
  sendMessageBehaviors.set("get_device_flow_status", () =>
    deviceFlowRejects ? Promise.reject(new Error("no service worker")) : Promise.resolve({ ok: true, ...deviceFlow })
  );

  const fakeChrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          onMessageListener = fn;
        },
      },
      sendMessage(message) {
        sentMessages.push(message);
        const behavior = sendMessageBehaviors.get(message.type);
        if (behavior !== undefined) return behavior(message);
        return Promise.resolve({});
      },
    },
  };

  const fakeWindow = {
    addEventListener() {},
    removeEventListener() {},
    // The page's own scheme decides whether it may be analysed automatically
    // (issue #25), so the stub carries both halves of the real location.
    location: { href: url, protocol: new URL(url).protocol },
    getComputedStyle() {
      return { display: "block", visibility: "visible", opacity: "1" };
    },
  };

  let observerCallback = null;
  let observerOptions = null;
  const observedTargets = [];
  class FakeMutationObserver {
    constructor(callback) {
      observerCallback = callback;
    }
    observe(target, options) {
      observedTargets.push(target);
      observerOptions = options;
    }
    disconnect() {}
  }

  global.document = fakeDocument;
  global.window = fakeWindow;
  global.chrome = fakeChrome;
  global.confirm = () => true;
  global.MutationObserver = FakeMutationObserver;
  global.Node = { ELEMENT_NODE: 1 };
  global.YodelLoginDetector = {
    DETECTION_ATTRIBUTES,
    VISUAL_ATTRIBUTES,
    collectOpenShadowRoots,
    detectLoginPage: () =>
      loginState.isLoginPage ? { isLogin: true, confidence: 0.9 } : { isLogin: false, confidence: 0 },
  };

  delete require.cache[CONTENT_SCRIPT_PATH];
  require(CONTENT_SCRIPT_PATH);

  return {
    loginState,
    sentMessages,
    // Feeds a batch of MutationRecord-shaped objects to the real observer
    // callback, exactly as the browser would.
    emitMutations(records) {
      observerCallback(records);
    },
    get observedAttributes() {
      return observerOptions?.attributeFilter ?? [];
    },
    get observedTargets() {
      return observedTargets;
    },
    get documentListenerTypes() {
      return documentListenerTypes;
    },
    createdWithTag(tagName) {
      return createdElements.filter((element) => element.tagName === tagName);
    },
    // Installs a one-off response/rejection for the next sendMessage of a
    // given type (e.g. "run_pipeline") -- used to simulate an explicit
    // {error} response or a rejected dispatch.
    setSendMessageBehavior(type, behavior) {
      sendMessageBehaviors.set(type, behavior);
    },
    dispatch(message) {
      let response;
      let responded = false;
      onMessageListener(message, {}, (value) => {
        responded = true;
        response = value;
      });
      return { responded, get response() { return response; } };
    },
    lastMessageOfType(type) {
      return [...sentMessages].reverse().find((m) => m.type === type);
    },
    get bannerMessage() {
      return lastPrepended?._messageNode.textContent ?? "";
    },
    get bannerCount() {
      return prependCount;
    },
    get bannerRemoved() {
      return lastPrepended?._removed ?? false;
    },
    get bannerVerdict() {
      return lastPrepended?.dataset.verdict;
    },
    get bannerHtml() {
      return lastPrepended?._html ?? "";
    },
    get bannerRenders() {
      return lastPrepended?._renders ?? 0;
    },
    get bannerHistory() {
      return lastPrepended?._messageNode.history ?? [];
    },
    get bannerRole() {
      return lastPrepended?.getAttribute("role");
    },
    bannerButton(selector) {
      return lastPrepended?.querySelector(selector) ?? null;
    },
    get submissionBlocked() {
      return submitListeners.size > 0;
    },
    // Fires an ordinary cancellable form submission at the installed guard.
    submitForm() {
      let prevented = false;
      const event = { cancelable: true, preventDefault() { prevented = true; } };
      for (const listener of submitListeners) listener(event);
      return prevented;
    },
    // Establishes a "current job in flight" without any exported hooks by
    // firing the same explicit manual_trigger path the action popup uses.
    // Returns the job id from the run_pipeline message content.js sent.
    startJobViaManualTrigger() {
      this.dispatch({ type: "manual_trigger" });
      const started = this.lastMessageOfType("run_pipeline");
      assert.ok(started, "manual_trigger should have dispatched run_pipeline");
      return started.jobId;
    },
    startJobViaTrustedAdd() {
      this.dispatch({ type: "show_banner", verdict: "unknown", data: {} });
      this.bannerButton(".yp-btn-add").click();
      const started = this.lastMessageOfType("add_to_trusted");
      assert.ok(started, "the Add button should have dispatched add_to_trusted");
      return started.jobId;
    },
  };
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Issue #15: the service worker can only distinguish "the click was handled"
// from "the click never arrived" if every manual trigger answers explicitly.
test("a manual trigger that starts an analysis reports started", () => {
  const page = loadContentScript();
  page.loginState.isLoginPage = true;

  const { responded, response } = page.dispatch({ type: "manual_trigger" });

  assert.equal(responded, true);
  assert.equal(response.status, "started");
  assert.equal(response.jobId, page.lastMessageOfType("run_pipeline")?.jobId);
});

test("a manual trigger bypasses a negative login heuristic and uses neutral progress wording", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();

  const { responded, response } = page.dispatch({ type: "manual_trigger" });

  assert.equal(responded, true);
  assert.equal(response.status, "started");
  assert.equal(response.jobId, page.lastMessageOfType("run_pipeline")?.jobId);

  page.dispatch({ type: "capture_complete", jobId: response.jobId });
  context.mock.timers.tick(300);
  assert.equal(page.bannerVerdict, "analysing_manual");
  assert.match(page.bannerMessage, /Manual analysis in progress/);
  assert.doesNotMatch(page.bannerMessage, /Login detected/i);
});

test("a manual trigger while a job is in flight reports analysing and leaves it alone", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();
  const beforeCount = page.sentMessages.length;
  page.loginState.isLoginPage = true;

  const { responded, response } = page.dispatch({ type: "manual_trigger" });

  assert.equal(responded, true);
  assert.deepEqual(response, { ok: true, status: "analysing", jobId });
  assert.equal(page.sentMessages.length, beforeCount, "the running job must not be restarted or re-rendered");
});

test("silent same-document cancellation releases the old job and analyses the new state", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const url = "https://example.test/login#password";
  const page = loadContentScript({ url });
  const oldJobId = page.startJobViaManualTrigger();
  page.loginState.isLoginPage = true;

  assert.equal(page.submissionBlocked, true);
  page.dispatch({
    type: "analysis_cancelled_silently",
    jobId: oldJobId,
    reanalyseUrl: url,
  });

  assert.equal(page.submissionBlocked, false, "the cancelled job must release the form immediately");
  assert.equal(page.bannerCount, 0, "silent cancellation must not render a warning banner");
  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "active");

  context.mock.timers.tick(250);
  const runs = page.sentMessages.filter((message) => message.type === "run_pipeline");
  assert.equal(runs.length, 2, "the surviving route must run ordinary login detection again");
  assert.notEqual(runs[1].jobId, oldJobId);
  assert.equal(page.submissionBlocked, true, "the replacement analysis owns a fresh form guard");
});

test("silent cancellation for an older job cannot reset a newer analysis", () => {
  const page = loadContentScript();
  const oldJobId = page.startJobViaManualTrigger();
  page.dispatch({ type: "show_banner", jobId: oldJobId, verdict: "trusted", data: {} });
  const newJobId = page.startJobViaManualTrigger();
  const beforeCount = page.sentMessages.length;

  page.dispatch({
    type: "analysis_cancelled_silently",
    jobId: oldJobId,
    reanalyseUrl: "https://example.test/other-state",
  });

  assert.equal(page.submissionBlocked, true);
  assert.equal(page.sentMessages.length, beforeCount, "a stale reset must have no UI or icon side effects");
  assert.deepEqual(page.dispatch({ type: "manual_trigger" }).response, {
    ok: true,
    status: "analysing",
    jobId: newJobId,
  });
});

test("capture lifecycle messages are accepted only for the current job", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  const stalePreparation = page.dispatch({
    type: "prepare_capture",
    jobId: "some-older-job-id",
  });
  assert.equal(stalePreparation.responded, true);
  assert.deepEqual(stalePreparation.response, { ok: false, reason: "stale_job" });

  page.dispatch({ type: "capture_complete", jobId: "some-older-job-id" });
  context.mock.timers.tick(300);
  assert.equal(page.bannerCount, 0, "an old capture must not release the current job's hidden progress");

  page.dispatch({ type: "capture_complete", jobId });
  context.mock.timers.tick(300);
  assert.equal(page.bannerVerdict, "analysing_manual");
});

test("a show_banner for an older job is rejected as stale and does not touch icon/UI state", () => {
  const page = loadContentScript();
  page.startJobViaManualTrigger();
  const beforeCount = page.sentMessages.length;

  const { response } = page.dispatch({
    type: "show_banner",
    jobId: "some-older-job-id",
    verdict: "trusted",
    data: {},
  });

  assert.deepEqual(response, { accepted: false, reason: "stale_job" });
  assert.equal(page.sentMessages.length, beforeCount, "a stale message must not send any new state-changing messages");
});

test("a show_banner for the current job is accepted and updates icon state", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  const { response } = page.dispatch({ type: "show_banner", jobId, verdict: "trusted", data: {} });

  assert.deepEqual(response, { accepted: true });
  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "safe");
});

test("an analysis_failed for an older job is ignored", () => {
  const page = loadContentScript();
  page.startJobViaManualTrigger();
  const beforeCount = page.sentMessages.length;

  page.dispatch({ type: "analysis_failed", jobId: "some-older-job-id", code: "analysis_failed" });

  assert.equal(page.sentMessages.length, beforeCount, "a stale failure must not alter current UI/icon state");
});

test("an analysis_failed for the current job clears state and sets the failed icon", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  page.dispatch({ type: "analysis_failed", jobId, code: "request_timeout" });

  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "failed");
});

test("an analysis_interrupted for an older job is ignored", () => {
  const page = loadContentScript();
  page.startJobViaManualTrigger();
  const beforeCount = page.sentMessages.length;

  page.dispatch({ type: "analysis_interrupted", jobId: "some-older-job-id" });

  assert.equal(page.sentMessages.length, beforeCount);
});

test("an analysis_interrupted for the current job sets the interrupted icon", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  page.dispatch({ type: "analysis_interrupted", jobId });

  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "interrupted");
});

test("a rejected run_pipeline dispatch is treated as a terminal failure", async () => {
  const page = loadContentScript();
  page.setSendMessageBehavior("run_pipeline", () => Promise.reject(new Error("service worker unavailable")));

  page.loginState.isLoginPage = true;
  page.dispatch({ type: "manual_trigger" });
  page.loginState.isLoginPage = false;
  await nextTick();

  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "failed");
});

test("an explicit {error} response to run_pipeline is treated as a terminal failure", async () => {
  const page = loadContentScript();
  page.setSendMessageBehavior("run_pipeline", () => Promise.resolve({ error: true, code: "queue_overloaded" }));

  page.loginState.isLoginPage = true;
  page.dispatch({ type: "manual_trigger" });
  page.loginState.isLoginPage = false;
  await nextTick();

  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "failed");
  assert.match(page.bannerMessage, /too many pages are waiting/);
});

test("a late interruption cannot overwrite a completed job", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();
  page.dispatch({ type: "show_banner", jobId, verdict: "trusted", data: {} });
  const beforeCount = page.sentMessages.length;

  page.dispatch({ type: "analysis_interrupted", jobId });

  assert.equal(page.sentMessages.length, beforeCount);
  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "safe");
});

test("a late continue message cannot replace a completed job with unverified state", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();
  page.dispatch({ type: "show_banner", jobId, verdict: "trusted", data: {} });
  const beforeCount = page.sentMessages.length;

  const result = page.dispatch({ type: "continue_without_analysis", jobId });

  assert.equal(result.responded, false);
  assert.equal(page.sentMessages.length, beforeCount);
  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "safe");
});

test("raw background error text is never rendered into the failure banner", async () => {
  const page = loadContentScript();
  page.setSendMessageBehavior("run_pipeline", () => Promise.resolve({
    error: true,
    code: "unrecognized_code",
    reason: "<img src=x onerror=alert(1)>",
  }));

  page.loginState.isLoginPage = true;
  page.dispatch({ type: "manual_trigger" });
  page.loginState.isLoginPage = false;
  await nextTick();

  assert.equal(page.bannerMessage, "Analysis could not be completed. You can try again.");
  assert.doesNotMatch(page.bannerMessage, /<img|onerror|alert/);
});


test("the content deadline reports cancellation and reaches a terminal failure locally", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  context.mock.timers.tick(290_000);

  assert.deepEqual(page.lastMessageOfType("analysis_client_timed_out"), {
    type: "analysis_client_timed_out",
    jobId,
  });
  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "failed");
  assert.match(page.bannerMessage, /page deadline/);
});


test("the OpenCV loader stays idle for clipboard-only use and reports a bounded startup failure after ping", () => {
  const loaderPath = require.resolve("../runtime/loader.js");
  const originalNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  const originalDocument = global.document;
  const originalChrome = global.chrome;
  const originalCv = global.cv;
  const timers = [];
  const sent = [];
  const listeners = [];
  const appendedScripts = [];
  let now = 0;

  try {
    Date.now = () => now;
    global.setTimeout = (callback) => {
      timers.push(callback);
      return timers.length;
    };
    global.cv = undefined;
    global.document = {
      body: { appendChild(script) { appendedScripts.push(script.src); } },
      createElement() {
        return {};
      },
    };
    global.chrome = {
      runtime: {
        getURL: (path) => path,
        sendMessage: (message) => {
          sent.push(message);
          return Promise.resolve();
        },
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          },
        },
        id: "extension-id",
      },
    };

    delete require.cache[loaderPath];
    require(loaderPath);
    assert.deepEqual(appendedScripts, [], "clipboard-only startup must not load OpenCV");
    assert.deepEqual(timers, [], "clipboard-only startup must not begin polling");

    listeners[0](
      { target: "yodel-offscreen", type: "ping" },
      { id: "extension-id", url: "dist/service_worker.js" }
    );
    assert.deepEqual(appendedScripts, ["opencv/opencv.js"]);
    while (sent.length === 0 && timers.length > 0) {
      now += 5_000;
      timers.shift()();
    }

    assert.deepEqual(sent, [{ type: "offscreen_runtime_failed", reason: "opencv_timeout" }]);
    assert.ok(now <= 35_000, "startup failure must be reported near the configured 30s deadline");
  } finally {
    Date.now = originalNow;
    global.setTimeout = originalSetTimeout;
    global.document = originalDocument;
    global.chrome = originalChrome;
    global.cv = originalCv;
    delete require.cache[loaderPath];
  }
});

test("a verdict that arrives immediately never paints the progress banner", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  // The analysis resolves before the delayed progress state would have been
  // painted -- so it is not painted at all.
  page.dispatch({ type: "show_banner", jobId, verdict: "trusted", data: {} });
  context.mock.timers.tick(5_000);

  assert.deepEqual(page.bannerHistory, ["Safe."]);
  assert.equal(page.bannerCount, 1);
  assert.equal(page.bannerRole, "status");
});

test("an existing banner does not make a fast progress state flash", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  page.dispatch({ type: "show_banner", verdict: "unknown", data: {} });
  const jobId = page.startJobViaManualTrigger();

  assert.equal(page.bannerVerdict, "unknown");
  context.mock.timers.tick(200);
  assert.equal(page.bannerVerdict, "unknown");

  page.dispatch({ type: "show_banner", jobId, verdict: "trusted", data: {} });
  context.mock.timers.tick(5_000);

  assert.equal(page.bannerVerdict, "trusted");
  assert.doesNotMatch(page.bannerHistory.join("\n"), /analysis in progress/i);
  assert.equal(page.bannerCount, 1);
});

test("a failure that arrives immediately replaces progress without waiting", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  page.dispatch({ type: "analysis_failed", jobId, code: "queue_overloaded" });

  assert.match(page.bannerMessage, /too many pages are waiting/);
  assert.equal(page.bannerCount, 1, "the failure must not wait for the progress delay");
  context.mock.timers.tick(5_000);
  assert.match(page.bannerMessage, /too many pages are waiting/, "the elapsed delay must not paint progress over a result");
});

test("a slow manual analysis shows neutral progress once, then updates the same element in place", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  page.dispatch({ type: "capture_complete", jobId });
  context.mock.timers.tick(300);
  assert.match(page.bannerMessage, /Manual analysis in progress/);
  assert.doesNotMatch(page.bannerMessage, /Login detected/i);
  assert.equal(page.bannerVerdict, "analysing_manual");

  page.dispatch({ type: "show_banner", jobId, verdict: "suspicious", data: { fqdn: "site.test" } });

  assert.equal(page.bannerCount, 1, "the result must reuse the banner, not build a second one");
  assert.equal(page.bannerRemoved, false, "the banner must not disappear between two states");
  assert.equal(page.bannerVerdict, "suspicious");
  assert.match(page.bannerMessage, /Potential risk detected/);
});

// Issue #77 -- the screenshot must not contain the banner, so anything painted
// before the capture has to be hidden for it and shown again afterwards. The
// user reads that as two banners. Progress therefore waits for the capture.
test("progress never appears before the screenshot that would have hidden it", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  // Well past the ordinary 250 ms delay, and past the one-second stability
  // wait the capture itself may spend: still nothing on screen.
  context.mock.timers.tick(1_500);
  assert.equal(page.bannerCount, 0, "no banner may exist while the screenshot is still pending");

  page.dispatch({ type: "capture_complete", jobId });
  context.mock.timers.tick(300);

  assert.equal(page.bannerCount, 1, "the banner appears once, after the capture");
  assert.deepEqual(page.bannerHistory, ["Manual analysis in progress…"]);
});

// Issue #77 again: a trusted verdict is decided before the analysis runs, so it
// used to be painted before the screenshot and then hidden for it -- "Safe."
// appeared, vanished and came back. Only the paint waits for the capture; the
// form and the icon are released at once, because neither is in the screenshot.
test("a provisional trusted verdict waits for the screenshot but releases the page at once", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  page.dispatch({ type: "show_banner", jobId, verdict: "trusted", data: {}, provisional: true });

  assert.equal(page.bannerCount, 0, "no verdict may be painted while the screenshot is still pending");
  assert.equal(page.submissionBlocked, false, "a trusted page must not stay blocked for the drift check");
  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "safe");

  page.dispatch({ type: "capture_complete", jobId });

  assert.equal(page.bannerCount, 1, "the capture is what paints the verdict");
  assert.deepEqual(page.bannerHistory, ["Safe."]);

  // The drift check is still running: its progress must not take the verdict's
  // place, and the verdict must not be repainted as a second banner.
  context.mock.timers.tick(5_000);
  assert.equal(page.bannerVerdict, "trusted");
  assert.equal(page.bannerCount, 1);
  assert.deepEqual(page.bannerHistory, ["Safe."]);
});

test("a capture that never reports back still gets a progress banner", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  page.startJobViaManualTrigger();

  // A worker that died mid-analysis sends no capture_complete. Waiting for the
  // job deadline in silence would be worse than showing progress late.
  context.mock.timers.tick(2_000);

  assert.equal(page.bannerCount, 1);
  assert.equal(page.bannerVerdict, "analysing_manual");
});

test("a verdict during the capture window is not held back by it", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  // No capture_complete: a result that arrives first must still paint at once,
  // and must not leave the next analysis waiting on a stale capture window.
  page.dispatch({ type: "show_banner", jobId, verdict: "trusted", data: {} });

  assert.equal(page.bannerCount, 1);
  assert.deepEqual(page.bannerHistory, ["Safe."]);
});

test("preparing and analysing are one progress presentation", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();
  page.dispatch({ type: "capture_complete", jobId });
  context.mock.timers.tick(300);
  const rendersAfterProgress = page.bannerRenders;

  // capture_complete re-asserts the progress state mid-analysis; it used to
  // replace a "preparing" banner with an "analysing" one.
  page.dispatch({ type: "capture_complete", jobId });

  assert.equal(page.bannerCount, 1, "the two progress states must not be two banners");
  assert.equal(page.bannerRenders, rendersAfterProgress, "the progress state must not repaint itself");
  assert.deepEqual(page.bannerHistory, ["Manual analysis in progress…"]);
});

test("a provisional verdict followed by the same final verdict repaints nothing", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  page.dispatch({ type: "show_banner", jobId, verdict: "trusted", data: {}, provisional: true });
  page.dispatch({ type: "capture_complete", jobId });
  const rendersAfterProvisional = page.bannerRenders;
  page.dispatch({ type: "show_banner", jobId, verdict: "trusted", data: {} });

  assert.equal(page.bannerCount, 1, "the final verdict must land on the provisional banner, not a new one");
  assert.equal(page.bannerRenders, rendersAfterProvisional, "identical content must be a no-op");
  assert.deepEqual(page.bannerHistory, ["Safe."]);
  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "safe");
});

test("a replaced state leaves none of the previous state's buttons behind", () => {
  const page = loadContentScript();
  page.dispatch({ type: "show_banner", verdict: "unknown", data: {} });
  assert.ok(page.bannerButton(".yp-btn-add"));
  assert.match(page.bannerHtml, /yp-btn-add/);
  assert.match(page.bannerHtml, /yp-btn-mute/);

  page.dispatch({ type: "show_banner", verdict: "muted_confirmation", data: { fqdn: "site.test" } });

  assert.equal(page.bannerButton(".yp-btn-add"), null);
  assert.doesNotMatch(page.bannerHtml, /yp-btn-add|yp-btn-mute|yp-btn-reanalyse/);
  assert.match(page.bannerHtml, /yp-btn-close-x/);
  assert.equal(page.bannerCount, 1);

  page.bannerButton(".yp-btn-close-x").click();
  assert.equal(page.bannerRemoved, true, "the replacement button has its own live handler");
});

function analyseOnPageChange(page, context) {
  page.loginState.isLoginPage = true;
  page.dispatch({ type: "page_history_changed" });
  context.mock.timers.tick(250);
}

test("a login page is analysed automatically over http and https", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });

  for (const url of ["https://example.test/login", "http://example.test/login"]) {
    const page = loadContentScript({ url });
    analyseOnPageChange(page, context);

    assert.ok(page.lastMessageOfType("run_pipeline"), `${url} should be analysed automatically`);
  }
});

test("automatic analysis retains login-detected progress wording", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();

  analyseOnPageChange(page, context);
  const jobId = page.lastMessageOfType("run_pipeline")?.jobId;
  page.dispatch({ type: "capture_complete", jobId });
  context.mock.timers.tick(300);

  assert.equal(page.bannerVerdict, "analysing");
  assert.match(page.bannerMessage, /Login detected/);
  assert.doesNotMatch(page.bannerMessage, /Manual analysis/);
});

test("a login page on a file URL is analysed automatically when the content script is present", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript({ url: "file:///home/user/login.html" });

  analyseOnPageChange(page, context);

  assert.ok(page.lastMessageOfType("run_pipeline"), "a permitted file page should be analysed like a web page");
});

test("a file page is scanned when the user asks for it through the action", () => {
  const page = loadContentScript({ url: "file:///home/user/login.html" });

  const { response } = page.dispatch({ type: "manual_trigger" });

  assert.equal(response.status, "started");
  assert.ok(
    page.lastMessageOfType("run_pipeline"),
    "an explicit click must bypass login detection and reach the worker's file-scan gate"
  );
});

test("the page never tells the worker which URL to analyse", () => {
  const page = loadContentScript();
  page.startJobViaManualTrigger();

  for (const message of page.sentMessages) {
    assert.equal(message.url, undefined, `${message.type} must leave the URL to the sender Chrome vouched for`);
  }
});

// =============================================================================
// Issue #11: observer→detector→pipeline lifecycle. The heuristic itself is
// tested directly against DOM fixtures in login-detector.test.js; here the
// stubbed detector flips between "no login" and "login" to verify *when*
// detection re-runs and reaches the pipeline.
// =============================================================================

function elementNode(tagName = "DIV") {
  return { nodeType: 1, parentElement: null, tagName };
}

test("an attribute-only change that activates a hidden login UI triggers the pipeline", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  page.loginState.isLoginPage = true;

  // e.g. a login dialog losing its inert attribute — no insertion, no pixels.
  page.emitMutations([{ type: "attributes", target: elementNode(), attributeName: "inert" }]);
  context.mock.timers.tick(250);

  assert.ok(page.lastMessageOfType("run_pipeline"), "detection-relevant attribute changes must re-enter detection");
});

test("identity-metadata attribute changes re-enter detection", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  page.loginState.isLoginPage = true;

  page.emitMutations([{ type: "attributes", target: elementNode(), attributeName: "placeholder" }]);
  context.mock.timers.tick(250);

  assert.ok(page.lastMessageOfType("run_pipeline"));
});

test("the observer subscribes to the detector's complete shared attribute list", () => {
  const page = loadContentScript();

  for (const attribute of DETECTION_ATTRIBUTES) {
    assert.equal(page.observedAttributes.includes(attribute), true, attribute + " must be observed");
  }
});

test("attribute changes outside the observed sets stay insignificant", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  page.loginState.isLoginPage = true;

  page.emitMutations([{ type: "attributes", target: elementNode(), attributeName: "data-state" }]);
  context.mock.timers.tick(250);

  assert.equal(page.lastMessageOfType("run_pipeline"), undefined);
});

test("dynamically inserted credential fields trigger exactly one pipeline run", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  page.loginState.isLoginPage = true;

  page.emitMutations([{ type: "childList", target: elementNode(), addedNodes: [elementNode("INPUT")], removedNodes: [] }]);
  page.emitMutations([{ type: "childList", target: elementNode(), addedNodes: [elementNode("DIV")], removedNodes: [] }]);
  context.mock.timers.tick(250);
  page.emitMutations([{ type: "childList", target: elementNode(), addedNodes: [elementNode("DIV")], removedNodes: [] }]);
  context.mock.timers.tick(250);

  const runs = page.sentMessages.filter((message) => message.type === "run_pipeline");
  assert.equal(runs.length, 1, "churn around one insertion must not start a second job");
});

test("automatic mutation handling remains gated when the page is not a detected login", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();

  page.emitMutations([{ type: "attributes", target: elementNode(), attributeName: "type" }]);
  context.mock.timers.tick(250);

  assert.equal(page.lastMessageOfType("run_pipeline"), undefined);
  assert.equal(page.bannerCount, 0);
});

// =============================================================================
// Issue #19: the capture-phase submit guard is on only while the current
// analysis, or a decision the user can actually act on, is pending -- and no
// terminal path may leave it behind.
// =============================================================================

test("a cancellable submission is prevented while an analysis is pending", () => {
  const page = loadContentScript();
  assert.equal(page.submissionBlocked, false, "an idle page must not block anything");

  page.startJobViaManualTrigger();

  assert.equal(page.submissionBlocked, true);
  assert.equal(page.submitForm(), true, "the pending analysis must prevent the submission");
});

test("a verdict, a failure and an explicit continuation each release the page", () => {
  const releases = {
    "a verdict": (page, jobId) => page.dispatch({ type: "show_banner", jobId, verdict: "unknown", data: {} }),
    "a failure": (page, jobId) => page.dispatch({ type: "analysis_failed", jobId, code: "request_timeout" }),
    "a continuation": (page, jobId) => {
      page.dispatch({ type: "analysis_interrupted", jobId });
      page.dispatch({ type: "continue_without_analysis", jobId });
    },
  };

  for (const [label, terminate] of Object.entries(releases)) {
    const page = loadContentScript();
    terminate(page, page.startJobViaManualTrigger());

    assert.equal(page.submissionBlocked, false, `${label} must release the page`);
    assert.equal(page.submitForm(), false);
  }
});

test("the content-side deadline releases the page on its own", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadContentScript();
  page.startJobViaManualTrigger();

  context.mock.timers.tick(290_000);

  assert.equal(page.submissionBlocked, false, "a job nobody ever answered must not block the page forever");
  assert.match(page.bannerMessage, /page deadline/);
});

test("a terminal message for another job leaves the current block in place", () => {
  const page = loadContentScript();
  page.startJobViaManualTrigger();

  page.dispatch({ type: "analysis_failed", jobId: "some-older-job-id", code: "request_timeout" });
  page.dispatch({ type: "analysis_interrupted", jobId: "some-older-job-id" });
  page.dispatch({ type: "show_banner", jobId: "some-older-job-id", verdict: "unknown", data: {} });

  assert.equal(page.submissionBlocked, true, "a stale job must not unblock the page the current one is guarding");
});

test("an interruption keeps the page blocked behind an explanation that cannot be dismissed", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  page.dispatch({ type: "analysis_interrupted", jobId });

  assert.equal(page.submissionBlocked, true);
  assert.equal(page.bannerVerdict, "interrupted");
  assert.doesNotMatch(page.bannerHtml, /yp-btn/, "the only explanation of a blocked page must stay on screen");
});

test("an interruption with no decision UI releases the page with a retryable failure", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();
  page.dispatch({ type: "analysis_interrupted", jobId });

  // What the worker sends when it could not open the interruption tab.
  page.dispatch({ type: "analysis_failed", jobId, code: "interruption_unavailable" });

  assert.equal(page.submissionBlocked, false);
  assert.equal(page.submitForm(), false);
  assert.match(page.bannerMessage, /recovery tab could not be opened/);
  assert.match(page.bannerHtml, /yp-btn-retry/);
});

test("an unavailable interruption retries the original add-to-trusted action", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaTrustedAdd();
  page.dispatch({ type: "analysis_interrupted", jobId });
  page.dispatch({ type: "analysis_failed", jobId, code: "interruption_unavailable" });

  page.bannerButton(".yp-btn-retry").click();

  const trustedAdds = page.sentMessages.filter((message) => message.type === "add_to_trusted");
  assert.equal(trustedAdds.length, 2);
  assert.equal(page.lastMessageOfType("run_pipeline"), undefined);
});

// =============================================================================
// DEVICE-CODE PHISHING (issue #39) — this check runs before, and independently
// of, the DOM-based login detector above; init() awaits it first.
// =============================================================================

test("device-flow risk shows the High Risk Login banner and never runs the normal pipeline", async () => {
  const page = loadContentScript({ deviceFlow: { active: true, provider: "GitHub" } });
  await nextTick();

  assert.equal(page.bannerVerdict, "high_risk_login");
  assert.match(page.bannerMessage, /High Risk Device Code Login/);
  assert.match(page.bannerMessage, /GitHub/);
  assert.equal(page.lastMessageOfType("run_pipeline"), undefined);
  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "device_flow");
});

test("device-flow protection runs on a file page when the content script is present", async () => {
  const page = loadContentScript({
    url: "file:///home/user/device-help.html",
    deviceFlow: { active: true, provider: "GitHub" },
  });
  await nextTick();

  assert.equal(page.bannerVerdict, "high_risk_login");
  assert.match(page.bannerMessage, /GitHub/);
  assert.equal(page.lastMessageOfType("run_pipeline"), undefined);
  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "device_flow");
});

test("manual analysis keeps the device-flow advisory and reports back to the popup", async () => {
  const page = loadContentScript({ deviceFlow: { active: true, provider: "GitHub" } });
  await nextTick();
  const bannerCount = page.bannerCount;

  const { response } = page.dispatch({ type: "manual_trigger" });
  assert.deepEqual(response, { ok: true, status: "device_flow_active" });
  assert.equal(page.bannerVerdict, "high_risk_login");
  assert.equal(page.bannerCount, bannerCount);
  assert.equal(page.lastMessageOfType("run_pipeline"), undefined);

  const rejected = page.dispatch({ type: "show_banner", verdict: "trusted", data: {} }).response;
  assert.deepEqual(rejected, { accepted: false, reason: "device_flow_active" });
  assert.equal(page.bannerVerdict, "high_risk_login");
  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "device_flow");
});

test("device-flow risk overrides a page that would otherwise be detected as a login page", async () => {
  const page = loadContentScript({ deviceFlow: { active: true, provider: "GitHub" } });
  page.loginState.isLoginPage = true; // would trigger the normal pipeline if device-flow did not win first
  await nextTick();

  assert.equal(page.bannerVerdict, "high_risk_login");
  assert.equal(page.lastMessageOfType("run_pipeline"), undefined);
});

test("the High Risk Login banner offers no add-to-trusted or mute controls", async () => {
  const page = loadContentScript({ deviceFlow: { active: true, provider: "GitHub" } });
  await nextTick();

  assert.doesNotMatch(page.bannerHtml, /yp-btn-add/);
  assert.doesNotMatch(page.bannerHtml, /yp-btn-mute/);
  assert.match(page.bannerHtml, /yp-btn-close-x/);
});
test("same-document navigation clears and can re-enter device-flow handling", async (context) => {
  const page = loadContentScript({ deviceFlow: { active: true, provider: "GitHub" } });
  await nextTick();
  await nextTick();
  context.mock.timers.enable({ apis: ["setTimeout"] });

  page.dispatch({ type: "page_history_changed", deviceFlow: { active: false } });
  assert.equal(page.bannerRemoved, true);
  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "active");

  page.dispatch({ type: "page_history_changed", deviceFlow: { active: true, provider: "Google" } });
  assert.equal(page.bannerVerdict, "high_risk_login");
  assert.match(page.bannerMessage, /Google/);
  assert.equal(page.lastMessageOfType("set_icon_state")?.state, "device_flow");
});

test("DOM changes never restart the pipeline while device-flow risk is active", async (context) => {
  const page = loadContentScript({ deviceFlow: { active: true, provider: "GitHub" } });
  await nextTick(); // let the device-flow check resolve under real timers first

  context.mock.timers.enable({ apis: ["setTimeout"] });
  page.loginState.isLoginPage = true;
  page.dispatch({ type: "page_history_changed" });
  context.mock.timers.tick(250);

  assert.equal(page.lastMessageOfType("run_pipeline"), undefined);
});

test("no device-flow risk lets the normal pipeline run exactly as before", async () => {
  const page = loadContentScript({ deviceFlow: { active: false } });
  page.loginState.isLoginPage = true;
  await nextTick();

  assert.equal(page.bannerVerdict, undefined);
  // detectLoginPage() only re-runs on the next observed page change or manual
  // trigger; asserting no crash and no stray device-flow banner is the point.
  assert.notEqual(page.lastMessageOfType("set_icon_state")?.state, "device_flow");
});

test("an unreachable background for the device-flow check fails open to normal detection", async () => {
  const page = loadContentScript({ deviceFlowRejects: true });
  page.loginState.isLoginPage = true;
  await nextTick();

  assert.ok(page.lastMessageOfType("run_pipeline"), "normal detection should still run when the device-flow check fails");
  assert.notEqual(page.bannerVerdict, "high_risk_login");
});

// =============================================================================
// Issue #88 — Shadow DOM observation and child-frame login reports.
// =============================================================================

// init() resolves through a handful of awaited microtasks and no timer, so it
// can be settled while setTimeout is mocked.
async function settleInit() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function shadowRootNode(children = []) {
  return { children };
}

function shadowHostNode(shadowRoot) {
  return { children: [], shadowRoot };
}

test("open Shadow roots discovered by a scan are observed, nested ones included", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const nestedRoot = shadowRootNode();
  const outerRoot = shadowRootNode([shadowHostNode(nestedRoot)]);
  const page = loadContentScript({ bodyChildren: [shadowHostNode(outerRoot)] });
  await settleInit();

  assert.equal(page.observedTargets.includes(outerRoot), true, "a MutationObserver on body never sees inside a root");
  assert.equal(page.observedTargets.includes(nestedRoot), true, "a root inside a root is reached by the same walk");
});

test("a Shadow root already known to the observer is never observed again", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const shadowRoot = shadowRootNode();
  const page = loadContentScript({ bodyChildren: [shadowHostNode(shadowRoot)] });
  await settleInit();

  page.emitMutations([
    { type: "childList", target: elementNode(), addedNodes: [elementNode()], removedNodes: [] },
  ]);
  context.mock.timers.tick(250);

  assert.equal(
    page.observedTargets.filter((target) => target === shadowRoot).length,
    1,
    "the WeakSet of registered roots keeps repeated scans from stacking observers"
  );
});

test("a closed Shadow root is skipped without throwing", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const closedHost = { children: [], shadowRoot: null };
  const page = loadContentScript({ bodyChildren: [closedHost] });
  await settleInit();

  assert.equal(page.observedTargets.includes(null), false);
  assert.equal(page.observedTargets.length, 1, "only document.body is observed");
});

test("iframe load events are no longer watched from the top document", () => {
  const page = loadContentScript();

  assert.equal(
    page.documentListenerTypes.includes("load"),
    false,
    "the parent cannot read a sandboxed or cross-origin child; each frame reports for itself"
  );
});

test("a child-frame login report starts exactly one analysis, owned by the top document", () => {
  const page = loadContentScript();

  page.dispatch({ type: "embedded_login_detected" });

  const started = page.lastMessageOfType("run_pipeline");
  assert.ok(started, "the report asks the top document for the analysis it owns");
  assert.equal(page.sentMessages.filter((message) => message.type === "run_pipeline").length, 1);
});

test("simultaneous child-frame login reports cannot create concurrent jobs", () => {
  const page = loadContentScript();

  page.dispatch({ type: "embedded_login_detected" });
  const jobId = page.lastMessageOfType("run_pipeline")?.jobId;
  page.dispatch({ type: "embedded_login_detected" });
  page.dispatch({ type: "embedded_login_detected" });

  assert.equal(page.sentMessages.filter((message) => message.type === "run_pipeline").length, 1);
  assert.equal(page.lastMessageOfType("run_pipeline")?.jobId, jobId);
});

test("a child-frame login report is ignored while an analysis is already running", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();
  const beforeCount = page.sentMessages.length;

  page.dispatch({ type: "embedded_login_detected" });

  assert.equal(page.sentMessages.length, beforeCount);
  assert.equal(page.lastMessageOfType("run_pipeline")?.jobId, jobId);
});

test("a child-frame login report after an analysis offers a re-analysis instead of a new job", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();
  page.dispatch({ type: "show_banner", jobId, verdict: "unknown", data: {} });
  page.bannerButton(".yp-btn-close").click();
  const runsBefore = page.sentMessages.filter((message) => message.type === "run_pipeline").length;

  page.dispatch({ type: "embedded_login_detected" });

  assert.equal(page.bannerVerdict, "page_changed");
  assert.equal(page.sentMessages.filter((message) => message.type === "run_pipeline").length, runsBefore);
});

test("a child-frame login report reveals the re-analyse control on a standing verdict", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();
  page.dispatch({ type: "show_banner", jobId, verdict: "unknown", data: {} });
  assert.match(page.bannerHtml, /yp-btn-reanalyse" hidden/, "an unknown verdict renders it hidden");
  const reanalyse = page.bannerButton(".yp-btn-reanalyse");
  reanalyse.hidden = true; // the stub does not parse the rendered hidden attribute

  page.dispatch({ type: "embedded_login_detected" });

  assert.equal(reanalyse.hidden, false);
});

test("a child-frame login report never displaces the device-code advisory", async () => {
  const page = loadContentScript({ deviceFlow: { active: true, provider: "GitHub" } });
  await nextTick();
  const beforeCount = page.sentMessages.length;

  page.dispatch({ type: "embedded_login_detected" });

  assert.equal(page.bannerVerdict, "high_risk_login");
  assert.equal(page.sentMessages.length, beforeCount);
});

// =============================================================================
// Issue #62 — the unknown verdict's wording.
// =============================================================================

test("the unknown banner separates the verdict, the reason, and the underlined instruction", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  page.dispatch({ type: "show_banner", jobId, verdict: "unknown", data: { fqdn: "shop.example" } });

  // The flat form (icon tooltip, banner state key) keeps the break as a
  // newline; the rendered form uses a real <br>.
  assert.equal(
    page.lastMessageOfType("set_icon_state")?.title,
    "Unknown.\nThis site is not on your trusted list. " +
    "Only enter your credentials if you know and trust shop.example."
  );
  assert.equal(page.createdWithTag("br").length, 1, "the verdict word gets its own line");

  assert.equal(
    page.createdWithTag("u").map((element) => element.textContent).join(""),
    "Only enter your credentials if you know and trust shop.example.",
    "the whole sentence the user has to act on is underlined, hostname included"
  );

  const bold = page.createdWithTag("strong");
  assert.equal(bold.length, 1, "nothing outside the hostname is emphasized");
  assert.equal(bold[0].textContent, "shop.example");
});

test("an unknown verdict with no hostname still reads as a complete instruction", () => {
  const page = loadContentScript();
  const jobId = page.startJobViaManualTrigger();

  page.dispatch({ type: "show_banner", jobId, verdict: "unknown", data: {} });

  assert.match(page.bannerMessage, /Only enter your credentials if you know and trust this website\.$/);
  assert.doesNotMatch(page.bannerMessage, /undefined/);
  assert.equal(page.createdWithTag("strong").length, 0, "a stand-in names no site, so it is not emphasized");
});
