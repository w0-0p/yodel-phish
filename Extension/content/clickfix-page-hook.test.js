// clickfix-page-hook.js is a classic MAIN-world script. These tests model the
// page as hostile: it can forge public messages and call methods through either
// navigator.clipboard or Clipboard.prototype. Private event names are handed
// over once at document_start and no inspected text reaches a native clipboard
// method from this realm.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const PAGE_HOOK_SCRIPT_PATH = require.resolve("./clickfix-page-hook.js");

class FakeDOMException extends Error {
  constructor(message, name) {
    super(message);
    this.name = name;
  }
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.isTrusted = init.isTrusted === true;
    this.ctrlKey = init.ctrlKey === true;
    this.metaKey = init.metaKey === true;
    this.key = init.key;
    this.bubbles = init.bubbles === true;
    this.composed = init.composed === true;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this._target = null;
  }

  get target() {
    return this._target;
  }

  stopImmediatePropagation() {
    this.propagationStopped = true;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeCustomEvent extends FakeEvent {
  constructor(type, init = {}) {
    super(type, init);
    this._detail = init.detail;
  }

  get detail() {
    return this._detail;
  }
}

function createFakeEventTargetClass() {
  return class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener, options = false) {
    const capture = options === true || options?.capture === true;
    const once = options !== null && typeof options === "object" && options.once === true;
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    if (this.listeners.get(type).some((entry) => entry.listener === listener && entry.capture === capture)) return;
    this.listeners.get(type).push({ listener, capture, once });
  }

  removeEventListener(type, listener, options = false) {
    const capture = options === true || options?.capture === true;
    const entries = this.listeners.get(type) ?? [];
    this.listeners.set(type, entries.filter((entry) => entry.listener !== listener || entry.capture !== capture));
  }

  dispatchEvent(event) {
    event._target = this;
    for (const entry of [...(this.listeners.get(event.type) ?? [])]) {
      if (entry.once) this.removeEventListener(event.type, entry.listener, entry.capture);
      entry.listener.call(this, event);
      if (event.propagationStopped) break;
    }
    return true;
  }
  };
}

function setGlobalNavigator(value) {
  Object.defineProperty(global, "navigator", { value, configurable: true, writable: true });
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadPageHook({
  writeTextImpl = async () => undefined,
  writeImpl = async () => "native-write-result",
  clipboardAvailable = true,
} = {}) {
  const PerLoadEventTarget = createFakeEventTargetClass();
  const posted = [];
  const privateRequests = [];
  const observedBootstrap = [];
  const timers = new Map();
  const nativeWriteTextCalls = [];
  const nativeWriteCalls = [];
  const nativeExecCommandCalls = [];
  const mutationObservers = [];
  let nextTimerId = 0;

  class FakeWindow extends PerLoadEventTarget {
    postMessage(data) {
      posted.push(data);
      const event = new FakeEvent("message");
      event.data = data;
      event.source = this;
      this.dispatchEvent(event);
    }

    setTimeout(callback, delay) {
      nextTimerId += 1;
      timers.set(nextTimerId, { callback, delay });
      return nextTimerId;
    }
    clearTimeout(timerId) {
      timers.delete(timerId);
    }
  }

  class FakeClipboard {
    writeText(text) {
      nativeWriteTextCalls.push(text);
      return writeTextImpl(text);
    }

    write(items) {
      nativeWriteCalls.push(items);
      return writeImpl(items);
    }
  }

  class FakeClipboardItem {
    constructor(entries) {
      this.entries = new Map(Object.entries(entries));
    }

    get types() {
      return [...this.entries.keys()];
    }

    getType(type) {
      if (!this.entries.has(type)) return Promise.reject(new Error("type not found"));
      return Promise.resolve(this.entries.get(type));
    }
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      mutationObservers.push(this);
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
    }
  }

  class FakeDocument extends PerLoadEventTarget {
    constructor() {
      super();
      this.documentElement = { generation: 0 };
    }

    open() {
      fakeWindow.listeners.clear();
      this.listeners.clear();
      this.documentElement = { generation: this.documentElement.generation + 1 };
      for (const observer of mutationObservers) {
        queueMicrotask(() => observer.callback([{ type: "childList", target: this }], observer));
      }
      return this;
    }

    write() {
      return undefined;
    }

    writeln() {
      return undefined;
    }

    execCommand(command) {
      nativeExecCommandCalls.push(command);
      const event = new FakeEvent(String(command).toLowerCase());
      fakeWindow.dispatchEvent(event);
      return !event.defaultPrevented;
    }
  }

  const clipboard = new FakeClipboard();
  const fakeWindow = new FakeWindow();
  const fakeDocument = new FakeDocument();
  global.window = fakeWindow;
  global.document = fakeDocument;
  global.Event = FakeEvent;
  global.CustomEvent = FakeCustomEvent;
  global.EventTarget = PerLoadEventTarget;
  global.Document = FakeDocument;
  global.MutationObserver = FakeMutationObserver;
  setGlobalNavigator(clipboardAvailable ? { clipboard } : {});
  global.Clipboard = FakeClipboard;
  global.ClipboardItem = FakeClipboardItem;
  global.DOMException = FakeDOMException;

  delete require.cache[PAGE_HOOK_SCRIPT_PATH];
  require(PAGE_HOOK_SCRIPT_PATH);

  const requestEventName = "__yodelphish_clickfix_request_1_2_3_4_5_6";
  const resultEventName = "__yodelphish_clickfix_result_7_8_9_10_11_12";
  fakeDocument.addEventListener("__yodelphish_clickfix_bootstrap_v1__", (event) => {
    observedBootstrap.push(event.detail);
  }, { capture: true });
  fakeDocument.addEventListener(requestEventName, (event) => {
    privateRequests.push(JSON.parse(event.detail));
  }, { capture: true });
  fakeDocument.dispatchEvent(new FakeCustomEvent("__yodelphish_clickfix_bootstrap_v1__", {
    detail: JSON.stringify({ requestEventName, resultEventName }),
    bubbles: false,
    composed: false,
  }));

  return {
    clipboard,
    Clipboard: FakeClipboard,
    ClipboardItem: FakeClipboardItem,
    nativeWriteTextCalls,
    nativeWriteCalls,
    nativeExecCommandCalls,
    document: fakeDocument,
    window: fakeWindow,
    posted,
    observedBootstrap,
    pendingTimerCount() {
      return timers.size;
    },
    lastRequest() {
      return privateRequests.at(-1);
    },
    dispatchResult(requestId, status) {
      fakeDocument.dispatchEvent(new FakeCustomEvent(resultEventName, {
        detail: JSON.stringify({ requestId, status }),
        bubbles: false,
        composed: false,
      }));
    },
    dispatchRecoveryAcknowledgement() {
      fakeDocument.dispatchEvent(new FakeCustomEvent(resultEventName, {
        detail: JSON.stringify({ control: "listeners_restored" }),
        bubbles: false,
        composed: false,
      }));
    },
    dispatchPublicResult(requestId, status) {
      fakeWindow.postMessage({
        channel: "yodelphish-clickfix",
        kind: "result",
        requestId,
        status,
      });
    },
    fireAllTimers() {
      const callbacks = [...timers.values()].map((entry) => entry.callback);
      timers.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test("does nothing when navigator.clipboard is unavailable", () => {
  assert.doesNotThrow(() => loadPageHook({ clipboardAvailable: false }));
});

test("writeText sends an immutable request and copied settles without a native write", async () => {
  const hook = loadPageHook();

  const promise = hook.clipboard.writeText("hello");
  const request = hook.lastRequest();

  assert.deepEqual(request, {
    operation: "writeText",
    requestId: request.requestId,
    text: "hello",
  });
  assert.deepEqual(hook.nativeWriteTextCalls, []);

  hook.dispatchResult(request.requestId, "copied");
  await assert.doesNotReject(promise);
  assert.deepEqual(hook.nativeWriteTextCalls, []);
  assert.equal(hook.pendingTimerCount(), 0);
});

test("a genuine private copied result settles without a native page-world write", async () => {
  const hook = loadPageHook();

  const promise = hook.clipboard.writeText("powershell -c evil");
  const request = hook.lastRequest();
  hook.dispatchResult(request.requestId, "copied");

  await assert.doesNotReject(promise);
  assert.deepEqual(hook.nativeWriteTextCalls, []);
});

test("the one-shot bootstrap does not expose private names to later page listeners", () => {
  const hook = loadPageHook();
  assert.deepEqual(hook.observedBootstrap, []);
});

test("only status copied succeeds; every other result rejects without a native write", async () => {
  const hook = loadPageHook();

  for (const status of ["blocked", "cancelled", "error", "allow", undefined]) {
    const promise = hook.clipboard.writeText("powershell -c evil");
    hook.dispatchResult(hook.lastRequest().requestId, status);
    await assert.rejects(promise, (error) => error.name === "NotAllowedError");
  }

  assert.deepEqual(hook.nativeWriteTextCalls, []);
  assert.equal(hook.pendingTimerCount(), 0);
});

test("writeText coerces a stateful object exactly once", async () => {
  const hook = loadPageHook();
  let coercions = 0;
  const stateful = {
    toString() {
      coercions += 1;
      return coercions === 1 ? "benign text" : "powershell -c evil";
    },
  };

  const promise = hook.clipboard.writeText(stateful);
  const request = hook.lastRequest();
  assert.equal(coercions, 1);
  assert.equal(request.text, "benign text");

  hook.dispatchResult(request.requestId, "copied");
  await promise;
  assert.equal(coercions, 1);
  assert.deepEqual(hook.nativeWriteTextCalls, []);
});

test("Clipboard.prototype.writeText routes through inspection and never calls the native", async () => {
  const hook = loadPageHook();
  const prototypeMethod = hook.Clipboard.prototype.writeText;

  const promise = prototypeMethod.call(hook.clipboard, "powershell -c evil");
  const request = hook.lastRequest();
  assert.equal(request.operation, "writeText");
  assert.equal(request.text, "powershell -c evil");

  hook.dispatchResult(request.requestId, "copied");
  await promise;
  assert.deepEqual(hook.nativeWriteTextCalls, []);
});

// The wrappers are installed writable and configurable on purpose (issue #68):
// page frameworks such as Sentry re-wrap these same methods with a plain
// strict-mode assignment, and a read-only property makes that assignment throw
// and takes the whole page down with it. Tamper-resistance does not rest on the
// property descriptor -- see the test below.
test("clipboard wrappers stay redefinable so page instrumentation cannot crash", () => {
  const hook = loadPageHook();

  for (const descriptor of [
    Object.getOwnPropertyDescriptor(hook.Clipboard.prototype, "writeText"),
    Object.getOwnPropertyDescriptor(hook.clipboard, "writeText"),
  ]) {
    assert.equal(descriptor.writable, true);
    assert.equal(descriptor.configurable, true);
  }
});

// The real-world failure this reproduces: account.proton.me ships Sentry,
// whose instrumentation re-wraps EventTarget.prototype.addEventListener with a
// bare `target[name] = wrapped` in strict-mode module code. Against a
// non-writable property that throws during app bootstrap and the site renders
// a blank page.
test("page instrumentation can re-wrap the patched listener APIs without throwing", () => {
  const hook = loadPageHook();

  assert.doesNotThrow(() => {
    "use strict";
    for (const target of [hook.window, global.EventTarget.prototype]) {
      const original = target.addEventListener;
      target.addEventListener = function instrumented(...args) {
        return original.apply(this, args);
      };
    }
    for (const handlerName of ["oncopy", "oncut", "onkeydown"]) {
      hook.window[handlerName] = () => undefined;
    }
  });
});

test("replacing an installed wrapper does not recover native clipboard authority", async () => {
  const hook = loadPageHook();

  // A page overwrites both the prototype method and the own property. The
  // natives were captured before any page script ran, so what it removes is
  // its own access -- not the extension's mediation.
  hook.Clipboard.prototype.writeText = function pageWriteText() {
    return "page-controlled";
  };
  hook.clipboard.writeText = hook.Clipboard.prototype.writeText;

  assert.equal(hook.clipboard.writeText("powershell -c evil"), "page-controlled");
  await flush();
  assert.deepEqual(hook.nativeWriteTextCalls, [], "the native clipboard stays unreachable from the page realm");
});

test("Clipboard.write with text/plain is inspected and never calls the native write", async () => {
  const hook = loadPageHook();
  const item = new hook.ClipboardItem({
    "text/plain": new Blob(["powershell -c evil"], { type: "text/plain" }),
    "text/html": new Blob(["<b>powershell -c evil</b>"], { type: "text/html" }),
  });

  const promise = hook.clipboard.write([item]);
  await flush();
  const request = hook.lastRequest();
  assert.equal(request.operation, "write");
  assert.equal(request.text, "powershell -c evil");
  assert.deepEqual(hook.nativeWriteCalls, []);

  hook.dispatchResult(request.requestId, "copied");
  await promise;
  assert.deepEqual(hook.nativeWriteCalls, []);
});

test("Clipboard.prototype.write cannot bypass text/plain inspection", async () => {
  const hook = loadPageHook();
  const item = new hook.ClipboardItem({
    "text/plain": new Blob(["cmd /c evil"], { type: "text/plain" }),
  });

  const promise = hook.Clipboard.prototype.write.call(hook.clipboard, [item]);
  await flush();
  const request = hook.lastRequest();
  assert.equal(request.operation, "write");

  hook.dispatchResult(request.requestId, "blocked");
  await assert.rejects(promise, (error) => error.name === "NotAllowedError");
  assert.deepEqual(hook.nativeWriteCalls, []);
});

test("Clipboard.write preserves the native path for non-text-only items", async () => {
  const hook = loadPageHook();
  const item = new hook.ClipboardItem({
    "image/png": new Blob(["not really a png"], { type: "image/png" }),
  });

  const result = await hook.clipboard.write([item]);

  assert.equal(result, "native-write-result");
  assert.equal(hook.posted.length, 0);
  assert.equal(hook.nativeWriteCalls.length, 1);
  assert.deepEqual(hook.nativeWriteCalls[0], [item]);
});

test("Clipboard.write fails closed for textual items without text/plain", async () => {
  const hook = loadPageHook();
  const item = new hook.ClipboardItem({
    "text/html": new Blob(["<b>powershell -c evil</b>"], { type: "text/html" }),
  });

  await assert.rejects(
    hook.clipboard.write([item]),
    (error) => error.name === "NotAllowedError" && /cannot be inspected safely/.test(error.message)
  );
  assert.deepEqual(hook.nativeWriteCalls, []);
  assert.equal(hook.posted.length, 0);
});

test("a missing result times out, rejects, and removes the pending request", async () => {
  const hook = loadPageHook();
  const promise = hook.clipboard.writeText("hello");
  const request = hook.lastRequest();

  assert.equal(hook.pendingTimerCount(), 1);
  hook.fireAllTimers();
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "NotAllowedError");
    assert.match(error.message, /timed out/i);
    return true;
  });
  assert.equal(hook.pendingTimerCount(), 0);

  // A late result is ignored after timeout cleanup.
  hook.dispatchResult(request.requestId, "copied");
  assert.deepEqual(hook.nativeWriteTextCalls, []);
});

test("forged public copied results cannot settle a genuine wrapper request", async () => {
  const hook = loadPageHook();
  const promise = hook.clipboard.writeText("hello");
  const request = hook.lastRequest();

  hook.dispatchPublicResult(request.requestId, "copied");
  assert.equal(hook.pendingTimerCount(), 1);
  hook.dispatchResult(request.requestId, "blocked");

  await assert.rejects(promise, (error) => error.name === "NotAllowedError");
  assert.deepEqual(hook.nativeWriteTextCalls, []);
});

test("document.open blocks same-task copy paths until private listener recovery", async () => {
  const hook = loadPageHook();

  hook.document.open();
  let hostileCopyHandlerRan = false;
  hook.window.addEventListener("copy", () => {
    hostileCopyHandlerRan = true;
  }, { capture: true });

  const manualCopy = new FakeEvent("copy");
  hook.window.dispatchEvent(manualCopy);
  assert.equal(manualCopy.defaultPrevented, true);
  assert.equal(hostileCopyHandlerRan, false);
  assert.equal(hook.document.execCommand("copy"), false);
  assert.deepEqual(hook.nativeExecCommandCalls, []);

  // MutationObserver recovery is asynchronous in browsers. MAIN first
  // reinstalls its private result listener; the isolated mediator then sends
  // this secret acknowledgement after restoring its own listeners.
  await Promise.resolve();
  hook.dispatchRecoveryAcknowledgement();
  // The permanent gate keeps the native event cancelled after recovery; in a
  // complete installation it relays the selection to the isolated mediator.
  assert.equal(hook.document.execCommand("copy"), false);
  assert.deepEqual(hook.nativeExecCommandCalls, ["copy"]);
});
