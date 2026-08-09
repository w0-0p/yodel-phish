// login-frame.js is a classic script with no exports, so it is loaded exactly
// the way content.test.js loads content.js: stub the few globals its top-level
// IIFE touches, require it, then drive the observer callback and the shared
// detector by hand.
//
// The contract under test is deliberately narrow (issue #88): this file may
// report a login transition and do nothing else. Everything it must NOT do --
// start analyses, capture, render banners, read settings, block submission --
// is asserted here as the absence of any other message.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  DETECTION_ATTRIBUTES,
  VISUAL_ATTRIBUTES,
  collectOpenShadowRoots,
} = require("./login-detector.js");

const FRAME_SCRIPT_PATH = require.resolve("./login-frame.js");

function loadFrameWatcher({
  isTopFrame = false,
  hasBody = true,
  detector = true,
  isLoginPage = false,
  bodyChildren = [],
} = {}) {
  const sentMessages = [];
  const loginState = { isLoginPage };

  const fakeBody = { tagName: "BODY", children: bodyChildren };
  const fakeDocument = { body: hasBody ? fakeBody : null };
  const fakeWindow = {};
  fakeWindow.top = isTopFrame ? fakeWindow : { different: true };

  let observerCallback = null;
  const observed = [];
  class FakeMutationObserver {
    constructor(callback) {
      observerCallback = callback;
    }
    observe(target, options) {
      observed.push({ target, options });
    }
    disconnect() {}
  }

  global.document = fakeDocument;
  global.window = fakeWindow;
  global.MutationObserver = FakeMutationObserver;
  global.chrome = {
    runtime: {
      sendMessage(message) {
        sentMessages.push(message);
        return Promise.resolve({});
      },
    },
  };
  global.YodelLoginDetector = detector
    ? {
      DETECTION_ATTRIBUTES,
      VISUAL_ATTRIBUTES,
      collectOpenShadowRoots,
      detectLoginPage: () =>
        loginState.isLoginPage ? { isLogin: true, confidence: 0.9 } : { isLogin: false, confidence: 0 },
    }
    : undefined;

  delete require.cache[FRAME_SCRIPT_PATH];
  require(FRAME_SCRIPT_PATH);

  return {
    loginState,
    sentMessages,
    observed,
    body: fakeBody,
    get loginReports() {
      return sentMessages.filter((message) => message.type === "child_frame_login_detected");
    },
    // Fires the observer exactly as the browser would; the records themselves
    // are irrelevant here because the watcher re-scans rather than inspecting
    // them.
    emitMutation(target = fakeBody) {
      assert.equal(observed.some((entry) => entry.target === target), true, "target must be observed");
      observerCallback([{ type: "childList" }]);
    },
  };
}

// A srcdoc or freshly navigated child document is fully parsed by document_idle,
// which is the whole reason the common case needs no mutation at all.
test("a frame that is already a login page reports on its initial scan", () => {
  const frame = loadFrameWatcher({ isLoginPage: true });

  assert.deepEqual(frame.loginReports, [{ type: "child_frame_login_detected" }]);
  assert.equal(frame.sentMessages.length, 1, "the watcher sends nothing else at all");
});

test("a frame that becomes a login page reports exactly once", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const frame = loadFrameWatcher();
  assert.deepEqual(frame.loginReports, [], "a frame with no credential surface says nothing");

  frame.loginState.isLoginPage = true;
  frame.emitMutation();
  context.mock.timers.tick(250);

  assert.deepEqual(frame.loginReports, [{ type: "child_frame_login_detected" }]);
  assert.equal(frame.sentMessages.length, 1, "the watcher sends nothing else at all");
});

test("a frame that stays a login page never reports again", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const frame = loadFrameWatcher();
  frame.loginState.isLoginPage = true;
  frame.emitMutation();
  context.mock.timers.tick(250);

  for (let index = 0; index < 5; index += 1) {
    frame.emitMutation();
    context.mock.timers.tick(250);
  }

  assert.equal(frame.loginReports.length, 1, "only the transition into a login page is worth a message");
});

test("a frame that stops being a login page re-arms and reports the next one", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const frame = loadFrameWatcher();
  frame.loginState.isLoginPage = true;
  frame.emitMutation();
  context.mock.timers.tick(250);

  frame.loginState.isLoginPage = false;
  frame.emitMutation();
  context.mock.timers.tick(250);
  assert.equal(frame.loginReports.length, 1, "losing the form is not itself reportable");

  frame.loginState.isLoginPage = true;
  frame.emitMutation();
  context.mock.timers.tick(250);

  assert.equal(frame.loginReports.length, 2, "a replacement document rendering the form is reported again");
});

test("continuous churn cannot postpone the debounced evaluation", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const frame = loadFrameWatcher();
  frame.loginState.isLoginPage = true;

  for (let index = 0; index < 10; index += 1) {
    frame.emitMutation();
    context.mock.timers.tick(50);
  }

  assert.equal(frame.loginReports.length, 1, "the timer is non-resetting, exactly like the top document's");
});

test("the frame observer subscribes to the detector's own shared attribute lists", () => {
  const frame = loadFrameWatcher();

  assert.equal(frame.observed.length, 1);
  const { target, options } = frame.observed[0];
  assert.equal(target, frame.body);
  assert.equal(options.subtree, true);
  assert.equal(options.childList, true);
  for (const attribute of [...VISUAL_ATTRIBUTES, ...DETECTION_ATTRIBUTES]) {
    assert.equal(options.attributeFilter.includes(attribute), true, attribute + " must be observed");
  }
});

test("a login inserted later inside an open Shadow root is detected", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const shadowRoot = { children: [] };
  const host = { children: [], shadowRoot };
  const frame = loadFrameWatcher();

  frame.body.children.push(host);
  frame.emitMutation();
  context.mock.timers.tick(250);

  assert.equal(frame.observed.some(({ target }) => target === shadowRoot), true);
  frame.loginState.isLoginPage = true;
  frame.emitMutation(shadowRoot);
  context.mock.timers.tick(250);

  assert.equal(frame.loginReports.length, 1);
});

test("the watcher stays inert in the top document, which owns the real content script", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const frame = loadFrameWatcher({ isTopFrame: true });
  frame.loginState.isLoginPage = true;

  assert.deepEqual(frame.observed, [], "no second owner of the page lifecycle");
  assert.deepEqual(frame.sentMessages, []);
});

test("a document with no body neither observes nor throws", () => {
  const frame = loadFrameWatcher({ hasBody: false });

  assert.deepEqual(frame.observed, []);
  assert.deepEqual(frame.sentMessages, []);
});

test("a frame without the shared detector reports nothing", () => {
  const frame = loadFrameWatcher({ detector: false });

  assert.deepEqual(frame.observed, []);
  assert.deepEqual(frame.sentMessages, []);
});
