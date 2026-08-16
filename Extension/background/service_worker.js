import { parse } from "tldts";
import { ChromeScreenshotSource, collectUiCoveredBoxes } from "../../src/detection/browser/screenshotSource";
import { ChromeTrustedSource } from "../../src/detection/browser/chromeTrustedSource";
import {
  ACTION_FEEDBACK_DURATION_MS,
  ACTION_OUTCOMES,
  ICON_STATE_ANIMATIONS,
  actionFeedbackFor,
  badgeForIconState,
  classifyManualTriggerResponse,
  isAnalysablePageUrl,
} from "./actionFeedback.mjs";
import {
  JOB_TOTAL_TIMEOUT_MS,
  MESSAGE_RESPONSE_TIMEOUT_MS,
  OFFSCREEN_PING_ATTEMPT_TIMEOUT_MS,
  OFFSCREEN_ROUND_TRIP_TIMEOUT_MS,
  OFFSCREEN_STARTUP_TIMEOUT_MS,
  TRUSTED_ADD_LOGO_SEARCH_TIMEOUT_MS,
} from "./inferenceLimits.mjs";
import {
  convertUiCoverBoxesToImageSpace,
  readPngDimensionsFromDataUrl,
  uiCoverCapturesMatch,
} from "./uiCoverBoxes.mjs";
import {
  CANCELLATION_REASONS,
  cancellationPresentation,
  classifyTopFrameForJob,
  jobMatchesAddress,
  jobMatchesSameDocumentState,
  navigationDiagnostics,
} from "./navigationState.mjs";
import { createCaptureTracker, createSelectorSessionStore, selectorSessionStatus } from "./selectorSessions.mjs";
import { createTrustedAddIntentStore } from "./trustedAddIntents.mjs";
import { createInterruptionTabs } from "./interruptionTabs.mjs";
import { createClickfixWarningStore } from "./clickfixWarnings.mjs";
import clickfixPolicy from "../content/clickfix-policy.js";
import {
  DEFAULT_DEVICE_FLOW_REGISTRY,
  MAX_DEVICE_FLOW_ENTRIES,
  canonicalizeHostname as canonicalizeDeviceFlowHostname,
  canonicalizePath as canonicalizeDeviceFlowPath,
  normalizeDeviceFlowEndpointParts,
  matchDeviceFlowEndpoint,
  parseDeviceFlowEndpointInput,
  isTrustedDeviceFlowInitiator,
} from "./deviceFlowRegistry.mjs";
import {
  DEVICE_FLOW_UNKNOWN_SOURCE,
  classifyDeviceFlowNavigation,
  resolveDeviceFlowSourceOrigin,
} from "./deviceFlowNavigation.mjs";
import { createDeviceFlowStore } from "./deviceFlowSessions.mjs";
import { createDeviceFlowSameTabSourceStore } from "./deviceFlowSameTabSources.mjs";
import {
  applyManualLogoSelection,
  applyManualSiteMutation,
  compensateTrustedMutedCommit,
  createStorageDomain,
  DomainQueue,
  enforceTrustedVariantCap,
  MAX_STORED_SCORES,
  MAX_TRUSTED_VARIANTS_PER_FQDN,
  normalizeFqdn,
  removeAllManualSiteEntries,
  removeManualSiteEntries,
  repairTrustedMutedLists,
  variantRecency,
} from "./storageQueues.mjs";

const OFFSCREEN_TARGET = "yodel-offscreen";
const CLICKFIX_CLIPBOARD_TARGET = "yodel-clickfix-clipboard";
const OFFSCREEN_DOCUMENT = "runtime/offscreen.html";
const INTERSTITIAL_PAGE = "interstitial/interstitial.html";
const PHISHING_STATE_KEY = "phishing_warning_state";
const ANALYSIS_HISTORY_KEY = "analysis_history";
const MAX_ANALYSIS_HISTORY = 25;
// 2: newly written records reduce the analysed address to its hostname (see
// compactOrigin), store non-winning candidates as comparison-table rows only,
// omit the full-page OCR transcription, and carry context and failure code on
// error records. Records created by older versions are retained unchanged.
const ANALYSIS_HISTORY_SCHEMA = 2;
const DRIFT_THRESHOLD = 1.5;

const SETTINGS_PAGE_URL = chrome.runtime.getURL("settings/settings.html");
const POPUP_PAGE_URL = chrome.runtime.getURL("popup/popup.html");
const MAX_USER_WORD_LENGTH = 50;
const ALLOWED_MUTED_UNTIL = new Set(["forever", "next_login"]);

// ClickFix protection (issue #26). User-authored regular expressions were
// intentionally removed: JavaScript regex execution cannot be safely bounded
// and the feature added disproportionate storage, UI, and renderer-DoS risk.
const CLICKFIX_MODES = new Set(["strict", "warn"]);
const CLICKFIX_OPERATIONS = new Set(["writeText", "write", "copy", "cut"]);
const MAX_CLICKFIX_DOMAIN_EXCLUSIONS = 50;
const MAX_CLICKFIX_DOMAIN_LENGTH = 253;
const CLICKFIX_CLIPBOARD_TIMEOUT_MS = 5_000;
const CLICKFIX_INTERSTITIAL_BASE = chrome.runtime.getURL(INTERSTITIAL_PAGE + "?kind=clickfix");
const CLICKFIX_OPAQUE_SOURCE_URL = "opaque-frame:";
const CLICKFIX_WARNING_EXPIRY_ALARM = "clickfix-warning-expiry";
const { MAX_COPY_TEXT_LENGTH, detectClickfixCommand } = clickfixPolicy;

// Device-code phishing protection (issue #39).
const DEVICE_FLOW_INTERSTITIAL_URL = chrome.runtime.getURL(INTERSTITIAL_PAGE + "?kind=device_flow");
// Sentinel sourceOrigin for a relationship the user's own navigation created
// (issue #75): never a URL, so it can't be mistaken for a source website.
const DEVICE_FLOW_DIRECT_SOURCE = "direct";
const DEVICE_FLOW_EXPIRY_ALARM = "device-flow-expiry";

// Banner text sizes selectable in settings (issue #3); "small" is the
// original size and the default.
const BANNER_FONT_SIZES = new Set(["small", "medium", "large"]);

const SETTINGS_MESSAGE_TYPES = new Set([
  "prepare_settings_state",
  "open_logo_selector",
  "add_user_word",
  "remove_user_word",
  "update_muted_until",
  "remove_list_entry",
  "move_muted_to_trusted",
  "add_manual_site",
  "edit_manual_site",
  "remove_manual_site",
  "set_developer_mode",
  "set_device_code_auth",
  "reset_advanced_settings",
  "set_banner_font_size",
  "clear_analysis_history",
  "set_clickfix_mode",
  "add_clickfix_domain_exclusion",
  "remove_clickfix_domain_exclusion",
  "get_device_flow_builtin_endpoints",
  "add_device_flow_endpoint",
  "update_device_flow_endpoint",
  "remove_device_flow_endpoint",
]);

// Prevent content scripts from bypassing the service worker's mutation queues
// with direct chrome.storage.local writes. manifest.json requires Chrome 116+,
// well past the version where this access control is available.
const storageAccessReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
void storageAccessReady.catch((error) => {
  console.error("[YodelPhish] Failed to restrict local storage to trusted extension contexts:", error);
});

const trustedLocalStorage = {
  async get(keys) {
    await storageAccessReady;
    return chrome.storage.local.get(keys);
  },
  async set(values) {
    await storageAccessReady;
    return chrome.storage.local.set(values);
  },
};

// =============================================================================
// ANALYSIS EXECUTION LIMITS — issue #9. The authoritative inference queue now
// lives in the offscreen document, so service-worker suspension or restart
// cannot create a second independent scheduler. All message deadlines remain
// below Chrome's five-minute per-request limit.
// =============================================================================

const trustedSource = new ChromeTrustedSource();
let creatingOffscreenDocument;
// Memoized readiness gate -- mirrors creatingOffscreenDocument's in-flight-
// promise pattern. Reset (to null) whenever the runtime might no longer be
// valid (recycle, or a failed readiness wait) so the next caller re-attempts
// from scratch instead of reusing a stale/failed gate.
let offscreenReadyPromise = null;
let recyclingOffscreenDocument = null;
const offscreenFailureListeners = new Set();


// Issue #24: a manual logo selection outlives any single worker lifetime, so
// its session (including an add-to-trusted session's payload and candidate
// boxes, issue #90) lives in chrome.storage.session rather than in worker
// memory.
const selectorSessions = createSelectorSessionStore(chrome.storage.session);
// Issue #8: a Settings "Move to trusted" opens the site in a new tab for the
// same interactive logo confirmation as "Add to trusted". That the tab is such
// a confirmation flow is recorded here, keyed by tab id, and must outlive a
// worker restart between opening the tab and the content script asking, so it
// lives in chrome.storage.session too.
const trustedAddIntents = createTrustedAddIntentStore(chrome.storage.session);
const captureTracker = createCaptureTracker();
const screenshotSource = new ChromeScreenshotSource(captureTracker);
let phishingStateQueue = Promise.resolve();

const activeJobs = new Map();
const INTERRUPTION_STATE_KEY = "analysis_interruption_state";
const INTERRUPTION_DELAY_MS = 200;
const INTERRUPTION_READY_TIMEOUT_MS = 5_000;
let interruptionStateQueue = Promise.resolve();
const interruptionTabs = createInterruptionTabs({
  tabs: chrome.tabs,
  interruptionUrl: chrome.runtime.getURL(INTERSTITIAL_PAGE + "?kind=interrupted"),
  store: storeInterruption,
  removeStored: takeInterruptionByInterstitial,
  readyTimeoutMs: INTERRUPTION_READY_TIMEOUT_MS,
});
const clickfixWarnings = createClickfixWarningStore(chrome.storage.session);

async function scheduleClickfixWarningExpiry() {
  const nextExpiry = await clickfixWarnings.nextExpiry();
  if (nextExpiry === null) {
    await chrome.alarms.clear(CLICKFIX_WARNING_EXPIRY_ALARM);
    return;
  }
  await chrome.alarms.create(CLICKFIX_WARNING_EXPIRY_ALARM, {
    when: Math.max(nextExpiry, Date.now() + 100),
  });
}

async function pruneAndScheduleClickfixWarnings() {
  await clickfixWarnings.pruneExpired();
  await scheduleClickfixWarningExpiry();
}

void pruneAndScheduleClickfixWarnings().catch((error) => {
  console.warn("[YodelPhish] Failed to initialize ClickFix warning expiry:", error);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== CLICKFIX_WARNING_EXPIRY_ALARM) return;
  void pruneAndScheduleClickfixWarnings().catch((error) => {
    console.warn("[YodelPhish] Failed to expire ClickFix warning state:", error);
  });
});

const deviceFlowSessions = createDeviceFlowStore(chrome.storage.session);
const sameTabDeviceFlowSources = createDeviceFlowSameTabSourceStore(chrome.storage.session);

async function scheduleDeviceFlowExpiry() {
  const nextExpiry = await deviceFlowSessions.nextExpiry();
  if (nextExpiry === null) {
    await chrome.alarms.clear(DEVICE_FLOW_EXPIRY_ALARM);
    return;
  }
  await chrome.alarms.create(DEVICE_FLOW_EXPIRY_ALARM, { when: Math.max(nextExpiry, Date.now() + 100) });
}

async function pruneAndScheduleDeviceFlow() {
  await deviceFlowSessions.pruneExpired();
  await scheduleDeviceFlowExpiry();
}

void pruneAndScheduleDeviceFlow().catch((error) => {
  console.warn("[YodelPhish] Failed to initialize device-flow relationship expiry:", error);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== DEVICE_FLOW_EXPIRY_ALARM) return;
  void pruneAndScheduleDeviceFlow().catch((error) => {
    console.warn("[YodelPhish] Failed to expire device-flow relationship state:", error);
  });
});

async function cleanupClickfixWarningTabNavigation(tabId, url) {
  const requestId = clickfixRequestIdFromInterstitial(url);
  if (requestId === null || await clickfixWarnings.getWarning(requestId, tabId) === null) {
    await clickfixWarnings.discardWarningTab(tabId);
  }
}

async function cleanupClickfixCommittedNavigation(details) {
  const documentId = typeof details.documentId === "string" && details.documentId !== ""
    ? details.documentId
    : undefined;
  await clickfixWarnings.discardSourceDocument(details.tabId, details.frameId, documentId);
  if (details.frameId === 0) {
    await cleanupClickfixWarningTabNavigation(details.tabId, details.url);
  }
  await scheduleClickfixWarningExpiry();
}

function activeJobFor(tabId) {
  const job = activeJobs.get(tabId);
  return job === undefined || isJobTerminal(job) ? null : job;
}

// Issue #88 — telling a navigation that happened *after* an analysis started
// from a late notification of the one it was started for.
//
// An SPA renders its login form and pushes the new route in a single task. The
// History API notification, the tab URL notification and the content script's
// own 200 ms mutation timer then race each other through the service worker,
// so run_pipeline can legitimately be accepted before the browser
// notifications describing that route arrive. Because a job now stores the
// authoritative top-frame URL and documentId resolved at acceptance, such a
// late notification is recognizable: it describes exactly the state the job is
// already anchored to, and must neither interrupt the screenshot guard nor
// cancel the job. Comparison is plain equality — no normalization, no
// timestamps, no navigation generations.
//
// tabs.onUpdated carries no document identity, so there the address is all it
// can assert; webNavigation.onCommitted stays the authoritative guard for a
// reload or replacement document at the same address.
function isActiveJobAddress(tabId, url) {
  return jobMatchesAddress(activeJobFor(tabId), url);
}

function isActiveJobSameDocumentState(details) {
  return jobMatchesSameDocumentState(activeJobFor(details.tabId), details);
}

function interruptForNavigation(tabId, url) {
  const job = activeJobFor(tabId);
  if (job === null) return;
  if (job.expectedNavigationUrl === url) return;
  if (job.url === url) return; // see isActiveJobAddress
  // Ordinary top-level navigation: the arriving document runs its own login
  // detection, so cancel silently rather than warning the user (issue #2).
  cancelJobForNavigation(tabId, job, CANCELLATION_REASONS.URL_CHANGED, url, navigationDiagnostics({
    context: job.kind,
    source: "tabs.onUpdated",
    job,
    url,
  }));
}

function interruptForSameDocumentNavigation(details, reasonHint, source) {
  const job = activeJobFor(details.tabId);
  if (job === null) return;
  if (job.expectedNavigationUrl === details.url) return;
  if (isActiveJobSameDocumentState(details)) return;
  const diagnostics = navigationDiagnostics({
    context: job.kind,
    source,
    job,
    url: details.url,
    documentId: details.documentId,
  });
  cancelJobForNavigation(details.tabId, job, reasonHint, details.url, diagnostics);
}

function interruptForCommittedDocument(details) {
  const job = activeJobFor(details.tabId);
  if (job === null) return;
  if (job.expectedNavigationUrl === details.url) return;
  if (job.documentId === null || typeof details.documentId !== "string") return;
  // A replacement document at the same address (e.g. a reload with a new
  // documentId) silently invalidates the old job; the fresh document analyses
  // itself independently.
  if (job.documentId !== details.documentId) {
    cancelJobForNavigation(details.tabId, job, CANCELLATION_REASONS.DOCUMENT_REPLACED, details.url, navigationDiagnostics({
      context: job.kind,
      source: "webNavigation.onCommitted",
      job,
      url: details.url,
      documentId: details.documentId,
    }));
  }
}

chrome.tabs.onUpdated.addListener(async (updatedTabId, changeInfo) => {
  if (changeInfo.url !== undefined) {
    // A URL notification restating the active job's own address is not a
    // navigation away from it (issue #88): same-document route changes are
    // reported here too, and can arrive after the analysis they caused was
    // already accepted.
    if (!isActiveJobAddress(updatedTabId, changeInfo.url)) {
      captureTracker.interruptTab(updatedTabId);
    }
    // Belongs with the other synchronous "this tab navigated" invalidations,
    // before anything is awaited. Held until after the storage round trips
    // below, it could still be in flight when the arriving page asserts its
    // own icon state -- and then erase it. The device-code advisory (issue
    // #39/#75) is the one that always loses that race: it is asserted from
    // content.js the moment the page loads, and again on every same-document
    // navigation the provider makes while the user reads the banner, so its
    // badge landed inside this window every time (issue #77-adjacent).
    invalidateActionFeedback(updatedTabId);
    await cleanupClickfixWarningTabNavigation(updatedTabId, changeInfo.url)
      .then(scheduleClickfixWarningExpiry)
      .catch((error) => {
        console.warn("[YodelPhish] Failed to clean navigated ClickFix warning tab:", error);
      });
    const isOpeningBlank = changeInfo.url === "about:blank" && interruptionTabs.isWaiting(updatedTabId);
    if (!isInterruptionUrl(changeInfo.url) && !isOpeningBlank) {
      await handleInterruptedTabUnavailable(updatedTabId).catch((error) => {
        console.error("[YodelPhish] Failed to release an unavailable interruption tab:", error);
      });
    }
    await reconcilePhishingNavigation(updatedTabId, changeInfo.url).catch((error) => {
      console.error("[YodelPhish] Failed to enforce phishing warning navigation:", error);
    });
    interruptForNavigation(updatedTabId, changeInfo.url);
  }

  if (changeInfo.status === "complete") {
    await injectLogoSelector(updatedTabId).catch((error) => {
      console.error("[YodelPhish] Logo selector injection failed:", error);
    });
  }
});

chrome.tabs.onActivated.addListener(({ windowId }) => {
  captureTracker.interruptWindow(windowId);
});

for (const event of [chrome.tabs.onAttached, chrome.tabs.onDetached]) {
  event.addListener((tabId) => captureTracker.interruptTab(tabId));
}

for (const [event, reasonHint, source] of [
  [
    chrome.webNavigation.onHistoryStateUpdated,
    CANCELLATION_REASONS.HISTORY_STATE_CHANGED,
    "webNavigation.onHistoryStateUpdated",
  ],
  [
    chrome.webNavigation.onReferenceFragmentUpdated,
    CANCELLATION_REASONS.REFERENCE_FRAGMENT_CHANGED,
    "webNavigation.onReferenceFragmentUpdated",
  ],
]) {
  event.addListener((details) => {
    void clickfixWarnings.discardSourceDocument(details.tabId, details.frameId)
      .then(scheduleClickfixWarningExpiry)
      .catch((error) => {
        console.warn("[YodelPhish] Failed to discard navigated ClickFix source state:", error);
      });
    if (details.frameId !== 0) return;
    invalidateActionFeedback(details.tabId);
    // Issue #88: only a route state the active job does not already represent
    // invalidates it. The normal page_history_changed notification below is
    // forwarded either way, so DOM and device-flow evaluation are unaffected.
    if (!isActiveJobSameDocumentState(details)) {
      captureTracker.interruptTab(details.tabId);
      interruptForSameDocumentNavigation(details, reasonHint, source);
    }
    void handleDeviceFlowHistoryChange(details.tabId, details.url).catch((error) => {
      console.warn("[YodelPhish] Failed to evaluate device-flow history navigation:", error);
    });
  });
}

// Promise maps close the event-ordering gaps while the durable records in
// chrome.storage.session survive MV3 worker suspension.
const sameTabSourcePreparations = new Map();
const createdDeviceFlowTargetPreparations = new Map();

// A top-level commit can replace the document without changing the URL. If it
// happens during capture, the screenshot guard must remain interrupted even if
// the tab later returns to the same address.
chrome.webNavigation.onCommitted.addListener((details) => {
  void cleanupClickfixCommittedNavigation(details).catch((error) => {
    console.warn("[YodelPhish] Failed to clean committed ClickFix navigation:", error);
  });
  if (details.frameId !== 0) return;
  captureTracker.interruptTab(details.tabId);
  interruptForCommittedDocument(details);
  const sameTabPreparation = sameTabSourcePreparations.get(details.tabId);
  const createdTargetPreparation = createdDeviceFlowTargetPreparations.get(details.tabId);
  sameTabSourcePreparations.delete(details.tabId);
  // Await both source snapshots before evaluating. Their durable records are
  // still authoritative after a worker restart, but in one worker lifetime
  // this prevents a temporary "unknown" opener from being hard-blocked.
  void Promise.all([
    Promise.resolve(sameTabPreparation).catch((error) => {
      console.warn("[YodelPhish] Failed to prepare same-tab device-flow source:", error);
    }),
    Promise.resolve(createdTargetPreparation).catch((error) => {
      console.warn("[YodelPhish] Failed to prepare created device-flow target:", error);
    }),
  ])
    .then(() => recordSameTabDeviceFlowSource(details))
    .catch((error) => {
      console.warn("[YodelPhish] Failed to record same-tab device-flow source:", error);
    })
    .then(() => handleDeviceFlowCommit(details.tabId, details.url))
    .catch((error) => {
      console.warn("[YodelPhish] Failed to evaluate device-flow navigation:", error);
    });
});

// Same-tab device-code arrival (issues #68/#75): onBeforeNavigate snapshots
// the current source for every web navigation. onCommitted classifies the
// final transition and consumes that source, so forms and server redirects
// retain the page that actually initiated them.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  const preparation = prepareSameTabDeviceFlowSource(details);
  sameTabSourcePreparations.set(details.tabId, preparation);
  void preparation.catch((error) => {
    if (sameTabSourcePreparations.get(details.tabId) === preparation) {
      sameTabSourcePreparations.delete(details.tabId);
    }
    console.warn("[YodelPhish] Failed to prepare same-tab device-flow source:", error);
  });
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  const preparation = sameTabSourcePreparations.get(details.tabId);
  sameTabSourcePreparations.delete(details.tabId);
  void Promise.resolve(preparation)
    .catch(() => {})
    .then(() => sameTabDeviceFlowSources.discardTab(details.tabId))
    .catch((error) => {
      console.warn("[YodelPhish] Failed to discard aborted same-tab device-flow source:", error);
    });
  void abortTrustedAddIntent(details.tabId).catch((error) => {
    console.warn("[YodelPhish] Failed to abort trusted-add intent after navigation error:", error);
  });
});

async function prepareSameTabDeviceFlowSource(details) {
  const [frame, tab] = await Promise.all([
    chrome.webNavigation.getFrame({ tabId: details.tabId, frameId: 0 }).catch(() => null),
    chrome.tabs.get(details.tabId).catch(() => null),
  ]);

  let sourceOrigin;
  try {
    const source = new URL(frame?.url ?? tab?.url ?? "");
    const target = new URL(details.url);
    if ((source.protocol !== "http:" && source.protocol !== "https:") ||
        (target.protocol !== "http:" && target.protocol !== "https:")) {
      await sameTabDeviceFlowSources.discardTab(details.tabId);
      return;
    }
    sourceOrigin = source.origin;
  } catch {
    await sameTabDeviceFlowSources.discardTab(details.tabId);
    return;
  }

  await sameTabDeviceFlowSources.record({
    tabId: details.tabId,
    sourceOrigin,
  });
}

async function recordSameTabDeviceFlowSource(details) {
  const { settings } = await getStorage();
  const match = matchDeviceFlowEndpoint(
    details.url,
    deviceFlowRegistryWith(settings.device_flow_user_endpoints)
  );
  const source = await sameTabDeviceFlowSources.consume(details.tabId);
  if (match === null || classifyDeviceFlowNavigation(details) !== "page") return;

  // createRelationship keeps an existing (e.g. cross-tab) record untouched.
  await deviceFlowSessions.createRelationship({
    sourceTabId: details.tabId,
    sourceFrameId: 0,
    targetTabId: details.tabId,
    sourceOrigin: source?.sourceOrigin ?? DEVICE_FLOW_UNKNOWN_SOURCE,
  });
  await scheduleDeviceFlowExpiry();
}

// A page opening a new tab/window is the strongest device-code phishing
// signal (issue #39): the relationship is recorded immediately, before either
// tab's own analysis has a chance to run, so the target is protected even if
// the source page is never itself flagged as anything.
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  const preparation = recordDeviceFlowNavigationTarget(details);
  createdDeviceFlowTargetPreparations.set(details.tabId, preparation);
  void preparation.then(
    () => {
      if (createdDeviceFlowTargetPreparations.get(details.tabId) === preparation) {
        createdDeviceFlowTargetPreparations.delete(details.tabId);
      }
    },
    (error) => {
      if (createdDeviceFlowTargetPreparations.get(details.tabId) === preparation) {
        createdDeviceFlowTargetPreparations.delete(details.tabId);
      }
      console.warn("[YodelPhish] Failed to record device-flow navigation target:", error);
    }
  );
});

async function recordDeviceFlowNavigationTarget(details) {
  // Queue the relationship before awaiting any tab lookup. onCommitted may
  // otherwise evaluate a fast target first and incorrectly downgrade it to
  // the direct-navigation advisory.
  const relationship = await deviceFlowSessions.createRelationship({
    sourceTabId: details.sourceTabId,
    sourceFrameId: details.sourceFrameId,
    targetTabId: details.tabId,
    sourceOrigin: DEVICE_FLOW_UNKNOWN_SOURCE,
  });
  await resolveDeviceFlowRelationshipSource(relationship);
  await scheduleDeviceFlowExpiry();
}

async function resolveDeviceFlowRelationshipSource(relationship) {
  if (relationship.sourceOrigin !== DEVICE_FLOW_UNKNOWN_SOURCE ||
      relationship.sourceTabId === relationship.targetTabId) {
    return relationship;
  }
  const sourceOrigin = await resolveDeviceFlowSourceOrigin(relationship, {
    getFrame: (query) => chrome.webNavigation.getFrame(query),
    getTab: (tabId) => chrome.tabs.get(tabId),
  });
  if (sourceOrigin === DEVICE_FLOW_UNKNOWN_SOURCE) return relationship;
  return await deviceFlowSessions.recordSourceOrigin(relationship.targetTabId, sourceOrigin) ?? relationship;
}

// The effective registry: read-only built-ins (code) plus user-added endpoints.
function deviceFlowRegistryWith(userEndpoints) {
  return [...DEFAULT_DEVICE_FLOW_REGISTRY, ...userEndpoints];
}

function sameDeviceFlowEndpoint(left, right) {
  return deviceFlowEndpointKey(left) === deviceFlowEndpointKey(right);
}

// The relationship is scoped to the first exact endpoint it reaches. An
// unrelated URL or a different registered endpoint ends that handling; only
// an authority-less loading commit and this extension's interstitial are
// ignored. The pre-commit snapshot can cross server redirects, but a
// relationship never spans a later unrelated committed document.
async function pruneDeviceFlowForCommit(tabId, url) {
  const relationship = await deviceFlowSessions.getRelationship(tabId);
  if (relationship === null) return;
  // An authority-less commit (about:blank while the popup loads) is not a
  // real navigation yet, and this extension's own warning interstitial must
  // not count as leaving the flow.
  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = "";
  }
  if (hostname === "" || isInterstitialUrl(url)) return;
  const { settings } = await getStorage();
  const match = matchDeviceFlowEndpoint(url, deviceFlowRegistryWith(settings.device_flow_user_endpoints));
  if (match !== null && (relationship.returnPath === null || sameDeviceFlowEndpoint(relationship.returnPath, match))) return;
  await deviceFlowSessions.discardRelationship(tabId);
  await scheduleDeviceFlowExpiry();
}

// Shared by the webNavigation commit handler and the run_pipeline fallback
// below. Returns null when the URL is not a recognized device-login endpoint.
// With Device Code Authentication blocked (the default, issue #75) every
// arrival is interrupted ("interstitial"); when a developer has allowed it,
// only an arrival from an unrelated website is -- a direct navigation or a
// provider-internal handoff downgrades to the High Risk Login banner.
async function evaluateDeviceFlow(tabId, url) {
  const { settings } = await getStorage();
  const registry = deviceFlowRegistryWith(settings.device_flow_user_endpoints);
  const match = matchDeviceFlowEndpoint(url, registry);
  if (match === null) return null;
  // User endpoints carry no provider label; their hostname is the display name.
  const provider = match.provider ?? match.hostname;
  const allowed = settings.device_code_auth === "allowed";
  const returnPath = { hostname: match.hostname, path: match.path };

  let relationship = await deviceFlowSessions.getRelationship(tabId);
  if (relationship !== null && relationship.returnPath !== null &&
      !sameDeviceFlowEndpoint(relationship.returnPath, returnPath)) {
    await deviceFlowSessions.discardRelationship(tabId);
    await scheduleDeviceFlowExpiry();
    relationship = null;
  }

  if (relationship?.sourceOrigin === DEVICE_FLOW_UNKNOWN_SOURCE) {
    relationship = await resolveDeviceFlowRelationshipSource(relationship);
  }

  if (relationship === null) {
    if (allowed) return { action: "banner", provider };
    // Blocked mode interrupts direct navigations too. The synthetic
    // relationship carries the acknowledgment and return URL exactly like an
    // opened-by-another-site record.
    relationship = await deviceFlowSessions.createRelationship({
      sourceTabId: tabId,
      targetTabId: tabId,
      sourceOrigin: DEVICE_FLOW_DIRECT_SOURCE,
    });
  }

  const recorded = await deviceFlowSessions.recordMatch(tabId, {
    provider,
    returnPath,
  });
  if (recorded === null) return { action: "banner", provider };
  if (allowed && (recorded.sourceOrigin === DEVICE_FLOW_DIRECT_SOURCE ||
      isTrustedDeviceFlowInitiator(recorded.sourceOrigin, match))) {
    return { action: "banner", provider };
  }
  await scheduleDeviceFlowExpiry();
  return { action: "interstitial", provider };
}

async function handleDeviceFlowCommit(tabId, url) {
  await pruneDeviceFlowForCommit(tabId, url);
  const decision = await evaluateDeviceFlow(tabId, url);
  if (decision?.action === "interstitial") {
    try {
      await chrome.tabs.update(tabId, { url: DEVICE_FLOW_INTERSTITIAL_URL });
    } catch {
      return { action: "banner", provider: decision.provider };
    }
  }
  return decision;
}

async function handleDeviceFlowHistoryChange(tabId, url) {
  const decision = await handleDeviceFlowCommit(tabId, url);
  if (decision?.action === "interstitial") return;
  await chrome.tabs.sendMessage(tabId, {
    type: "page_history_changed",
    deviceFlow: decision === null
      ? { active: false }
      : { active: true, provider: decision.provider },
  }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((removedTabId) => {
  captureTracker.interruptTab(removedTabId);
  sameTabSourcePreparations.delete(removedTabId);
  createdDeviceFlowTargetPreparations.delete(removedTabId);
  void sameTabDeviceFlowSources.discardTab(removedTabId).catch((error) => {
    console.warn("[YodelPhish] Failed to discard same-tab device-flow source:", error);
  });
  void selectorSessions.discardTab(removedTabId).catch((error) => {
    console.warn("[YodelPhish] Failed to discard logo selector session state:", error);
  });
  void trustedAddIntents.discardTab(removedTabId).catch((error) => {
    console.warn("[YodelPhish] Failed to discard trusted-add intent state:", error);
  });
  const feedbackTimer = actionFeedbackTimers.get(removedTabId);
  if (feedbackTimer !== undefined) clearTimeout(feedbackTimer);
  actionFeedbackTimers.delete(removedTabId);
  actionFeedbackVersions.delete(removedTabId);
  iconStates.delete(removedTabId);
  stopIconAnimation(removedTabId);
  const removedJob = activeJobs.get(removedTabId);
  if (removedJob !== undefined) clearJobTimeout(removedJob);
  activeJobs.delete(removedTabId);
  // No user-facing terminal message is needed for tab closure (there is no
  // longer a tab to show one in) -- just release whatever this tab held in
  // the shared offscreen queue. A still-queued ticket is removed for free;
  // a still-running one terminates the dedicated inference Worker and releases
  // the real slot without destroying the coordinator or other tabs' queue.
  cancelOffscreenWork(removedTabId, undefined, "tab_closed")
    .catch((error) => {
      console.error("[YodelPhish] Failed to cancel offscreen work after tab closure:", error);
    });
  discardPhishingTabState(removedTabId).catch((error) => {
    console.error("[YodelPhish] Failed to discard phishing warning state:", error);
  });
  clickfixWarnings.discardTab(removedTabId).then(scheduleClickfixWarningExpiry).catch((error) => {
    console.error("[YodelPhish] Failed to discard ClickFix warning state:", error);
  });
  deviceFlowSessions.discardTab(removedTabId).then(scheduleDeviceFlowExpiry).catch((error) => {
    console.error("[YodelPhish] Failed to discard device-flow relationship state:", error);
  });
  interruptionTabs.cancelWait(removedTabId);
  handleInterruptedTabUnavailable(removedTabId).catch((error) => {
    console.error("[YodelPhish] Failed to clean interruption state:", error);
  });
});

// Only HTTP(S) URLs produce ordinary web-origin records.
function parseOrigin(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return null;

  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname === "") return null;

  const result = parse(hostname, { allowPrivateDomains: true });
  return {
    fqdn: hostname,
    etld1: result.domain ?? hostname,
    ocrDomain: result.domainWithoutSuffix ?? hostname.split(".")[0] ?? hostname,
    protocol: parsedUrl.protocol.replace(":", ""),
  };
}

function isFileUrl(url) {
  return typeof url === "string" && url.toLowerCase().startsWith("file:");
}

async function isFileScanPermitted() {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

// File references use a stable storage key without becoming web origins.
async function parseFileOrigin(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== "file:") return null;
  parsedUrl.hash = "";
  const sourceUrl = parsedUrl.href;
  const digest = await sha256Text(sourceUrl);
  if (digest === "") return null;
  const fqdn = `file-${digest.slice(0, 24)}.local`;
  return {
    fqdn,
    etld1: fqdn,
    ocrDomain: "",
    protocol: "file",
    sourceUrl,
  };
}

async function parseListOrigin(url) {
  const webOrigin = parseOrigin(url);
  if (webOrigin !== null) return webOrigin;
  if (!isFileUrl(url) || !(await isFileScanPermitted())) return null;
  return parseFileOrigin(url);
}

function emptyPhishingState() {
  return { pending_by_tab: {} };
}

// A state stored before issue #93 also carries a bypass_by_tab map. It is
// deliberately not part of the normalized shape: nothing reads it any more,
// and the next write drops it, so a pre-update one-time bypass authorization
// can never open a warned-about page again.
function normalizePhishingState(value) {
  if (value === null || typeof value !== "object") return emptyPhishingState();
  return {
    pending_by_tab: value.pending_by_tab !== null && typeof value.pending_by_tab === "object"
      ? value.pending_by_tab
      : {},
  };
}

function withPhishingState(mutator) {
  const operation = phishingStateQueue.then(async () => {
    const stored = await chrome.storage.session.get(PHISHING_STATE_KEY);
    const state = normalizePhishingState(stored[PHISHING_STATE_KEY]);
    const outcome = await mutator(state);
    if (outcome.changed) {
      await chrome.storage.session.set({ [PHISHING_STATE_KEY]: state });
    }
    return outcome.value;
  });
  phishingStateQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function phishingTabKey(tabId) {
  return String(tabId);
}

async function getPendingPhishingWarning(tabId) {
  return withPhishingState((state) => ({
    value: state.pending_by_tab[phishingTabKey(tabId)] ?? null,
    changed: false,
  }));
}

async function setPendingPhishingWarning(tabId, warning) {
  await withPhishingState((state) => {
    state.pending_by_tab[phishingTabKey(tabId)] = warning;
    return { value: undefined, changed: true };
  });
}

async function discardPhishingTabState(tabId) {
  await withPhishingState((state) => {
    const key = phishingTabKey(tabId);
    const changed = state.pending_by_tab[key] !== undefined;
    delete state.pending_by_tab[key];
    return { value: undefined, changed };
  });
}

function emptyInterruptionState() {
  return { by_interstitial: {} };
}

function normalizeInterruptionState(value) {
  if (value === null || typeof value !== "object" || value.by_interstitial === null || typeof value.by_interstitial !== "object") {
    return emptyInterruptionState();
  }
  return { by_interstitial: value.by_interstitial };
}

function withInterruptionState(mutator) {
  const operation = interruptionStateQueue.then(async () => {
    const stored = await chrome.storage.session.get(INTERRUPTION_STATE_KEY);
    const state = normalizeInterruptionState(stored[INTERRUPTION_STATE_KEY]);
    const outcome = await mutator(state);
    if (outcome.changed) await chrome.storage.session.set({ [INTERRUPTION_STATE_KEY]: state });
    return outcome.value;
  });
  interruptionStateQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function interruptionKey(tabId) {
  return String(tabId);
}

async function storeInterruption(entry) {
  await withInterruptionState((state) => {
    state.by_interstitial[interruptionKey(entry.interruptionTabId)] = entry;
    return { value: undefined, changed: true };
  });
}

function getInterruption(interruptionTabId) {
  return withInterruptionState((state) => ({
    value: state.by_interstitial[interruptionKey(interruptionTabId)] ?? null,
    changed: false,
  }));
}

function takeInterruptionByInterstitial(interruptionTabId) {
  return withInterruptionState((state) => {
    const key = interruptionKey(interruptionTabId);
    const entry = state.by_interstitial[key] ?? null;
    delete state.by_interstitial[key];
    return { value: entry, changed: entry !== null };
  });
}

function takeInterruptionByAnalysed(analysedTabId) {
  return withInterruptionState((state) => {
    const item = Object.entries(state.by_interstitial).find(([, entry]) => entry.analysedTabId === analysedTabId);
    if (item === undefined) return { value: null, changed: false };
    const [key, entry] = item;
    delete state.by_interstitial[key];
    return { value: entry, changed: true };
  });
}

async function clearInterruptionForAnalysed(analysedTabId) {
  const entry = await takeInterruptionByAnalysed(analysedTabId);
  if (entry !== null) {
    interruptionTabs.cancelWait(entry.interruptionTabId);
    await chrome.tabs.remove(entry.interruptionTabId).catch(() => {});
  }
}

async function handleInterruptedTabUnavailable(tabId) {
  interruptionTabs.cancelWait(tabId);
  const unavailableWarning = await takeInterruptionByInterstitial(tabId);
  if (unavailableWarning !== null) {
    const active = activeJobs.get(unavailableWarning.analysedTabId);
    if (active?.jobId === unavailableWarning.jobId) activeJobs.delete(unavailableWarning.analysedTabId);
    await chrome.tabs.update(unavailableWarning.analysedTabId, { active: true }).catch(() => {});
    await chrome.tabs.sendMessage(unavailableWarning.analysedTabId, {
      type: "continue_without_analysis",
      jobId: unavailableWarning.jobId,
    }).catch(() => {});
    return;
  }

  const closedAnalysed = await takeInterruptionByAnalysed(tabId);
  if (closedAnalysed !== null) {
    await chrome.tabs.remove(closedAnalysed.interruptionTabId).catch(() => {});
  }
}

function isPendingPhishingUrl(url, pending) {
  const origin = parseOrigin(url);
  return origin !== null && origin.fqdn === pending?.data?.fqdn;
}

function isInterstitialUrl(url) {
  // startsWith (not ===) so this also matches the "?kind=interrupted" variant.
  return typeof url === "string" && url.startsWith(chrome.runtime.getURL(INTERSTITIAL_PAGE));
}

function isInterruptionUrl(url) {
  return url === chrome.runtime.getURL(INTERSTITIAL_PAGE + "?kind=interrupted");
}

function clickfixRequestIdFromInterstitial(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    const expected = new URL(chrome.runtime.getURL(INTERSTITIAL_PAGE));
    if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname) return null;
    if (parsed.searchParams.get("kind") !== "clickfix") return null;
    const requestId = parsed.searchParams.get("request");
    return typeof requestId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(requestId)
      ? requestId
      : null;
  } catch {
    return null;
  }
}

function clickfixSenderContextUrl(sender) {
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id)) return null;
  let opaqueFrame = false;

  // Prefer the sending document itself. Opaque local/sandboxed documents may
  // have no trustworthy hostname; they must not inherit a warn-mode exclusion
  // merely because the top-level tab happens to be excluded.
  for (const candidate of [sender.url, sender.origin]) {
    if (typeof candidate !== "string" || candidate === "") continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
      if (parsed.protocol === "file:") return "file:";
      // A blob URL retains its creator origin even though its own protocol
      // cannot be used directly for hostname exclusions.
      if (parsed.protocol === "blob:" && parsed.origin !== "null") {
        return parsed.origin;
      }
      if (["about:", "data:", "blob:", "filesystem:"].includes(parsed.protocol) ||
          parsed.origin === "null") {
        opaqueFrame = true;
      }
    } catch {
      // Try the next trusted MessageSender field.
    }
  }

  if (opaqueFrame || sender.origin === "null") return CLICKFIX_OPAQUE_SOURCE_URL;

  // MessageSender.url is normally present. A top-level sender may safely use
  // its own tab URL as a compatibility fallback; a child frame may not.
  if ((sender.frameId ?? 0) === 0 && typeof sender.tab.url === "string") {
    try {
      const parsed = new URL(sender.tab.url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
      if (parsed.protocol === "file:") return "file:";
    } catch {
      // Fall through to fail closed.
    }
  }
  return null;
}

function summarizeClickfixDecision(decision) {
  const summary = {
    action: decision.action,
    reasons: Array.isArray(decision.reasons) ? decision.reasons.slice(0, 4) : [],
    normalizedPreview: typeof decision.normalizedText === "string"
      ? decision.normalizedText.slice(0, 1_000)
      : "",
  };
  if (typeof decision.tool === "string") summary.tool = decision.tool.slice(0, 120);
  if (typeof decision.behavior === "string") summary.behavior = decision.behavior.slice(0, 160);
  return summary;
}

async function writeClickfixClipboardText(text) {
  await ensureOffscreenDocument();
  const response = await withTimeout(
    chrome.runtime.sendMessage({
      target: CLICKFIX_CLIPBOARD_TARGET,
      type: "write_text",
      text,
    }),
    CLICKFIX_CLIPBOARD_TIMEOUT_MS,
    new Error("ClickFix clipboard write timed out")
  );
  if (response?.ok !== true) {
    throw new Error(response?.error ?? "Extension clipboard writer rejected the request");
  }
}

async function openClickfixWarning(sender, sourceUrl, text, decision, mode) {
  const sourceTabId = sender.tab.id;
  const sourceFrameId = Number.isInteger(sender.frameId) && sender.frameId >= 0 ? sender.frameId : 0;
  if (typeof sender.documentId !== "string" || sender.documentId === "") return null;
  const warning = await clickfixWarnings.createWarning({
    sourceTabId,
    sourceFrameId,
    sourceDocumentId: sender.documentId,
    sourceUrl,
    mode,
    decision: summarizeClickfixDecision(decision),
    text,
  });
  if (warning === null) return null;
  // A navigation commit may race this in-flight runtime message and complete
  // its cleanup before the new warning record is created. Validate the exact
  // initiating document after creation; a later commit will instead delete
  // the record and make tab binding fail closed.
  if (!(await isClickfixSourceDocumentAlive(warning))) {
    await clickfixWarnings.discardWarning(warning.requestId);
    await scheduleClickfixWarningExpiry();
    return null;
  }
  await scheduleClickfixWarningExpiry();

  let warningTab;
  try {
    warningTab = await chrome.tabs.create({
      url: `${CLICKFIX_INTERSTITIAL_BASE}&request=${encodeURIComponent(warning.requestId)}`,
      active: true,
      openerTabId: sourceTabId,
      ...(Number.isInteger(sender.tab.windowId) ? { windowId: sender.tab.windowId } : {}),
    });
  } catch (error) {
    await clickfixWarnings.discardWarning(warning.requestId);
    await scheduleClickfixWarningExpiry();
    throw error;
  }

  if (!Number.isInteger(warningTab?.id) ||
      await clickfixWarnings.bindWarningTab(warning.requestId, warningTab.id) === null) {
    if (Number.isInteger(warningTab?.id)) await chrome.tabs.remove(warningTab.id).catch(() => {});
    await clickfixWarnings.discardWarning(warning.requestId);
    await scheduleClickfixWarningExpiry();
    throw new Error("Could not bind the ClickFix warning tab");
  }
  await scheduleClickfixWarningExpiry();
  return warning;
}

async function isClickfixSourceDocumentAlive(warning) {
  try {
    const response = await chrome.tabs.sendMessage(
      warning.sourceTabId,
      { type: "clickfix_validate_source_document" },
      { documentId: warning.sourceDocumentId }
    );
    return response?.ok === true;
  } catch {
    return false;
  }
}

function isOffscreenSender(sender) {
  return sender?.id === chrome.runtime.id &&
    sender.tab === undefined &&
    sender.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
}

async function reconcilePhishingNavigation(tabId, url) {
  const interstitialUrl = chrome.runtime.getURL(INTERSTITIAL_PAGE);
  const action = await withPhishingState((state) => {
    const key = phishingTabKey(tabId);
    const pending = state.pending_by_tab[key];
    if (pending === undefined || url === interstitialUrl) return { value: "none", changed: false };
    if (isPendingPhishingUrl(url, pending)) return { value: "redirect", changed: false };

    delete state.pending_by_tab[key];
    return { value: "none", changed: true };
  });

  if (action === "redirect") {
    await chrome.tabs.update(tabId, { url: interstitialUrl });
  }
}

// =============================================================================
// STORAGE DOMAINS — issue #13: the service worker is the sole writer of
// mutable chrome.storage.local records. trusted_list and muted_list share one
// queue because "move to trusted" and drift refresh touch both. Settings and
// analysis_history use key-specific helpers backed by one shared diagnostics
// queue, because appending history depends on developer mode. Every mutation
// and every read participating in a read-modify-write operation goes through
// the matching withX() helper — never a bare get()/set() pair. A read inside
// a queued task always sees the latest committed state, never a stale snapshot
// that a sibling task is racing to overwrite.
// =============================================================================

function removeStoredScreenshot(entry) {
  if (entry === null || typeof entry !== "object" || !("screenshot" in entry)) return entry;
  const sanitized = { ...entry };
  delete sanitized.screenshot;
  return sanitized;
}

// Up to MAX_TRUSTED_VARIANTS_PER_FQDN stored entries may share an fqdn (drift
// history, see refreshTrustedEntry) — variant_id disambiguates which one a UI
// action targets.
function newStorageRevision() {
  return crypto.randomUUID();
}

function touchTrustedEntry(entry) {
  entry.storage_revision = newStorageRevision();
  return entry.storage_revision;
}

const withTrustedMuted = createStorageDomain({
  storageArea: trustedLocalStorage,
  keys: ["trusted_list", "muted_list"],
  load(data) {
    // Issue #12: every read repairs the stored invariants (drop invalid
    // entries, backfill variant ids and storage revisions, collapse duplicate
    // mutes, cap variants per fqdn, resolve trusted/muted overlaps) before any
    // mutator sees the lists. `changed` reports that the repair rewrote
    // something: that migration write must land through this same queue, not
    // as a side effect of a bare read racing an unrelated queued mutation.
    const { trusted_list, muted_list, changed } = repairTrustedMutedLists(data, {
      newId: newStorageRevision,
    });
    return { state: { trusted_list, muted_list }, dirty: changed };
  },
  persist: (state) => ({
    trusted_list: state.trusted_list.map(removeStoredScreenshot),
    muted_list: state.muted_list,
  }),
});

function isValidClickfixDomain(value) {
  if (typeof value !== "string") return false;
  const domain = value.trim().toLowerCase();
  if (domain.length === 0 || domain.length > MAX_CLICKFIX_DOMAIN_LENGTH ||
      !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    return false;
  }
  // A public/private suffix (for example co.uk or github.io) is too broad an
  // exclusion. Requiring a registrable domain still permits that domain and
  // any explicitly named subdomain beneath it.
  return parse(domain, { allowPrivateDomains: true }).domain !== null;
}

function normalizeClickfixDomains(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  const seen = new Set();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const domain = candidate.trim().toLowerCase();
    if (!isValidClickfixDomain(domain) || seen.has(domain)) continue;
    seen.add(domain);
    normalized.push(domain);
    if (normalized.length >= MAX_CLICKFIX_DOMAIN_EXCLUSIONS) break;
  }
  return normalized;
}

// Re-validated and canonicalized on every read. Unknown legacy fields remain
// stored but are not used by the current ClickFix policy.
function normalizeClickfixSettings(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const mode = CLICKFIX_MODES.has(source.mode) ? source.mode : "strict";
  const excluded_domains = normalizeClickfixDomains(source.excluded_domains);
  return { ...source, mode, excluded_domains };
}

function clickfixSettingsNeedRepair(raw, normalized) {
  if (raw === undefined) return false;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return true;
  if (raw.mode !== normalized.mode) return true;
  if (!Array.isArray(raw.excluded_domains) || raw.excluded_domains.length !== normalized.excluded_domains.length) {
    return true;
  }
  return raw.excluded_domains.some((domain, index) => domain !== normalized.excluded_domains[index]);
}

// Device-code endpoints (issue #39). Built-in endpoints ship as code
// (DEFAULT_DEVICE_FLOW_REGISTRY) and are read-only; only user-added
// endpoints are stored. Re-validated and de-duplicated on every read.
function deviceFlowEndpointKey(entry) {
  return `${canonicalizeDeviceFlowHostname(entry.hostname)}${canonicalizeDeviceFlowPath(entry.path)}`;
}

function normalizeDeviceFlowUserEndpoints(raw) {
  if (!Array.isArray(raw)) return [];
  const normalized = [];
  const seen = new Set(DEFAULT_DEVICE_FLOW_REGISTRY.map(deviceFlowEndpointKey));
  for (const candidate of raw) {
    if (candidate === null || typeof candidate !== "object" ||
        typeof candidate.id !== "string" || candidate.id.length === 0) continue;
    const endpoint = normalizeDeviceFlowEndpointParts(candidate.hostname, candidate.path);
    if (endpoint === null) continue;
    const entry = { id: candidate.id, ...endpoint };
    const key = deviceFlowEndpointKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(entry);
    if (normalized.length >= MAX_DEVICE_FLOW_ENTRIES) break;
  }
  return normalized;
}

function deviceFlowEndpointsNeedRepair(rawSettings, normalized) {
  const raw = rawSettings?.device_flow_user_endpoints;
  if (raw === undefined) return normalized.length !== 0;
  if (!Array.isArray(raw) || raw.length !== normalized.length) return true;
  return raw.some((entry, index) =>
    entry?.id !== normalized[index].id ||
    entry?.hostname !== normalized[index].hostname ||
    entry?.path !== normalized[index].path
  );
}

// A user endpoint may not duplicate a built-in or another user endpoint.
function deviceFlowEndpointTaken(parsed, userEndpoints, excludeId = null) {
  const key = deviceFlowEndpointKey(parsed);
  return DEFAULT_DEVICE_FLOW_REGISTRY.some((entry) => deviceFlowEndpointKey(entry) === key) ||
    userEndpoints.some((entry) => entry.id !== excludeId && deviceFlowEndpointKey(entry) === key);
}

function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const developer_mode = source.developer_mode === true;
  // Not derived from developer_mode: "allowed" persists across a reload and is
  // cleared only by an explicit action — blocking it again, turning Advanced
  // Settings off (issue #82), or resetting to defaults.
  const device_code_auth = source.device_code_auth === "allowed" ? "allowed" : "blocked";
  const clickfix = normalizeClickfixSettings(source.clickfix);
  const device_flow_user_endpoints = normalizeDeviceFlowUserEndpoints(source.device_flow_user_endpoints);
  const banner_font_size = BANNER_FONT_SIZES.has(source.banner_font_size) ? source.banner_font_size : "small";
  return { ...source, developer_mode, device_code_auth, clickfix, device_flow_user_endpoints, banner_font_size };
}

// Shared by the settings and diagnostics domains: whether a raw settings read
// carries a current setting that normalization had to repair, which must then
// be persisted through the owning queue. Unknown legacy fields are retained.
function settingsNeedRepair(raw, normalized) {
  return normalized.developer_mode !== (raw?.developer_mode === true) ||
    clickfixSettingsNeedRepair(raw?.clickfix, normalized.clickfix) ||
    deviceFlowEndpointsNeedRepair(raw, normalized.device_flow_user_endpoints);
}

// Settings and diagnostic history share one queue because the decision to
// append a diagnostic record depends on the current developer-mode setting.
const diagnosticsStorageQueue = new DomainQueue();

const withSettings = createStorageDomain({
  storageArea: trustedLocalStorage,
  queue: diagnosticsStorageQueue,
  keys: ["settings"],
  load(data) {
    const settings = normalizeSettings(data.settings);
    return {
      state: settings,
      dirty: settingsNeedRepair(data.settings, settings),
    };
  },
  persist: (settings) => ({ settings }),
});

const withAnalysisHistoryState = createStorageDomain({
  storageArea: trustedLocalStorage,
  queue: diagnosticsStorageQueue,
  keys: [ANALYSIS_HISTORY_KEY],
  load(data) {
    return {
      state: { history: Array.isArray(data[ANALYSIS_HISTORY_KEY]) ? data[ANALYSIS_HISTORY_KEY] : [] },
      dirty: false,
    };
  },
  persist: (state) => ({ [ANALYSIS_HISTORY_KEY]: state.history }),
});

const withDiagnosticsState = createStorageDomain({
  storageArea: trustedLocalStorage,
  queue: diagnosticsStorageQueue,
  keys: ["settings", ANALYSIS_HISTORY_KEY],
  load(data) {
    const settings = normalizeSettings(data.settings);
    return {
      state: {
        settings,
        history: Array.isArray(data[ANALYSIS_HISTORY_KEY]) ? data[ANALYSIS_HISTORY_KEY] : [],
      },
      dirty: settingsNeedRepair(data.settings, settings),
    };
  },
  persist: (state) => ({
    settings: state.settings,
    [ANALYSIS_HISTORY_KEY]: state.history,
  }),
});

async function getStorage() {
  const { trusted_list, muted_list } = await withTrustedMuted((state) => ({ value: state, changed: false }));
  const settings = await withSettings((state) => ({ value: state, changed: false }));
  return { trusted_list, muted_list, settings };
}

void getStorage().catch((error) => {
  console.error("[YodelPhish] Failed to run startup storage repair:", error);
});

// A muted fqdn is always unique, but a trusted fqdn may have up to
// MAX_TRUSTED_VARIANTS_PER_FQDN stored variants (see the storage invariants in
// storageQueues.mjs) — variantId disambiguates which one to touch.
function findListEntry(list, fqdn, listType, variantId) {
  return list.find((entry) => entry.fqdn === fqdn && (listType !== "trusted" || entry.variant_id === variantId)) ?? null;
}

function isSettingsSender(sender) {
  const senderUrl = sender?.url ?? sender?.tab?.url;
  return sender?.id === chrome.runtime.id && senderUrl === SETTINGS_PAGE_URL;
}

function isPopupSender(sender) {
  return sender?.id === chrome.runtime.id && sender?.url === POPUP_PAGE_URL;
}

function isValidListType(value) {
  return value === "trusted" || value === "muted";
}

function isValidFqdnTarget(value) {
  return typeof value === "string" && normalizeFqdn(value) === value;
}

function isValidVariantId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function normalizeUserWordInput(value) {
  if (typeof value !== "string") return null;
  const word = value.trim();
  return word.length > 0 && word.length <= MAX_USER_WORD_LENGTH ? word : null;
}

function invalidSettingsRequest(code = "invalid_request") {
  return { ok: false, code };
}

// Reverts exactly the entry identified by `commit` (fqdn + variant_id + a
// collision-proof storage revision), and only if nothing else has touched it
// since. Every trusted-entry mutation rotates this revision. If a newer
// commit already changed or removed it, that identity/version match fails
// and this is a deliberate no-op -- restoring `before` (or deleting the
// entry) at that point would silently erase the newer, unrelated change.
// This replaces the old "clone the whole list, write it all back on
// failure" rollback pattern that issue #13 flagged as unsafe.
async function compensateTrustedCommit(commit) {
  if (commit === null || commit === undefined) return;
  await withTrustedMuted((state) => {
    const outcome = compensateTrustedMutedCommit(state.trusted_list, state.muted_list, commit);
    state.trusted_list = outcome.trustedEntries;
    state.muted_list = outcome.mutedEntries;
    return { value: undefined, changed: outcome.changed };
  });
}

function findByFqdn(list, fqdn) {
  return list.find((entry) => entry.fqdn === fqdn) ?? null;
}

function findAllByFqdn(list, fqdn) {
  return list.filter((entry) => entry.fqdn === fqdn);
}

function findByVariant(list, fqdn, variantId) {
  if (typeof variantId !== "string" || variantId.length === 0) return findByFqdn(list, fqdn);
  return list.find((entry) => entry.fqdn === fqdn && entry.variant_id === variantId) ?? null;
}

function todayString() {
  const date = new Date();
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}${mm}${date.getFullYear()}`;
}

function appendScore(existingScores = [], newScore) {
  return [
    ...existingScores,
    { datetime: new Date().toISOString(), ...newScore },
  ].slice(-MAX_STORED_SCORES);
}

async function checkOrigin(url, { allowFile = false } = {}) {
  const webOrigin = parseOrigin(url);
  const fileOrigin = webOrigin === null && allowFile ? await parseFileOrigin(url) : null;
  const origin = webOrigin ?? fileOrigin;
  if (origin === null) return { valid: false };

  const { trusted_list, muted_list } = await getStorage();
  const trustedEntry = findByFqdn(trusted_list, origin.fqdn);
  const mutedEntry = findByFqdn(muted_list, origin.fqdn);
  const protocolMatches = trustedEntry === null || trustedEntry.protocol === origin.protocol;

  return {
    valid: true,
    ...origin,
    in_trusted_list: trustedEntry !== null,
    in_muted_list: mutedEntry !== null,
    protocol_matches: protocolMatches,
    origin_mismatch: fileOrigin !== null || trustedEntry === null || !protocolMatches || origin.protocol !== "https",
    trusted_entry: trustedEntry,
    muted_entry: mutedEntry,
  };
}

async function ensureOffscreenDocument() {
  if (recyclingOffscreenDocument !== null) await recyclingOffscreenDocument;
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });
  if (contexts.length === 0 && creatingOffscreenDocument === undefined) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT,
      reasons: ["WORKERS", "CLIPBOARD"],
      justification: "Run local phishing detection and perform extension-mediated clipboard writes.",
    }).finally(() => {
      creatingOffscreenDocument = undefined;
    });
  }
  if (creatingOffscreenDocument !== undefined) await creatingOffscreenDocument;
}

// Readiness gate, hoisted out of any single request's timeout: waits for the
// document to exist AND for its runtime bundle to answer "ping", bounded by
// OFFSCREEN_STARTUP_TIMEOUT_MS as one whole, including complete service
// initialization. The request executor has its own bound, while the job-level
// deadline remains authoritative across startup and every inference request.
// Memoized so concurrent callers share one
// in-flight wait; a failure clears the memo so the next caller retries from
// scratch rather than reusing a known-bad gate.
async function ensureOffscreenRuntimeReady() {
  if (offscreenReadyPromise === null) {
    offscreenReadyPromise = (async () => {
      await ensureOffscreenDocument();
      await waitForOffscreenRuntime();
    })().catch(async (error) => {
      offscreenReadyPromise = null;
      await recycleOffscreenDocument("startup_failed").catch(() => {});
      throw error;
    });
  }
  return offscreenReadyPromise;
}

class AnalysisExecutionError extends Error {
  constructor(code, internalMessage) {
    super(internalMessage ?? code);
    this.name = "AnalysisExecutionError";
    this.code = code;
  }
}

function withTimeout(promise, timeoutMs, timeoutError) {
  promise.catch(() => {});
  let timeoutHandle;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutHandle));
}

function pingOffscreenOnce() {
  return withTimeout(
    chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, type: "ping" }),
    OFFSCREEN_PING_ATTEMPT_TIMEOUT_MS,
    new AnalysisExecutionError("runtime_startup_timeout", "Offscreen readiness ping timed out")
  );
}

async function waitForOffscreenRuntime() {
  const deadline = Date.now() + OFFSCREEN_STARTUP_TIMEOUT_MS;
  let failureReason = null;
  const onFailure = (reason) => {
    failureReason = reason;
  };
  offscreenFailureListeners.add(onFailure);
  try {
    while (Date.now() < deadline) {
      if (failureReason !== null) break;
      try {
        const response = await pingOffscreenOnce();
        if (response?.ok === true) return;
        if (response?.ok === false) {
          failureReason = response.error ?? "service initialization failed";
          break;
        }
      } catch {
        // Still loading, or this individual ping attempt timed out.
      }
      if (failureReason !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    offscreenFailureListeners.delete(onFailure);
  }
  throw new AnalysisExecutionError(
    "runtime_startup_timeout",
    failureReason !== null
      ? "Offscreen detection runtime failed to start: " + failureReason
      : "Offscreen detection runtime did not become ready in time"
  );
}

function announceOffscreenFailure(reason) {
  offscreenReadyPromise = null;
  for (const listener of offscreenFailureListeners) listener(reason);
}

async function recycleOffscreenDocument(reason) {
  if (recyclingOffscreenDocument === null) {
    recyclingOffscreenDocument = (async () => {
      console.warn("[YodelPhish] Recycling offscreen runtime:", reason);
      offscreenReadyPromise = null;
      creatingOffscreenDocument = undefined;
      try {
        await chrome.offscreen.closeDocument();
      } catch {
        // No document existed, or it was already closing.
      }
    })().finally(() => {
      recyclingOffscreenDocument = null;
    });
  }
  return recyclingOffscreenDocument;
}

async function getExistingOffscreenContext() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });
  return contexts.length > 0;
}

async function cancelOffscreenWork(tabId, ticketId, reason) {
  if (!(await getExistingOffscreenContext())) return { queued: false, running: false };
  const response = await withTimeout(
    chrome.runtime.sendMessage({
      target: OFFSCREEN_TARGET,
      type: "cancel_tab",
      tabId,
      ticketId,
      reason,
    }),
    OFFSCREEN_PING_ATTEMPT_TIMEOUT_MS,
    new AnalysisExecutionError("offscreen_control_timeout", "Offscreen cancellation timed out")
  );
  return response?.ok === true
    ? response.result
    : { queued: false, running: false };
}

async function sendToOffscreen(type, payload, tabId, ticketId = crypto.randomUUID()) {
  await ensureOffscreenRuntimeReady();
  let response;
  try {
    response = await withTimeout(
      chrome.runtime.sendMessage({
        target: OFFSCREEN_TARGET,
        type,
        tabId,
        ticketId,
        ...payload,
      }),
      OFFSCREEN_ROUND_TRIP_TIMEOUT_MS,
      new AnalysisExecutionError("offscreen_round_trip_timeout", "Offscreen " + type + " round trip timed out")
    );
  } catch (error) {
    offscreenReadyPromise = null;
    await recycleOffscreenDocument("transport_failed").catch(() => {});
    if (error instanceof AnalysisExecutionError) throw error;
    throw new AnalysisExecutionError(
      "offscreen_request_failed",
      error instanceof Error ? error.message : String(error)
    );
  }
  if (response?.ok !== true) {
    const error = new AnalysisExecutionError(
      response?.code ?? "offscreen_request_failed",
      response?.error ?? "Offscreen " + type + " request failed"
    );
    // offscreen_request_failed means the runtime itself threw (e.g. a native
    // WASM exception), not a scheduler rejection: the OpenCV/OCR/ONNX state may
    // be poisoned, so replace the document instead of reusing it (issue #74).
    if (error.code === "request_timeout" || error.code === "offscreen_request_failed") {
      await recycleOffscreenDocument(error.code).catch(() => {});
    }
    throw error;
  }
  return response.result;
}

async function capturePageAnalysis(tabId, job, { coordinateBanner = true } = {}) {
  try {
    if (coordinateBanner) {
      const prepared = await sendJobDocumentMessage(tabId, job, { type: "prepare_capture" });
      if (prepared?.ok !== true) {
        throw new Error(prepared?.error ?? prepared?.reason ?? "Page could not be prepared for capture");
      }
    }
    job.phase = "capturing";
    const uiCoverCaptureBefore = await collectUiCoveredBoxes(tabId);
    const screenshot = await screenshotSource.captureVisibleTab(tabId);
    const uiCoverCaptureAfter = await collectUiCoveredBoxes(tabId);
    let uiCoveredBoxes = [];
    if (uiCoverCapturesMatch(uiCoverCaptureBefore, uiCoverCaptureAfter)) {
      uiCoveredBoxes = await toScreenshotSpaceUiBoxes(screenshot, uiCoverCaptureAfter);
    } else {
      console.warn("[YodelPhish] Page geometry changed during screenshot capture; dropping UI cover boxes");
    }
    return { screenshot, uiCoveredBoxes };
  } finally {
    if (coordinateBanner) {
      await sendJobDocumentMessage(tabId, job, { type: "capture_complete" });
    }
  }
}

// UI rectangles are collected in CSS viewport pixels, while OCR word boxes are
// measured in decoded-screenshot pixels. The two only line up once the
// rectangles are scaled by the real bitmap size, which absorbs browser zoom,
// device pixel ratio and display scaling in one step.
async function toScreenshotSpaceUiBoxes(screenshot, uiCoverCapture) {
  if (uiCoverCapture.boxes.length === 0) return [];
  const dimensions = await screenshotDimensions(screenshot);
  if (dimensions === null) {
    console.warn("[YodelPhish] Screenshot dimensions unavailable; dropping UI cover boxes");
    return [];
  }
  return convertUiCoverBoxesToImageSpace(uiCoverCapture, dimensions.width, dimensions.height);
}

async function screenshotDimensions(screenshot) {
  const fromHeader = readPngDimensionsFromDataUrl(screenshot?.dataUrl);
  if (fromHeader !== null) return fromHeader;

  // captureVisibleTab is asked for PNG, so the header path is the normal one;
  // decoding is the fallback for anything the header reader does not recognize.
  let bitmap;
  try {
    bitmap = await createImageBitmap(await (await fetch(screenshot.dataUrl)).blob());
  } catch {
    return null;
  }
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

async function sendDocumentMessage(tabId, documentId, message) {
  if (tabId === undefined || typeof documentId !== "string" || documentId === "") return undefined;
  try {
    return await chrome.tabs.sendMessage(tabId, message, { documentId });
  } catch {
    return undefined;
  }
}

async function sendJobDocumentMessage(tabId, job, message) {
  if (tabId === undefined || typeof job?.jobId !== "string") return undefined;
  const scopedMessage = { ...message, jobId: job.jobId };
  if (typeof job.documentId === "string" && job.documentId !== "") {
    return sendDocumentMessage(tabId, job.documentId, scopedMessage);
  }
  try {
    return await chrome.tabs.sendMessage(tabId, scopedMessage);
  } catch {
    return undefined;
  }
}

// Issue #88: the analysis lifecycle belongs to the top document alone. Every
// message that could start, feed or terminate a job is required to come from
// frame 0; a child frame has exactly one thing it may say, and says it through
// child_frame_login_detected.
function isTopFrameSender(sender) {
  return sender?.id === chrome.runtime.id && sender.frameId === 0;
}

async function resolveTopFrame(tabId, documentId = undefined) {
  const details = { tabId, frameId: 0 };
  if (typeof documentId === "string" && documentId !== "") {
    details.documentId = documentId;
  }
  try {
    return await chrome.webNavigation.getFrame(details);
  } catch {
    return null;
  }
}

// Fail closed when a capture-derived trusted reference is about to be written:
// URL equality cannot distinguish a reload or another same-address document.
async function isInitiatingDocumentCurrent(tabId, documentId) {
  if (typeof documentId !== "string" || documentId.length === 0) return false;
  const frame = await resolveTopFrame(tabId);
  return frame?.documentId === documentId;
}

// Issue #18: the single authoritative way a message handler binds a new job to
// a tab. It rejects a sender with no document identity, resolves the live top
// frame from that document id, and returns its own URL and document id only
// when the frame is still the sender's active top document. Both run_pipeline
// and add_to_trusted use it so neither can anchor a job to a stale
// MessageSender snapshot. Returns { ok: true, url, documentId } or
// { ok: false, reason }.
async function resolveAuthoritativeTopFrame(tabId, sender) {
  const senderDocumentId = sender?.documentId;
  if (typeof senderDocumentId !== "string" || senderDocumentId === "") {
    return { ok: false, reason: CANCELLATION_REASONS.STALE_SENDER_DOCUMENT };
  }
  const frame = await resolveTopFrame(tabId, senderDocumentId);
  return classifyTopFrameForJob(sender, frame);
}

async function loadTrustedEntries() {
  return trustedSource.getTrustedEntries();
}

async function detectCaptured(captured, tabId, ticketId) {
  const trustedEntries = await loadTrustedEntries();
  if (trustedEntries.length === 0) {
    return {
      screenshot: captured.screenshot,
      pipeline_result: null,
      global_score: 0,
      dinov2_logo_similarity: 0,
      logo_region_score: 0,
      logo_region_assigned_score: 0,
      ocr_score: 0,
      best_match_fqdn: "",
      best_match_variant_id: "",
      best_match_reference_id: "",
      verdict: "unknown",
    };
  }

  const includeDiagnostics = await withSettings((settings) => ({
    value: settings.developer_mode === true,
    changed: false,
  }));
  const pipelineResult = await sendToOffscreen("detect", {
    screenshot: captured.screenshot,
    trustedEntries,
    uiCoveredBoxes: captured.uiCoveredBoxes,
    includeDiagnostics,
  }, tabId, ticketId);
  const winner = pipelineResult.winner;
  return {
    screenshot: captured.screenshot,
    pipeline_result: pipelineResult,
    global_score: winner.globalScore,
    dinov2_logo_similarity: winner.dinoV2LogoSimilarity,
    logo_region_score: winner.logo.logoRegionScore,
    logo_region_assigned_score: winner.logo.logoRegionAssignedScore,
    ocr_score: Math.max(winner.ocr.normalizedScore, winner.ocr.fuzzyScore, winner.logo.ocrScore),
    best_match_fqdn: winner.matchedFqdn,
    best_match_variant_id: winner.matchedVariantId ?? "",
    best_match_reference_id: winner.matchedReferenceId ?? "",
    verdict: winner.verdict,
  };
}

// Runs a capture+detect cycle for a tracked job. DOM churn deliberately does
// not invalidate analysis; URL and initiating-document checks guard the final
// commit instead.
async function runJobDetection(tabId, job) {
  const captured = await capturePageAnalysis(tabId, job);
  if (isJobStale(tabId, job)) return null;
  job.phase = "analysing";
  const result = await detectCaptured(captured, tabId, job.jobId);
  return isJobStale(tabId, job) ? null : result;
}

async function preprocessTrustedReference(screenshot, tabId, ticketId) {
  return sendToOffscreen("preprocess_trusted", { screenshot }, tabId, ticketId);
}

// Issue #90: YOLO's proposals for the add-to-trusted selector — viewport-ratio
// rectangles the user confirms, edits or replaces before anything is encoded.
async function proposeTrustedAddCandidates(screenshot, tabId, ticketId) {
  return sendToOffscreen("propose_trusted_add_candidates", { screenshot }, tabId, ticketId);
}

function scoreSnapshot(result) {
  return {
    dinov2_logo_similarity: result.dinov2_logo_similarity,
    logo_region_score: result.logo_region_score,
    logo_region_assigned_score: result.logo_region_assigned_score,
    ocr_score: result.ocr_score,
    global_score: result.global_score,
  };
}

async function appendAnalysisHistory(record) {
  // storage.local is shared between regular and split-incognito processes.
  // Never persist browsing diagnostics from the incognito worker: a record no
  // longer carries the address in full, but a hostname and a verdict are still
  // a record that the page was visited.
  if (chrome.extension.inIncognitoContext === true) return;

  await withDiagnosticsState((state) => {
    if (state.settings.developer_mode !== true) {
      return { value: false, changed: false };
    }
    state.history = [...state.history, record].slice(-MAX_ANALYSIS_HISTORY);
    return { value: true, changed: true };
  });
}

function isDeveloperModeEnabled() {
  return withSettings((settings) => ({
    value: settings.developer_mode === true,
    changed: false,
  }));
}

async function recordCompletedAnalysis(input) {
  try {
    if (!(await isDeveloperModeEnabled())) return;
    await appendAnalysisHistory(await buildAnalysisRecord(input));
  } catch (error) {
    console.warn("[YodelPhish] Could not store analysis diagnostics:", error);
  }
}

async function recordAnalysisError(input) {
  try {
    await appendAnalysisHistory(buildAnalysisErrorRecord(input));
  } catch (error) {
    console.warn("[YodelPhish] Could not store analysis error diagnostics:", error);
  }
}

async function buildAnalysisRecord({
  origin,
  result,
  displayedVerdict,
  context = "detection",
  preprocessing = null,
  logoSearchMs = undefined,
}) {
  const pipeline = result.pipeline_result;
  const { trusted_list } = await getStorage();
  const matchedReference = findByVariant(
    trusted_list,
    result.best_match_fqdn,
    result.best_match_variant_id
  );
  return {
    schema_version: ANALYSIS_HISTORY_SCHEMA,
    datetime: new Date().toISOString(),
    extension_version: chrome.runtime.getManifest().version,
    origin: compactOrigin(origin),
    status: "completed",
    context,
    displayed_verdict: displayedVerdict,
    pipeline_verdict: result.verdict,
    global_score: result.global_score,
    matched_fqdn: result.best_match_fqdn,
    matched_variant_id: result.best_match_variant_id,
    reference: await compactReference(matchedReference),
    // Only the winner keeps its full diagnostics: the candidate list exists to
    // answer "why did this reference win over that one", which the comparison
    // table's summary columns already carry. Storing every candidate's logo
    // metrics and OCR internals made the record grow with the trusted list for
    // no diagnostic gain. `perTrusted` is score-sorted with the winner first,
    // so omit that first row instead of storing the winner twice.
    winner: pipeline === null ? null : compactWinner(pipeline.winner),
    candidates: pipeline?.perTrusted?.slice(1).map((candidate) => compactCandidate(candidate)) ?? [],
    timings_ms: pipeline?.timings ?? null,
    // Which proposal path the query took (yolo vs cv-fallback vs merged) and
    // whether full-page OCR ran — the two facts that explain a slow analysis
    // or an unexpected compared-logo crop without forensics on the timings.
    query_stats: pipeline?.queryStats ?? null,
    preprocessing,
    // Issue #14: how long the automatic logo search behind "Add to trusted"
    // took, measured from the click. Present only on that flow's records, and
    // the sample TRUSTED_ADD_LOGO_SEARCH_TIMEOUT_MS is meant to be retuned
    // against.
    ...(logoSearchMs === undefined ? {} : { logo_search_ms: logoSearchMs }),
    compared_logo_image: pipeline?.winnerLogoImage ?? null,
  };
}

// A failed analysis never produced verdicts, scores or candidates, so the
// record carries none of those fields. What it can carry is why it failed:
// the job kind it failed in and the stable failure code the content script was
// told about (see failureCodeFor).
function buildAnalysisErrorRecord({ origin, error, context, failureCode }) {
  return {
    schema_version: ANALYSIS_HISTORY_SCHEMA,
    datetime: new Date().toISOString(),
    extension_version: chrome.runtime.getManifest().version,
    origin: compactOrigin(origin),
    status: "error",
    context: context ?? "detection",
    failure_code: failureCode ?? "analysis_failed",
    error: error instanceof Error ? error.message : String(error),
  };
}

// The hostname is the only address a diagnostic record keeps. A full URL can
// carry session tokens, password-reset codes, single-use login links or
// personal data in its path, query or fragment, and none of that helps explain
// a verdict — the pipeline never sees anything but the rendered page. A scanned
// local file is already reduced to a `file-<digest>.local` pseudo-host by
// parseFileOrigin, whose sourceUrl is deliberately not copied here.
function compactOrigin(origin) {
  if (origin?.valid !== true) return { valid: false };
  return {
    valid: true,
    fqdn: origin.fqdn,
    protocol: origin.protocol,
    in_trusted_list: origin.in_trusted_list,
    origin_mismatch: origin.origin_mismatch,
  };
}

// The hostname of the address a job was started for, for the records written
// when a job dies before checkOrigin ever ran (a capture failure, an offscreen
// startup timeout, the whole-job deadline). parseOrigin keeps the hostname and
// protocol and drops everything else about the URL; a local file that never
// reached checkOrigin stays unattributed rather than being re-derived here.
function webOriginOf(url) {
  const parsed = parseOrigin(url);
  return parsed === null ? { valid: false } : { valid: true, ...parsed };
}

async function compactReference(entry) {
  if (entry === null) return null;
  return {
    fqdn: entry.fqdn,
    variant_id: entry.variant_id ?? "",
    logo_source: entry.logo_source ?? "automatic",
    // Not shown in the menu — kept for exports, where it is the only way to
    // tell whether a historical result was scored against today's logo.
    logo_fingerprint: await sha256Text(entry.logo_image ?? ""),
    logo_regions: (entry.logo_regions ?? []).map(compactRegion),
    ocr_domain: entry.ocr_domain ?? "",
    ocr_words: entry.ocr_words ?? [],
    user_words: entry.user_words ?? [],
  };
}

function compactRegion(region) {
  return {
    rank: region.rank,
    source: region.source,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    dominantHueBin: region.dominantHueBin,
    dominantHueFraction: region.dominantHueFraction,
  };
}

// The full diagnostics of the reference that won — everything the expanded
// history card explains the verdict with. Deliberately without the full-page
// OCR transcription: the matched, fuzzy and rejected token lists below say why
// the OCR score is what it is, and a verbatim copy of the page's text is both
// the largest and the most sensitive thing this record could hold.
function compactWinner(winner) {
  const logo = winner.logo ?? {};
  const ocr = winner.ocr ?? {};
  const scoreBeforeLimit = round4(
    (logo.logoRegionAssignedScore ?? 0) +
    (winner.ocrAssignedScore ?? 0) +
    (winner.ocrVisibleExactMatchBonus ?? 0)
  );
  return {
    fqdn: winner.matchedFqdn ?? "",
    variant_id: winner.matchedVariantId ?? "",
    reference_id: winner.matchedReferenceId ?? "",
    verdict: winner.verdict,
    global_score: winner.globalScore,
    score_composition: {
      logo_assigned_score: logo.logoRegionAssignedScore,
      ocr_assigned_score: winner.ocrAssignedScore,
      visible_exact_match_bonus: winner.ocrVisibleExactMatchBonus,
      effective_logo_score: winner.effectiveLogoScore,
      effective_ocr_score: winner.effectiveOcrScore,
      global_score_before_limit: scoreBeforeLimit,
      global_score_was_limited: Math.abs(scoreBeforeLimit - (winner.globalScore ?? 0)) > 0.00005,
    },
    dinov2_logo_similarity: winner.dinoV2LogoSimilarity,
    logo: {
      score: logo.logoRegionScore,
      pre_ocr_score: logo.preOcrScore,
      shape_score: logo.shapeScore,
      color_score: logo.colorScore,
      texture_score: logo.textureScore,
      layout_score: logo.layoutScore,
      crop_ocr_score: logo.ocrScore,
      geometry_score: logo.geometryScore,
      score_was_capped: logo.scoreWasCapped,
      color_conflict: logo.colorConflict,
      color_histogram_similarity: logo.colorHistogramSimilarity,
      query_dominant_hue_bin: logo.queryDominantHueBin,
      query_dominant_hue_fraction: logo.queryDominantHueFraction,
      trusted_dominant_hue_bin: logo.trustedDominantHueBin,
      trusted_dominant_hue_fraction: logo.trustedDominantHueFraction,
      rejected_pairs_without_evidence: logo.rejectedPairsWithoutEvidence,
      pair: logo.pair,
      query_box: logo.queryBox,
      trusted_box: logo.trustedBox,
      partial_box: logo.partialBox,
      query_count: logo.queryCount,
      trusted_count: logo.trustedCount,
      query_ocr_text: logo.queryOcrText,
      trusted_ocr_text: logo.trustedOcrText,
      ocr_matched_tokens: logo.ocrMatchedTokens,
      query_ocr_diagnostics: logo.queryOcrDiagnostics ?? null,
      trusted_ocr_diagnostics: logo.trustedOcrDiagnostics ?? null,
      reason: logo.reason,
    },
    ocr: {
      normalized_score: ocr.normalizedScore,
      fuzzy_score: ocr.fuzzyScore,
      matched_tokens: ocr.matchedTokens,
      matched_tokens_with_size: ocr.matchedTokensWithSize,
      fuzzy_matched_tokens: ocr.fuzzyMatchedTokens,
      fuzzy_matched_tokens_with_size: ocr.fuzzyMatchedTokensWithSize,
      rejected_small_bottom_tokens: ocr.rejectedSmallBottomTokens,
      rejected_ui_tokens: ocr.rejectedUiTokens,
      visible_exact_match: ocr.visibleExactMatch,
    },
  };
}

// One row of the candidate comparison table, and nothing more. The nesting
// mirrors compactWinner so both render through the same table reader.
function compactCandidate(candidate) {
  const logo = candidate.logo ?? {};
  return {
    fqdn: candidate.fqdn ?? "",
    variant_id: candidate.variantId ?? "",
    global_score: candidate.globalScore,
    score_composition: {
      logo_assigned_score: logo.logoRegionAssignedScore,
      ocr_assigned_score: candidate.ocrAssignedScore,
      effective_ocr_score: candidate.effectiveOcrScore,
    },
    dinov2_logo_similarity: candidate.dinoV2LogoSimilarity,
    logo: {
      score: logo.logoRegionScore,
      score_was_capped: logo.scoreWasCapped,
      color_conflict: logo.colorConflict,
    },
  };
}

async function sha256Text(value) {
  if (value.length === 0) return "";
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function computeVerdict(result, origin) {
  if (result.verdict === "phishing" && origin.origin_mismatch) return "phishing";
  if (result.verdict === "phishing") return "suspicious";
  return result.verdict;
}

// =============================================================================
// ANALYSIS JOB LIFECYCLE — issue #4 bounds page-change tracking & interrupts
// stale analyses. Each run_pipeline invocation gets a job record keyed by
// tabId. A significant page change during or after capture marks the job
// cancelled immediately; a non-resetting 200ms timer (separate from the
// content script's own 200ms UI-evaluation timer) then opens exactly one
// dedicated interruption tab.
//
// Issue #9 adds the remaining bounds: every accepted job is guaranteed to
// reach exactly one terminal state (succeeded/failed/cancelled/superseded —
// see Requirements/extension.md), via a whole-job deadline
// (JOB_TOTAL_TIMEOUT_MS, armed in startJob and disarmed by whichever of
// finishJob/markJobTerminalIfCurrent fires first) and a dedicated failJob
// path (hard errors, any timeout) that is deliberately distinct from
// cancelJob (page-change interruption): a failure needs a plain retryable
// banner in place, not the re-analyse/continue/leave interstitial. Physical
// in-flight inference is isolated in a dedicated Worker. Cancelling its exact
// ticket terminates that Worker, while job/document guards still prevent any
// stale result from reaching UI or storage.
// =============================================================================

const REASON_MESSAGES = {
  // Retained for analysis-history records written before issue #18 split it into
  // the specific reasons below.
  address_changed: "The page address changed.",
  url_changed: "The page address changed.",
  history_state_changed: "The page updated its address without reloading.",
  reference_fragment_changed: "The page updated its address fragment.",
  document_replaced: "The page was reloaded or replaced by a new document.",
  stale_sender_document: "The page's document changed before analysis could start.",
  document_inactive: "The page is no longer active.",
  credential_fields_changed: "Credential fields were added, removed, or displayed.",
  visual_changed: "Security-relevant visual content changed.",
  unclassified: "The page changed in a way that could not be safely classified.",
};

function describeReason(reasonHint) {
  return REASON_MESSAGES[reasonHint] ?? REASON_MESSAGES.unclassified;
}

function isJobTerminal(job) {
  return job.terminalState !== null;
}

function failureCodeFor(errorOrCode) {
  const rawCode = typeof errorOrCode === "string" ? errorOrCode : errorOrCode?.code;
  const allowed = new Set([
    "queue_overloaded",
    "queue_wait_timeout",
    "request_timeout",
    "runtime_startup_timeout",
    "offscreen_round_trip_timeout",
    "offscreen_control_timeout",
    "job_timeout",
    "client_timeout",
    "dispatch_failed",
  ]);
  return allowed.has(rawCode) ? rawCode : "analysis_failed";
}

function startJob(tabId, jobId, url, kind = "detection", documentId = null) {
  const previous = activeJobs.get(tabId);
  if (previous !== undefined && !isJobTerminal(previous)) {
    previous.phase = "superseded";
    previous.terminalState = "superseded";
    previous.reasonHint = "superseded";
    clearJobTimeout(previous);
    cancelOffscreenWork(tabId, previous.jobId, "superseded").catch(() => {});
  }
  const job = {
    jobId: typeof jobId === "string" && jobId.length > 0 ? jobId : crypto.randomUUID(),
    url,
    kind,
    // The initiating document is the stable boundary for every job. DOM
    // mutations inside it are ignored, while a reload or replacement document
    // can never receive the old document's verdict or trusted-reference write.
    documentId: typeof documentId === "string" && documentId.length > 0 ? documentId : null,
    phase: "preparing",
    terminalState: null,
    reasonHint: null,
    origin: null,
    // How a cancellation of this job is presented. "decision_required" opens
    // the interruption tab and warns the arriving document; "silent" (set by
    // an ordinary top-level navigation or document replacement) invalidates
    // and cancels without either. Every cancellation-finalization path reads
    // this so a silent job can never schedule an interruption during later
    // cleanup (issue #2).
    interruptionMode: "decision_required",
    interruptionPromise: undefined,
    expectedNavigationUrl: undefined,
    // Safe comparison data (source + equality booleans, never a URL) describing
    // the navigation event that cancelled this job, recorded into the analysis
    // history so a false address-change cancel can be told apart from a real one
    // (issue #18).
    navigationDiagnostics: null,
    cancellationRecorded: false,
    failureRecorded: false,
    failureCode: null,
    totalTimeoutHandle: undefined,
    // Issue #14 — the trusted-site flow's UX fallback to manual logo selection.
    // startedAt is when the user clicked, which is where the logo-search
    // deadline is measured from and what logoSearchMs reports against.
    // selectorOpened is the exclusion between the three routes into the
    // selector (automatic completion, "Select logo manually", the deadline):
    // it is set synchronously by whichever gets there first, so one job can
    // never mount two selectors or write two sessions.
    startedAt: Date.now(),
    logoSearchTimeoutHandle: undefined,
    logoSearchMs: undefined,
    selectorOpened: false,
    trustedAdd: null,
  };
  activeJobs.set(tabId, job);
  job.totalTimeoutHandle = setTimeout(() => {
    failJob(tabId, job, "job_timeout", new Error("Analysis exceeded the whole-job deadline"));
  }, JOB_TOTAL_TIMEOUT_MS);
  return job;
}

function isJobStale(tabId, job) {
  if (isJobTerminal(job)) return true;
  if (activeJobs.get(tabId) !== job) return true;
  return false;
}

// Every timer a job owns dies here, and every terminal transition passes
// through here -- completion, failure, cancellation (including the silent
// navigation one), supersession and tab closure -- so no job can leave a timer
// behind to fire against a page that has moved on (issue #14).
function clearJobTimeout(job) {
  if (job.totalTimeoutHandle !== undefined) {
    clearTimeout(job.totalTimeoutHandle);
    job.totalTimeoutHandle = undefined;
  }
  clearLogoSearchDeadline(job);
}

function clearLogoSearchDeadline(job) {
  if (job.logoSearchTimeoutHandle !== undefined) {
    clearTimeout(job.logoSearchTimeoutHandle);
    job.logoSearchTimeoutHandle = undefined;
  }
}

// How long the automatic logo search ran before it stopped, whichever way it
// stopped. Recorded once per job and carried into that job's diagnostics
// record, so the deadline above can later be tuned against real runtimes.
function recordLogoSearchDuration(job) {
  if (job.kind !== "add_to_trusted" || job.logoSearchMs !== undefined) return;
  job.logoSearchMs = Date.now() - job.startedAt;
}

function markJobTerminalIfCurrent(tabId, job, terminalState, reasonHint) {
  if (activeJobs.get(tabId) !== job || isJobTerminal(job)) return false;
  job.phase = terminalState;
  job.terminalState = terminalState;
  job.reasonHint = job.reasonHint ?? reasonHint;
  clearJobTimeout(job);
  return true;
}

function cancelJob(
  tabId,
  job,
  reasonHint = "unclassified",
  { interruptionMode = "decision_required", resetContent = false, reanalyseUrl, diagnostics } = {}
) {
  if (!markJobTerminalIfCurrent(tabId, job, "cancelled", reasonHint)) return false;
  if (diagnostics !== undefined && diagnostics !== null) job.navigationDiagnostics = diagnostics;
  // The first cancellation wins the presentation policy; a later silent
  // navigation cancel cannot demote an interruption already scheduled, and a
  // later decision cannot promote one an ordinary navigation already silenced.
  job.interruptionMode = interruptionMode;
  const presentation = cancellationPresentation(interruptionMode, { resetContent });
  cancelOffscreenWork(tabId, job.jobId, reasonHint).catch((error) => {
    console.warn("[YodelPhish] Could not cancel offscreen work:", error);
  });
  // Silent cancellation still interrupts capture and cancels offscreen work
  // above; it only withholds the arriving document's interrupted banner and
  // the interruption tab. A same-document navigation still needs a non-warning
  // terminal message so the surviving content script releases the old job and
  // lets the new route run normal login detection. Both messages are scoped to
  // the initiating document and job, so neither can disturb the destination's
  // new content script or a newer analysis.
  if (presentation.resetContent) {
    void sendJobDocumentMessage(tabId, job, {
      type: "analysis_cancelled_silently",
      ...(typeof reanalyseUrl === "string" ? { reanalyseUrl } : {}),
    });
  }
  if (presentation.notifyInterrupted) {
    chrome.tabs.sendMessage(tabId, {
      type: "analysis_interrupted",
      jobId: job.jobId,
    }).catch(() => {});
    scheduleInterruption(tabId, job);
  }
  return true;
}

function cancelJobForNavigation(tabId, job, reasonHint, reanalyseUrl, diagnostics) {
  return cancelJob(tabId, job, reasonHint, {
    interruptionMode: "silent",
    resetContent: true,
    reanalyseUrl,
    diagnostics,
  });
}

// Issue #14: the user ended this job, or its logo search ran past the point
// where waiting still beat picking the logo by hand. Terminal and silent in
// both cases -- there is no page change to warn about, so no interruption tab
// and no navigation warning -- and resetContent stays off because the content
// script tore its own UI down before asking (a user cancel) or is about to
// have it replaced by the selector (the logo-search fallback).
function cancelJobForUser(tabId, job, reasonHint) {
  recordLogoSearchDuration(job);
  return cancelJob(tabId, job, reasonHint, { interruptionMode: "silent" });
}

function recordJobFailure(job, error) {
  if (job.failureRecorded) return;
  job.failureRecorded = true;
  recordAnalysisError({
    origin: job.origin ?? webOriginOf(job.url),
    error,
    context: job.kind,
    failureCode: job.failureCode,
  }).catch(() => {});
}

function failJob(tabId, job, errorOrCode, internalError = errorOrCode) {
  if (!markJobTerminalIfCurrent(tabId, job, "failed", "failed")) return false;
  const code = failureCodeFor(errorOrCode);
  job.failureCode = code;
  chrome.tabs.sendMessage(tabId, {
    type: "analysis_failed",
    jobId: job.jobId,
    code,
  }).catch(() => {});
  recordJobFailure(job, internalError);
  cancelOffscreenWork(tabId, job.jobId, code).catch((error) => {
    console.warn("[YodelPhish] Could not stop failed offscreen work:", error);
  });
  return true;
}

async function settleJobException(tabId, job, error) {
  if (job.terminalState === "cancelled") {
    await finalizeCancelledJob(tabId, job);
    return true;
  }
  if (job.terminalState === "superseded" || job.terminalState === "failed") return true;
  failJob(tabId, job, error);
  return false;
}

async function validateJobForCommit(tabId, job) {
  if (isJobStale(tabId, job)) return false;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    cancelJobForNavigation(tabId, job, CANCELLATION_REASONS.URL_CHANGED, undefined, navigationDiagnostics({
      context: job.kind,
      source: "validateJobForCommit.tabGone",
      job,
    }));
    return false;
  }
  if (isJobStale(tabId, job)) return false;
  if (tab.url !== job.url) {
    // The destination is evaluated independently by its own document; a late
    // result from this job must never commit across the navigation (issue #2).
    cancelJobForNavigation(tabId, job, CANCELLATION_REASONS.URL_CHANGED, tab.url, navigationDiagnostics({
      context: job.kind,
      source: "validateJobForCommit.url",
      job,
      url: tab.url,
    }));
    return false;
  }
  if (!(await isInitiatingDocumentCurrent(tabId, job.documentId))) {
    // Same address, different (or gone) document: a reload or replacement. The
    // capture result can no longer be committed against the originating
    // document (issue #18).
    cancelJobForNavigation(tabId, job, CANCELLATION_REASONS.DOCUMENT_REPLACED, tab.url, navigationDiagnostics({
      context: job.kind,
      source: "validateJobForCommit.document",
      job,
      url: tab.url,
    }));
    return false;
  }
  return !isJobStale(tabId, job);
}

function finishJob(tabId, job) {
  if (activeJobs.get(tabId) !== job || isJobTerminal(job)) return false;
  job.phase = "done";
  job.terminalState = "succeeded";
  clearJobTimeout(job);
  activeJobs.delete(tabId);
  return true;
}

async function sendValidatedBanner(tabId, job, verdict, data) {
  if (!(await validateJobForCommit(tabId, job))) return false;
  const response = await sendJobDocumentMessage(tabId, job, {
    type: "show_banner",
    verdict,
    data,
  });
  if (response?.accepted !== true) {
    // The initiating document can disappear after validation but before
    // delivery. A rejected/undeliverable old verdict is therefore a silent
    // invalidation, never a reason to open the navigation warning UI.
    cancelJob(tabId, job, "unclassified", {
      interruptionMode: "silent",
      resetContent: true,
    });
    return false;
  }
  return finishJob(tabId, job);
}

async function recordCancelledDiagnostics(job) {
  if (job.cancellationRecorded) return;
  job.cancellationRecorded = true;
  try {
    await appendAnalysisHistory({
      schema_version: ANALYSIS_HISTORY_SCHEMA,
      datetime: new Date().toISOString(),
      extension_version: chrome.runtime.getManifest().version,
      origin: compactOrigin(job.origin ?? webOriginOf(job.url)),
      status: "cancelled",
      context: job.kind,
      reason: job.reasonHint ?? "unclassified",
      // Issue #18: the event source and URL/document equality that classified
      // this cancellation. Booleans only -- the authentication URL and its
      // sensitive query string are deliberately never stored.
      ...(job.navigationDiagnostics === null ? {} : { navigation: job.navigationDiagnostics }),
      // A logo search that was abandoned is exactly the sample the deadline
      // needs to be tuned against, so it is recorded here too (issue #14).
      ...(job.logoSearchMs === undefined ? {} : { logo_search_ms: job.logoSearchMs }),
    });
  } catch (error) {
    console.warn("[YodelPhish] Could not store cancellation diagnostics:", error);
  }
}

async function finalizeCancelledJob(tabId, job) {
  if (job.terminalState !== "cancelled") return;
  // Diagnostics still record the cancellation (including a navigation-silenced
  // one); only the interruption tab is withheld for a silent job. Suppressing
  // the initial analysis_interrupted message alone is not enough -- this later
  // cleanup path must never schedule an interruption for a silent job.
  const tasks = [recordCancelledDiagnostics(job)];
  if (cancellationPresentation(job.interruptionMode).scheduleInterruption) {
    tasks.push(scheduleInterruption(tabId, job));
  }
  await Promise.all(tasks);
}

function scheduleInterruption(tabId, job) {
  if (job.terminalState !== "cancelled") return undefined;
  if (!cancellationPresentation(job.interruptionMode).scheduleInterruption) return undefined;
  if (job.interruptionPromise !== undefined) return job.interruptionPromise;
  job.interruptionPromise = (async () => {
    await new Promise((resolve) => setTimeout(resolve, INTERRUPTION_DELAY_MS));
    const result = await interruptionTabs.open({
      analysedTabId: tabId,
      entry: {
        analysedTabId: tabId,
        jobId: job.jobId,
        url: job.url,
        reasonHint: job.reasonHint ?? "unclassified",
      },
      isCurrent: () => job.terminalState === "cancelled" && activeJobs.get(tabId) === job,
    });
    if (result.error !== undefined) {
      console.error("[YodelPhish] Failed to open interruption tab:", result.error);
    }
    if (result.ok || activeJobs.get(tabId) !== job) return;

    await chrome.tabs.sendMessage(tabId, {
      type: "analysis_failed",
      jobId: job.jobId,
      code: "interruption_unavailable",
    }).catch(() => {});
    if (activeJobs.get(tabId) === job) activeJobs.delete(tabId);
  })();
  return job.interruptionPromise;
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === OFFSCREEN_TARGET || message?.target === CLICKFIX_CLIPBOARD_TARGET) return false;

  if (SETTINGS_MESSAGE_TYPES.has(message?.type) && !isSettingsSender(sender)) {
    sendResponse(invalidSettingsRequest("forbidden"));
    return false;
  }

  if (message?.type === "request_manual_analysis" && !isPopupSender(sender)) {
    sendResponse(invalidSettingsRequest("forbidden"));
    return false;
  }

  const tabId = sender.tab?.id;
  withTimeout(
    storageAccessReady.then(() => handleMessage(message, tabId, sender.url ?? sender.tab?.url, sender)),
    MESSAGE_RESPONSE_TIMEOUT_MS,
    new AnalysisExecutionError("job_timeout", "Message handler exceeded its response deadline")
  )
    .then(sendResponse)
    .catch((error) => {
      console.error("[YodelPhish] Error handling message:", error);
      sendResponse({ error: true, code: failureCodeFor(error) });
    });
  return true;
});

async function handleMessage(message, tabId, senderUrl, sender) {
  switch (message.type) {
    case "run_pipeline": {
      if (tabId === undefined) return;
      // Only the top document owns an analysis (issue #88). A child frame
      // reports a login surface through child_frame_login_detected and can
      // never bind a job to its own URL or document.
      if (!isTopFrameSender(sender)) return;
      // A tab that is picking a logo must not start an analysis underneath it.
      if (await selectorSessions.get(tabId) !== null) return;
      // The authoritative current top frame rather than the sender's snapshot:
      // for a same-document route change, sender.url and the browser's own
      // frame URL do not necessarily settle at the same instant, and this
      // job's stored URL is what every later navigation notification is
      // compared against (see isActiveJobAddress). Shared with add_to_trusted
      // (issue #18).
      const resolved = await resolveAuthoritativeTopFrame(tabId, sender);
      if (!resolved.ok) {
        return { error: true, code: "analysis_failed" };
      }
      const currentUrl = resolved.url;
      const job = startJob(
        tabId,
        message.jobId,
        currentUrl,
        "detection",
        resolved.documentId
      );
      let origin;
      let fileScan = false;
      let deviceFlow = null;
      try {
        await clearInterruptionForAnalysed(tabId);
        const pendingWarning = await getPendingPhishingWarning(tabId);
        if (pendingWarning !== null) {
          if (isPendingPhishingUrl(currentUrl, pendingWarning)) {
            const warningUrl = chrome.runtime.getURL(INTERSTITIAL_PAGE);
            job.expectedNavigationUrl = warningUrl;
            await chrome.tabs.update(tabId, { url: warningUrl });
            finishJob(tabId, job);
            return;
          }
          await discardPhishingTabState(tabId);
        }

        // Device-code phishing (issue #39) takes precedence over trusted/muted
        // status and runs independently of DOM login detection -- decided
        // purely from the URL, before any of that machinery below is
        // consulted. onCommitted already handles the common case; this is the
        // defense-in-depth path for a manual re-analyse or icon click.
        deviceFlow = await evaluateDeviceFlow(tabId, currentUrl);
        if (deviceFlow?.action === "interstitial") {
          job.expectedNavigationUrl = DEVICE_FLOW_INTERSTITIAL_URL;
          await chrome.tabs.update(tabId, { url: DEVICE_FLOW_INTERSTITIAL_URL });
          finishJob(tabId, job);
          return;
        }

        if (deviceFlow === null) {
          fileScan = isFileUrl(currentUrl) && await isFileScanPermitted();
          origin = await checkOrigin(currentUrl, { allowFile: fileScan });
          job.origin = origin;
        }
      } catch (error) {
        if (!(await settleJobException(tabId, job, error))) throw error;
        return;
      }
      if (isJobStale(tabId, job)) {
        await finalizeCancelledJob(tabId, job);
        return;
      }

      if (deviceFlow?.action === "banner") {
        try {
          const response = await sendToTab(tabId, {
            type: "show_banner",
            verdict: "high_risk_login",
            data: { provider: deviceFlow.provider },
            jobId: job.jobId,
          });
          if (response?.accepted === true) finishJob(tabId, job);
          else cancelJob(tabId, job, "unclassified", { interruptionMode: "silent" });
        } catch (error) {
          if (!(await settleJobException(tabId, job, error))) throw error;
        }
        return;
      }

      try {
        if (!origin.valid) {
          const response = await sendToTab(tabId, {
            type: "show_banner",
            verdict: "unknown",
            data: {},
            jobId: job.jobId,
          });
          if (response?.accepted === true) finishJob(tabId, job);
          else cancelJob(tabId, job, "unclassified", { interruptionMode: "silent" });
          return;
        }

        if (origin.in_muted_list) {
          if (isJobStale(tabId, job)) {
            await finalizeCancelledJob(tabId, job);
            return;
          }
          // Read-decide-write as one queued step: a stale muted_list read
          // taken before this check could otherwise be filtered and written
          // back after another handler already changed it concurrently.
          const muteOutcome = await withTrustedMuted((state) => {
            const entry = findByFqdn(state.muted_list, origin.fqdn);
            if (entry?.muted_until === "next_login") {
              state.muted_list = state.muted_list.filter((item) => item.fqdn !== origin.fqdn);
              return { value: "consumed", changed: true };
            }
            return { value: "active", changed: false };
          });
          if (muteOutcome === "active") {
            const response = await sendToTab(tabId, {
              type: "show_banner",
              verdict: "muted",
              data: {},
              jobId: job.jobId,
            });
            if (response?.accepted === true) finishJob(tabId, job);
            else cancelJob(tabId, job, "unclassified", { interruptionMode: "silent" });
            return;
          }
        }
      } catch (error) {
        if (!(await settleJobException(tabId, job, error))) throw error;
        return;
      }

      if (isJobStale(tabId, job)) {
        await finalizeCancelledJob(tabId, job);
        return;
      }

      if (origin.in_trusted_list && origin.protocol_matches && origin.protocol === "https") {
        await sendToTab(tabId, { type: "show_banner", verdict: "trusted", data: {}, jobId: job.jobId, provisional: true });
        try {
          const result = await runJobDetection(tabId, job);
          if (result === null || !(await validateJobForCommit(tabId, job))) {
            await finalizeCancelledJob(tabId, job);
            return;
          }
          // refreshTrustedEntry also handles the one threshold-independent
          // capture owed by an entry moved from the muted list.
          const refreshed = await refreshTrustedEntry(origin.fqdn, result, tabId, job);
          if (!refreshed) {
            await finalizeCancelledJob(tabId, job);
            return;
          }
          if (!(await sendValidatedBanner(tabId, job, "trusted", {}))) {
            await finalizeCancelledJob(tabId, job);
            return;
          }
          await recordCompletedAnalysis({ origin, result, displayedVerdict: "trusted" });
        } catch (error) {
          if (!(await settleJobException(tabId, job, error))) throw error;
          return;
        }
        return;
      }

      try {
        const result = await runJobDetection(tabId, job);
        if (result === null || !(await validateJobForCommit(tabId, job))) {
          await finalizeCancelledJob(tabId, job);
          return;
        }

        if (fileScan && origin.trusted_entry?.needs_reference_capture === true) {
          const refreshed = await refreshTrustedEntry(origin.fqdn, result, tabId, job);
          if (!refreshed) {
            await finalizeCancelledJob(tabId, job);
            return;
          }
        }

        const verdict = computeVerdict(result, origin);
        const data = {
          global_score: result.global_score,
          dinov2_logo_similarity: result.dinov2_logo_similarity,
          logo_region_score: result.logo_region_score,
          ocr_score: result.ocr_score,
          best_match_fqdn: result.best_match_fqdn,
          fqdn: fileScan ? currentUrl : origin.fqdn,
        };

        if (verdict === "phishing") {
          await setPendingPhishingWarning(tabId, { url: currentUrl, data });
          if (!(await validateJobForCommit(tabId, job))) {
            await discardPhishingTabState(tabId);
            await finalizeCancelledJob(tabId, job);
            return;
          }
          const warningUrl = chrome.runtime.getURL(INTERSTITIAL_PAGE);
          job.expectedNavigationUrl = warningUrl;
          await chrome.tabs.update(tabId, { url: warningUrl });
          if (!finishJob(tabId, job)) {
            await discardPhishingTabState(tabId);
            await finalizeCancelledJob(tabId, job);
            return;
          }
        } else if (!(await sendValidatedBanner(tabId, job, verdict, data))) {
          await finalizeCancelledJob(tabId, job);
          return;
        }

        await recordCompletedAnalysis({
          origin,
          result,
          displayedVerdict: verdict,
          context: fileScan ? "file_scan" : "detection",
        });
        return;
      } catch (error) {
        if (!(await settleJobException(tabId, job, error))) throw error;
        return;
      }
    }

    // Issue #88: a child frame reported that its own document became a login
    // page. Nothing about the pipeline moves into that frame -- the signal is
    // forwarded to the tab's current top document, which applies exactly the
    // lifecycle rules it applies to its own detector. The message is delivered
    // to that one document rather than broadcast, so no other frame can see or
    // answer it.
    case "child_frame_login_detected": {
      if (sender?.id !== chrome.runtime.id) return;
      if (!Number.isInteger(tabId)) return;
      if (!Number.isInteger(sender.frameId) || sender.frameId <= 0) return;
      if (typeof sender.documentId !== "string" || sender.documentId === "") return;
      if (sender.documentLifecycle !== "active") return;

      const [senderFrame, topFrame] = await Promise.all([
        chrome.webNavigation.getFrame({
          tabId,
          frameId: sender.frameId,
          documentId: sender.documentId,
        }).catch(() => null),
        resolveTopFrame(tabId),
      ]);
      // Browser navigation metadata is origin-independent, so opaque srcdoc
      // frames can be validated without parent-side DOM access. If the exact
      // sending document is no longer active, its report is stale.
      if (senderFrame?.documentId !== sender.documentId ||
          senderFrame?.documentLifecycle !== "active") return;
      const topDocumentId = topFrame?.documentId;
      if (typeof topDocumentId !== "string" || topDocumentId === "" ||
          topFrame?.documentLifecycle !== "active") return;

      await chrome.tabs.sendMessage(
        tabId,
        { type: "embedded_login_detected" },
        { documentId: topDocumentId }
      ).catch(() => {});
      return;
    }

    case "analysis_client_timed_out": {
      if (tabId === undefined) return;
      const job = activeJobs.get(tabId);
      if (job === undefined || message.jobId !== job.jobId || isJobTerminal(job)) return;
      failJob(tabId, job, "client_timeout", new Error("Content-side analysis deadline expired"));
      return;
    }

    case "get_interruption_state": {
      if (tabId === undefined || !isInterruptionUrl(senderUrl)) return { ok: false };
      const entry = await getInterruption(tabId);
      if (entry === null) return { ok: false };
      return { ok: true, reason: describeReason(entry.reasonHint) };
    }

    case "interruption_ui_ready": {
      if (tabId === undefined || !isInterruptionUrl(senderUrl)) return { ok: false };
      const entry = await getInterruption(tabId);
      if (entry === null) return { ok: false };
      interruptionTabs.acknowledgeReady(tabId);
      return { ok: true };
    }

    // Issue #51: the popup's "Run manual analysis" button. The tab is the one
    // the popup was opened over, so it is taken from the request rather than
    // from the sender -- the popup is not a tab.
    case "request_manual_analysis": {
      if (!Number.isInteger(message.tabId)) return invalidSettingsRequest();
      const outcome = await runManualAnalysis(message.tabId);
      return { started: outcome === ACTION_OUTCOMES.STARTED, message: actionFeedbackFor(outcome).message };
    }

    case "reanalyse_interrupted": {
      if (tabId === undefined || !isInterruptionUrl(senderUrl)) return { ok: false };
      const entry = await getInterruption(tabId);
      if (entry === null) return { ok: false };
      const active = activeJobs.get(entry.analysedTabId);
      if (active?.jobId === entry.jobId) activeJobs.delete(entry.analysedTabId);
      await chrome.tabs.update(entry.analysedTabId, { active: true });
      // The interstitial's "re-analyse" button drives the same manual trigger
      // as the action icon, so it can now tell a handled re-analysis (started,
      // already running, or a device-flow warning taking priority) from one
      // that never arrived, in which case the interstitial stays open and says
      // so.
      if ((await deliverManualTrigger(entry.analysedTabId)) === ACTION_OUTCOMES.DELIVERY_FAILED) {
        return { ok: false };
      }
      await takeInterruptionByInterstitial(tabId);
      await chrome.tabs.remove(tabId).catch(() => {});
      return { ok: true };
    }

    case "continue_interrupted": {
      if (tabId === undefined || !isInterruptionUrl(senderUrl)) return { ok: false };
      const entry = await getInterruption(tabId);
      if (entry === null) return { ok: false };
      const active = activeJobs.get(entry.analysedTabId);
      if (active?.jobId === entry.jobId) activeJobs.delete(entry.analysedTabId);
      await chrome.tabs.update(entry.analysedTabId, { active: true });
      try {
        await chrome.tabs.sendMessage(entry.analysedTabId, { type: "continue_without_analysis", jobId: entry.jobId });
      } catch {
        return { ok: false };
      }
      await takeInterruptionByInterstitial(tabId);
      await chrome.tabs.remove(tabId).catch(() => {});
      return { ok: true };
    }

    case "leave_interrupted_page": {
      if (tabId === undefined || !isInterruptionUrl(senderUrl)) return { ok: false };
      const entry = await takeInterruptionByInterstitial(tabId);
      if (entry === null) return { ok: false };
      const active = activeJobs.get(entry.analysedTabId);
      if (active?.jobId === entry.jobId) activeJobs.delete(entry.analysedTabId);
      await chrome.tabs.remove([tabId, entry.analysedTabId]).catch(() => {});
      return { ok: true };
    }

    case "add_to_trusted": {
      if (tabId === undefined) return;
      if (!isTopFrameSender(sender)) return;
      // Issue #18: bind to the authoritative current top frame, exactly as
      // run_pipeline does, rather than the sender's possibly-stale snapshot. A
      // History API URL change between page load and this click otherwise leaves
      // the job anchored to a URL the browser's navigation events no longer
      // report, and the next same-document event cancels the capture as a false
      // address change (the Zalando symptom in issue #18). A stale or replaced
      // sender document cannot start a job at all.
      const resolved = await resolveAuthoritativeTopFrame(tabId, sender);
      if (!resolved.ok) {
        return { error: true, code: "analysis_failed", reason: resolved.reason };
      }
      let currentUrl = resolved.url;
      let parsedOrigin = await parseListOrigin(currentUrl);
      if (parsedOrigin === null) {
        return sendDocumentMessage(tabId, resolved.documentId, {
          type: "show_banner",
          jobId: message.jobId,
          verdict: "unknown",
          data: {},
        });
      }
      // Issue #8: when this tab was opened by a Settings "Move to trusted", the
      // same confirmation flow runs, but on completion the tab is closed and
      // Settings is refocused rather than a banner shown in place. The intent is
      // fqdn-scoped so it survives the reloads and same-site redirects a login
      // page makes before confirmation, yet never turns an unrelated site the
      // tab later navigates to into a move. The selector session consumes it.
      const moveIntent = await trustedAddIntents.get(tabId);
      // Revalidate the top document immediately before startJob (issue #18): the
      // origin parse and intent read above are asynchronous, so re-resolve to be
      // sure the same active document is still current before binding the job.
      const revalidated = await resolveAuthoritativeTopFrame(tabId, sender);
      if (!revalidated.ok || revalidated.documentId !== resolved.documentId) {
        return {
          error: true,
          code: "analysis_failed",
          reason: revalidated.ok ? CANCELLATION_REASONS.STALE_SENDER_DOCUMENT : revalidated.reason,
        };
      }
      if (revalidated.url !== currentUrl) {
        // A History API update can legitimately settle between the first frame
        // resolution and the intent read. It is still the same document, and web
        // History API changes cannot cross origin, so bind to the browser's
        // latest URL after independently confirming the fqdn. File references
        // retain exact-URL identity and therefore fail closed here.
        const updatedOrigin = parseOrigin(revalidated.url);
        if (updatedOrigin === null || updatedOrigin.fqdn !== parsedOrigin.fqdn) {
          return { error: true, code: "analysis_failed", reason: CANCELLATION_REASONS.URL_CHANGED };
        }
        currentUrl = revalidated.url;
        parsedOrigin = updatedOrigin;
      }
      const isMoveToTrusted = moveIntent !== null && moveIntent.fqdn === parsedOrigin.fqdn;
      const origin = { valid: true, ...parsedOrigin };
      const job = startJob(tabId, message.jobId, currentUrl, "add_to_trusted", revalidated.documentId);
      job.origin = origin;
      // What the two routes that bypass the automatic search ("Select logo
      // manually" and the logo-search deadline) need to open the same selector
      // this handler would have opened (issue #14).
      job.trustedAdd = { origin: parsedOrigin, moveIntent: isMoveToTrusted ? moveIntent : null };
      armLogoSearchDeadline(tabId, job);

      try {
        const result = await runJobDetection(tabId, job);
        if (result === null || !(await validateJobForCommit(tabId, job))) {
          await finalizeCancelledJob(tabId, job);
          return;
        }
        // Issue #90: no automatic preprocessing or trusted-list write happens
        // here any more. The user first confirms which region actually is the
        // logo; encoding and the commit run in the selector's confirmation
        // path (logo_selection_confirmed), so a wrong proposal can never
        // become the stored reference. YOLO's boxes ride along purely as
        // suggestions, gathered with a lower-than-detection floor because a
        // human does the filtering; with none the selector opens in free-draw.
        const candidates = await proposeTrustedAddCandidates(result.screenshot, tabId, job.jobId);
        if (!(await validateJobForCommit(tabId, job))) {
          await finalizeCancelledJob(tabId, job);
          return;
        }
        // The search is over: stop its deadline before anything is awaited, so
        // the fallback can never fire against a selector this path is already
        // opening.
        clearLogoSearchDeadline(job);
        recordLogoSearchDuration(job);

        if (!(await openTrustedAddSelector(tabId, job, { scores: scoreSnapshot(result), candidates }))) {
          await finalizeCancelledJob(tabId, job);
          return;
        }
        if (!finishJob(tabId, job)) {
          await finalizeCancelledJob(tabId, job);
          return;
        }
        await recordCompletedAnalysis({
          origin,
          result,
          displayedVerdict: "logo_validation_pending",
          context: "add_to_trusted",
          preprocessing: { candidates },
          logoSearchMs: job.logoSearchMs,
        });
        return;
      } catch (error) {
        const settled = await settleJobException(tabId, job, error);
        // Manual selection and the timeout deliberately cancel the automatic
        // job after claiming a selector session. Their cancellation rejection
        // can race this catch before openTrustedAddSelector has consumed the
        // Settings move intent; never mistake that successful handoff for an
        // analysis failure and close its tab underneath the selector.
        if (isMoveToTrusted && !job.selectorOpened) {
          await abortTrustedAddIntent(tabId).catch((cleanupError) => {
            console.warn("[YodelPhish] Failed to abort trusted-add intent after analysis failure:", cleanupError);
          });
        }
        if (!settled) throw error;
        return;
      }
    }

    // Issue #8: a tab opened by "Move to trusted" asks, before it would start
    // ordinary phishing analysis, whether it should instead run the trusted-add
    // confirmation. Answered true only while the tab is still on the fqdn the
    // move was started for, so a same-site reload keeps confirming while a
    // navigation elsewhere falls back to ordinary analysis. This check is
    // read-only; selector startup or navigation/tab cleanup consumes it.
    case "get_trusted_add_intent": {
      if (tabId === undefined || !isTopFrameSender(sender)) return { ok: true, active: false };
      const intent = await trustedAddIntents.get(tabId);
      if (intent === null) return { ok: true, active: false };
      const origin = await parseListOrigin(senderUrl);
      return { ok: true, active: origin !== null && origin.fqdn === intent.fqdn };
    }

    // =========================================================================
    // PROGRESS-BANNER CONTROLS (issue #14)
    //
    // Both are scoped to one exact job id, so a control clicked just as the
    // flow moved on -- a superseding job, a navigation cancel, a result that
    // landed first -- is a no-op rather than an action against whatever came
    // next. Both are top-frame only, like every other message that can end a
    // job (issue #88).
    // =========================================================================

    // "Cancel" on either progress banner, and the standard analysis the
    // progress banner's "Add to trusted" replaces. The content script has
    // already released its own UI and stopped accepting this job's messages;
    // what is left is to make the job terminal so its in-flight work can no
    // longer commit anything, and to give back a tab a Settings move opened
    // for a confirmation that is not going to happen.
    case "cancel_current_analysis": {
      if (tabId === undefined || !isTopFrameSender(sender)) return { ok: false };
      const job = activeJobs.get(tabId);
      if (job === undefined || job.jobId !== message.jobId || isJobTerminal(job)) {
        return { ok: false, reason: "no_active_job" };
      }
      // Only a cancelled *move* gives its tab back: that tab exists solely for
      // a confirmation that is now not going to happen. A tab the user was
      // already on keeps its own life, exactly as it does when the same flow
      // fails rather than being cancelled.
      const wasMoveToTrusted = job.trustedAdd?.moveIntent != null;
      cancelJobForUser(tabId, job, "user_cancelled");
      await finalizeCancelledJob(tabId, job);
      if (wasMoveToTrusted) {
        await abortTrustedAddIntent(tabId).catch((error) => {
          console.warn("[YodelPhish] Failed to abort trusted-add intent after cancellation:", error);
        });
      }
      return { ok: true };
    }

    // "Select logo manually": stop waiting for the automatic search and mount
    // the selector now. The job is cancelled first, so a search that is still
    // physically running cannot come back and overwrite the session the user
    // is about to draw into.
    case "select_logo_manually": {
      if (tabId === undefined || !isTopFrameSender(sender)) return { ok: false };
      const job = activeJobs.get(tabId);
      if (job === undefined || job.jobId !== message.jobId || job.kind !== "add_to_trusted") {
        return { ok: false, reason: "no_active_job" };
      }
      // The automatic path won the race to the selector; it is already open (or
      // opening) with the same session, and there is nothing else to do.
      if (job.selectorOpened) return { ok: true };
      if (isJobTerminal(job)) return { ok: false, reason: "no_active_job" };
      cancelJobForUser(tabId, job, "manual_logo_selection");
      const opened = await openTrustedAddSelector(tabId, job, {});
      await finalizeCancelledJob(tabId, job);
      return { ok: opened };
    }

    case "add_to_muted": {
      const origin = await parseListOrigin(senderUrl);
      if (origin === null) return;
      const mutedUntil = ALLOWED_MUTED_UNTIL.has(message.muted_until)
        ? message.muted_until
        : "forever";
      await withTrustedMuted((state) => {
        // Issue #12: muting an fqdn explicitly removes its trusted variants,
        // so the two lists stay mutually exclusive. A manually added trusted
        // hostname keeps its provenance across the move (issue #93), so Reset
        // to defaults can still find it.
        const wasManual = state.trusted_list.some(
          (entry) => entry.fqdn === origin.fqdn && entry.manual_entry === true
        );
        state.trusted_list = state.trusted_list.filter((entry) => entry.fqdn !== origin.fqdn);
        const existing = findByFqdn(state.muted_list, origin.fqdn);
        if (existing === null) {
          state.muted_list = [
            ...state.muted_list,
            {
              fqdn: origin.fqdn,
              etld1: origin.etld1,
              protocol: origin.protocol,
              ...(origin.sourceUrl === undefined ? {} : { source_url: origin.sourceUrl }),
              muted_until: mutedUntil,
              user_words: [],
              scores: [],
              last_visited: todayString(),
              ...(wasManual ? { manual_entry: true } : {}),
            },
          ];
        } else {
          existing.muted_until = mutedUntil;
          if (origin.sourceUrl !== undefined) existing.source_url = origin.sourceUrl;
        }
        return { value: undefined, changed: true };
      });
      if (tabId !== undefined) {
        return sendToTab(tabId, {
          type: "show_banner",
          verdict: "muted_confirmation",
          data: { fqdn: origin.sourceUrl ?? origin.fqdn },
        });
      }
      return;
    }

    // Only the isolated mediator can send this runtime message. Its private,
    // per-document channel receives the immutable value from the MAIN hook;
    // the background still reclassifies that exact text using trusted settings
    // and sender context before an extension-owned clipboard write.
    case "clickfix_clipboard_request": {
      const clickfixContextUrl = clickfixSenderContextUrl(sender);
      if (clickfixContextUrl === null || tabId === undefined) {
        return invalidSettingsRequest("forbidden");
      }
      if (!CLICKFIX_OPERATIONS.has(message.operation) ||
          typeof message.text !== "string" ||
          message.text.length > MAX_COPY_TEXT_LENGTH) {
        return { ok: true, status: "blocked" };
      }
      // Keep classification and an allowed clipboard write in the same settings
      // transaction. Otherwise a strict-mode change or exclusion removal could
      // be acknowledged after a permissive read but before its stale write.
      const inspection = await withSettings(async (state) => {
        const currentSettings = state.clickfix;
        const decision = detectClickfixCommand(message.text, currentSettings, { url: clickfixContextUrl });
        if (decision.action === "allow") {
          await writeClickfixClipboardText(message.text);
          return { value: { copied: true }, changed: false };
        }
        return {
          value: {
            copied: false,
            decision,
            mode: currentSettings.mode,
          },
          changed: false,
        };
      });
      if (inspection.copied) return { ok: true, status: "copied" };
      const warning = await openClickfixWarning(
        sender,
        clickfixContextUrl,
        message.text,
        inspection.decision,
        inspection.mode
      );
      if (warning === null) return { ok: false, code: "rate_limited" };
      return {
        ok: true,
        status: inspection.decision.action === "warn" ? "warning" : "blocked",
      };
    }

    // The blocked-copy notice links to settings, but chrome.runtime.openOptionsPage()
    // is not part of the restricted chrome.runtime subset content scripts get.
    case "open_clickfix_settings": {
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    }

    // =========================================================================
    // SETTINGS PAGE PROTOCOL — issue #13. The settings page may read storage
    // after this worker has restricted it to trusted contexts, but every write
    // is a validated request serialized through the matching domain queue.
    // Mutation responses contain only the affected record fields.
    // =========================================================================

    case "prepare_settings_state": {
      await getStorage();
      await withAnalysisHistoryState((state) => ({ value: state.history.length, changed: false }));
      return { ok: true };
    }

    case "add_user_word": {
      const { listType, fqdn, variantId } = message;
      const word = normalizeUserWordInput(message.word);
      if (!isValidListType(listType) || !isValidFqdnTarget(fqdn) || word === null ||
          (listType === "trusted" && !isValidVariantId(variantId))) {
        return invalidSettingsRequest();
      }
      const mutation = await withTrustedMuted((state) => {
        const list = listType === "trusted" ? state.trusted_list : state.muted_list;
        const entry = findListEntry(list, fqdn, listType, variantId);
        if (entry === null) return { value: null, changed: false };
        const currentWords = Array.isArray(entry.user_words) ? entry.user_words : [];
        if (currentWords.includes(word)) {
          return { value: { variantId: entry.variant_id, userWords: [...currentWords] }, changed: false };
        }
        entry.user_words = [...currentWords, word];
        if (listType === "trusted") touchTrustedEntry(entry);
        return { value: { variantId: entry.variant_id, userWords: [...entry.user_words] }, changed: true };
      });
      if (mutation === null) return invalidSettingsRequest("not_found");
      return { ok: true, listType, fqdn, variantId: mutation.variantId, user_words: mutation.userWords };
    }

    case "remove_user_word": {
      const { listType, fqdn, variantId } = message;
      const word = normalizeUserWordInput(message.word);
      if (!isValidListType(listType) || !isValidFqdnTarget(fqdn) || word === null ||
          (listType === "trusted" && !isValidVariantId(variantId))) {
        return invalidSettingsRequest();
      }
      const mutation = await withTrustedMuted((state) => {
        const list = listType === "trusted" ? state.trusted_list : state.muted_list;
        const entry = findListEntry(list, fqdn, listType, variantId);
        if (entry === null) return { value: null, changed: false };
        const currentWords = Array.isArray(entry.user_words) ? entry.user_words : [];
        const nextWords = currentWords.filter((existing) => existing !== word);
        const changed = nextWords.length !== currentWords.length;
        if (changed) {
          entry.user_words = nextWords;
          if (listType === "trusted") touchTrustedEntry(entry);
        }
        return { value: { variantId: entry.variant_id, userWords: [...nextWords] }, changed };
      });
      if (mutation === null) return invalidSettingsRequest("not_found");
      return { ok: true, listType, fqdn, variantId: mutation.variantId, user_words: mutation.userWords };
    }

    case "update_muted_until": {
      const { fqdn, value } = message;
      if (!isValidFqdnTarget(fqdn) || !ALLOWED_MUTED_UNTIL.has(value)) return invalidSettingsRequest();
      const mutation = await withTrustedMuted((state) => {
        const entry = findByFqdn(state.muted_list, fqdn);
        if (entry === null) return { value: null, changed: false };
        const changed = entry.muted_until !== value;
        entry.muted_until = value;
        return { value: entry.muted_until, changed };
      });
      if (mutation === null) return invalidSettingsRequest("not_found");
      return { ok: true, fqdn, muted_until: mutation };
    }

    case "remove_list_entry": {
      const { listType, fqdn, variantId } = message;
      if (!isValidListType(listType) || !isValidFqdnTarget(fqdn) ||
          (listType === "trusted" && !isValidVariantId(variantId))) {
        return invalidSettingsRequest();
      }
      const removed = await withTrustedMuted((state) => {
        if (listType === "trusted") {
          const filtered = state.trusted_list.filter((entry) => !(entry.fqdn === fqdn && entry.variant_id === variantId));
          const changed = filtered.length !== state.trusted_list.length;
          state.trusted_list = filtered;
          return { value: changed, changed };
        }
        const filtered = state.muted_list.filter((entry) => entry.fqdn !== fqdn);
        const changed = filtered.length !== state.muted_list.length;
        state.muted_list = filtered;
        return { value: changed, changed };
      });
      return { ok: true, removed, listType, fqdn, variantId };
    }

    // Issue #8: moving a muted site to the trusted list no longer happens
    // silently with an unvalidated logo captured on a later visit. It opens the
    // site in a new tab and runs the same interactive confirmation as "Add to
    // trusted": the tab's content script starts the add-to-trusted flow (see
    // get_trusted_add_intent), the user confirms which logo YOLO found — or
    // free-draws one — and only that confirmation removes the entry from the
    // muted list and adds it to trusted (applyManualLogoSelection). Cancelling
    // or closing the tab changes nothing, so the site stays muted.
    case "move_muted_to_trusted": {
      const { fqdn } = message;
      if (tabId === undefined || !isValidFqdnTarget(fqdn)) return invalidSettingsRequest();
      const { muted_list } = await getStorage();
      const entry = findByFqdn(muted_list, fqdn);
      if (entry === null) return invalidSettingsRequest("not_found");

      // Reuse the URL derivation open_logo_selector uses, so a file-protocol
      // entry reopens its own file and everything else its https origin.
      const url = entry.protocol === "file" && isFileUrl(entry.source_url)
        ? entry.source_url
        : `${entry.protocol ?? "https"}://${fqdn}`;

      // Arm the tab before the destination can load. Creating it directly at
      // the destination races a cached/file page's content script: it can ask
      // for the intent before storage.session contains it and run normal analysis.
      const newTab = await chrome.tabs.create({ url: "about:blank", active: true });
      if (newTab.id === undefined) return invalidSettingsRequest("tab_unavailable");
      try {
        await trustedAddIntents.set(newTab.id, { fqdn, settingsTabId: tabId });
        await chrome.tabs.update(newTab.id, { url });
      } catch (error) {
        await trustedAddIntents.discardTab(newTab.id).catch(() => {});
        await chrome.tabs.remove(newTab.id).catch(() => {});
        await focusOrOpenSettings(tabId).catch(() => {});
        console.warn("[YodelPhish] Failed to start trusted-add confirmation tab:", error);
        return invalidSettingsRequest("tab_unavailable");
      }
      return { ok: true, pending: true, fqdn, tabId: newTab.id };
    }

    // =========================================================================
    // MANUAL SITE MANAGEMENT (issue #93) — settings-page only, gated via
    // SETTINGS_MESSAGE_TYPES above. The Advanced Settings page adds, edits and
    // removes exact hostnames on the trusted/muted lists; every mutation runs
    // through the shared trusted+muted queue and the pure helpers in
    // storageQueues.mjs, which keep the two lists mutually exclusive and tag
    // the entries with the provenance "Reset to defaults" removes.
    // =========================================================================

    case "add_manual_site":
    case "edit_manual_site": {
      const { listType } = message;
      const fqdn = typeof message.hostname === "string" ? normalizeFqdn(message.hostname) : null;
      if (!isValidListType(listType) || fqdn === null) return invalidSettingsRequest("invalid_hostname");
      let previousFqdn = null;
      if (message.type === "edit_manual_site") {
        if (!isValidFqdnTarget(message.fqdn)) return invalidSettingsRequest();
        previousFqdn = message.fqdn;
      }
      // The exact derivation checkOrigin applies to a visited page, so the
      // stored entry is reachable by an ordinary lookup on the next visit.
      const origin = parseOrigin(`https://${fqdn}`);
      if (origin === null) return invalidSettingsRequest("invalid_hostname");
      const status = await withTrustedMuted((state) => {
        const outcome = applyManualSiteMutation(state, {
          listType,
          origin,
          previousFqdn,
          timestamp: new Date().toISOString(),
          newId: newStorageRevision,
        });
        return { value: outcome.status, changed: outcome.changed };
      });
      if (status !== "saved") return invalidSettingsRequest(status);
      return { ok: true, listType, fqdn };
    }

    case "remove_manual_site": {
      const { listType, fqdn } = message;
      if (!isValidListType(listType) || !isValidFqdnTarget(fqdn)) return invalidSettingsRequest();
      const removed = await withTrustedMuted((state) => {
        const changed = removeManualSiteEntries(state, listType, fqdn);
        return { value: changed, changed };
      });
      if (!removed) return invalidSettingsRequest("not_found");
      return { ok: true, listType, fqdn };
    }

    case "set_developer_mode": {
      if (typeof message.enabled !== "boolean") return invalidSettingsRequest();
      // Every dev-gated choice weakens protection, so none of them may stay
      // active once its control is hidden again (issue #82): turning Advanced
      // Settings off returns both to their secure default. The trusted
      // domains, endpoints and manually added sites they reference are kept —
      // only [Reset to defaults] clears those.
      const settings = await withSettings((state) => {
        const changed = state.developer_mode !== message.enabled ||
          (!message.enabled && (
            state.device_code_auth !== "blocked" ||
            state.clickfix.mode !== "strict"
          ));
        state.developer_mode = message.enabled;
        if (!state.developer_mode) {
          state.device_code_auth = "blocked";
          state.clickfix = { ...state.clickfix, mode: "strict" };
        }
        return {
          value: {
            developer_mode: state.developer_mode,
            device_code_auth: state.device_code_auth,
            clickfix: state.clickfix,
          },
          changed,
        };
      });
      return { ok: true, settings };
    }

    case "set_device_code_auth": {
      if (message.mode !== "allowed" && message.mode !== "blocked") return invalidSettingsRequest();
      const device_code_auth = await withSettings((state) => {
        // Allowing device-code sign-ins is a developer-mode decision; without
        // it the request can only (re)assert the blocked default.
        const mode = state.developer_mode === true && message.mode === "allowed" ? "allowed" : "blocked";
        const changed = state.device_code_auth !== mode;
        state.device_code_auth = mode;
        return { value: state.device_code_auth, changed };
      });
      return { ok: true, device_code_auth };
    }

    // One-click return to the secure defaults (issue #75). Turning Advanced
    // Settings off already restores the dev-gated toggles; this additionally
    // discards the trusted ClickFix domains, the user device-code endpoints,
    // the banner text size and every trusted/muted entry that was added
    // through the Advanced Settings controls (issue #93) — entries created by
    // the normal in-page flows are kept.
    case "reset_advanced_settings": {
      await withSettings((state) => {
        state.developer_mode = false;
        state.device_code_auth = "blocked";
        state.clickfix = { mode: "strict", excluded_domains: [] };
        state.device_flow_user_endpoints = [];
        state.banner_font_size = "small";
        return { value: null, changed: true };
      });
      await withTrustedMuted((state) => {
        const changed = removeAllManualSiteEntries(state);
        return { value: undefined, changed };
      });
      return { ok: true };
    }

    case "set_banner_font_size": {
      if (!BANNER_FONT_SIZES.has(message.size)) return invalidSettingsRequest();
      const banner_font_size = await withSettings((state) => {
        const changed = state.banner_font_size !== message.size;
        state.banner_font_size = message.size;
        return { value: state.banner_font_size, changed };
      });
      return { ok: true, banner_font_size };
    }

    // Read by content scripts when rendering a banner: storage.local is
    // restricted to trusted contexts, so the size travels by message.
    case "get_banner_font_size": {
      const size = await withSettings((state) => ({ value: state.banner_font_size, changed: false }));
      return { ok: true, size };
    }

    case "clear_analysis_history": {
      const cleared = await withAnalysisHistoryState((state) => {
        const changed = state.history.length > 0;
        state.history = [];
        return { value: changed, changed };
      });
      return { ok: true, cleared };
    }

    case "set_icon_state": {
      if (tabId === undefined) return;
      // Real analysis state outranks any transient click feedback still on
      // screen: drop the pending revert rather than let it fire later over
      // the state set here. applyIconState writes the title (the banner text
      // when one is showing — issue #3), so the click's title is covered too.
      cancelActionFeedback(tabId);
      const stored = {
        state: message.state,
        title: typeof message.title === "string" && message.title !== ""
          ? message.title.slice(0, 500)
          : DEFAULT_ACTION_TITLE,
      };
      iconStates.set(tabId, stored);
      await applyIconState(tabId, stored);
      return;
    }

    case "close_tab": {
      if (tabId !== undefined && isInterstitialUrl(senderUrl)) {
        await chrome.tabs.remove(tabId);
      }
      return;
    }

    // Pushed by runtime/loader.js (OpenCV never became usable, or the
    // offscreen bundle script failed to load) or runtime/offscreen.js (the
    // DINOv2/YOLO service construction rejected). No `target` field, so
    // this flows through the normal switch rather than the offscreen
    // request/response filter above. Lets any in-progress
    // waitForOffscreenRuntime() poll fail fast instead of waiting out its
    // full timeout.
    case "offscreen_runtime_failed": {
      if (!isOffscreenSender(sender)) return { ok: false };
      console.error("[YodelPhish] Offscreen runtime failed to start:", message.reason);
      announceOffscreenFailure(typeof message.reason === "string" ? message.reason : "unknown");
      void recycleOffscreenDocument("runtime_failed").catch(() => {});
      return { ok: true };
    }

    case "offscreen_recycle_requested": {
      if (!isOffscreenSender(sender)) return { ok: false };
      await recycleOffscreenDocument(
        typeof message.reason === "string" ? message.reason : "offscreen_requested"
      );
      return { ok: true };
    }

    case "get_clickfix_warning": {
      const requestId = clickfixRequestIdFromInterstitial(senderUrl);
      if (tabId === undefined || requestId === null) return { ok: false };
      const warning = await clickfixWarnings.getWarning(requestId, tabId);
      if (warning === null) return { ok: false };
      let sourceHost = "This page";
      if (warning.sourceUrl === CLICKFIX_OPAQUE_SOURCE_URL) {
        sourceHost = "An embedded page";
      } else if (warning.sourceUrl === "file:") {
        sourceHost = "A local file";
      } else {
        try {
          sourceHost = new URL(warning.sourceUrl).hostname || warning.sourceUrl;
        } catch {
          sourceHost = "This page";
        }
      }
      return {
        ok: true,
        mode: warning.mode,
        source_host: sourceHost,
        text: warning.text,
        reasons: warning.decision.reasons,
        tool: warning.decision.tool,
        behavior: warning.decision.behavior,
      };
    }

    case "clickfix_copy_anyway": {
      const requestId = clickfixRequestIdFromInterstitial(senderUrl);
      if (tabId === undefined || requestId === null) return { ok: false };
      try {
        // Serialize approval with settings mutations. If strict mode wins the
        // queue first, the stored warn decision is consumed but cannot copy;
        // if approval wins first, its exact single-use write completes before
        // a later tightening mutation is acknowledged.
        const copied = await withSettings(async (state) => {
          const warning = await clickfixWarnings.consumeWarning(requestId, tabId);
          if (warning === null || warning.mode !== "warn" || state.clickfix.mode !== "warn") {
            return { value: false, changed: false };
          }
          if (!(await isClickfixSourceDocumentAlive(warning))) {
            return { value: false, changed: false };
          }
          await writeClickfixClipboardText(warning.text);
          return { value: true, changed: false };
        });
        return { ok: copied };
      } finally {
        await scheduleClickfixWarningExpiry();
      }
    }

    case "clickfix_cancel": {
      const requestId = clickfixRequestIdFromInterstitial(senderUrl);
      if (tabId === undefined || requestId === null) return { ok: false };
      try {
        const warning = await clickfixWarnings.consumeWarning(requestId, tabId);
        return { ok: warning !== null };
      } finally {
        await scheduleClickfixWarningExpiry();
      }
    }

    // The phishing interstitial is a hard block: it reports what was detected
    // and offers no proceed action (issue #93). A false positive is resolved
    // by adding the exact hostname to Trusted or Muted Sites in Advanced
    // Settings instead.
    case "get_phishing_warning": {
      if (tabId === undefined || !isInterstitialUrl(senderUrl)) return { ok: false };
      const pending = await getPendingPhishingWarning(tabId);
      if (pending === null) return { ok: false };
      return {
        ok: true,
        fqdn: pending.data.fqdn,
        best_match_fqdn: pending.data.best_match_fqdn,
      };
    }

    // Issue #39 — a read-only, informational check content.js runs on its own,
    // independently of and before DOM login detection. It never redirects
    // anything itself; only the webNavigation commit handler and the
    // run_pipeline fallback above do that.
    case "get_device_flow_status": {
      if (tabId === undefined || senderUrl === undefined) return { ok: true, active: false };
      const decision = await evaluateDeviceFlow(tabId, senderUrl);
      return { ok: true, active: decision !== null, provider: decision?.provider ?? null };
    }

    case "get_device_flow_warning": {
      if (tabId === undefined || !isInterstitialUrl(senderUrl)) return { ok: false };
      const relationship = await deviceFlowSessions.getRelationship(tabId);
      if (relationship === null) return { ok: false };
      const { settings } = await getStorage();
      let sourceFqdn = null;
      try {
        sourceFqdn = new URL(relationship.sourceOrigin).hostname;
      } catch {
        // "direct"/"unknown" sentinels: there is no source website to name.
      }
      return {
        ok: true,
        provider: relationship.provider ?? "this provider",
        source_fqdn: sourceFqdn,
        reason: settings.device_code_auth === "allowed" ? "cross_site" : "policy",
      };
    }

    case "open_logo_selector": {
      if (tabId === undefined) return;
      const { fqdn, variantId } = message;
      if (!isValidFqdnTarget(fqdn) || !isValidVariantId(variantId)) return;

      const { trusted_list } = await getStorage();
      const entry = findByVariant(trusted_list, fqdn, variantId);
      if (entry === null) return;

      const url = entry.protocol === "file" && isFileUrl(entry.source_url)
        ? entry.source_url
        : `${entry.protocol ?? "https"}://${fqdn}`;
      const newTab = await chrome.tabs.create({ url, active: true });
      if (newTab.id === undefined) return;

      await selectorSessions.start(newTab.id, {
        fqdn,
        variantId: entry.variant_id,
        settingsTabId: tabId,
        closeTabOnComplete: true,
      });
      // The new tab can finish loading before the session is stored, in which
      // case its "complete" event already came and went with nothing to serve.
      // Injecting twice is harmless: the overlay refuses to mount twice.
      const created = await chrome.tabs.get(newTab.id).catch(() => null);
      if (created?.status === "complete") {
        await injectLogoSelector(newTab.id).catch((error) => {
          console.error("[YodelPhish] Logo selector injection failed:", error);
        });
      }
      return;
    }

    // Issue #7: the selector overlay stays up, disabled, until this handler
    // answers, so every outcome below is what the user sees. A failure code
    // leaves the session registered: the overlay restores its controls and the
    // same selection can be confirmed again or cancelled.
    case "logo_selection_confirmed": {
      if (tabId === undefined) return { ok: false, code: "selector_inactive" };
      const sessionId = message.sessionId;
      const documentId = sender?.documentId;
      if (typeof documentId !== "string" || documentId.length === 0) {
        return { ok: false, code: "page_changed" };
      }
      const attempt = await selectorSessions.beginAttempt(tabId, sessionId);
      if (attempt === null) return { ok: false, code: "selector_inactive" };
      const attemptId = attempt.attemptId;

      const beforeCapture = await checkSelectorSession(tabId, sessionId, attemptId);
      if (beforeCapture.status !== "ok") return { ok: false, code: beforeCapture.status };

      let screenshot;
      let afterCapture = null;
      let captureError = null;
      try {
        const prepared = await chrome.tabs.sendMessage(tabId, { type: "logo_selector_prepare_capture" });
        if (prepared?.ok !== true) throw new Error("Logo selector could not be hidden for capture");
        screenshot = await screenshotSource.captureVisibleTab(tabId);
        afterCapture = await checkSelectorSession(tabId, sessionId, attemptId);
      } catch (error) {
        captureError = error;
      } finally {
        await chrome.tabs.sendMessage(tabId, { type: "logo_selector_capture_complete" }).catch(() => {});
      }
      if (captureError !== null) {
        console.warn("[YodelPhish] Logo selection capture failed:", captureError);
        if (captureError?.code === "capture_interrupted") {
          return { ok: false, code: "capture_interrupted" };
        }
        return { ok: false, code: "capture_failed" };
      }
      if (afterCapture.status !== "ok") return { ok: false, code: afterCapture.status };

      let preprocessed;
      try {
        preprocessed = await sendToOffscreen("preprocess_trusted_region", {
          screenshot,
          normalizedRect: message.normalizedRect,
        }, tabId);
      } catch (error) {
        console.warn("[YodelPhish] Logo selection preprocessing failed:", error);
        return { ok: false, code: "preprocess_failed" };
      }

      const timestamp = new Date().toISOString();
      let outcome;
      try {
        outcome = await withTrustedMuted(async (state) => {
          // This check runs only once the storage queue reaches this write. A
          // cancellation, replacement, or newer retry while waiting therefore
          // prevents the stale request from mutating the trusted list.
          const beforeSave = await checkSelectorSession(tabId, sessionId, attemptId);
          if (beforeSave.status !== "ok") {
            return { value: { status: beforeSave.status, changed: false }, changed: false };
          }
          if (!(await isInitiatingDocumentCurrent(tabId, documentId))) {
            return { value: { status: "page_changed", changed: false }, changed: false };
          }
          const session = beforeSave.session;
          const addition = session.add === undefined || session.add === null
            ? null
            : {
              origin: session.add.origin,
              variantId: crypto.randomUUID(),
              // A session whose automatic search was bypassed or timed out
              // (issue #14) never produced a score snapshot; the entry records
              // no scores at all rather than a dated row of blanks.
              scores: session.add.scores === undefined || session.add.scores === null
                ? []
                : [{ datetime: timestamp, ...session.add.scores }],
              lastVisited: todayString(),
              ...(session.add.moveFromMuted === true ? { moveFromMuted: true } : {}),
            };
          const result = applyManualLogoSelection(state, {
            fqdn: session.fqdn,
            targetVariantId: session.variantId,
            logo: preprocessed,
            timestamp,
            storageRevision: newStorageRevision(),
            addition,
          });
          return { value: { ...result, session }, changed: result.changed };
        });
      } catch (error) {
        console.warn("[YodelPhish] Logo selection save failed:", error);
        return { ok: false, code: "save_failed" };
      }
      if (outcome.status !== "saved") return { ok: false, code: outcome.status };

      let session;
      try {
        session = await selectorSessions.completeAttempt(tabId, sessionId, attemptId);
      } catch (error) {
        // The trusted write is already acknowledged. Cleanup failure must not
        // report a false save failure; retry it without delaying the response.
        console.warn("[YodelPhish] Logo selector session cleanup failed after saving:", error);
        session = outcome.session;
        void selectorSessions.completeAttempt(tabId, sessionId, attemptId).catch((cleanupError) => {
          console.warn("[YodelPhish] Logo selector session cleanup retry failed:", cleanupError);
        });
      }
      if (session === null) {
        // Cancellation, replacement, or a newer retry won while local storage
        // was committing. Remove only this exact revision and report no success.
        await compensateTrustedCommit(outcome.commit);
        return { ok: false, code: "selector_inactive" };
      }

      // The reference is stored and this exact attempt still owns the session.
      // Closing the tab or showing confirmation are non-authoritative follow-ups.
      try {
        if (session.closeTabOnComplete) {
          await chrome.tabs.remove(tabId);
          await focusOrOpenSettings(session.settingsTabId);
        } else {
          await sendToTab(tabId, {
            type: "show_banner",
            verdict: "added_confirmation",
            data: { fqdn: session.fqdn },
          });
        }
      } catch (error) {
        console.warn("[YodelPhish] Logo selection follow-up failed after saving:", error);
      }
      return { ok: true };
    }

    case "logo_selection_cancelled": {
      if (tabId === undefined) return;
      // Scoped to the sending overlay's session: a cancel from an overlay left
      // behind by an earlier session must not tear down the current one.
      await cancelLogoSelectorSession(tabId, message.sessionId);
      return;
    }

    // =========================================================================
    // CLICKFIX SETTINGS MUTATIONS (issue #26) — settings-page only, gated via
    // SETTINGS_MESSAGE_TYPES above. Every response carries the full clickfix
    // sub-object so the settings page can re-render from one source of truth.
    // =========================================================================

    case "set_clickfix_mode": {
      if (!CLICKFIX_MODES.has(message.mode)) return invalidSettingsRequest();
      const clickfix = await withSettings((state) => {
        const changed = state.clickfix.mode !== message.mode;
        if (changed) state.clickfix = { ...state.clickfix, mode: message.mode };
        return { value: state.clickfix, changed };
      });
      return { ok: true, clickfix };
    }

    case "add_clickfix_domain_exclusion": {
      const domain = typeof message.domain === "string" ? message.domain.trim().toLowerCase() : "";
      if (!isValidClickfixDomain(domain)) return invalidSettingsRequest("invalid_domain");
      const clickfix = await withSettings((state) => {
        if (state.clickfix.excluded_domains.includes(domain)) {
          return { value: state.clickfix, changed: false };
        }
        if (state.clickfix.excluded_domains.length >= MAX_CLICKFIX_DOMAIN_EXCLUSIONS) {
          return { value: null, changed: false }; // null here only ever means "at capacity"
        }
        state.clickfix = {
          ...state.clickfix,
          excluded_domains: [...state.clickfix.excluded_domains, domain],
        };
        return { value: state.clickfix, changed: true };
      });
      if (clickfix === null) return invalidSettingsRequest("too_many_domains");
      return { ok: true, clickfix };
    }

    case "remove_clickfix_domain_exclusion": {
      const domain = typeof message.domain === "string" ? message.domain.trim().toLowerCase() : "";
      if (domain.length === 0) return invalidSettingsRequest();
      const clickfix = await withSettings((state) => {
        const filtered = state.clickfix.excluded_domains.filter((d) => d !== domain);
        const changed = filtered.length !== state.clickfix.excluded_domains.length;
        if (changed) state.clickfix = { ...state.clickfix, excluded_domains: filtered };
        return { value: state.clickfix, changed };
      });
      return { ok: true, clickfix };
    }

    // =========================================================================
    // DEVICE-FLOW ENDPOINT MUTATIONS (issue #39) — settings-page only, gated
    // via SETTINGS_MESSAGE_TYPES above. Built-in endpoints ship as code and
    // cannot be edited or removed; these messages touch user endpoints only.
    // =========================================================================

    case "get_device_flow_builtin_endpoints": {
      return { ok: true, endpoints: DEFAULT_DEVICE_FLOW_REGISTRY };
    }

    case "add_device_flow_endpoint": {
      const parsed = parseDeviceFlowEndpointInput(message.endpoint);
      if (parsed === null) return invalidSettingsRequest("invalid_url");
      const outcome = await withSettings((state) => {
        if (deviceFlowEndpointTaken(parsed, state.device_flow_user_endpoints)) {
          return { value: "duplicate", changed: false };
        }
        if (state.device_flow_user_endpoints.length >= MAX_DEVICE_FLOW_ENTRIES) {
          return { value: "capacity", changed: false };
        }
        state.device_flow_user_endpoints = [
          ...state.device_flow_user_endpoints,
          { id: crypto.randomUUID(), ...parsed },
        ];
        return { value: state.device_flow_user_endpoints, changed: true };
      });
      if (outcome === "duplicate") return invalidSettingsRequest("duplicate_endpoint");
      if (outcome === "capacity") return invalidSettingsRequest("too_many_endpoints");
      return { ok: true, device_flow_user_endpoints: outcome };
    }

    case "update_device_flow_endpoint": {
      const id = typeof message.id === "string" ? message.id : "";
      if (id.length === 0) return invalidSettingsRequest();
      const parsed = parseDeviceFlowEndpointInput(message.endpoint);
      if (parsed === null) return invalidSettingsRequest("invalid_url");
      const outcome = await withSettings((state) => {
        const index = state.device_flow_user_endpoints.findIndex((entry) => entry.id === id);
        if (index === -1) return { value: "not_found", changed: false };
        if (deviceFlowEndpointTaken(parsed, state.device_flow_user_endpoints, id)) {
          return { value: "duplicate", changed: false };
        }
        const next = [...state.device_flow_user_endpoints];
        next[index] = { id, ...parsed };
        state.device_flow_user_endpoints = next;
        return { value: state.device_flow_user_endpoints, changed: true };
      });
      if (outcome === "not_found") return invalidSettingsRequest("not_found");
      if (outcome === "duplicate") return invalidSettingsRequest("duplicate_endpoint");
      return { ok: true, device_flow_user_endpoints: outcome };
    }

    case "remove_device_flow_endpoint": {
      const id = typeof message.id === "string" ? message.id : "";
      if (id.length === 0) return invalidSettingsRequest();
      const device_flow_user_endpoints = await withSettings((state) => {
        const filtered = state.device_flow_user_endpoints.filter((entry) => entry.id !== id);
        const changed = filtered.length !== state.device_flow_user_endpoints.length;
        if (changed) state.device_flow_user_endpoints = filtered;
        return { value: state.device_flow_user_endpoints, changed };
      });
      return { ok: true, device_flow_user_endpoints };
    }

    default:
      console.warn("[YodelPhish] Unknown message type:", message.type);
  }
}

// MAX_TRUSTED_VARIANTS_PER_FQDN (a storage invariant, see storageQueues.mjs) caps
// how many automatic reference variants a single domain can accumulate (see [B.2]
// in REVIEW_FINDINGS.md). A drifted-but-acceptable capture is kept as an additional
// variant instead of overwriting the only one on file, so one bad-but-under-threshold
// capture can no longer permanently destroy the reference. Once the cap is reached,
// the oldest automatic variant is replaced.
async function refreshTrustedEntry(fqdn, result, tabId, job) {
  if (!(await validateJobForCommit(tabId, job))) return false;

  const drifted = result.global_score < DRIFT_THRESHOLD;

  // Read the latest variants and, if a manual one exists, commit its score
  // refresh in the same queued step -- never against a snapshot read before
  // this point. `commit` carries just enough identity/version info for
  // compensateTrustedCommit to undo precisely this change later, never a
  // whole-list rollback.
  const outcome = await withTrustedMuted((state) => {
    const variants = findAllByFqdn(state.trusted_list, fqdn);
    if (variants.length === 0) return { value: { kind: "none" }, changed: false };

    const pending = variants.find((entry) => entry.needs_reference_capture === true);
    if (pending !== undefined) {
      return { value: { kind: "initial_capture", variantId: pending.variant_id }, changed: false };
    }
    if (!drifted) return { value: { kind: "none" }, changed: false };

    const manual = variants.find((entry) => entry.logo_source === "manual");
    if (manual === undefined) return { value: { kind: "capture" }, changed: false };

    const before = { ...manual };
    manual.scores = appendScore(manual.scores, scoreSnapshot(result));
    manual.last_visited = todayString();
    manual.updated_at = new Date().toISOString();
    const revision = touchTrustedEntry(manual);
    return {
      value: { kind: "manual_scores", commit: { isNew: false, fqdn, variantId: manual.variant_id, revision, before } },
      changed: true,
    };
  });

  if (outcome.kind === "none") return true;

  if (outcome.kind === "manual_scores") {
    if (!(await validateJobForCommit(tabId, job))) {
      await compensateTrustedCommit(outcome.commit);
      return false;
    }
    return true;
  }

  // A moved entry forces this path once, regardless of its score. Normal
  // entries still reach it only when their reference drifted.
  const preprocessed = await preprocessTrustedReference(result.screenshot, tabId, job.jobId);
  if (!(await validateJobForCommit(tabId, job))) return false;

  if (preprocessed.logo_region === null ||
      typeof preprocessed.logo_image !== "string" || preprocessed.logo_image.length === 0) {
    console.warn(`[YodelPhish] Skipping trusted refresh for ${fqdn}: no usable logo was found`);
    return true;
  }

  const referenceFields = {
    logo_image: preprocessed.logo_image,
    ocr_words: preprocessed.ocr_words,
    logo_regions: preprocessed.logo_regions,
    logo_features: preprocessed.logo_features,
    dinov2_embedding: preprocessed.dinov2_embedding,
  };

  const commit = await withTrustedMuted(async (state) => {
    if (!(await isInitiatingDocumentCurrent(tabId, job.documentId))) {
      return { value: "document_replaced", changed: false };
    }

    if (outcome.kind === "initial_capture") {
      const pending = findByVariant(state.trusted_list, fqdn, outcome.variantId);
      // A manual selection, explicit add or removal may have won while
      // preprocessing ran. Do not overwrite that newer state.
      if (pending?.needs_reference_capture !== true) return { value: null, changed: false };

      const before = { ...pending };
      const revision = newStorageRevision();
      Object.assign(pending, referenceFields, {
        logo_source: "automatic",
        scores: appendScore(pending.scores, scoreSnapshot(result)),
        last_visited: todayString(),
        updated_at: new Date().toISOString(),
        storage_revision: revision,
      });
      delete pending.needs_reference_capture;
      return {
        value: { isNew: false, fqdn, variantId: pending.variant_id, revision, before },
        changed: true,
      };
    }

    const variants = findAllByFqdn(state.trusted_list, fqdn);
    if (variants.length === 0) return { value: null, changed: false };
    const template = variants[0];
    const updatedAt = new Date().toISOString();
    const revision = newStorageRevision();
    const variantId = crypto.randomUUID();
    const newVariant = {
      fqdn,
      storage_revision: revision,
      etld1: template.etld1,
      protocol: template.protocol,
      variant_id: variantId,
      ocr_domain: template.ocr_domain,
      ...referenceFields,
      user_words: template.user_words ?? [],
      scores: [{ datetime: updatedAt, ...scoreSnapshot(result) }],
      last_visited: todayString(),
      updated_at: updatedAt,
      // A manually added hostname's provenance (issue #93) spans every variant,
      // so a drift capture never hides the entry from Reset to defaults.
      ...(template.manual_entry === true ? { manual_entry: true } : {}),
    };

    if (variants.length < MAX_TRUSTED_VARIANTS_PER_FQDN) {
      state.trusted_list = enforceTrustedVariantCap([...state.trusted_list, newVariant]);
      return { value: { isNew: true, fqdn, variantId, revision }, changed: true };
    }

    const oldest = variants.reduce((a, b) => (variantRecency(a) <= variantRecency(b) ? a : b));
    const index = state.trusted_list.indexOf(oldest);
    const before = { ...oldest };
    state.trusted_list = state.trusted_list.map((entry, i) => (i === index ? newVariant : entry));
    return { value: { isNew: false, fqdn, variantId, revision, before }, changed: true };
  });

  if (commit === "document_replaced") {
    // A trusted page's background reference refresh abandoned by navigation:
    // cancel silently, without warning the user (issue #2).
    cancelJobForNavigation(tabId, job, CANCELLATION_REASONS.DOCUMENT_REPLACED, job.url, navigationDiagnostics({
      context: job.kind,
      source: "refreshTrustedEntry.document",
      job,
    }));
    return false;
  }
  if (commit === null) return true;

  if (!(await validateJobForCommit(tabId, job))) {
    await compensateTrustedCommit(commit);
    return false;
  }
  return true;
}

// Re-reads the stored session together with the live tab, so a session that was
// cancelled or replaced mid-flow is caught alongside a tab that navigated away
// or stopped being the active one. Returns "ok" plus the session that was just
// read, or the recoverable code the selector overlay reports to the user.
async function checkSelectorSession(tabId, sessionId, attemptId = undefined) {
  const session = await selectorSessions.get(tabId);
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { status: "selector_inactive", session: null, tab: null };
  }
  const tabUrl = tab.url ?? "";
  const tabOrigin = parseOrigin(tabUrl) ?? await parseFileOrigin(tabUrl);
  const status = selectorSessionStatus(session, {
    sessionId,
    attemptId,
    tabActive: tab.active,
    tabFqdn: tabOrigin?.fqdn,
  });
  return { status, session, tab };
}

// =============================================================================
// TRUSTED-ADD SELECTOR HANDOVER — issue #14
//
// Three routes end the automatic logo search: it finishes, the user presses
// "Select logo manually", or its deadline expires. All three continue into the
// same manual selector, so they all go through this one function, and the
// job's `selectorOpened` flag (set synchronously before the first await) is
// what keeps them mutually exclusive: whichever arrives first opens the
// selector, the others are told it is already open.
//
// A bypassed search has no scores and no candidate boxes, so the selector
// opens in free-draw with the notice explaining why it did.
// =============================================================================

async function openTrustedAddSelector(tabId, job, { scores, candidates = [], notice } = {}) {
  const trustedAdd = job.trustedAdd;
  if (trustedAdd === null || trustedAdd === undefined) return false;
  if (job.selectorOpened) return false;
  job.selectorOpened = true;

  const moveIntent = trustedAdd.moveIntent;
  // The session carries only what the confirmed selection will rebuild the
  // entry from — the analysis result itself is far too large for session
  // storage.
  await selectorSessions.start(tabId, {
    fqdn: trustedAdd.origin.fqdn,
    add: {
      origin: trustedAdd.origin,
      ...(scores === undefined ? {} : { scores }),
      ...(moveIntent !== null ? { moveFromMuted: true } : {}),
    },
    candidates,
    ...(notice === undefined ? {} : { notice }),
    // A move-to-trusted (issue #8) confirms in a tab we opened, so it closes on
    // completion and hands focus back to Settings; an ordinary add confirms in
    // the page the user is already on and keeps it.
    closeTabOnComplete: moveIntent !== null,
    ...(moveIntent?.settingsTabId !== undefined ? { settingsTabId: moveIntent.settingsTabId } : {}),
  });
  // From here the durable selector session owns reload/cancel handling.
  // Consuming the bootstrap intent prevents a failed tab close after save from
  // ever starting a second add flow in the same tab.
  if (moveIntent !== null) await trustedAddIntents.discardTab(tabId);
  await injectLogoSelector(tabId);
  return true;
}

// The UX fallback itself: past TRUSTED_ADD_LOGO_SEARCH_TIMEOUT_MS, waiting for
// the automatic search no longer beats drawing the box by hand, so the flow
// stops waiting and hands over to the selector with an explanation. Nothing is
// reported as failed -- the job is cancelled exactly the way the user's own
// "Select logo manually" cancels it, and the pipeline's own longer timeouts
// stay in place for work that is genuinely broken rather than merely slow.
function armLogoSearchDeadline(tabId, job) {
  clearLogoSearchDeadline(job);
  job.logoSearchTimeoutHandle = setTimeout(() => {
    job.logoSearchTimeoutHandle = undefined;
    if (job.selectorOpened || isJobTerminal(job) || activeJobs.get(tabId) !== job) return;
    cancelJobForUser(tabId, job, "logo_search_timeout");
    void (async () => {
      try {
        await openTrustedAddSelector(tabId, job, { notice: "logo_search_timeout" });
      } finally {
        // The cancellation is recorded even when the handover itself fails --
        // that is the sample the deadline is tuned against. A failed injection
        // has already put the user back on the unknown banner by then (see
        // injectLogoSelector).
        await finalizeCancelledJob(tabId, job);
      }
    })().catch((error) => {
      console.error("[YodelPhish] Failed to open the logo selector after the logo-search deadline:", error);
    });
  }, TRUSTED_ADD_LOGO_SEARCH_TIMEOUT_MS);
}

async function injectLogoSelector(tabId) {
  const session = await selectorSessions.get(tabId);
  if (session === null) return;
  // Re-injection follows the tab's own load events, so it must not paint a
  // selector for site A over whatever the tab navigated to instead. The session
  // is left in place: navigating back brings the overlay back.
  const { status } = await checkSelectorSession(tabId, session.sessionId);
  if (status === "page_changed" || status === "selector_inactive") return;

  try {
    await chrome.tabs.sendMessage(tabId, { type: "cancel_analysis" }).catch(() => {});

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (fqdnVal, sessionIdVal, candidatesVal, noticeVal) => {
        window.__YP_SELECTOR_CONFIG__ = {
          fqdn: fqdnVal,
          sessionId: sessionIdVal,
          candidates: candidatesVal,
          notice: noticeVal,
        };
      },
      // `notice` is a code, never display text (issue #14): the overlay maps it
      // to its own fixed wording, exactly as it does for failure codes, so no
      // background string can ever be rendered into the page.
      args: [session.fqdn, session.sessionId, session.candidates ?? [], session.notice ?? null],
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["logo-selector/logo-selector.js"],
    });
  } catch (error) {
    try {
      await cancelLogoSelectorSession(tabId, session.sessionId);
    } catch (cleanupError) {
      console.warn("[YodelPhish] Failed to clean up logo selector session after injection error:", cleanupError);
    }
    throw error;
  }
}

async function abortTrustedAddIntent(tabId) {
  const intent = await trustedAddIntents.discardTab(tabId);
  if (intent === null) return false;
  await chrome.tabs.remove(tabId).catch(() => {});
  await focusOrOpenSettings(intent.settingsTabId);
  return true;
}

async function cancelLogoSelectorSession(tabId, sessionId = undefined) {
  const session = await selectorSessions.end(tabId, sessionId);
  if (session === null) return;
  if (session.closeTabOnComplete) {
    await chrome.tabs.remove(tabId);
    if (session.settingsTabId !== undefined) {
      await chrome.tabs.update(session.settingsTabId, { active: true }).catch(() => {});
    }
  } else {
    // Issue #90: cancelling an add-flow selection flushes the whole attempt —
    // ending the session above already dropped everything it held — and the
    // unknown banner puts the user back where "Add to trusted" started.
    await sendToTab(tabId, {
      type: "show_banner",
      verdict: "unknown",
      data: { fqdn: session.add?.origin?.sourceUrl ?? session.fqdn },
    });
  }
}

// Issue #22: this used to tell the settings page its card was ready with
// chrome.tabs.sendMessage. That API delivers to a tab's content scripts, not to
// an extension page, so the refresh it asked for was never guaranteed to happen
// and the user could come back to a card still showing the previous logo. The
// selection is already committed to chrome.storage.local by the time this runs,
// and the settings page renders from chrome.storage.onChanged, so putting that
// page back in front of the user is all this has left to do.
async function focusOrOpenSettings(settingsTabId) {
  if (settingsTabId !== undefined) {
    try {
      await chrome.tabs.get(settingsTabId);
      await chrome.tabs.update(settingsTabId, { active: true });
      return;
    } catch {
      // Settings tab was closed — fall through to open a new one
    }
  }
  await chrome.tabs.create({ url: SETTINGS_PAGE_URL, active: true });
}

async function sendToTab(tabId, message) {
  if (tabId === undefined) return undefined;
  return chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

// =============================================================================
// ACTION ICON FEEDBACK — issue #15 (requested from the popup since issue #51)
//
// A click used to be fire-and-forget: manual_trigger went to the active tab
// and any failure to deliver it was swallowed, so a restricted page, a tab
// with no content script, and a click the content script chose to ignore all
// looked identical -- nothing happened. Now every click resolves to exactly
// one of five outcomes (three reported by content.js, two decided here when
// nothing answered) and each one is acknowledged on the icon, the only UI
// this extension controls on a page it cannot touch.
//
// The acknowledgement is transient: it holds for ACTION_FEEDBACK_DURATION_MS
// and then the icon reverts to the tab's durable analysis state, so a click's
// answer can never be mistaken for a verdict. Feedback is also dropped early
// when the tab reports new analysis state or navigates away.
// =============================================================================

const DEFAULT_ACTION_TITLE = chrome.runtime.getManifest().action?.default_title ?? "Yodel Phish";

// Last state each tab reported via set_icon_state, so a transient feedback
// badge knows what to revert to. Only ever read by a revert running in the
// same service-worker lifetime that recorded it: if the worker is torn down,
// the pending revert dies with the map and the content script re-asserts the
// state on its next message.
const iconStates = new Map();
const actionFeedbackTimers = new Map();
const actionFeedbackVersions = new Map();

// Issue #51: the action button opens the popup, so chrome.action.onClicked no
// longer fires -- a manual analysis is now requested by the popup for the tab
// it was opened over. Everything the icon does with the answer is unchanged;
// the popup shows the same answer in words.
async function runManualAnalysis(tabId) {
  const requestVersion = nextActionFeedbackVersion(tabId);
  cancelActionFeedback(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  let outcome;
  if (tab === null) outcome = ACTION_OUTCOMES.DELIVERY_FAILED;
  else if (!await isAnalysableTabUrl(tab.url)) outcome = ACTION_OUTCOMES.UNSUPPORTED_PAGE;
  else outcome = await deliverManualTrigger(tabId);
  if (actionFeedbackVersions.get(tabId) === requestVersion) await showActionFeedback(tabId, outcome);
  return outcome;
}

async function isAnalysableTabUrl(url) {
  return isAnalysablePageUrl(url, isFileUrl(url) ? await isFileScanPermitted() : true);
}

// Delivers a manual trigger and reduces the round trip to a single outcome.
// A rejected sendMessage (no receiver, restricted frame, tab gone mid-flight)
// and a response this build does not recognize are both delivery failures --
// see classifyManualTriggerResponse.
async function deliverManualTrigger(tabId) {
  try {
    return classifyManualTriggerResponse(await chrome.tabs.sendMessage(tabId, { type: "manual_trigger" }));
  } catch {
    return ACTION_OUTCOMES.DELIVERY_FAILED;
  }
}

async function showActionFeedback(tabId, outcome) {
  const feedback = actionFeedbackFor(outcome);
  cancelActionFeedback(tabId);
  stopIconAnimation(tabId); // transient feedback owns the badge until revert
  const timer = setTimeout(() => {
    void revertActionFeedback(tabId);
  }, ACTION_FEEDBACK_DURATION_MS);
  actionFeedbackTimers.set(tabId, timer);
  try {
    const updates = [];
    if (feedback.badge !== null) {
      updates.push(chrome.action.setBadgeText({ tabId, text: feedback.badge.text }));
      updates.push(chrome.action.setBadgeBackgroundColor({ tabId, color: feedback.badge.color }));
    }
    updates.push(chrome.action.setTitle({ tabId, title: feedback.title }));
    await Promise.all(updates);
  } catch {
    if (actionFeedbackTimers.get(tabId) === timer) cancelActionFeedback(tabId);
    return; // Tab closed or navigated away mid-click — nothing left to inform.
  }
}

function nextActionFeedbackVersion(tabId) {
  const version = (actionFeedbackVersions.get(tabId) ?? 0) + 1;
  actionFeedbackVersions.set(tabId, version);
  return version;
}

function invalidateActionFeedback(tabId) {
  nextActionFeedbackVersion(tabId);
  cancelActionFeedback(tabId);
  iconStates.delete(tabId);
  void applyIconState(tabId, undefined).catch(() => {
    // The tab may have closed while its navigation event was being handled.
  });
}

// Drops a pending revert without touching the icon — for callers that are
// about to write the icon themselves. Reports whether there was one, since
// only then is there feedback on screen to take over from.
function cancelActionFeedback(tabId) {
  const timer = actionFeedbackTimers.get(tabId);
  if (timer === undefined) return false;
  clearTimeout(timer);
  actionFeedbackTimers.delete(tabId);
  return true;
}

// Performs the revert: title back to the manifest default, badge back to the
// tab's durable analysis state. A no-op when this tab has no feedback
// showing, so ordinary events never disturb an icon no click has touched.
async function revertActionFeedback(tabId) {
  if (!cancelActionFeedback(tabId)) return;
  try {
    await applyIconState(tabId, iconStates.get(tabId));
  } catch {
    // Tab is gone; its per-tab icon state went with it.
  }
}

// `stored` is the {state, title} recorded by set_icon_state (or undefined for
// the idle default). The title is the banner text, so hovering the icon reads
// the same message as the banner (issue #3).
async function applyIconState(tabId, stored) {
  stopIconAnimation(tabId);
  const badge = badgeForIconState(stored?.state);
  const frames = ICON_STATE_ANIMATIONS[stored?.state];
  await chrome.action.setBadgeText({ tabId, text: frames?.[0] ?? badge.text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
  await chrome.action.setTitle({ tabId, title: stored?.title ?? DEFAULT_ACTION_TITLE });
  if (frames !== undefined) startIconAnimation(tabId, frames);
}

// Animated badges (issue #3). A setInterval dies with the MV3 worker; the last
// written frame then simply stays up, which is an acceptable static fallback.
const ICON_ANIMATION_INTERVAL_MS = 500;
const iconAnimationTimers = new Map();

function startIconAnimation(tabId, frames) {
  let frame = 0;
  const timer = setInterval(() => {
    frame = (frame + 1) % frames.length;
    chrome.action.setBadgeText({ tabId, text: frames[frame] })
      .catch(() => stopIconAnimation(tabId));
  }, ICON_ANIMATION_INTERVAL_MS);
  iconAnimationTimers.set(tabId, timer);
}

function stopIconAnimation(tabId) {
  const timer = iconAnimationTimers.get(tabId);
  if (timer === undefined) return;
  clearInterval(timer);
  iconAnimationTimers.delete(tabId);
}
