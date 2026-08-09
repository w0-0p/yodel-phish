// ClickFix protection (issue #26) — MAIN-world clipboard hook.
//
// This realm is controlled by the page. The isolated-world mediator therefore
// bootstraps two unguessable DOM event names at document_start, before page
// scripts run. Once text has been extracted for inspection, this hook never
// invokes the native clipboard operation; the isolated/background path copies
// only the immutable inspected string.
(function () {
  const BOOTSTRAP_EVENT = "__yodelphish_clickfix_bootstrap_v1__";
  const REQUEST_EVENT_RE = /^__yodelphish_clickfix_request_(?:[0-9]+_){5}[0-9]+$/;
  const RESULT_EVENT_RE = /^__yodelphish_clickfix_result_(?:[0-9]+_){5}[0-9]+$/;
  const RESULT_TIMEOUT_MS = 60_000;
  const pendingRequests = new Map();
  let requestCounter = 0;
  let requestEventName = null;
  let resultEventName = null;
  let documentRecoveryGuardActive = false;

  // Capture the built-ins used after installation. A page may replace globals
  // and prototype methods later, but that must not change what the hook calls.
  const NativePromise = Promise;
  const NativeString = String;
  const NativeCustomEvent = CustomEvent;
  const NativeMutationObserver = globalThis.MutationObserver;
  const nativeApply = Reflect.apply;
  const promiseReject = NativePromise.reject.bind(NativePromise);
  const mapGet = Map.prototype.get;
  const mapSet = Map.prototype.set;
  const mapDelete = Map.prototype.delete;
  const objectDefineProperty = Object.defineProperty;
  const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const objectGetPrototypeOf = Object.getPrototypeOf;
  const eventTargetAdd = EventTarget.prototype.addEventListener;
  const eventTargetRemove = EventTarget.prototype.removeEventListener;
  const eventTargetDispatch = EventTarget.prototype.dispatchEvent;
  const eventTargetGetter = objectGetOwnPropertyDescriptor(Event.prototype, "target")?.get ?? null;
  const eventTypeGetter = objectGetOwnPropertyDescriptor(Event.prototype, "type")?.get ?? null;
  const eventIsTrustedGetter = objectGetOwnPropertyDescriptor(Event.prototype, "isTrusted")?.get ?? null;
  const keyboardEventPrototype = typeof KeyboardEvent === "function" ? KeyboardEvent.prototype : null;
  const keyboardCtrlKeyGetter = keyboardEventPrototype === null
    ? null
    : objectGetOwnPropertyDescriptor(keyboardEventPrototype, "ctrlKey")?.get ?? null;
  const keyboardMetaKeyGetter = keyboardEventPrototype === null
    ? null
    : objectGetOwnPropertyDescriptor(keyboardEventPrototype, "metaKey")?.get ?? null;
  const keyboardKeyGetter = keyboardEventPrototype === null
    ? null
    : objectGetOwnPropertyDescriptor(keyboardEventPrototype, "key")?.get ?? null;
  const preventDefault = Event.prototype.preventDefault;
  const stopImmediatePropagation = Event.prototype.stopImmediatePropagation;
  const customEventDetailGetter = objectGetOwnPropertyDescriptor(NativeCustomEvent.prototype, "detail")?.get ?? null;
  const regexpTest = RegExp.prototype.test;
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  const mutationObserverObserve = typeof NativeMutationObserver === "function"
    ? NativeMutationObserver.prototype.observe
    : null;
  const arrayFrom = Array.from;
  const arrayJoin = Array.prototype.join;
  const arrayIterator = Array.prototype[Symbol.iterator];
  const iteratorSymbol = Symbol.iterator;
  const stringSplit = String.prototype.split;
  const stringStartsWith = String.prototype.startsWith;
  const stringTrim = String.prototype.trim;
  const stringToLowerCase = String.prototype.toLowerCase;
  const scheduleTimeout = window.setTimeout.bind(window);
  const cancelTimeout = window.clearTimeout.bind(window);
  const NativeDOMException = DOMException;
  const bridgeTarget = document;
  const guardedWindow = window;
  const documentPrototype =
    typeof Document !== "undefined" && Document.prototype
      ? Document.prototype
      : objectGetPrototypeOf(bridgeTarget);
  const documentElementGetter =
    objectGetOwnPropertyDescriptor(documentPrototype, "documentElement")?.get ?? null;
  const originalDocumentOpen =
    typeof bridgeTarget.open === "function" ? bridgeTarget.open : null;
  const originalDocumentWrite =
    typeof bridgeTarget.write === "function" ? bridgeTarget.write : null;
  const originalDocumentWriteln =
    typeof bridgeTarget.writeln === "function" ? bridgeTarget.writeln : null;
  const originalExecCommand =
    typeof bridgeTarget.execCommand === "function" ? bridgeTarget.execCommand : null;

  function bridgeEventTarget(event) {
    return eventTargetGetter === null ? event.target : nativeApply(eventTargetGetter, event, []);
  }

  function bridgeEventDetail(event) {
    return customEventDetailGetter === null ? event.detail : nativeApply(customEventDetailGetter, event, []);
  }

  function nativeEventType(event) {
    return eventTypeGetter === null ? event.type : nativeApply(eventTypeGetter, event, []);
  }

  function nativeEventIsTrusted(event) {
    return eventIsTrustedGetter === null
      ? event.isTrusted === true
      : nativeApply(eventIsTrustedGetter, event, []) === true;
  }

  function nativeKeyboardValue(event, getter, fallbackName) {
    return getter === null ? event[fallbackName] : nativeApply(getter, event, []);
  }

  function dispatchPrivateEvent(type, detail) {
    const event = new NativeCustomEvent(type, {
      detail,
      bubbles: false,
      composed: false,
    });
    return nativeApply(eventTargetDispatch, bridgeTarget, [event]);
  }

  function onPrivateResult(event) {
    if (bridgeEventTarget(event) !== bridgeTarget) return;
    const serialized = bridgeEventDetail(event);
    if (typeof serialized !== "string" || serialized.length > 512) return;

    let data;
    try {
      data = jsonParse(serialized);
    } catch {
      return;
    }
    if (data !== null && typeof data === "object" && data.control === "listeners_restored") {
      releaseDocumentRecoveryGuard();
      return;
    }
    if (data === null || typeof data !== "object" || typeof data.requestId !== "string") return;
    settleRequest(data.requestId, data.status);
  }

  function installPrivateResultListener() {
    if (resultEventName === null) return;
    nativeApply(eventTargetRemove, bridgeTarget, [resultEventName, onPrivateResult, true]);
    nativeApply(eventTargetAdd, bridgeTarget, [resultEventName, onPrivateResult, { capture: true }]);
  }

  function consumeBootstrap(event) {
    // The listener is already `once`; explicit removal plus propagation stop
    // prevents the private names from reaching any later page listener.
    nativeApply(eventTargetRemove, bridgeTarget, [BOOTSTRAP_EVENT, consumeBootstrap, true]);
    nativeApply(stopImmediatePropagation, event, []);
    if (bridgeEventTarget(event) !== bridgeTarget) return;

    const serialized = bridgeEventDetail(event);
    if (typeof serialized !== "string" || serialized.length > 512) return;
    let data;
    try {
      data = jsonParse(serialized);
    } catch {
      return;
    }
    if (data === null || typeof data !== "object" ||
        typeof data.requestEventName !== "string" ||
        typeof data.resultEventName !== "string" ||
        data.requestEventName === data.resultEventName ||
        !nativeApply(regexpTest, REQUEST_EVENT_RE, [data.requestEventName]) ||
        !nativeApply(regexpTest, RESULT_EVENT_RE, [data.resultEventName])) {
      return;
    }

    requestEventName = data.requestEventName;
    resultEventName = data.resultEventName;
    installPrivateResultListener();
  }

  // Register before checking clipboard availability: even a document without
  // the API must synchronously consume the isolated world's secret bootstrap.
  nativeApply(eventTargetAdd, bridgeTarget, [BOOTSTRAP_EVENT, consumeBootstrap, {
    capture: true,
    once: true,
  }]);

  // document.open()/write() may clear DOM listeners without replacing this
  // realm. Restore the private result listener only when the document root is
  // replaced; ordinary subtree mutations do not trigger this observer.
  if (typeof NativeMutationObserver === "function" && mutationObserverObserve !== null) {
    const recoveryObserver = new NativeMutationObserver(() => installPrivateResultListener());
    nativeApply(mutationObserverObserve, recoveryObserver, [bridgeTarget, { childList: true }]);
  }

  // document.open() removes Window/Document event listeners synchronously,
  // while MutationObserver recovery runs only at the following microtask
  // checkpoint. Arm a MAIN-world guard before document replacement APIs run
  // and keep it until the isolated mediator explicitly confirms that its
  // private and manual listeners are installed again. This closes the
  // same-task execCommand/copy-event gap without trying to parse page code.
  function protectManualClipboardEvent(event) {
    const operation = nativeEventType(event);
    if (operation !== "copy" && operation !== "cut") return;
    if (typeof preventDefault === "function") nativeApply(preventDefault, event, []);
    nativeApply(stopImmediatePropagation, event, []);

    // Keep this first listener permanently. Observer recovery cannot regain
    // listener priority if an inline script registers a hostile Window capture
    // listener while document.open()/write() is replacing the document.
    if (documentRecoveryGuardActive || !nativeEventIsTrusted(event) ||
        requestEventName === null || resultEventName === null) return;
    requestCounter += 1;
    try {
      dispatchPrivateEvent(requestEventName, jsonStringify({
        operation,
        requestId: `manual-${requestCounter}`,
        manual: true,
      }));
    } catch {
      // The native copy was already cancelled, so relay failure stays closed.
    }
  }

  function protectManualShortcutEvent(event) {
    if (nativeEventType(event) !== "keydown" || !nativeEventIsTrusted(event)) return;
    const ctrlKey = nativeKeyboardValue(event, keyboardCtrlKeyGetter, "ctrlKey") === true;
    const metaKey = nativeKeyboardValue(event, keyboardMetaKeyGetter, "metaKey") === true;
    let key = nativeKeyboardValue(event, keyboardKeyGetter, "key");
    if ((!ctrlKey && !metaKey) || typeof key !== "string") return;
    key = nativeApply(stringToLowerCase, key, []);
    if (key !== "c" && key !== "x") return;

    // Preserve the browser's default copy/cut, but prevent a later page
    // keydown listener from borrowing this activation for a competing write.
    nativeApply(stopImmediatePropagation, event, []);
    if (documentRecoveryGuardActive || requestEventName === null || resultEventName === null) return;
    requestCounter += 1;
    try {
      dispatchPrivateEvent(requestEventName, jsonStringify({
        operation: "manual-intent",
        requestId: `intent-${requestCounter}`,
        manual: true,
      }));
    } catch {
      // The subsequent copy/cut gate still fails closed if the relay is lost.
    }
  }

  function installPersistentInputGates() {
    // Native addEventListener deduplicates the same listener/type/capture
    // triple. Do not remove first: an ordinary parser-time document.write()
    // keeps the listener alive, and remove+add would move it behind page code.
    nativeApply(eventTargetAdd, guardedWindow, ["keydown", protectManualShortcutEvent, { capture: true }]);
    nativeApply(eventTargetAdd, guardedWindow, ["copy", protectManualClipboardEvent, { capture: true }]);
    nativeApply(eventTargetAdd, guardedWindow, ["cut", protectManualClipboardEvent, { capture: true }]);
  }

  function armDocumentRecoveryGuard() {
    documentRecoveryGuardActive = true;
    installPersistentInputGates();
  }

  function releaseDocumentRecoveryGuard() {
    documentRecoveryGuardActive = false;
  }

  // `document.write()` can execute an inline script before its finally block
  // re-adds the gate. While recovery is active, block same-realm attempts to
  // take an earlier Window copy/cut slot through either the instance or the
  // EventTarget prototype. Calls for every other event/target pass through.
  function protectedAddEventListener(type, listener, options) {
    if (typeof type === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    const normalizedType = NativeString(type);
    if (documentRecoveryGuardActive && this === guardedWindow &&
        (normalizedType === "copy" || normalizedType === "cut" || normalizedType === "keydown")) {
      return undefined;
    }
    return nativeApply(eventTargetAdd, this, [normalizedType, listener, options]);
  }

  function propertyOwner(target, name) {
    let current = target;
    for (let depth = 0; current !== null && depth < 16; depth += 1) {
      if (objectGetOwnPropertyDescriptor(current, name) !== undefined) return current;
      current = objectGetPrototypeOf(current);
    }
    return null;
  }

  function installProtectedEventHandlerProperty(target, name, nativeDescriptor) {
    if (target === null || target === undefined) return;
    const descriptor = objectGetOwnPropertyDescriptor(target, name);
    const nativeGetter = typeof nativeDescriptor?.get === "function" ? nativeDescriptor.get : null;
    const nativeSetter = typeof nativeDescriptor?.set === "function" ? nativeDescriptor.set : null;
    try {
      // configurable:true for the same page-compatibility reason as
      // installHookMethod below; redefining only severs the page's own path
      // to the native setter, which was captured before page scripts ran.
      objectDefineProperty(target, name, {
        get() {
          return nativeGetter === null ? null : nativeApply(nativeGetter, this, []);
        },
        set(value) {
          if (documentRecoveryGuardActive && this === guardedWindow) return;
          if (nativeSetter !== null) nativeApply(nativeSetter, this, [value]);
        },
        enumerable: descriptor?.enumerable === true,
        configurable: true,
      });
    } catch {
      // The persistent gate still covers ordinary handler registration. A
      // non-configurable native setter is a platform limitation and remains
      // subject to the documented fresh-realm boundary.
    }
  }

  installHookMethod(EventTarget.prototype, "addEventListener", protectedAddEventListener);
  installHookMethod(guardedWindow, "addEventListener", protectedAddEventListener);
  for (const handlerName of ["oncopy", "oncut", "onkeydown"]) {
    const owner = propertyOwner(guardedWindow, handlerName);
    const nativeDescriptor = owner === null ? undefined : objectGetOwnPropertyDescriptor(owner, handlerName);
    if (owner !== null) installProtectedEventHandlerProperty(owner, handlerName, nativeDescriptor);
    if (owner !== guardedWindow) {
      installProtectedEventHandlerProperty(guardedWindow, handlerName, nativeDescriptor);
    }
  }
  installPersistentInputGates();

  function currentDocumentRoot() {
    return documentElementGetter === null
      ? bridgeTarget.documentElement
      : nativeApply(documentElementGetter, bridgeTarget, []);
  }

  function protectedDocumentOpen(...args) {
    // The legacy three-argument overload opens a separate browsing context
    // rather than replacing this document, so it does not clear our listeners.
    if (args.length >= 3) return nativeApply(originalDocumentOpen, this, args);
    armDocumentRecoveryGuard();
    try {
      return nativeApply(originalDocumentOpen, this, args);
    } finally {
      // open() removes the pre-call guard along with every other listener.
      armDocumentRecoveryGuard();
    }
  }

  function callProtectedDocumentWrite(original, receiver, args) {
    const rootBefore = currentDocumentRoot();
    armDocumentRecoveryGuard();
    try {
      return nativeApply(original, receiver, args);
    } finally {
      const rootAfter = currentDocumentRoot();
      if (rootBefore !== null && rootBefore === rootAfter) {
        // Ordinary parser-time writes did not replace the document or remove
        // listeners. Same-task calls from written inline scripts were guarded.
        releaseDocumentRecoveryGuard();
      } else {
        // An implicit document.open() may have removed the first guard.
        armDocumentRecoveryGuard();
      }
    }
  }

  function protectedDocumentWrite(...args) {
    return callProtectedDocumentWrite(originalDocumentWrite, this, args);
  }

  function protectedDocumentWriteln(...args) {
    return callProtectedDocumentWrite(originalDocumentWriteln, this, args);
  }

  function protectedExecCommand(commandId, ...args) {
    let command;
    try {
      command = NativeString(commandId);
    } catch (error) {
      throw error;
    }
    const normalizedCommand = nativeApply(stringToLowerCase, command, []);
    if (documentRecoveryGuardActive &&
        (normalizedCommand === "copy" || normalizedCommand === "cut")) {
      return false;
    }
    const forwarded = [command];
    for (let index = 0; index < args.length; index += 1) {
      forwarded[index + 1] = args[index];
    }
    return nativeApply(originalExecCommand, this, forwarded);
  }

  if (originalDocumentOpen !== null) {
    installHookMethod(documentPrototype, "open", protectedDocumentOpen);
    installHookMethod(bridgeTarget, "open", protectedDocumentOpen);
  }
  if (originalDocumentWrite !== null) {
    installHookMethod(documentPrototype, "write", protectedDocumentWrite);
    installHookMethod(bridgeTarget, "write", protectedDocumentWrite);
  }
  if (originalDocumentWriteln !== null) {
    installHookMethod(documentPrototype, "writeln", protectedDocumentWriteln);
    installHookMethod(bridgeTarget, "writeln", protectedDocumentWriteln);
  }
  if (originalExecCommand !== null) {
    installHookMethod(documentPrototype, "execCommand", protectedExecCommand);
    installHookMethod(bridgeTarget, "execCommand", protectedExecCommand);
  }

  const clipboard = navigator.clipboard;
  if (!clipboard) return;

  const clipboardPrototype =
    typeof Clipboard !== "undefined" && Clipboard.prototype
      ? Clipboard.prototype
      : objectGetPrototypeOf(clipboard);

  const originalWrite = typeof clipboard.write === "function" ? clipboard.write : null;

  const clipboardItemPrototype =
    typeof ClipboardItem !== "undefined" && ClipboardItem.prototype
      ? ClipboardItem.prototype
      : null;
  const clipboardItemTypesGetter = clipboardItemPrototype === null
    ? null
    : objectGetOwnPropertyDescriptor(clipboardItemPrototype, "types")?.get ?? null;
  const clipboardItemGetType = clipboardItemPrototype === null ||
      typeof clipboardItemPrototype.getType !== "function"
    ? null
    : clipboardItemPrototype.getType;
  const nativeBlobText = typeof Blob !== "undefined" && typeof Blob.prototype?.text === "function"
    ? Blob.prototype.text
    : null;

  function rejection(message) {
    return new NativeDOMException(message, "NotAllowedError");
  }

  function settleRequest(requestId, status) {
    const pending = nativeApply(mapGet, pendingRequests, [requestId]);
    if (pending === undefined) return;

    nativeApply(mapDelete, pendingRequests, [requestId]);
    cancelTimeout(pending.timeoutId);
    if (status === "copied") {
      pending.resolve(undefined);
      return;
    }
    pending.reject(rejection("Clipboard write was blocked or could not be completed"));
  }

  function requestClipboardWrite(text, operation) {
    if (requestEventName === null || resultEventName === null) {
      return promiseReject(rejection("Clipboard inspection bridge is unavailable"));
    }
    requestCounter += 1;
    const requestId = `${requestCounter}`;

    return new NativePromise((resolve, reject) => {
      const timeoutId = scheduleTimeout(() => {
        const pending = nativeApply(mapGet, pendingRequests, [requestId]);
        if (pending === undefined) return;
        nativeApply(mapDelete, pendingRequests, [requestId]);
        pending.reject(rejection("Clipboard inspection timed out"));
      }, RESULT_TIMEOUT_MS);

      nativeApply(mapSet, pendingRequests, [requestId, { resolve, reject, timeoutId }]);
      try {
        // `text` is a primitive string by this point. JSON serialization
        // snapshots it before dispatch into the isolated-world listener.
        dispatchPrivateEvent(requestEventName, jsonStringify({ operation, requestId, text }));
      } catch {
        nativeApply(mapDelete, pendingRequests, [requestId]);
        cancelTimeout(timeoutId);
        reject(rejection("Clipboard inspection could not be started"));
      }
    });
  }

  function protectedWriteText(value) {
    let text;
    try {
      // Convert exactly once. In particular, never pass the original object to
      // a native Web-IDL conversion after inspecting a different string value.
      if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
      text = NativeString(value);
    } catch (error) {
      return promiseReject(error);
    }
    return requestClipboardWrite(text, "writeText");
  }

  function readClipboardItemTypes(item) {
    if (clipboardItemTypesGetter !== null) {
      // Platform brand checks accept genuine cross-realm ClipboardItems. If
      // they reject, fail closed instead of trusting an overrideable getter.
      return arrayFrom(nativeApply(clipboardItemTypesGetter, item, []));
    }
    if (item === null || item === undefined) {
      throw new TypeError("ClipboardItem types are unavailable");
    }
    const types = item.types;
    if (types === undefined) throw new TypeError("ClipboardItem types are unavailable");
    return arrayFrom(types);
  }

  function getClipboardItemType(item, type) {
    if (clipboardItemGetType !== null) {
      return nativeApply(clipboardItemGetType, item, [type]);
    }
    if (item === null || item === undefined) {
      throw new TypeError("ClipboardItem text cannot be read");
    }
    const getType = item.getType;
    if (typeof getType !== "function") throw new TypeError("ClipboardItem text cannot be read");
    return nativeApply(getType, item, [type]);
  }

  function blobText(blob) {
    if (nativeBlobText !== null) {
      return nativeApply(nativeBlobText, blob, []);
    }
    if (blob === null || blob === undefined) {
      throw new TypeError("ClipboardItem text payload is unavailable");
    }
    const text = blob.text;
    if (typeof text !== "function") throw new TypeError("ClipboardItem text payload is unavailable");
    return nativeApply(text, blob, []);
  }

  async function protectedWrite(items) {
    // Materialize a possibly one-shot iterable once. The same materialized
    // list is passed to the native operation when every item is non-text.
    const itemList = arrayFrom(items);
    // Web IDL consumes a sequence through @@iterator. Lock this materialized
    // array to the iterator captured at installation so a stateful replacement
    // cannot show inspection one sequence and the native write another.
    try {
      objectDefineProperty(itemList, iteratorSymbol, {
        value: arrayIterator,
        enumerable: false,
        writable: false,
        configurable: false,
      });
    } catch {
      // Ordinary arrays are extensible; this is only a compatibility fallback
      // for unusual host-provided sequence implementations.
    }

    const plainTextEntries = [];
    let hasTextPayload = false;
    for (let itemIndex = 0; itemIndex < itemList.length; itemIndex += 1) {
      const item = itemList[itemIndex];
      const types = readClipboardItemTypes(item);
      for (let typeIndex = 0; typeIndex < types.length; typeIndex += 1) {
        const typeValue = types[typeIndex];
        const type = NativeString(typeValue);
        const firstTypePart = nativeApply(stringSplit, type, [";", 1])[0];
        const trimmedType = nativeApply(stringTrim, firstTypePart, []);
        const normalizedType = nativeApply(stringToLowerCase, trimmedType, []);
        if (nativeApply(stringStartsWith, normalizedType, ["text/"])) hasTextPayload = true;
        if (normalizedType === "text/plain") {
          plainTextEntries[plainTextEntries.length] = { item, type };
          break;
        }
      }
    }

    if (plainTextEntries.length === 0) {
      if (hasTextPayload) {
        throw rejection("Text clipboard items without text/plain are blocked because they cannot be inspected safely");
      }
      if (originalWrite === null) {
        throw new TypeError("Clipboard.write is unavailable");
      }
      return nativeApply(originalWrite, this, [itemList]);
    }

    const textValues = [];
    for (let entryIndex = 0; entryIndex < plainTextEntries.length; entryIndex += 1) {
      const entry = plainTextEntries[entryIndex];
      const blob = await getClipboardItemType(entry.item, entry.type);
      textValues[textValues.length] = NativeString(await blobText(blob));
    }

    // Chromium currently supports one clipboard item on the common desktop
    // platforms. Joining still ensures that no text/plain item can evade
    // inspection if a platform accepts more than one.
    const text = nativeApply(arrayJoin, textValues, ["\n"]);
    return requestClipboardWrite(text, "write");
  }

  // Deliberately NOT locked (writable + configurable): frameworks the page
  // ships (Sentry and similar instrumentation) re-wrap these same methods with
  // a plain strict-mode assignment, which throws on a read-only property and
  // takes the whole application down with it. Tamper-resistance is not lost:
  // the native functions were captured above before any page script ran, so a
  // page that overwrites or deletes a wrapper can never recover native
  // clipboard/exec authority — it only severs its own access, which fails
  // closed. The fresh-realm boundary documented at the end of this file is the
  // real limit either way.
  function installHookMethod(target, name, replacement) {
    if (target === null || target === undefined) return false;
    const descriptor = objectGetOwnPropertyDescriptor(target, name);
    try {
      objectDefineProperty(target, name, {
        value: replacement,
        enumerable: descriptor?.enumerable === true,
        writable: true,
        configurable: true,
      });
      return true;
    } catch {
      // Some host objects reject defineProperty. Assignment is weaker but
      // preserves coverage where the property is writable.
      try {
        target[name] = replacement;
        return target[name] === replacement;
      } catch {
        return false;
      }
    }
  }

  if (typeof clipboard.writeText === "function") {
    installHookMethod(clipboardPrototype, "writeText", protectedWriteText);
    installHookMethod(clipboard, "writeText", protectedWriteText);
  }
  if (originalWrite !== null) {
    installHookMethod(clipboardPrototype, "write", protectedWrite);
    installHookMethod(clipboard, "write", protectedWrite);
  }

  // Defense-in-depth, not an OS clipboard boundary: a page that obtained a
  // callable native method from another realm before this hook can invoke that
  // authority outside APIs a content script is able to mediate.
})();
