// logo-selector.js is a classic script (an IIFE injected with executeScript),
// so it can be require()d under plain Node once document/window/chrome are
// stubbed. That runs the real overlay: the same drag handlers, the same confirm
// handler, the same shadow-DOM elements the user clicks.
//
// Coverage is the issue #7 contract -- a confirmation is recoverable: the
// overlay stays up and inert while the request runs, every failure restores the
// controls and shows why, and the overlay only goes away once the background
// reports the entry was saved.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const SELECTOR_SCRIPT_PATH = require.resolve("./logo-selector.js");

function createFakeElement(tagName) {
  const listeners = new Map();
  return {
    tagName,
    id: "",
    className: "",
    textContent: "",
    disabled: false,
    removed: false,
    style: {},
    children: [],
    attachShadow() {
      return { appendChild: (node) => this.children.push(node) };
    },
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    remove() {
      this.removed = true;
    },
    fire(type, event = {}) {
      const handler = listeners.get(type);
      assert.ok(handler, `${this.id || this.tagName} has no ${type} handler`);
      return handler({ preventDefault() {}, stopPropagation() {}, ...event });
    },
    has(type) {
      return listeners.has(type);
    },
  };
}

function loadSelector({ fqdn = "example.test", sessionId = "session-1", candidates } = {}) {
  const created = [];
  const sentMessages = [];
  let pendingConfirm = null;
  let runtimeMessageListener = null;

  const fakeDocument = {
    documentElement: createFakeElement("html"),
    createElement(tag) {
      const element = createFakeElement(tag);
      created.push(element);
      return element;
    },
    addEventListener() {},
  };

  const fakeWindow = {
    innerWidth: 1000,
    innerHeight: 800,
    __YP_SELECTOR_CONFIG__: { fqdn, sessionId, ...(candidates === undefined ? {} : { candidates }) },
    requestAnimationFrame(callback) {
      callback();
    },
  };

  const fakeChrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          runtimeMessageListener = listener;
        },
      },
      sendMessage(message) {
        sentMessages.push(message);
        if (message.type !== "logo_selection_confirmed") return Promise.resolve({});
        // Held open so a test can inspect the overlay mid-request.
        return new Promise((resolve, reject) => {
          pendingConfirm = { resolve, reject };
        });
      },
    },
  };

  global.document = fakeDocument;
  global.window = fakeWindow;
  global.chrome = fakeChrome;

  delete require.cache[SELECTOR_SCRIPT_PATH];
  require(SELECTOR_SCRIPT_PATH);

  const byId = (id) => {
    const element = created.find((candidate) => candidate.id === id);
    assert.ok(element, `overlay element #${id} was never created`);
    return element;
  };

  const overlay = byId("overlay");
  const host = fakeDocument.documentElement.children[0];

  return {
    sentMessages,
    host,
    overlay,
    confirm: byId("btn-confirm"),
    redo: byId("btn-redo"),
    cancel: byId("btn-cancel"),
    toolbar: byId("toolbar"),
    error: byId("error-msg"),
    selection: byId("selection"),
    instructions: byId("instructions"),
    // Unlike byId, absence is a legal answer here: a dropped candidate must
    // leave no element behind.
    findId(id) {
      return created.find((candidate) => candidate.id === id) ?? null;
    },
    // A plain click (no drag) through the real pointer handlers.
    clickAt(clientX, clientY) {
      overlay.fire("mousedown", { button: 0, clientX, clientY });
      overlay.fire("mouseup", { clientX, clientY });
    },
    // Draws a valid selection through the real pointer handlers.
    drawSelection() {
      overlay.fire("mousedown", { button: 0, clientX: 100, clientY: 200 });
      overlay.fire("mousemove", { clientX: 300, clientY: 320 });
      overlay.fire("mouseup", { clientX: 300, clientY: 320 });
    },
    clickConfirm() {
      return this.confirm.fire("click");
    },
    // Settles the in-flight confirmation and lets the handler resume.
    async settleConfirm(response) {
      assert.ok(pendingConfirm, "no confirmation was in flight");
      pendingConfirm.resolve(response);
      pendingConfirm = null;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async rejectConfirm(error) {
      assert.ok(pendingConfirm, "no confirmation was in flight");
      pendingConfirm.reject(error);
      pendingConfirm = null;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    lastMessageOfType(type) {
      return [...sentMessages].reverse().find((message) => message.type === type);
    },
    dispatchRuntimeMessage(message) {
      assert.ok(runtimeMessageListener, "the selector did not register a runtime message listener");
      return new Promise((resolve) => {
        const asyncResponse = runtimeMessageListener(message, {}, resolve);
        if (asyncResponse !== true) resolve(undefined);
      });
    },
  };
}

test("confirming sends the drawn rectangle as viewport ratios", () => {
  const ui = loadSelector();
  ui.drawSelection();
  ui.clickConfirm();

  const sent = ui.lastMessageOfType("logo_selection_confirmed");
  assert.deepEqual(sent.normalizedRect, {
    xRatio: 100 / 1000,
    yRatio: 200 / 800,
    widthRatio: 200 / 1000,
    heightRatio: 120 / 800,
  });
  assert.equal(sent.fqdn, "example.test");
});

test("the overlay stays up and inert while the confirmation is in flight", () => {
  const ui = loadSelector();
  ui.drawSelection();
  ui.clickConfirm();

  assert.equal(ui.host.removed, false, "the overlay must not be torn down before the result is known");
  assert.equal(ui.confirm.disabled, true);
  assert.equal(ui.redo.disabled, true);
  assert.equal(ui.cancel.disabled, true);
  assert.equal(ui.confirm.textContent, "Processing…");

  // A second click, a redraw, and a cancel are all ignored: the selection must
  // not change under the request, and it must not be confirmed twice.
  ui.clickConfirm();
  ui.redo.fire("click");
  ui.cancel.fire("click");
  assert.equal(ui.sentMessages.filter((m) => m.type === "logo_selection_confirmed").length, 1);
  assert.equal(ui.lastMessageOfType("logo_selection_cancelled"), undefined);
  assert.equal(ui.toolbar.style.display, "flex", "the selection stays on screen while processing");
});

test("the overlay is transparent only while the background captures the page", async () => {
  const ui = loadSelector();
  ui.drawSelection();
  ui.clickConfirm();

  const prepared = await ui.dispatchRuntimeMessage({ type: "logo_selector_prepare_capture" });

  assert.deepEqual(prepared, { ok: true });
  assert.equal(ui.overlay.style.opacity, "0");
  assert.equal(ui.host.removed, false, "capture preparation must not remove the recoverable overlay");
  assert.equal(ui.confirm.disabled, true, "the transparent overlay must keep blocking interaction");

  await ui.dispatchRuntimeMessage({ type: "logo_selector_capture_complete" });
  assert.equal(ui.overlay.style.opacity, "");
  assert.equal(ui.confirm.textContent, "Processing…");
});

test("the overlay closes only after the background reports the entry was saved", async () => {
  const ui = loadSelector();
  ui.drawSelection();
  ui.clickConfirm();
  assert.equal(ui.host.removed, false);

  await ui.settleConfirm({ ok: true });

  assert.equal(ui.host.removed, true);
  assert.equal(global.window.__YP_SELECTOR_ACTIVE__, false);
});

test("a save failure restores the controls and shows why, in place", async () => {
  const ui = loadSelector();
  ui.drawSelection();
  ui.clickConfirm();

  await ui.settleConfirm({ ok: false, code: "save_failed" });

  assert.equal(ui.host.removed, false, "a failed confirmation must leave a retry path on screen");
  assert.equal(ui.confirm.disabled, false);
  assert.equal(ui.redo.disabled, false);
  assert.equal(ui.cancel.disabled, false);
  assert.equal(ui.confirm.textContent, "Confirm logo");
  assert.equal(ui.error.style.display, "block");
  assert.match(ui.error.textContent, /could not be saved/i);
  assert.equal(ui.toolbar.style.display, "flex", "the drawn selection is kept so it can be confirmed again");
});

test("a deleted trusted entry is reported instead of closing the selector", async () => {
  const ui = loadSelector();
  ui.drawSelection();
  ui.clickConfirm();

  await ui.settleConfirm({ ok: false, code: "entry_missing" });

  assert.equal(ui.host.removed, false);
  assert.match(ui.error.textContent, /no longer exists/i);
  assert.equal(ui.cancel.disabled, false, "cancel must stay available when retrying cannot help");
});

test("the same selection can be confirmed again after a failure", async () => {
  const ui = loadSelector();
  ui.drawSelection();
  ui.clickConfirm();
  await ui.settleConfirm({ ok: false, code: "capture_failed" });

  ui.clickConfirm();

  const attempts = ui.sentMessages.filter((m) => m.type === "logo_selection_confirmed");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1].normalizedRect, attempts[0].normalizedRect);
  assert.equal(ui.error.style.display, "none", "the previous error is cleared while retrying");

  await ui.settleConfirm({ ok: true });
  assert.equal(ui.host.removed, true);
});

test("an unreachable background process is reported like any other failure", async () => {
  const ui = loadSelector();
  ui.drawSelection();
  ui.clickConfirm();

  await ui.rejectConfirm(new Error("Extension context invalidated"));

  assert.equal(ui.host.removed, false);
  assert.equal(ui.confirm.disabled, false);
  assert.equal(ui.error.style.display, "block");
  assert.match(ui.error.textContent, /background process could not be reached/i);
});

test("failures never render background-supplied text", async () => {
  const ui = loadSelector();
  ui.drawSelection();
  ui.clickConfirm();

  await ui.settleConfirm({ ok: false, code: "boom", error: "TypeError: cannot read property 'x' of undefined" });

  assert.doesNotMatch(ui.error.textContent, /TypeError|undefined/);
  assert.match(ui.error.textContent, /Processing failed/i);
});

test("cancelling before confirming tells the background and closes the overlay", () => {
  const ui = loadSelector();
  ui.drawSelection();

  ui.cancel.fire("click");

  assert.equal(ui.lastMessageOfType("logo_selection_cancelled")?.fqdn, "example.test");
  assert.equal(ui.host.removed, true);
});

test("redrawing after a failure clears the error and the previous selection", async () => {
  const ui = loadSelector();
  ui.drawSelection();
  ui.clickConfirm();
  await ui.settleConfirm({ ok: false, code: "preprocess_failed" });

  ui.redo.fire("click");

  assert.equal(ui.error.style.display, "none");
  assert.equal(ui.toolbar.style.display, "none");
  assert.equal(ui.selection.style.display, "none");
  ui.clickConfirm();
  assert.equal(ui.sentMessages.filter((m) => m.type === "logo_selection_confirmed").length, 1);
});

// =============================================================================
// Issue #24: the overlay speaks for exactly one selection session.
// =============================================================================

test("every message carries the session id the overlay was injected with", () => {
  const ui = loadSelector({ sessionId: "session-42" });
  ui.drawSelection();
  ui.clickConfirm();

  assert.equal(ui.lastMessageOfType("logo_selection_confirmed").sessionId, "session-42");
});

test("a cancel is scoped to the overlay's own session", () => {
  const ui = loadSelector({ sessionId: "session-42" });
  ui.drawSelection();

  ui.cancel.fire("click");

  assert.equal(ui.lastMessageOfType("logo_selection_cancelled").sessionId, "session-42");
});

test("a session bound to another page is reported with a way back", async () => {
  const ui = loadSelector({ fqdn: "bank.example" });
  ui.drawSelection();
  ui.clickConfirm();

  await ui.settleConfirm({ ok: false, code: "page_changed" });

  assert.equal(ui.host.removed, false, "the crop is refused, not saved, and the overlay stays recoverable");
  assert.equal(ui.confirm.disabled, false);
  assert.match(ui.error.textContent, /bank\.example/);
});

// =============================================================================
// Issue #90: YOLO candidates from the add-to-trusted flow are offered for
// confirmation — the best one pre-selected, the others selectable — and a
// redraw or a fresh drag always beats a suggestion.
// =============================================================================

// Viewport is 1000×800, so in pixels: first box 50,40 200×80 (score 0.62),
// second box 700,16 100×40 (score 0.31).
function suggestionFixture() {
  return [
    { xRatio: 0.05, yRatio: 0.05, widthRatio: 0.2, heightRatio: 0.1, score: 0.62 },
    { xRatio: 0.7, yRatio: 0.02, widthRatio: 0.1, heightRatio: 0.05, score: 0.31 },
  ];
}

test("the best-scored suggestion starts selected and confirms with its exact ratios", () => {
  const ui = loadSelector({ candidates: suggestionFixture() });

  assert.equal(ui.toolbar.style.display, "flex", "the toolbar is offered without any drawing");
  assert.equal(ui.selection.style.display, "block");
  assert.equal(ui.selection.style.left, "50px");
  assert.equal(ui.selection.style.width, "200px");
  assert.equal(ui.findId("candidate-0").style.display, "none", "the active suggestion is shown as the selection");
  assert.equal(ui.findId("candidate-1").style.display, "", "the other suggestion stays visible, inactive");
  assert.match(ui.instructions.textContent, /Select or edit the logo area for example\.test/);
  assert.notEqual(ui.instructions.style.display, "none", "the prompt stays up until the user draws by hand");

  ui.clickConfirm();
  const sent = ui.lastMessageOfType("logo_selection_confirmed");
  assert.deepEqual(sent.normalizedRect, {
    xRatio: 0.05,
    yRatio: 0.05,
    widthRatio: 0.2,
    heightRatio: 0.1,
  }, "the suggestion's own ratios are sent, untouched by any pixel round trip");
});

test("suggestions are offered best score first regardless of their given order", () => {
  const [best, other] = suggestionFixture();
  const ui = loadSelector({ candidates: [other, best] });

  ui.clickConfirm();
  assert.equal(ui.lastMessageOfType("logo_selection_confirmed").normalizedRect.xRatio, 0.05);
});

test("clicking another suggestion activates it in place of the current one", () => {
  const ui = loadSelector({ candidates: suggestionFixture() });

  ui.clickAt(750, 30);

  assert.equal(ui.findId("candidate-1").style.display, "none");
  assert.equal(ui.findId("candidate-0").style.display, "", "the previous choice goes back to inactive");
  assert.equal(ui.selection.style.left, "700px");
  ui.clickConfirm();
  assert.deepEqual(ui.lastMessageOfType("logo_selection_confirmed").normalizedRect, {
    xRatio: 0.7,
    yRatio: 0.02,
    widthRatio: 0.1,
    heightRatio: 0.05,
  });
});

test("picking a suggestion after a redraw restores the select prompt", () => {
  const ui = loadSelector({ candidates: suggestionFixture() });
  ui.redo.fire("click");
  assert.match(ui.instructions.textContent, /Draw a rectangle/);

  ui.clickAt(100, 80);

  assert.match(ui.instructions.textContent, /Select or edit/);
  assert.notEqual(ui.instructions.style.display, "none");
});

test("the toolbar is kept on screen for a suggestion at the right edge", () => {
  const ui = loadSelector({
    candidates: [
      { xRatio: 0.05, yRatio: 0.05, widthRatio: 0.2, heightRatio: 0.1, score: 0.62 },
      { xRatio: 0.9, yRatio: 0.1, widthRatio: 0.09, heightRatio: 0.05, score: 0.31 },
    ],
  });
  // 240px of buttons anchored at x=900 would end at 1140, past the 1000px
  // viewport; the clamp keeps them fully visible with an 8px margin.
  ui.toolbar.offsetWidth = 240;

  ui.clickAt(950, 100);

  assert.equal(ui.toolbar.style.left, "752px");
  assert.equal(ui.toolbar.style.display, "flex");
});

test("a click outside every suggestion leaves the current selection alone", () => {
  const ui = loadSelector({ candidates: suggestionFixture() });

  ui.clickAt(500, 500);

  assert.equal(ui.toolbar.style.display, "flex");
  ui.clickConfirm();
  assert.equal(ui.lastMessageOfType("logo_selection_confirmed").normalizedRect.xRatio, 0.05);
});

test("redraw switches to hand-drawing while suggestions stay clickable", () => {
  const ui = loadSelector({ candidates: suggestionFixture() });

  ui.redo.fire("click");

  assert.equal(ui.toolbar.style.display, "none");
  assert.match(ui.instructions.textContent, /Draw a rectangle around the logo for example\.test/);
  assert.equal(ui.findId("candidate-0").style.display, "", "suggestions reappear for another pick");

  ui.drawSelection();
  ui.clickConfirm();
  assert.deepEqual(ui.lastMessageOfType("logo_selection_confirmed").normalizedRect, {
    xRatio: 100 / 1000,
    yRatio: 200 / 800,
    widthRatio: 200 / 1000,
    heightRatio: 120 / 800,
  }, "a drawn rectangle wins over any suggestion");
});

test("after a redraw, a suggestion can still be picked by clicking it", () => {
  const ui = loadSelector({ candidates: suggestionFixture() });
  ui.redo.fire("click");

  ui.clickAt(100, 80);

  assert.equal(ui.toolbar.style.display, "flex");
  ui.clickConfirm();
  assert.equal(ui.lastMessageOfType("logo_selection_confirmed").normalizedRect.xRatio, 0.05);
});

test("a drag starting on a suggestion draws instead of selecting it", () => {
  const ui = loadSelector({ candidates: suggestionFixture() });
  ui.redo.fire("click");

  ui.overlay.fire("mousedown", { button: 0, clientX: 60, clientY: 50 });
  ui.overlay.fire("mousemove", { clientX: 260, clientY: 170 });
  ui.overlay.fire("mouseup", { clientX: 260, clientY: 170 });

  ui.clickConfirm();
  assert.deepEqual(ui.lastMessageOfType("logo_selection_confirmed").normalizedRect, {
    xRatio: 60 / 1000,
    yRatio: 50 / 800,
    widthRatio: 200 / 1000,
    heightRatio: 120 / 800,
  });
});

test("unusable suggestion rectangles are dropped rather than drawn somewhere misleading", () => {
  const ui = loadSelector({
    candidates: [
      { xRatio: 0.9, yRatio: 0.9, widthRatio: 0.3, heightRatio: 0.3, score: 0.9 }, // reaches past the viewport
      { xRatio: Number.NaN, yRatio: 0.1, widthRatio: 0.1, heightRatio: 0.1, score: 0.8 },
      { xRatio: 0.1, yRatio: 0.1, widthRatio: 0, heightRatio: 0.1, score: 0.7 }, // zero area
      "nonsense",
    ],
  });

  assert.equal(ui.findId("candidate-0"), null, "nothing was rendered for the dropped suggestions");
  assert.notEqual(ui.toolbar.style.display, "flex", "nothing is pre-selected");
  assert.match(ui.instructions.textContent, /Draw a rectangle/, "with nothing to offer the overlay is the free-draw selector");
});

test("cancelling with a pre-selected suggestion still tells the background", () => {
  const ui = loadSelector({ candidates: suggestionFixture() });

  ui.cancel.fire("click");

  assert.equal(ui.lastMessageOfType("logo_selection_cancelled")?.sessionId, "session-1");
  assert.equal(ui.host.removed, true);
});

test("a confirmation from a background tab is reported instead of capturing another page", async () => {
  const ui = loadSelector();
  ui.drawSelection();
  ui.clickConfirm();

  await ui.settleConfirm({ ok: false, code: "tab_inactive" });

  assert.equal(ui.host.removed, false);
  assert.match(ui.error.textContent, /foreground/i);
});

test("an interrupted capture stays visible and can be retried", async () => {
  const ui = loadSelector();
  ui.drawSelection();
  ui.clickConfirm();

  await ui.settleConfirm({ ok: false, code: "capture_interrupted" });

  assert.equal(ui.host.removed, false, "an interrupted capture must leave the selector on screen");
  assert.equal(ui.confirm.disabled, false);
  assert.equal(ui.redo.disabled, false);
  assert.equal(ui.cancel.disabled, false);
  assert.equal(ui.confirm.textContent, "Confirm logo");
  assert.equal(ui.error.style.display, "block");
  assert.match(ui.error.textContent, /changed during capture/i);
  assert.match(ui.error.textContent, /confirm again/i);
  assert.equal(ui.toolbar.style.display, "flex", "the existing selection remains available to retry");
});
