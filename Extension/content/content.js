// =============================================================================
// STATE
// =============================================================================

let alreadyAnalysing = false;
let dismissed = false;
let bannerEl = null;
// State needed to update one banner in place and coordinate delayed progress
// with screenshot capture.
let bannerState = null;
let progressTimer = null;
let bannerHiddenForCapture = false;
// Set from the moment an analysis starts until its screenshot is done, so no
// banner is painted into the window where it would have to be hidden again for
// the capture (issue #77) -- neither the progress banner nor the provisional
// trusted verdict.
let capturePending = false;
const transientExtensionRoots = new WeakSet();
let submissionBlocker = null;
let analysisMode = null;
let interruptionPending = false;
let currentJobId = null;
let analysisAttempted = false;
let analysisDeadlineHandle = null;
let deviceFlowActive = false;
let deviceFlowProvider = null;

const CONTENT_JOB_TIMEOUT_MS = 290_000;

let evaluationScheduled = false;

// =============================================================================
// LOGIN PAGE DETECTION
// Lightweight — runs on every page and on every DOM change. The heuristic
// itself lives in the shared login-detector.js module (loaded before this
// script; issue #11): fixed patterns with fixed confidences instead of an
// additive score. This wrapper only binds it to the live page.
// =============================================================================

const loginDetector = globalThis.YodelLoginDetector;

function detectLoginPage() {
  // Discovering open Shadow roots is part of every scan (issue #88): the
  // detector already walks into them, and the same moment is when a newly
  // created root must be handed to the mutation observer.
  observeOpenShadowRoots();
  return loginDetector.detectLoginPage(document, window);
}

// =============================================================================
// MUTATION OBSERVER — discover dynamically injected login forms.
//
// DOM changes only schedule the cheap login detector when no analysis is in
// flight. They never cancel or invalidate an analysis: modern pages routinely
// mutate banners, carousels, ads and framework-owned DOM while a screenshot is
// being processed. One non-resetting timer prevents continuous churn from
// postponing discovery indefinitely.
// =============================================================================

function scheduleEvaluation() {
  if (evaluationScheduled) return; // non-resetting: never postponed, never a 2nd timer
  evaluationScheduled = true;
  setTimeout(runChangeEvaluation, 200);
}

function runChangeEvaluation() {
  evaluationScheduled = false; // from here, one more evaluation may be scheduled
  // Device-flow risk (issue #39) is decided purely from the URL and does not
  // change with the DOM, so a mutation must never restart the normal pipeline
  // while it is active -- that could otherwise surface a trusted/"Safe." banner.
  if (alreadyAnalysing || interruptionPending || deviceFlowActive) return;

  if (!bannerEl) {
    if (dismissed) dismissed = false;
    const result = detectLoginPage();
    if (!result.isLogin) return;
    handleLoginDetected();
    return;
  }

  offerReanalysis();
}

// The first login surface found on a page starts exactly one analysis; once an
// analysis has been attempted, a later one only offers a re-analysis. Shared
// with child-frame reports (issue #88), so several frames rendering login UIs
// at the same time can never create concurrent or superseding jobs.
function handleLoginDetected() {
  if (!analysisAttempted) {
    triggerPipeline();
  } else {
    showBanner("page_changed", {});
  }
}

// A verdict the user can still act on stays on screen, but the page changed
// underneath it, so the re-analyse control is revealed.
function offerReanalysis() {
  const verdict = bannerEl.dataset.verdict;
  if (verdict !== "unknown" && verdict !== "suspicious") return;

  const reanalyseBtn = bannerEl.querySelector(".yp-btn-reanalyse");
  if (reanalyseBtn?.hidden) {
    reanalyseBtn.hidden = false;
    markExtensionMutation(bannerEl);
  }
}

// Observe both visual state and detector metadata. Both sets live in
// login-detector.js beside the heuristic that consumes them. The callback
// ignores extension-owned DOM so updating our own banner cannot schedule a
// loop.
const VISUAL_ATTRS = new Set(loginDetector.VISUAL_ATTRIBUTES);
const DETECTION_ATTRS = new Set(loginDetector.DETECTION_ATTRIBUTES);

const OBSERVER_OPTIONS = {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: [...VISUAL_ATTRS, ...DETECTION_ATTRS],
};

const observer = new MutationObserver((mutations) => {
  if (hasPageMutation(mutations)) scheduleEvaluation();
});
observer.observe(document.body, OBSERVER_OPTIONS);

// A MutationObserver on document.body never reports anything that happens
// inside a Shadow root, so every discovered open root is observed as well
// (issue #88). Discovery runs immediately before each scan: a host and its
// open root are created in the same JavaScript task, so the light-DOM mutation
// that added the host is exactly what brings us here.
//
// Closed roots are invisible (`shadowRoot` is null) and stay unsupported, as
// does a root attached to a long-existing host without any other document
// mutation -- neither is worth polling or patching attachShadow() for.
const observedShadowRoots = new WeakSet();

function observeOpenShadowRoots() {
  for (const shadow of loginDetector.collectOpenShadowRoots(document)) {
    if (!observedShadowRoots.has(shadow)) {
      observedShadowRoots.add(shadow);
      observer.observe(shadow, OBSERVER_OPTIONS);
    }
  }
}

// History API changes made by the page run in a different JavaScript world.
// The service worker observes them through chrome.webNavigation and forwards
// page_history_changed to this content script.
//
// Iframes are not watched from here at all: a parent document cannot read a
// sandboxed or cross-origin child, so each frame runs its own detector copy
// and reports through the service worker instead (see content/login-frame.js).
window.addEventListener("popstate", scheduleEvaluation);
window.addEventListener("hashchange", scheduleEvaluation);

// =============================================================================
// PIPELINE TRIGGER
// =============================================================================

function clearAnalysisDeadline() {
  if (analysisDeadlineHandle !== null) {
    clearTimeout(analysisDeadlineHandle);
    analysisDeadlineHandle = null;
  }
}

function armAnalysisDeadline(jobId) {
  clearAnalysisDeadline();
  analysisDeadlineHandle = setTimeout(() => {
    analysisDeadlineHandle = null;
    if (jobId !== currentJobId || !alreadyAnalysing) return;
    chrome.runtime.sendMessage({ type: "analysis_client_timed_out", jobId }).catch(() => {});
    enterFailedState(jobId, "client_timeout");
  }, CONTENT_JOB_TIMEOUT_MS);
  analysisDeadlineHandle?.unref?.();
}

function isCurrentJobMessage(message) {
  return typeof message.jobId === "string" && message.jobId === currentJobId;
}

// File pages host the same protections as ordinary web pages when Chrome has
// granted the extension file access. Without that grant this content script is
// not injected, so no separate settings gate is needed here.
function isAutomaticallyAnalysablePage() {
  return window.location.protocol === "http:" ||
    window.location.protocol === "https:" ||
    window.location.protocol === "file:";
}

// Both dispatch calls below handle two distinct failure shapes the same way:
// an explicit { error } response (the generic onMessage wrapper in
// service_worker.js reports a handler that threw) and a *rejected*
// sendMessage promise (e.g. the service worker was asleep or torn down
// mid-request, so the message channel itself never delivered). Without this,
// either case left the page stuck in "analysing" forever with no recovery
// short of a reload -- the terminal analysis_failed message from the
// background covers everything that fails *after* dispatch succeeds; this
// covers dispatch itself failing.
function analysisProgressVerdict() {
  if (analysisMode === "add_to_trusted") return "adding_to_trusted";
  if (analysisMode === "manual_detection") return "analysing_manual";
  return "analysing";
}

function triggerPipeline({ userInitiated = false } = {}) {
  if (!userInitiated && !isAutomaticallyAnalysablePage()) return;
  if (alreadyAnalysing) return;
  alreadyAnalysing = true;
  analysisAttempted = true;
  const jobId = crypto.randomUUID();
  currentJobId = jobId;
  analysisMode = userInitiated ? "manual_detection" : "detection";
  capturePending = true;
  armAnalysisDeadline(jobId);
  blockFormSubmission();
  setIconState("analysing", bannerMessageFor(analysisProgressVerdict(), {}));
  showBanner(analysisProgressVerdict(), {});
  chrome.runtime.sendMessage({ type: "run_pipeline", jobId })
    .then((response) => {
      if (response?.error) enterFailedState(jobId, response.code ?? "analysis_failed");
    })
    .catch(() => {
      enterFailedState(jobId, "dispatch_failed");
    });
}

function triggerTrustedAdd() {
  if (alreadyAnalysing) return;
  alreadyAnalysing = true;
  analysisAttempted = true;
  const jobId = crypto.randomUUID();
  currentJobId = jobId;
  analysisMode = "add_to_trusted";
  capturePending = true;
  armAnalysisDeadline(jobId);
  blockFormSubmission();
  setIconState("analysing", bannerMessageFor("adding_to_trusted", {}));
  showBanner("adding_to_trusted", {});
  chrome.runtime.sendMessage({ type: "add_to_trusted", jobId })
    .then((response) => {
      if (response?.error) enterFailedState(jobId, response.code ?? "analysis_failed");
    })
    .catch(() => {
      enterFailedState(jobId, "dispatch_failed");
    });
}

// =============================================================================
// MANUAL TRIGGER — fired by extension icon click (from service worker)
// =============================================================================

// Every manual trigger answers with an explicit status, so the service worker
// can tell the three "the click was handled here" outcomes apart from each
// other -- and, crucially, from a click that never reached this script at all
// (restricted page, no content script, messaging failure), which is what an
// absent or unrecognized response now means to the caller. Without this, an
// ignored click and an undeliverable one were indistinguishable on both ends.
//
//   analysing      -- a job is already in flight; the click changes nothing,
//                     and this state is deliberately left untouched rather
//                     than restarted or re-rendered.
//   device_flow_active -- the higher-priority device-code warning stays active.
//   started        -- a new job is now in flight.
function handleManualTrigger() {
  if (alreadyAnalysing) return { ok: true, status: "analysing", jobId: currentJobId };
  if (deviceFlowActive) {
    if (!bannerEl) activateDeviceFlowAdvisory(deviceFlowProvider);
    return { ok: true, status: "device_flow_active" };
  }

  dismissed = false;
  interruptionPending = false;

  // Explicit user intent bypasses only the automatic login-page heuristic.
  // URL support, device-flow priority, delivery errors, and the single-job
  // guard remain enforced by their existing owners.
  triggerPipeline({ userInitiated: true });
  return { ok: true, status: "started", jobId: currentJobId };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "prepare_capture") {
    preparePageForCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "capture_complete") {
    bannerHiddenForCapture = false;
    capturePending = false;
    if (bannerEl) {
      bannerEl.style.removeProperty("visibility");
      markExtensionMutation(bannerEl);
    }
    if (alreadyAnalysing) {
      // The capture is what releases a held-back banner. A trusted refresh has
      // its verdict already ("trusted_drift" is only ever entered for it); every
      // other mode is still working and shows progress.
      showBanner(analysisMode === "trusted_drift" ? "trusted" : analysisProgressVerdict(), {});
    }
    return false;
  }

  if (message.type === "page_history_changed") {
    const status = message.deviceFlow;
    if (status?.active === true) {
      activateDeviceFlowAdvisory(status.provider);
      return false;
    }
    if (status?.active === false && deviceFlowActive) deactivateDeviceFlowAdvisory();
    scheduleEvaluation();
    return false;
  }

  // Issue #88: a child frame reported that its own document became a login
  // page. The frame owns nothing -- the job, the capture, the banners, form
  // blocking and the icon all stay bound to this top document and its URL.
  // Only the lifecycle decision is shared with top-document detection, which
  // is what keeps simultaneous reports from several frames down to one job.
  if (message.type === "embedded_login_detected") {
    if (alreadyAnalysing || interruptionPending || deviceFlowActive) return false;
    if (bannerEl) {
      offerReanalysis();
      return false;
    }
    dismissed = false;
    handleLoginDetected();
    return false;
  }

  if (message.type === "manual_trigger") {
    sendResponse(handleManualTrigger());
    return false;
  }

  if (message.type === "show_banner") {
    if (deviceFlowActive) {
      sendResponse({ accepted: false, reason: "device_flow_active" });
      return false;
    }
    if (message.jobId !== undefined && message.jobId !== currentJobId) {
      sendResponse({ accepted: false, reason: "stale_job" });
      return false;
    }
    if (message.provisional === true) {
      alreadyAnalysing = true;
      analysisMode = "trusted_drift";
      unblockFormSubmission();
      setIconState(iconStateForVerdict(message.verdict), bannerMessageFor(message.verdict, message.data ?? {}));
      // The verdict is decided before the analysis runs, but the screenshot is
      // still owed: painting now only means hiding it again for the capture,
      // which the user reads as two banners (issue #77). capture_complete paints
      // it. Releasing the form and the icon does not wait -- neither of those
      // ends up in the screenshot.
      if (!capturePending) showBanner(message.verdict, message.data ?? {});
      sendResponse({ accepted: true });
      return false;
    }
    clearAnalysisDeadline();
    alreadyAnalysing = false;
    dismissed = false;
    analysisMode = null;
    interruptionPending = false;
    currentJobId = null;
    unblockFormSubmission();
    setIconState(iconStateForVerdict(message.verdict), bannerMessageFor(message.verdict, message.data ?? {}));
    showBanner(message.verdict, message.data ?? {});
    sendResponse({ accepted: true });
    return false;
  }

  if (message.type === "cancel_analysis") {
    if (deviceFlowActive) return false;
    clearAnalysisDeadline();
    alreadyAnalysing = true;
    unblockFormSubmission();
    removeBanner();
  }

  if (message.type === "analysis_interrupted") {
    if (!isCurrentJobMessage(message)) return false;
    enterInterruptedState(message.jobId);
    return false;
  }

  if (message.type === "analysis_failed") {
    enterFailedState(message.jobId, message.code);
    return false;
  }

  if (message.type === "continue_without_analysis") {
    if (!isCurrentJobMessage(message)) return false;
    clearAnalysisDeadline();
    alreadyAnalysing = false;
    interruptionPending = false;
    currentJobId = null;
    analysisMode = null;
    unblockFormSubmission();
    setIconState("unverified", bannerMessageFor("continued_unverified", {}));
    showBanner("continued_unverified", {});
    sendResponse({ ok: true });
    return false;
  }
});

function enterInterruptedState(jobId) {
  if (typeof jobId !== "string" || jobId !== currentJobId) return false;
  clearAnalysisDeadline();
  alreadyAnalysing = false;
  if (jobId !== undefined) currentJobId = jobId;
  interruptionPending = true;
  blockFormSubmission();
  setIconState("interrupted", bannerMessageFor("interrupted", {}));
  showBanner("interrupted", {});
  return true;
}

// Terminal failure for the current job: a hard error or any timeout (queue
// wait, offscreen request, or whole-job) reported by the background, or a
// dispatch that never reached it in the first place (see triggerPipeline /
// triggerTrustedAdd). Ignored for a job that is no longer current -- an
// older job's failure must never disturb whatever the current job already
// put on screen. Returns whether it actually applied.
function enterFailedState(jobId, code) {
  if (typeof jobId !== "string" || jobId !== currentJobId) return false;
  const retryMode = analysisMode;
  clearAnalysisDeadline();
  alreadyAnalysing = false;
  dismissed = false;
  analysisMode = null;
  interruptionPending = false;
  currentJobId = null;
  unblockFormSubmission();
  setIconState("failed", bannerMessageFor("analysis_failed", { code }));
  showBanner("analysis_failed", { code, retryMode });
  return true;
}

// =============================================================================
// STABLE SCREENSHOT COORDINATION
// =============================================================================

const PAGE_STABILITY_TIMEOUT_MS = 1000;

async function preparePageForCapture() {
  // Two different things happen here, and they are deliberately not at the same
  // moment. The flag is raised now so that anything rendered during the wait is
  // born hidden -- a banner that appeared mid-wait and was then hidden for the
  // screenshot is read as two banners (issue #77). A banner that is *already*
  // on screen is hidden only at the last moment instead, so a verdict the user
  // is currently reading (the previous one, when they press Re-analyse)
  // disappears for the capture alone rather than for the whole stability wait.
  bannerHiddenForCapture = true;
  try {
    await waitForPageStability(PAGE_STABILITY_TIMEOUT_MS);
  } finally {
    if (bannerEl) {
      bannerEl.style.visibility = "hidden";
      markExtensionMutation(bannerEl);
    }
    await waitForAnimationFrames(2);
  }
}

async function waitForPageStability(timeoutMs) {
  const resourceWaitMs = Math.round(timeoutMs * 0.7);
  const waits = [];

  if (document.fonts?.ready) {
    waits.push(Promise.resolve(document.fonts.ready).catch(() => undefined));
  }
  for (const image of document.images) {
    if (typeof image.decode === "function") {
      waits.push(image.decode().catch(() => undefined));
    }
  }
  for (const animation of document.getAnimations?.() ?? []) {
    const endTime = animation.effect?.getComputedTiming?.().endTime;
    if (animation.playState === "running" && Number.isFinite(endTime)) {
      waits.push(animation.finished.catch(() => undefined));
    }
  }

  if (waits.length > 0) {
    await Promise.race([Promise.allSettled(waits), delay(resourceWaitMs)]);
  }
  await waitForStableLayout(Math.max(0, timeoutMs - resourceWaitMs));
}

async function waitForStableLayout(timeoutMs) {
  const started = performance.now();
  let previous = "";
  let stableFrames = 0;
  while (performance.now() - started < timeoutMs) {
    await waitForAnimationFrames(1);
    const bodyRect = document.body.getBoundingClientRect();
    const current = [
      document.documentElement.scrollWidth,
      document.documentElement.scrollHeight,
      Math.round(bodyRect.width),
      Math.round(bodyRect.height),
    ].join(":");
    stableFrames = current === previous ? stableFrames + 1 : 0;
    if (stableFrames >= 2) return;
    previous = current;
  }
}

function waitForAnimationFrames(count) {
  return new Promise((resolve) => {
    const next = () => {
      count -= 1;
      if (count <= 0) {
        resolve();
      } else {
        requestAnimationFrame(next);
      }
    };
    requestAnimationFrame(next);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// BANNER
// =============================================================================

const ANALYSIS_FAILURE_MESSAGES = Object.freeze({
  queue_overloaded: "Analysis is busy because too many pages are waiting.",
  queue_wait_timeout: "Analysis could not start before the queue deadline.",
  request_timeout: "The local inference request timed out.",
  runtime_startup_timeout: "The local analysis runtime could not start in time.",
  offscreen_round_trip_timeout: "The local analysis runtime stopped responding.",
  offscreen_control_timeout: "The local analysis runtime could not be stopped cleanly.",
  job_timeout: "Analysis exceeded its overall time limit.",
  client_timeout: "Analysis did not finish before the page deadline.",
  dispatch_failed: "The extension background process could not be reached.",
  interruption_unavailable: "Analysis was interrupted and the recovery tab could not be opened.",
  analysis_failed: "Analysis could not be completed.",
});

function analysisFailureMessage(code) {
  return ANALYSIS_FAILURE_MESSAGES[code] ?? ANALYSIS_FAILURE_MESSAGES.analysis_failed;
}

// Banner text size chosen in settings (issue #3). storage.local is restricted
// to trusted contexts, so the value travels by message: the cached size is
// applied synchronously on render and refreshed in the background.
let bannerFontSize = "small";

function refreshBannerFontSize() {
  chrome.runtime.sendMessage({ type: "get_banner_font_size" })
    .then((response) => {
      const size = response?.size;
      if (size !== "small" && size !== "medium" && size !== "large") return;
      bannerFontSize = size;
      if (bannerEl) bannerEl.dataset.fontSize = size;
    })
    .catch(() => {});
}

// Verdict icons drawn as inline SVG rather than text symbols like "ⓘ"/"✗",
// which depend on the page's font and render inconsistently. Each is filled
// with currentColor, so it picks up the verdict's own text color, and sized in
// em so it follows the banner text size.
const BANNER_ICONS = {
  info: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
  error: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`,
  muted: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.9 8.9 0 0 0 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4 9.91 6.09 12 8.18V4z"/></svg>`,
  // Progress states get a spinner that actually turns, so a long analysis
  // reads as running rather than stuck.
  spinner: `<svg class="yp-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity="0.35"/><path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round"/></svg>`,
};

const BANNER_CONFIG = {
  // Preparation and analysis share one progress presentation. Informational
  // progress banners are blue with light text (issue #68) — the previous
  // near-white background matched the light text and made them unreadable.
  analysing: {
    color:   "var(--yp-blue)",
    icon:    "spinner",
    message: "Login detected, Yodel-Phish Analysis in progress",
    buttons: [],
  },
  analysing_manual: {
    color:   "var(--yp-blue)",
    icon:    "spinner",
    message: "Manual analysis in progress…",
    buttons: [],
  },
  adding_to_trusted: {
    color:   "var(--yp-blue)",
    icon:    "spinner",
    message: "Adding this site to your trusted list…",
    buttons: [],
  },
  trusted: {
    color:   "var(--yp-green)",
    icon:    "check",
    message: "Safe.",
    buttons: [],
  },
  // Issue #62: the verdict word stands on its own line, the reason follows, and
  // the one sentence the user has to act on is underlined. The hostname is
  // named inside that sentence rather than parenthesized after it, so what the
  // user is being asked to recognize is part of the instruction.
  unknown: {
    color:   "var(--yp-white)",
    icon:    "info",
    message: (data) => {
      const site = data.fqdn ?? "this website";
      return [
        "Unknown.",
        { text: "This site is not on your trusted list. ", newLine: true },
        { text: "Only enter your credentials if you know and trust ", underline: true },
        // The hostname is the one thing the user actually has to recognize, so
        // it carries the emphasis inside the underlined instruction. The
        // stand-in used when no hostname was resolved names nothing, so it is
        // not emphasized.
        { text: site, underline: true, bold: site === data.fqdn },
        { text: ".", underline: true },
      ];
    },
    buttons: ["add", "mute", "close", "re-analyse"],
  },
  suspicious: {
    color:   "var(--yp-orange)",
    icon:    "warning",
    message: (data) => `Warning. Potential risk detected. Ask your IT team before entering your credentials on ${data.fqdn ?? "this site"}.`,
    buttons: ["add", "mute", "close", "re-analyse"],
  },
  added_confirmation: {
    color:   "var(--yp-green)",
    icon:    "check",
    message: (data) => `${data.fqdn ?? "This site"} has been added to your trusted list.`,
    buttons: ["close-x"],
  },
  muted_confirmation: {
    color:   "var(--yp-grey)",
    icon:    "muted",
    message: (data) => `${data.fqdn ?? "This site"} has been muted.`,
    buttons: ["close-x"],
  },
  muted: {
    color:   "var(--yp-grey)",
    icon:    "muted",
    message: "This site is muted.",
    buttons: ["close-x"],
  },
  // Issue #19: not dismissible -- submission stays blocked until a decision.
  interrupted: {
    color:   "var(--yp-grey)",
    icon:    "info",
    message: "Analysis interrupted because the page changed. Use the warning tab to re-analyse, continue unverified, or leave.",
    buttons: [],
  },
  continued_unverified: {
    color:   "var(--yp-orange)",
    icon:    "warning",
    message: "Analysis was bypassed. This page has not been verified.",
    buttons: ["close-x"],
  },
  page_changed: {
    color:   "var(--yp-grey)",
    icon:    "info",
    message: "The page changed after the previous check. Re-analyse when you are ready.",
    buttons: ["re-analyse-visible", "close-x"],
  },
  analysis_failed: {
    color:   "var(--yp-orange)",
    icon:    "error",
    message: (data) => analysisFailureMessage(data.code) + " You can try again.",
    buttons: ["retry", "close-x"],
  },
  // Issue #39 — never "Safe.", overrides trusted/muted, no add/mute controls.
  // Dismissible for this navigation only: reappears on the next qualifying one.
  high_risk_login: {
    color:   "var(--yp-orange)",
    icon:    "warning",
    message: (data) => [
      `High Risk Device Code Login on the official ${data.provider ?? "provider"} page.`,
      { text: "Never use a code sent by phone, SMS, email, chat, support, or another website.", bold: true, newLine: true },
      { text: "Only enter the code if you started the sign-in on a device or app you control.", bold: true, underline: true, newLine: true },
    ],
    buttons: ["close-x"],
  },
};

// A message is either a plain string or a list of segments, so a verdict can
// emphasize part of its text. Segments are rendered as real <strong>/<u>
// elements whose text is always written with textContent -- interpolated
// values (fqdn, provider, failure codes) can therefore never inject markup.
function bannerMessageParts(verdict, data) {
  const config = BANNER_CONFIG[verdict];
  if (!config) return [];
  const message = typeof config.message === "function" ? config.message(data) : config.message;
  return Array.isArray(message) ? message : [message];
}

// The flat text: used for the state key and for the icon tooltip, which shows
// the banner's wording and cannot carry emphasis. A segment's line break
// survives as a newline, which the icon tooltip does render.
function bannerMessageFor(verdict, data) {
  return bannerMessageParts(verdict, data)
    .map((part) => (typeof part === "string" ? part : (part.newLine ? "\n" : "") + part.text))
    .join("");
}

function renderBannerMessage(messageEl, parts) {
  messageEl.textContent = "";
  for (const part of parts) {
    if (typeof part === "string") {
      messageEl.append(part);
      continue;
    }
    if (part.newLine) messageEl.appendChild(document.createElement("br"));
    let node = document.createTextNode(part.text);
    if (part.underline) {
      const underlined = document.createElement("u");
      underlined.appendChild(node);
      node = underlined;
    }
    if (part.bold) {
      const emphasized = document.createElement("strong");
      emphasized.appendChild(node);
      node = emphasized;
    }
    messageEl.appendChild(node);
  }
}

// Progress is the only delayed presentation. Every other state renders now and
// cancels any pending progress update.
const PROGRESS_VERDICTS = new Set(["analysing", "analysing_manual", "adding_to_trusted"]);
const PROGRESS_DELAY_MS = 250;
// While a capture is pending, progress waits for capture_complete instead: it
// is the screenshot, not this delay, that decides when the banner may first be
// seen. The value is only a floor for a capture that never reports back (a
// worker that died mid-analysis) -- past it, showing progress beats showing
// nothing until the job deadline. It clears PAGE_STABILITY_TIMEOUT_MS plus the
// capture round trip, so a healthy capture always answers first.
const CAPTURE_PROGRESS_DELAY_MS = 2_000;

function showBanner(verdict, data) {
  const config = BANNER_CONFIG[verdict];
  if (!config) return;
  const message = bannerMessageFor(verdict, data);
  const state = `${verdict}\n${message}\n${data.retryMode ?? ""}`;

  clearProgressTimer();
  // Any other state ends the capture window: those paths either already
  // captured or never will, and must never be held back.
  if (!PROGRESS_VERDICTS.has(verdict)) capturePending = false;
  if (bannerEl !== null && state === bannerState) return;

  if (PROGRESS_VERDICTS.has(verdict)) {
    progressTimer = setTimeout(() => {
      progressTimer = null;
      renderBanner(verdict, config, data, message, state);
    }, capturePending ? CAPTURE_PROGRESS_DELAY_MS : PROGRESS_DELAY_MS);
    progressTimer?.unref?.();
    return;
  }
  renderBanner(verdict, config, data, message, state);
}

function clearProgressTimer() {
  if (progressTimer === null) return;
  clearTimeout(progressTimer);
  progressTimer = null;
}

function renderBanner(verdict, config, data, message, state) {
  // Avoid replacing buttons that are already in the correct state.
  if (bannerEl !== null && state === bannerState) return;
  bannerState = state;

  if (bannerEl === null) {
    bannerEl = document.createElement("div");
    bannerEl.id = "yp-banner";
    bannerEl.setAttribute("role", "status");
    document.body.prepend(bannerEl);
  }

  // A state rendered during capture must not appear in the screenshot.
  bannerEl.style.visibility = bannerHiddenForCapture ? "hidden" : "";
  bannerEl.setAttribute("data-verdict", verdict);
  bannerEl.dataset.fontSize = bannerFontSize;
  refreshBannerFontSize();
  bannerEl.style.setProperty("--yp-bg", config.color);

  // Replacing the children removes all state-specific buttons and listeners.
  bannerEl.innerHTML = `
    <div class="yp-inner">
      <span class="yp-brand">Yodel Phish</span>
      <span class="yp-icon">${BANNER_ICONS[config.icon] ?? BANNER_ICONS.info}</span>
      <span class="yp-message"></span>
      <div class="yp-actions">
        ${config.buttons.includes("add")       ? `<button class="yp-btn yp-btn-add">Add to trusted list</button>` : ""}
        ${config.buttons.includes("mute")      ? `<button class="yp-btn yp-btn-mute">Mute forever</button>` : ""}
        ${config.buttons.includes("close")     ? `<button class="yp-btn yp-btn-close">Close</button>` : ""}
        ${config.buttons.includes("close-x")   ? `<button class="yp-btn yp-btn-close-x" aria-label="Close" title="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg></button>` : ""}
        ${config.buttons.includes("re-analyse") ? `<button class="yp-btn yp-btn-reanalyse" hidden>Re-analyse</button>` : ""}
        ${config.buttons.includes("re-analyse-visible") ? `<button class="yp-btn yp-btn-reanalyse">Re-analyse</button>` : ""}
        ${config.buttons.includes("retry")       ? `<button class="yp-btn yp-btn-retry">Retry</button>` : ""}
      </div>
    </div>
  `;
  const messageEl = bannerEl.querySelector(".yp-message");
  if (messageEl !== null) renderBannerMessage(messageEl, bannerMessageParts(verdict, data));

  bannerEl.querySelector(".yp-btn-add")?.addEventListener("click", () => {
    if (!confirm("Add this site to your trusted list?")) return;
    triggerTrustedAdd();
  });

  bannerEl.querySelector(".yp-btn-mute")?.addEventListener("click", () => {
    if (!confirm("Mute this site forever? You will no longer see warnings for it.")) return;
    chrome.runtime.sendMessage({ type: "add_to_muted", muted_until: "forever" });
    removeBanner();
  });

  bannerEl.querySelectorAll(".yp-btn-close, .yp-btn-close-x").forEach((btn) => {
    btn.addEventListener("click", () => {
      dismissed = true;
      removeBanner();
    });
  });

  bannerEl.querySelector(".yp-btn-reanalyse")?.addEventListener("click", () => {
    unblockFormSubmission();
    triggerPipeline({ userInitiated: true });
  });

  bannerEl.querySelector(".yp-btn-retry")?.addEventListener("click", () => {
    if (data.retryMode === "add_to_trusted") {
      triggerTrustedAdd();
    } else {
      triggerPipeline({ userInitiated: true });
    }
  });

  if (PROGRESS_VERDICTS.has(verdict)) {
    startProgressNote();
  } else {
    stopProgressNote();
  }

  markExtensionMutation(bannerEl);
}

// Long analyses (e.g. when no logo is detected quickly) look stalled behind a
// static message. After a few seconds the progress banner grows a live note
// with the elapsed time, so the user can see the analysis is still moving.
const PROGRESS_NOTE_AFTER_MS = 3_000;
const PROGRESS_NOTE_STILL_AFTER_MS = 6_000;
const PROGRESS_NOTE_LONG_AFTER_MS = 10_000;
let progressNoteTimer = null;
let progressNoteStartedAt = 0;

function startProgressNote() {
  if (progressNoteTimer !== null) return; // keep the original start across re-renders
  progressNoteStartedAt = Date.now();
  progressNoteTimer = setInterval(updateProgressNote, 1_000);
  progressNoteTimer?.unref?.();
}

function stopProgressNote() {
  if (progressNoteTimer === null) return;
  clearInterval(progressNoteTimer);
  progressNoteTimer = null;
}

function updateProgressNote() {
  const messageEl = bannerEl?.querySelector(".yp-message");
  if (!messageEl) return;
  const elapsedMs = Date.now() - progressNoteStartedAt;
  if (elapsedMs < PROGRESS_NOTE_AFTER_MS) return;
  let note = messageEl.querySelector(".yp-progress-note");
  if (!note) {
    note = document.createElement("span");
    note.className = "yp-progress-note";
    messageEl.appendChild(note);
    markExtensionMutation(bannerEl);
  }
  const seconds = Math.round(elapsedMs / 1000);
  if (elapsedMs < PROGRESS_NOTE_STILL_AFTER_MS) {
    note.textContent = `Working… (${seconds}s)`;
  } else if (elapsedMs < PROGRESS_NOTE_LONG_AFTER_MS) {
    note.textContent = `Still analysing… (${seconds}s)`;
  } else {
    note.textContent = `Still analysing… (${seconds}s) — some checks, like finding the page's logo, take longer on certain pages.`;
  }
}

function removeBanner() {
  clearProgressTimer();
  capturePending = false;
  stopProgressNote();
  const removedBanner = bannerEl;
  removedBanner?.remove();
  if (removedBanner) markExtensionMutation(removedBanner);
  bannerEl = null;
  bannerState = null;
}

// =============================================================================
// FORM SUBMISSION BLOCK (during in-page analysis)
// =============================================================================

function blockFormSubmission() {
  if (submissionBlocker) return;
  const handler = (e) => e.preventDefault();
  document.addEventListener("submit", handler, { capture: true });
  submissionBlocker = handler;
}

function unblockFormSubmission() {
  if (!submissionBlocker) return;
  document.removeEventListener("submit", submissionBlocker, { capture: true });
  submissionBlocker = null;
}

// =============================================================================
// ICON STATE
// Communicates state via badge text on the extension icon.
// =============================================================================

function setIconState(state, title = "") {
  // Content scripts cannot call chrome.action directly — send to background.
  // `title` is the banner text, shown as the icon tooltip (issue #3).
  chrome.runtime.sendMessage({ type: "set_icon_state", state, title }).catch(() => {});
}

// Verdict banners drive a matching badge on the extension icon (issue #3):
// green check for safe, orange "!" for a warning, red cross for phishing.
const VERDICT_ICON_STATES = {
  trusted: "safe",
  added_confirmation: "safe",
  suspicious: "suspicious",
  continued_unverified: "unverified",
  high_risk_login: "device_flow",
};

function iconStateForVerdict(verdict) {
  return VERDICT_ICON_STATES[verdict] ?? "active";
}

// =============================================================================
// UTILS
// =============================================================================

const SKIP_TAGS = new Set(["script", "style", "link", "meta", "noscript"]);
function hasPageMutation(mutations) {
  for (const mutation of mutations) {
    if (isExtensionOwnedNode(mutation.target)) continue;
    if (mutation.type === "characterData") continue;
    if (mutation.type === "attributes") {
      if (VISUAL_ATTRS.has(mutation.attributeName) || DETECTION_ATTRS.has(mutation.attributeName)) return true;
      continue;
    }
    if (mutation.type === "childList") {
      for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (SKIP_TAGS.has(node.tagName.toLowerCase())) continue;
        if (isExtensionOwnedNode(node)) continue;
        return true;
      }
    }
  }
  return false;
}

function markExtensionMutation(root) {
  transientExtensionRoots.add(root);
  queueMicrotask(() => transientExtensionRoots.delete(root));
}

function isExtensionOwnedNode(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  for (let current = node; current !== null; current = current.parentElement) {
    if (transientExtensionRoots.has(current)) return true;
  }
  return false;
}

// =============================================================================
// DEVICE-CODE PHISHING CHECK (issue #39)
//
// Purely URL-based and decided by the service worker before any of this
// file's DOM-based login detection or the visual-model pipeline runs. A
// recognized device-login endpoint always shows this banner instead -- it
// overrides trusted/muted status and is never replaced by "Safe.".
// =============================================================================

function activateDeviceFlowAdvisory(provider) {
  clearAnalysisDeadline();
  alreadyAnalysing = false;
  dismissed = false;
  analysisMode = null;
  interruptionPending = false;
  currentJobId = null;
  unblockFormSubmission();
  deviceFlowActive = true;
  deviceFlowProvider = typeof provider === "string" && provider !== "" ? provider : "this provider";
  setIconState("device_flow", bannerMessageFor("high_risk_login", { provider: deviceFlowProvider }));
  showBanner("high_risk_login", { provider: deviceFlowProvider });
}

function deactivateDeviceFlowAdvisory() {
  if (!deviceFlowActive) return;
  deviceFlowActive = false;
  deviceFlowProvider = null;
  setIconState("active");
  removeBanner();
}

async function checkDeviceFlowStatus() {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "get_device_flow_status" });
  } catch {
    return false; // background unreachable -- fail open, run the normal pipeline
  }
  if (response?.active !== true) return false;
  activateDeviceFlowAdvisory(response.provider);
  return true;
}

// =============================================================================
// INITIAL CHECK ON PAGE LOAD
// =============================================================================

window.addEventListener("pageshow", async (event) => {
  if (!event.persisted) return;

  clearAnalysisDeadline();
  alreadyAnalysing = false;
  dismissed = false;
  analysisMode = null;
  interruptionPending = false;
  currentJobId = null;
  deviceFlowActive = false;
  deviceFlowProvider = null;
  unblockFormSubmission();
  setIconState("active");
  removeBanner();

  if (await checkDeviceFlowStatus()) return;

  const result = detectLoginPage();
  if (result.isLogin) {
    if (analysisAttempted) {
      showBanner("page_changed", {});
    } else {
      triggerPipeline();
    }
  }
});

(async function init() {
  if (await checkDeviceFlowStatus()) return;
  const result = detectLoginPage();
  if (result.isLogin) {
    triggerPipeline();
  }
})();
