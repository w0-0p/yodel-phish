// ClickFix protection (issue #26) — isolated-world mediator.
//
// Security invariant: inspected page operations are never resumed in the page
// world. Programmatic text writes are copied by an extension-owned context
// only after the background has inspected the immutable string. Copy/cut DOM
// events are cancelled before page handlers run; the extension then copies the
// exact snapshot, and an approved cut deletes only the unchanged selection.
(function installClickfixMediator() {
  const policy = globalThis.YodelClickfixPolicy;
  const BOOTSTRAP_EVENT = "__yodelphish_clickfix_bootstrap_v1__";
  const REQUEST_TIMEOUT_MS = 10_000;
  const RATE_WINDOW_MS = 10_000;
  const MANUAL_COPY_GUARD_MS = 6_000;
  const MAX_REQUESTS_PER_WINDOW = 8;
  const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
  const PRIVATE_EVENT_RE = /^__yodelphish_clickfix_(?:request|result)_(?:[0-9]+_){5}[0-9]+$/;

  // This script runs in an isolated world. Capture the DOM bridge primitives
  // once anyway so later callbacks do not depend on mutable global bindings.
  const NativeCustomEvent = globalThis.CustomEvent;
  const NativeUint32Array = globalThis.Uint32Array;
  const NativeMutationObserver = globalThis.MutationObserver;
  const nativeApply = Reflect.apply;
  const eventTargetAdd = EventTarget.prototype.addEventListener;
  const eventTargetRemove = EventTarget.prototype.removeEventListener;
  const eventTargetDispatch = EventTarget.prototype.dispatchEvent;
  const eventTargetGetter = Object.getOwnPropertyDescriptor(Event.prototype, "target")?.get ?? null;
  const stopImmediatePropagation = Event.prototype.stopImmediatePropagation;
  const customEventDetailGetter = typeof NativeCustomEvent === "function"
    ? Object.getOwnPropertyDescriptor(NativeCustomEvent.prototype, "detail")?.get ?? null
    : null;
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  const dateNow = Date.now;
  const scheduleMicrotask = typeof globalThis.queueMicrotask === "function"
    ? globalThis.queueMicrotask.bind(globalThis)
    : (callback) => Promise.resolve().then(callback);
  const mutationObserverObserve = typeof NativeMutationObserver === "function"
    ? NativeMutationObserver.prototype.observe
    : null;
  const randomSource = globalThis.crypto;
  const getRandomValues = randomSource !== null && typeof randomSource === "object" &&
      typeof randomSource.getRandomValues === "function"
    ? randomSource.getRandomValues
    : null;

  if (policy === null || typeof policy !== "object" ||
      !Number.isInteger(policy.MAX_COPY_TEXT_LENGTH) || policy.MAX_COPY_TEXT_LENGTH < 1) {
    console.error("[YodelPhish] ClickFix policy failed to load; clipboard mediation is unavailable.");
    return;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "clickfix_validate_source_document") {
      sendResponse({ ok: true });
    }
    return false;
  });

  let recentRequestTimes = [];
  let manualCopyGuardUntil = 0;
  let requestEventName = null;
  let resultEventName = null;
  const bridgeTarget = document;
  const guardedWindow = window;

  function eventTarget(event) {
    return eventTargetGetter === null ? event.target : nativeApply(eventTargetGetter, event, []);
  }

  function eventDetail(event) {
    return customEventDetailGetter === null ? event.detail : nativeApply(customEventDetailGetter, event, []);
  }

  function privateEventName(kind) {
    if (getRandomValues === null || typeof NativeUint32Array !== "function") return null;
    const words = new NativeUint32Array(6);
    nativeApply(getRandomValues, randomSource, [words]);
    return `__yodelphish_clickfix_${kind}_${words[0]}_${words[1]}_${words[2]}_${words[3]}_${words[4]}_${words[5]}`;
  }

  function dispatchPrivateEvent(type, detail) {
    if (typeof NativeCustomEvent !== "function") return false;
    const event = new NativeCustomEvent(type, {
      detail,
      bubbles: false,
      composed: false,
    });
    return nativeApply(eventTargetDispatch, bridgeTarget, [event]);
  }

  // Run before page keydown handlers. A hostile handler can otherwise borrow
  // the Ctrl/Meta+C activation, call the genuine patched writeText method, and
  // race the browser's manual copy with an asynchronous extension-owned copy.
  // Keep the guard through the browser's bounded transient-activation window;
  // clearing it at event return would reopen that exact race.
  function handleCopyShortcutKeydown(event) {
    if (event.isTrusted !== true || (event.ctrlKey !== true && event.metaKey !== true)) return;
    const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
    if (key !== "c" && key !== "x") return;
    manualCopyGuardUntil = dateNow() + MANUAL_COPY_GUARD_MS;
    // Do not preventDefault: the browser must still emit the copy/cut event.
    // Stopping later page keydown handlers prevents them from scheduling a
    // competing programmatic write with this trusted activation.
    nativeApply(stopImmediatePropagation, event, []);
  }

  function withDeadline(promise) {
    let timeout;
    const deadline = new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("ClickFix inspection timed out")), REQUEST_TIMEOUT_MS);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
  }

  function rateLimitAllowsRequest() {
    const now = Date.now();
    recentRequestTimes = recentRequestTimes.filter((time) => now - time < RATE_WINDOW_MS);
    if (recentRequestTimes.length >= MAX_REQUESTS_PER_WINDOW) return false;
    recentRequestTimes.push(now);
    return true;
  }

  function hasProgrammaticClipboardAuthority() {
    if (navigator.userActivation?.isActive !== true || typeof document.hasFocus !== "function") return false;
    try {
      if (document.hasFocus() !== true) return false;
      const permissionsPolicy = document.permissionsPolicy ?? document.featurePolicy;
      return permissionsPolicy !== null && typeof permissionsPolicy === "object" &&
        typeof permissionsPolicy.allowsFeature === "function" &&
        permissionsPolicy.allowsFeature("clipboard-write") === true;
    } catch {
      return false;
    }
  }

  function hasManualClipboardAuthority() {
    if (navigator.userActivation?.isActive !== true || typeof document.hasFocus !== "function") return false;
    try {
      return document.hasFocus() === true;
    } catch {
      return false;
    }
  }

  async function mediateProgrammaticRequest(data) {
    if (!rateLimitAllowsRequest()) return "error";
    try {
      const response = await withDeadline(chrome.runtime.sendMessage({
        type: "clickfix_clipboard_request",
        operation: data.operation,
        text: data.text,
      }));
      if (response?.ok !== true) return "error";
      return ["copied", "blocked", "warning"].includes(response.status)
        ? response.status
        : "error";
    } catch {
      return "error";
    }
  }

  function sendPrivateResult(requestId, status) {
    if (resultEventName === null) return;
    dispatchPrivateEvent(resultEventName, jsonStringify({ requestId, status }));
  }

  function handlePrivateRequest(requestEvent) {
    if (eventTarget(requestEvent) !== bridgeTarget) return;
    const serialized = eventDetail(requestEvent);
    if (typeof serialized !== "string" || serialized.length > policy.MAX_COPY_TEXT_LENGTH + 512) return;

    let data;
    try {
      data = jsonParse(serialized);
    } catch {
      return;
    }
    const programmatic = data !== null && typeof data === "object" &&
      (data.operation === "writeText" || data.operation === "write") &&
      typeof data.text === "string";
    const manual = data !== null && typeof data === "object" &&
      (data.operation === "copy" || data.operation === "cut") &&
      data.manual === true && data.text === undefined;
    const manualIntent = data !== null && typeof data === "object" &&
      data.operation === "manual-intent" && data.manual === true && data.text === undefined;
    if ((programmatic === false && manual === false && manualIntent === false) ||
        !REQUEST_ID_RE.test(data.requestId)) {
      return;
    }

    const sendResult = (status) => sendPrivateResult(data.requestId, status);
    if (manualIntent) {
      if (hasManualClipboardAuthority()) manualCopyGuardUntil = dateNow() + MANUAL_COPY_GUARD_MS;
      return;
    }
    if (manual) {
      if (!hasManualClipboardAuthority()) return;
      // Context-menu and page-triggered trusted copy/cut paths have no
      // preceding keyboard intent. Arm the same bounded overwrite guard before
      // snapshotting so a callback cannot borrow that activation for a later
      // programmatic write that races the approved manual value.
      manualCopyGuardUntil = dateNow() + MANUAL_COPY_GUARD_MS;
      let snapshot;
      try {
        snapshot = snapshotClipboardText();
      } catch {
        return;
      }
      if (snapshot.text === "" || snapshot.text.length > policy.MAX_COPY_TEXT_LENGTH) return;
      mediateManualSnapshot(snapshot, data.operation);
      return;
    }
    if (dateNow() < manualCopyGuardUntil ||
        !hasProgrammaticClipboardAuthority() ||
        data.text.length > policy.MAX_COPY_TEXT_LENGTH) {
      sendResult("blocked");
      return;
    }
    mediateProgrammaticRequest(data).then(sendResult);
  }

  function installPrivateRequestListener() {
    if (requestEventName === null) return;
    nativeApply(eventTargetRemove, bridgeTarget, [requestEventName, handlePrivateRequest, true]);
    nativeApply(eventTargetAdd, bridgeTarget, [requestEventName, handlePrivateRequest, { capture: true }]);
  }

  // MAIN registers the well-known listener before this isolated script runs.
  // Generate both private event names independently, install the privileged
  // request listener first, and then hand the names to MAIN synchronously. The
  // MAIN listener consumes and stops this non-bubbling bootstrap event, so no
  // recurring, page-known event or window.message API has clipboard authority.
  if (typeof NativeCustomEvent === "function" && getRandomValues !== null) {
    requestEventName = privateEventName("request");
    resultEventName = privateEventName("result");
    if (requestEventName !== null && resultEventName !== null &&
        requestEventName !== resultEventName &&
        PRIVATE_EVENT_RE.test(requestEventName) && PRIVATE_EVENT_RE.test(resultEventName)) {
      installPrivateRequestListener();
      dispatchPrivateEvent(BOOTSTRAP_EVENT, jsonStringify({ requestEventName, resultEventName }));
    } else {
      requestEventName = null;
      resultEventName = null;
    }
  }

  // Other browser-specific activation paths cannot all be attributed to a
  // user's clipboard intent from a content script. The background still
  // classifies and copies the exact snapshot, while this guard closes the
  // reproducible keyboard-copy overwrite race without widening privileges.

  function deepActiveElement(root) {
    let active = root.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  }

  function currentSelection() {
    const active = deepActiveElement(document);
    const root = active?.getRootNode?.();
    if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot &&
        typeof root.getSelection === "function") {
      const selection = root.getSelection();
      if (String(selection ?? "") !== "") return selection;
    }
    return window.getSelection();
  }

  function selectedInputSnapshot() {
    const active = deepActiveElement(document);
    if (!(active instanceof HTMLInputElement) && !(active instanceof HTMLTextAreaElement)) return null;
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
    return { element: active, start, end, text: active.value.slice(start, end) };
  }

  function snapshotClipboardText(event = null) {
    const explicitText = event?.clipboardData?.getData?.("text/plain");
    if (typeof explicitText === "string" && explicitText !== "") {
      return { text: explicitText, input: null, selection: null };
    }
    const input = selectedInputSnapshot();
    if (input !== null) return { text: input.text, input, selection: null, selectionState: null };
    const selection = currentSelection();
    return {
      text: String(selection ?? ""),
      input: null,
      selection,
      selectionState: selection === null ? null : {
        anchorNode: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode,
        focusOffset: selection.focusOffset,
        rangeCount: selection.rangeCount,
      },
    };
  }

  function dispatchCutInput(element) {
    let inputEvent;
    try {
      inputEvent = new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "deleteByCut",
        data: null,
      });
    } catch {
      inputEvent = new Event("input", { bubbles: true, composed: true });
    }
    element.dispatchEvent(inputEvent);
  }

  function deleteApprovedCut(snapshot) {
    if (snapshot.input !== null) {
      const { element, start, end, text } = snapshot.input;
      if (deepActiveElement(document) !== element || element.isConnected === false ||
          element.selectionStart !== start || element.selectionEnd !== end ||
          element.value.slice(start, end) !== text || typeof element.setRangeText !== "function") return;
      element.setRangeText("", start, end, "start");
      dispatchCutInput(element);
      return;
    }
    const state = snapshot.selectionState;
    if (snapshot.selection !== null && currentSelection() === snapshot.selection && state !== null &&
        snapshot.selection.anchorNode === state.anchorNode &&
        snapshot.selection.anchorOffset === state.anchorOffset &&
        snapshot.selection.focusNode === state.focusNode &&
        snapshot.selection.focusOffset === state.focusOffset &&
        snapshot.selection.rangeCount === state.rangeCount &&
        String(snapshot.selection) === snapshot.text &&
        typeof snapshot.selection.deleteFromDocument === "function") {
      snapshot.selection.deleteFromDocument();
    }
  }

  async function mediateManualSnapshot(snapshot, operation) {
    if (!rateLimitAllowsRequest()) return;
    try {
      const response = await withDeadline(chrome.runtime.sendMessage({
        type: "clickfix_clipboard_request",
        operation,
        text: snapshot.text,
      }));
      if (operation === "cut" && response?.ok === true && response.status === "copied") {
        deleteApprovedCut(snapshot);
      }
    } catch {
      // The native operation was cancelled first, so transport failure remains
      // closed and an unconfirmed cut never mutates the document.
    }
  }

  function handleClipboardEvent(event) {
    // Always cancel before a page listener can replace clipboard contents.
    // Neither cached mode nor an exclusion is authoritative in this realm.
    event.preventDefault();
    event.stopImmediatePropagation();

    if (event.isTrusted !== true || navigator.userActivation?.isActive !== true) return;
    const snapshot = snapshotClipboardText(event);
    if (snapshot.text === "" || snapshot.text.length > policy.MAX_COPY_TEXT_LENGTH) return;
    mediateManualSnapshot(snapshot, event.type === "cut" ? "cut" : "copy");
  }

  function installProtectedListeners() {
    nativeApply(eventTargetRemove, guardedWindow, ["keydown", handleCopyShortcutKeydown, true]);
    nativeApply(eventTargetRemove, guardedWindow, ["copy", handleClipboardEvent, true]);
    nativeApply(eventTargetRemove, guardedWindow, ["cut", handleClipboardEvent, true]);
    nativeApply(eventTargetAdd, guardedWindow, ["keydown", handleCopyShortcutKeydown, { capture: true }]);
    nativeApply(eventTargetAdd, guardedWindow, ["copy", handleClipboardEvent, { capture: true }]);
    nativeApply(eventTargetAdd, guardedWindow, ["cut", handleClipboardEvent, { capture: true }]);
    installPrivateRequestListener();
  }

  // Window capture precedes document capture and makes it harder for a page to
  // register a parent listener that stops the event before mediation.
  installProtectedListeners();

  // document.open()/write() can remove listeners while preserving this script
  // realm. Observe only root-child replacement, avoiding work for ordinary DOM
  // mutations, and restore the named listeners if that boundary is crossed.
  if (typeof NativeMutationObserver === "function" && mutationObserverObserve !== null) {
    const recoveryObserver = new NativeMutationObserver(() => {
      installProtectedListeners();
      // MAIN's earlier observer first restores its private result listener.
      // A microtask then acknowledges that both worlds are ready, allowing the
      // synchronous document.open/write copy guard to stand down.
      scheduleMicrotask(() => {
        if (resultEventName !== null) {
          dispatchPrivateEvent(resultEventName, jsonStringify({ control: "listeners_restored" }));
        }
      });
    });
    nativeApply(mutationObserverObserve, recoveryObserver, [bridgeTarget, { childList: true }]);
  }
})();
