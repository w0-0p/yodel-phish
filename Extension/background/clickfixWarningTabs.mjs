// =============================================================================
// CLICKFIX WARNING TAB LIFECYCLE — issue #29
//
// A hidden about:blank document supplies the target tab and document identity.
// State is persisted against both before navigation is authorized. tabs.update
// starts navigation; success requires the matching webNavigation commit.
// =============================================================================

export const CLICKFIX_WARNING_REFUSALS = {
  RATE_LIMITED: "rate_limited",
  UNAVAILABLE: "warning_unavailable",
};

const DEFAULT_COMMIT_TIMEOUT_MS = 10_000;

/**
 * Bridges the in-flight opener to authoritative commit/error events. Durable
 * storage remains authoritative across worker restarts; this only prevents a
 * live request handler from reporting success before its navigation commits.
 */
export function createClickfixWarningNavigationMonitor({
  timeoutMs = DEFAULT_COMMIT_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }
  const pending = new Map();

  function settle(tabId, action) {
    const entry = pending.get(tabId);
    if (entry === undefined) return false;
    pending.delete(tabId);
    clearTimeoutFn(entry.timer);
    action(entry);
    return true;
  }

  return {
    expect(tabId, requestId) {
      if (!isTabId(tabId)) throw new TypeError("tabId must be a non-negative integer");
      if (typeof requestId !== "string" || requestId === "") {
        throw new TypeError("requestId is required");
      }
      settle(tabId, (entry) => entry.reject(new Error("ClickFix navigation was superseded")));
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const timer = setTimeoutFn(() => {
        settle(tabId, (entry) => {
          entry.reject(new Error("ClickFix interstitial navigation did not commit"));
        });
      }, timeoutMs);
      timer?.unref?.();
      pending.set(tabId, { requestId, resolve, reject, timer });
      void promise.catch(() => {});
      return promise;
    },

    commit(tabId, requestId) {
      const entry = pending.get(tabId);
      if (entry === undefined || entry.requestId !== requestId) return false;
      return settle(tabId, (current) => current.resolve(true));
    },

    fail(tabId, error = new Error("ClickFix interstitial navigation failed")) {
      return settle(tabId, (entry) => {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      });
    },

    cancel(tabId) {
      return settle(tabId, (entry) => entry.resolve(false));
    },

    has(tabId) {
      return pending.has(tabId);
    },
  };
}

export async function openClickfixWarningTab(request, dependencies) {
  const {
    tabs,
    warnings,
    interstitialUrl,
    stagingUrl,
    getWarningTabDocument,
    navigationMonitor,
    isSourceDocumentAlive,
    onStateChanged = async () => {},
  } = dependencies ?? {};
  requireTabsApi(tabs);
  requireStore(warnings);
  if (typeof interstitialUrl !== "function") throw new TypeError("interstitialUrl must be a function");
  if (typeof stagingUrl !== "string" || stagingUrl === "") throw new TypeError("stagingUrl is required");
  if (typeof getWarningTabDocument !== "function") {
    throw new TypeError("getWarningTabDocument must be a function");
  }
  requireNavigationMonitor(navigationMonitor);
  if (typeof isSourceDocumentAlive !== "function") {
    throw new TypeError("isSourceDocumentAlive must be a function");
  }

  const { sourceTabId, sourceDocumentId } = request ?? {};
  if (!isTabId(sourceTabId) || typeof sourceDocumentId !== "string" || sourceDocumentId === "") {
    return refusal(CLICKFIX_WARNING_REFUSALS.UNAVAILABLE);
  }
  if (!(await warnings.canCreateWarning(sourceTabId))) {
    return refusal(CLICKFIX_WARNING_REFUSALS.RATE_LIMITED);
  }

  let warningTabId;
  try {
    const warningTab = await tabs.create({
      url: stagingUrl,
      active: false,
      openerTabId: sourceTabId,
      ...(Number.isInteger(request.windowId) ? { windowId: request.windowId } : {}),
    });
    warningTabId = warningTab?.id;
  } catch (error) {
    return refusal(CLICKFIX_WARNING_REFUSALS.UNAVAILABLE, error);
  }
  if (!isTabId(warningTabId)) {
    return refusal(
      CLICKFIX_WARNING_REFUSALS.UNAVAILABLE,
      new Error("The ClickFix warning tab was created without an id")
    );
  }

  let stagingDocument;
  try {
    stagingDocument = await getWarningTabDocument(warningTabId);
  } catch (error) {
    await closeTab(tabs, warningTabId);
    return refusal(CLICKFIX_WARNING_REFUSALS.UNAVAILABLE, error);
  }
  if (!isExactStagingDocument(stagingDocument, stagingUrl)) {
    await closeTab(tabs, warningTabId);
    return refusal(
      CLICKFIX_WARNING_REFUSALS.UNAVAILABLE,
      new Error("The ClickFix staging document could not be verified")
    );
  }

  let warning;
  try {
    warning = await warnings.createBoundWarning({
      warningTabId,
      stagingDocumentId: stagingDocument.documentId,
      sourceTabId,
      sourceFrameId: request.sourceFrameId,
      sourceDocumentId,
      sourceUrl: request.sourceUrl,
      mode: request.mode,
      decision: request.decision,
      text: request.text,
    });
  } catch (error) {
    await closeTab(tabs, warningTabId);
    await notifyStateChanged(onStateChanged);
    return refusal(CLICKFIX_WARNING_REFUSALS.UNAVAILABLE, error);
  }
  await notifyStateChanged(onStateChanged);
  if (warning === null) {
    await closeTab(tabs, warningTabId);
    return refusal(CLICKFIX_WARNING_REFUSALS.RATE_LIMITED);
  }

  try {
    if (!(await isSourceDocumentAlive(warning))) {
      await withdraw(dependencies, warning.requestId, warningTabId);
      return refusal(CLICKFIX_WARNING_REFUSALS.UNAVAILABLE);
    }

    const currentStagingDocument = await getWarningTabDocument(warningTabId);
    if (!isExactStagingDocument(currentStagingDocument, stagingUrl) ||
        currentStagingDocument.documentId !== warning.stagingDocumentId) {
      throw new Error("The ClickFix staging document was replaced");
    }

    // Cleanup may win during either async validation above. Make authorization
    // the final awaited operation before tabs.update so a missing record can
    // never be followed by navigation.
    const authorized = await warnings.beginWarningTabNavigation(
      warning.requestId,
      warningTabId
    );
    if (authorized === null) {
      await withdraw(dependencies, warning.requestId, warningTabId);
      return refusal(CLICKFIX_WARNING_REFUSALS.UNAVAILABLE);
    }
    void notifyStateChanged(onStateChanged);

    const commitPromise = navigationMonitor.expect(warningTabId, warning.requestId);
    await tabs.update(warningTabId, {
      url: interstitialUrl(warning.requestId),
      active: true,
    });
    if (!(await commitPromise)) {
      throw new Error("The ClickFix interstitial navigation was cancelled");
    }

    const activeWarning = await warnings.getWarning(warning.requestId, warningTabId);
    if (activeWarning === null || activeWarning.status !== "active") {
      throw new Error("The committed ClickFix warning state is unavailable");
    }
    return { ok: true, warning: activeWarning };
  } catch (error) {
    navigationMonitor.cancel(warningTabId);
    await withdraw(dependencies, warning.requestId, warningTabId);
    await activateTab(tabs, sourceTabId);
    return refusal(CLICKFIX_WARNING_REFUSALS.UNAVAILABLE, error);
  }
}

export async function abandonClickfixWarningTab(warningTabId, dependencies) {
  const {
    tabs,
    warnings,
    navigationMonitor,
    onStateChanged = async () => {},
  } = dependencies ?? {};
  requireTabsApi(tabs);
  requireStore(warnings);
  if (!isTabId(warningTabId)) throw new TypeError("warningTabId must be a non-negative integer");

  const warningTab = await getTab(tabs, warningTabId);
  let abandoned = null;
  let abandonError;
  try {
    abandoned = await warnings.abandonWarningTab(warningTabId);
  } catch (error) {
    abandonError = error;
  }
  navigationMonitor?.cancel?.(warningTabId);
  await notifyStateChanged(onStateChanged);
  const sourceTabId = abandoned?.sourceTabId ?? warningTab?.openerTabId;
  await activateTab(tabs, sourceTabId);
  await closeTab(tabs, warningTabId);
  if (abandonError !== undefined) throw abandonError;
  return { ok: true, warning: abandoned };
}

async function withdraw(
  { tabs, warnings, navigationMonitor, onStateChanged = async () => {} },
  requestId,
  warningTabId
) {
  navigationMonitor?.cancel?.(warningTabId);
  try {
    await warnings.discardWarning(requestId).catch(() => {});
    await notifyStateChanged(onStateChanged);
  } finally {
    await closeTab(tabs, warningTabId);
  }
}

async function notifyStateChanged(onStateChanged) {
  try {
    await onStateChanged();
  } catch {
    // Alarm scheduling cannot block cleanup, focus restoration, or progress.
  }
}

async function getTab(tabs, tabId) {
  try {
    return await tabs.get(tabId);
  } catch {
    return null;
  }
}

async function closeTab(tabs, tabId) {
  try {
    await tabs.remove(tabId);
  } catch {
    // The tab may already be gone.
  }
}

async function activateTab(tabs, tabId) {
  if (!isTabId(tabId)) return;
  try {
    await tabs.update(tabId, { active: true });
  } catch {
    // The source tab may already be gone.
  }
}

function isExactStagingDocument(document, stagingUrl) {
  return document !== null && typeof document === "object" &&
    document.url === stagingUrl &&
    typeof document.documentId === "string" &&
    document.documentId !== "";
}

function refusal(code, error) {
  return error === undefined ? { ok: false, code } : { ok: false, code, error };
}

function isTabId(value) {
  return Number.isInteger(value) && value >= 0;
}

function requireTabsApi(tabs) {
  if (tabs === null || typeof tabs !== "object" || typeof tabs.create !== "function" ||
      typeof tabs.get !== "function" || typeof tabs.update !== "function" ||
      typeof tabs.remove !== "function") {
    throw new TypeError("A chrome.tabs-compatible API is required");
  }
}

function requireStore(warnings) {
  if (warnings === null || typeof warnings !== "object") {
    throw new TypeError("A ClickFix warning store is required");
  }
}

function requireNavigationMonitor(monitor) {
  if (monitor === null || typeof monitor !== "object" ||
      typeof monitor.expect !== "function" ||
      typeof monitor.cancel !== "function") {
    throw new TypeError("A ClickFix navigation monitor is required");
  }
}
