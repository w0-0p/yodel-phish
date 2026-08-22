// =============================================================================
// STATE
// =============================================================================

let alreadyAnalysing = false;
let dismissed = false;
// The banner's anonymous light-DOM host and, inside its closed Shadow Root,
// the banner element itself (issue #9). Only the host ever touches the page's
// DOM; everything the banner renders and styles stays behind the shadow
// boundary, out of reach of host-page CSS.
let bannerHostEl = null;
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
// A transparent, full-viewport shield shown while an analysis is in flight so
// the native "progress" cursor (the same busy clock the logo selector uses)
// appears over the page. Because a cursor only renders on an element that takes
// pointer events, the shield necessarily also swallows clicks — which matches
// the banner's "Do not interact with the website" guidance. It is NOT a scroll
// container, so wheel/touch scrolling still reaches the page.
let busyOverlayEl = null;
let submissionBlocker = null;
let analysisMode = null;
let interruptionPending = false;
let currentJobId = null;
let analysisAttempted = false;
let analysisDeadlineHandle = null;
let deviceFlowActive = false;
let deviceFlowProvider = null;
// Issue #14: one progress banner may only ever start one operation. The flag
// is held across the asynchronous ones (the manual-logo request), so repeated
// or competing clicks on the same banner cannot create concurrent flows.
let bannerActionPending = false;
// The actionable verdict the user pressed "Add to trusted" on, so cancelling
// the trusted-site flow can put exactly that banner back (issue #14).
let restorableVerdict = null;
// Issue #24 — cross-domain login handover. A pending handover is not an
// analysis job: it has no job id, no pipeline, no busy overlay and never sets
// alreadyAnalysing. It owns the form blocker and the prompt banner until the
// user decides, the candidate expires, or the navigation context is
// invalidated.
let handoverResolutionPending = false;
let handoverResolutionToken = 0;
let pendingHandover = null;
let handoverExpiryTimer = null;
let handoverActionPending = false;

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
  // A handover lookup or a pending handover prompt equally owns the page
  // (issue #24): login pages churn their DOM while rendering and validating,
  // and none of that is evidence the navigation context changed.
  if (alreadyAnalysing || interruptionPending || deviceFlowActive || hasHandoverState()) return;

  if (!bannerIsMounted()) {
    if (dismissed) dismissed = false;
    const result = detectLoginPage();
    if (!result.isLogin) return;
    handleLoginDetected();
    return;
  }

  offerReanalysis();
}

// The first login surface found on a page starts exactly one handover lookup
// or analysis; once login handling has been attempted, a later one only offers
// a re-analysis. Shared with child-frame reports (issue #88), so several
// frames rendering login UIs at the same time can never create concurrent or
// superseding jobs, and shared with the handover lookup (issue #24), so the
// candidate check always runs before ordinary pipeline dispatch.
function handleLoginDetected() {
  if (!analysisAttempted) {
    beginLoginHandling();
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
  if (reanalyseBtn?.hidden) reanalyseBtn.hidden = false;
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
  // Issue #23: the shield's escape hatch is checked before anything is
  // filtered out. A page removing the banner host is the one mutation that
  // matters most here, and it is also one hasPageMutation() would happily
  // report as an ordinary page change and nothing else would act on.
  ensureShieldHasEscape();
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
  // A new job never inherits the previous one's capture hold (issue #23).
  clearCaptureHold();
  capturePending = true;
  armAnalysisDeadline(jobId);
  blockFormSubmission();
  showBusyOverlay();
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
  clearCaptureHold();
  capturePending = true;
  armAnalysisDeadline(jobId);
  blockFormSubmission();
  showBusyOverlay();
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
// USER-DRIVEN CANCELLATION — issue #14
//
// The progress banners carry the only controls that can end an analysis the
// user did not ask to wait for. All three of them (Cancel, Add to trusted,
// Select logo manually) go through this section, so the two halves of a
// cancellation always happen together and in the same order: this document
// releases everything it holds (deadline, timers, shield, form guard) and
// forgets the job id, and the background is told to drop the job itself.
//
// Clearing currentJobId first is what makes the cancellation final on this
// side: every inbound job message is matched against it, so nothing the
// cancelled job still produces -- a late verdict, a capture handshake, a
// terminal failure -- can reach the banner afterwards.
// =============================================================================

function stopAnalysisLocally() {
  const jobId = currentJobId;
  clearAnalysisDeadline();
  clearProgressTimer();
  stopProgressNote();
  alreadyAnalysing = false;
  analysisMode = null;
  interruptionPending = false;
  currentJobId = null;
  capturePending = false;
  clearCaptureHold();
  unblockFormSubmission();
  removeBusyOverlay();
  if (typeof jobId === "string") {
    chrome.runtime.sendMessage({ type: "cancel_current_analysis", jobId }).catch(() => {});
  }
  return jobId;
}

// "Cancel" on either progress banner, and the Escape key while the shield is
// up (issue #23). A cancelled trusted-site flow returns to the verdict it was
// started from and leaves the trusted list untouched (the list is only ever
// written by a confirmed logo selection); a cancelled analysis leaves no
// banner at all, so the page is exactly as interactive as it was before the
// analysis started.
function cancelAnalysisFromUser({ force = false } = {}) {
  if (!alreadyAnalysing || (bannerActionPending && !force)) return false;
  bannerActionPending = true;
  const restore = analysisMode === "add_to_trusted" ? restorableVerdict : null;
  stopAnalysisLocally();
  if (restore !== null) {
    setIconState(iconStateForVerdict(restore.verdict), bannerMessageFor(restore.verdict, restore.data));
    showBanner(restore.verdict, restore.data);
  } else {
    setIconState("active");
    removeBanner();
  }
  bannerActionPending = false;
  return true;
}

// "Add to trusted", from a verdict banner (where nothing is running) or from
// the progress banner (where the standard analysis is cancelled first, so the
// trusted-site flow is never the second job in flight for this page).
function startTrustedAddFromBanner() {
  if (bannerActionPending) return;
  if (!confirm("Add this site to your trusted list?")) return;
  bannerActionPending = true;
  setBannerActionsDisabled(true);
  try {
    if (alreadyAnalysing) stopAnalysisLocally();
    triggerTrustedAdd();
  } catch (error) {
    bannerActionPending = false;
    setBannerActionsDisabled(false);
    throw error;
  }
}

// "Select logo manually" on the trusted-site progress banner: the background
// stops the automatic logo search and mounts the selector. It answers only
// once the selector session exists, and mounting the selector is itself what
// takes this banner and the shield down (cancel_analysis), so there is nothing
// left to render here on success. On failure the controls come back.
async function requestManualLogoSelection() {
  if (bannerActionPending || analysisMode !== "add_to_trusted") return;
  const jobId = currentJobId;
  if (typeof jobId !== "string") return;
  bannerActionPending = true;
  setBannerActionsDisabled(true);
  let accepted = false;
  try {
    const response = await chrome.runtime.sendMessage({ type: "select_logo_manually", jobId });
    accepted = response?.ok === true;
  } catch {
    accepted = false;
  }
  bannerActionPending = false;
  // The flow moved on while the request was in flight (cancelled, navigated,
  // or the automatic search finished first) -- whatever is on screen now owns
  // the banner, so leave it alone.
  if (jobId !== currentJobId) return;
  if (!accepted) setBannerActionsDisabled(false);
}

function setBannerActionsDisabled(disabled) {
  bannerEl?.querySelectorAll(".yp-btn").forEach((button) => {
    button.disabled = disabled;
  });
}

// =============================================================================
// SHIELD SAFETY NET — issue #23
//
// The busy shield deliberately swallows every pointer event, so the page is
// unusable for as long as it is up. That is only ever acceptable while the
// user can still reach a way out of the analysis. Two things used to break
// that pairing:
//
//   * the screenshot handshake hides the banner, and a capture_complete that
//     never arrived left it hidden -- a live shield over an invisible Cancel
//     button, until the 290-second job deadline;
//   * the banner host is an ordinary child of the page's own body, so a
//     single-page app clearing body.firstElementChild detached it while the
//     separately appended shield stayed up -- and every `bannerEl !== null`
//     test went on believing the banner was mounted.
//
// Everything below keeps one invariant: the shield is only ever up while a
// connected, visible, actionable banner exists -- or while the bounded capture
// window that is allowed to hide it has not yet expired.
// =============================================================================

// Comfortably longer than a healthy handshake (a one-second stability wait
// plus the background's capture round trip) and far shorter than the job
// deadlines, so it can only fire on a capture that is genuinely not coming
// back -- a page whose rendering stopped mid-wait, a worker that died, a
// dropped message.
const CAPTURE_RECOVERY_TIMEOUT_MS = 10_000;
let captureWatchdogHandle = null;

function clearCaptureWatchdog() {
  if (captureWatchdogHandle === null) return;
  clearTimeout(captureWatchdogHandle);
  captureWatchdogHandle = null;
}

function armCaptureWatchdog(jobId) {
  clearCaptureWatchdog();
  captureWatchdogHandle = setTimeout(() => {
    captureWatchdogHandle = null;
    abandonAnalysis(jobId, "capture_timeout");
  }, CAPTURE_RECOVERY_TIMEOUT_MS);
  captureWatchdogHandle?.unref?.();
}

// Releases every part of the capture hold at once: the watchdog that bounds
// it, the flag that makes anything rendered next invisible, and the inline
// style already hiding a banner that is on screen. Releasing one without the
// others is what let a terminal verdict, failure or interruption paint itself
// hidden behind a shield, so every terminal and recovery path calls this
// before it renders.
function clearCaptureHold() {
  clearCaptureWatchdog();
  bannerHiddenForCapture = false;
  if (bannerEl !== null) bannerEl.style.removeProperty("visibility");
}

// Drops references into a host the page detached or moved under one of its own
// containers. A connected host is not necessarily reachable: an SPA can park
// it below `display:none`, `hidden` or `inert` content while the separately
// mounted shield continues to own every pointer event. The banner host is only
// valid in the exact top-level location in which we mounted it.
function forgetUnreachableBannerHost() {
  if (
    bannerHostEl === null
    || (bannerHostEl.isConnected !== false && bannerHostEl.parentElement === document.body)
  ) return;
  const unreachableHost = bannerHostEl;
  bannerHostEl = null;
  bannerEl = null;
  bannerState = null;
  unreachableHost.remove();
  markExtensionMutation(unreachableHost);
}

function bannerIsMounted() {
  forgetUnreachableBannerHost();
  return bannerEl !== null;
}

// Connectivity and parentage catch detached/reparented hosts. Browser hit
// testing catches the remaining cases -- page CSS or another top-layer element
// making the visible Cancel control unreachable even though its host is still
// connected. elementFromPoint() called from the document sees the closed
// shadow tree as its host, which is exactly the result expected here.
function bannerProvidesShieldEscape() {
  if (!bannerIsMounted() || bannerHiddenForCapture) return false;
  const cancelButton = bannerEl.querySelector(".yp-btn-cancel");
  if (cancelButton === null) return false;
  const rect = cancelButton.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  try {
    return document.elementFromPoint(x, y) === bannerHostEl;
  } catch {
    return false;
  }
}

// A shield the page itself removed blocks nothing, so it does not count as one.
function shieldIsBlockingPage() {
  if (busyOverlayEl === null) return false;
  if (busyOverlayEl.isConnected === false) {
    busyOverlayEl = null;
    return false;
  }
  return true;
}

// Runs on every observed mutation, which is exactly what a page removing the
// banner host produces. Exactly two windows legitimately pair a shield with no
// mounted banner, and both are bounded: the screenshot handshake, by the
// watchdog above, and the fraction of a second a delayed progress banner is
// still waiting out. `capturePending` on its own is deliberately not one of
// them -- it stays raised for a whole analysis if the background never asks
// for the screenshot at all, which is precisely when the page must not be left
// sealed.
function ensureShieldHasEscape() {
  if (!alreadyAnalysing || !shieldIsBlockingPage()) return;
  if (bannerProvidesShieldEscape()) return;
  if (bannerHiddenForCapture || progressTimer !== null) return;
  if (remountShieldControls()) return;
  if (abandonAnalysis(currentJobId, "banner_unavailable")) return;
  // No job left to end, yet the shield still has no way out of it: it does not
  // get to stay either way.
  removeBusyOverlay();
  unblockFormSubmission();
}

// Puts the banner the shield depends on back, without the usual delay: that
// delay exists to keep a fast analysis from flashing a progress banner, not to
// leave a sealed page waiting another quarter second for its Cancel button.
function remountShieldControls() {
  try {
    // A trusted page's verdict is only ever painted once its screenshot is
    // done (issue #77), so until then the shield's controls are the progress
    // banner's -- which is what was on screen anyway.
    const verdict = analysisMode === "trusted_drift" && !capturePending
      ? "trusted"
      : analysisProgressVerdict();
    showBanner(verdict, {}, { immediate: true, preserveActionPending: true });
  } catch {
    return false;
  }
  return bannerProvidesShieldEscape();
}

// The one recovery for "the shield is up and its way out is gone". The job
// ends on both sides -- letting it run on would leave the background working
// for a page that can no longer show the answer -- the page is released, and
// the retryable failure banner is the visible, actionable surface the shield
// is not allowed to exist without. stopAnalysisLocally() takes the shield down
// before the banner is attempted, so even a page hostile enough to defeat the
// remount is left interactive.
function abandonAnalysis(jobId, code) {
  if (typeof jobId !== "string" || jobId !== currentJobId || !alreadyAnalysing) return false;
  const retryMode = analysisMode;
  stopAnalysisLocally();
  setIconState("failed", bannerMessageFor("analysis_failed", { code }));
  // The page is already released above. A document that will not accept the
  // banner at all -- the very case that can bring us here -- must not turn
  // this recovery into an exception on the way out.
  try {
    showBanner("analysis_failed", { code, retryMode });
  } catch {
    removeBanner();
  }
  return true;
}

// An emergency exit that depends on no part of the banner. The shield swallows
// pointer events but never keys, so Escape still reaches this document even
// when the page is completely sealed. The listener is inert unless a shield is
// actually up, so it never competes with a page's own Escape handling, and it
// consumes the key it acts on: while the shield owns the page, Escape is Yodel
// Phish's control rather than the page's.
document.addEventListener("keydown", (event) => {
  if (event.isTrusted !== true || event.key !== "Escape") return;
  if (!alreadyAnalysing || !shieldIsBlockingPage()) return;
  if (!cancelAnalysisFromUser({ force: true })) return;
  event.preventDefault();
  event.stopImmediatePropagation?.();
  event.stopPropagation();
}, { capture: true });

// =============================================================================
// CROSS-DOMAIN LOGIN HANDOVER — issue #24
//
// A legitimate sign-in may hand over from a trusted site to a different,
// previously unknown one. When this page's login surface is first detected,
// the service worker is asked whether this exact top document is the bound
// destination of such a handover before any pipeline job is created. A
// returned candidate proves navigation context only -- never destination
// legitimacy -- so the prompt describes the destination as untrusted, keeps
// credential submission blocked, and offers exactly three ways out: the
// existing interactive Add to trusted flow, an explicitly requested normal
// analysis, or leaving the site. No candidate (or a failed lookup) falls
// through to the ordinary pipeline unchanged.
// =============================================================================

function hasHandoverState() {
  return handoverResolutionPending || pendingHandover !== null;
}

function clearHandoverExpiryTimer() {
  if (handoverExpiryTimer !== null) {
    clearTimeout(handoverExpiryTimer);
    handoverExpiryTimer = null;
  }
}

// Drops every piece of local handover state without touching the banner or
// the form blocker -- each caller decides what replaces them. Bumping the
// resolution token makes any in-flight lookup's answer stale, so a response
// raced by a BFCache restore or a device-code advisory renders nothing.
function clearHandoverLocalState() {
  clearHandoverExpiryTimer();
  handoverResolutionToken += 1;
  handoverResolutionPending = false;
  pendingHandover = null;
  handoverActionPending = false;
}

// The one shared entry into first-time login handling: top-document detection,
// child-frame reports, init and the BFCache path all come through here, so the
// candidate lookup always happens before ordinary pipeline dispatch, several
// simultaneous detections resolve to one lookup, and submission is blocked
// before the lookup starts.
function beginLoginHandling() {
  if (alreadyAnalysing || interruptionPending || deviceFlowActive) return;
  if (hasHandoverState()) return;
  // Only an HTTPS document can be a handover destination; every other page
  // keeps the pre-handover behavior exactly.
  if (window.location.protocol !== "https:") {
    triggerPipeline();
    return;
  }
  handoverResolutionPending = true;
  const token = ++handoverResolutionToken;
  blockFormSubmission();
  chrome.runtime.sendMessage({ type: "resolve_handover_candidate" })
    .then((response) => finishHandoverResolution(token, response))
    .catch(() => finishHandoverResolution(token, null));
}

function finishHandoverResolution(token, response) {
  // A stale response -- the state was reset while the lookup was pending --
  // must not render into whatever owns the page now.
  if (token !== handoverResolutionToken || !handoverResolutionPending) return;
  handoverResolutionPending = false;
  if (alreadyAnalysing || interruptionPending || deviceFlowActive) return;
  const candidate = response?.ok === true ? response.candidate : null;
  if (candidate !== null && candidate !== undefined && typeof candidate.candidateId === "string") {
    showHandoverPrompt(candidate);
    return;
  }
  // No candidate, or the candidate store was unreachable: an unavailable
  // handover store must never bypass normal analysis.
  triggerPipeline();
}

// Renders the prompt through the banner's own renderer, never through the
// terminal show_banner path -- that handler releases the form blocker, and the
// blocker must stay on for as long as the decision is pending. The busy
// overlay would swallow the prompt's own buttons, so it must not be up.
function showHandoverPrompt(candidate) {
  analysisAttempted = true;
  clearHandoverExpiryTimer();
  pendingHandover = {
    candidateId: candidate.candidateId,
    sourceHost: typeof candidate.sourceHost === "string" ? candidate.sourceHost : "",
    destinationHost: typeof candidate.destinationHost === "string" ? candidate.destinationHost : "",
  };
  const data = {
    sourceHost: pendingHandover.sourceHost,
    destinationHost: pendingHandover.destinationHost,
  };
  blockFormSubmission();
  removeBusyOverlay();
  setIconState("unverified", bannerMessageFor("handover_pending", data));
  showBanner("handover_pending", data);
  // The background alarm owns authoritative expiry; this timer is the local
  // recovery for an already loaded page, armed from the authoritative
  // expires_at rather than any local lifetime.
  const expiresAt = candidate.expiresAt;
  if (Number.isFinite(expiresAt)) {
    handoverExpiryTimer = setTimeout(() => {
      handoverExpiryTimer = null;
      handleHandoverExpiry(candidate.candidateId);
    }, Math.max(0, expiresAt - Date.now()));
    handoverExpiryTimer?.unref?.();
  }
}

// Expiry of an unanswered prompt, from the background alarm or the local
// fallback timer. A stale notification -- an older candidate id, or no prompt
// pending -- changes nothing; a decision already in flight owns the
// transition. Otherwise the destination follows the standard process:
// submission stays blocked straight into the pipeline's own guard.
function handleHandoverExpiry(candidateId) {
  if (pendingHandover === null || pendingHandover.candidateId !== candidateId) return;
  if (handoverActionPending) return;
  clearHandoverLocalState();
  removeBanner();
  triggerPipeline();
}

const HANDOVER_ACTION_MESSAGES = Object.freeze({
  add: "handover_add_to_trusted",
  analyse: "handover_analyse_normally",
  leave: "handover_leave",
});

// One prompt decision. The service worker validates and consumes exactly the
// displayed candidate; only then does the chosen flow start. A rejected
// consume means the candidate was already gone (expired or stale), and the
// page falls back to the standard process rather than staying blocked behind
// a dead prompt.
async function handleHandoverAction(action) {
  if (handoverActionPending || pendingHandover === null) return;
  const candidateId = pendingHandover.candidateId;
  handoverActionPending = true;
  setBannerActionsDisabled(true);
  let accepted = false;
  try {
    const response = await chrome.runtime.sendMessage({
      type: HANDOVER_ACTION_MESSAGES[action],
      candidateId,
    });
    accepted = response?.ok === true;
  } catch {
    accepted = false;
  }
  handoverActionPending = false;
  // Expiry or invalidation won while the request was in flight; whatever
  // replaced the prompt owns the page now.
  if (pendingHandover === null || pendingHandover.candidateId !== candidateId) return;
  clearHandoverLocalState();
  removeBanner();
  if (accepted && action === "leave") {
    // The background is navigating this tab back or closing it.
    setIconState("active");
    return;
  }
  if (accepted && action === "add") {
    // The prompt's button was the confirmation, so the generic "Add this
    // site?" dialog is not shown again; the existing interactive flow owns
    // everything from here, and trust is persisted only by its confirmed
    // logo selection.
    triggerTrustedAdd();
    return;
  }
  if (accepted && action === "analyse") {
    triggerPipeline({ userInitiated: true });
    return;
  }
  triggerPipeline();
}

// A same-document History API change arrived while the prompt is pending. The
// scheme+host identity cannot change same-document, so a still-valid candidate
// keeps its prompt; one the background invalidated (back/forward) clears the
// handover state and falls back to normal login evaluation -- no analysis job
// existed, so no interruption UI is involved.
async function revalidatePendingHandover() {
  if (pendingHandover === null || handoverActionPending) return;
  const candidateId = pendingHandover.candidateId;
  let stillValid = false;
  try {
    const response = await chrome.runtime.sendMessage({ type: "resolve_handover_candidate" });
    stillValid = response?.ok === true && response.candidate?.candidateId === candidateId;
  } catch {
    stillValid = false;
  }
  if (pendingHandover === null || pendingHandover.candidateId !== candidateId) return;
  if (handoverActionPending || stillValid) return;
  clearHandoverLocalState();
  removeBanner();
  unblockFormSubmission();
  setIconState("active");
  // The prompt was the only login handling this document attempted -- it was
  // never an analysis -- so the surviving route runs first-time login
  // handling rather than the page-changed re-analyse offer.
  analysisAttempted = false;
  scheduleEvaluation();
}

// BFCache restoration: the prompt is only ever rebuilt from the service
// worker's answer for this exact restored document, never from content-script
// memory alone.
async function restorePendingHandover() {
  let candidate = null;
  try {
    const response = await chrome.runtime.sendMessage({ type: "resolve_handover_candidate" });
    if (response?.ok === true) candidate = response.candidate ?? null;
  } catch {
    candidate = null;
  }
  if (candidate === null || typeof candidate.candidateId !== "string") return false;
  if (alreadyAnalysing || interruptionPending || deviceFlowActive || hasHandoverState()) return false;
  showHandoverPrompt(candidate);
  return true;
}

// -----------------------------------------------------------------------------
// User-activity capture. Only browser-generated events count -- a synthetic
// event dispatched by page JavaScript has isTrusted === false and is ignored.
// Only the activity kind is reported: the service worker derives the source
// identity from the authoritative top frame it resolves itself, uses its own
// receipt time, and verifies the source is currently trusted, so nothing a
// page supplies here can arm a handover.
// -----------------------------------------------------------------------------

const HANDOVER_ACTIVITY_THROTTLE_MS = 1_000;
let lastActivityReportAt = 0;

function reportHandoverActivity(kind) {
  const nowMs = Date.now();
  if (nowMs - lastActivityReportAt < HANDOVER_ACTIVITY_THROTTLE_MS) return;
  lastActivityReportAt = nowMs;
  chrome.runtime.sendMessage({ type: "handover_user_activity", kind }).catch(() => {});
}

// Link clicks and button-like clicks may initiate navigation; anything else a
// click lands on is not reported at all.
function handoverActivityKindForClick(event) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const node of path) {
    if (node?.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = typeof node.tagName === "string" ? node.tagName.toLowerCase() : "";
    if (tag === "a" && node.hasAttribute?.("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "input" && ["submit", "button", "image"].includes(node.type)) return "button";
    if (node.getAttribute?.("role") === "button") return "button";
  }
  return null;
}

// Only an HTTPS page can be a handover source, so anything else never reports.
function isPotentialHandoverSourcePage() {
  return window.location.protocol === "https:";
}

document.addEventListener("click", (event) => {
  if (event.isTrusted !== true || !isPotentialHandoverSourcePage()) return;
  const kind = handoverActivityKindForClick(event);
  if (kind !== null) reportHandoverActivity(kind);
}, { capture: true, passive: true });

document.addEventListener("keydown", (event) => {
  if (event.isTrusted !== true || !isPotentialHandoverSourcePage()) return;
  if (event.key !== "Enter") return;
  reportHandoverActivity("enter");
}, { capture: true, passive: true });

document.addEventListener("submit", (event) => {
  if (event.isTrusted !== true || !isPotentialHandoverSourcePage()) return;
  reportHandoverActivity("submit");
}, { capture: true, passive: true });

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
    if (!bannerIsMounted()) activateDeviceFlowAdvisory(deviceFlowProvider);
    return { ok: true, status: "device_flow_active" };
  }

  dismissed = false;
  interruptionPending = false;

  // An explicit request supersedes a pending handover decision (issue #24):
  // the candidate is consumed as "analyse normally" and the standard pipeline
  // takes the page over. A lookup still in flight is simply invalidated.
  if (pendingHandover !== null) {
    chrome.runtime.sendMessage({
      type: "handover_analyse_normally",
      candidateId: pendingHandover.candidateId,
    }).catch(() => {});
    clearHandoverLocalState();
    removeBanner();
  } else if (handoverResolutionPending) {
    clearHandoverLocalState();
  }

  // Explicit user intent bypasses only the automatic login-page heuristic.
  // URL support, device-flow priority, delivery errors, and the single-job
  // guard remain enforced by their existing owners.
  triggerPipeline({ userInitiated: true });
  return { ok: true, status: "started", jobId: currentJobId };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "prepare_capture") {
    if (!isCurrentJobMessage(message)) {
      sendResponse({ ok: false, reason: "stale_job" });
      return false;
    }
    // Issue #23: the hidden-banner window opens here, so its deadline starts
    // here too -- never inside preparePageForCapture(), whose own continuation
    // is one of the things that can stop running.
    armCaptureWatchdog(message.jobId);
    preparePageForCapture(message.jobId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "capture_complete") {
    if (!isCurrentJobMessage(message)) return false;
    clearCaptureHold();
    capturePending = false;
    if (alreadyAnalysing) {
      // The capture is what releases a held-back banner. A trusted refresh has
      // its verdict already ("trusted_drift" is only ever entered for it); every
      // other mode is still working and shows progress.
      if (analysisMode === "trusted_drift") {
        showBanner("trusted", {});
        // The provisional verdict is already telling the user the page is
        // safe. The drift analysis may finish in the background, but it must
        // no longer leave an input-blocking shield with a banner that has no
        // Cancel control.
        removeBusyOverlay();
      } else {
        showBanner(analysisProgressVerdict(), {});
      }
    }
    return false;
  }

  if (message.type === "analysis_cancelled_silently") {
    if (!isCurrentJobMessage(message)) return false;
    clearAnalysisDeadline();
    alreadyAnalysing = false;
    dismissed = false;
    analysisMode = null;
    interruptionPending = false;
    currentJobId = null;
    analysisAttempted = false;
    clearCaptureHold();
    unblockFormSubmission();
    removeBanner();
    setIconState("active");

    // A tabs.onUpdated URL event may precede either a History API event or a
    // full document commit. Reanalyse only if this surviving document already
    // owns that URL; a document that is merely waiting to unload must not start
    // another job. When delivery itself failed without a known destination,
    // the current document gets the same recovery pass.
    if (typeof message.reanalyseUrl !== "string" || window.location.href === message.reanalyseUrl) {
      scheduleEvaluation();
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
    // Issue #24: a pending prompt is revalidated against the candidate store
    // rather than replaced by mutation evaluation; a lookup in flight already
    // owns login handling and needs no extra evaluation.
    if (pendingHandover !== null) {
      void revalidatePendingHandover();
      return false;
    }
    if (handoverResolutionPending) return false;
    scheduleEvaluation();
    return false;
  }

  // Issue #24: authoritative expiry of an unanswered handover prompt, sent to
  // this exact document by the background alarm. Stale ids change nothing.
  if (message.type === "handover_expired" || message.type === "handover_invalidated") {
    if (typeof message.candidateId === "string") handleHandoverExpiry(message.candidateId);
    return false;
  }

  // Issue #88: a child frame reported that its own document became a login
  // page. The frame owns nothing -- the job, the capture, the banners, form
  // blocking and the icon all stay bound to this top document and its URL.
  // Only the lifecycle decision is shared with top-document detection, which
  // is what keeps simultaneous reports from several frames down to one job.
  if (message.type === "embedded_login_detected") {
    // Issue #24: a report while a candidate lookup is pending or the prompt is
    // showing must not create another lookup, prompt or job. The response tells
    // the exact reporting child whether this top lifecycle still owns a blocker.
    if (alreadyAnalysing || interruptionPending || deviceFlowActive || hasHandoverState()) {
      sendResponse({ ok: true, blocked: submissionBlocker !== null });
      return false;
    }
    if (bannerIsMounted()) {
      offerReanalysis();
      sendResponse({ ok: true, blocked: submissionBlocker !== null });
      return false;
    }
    dismissed = false;
    handleLoginDetected();
    sendResponse({ ok: true, blocked: submissionBlocker !== null });
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
      if (!capturePending) {
        showBanner(message.verdict, message.data ?? {});
        removeBusyOverlay();
      }
      sendResponse({ accepted: true });
      return false;
    }
    clearAnalysisDeadline();
    clearCaptureHold();
    alreadyAnalysing = false;
    dismissed = false;
    analysisMode = null;
    interruptionPending = false;
    currentJobId = null;
    unblockFormSubmission();
    removeBusyOverlay();
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
    clearCaptureHold();
    alreadyAnalysing = false;
    interruptionPending = false;
    currentJobId = null;
    analysisMode = null;
    unblockFormSubmission();
    removeBusyOverlay();
    setIconState("unverified", bannerMessageFor("continued_unverified", {}));
    showBanner("continued_unverified", {});
    sendResponse({ ok: true });
    return false;
  }
});

function enterInterruptedState(jobId) {
  if (typeof jobId !== "string" || jobId !== currentJobId) return false;
  clearAnalysisDeadline();
  clearCaptureHold();
  alreadyAnalysing = false;
  if (jobId !== undefined) currentJobId = jobId;
  interruptionPending = true;
  blockFormSubmission();
  removeBusyOverlay();
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
  clearCaptureHold();
  alreadyAnalysing = false;
  dismissed = false;
  analysisMode = null;
  interruptionPending = false;
  currentJobId = null;
  unblockFormSubmission();
  removeBusyOverlay();
  setIconState("failed", bannerMessageFor("analysis_failed", { code }));
  showBanner("analysis_failed", { code, retryMode });
  return true;
}

// =============================================================================
// STABLE SCREENSHOT COORDINATION
// =============================================================================

const PAGE_STABILITY_TIMEOUT_MS = 1000;

async function preparePageForCapture(jobId) {
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
    // The job can be cancelled while the stability wait is in progress. Its
    // late continuation must not hide a newer job's banner in the same SPA.
    if (jobId !== currentJobId) throw new Error("Capture job is no longer current");
    if (bannerEl) bannerEl.style.visibility = "hidden";
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
  capture_timeout: "The page screenshot did not finish in time, so the analysis was stopped.",
  banner_unavailable: "This page removed the Yodel Phish controls, so the analysis was stopped.",
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

// All banner styling lives inside the banner's closed Shadow Root (issue #9),
// the same isolation the logo selector uses: host-page CSS cannot reach the
// banner's internals through ordinary selectors, and none of these rules can
// leak onto matching host-page elements.
//
// The :host declarations are all !important because, for the host element,
// important declarations from the inner (shadow) context outrank the host
// document's — even a page's own `div { display: none !important }` cannot
// collapse or reposition the banner. `all: initial` cuts ordinary inheritance
// at the boundary; direction and bidi isolation (which `all` deliberately does
// not reset) are fixed explicitly below. The palette custom properties and the
// spinner keyframes are scoped to the shadow tree, so page-defined `--yp-*`
// values or a page `yp-spin` animation cannot alter the banner either.
const BANNER_CSS = `
  :host {
    all: initial !important;
    display: block !important;
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    z-index: 2147483647 !important;
    direction: ltr !important;
    unicode-bidi: isolate !important;
    /* The fixed host keeps the banner dimensions while its inner element is
       hidden for capture. Never let that transparent box intercept the page;
       the visible banner opts back into hit testing below. */
    pointer-events: none !important;
  }

  #yp-banner {
    --yp-green:  #2e7d32;
    --yp-orange: #e65100;
    --yp-red:    #b71c1c;
    --yp-grey:   #424242;
    --yp-blue:   #8fbcf2;
    --yp-white:  #f5f5f5;
    --yp-text-light: #ffffff;
    --yp-text-dark:  #212121;
    --yp-font:   system-ui, -apple-system, sans-serif;

    background-color: var(--yp-bg, #424242);
    color: var(--yp-text-light);
    font: 400 14px/normal var(--yp-font);
    /* "small" is the original size; the user can pick a larger one in settings
       (issue #3). Buttons and icon use em units so they scale along. */
    letter-spacing: normal;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    pointer-events: auto;
  }

  #yp-banner[data-font-size="medium"] { font-size: 17px; }
  #yp-banner[data-font-size="large"]  { font-size: 20px; }

  /* The light-background verdicts need dark text; the progress verdicts are
     blue with light text (issue #68). The handover prompt (issue #24) shares
     the unknown verdict's presentation: an undecided page, not a verdict. */
  #yp-banner[data-verdict="unknown"],
  #yp-banner[data-verdict="handover_pending"] {
    color: var(--yp-text-dark);
  }

  .yp-inner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    max-width: 100%;
    flex-wrap: wrap;
    box-sizing: border-box;
  }

  .yp-brand {
    font-weight: 700;
    letter-spacing: 0.02em;
    flex-shrink: 0;
  }

  .yp-icon {
    display: inline-flex;
    flex-shrink: 0;
  }

  .yp-icon svg {
    display: block;
    width: 1.5em;
    height: 1.5em;
  }

  .yp-icon .yp-spin {
    animation: yp-spin 900ms linear infinite;
  }

  @keyframes yp-spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .yp-icon .yp-spin { animation: none; }
  }

  /* The message is centered in the banner; the brand label sits on the left
     (issue #3). */
  .yp-message {
    flex: 1;
    line-height: 1.4;
    text-align: center;
  }

  .yp-progress-note {
    display: block;
    font-size: 0.85em;
    opacity: 0.85;
  }

  .yp-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  /* Only user-agent defaults exist inside the shadow root, so every control
     is styled from scratch here — no variant may depend on what a site's
     stylesheet happens to do to buttons (issue #9). The base is the neutral
     solid button; variants override it. */
  .yp-btn {
    appearance: none;
    margin: 0;
    padding: 6px 14px;
    border: none;
    border-radius: 4px;
    background-color: #757575;
    color: #ffffff;
    font: 500 0.93em/normal var(--yp-font);
    letter-spacing: normal;
    text-transform: none;
    text-shadow: none;
    text-decoration: none;
    box-shadow: none;
    cursor: pointer;
  }

  /* Close is an icon-only button; the SVG cross is drawn with a thick stroke so
     it reads as a clear, standard close control (issue #3). */
  .yp-btn-close-x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px;
    background: transparent;
    color: currentColor;
    opacity: 0.85;
  }

  .yp-btn-close-x:hover { opacity: 1; }

  .yp-btn-close-x svg {
    display: block;
    width: 1.35em;
    height: 1.35em;
  }

  .yp-btn-add {
    background-color: #2e7d32;
  }

  .yp-btn-add:hover {
    background-color: #1b5e20;
  }

  .yp-btn-mute {
    background-color: #757575;
  }

  .yp-btn-mute:hover {
    background-color: #616161;
  }

  .yp-btn-close,
  .yp-btn-reanalyse {
    background-color: transparent;
    color: currentColor;
    border: 1px solid currentColor;
    opacity: 0.65;
  }

  .yp-btn-close:hover,
  .yp-btn-reanalyse:hover {
    opacity: 1;
  }

  .yp-btn-retry {
    background-color: #2e7d32;
  }

  .yp-btn-retry:hover {
    background-color: #1b5e20;
  }

  /* Progress-banner controls (issue #14). "Add to trusted" is the same green
     affirmative action it is on a verdict banner; ending or redirecting the
     analysis is quieter, so both read as outlined controls on the blue
     progress background. */
  .yp-btn-add-trusted {
    background-color: #2e7d32;
  }

  .yp-btn-add-trusted:hover {
    background-color: #1b5e20;
  }

  .yp-btn-cancel,
  .yp-btn-manual-logo {
    background-color: transparent;
    color: currentColor;
    border: 1px solid currentColor;
    opacity: 0.75;
  }

  .yp-btn-cancel:hover,
  .yp-btn-manual-logo:hover {
    opacity: 1;
  }

  /* Handover prompt controls (issue #24). "Add to trusted" is the same green
     affirmative action it is everywhere else; the two fallback decisions read
     as outlined controls on the prompt's light background. */
  .yp-btn-handover-add {
    background-color: #2e7d32;
  }

  .yp-btn-handover-add:hover {
    background-color: #1b5e20;
  }

  .yp-btn-handover-analyse,
  .yp-btn-handover-leave {
    background-color: transparent;
    color: currentColor;
    border: 1px solid currentColor;
    opacity: 0.75;
  }

  .yp-btn-handover-analyse:hover,
  .yp-btn-handover-leave:hover {
    opacity: 1;
  }

  /* A control whose operation is already running must not look clickable --
     the busy shield's cursor applies to the page, not to the banner. */
  .yp-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

// A constructed stylesheet is preferred over a <style> element: an inline
// <style> inside the shadow tree is still part of the host document and can be
// blocked by the page's own style-src CSP, while an adopted sheet cannot.
function applyBannerStylesheet(shadow) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(BANNER_CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement("style");
    style.textContent = BANNER_CSS;
    shadow.appendChild(style);
  }
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
  // Issue #14: waiting is never the only option. An analysis in progress can
  // be ended outright or turned into the trusted-site flow, and the
  // trusted-site flow can be ended or taken straight to manual logo selection.
  analysing: {
    color:   "var(--yp-blue)",
    icon:    "spinner",
    message: "Login detected, Yodel-Phish Analysis in progress",
    buttons: ["add-trusted", "cancel-analysis"],
  },
  analysing_manual: {
    color:   "var(--yp-blue)",
    icon:    "spinner",
    message: "Manual analysis in progress…",
    buttons: ["add-trusted", "cancel-analysis"],
  },
  adding_to_trusted: {
    color:   "var(--yp-blue)",
    icon:    "spinner",
    message: "Adding this site to your trusted list…",
    buttons: ["manual-logo", "cancel-analysis"],
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
  // Issue #24 — a trusted page's own recent navigation reached this unknown
  // login page. The prompt names the exact untrusted destination hostname,
  // never implies it was verified, and has no dismiss control: a decision,
  // expiry or navigation is what ends it. Submission stays blocked meanwhile.
  handover_pending: {
    color:   "var(--yp-white)",
    icon:    "info",
    message: (data) => {
      const source = data.sourceHost ? data.sourceHost : "a trusted site";
      const destination = data.destinationHost ? data.destinationHost : "this site";
      return [
        "You started a sign-in navigation from your trusted site ",
        { text: source, bold: true },
        { text: ". " },
        { text: "The sign-in page is now on the untrusted site ", newLine: true },
        { text: destination, bold: true },
        { text: ". " },
        { text: "Do you know and trust ", underline: true },
        { text: destination, underline: true, bold: true },
        { text: "?", underline: true },
      ];
    },
    buttons: ["handover-add", "handover-analyse", "handover-leave"],
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

// `immediate` skips the delayed progress presentation. Only the shield's own
// remount uses it (issue #23): that delay exists to keep a fast analysis from
// flashing a progress banner, never to leave a blocked page without controls.
function showBanner(verdict, data, { immediate = false, preserveActionPending = false } = {}) {
  const config = BANNER_CONFIG[verdict];
  if (!config) return;
  const message = bannerMessageFor(verdict, data);
  const state = `${verdict}\n${message}\n${data.retryMode ?? ""}`;

  clearProgressTimer();
  // Any other state ends the capture window: those paths either already
  // captured or never will, and must never be held back. This renderer does
  // not own the busy shield's lifecycle: a provisional "trusted" verdict is
  // non-progress UI while its trusted-drift analysis is still running.
  if (!PROGRESS_VERDICTS.has(verdict)) {
    capturePending = false;
  }
  // A host the page detached is not a banner, so neither the deduplication
  // below nor the reuse in renderBanner() may treat it as one (issue #23).
  if (bannerIsMounted() && state === bannerState) {
    // A terminal response can legitimately restore the same verdict that was
    // visible when Add-to-trusted started. That still completes the old
    // button's transition and must give its controls back.
    if (bannerActionPending && !preserveActionPending) {
      bannerActionPending = false;
      setBannerActionsDisabled(false);
    }
    return;
  }

  if (!immediate && PROGRESS_VERDICTS.has(verdict)) {
    progressTimer = setTimeout(() => {
      progressTimer = null;
      renderBanner(verdict, config, data, message, state, { preserveActionPending });
    }, capturePending ? CAPTURE_PROGRESS_DELAY_MS : PROGRESS_DELAY_MS);
    progressTimer?.unref?.();
    return;
  }
  renderBanner(verdict, config, data, message, state, { preserveActionPending });
}

function clearProgressTimer() {
  if (progressTimer === null) return;
  clearTimeout(progressTimer);
  progressTimer = null;
}

function renderBanner(verdict, config, data, message, state, { preserveActionPending = false } = {}) {
  // Avoid replacing buttons that are already in the correct state.
  if (bannerIsMounted() && state === bannerState) return;
  bannerState = state;

  // Issue #14: the two verdicts that offer "Add to trusted" are also the two a
  // cancelled trusted-site flow returns to. A progress banner replaces such a
  // verdict without ending it, so it deliberately keeps the memory; any other
  // verdict has genuinely superseded it.
  if (verdict === "unknown" || verdict === "suspicious") {
    restorableVerdict = { verdict, data };
  } else if (!PROGRESS_VERDICTS.has(verdict)) {
    restorableVerdict = null;
  }

  if (!bannerIsMounted()) {
    // The host carries no stable id or class, avoiding ordinary selector
    // collisions. It is still part of the shared document and page JavaScript
    // can observe or remove it; the closed root protects only its internals.
    // It also keeps the banner controls out of the login detector shadow walk.
    // The banner id below is scoped to the shadow tree and invisible to
    // document selectors. Positioning lives in the :host block of BANNER_CSS
    // because shadow-context !important outranks page CSS on the host.
    bannerHostEl = document.createElement("div");
    const shadow = bannerHostEl.attachShadow({ mode: "closed" });
    applyBannerStylesheet(shadow);
    bannerEl = document.createElement("div");
    bannerEl.id = "yp-banner";
    bannerEl.setAttribute("role", "status");
    bannerEl.setAttribute("lang", "en");
    bannerEl.setAttribute("dir", "ltr");
    shadow.appendChild(bannerEl);
    document.body.prepend(bannerHostEl);
    markExtensionMutation(bannerHostEl);
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
        ${config.buttons.includes("add-trusted") ? `<button class="yp-btn yp-btn-add-trusted">Add to trusted</button>` : ""}
        ${config.buttons.includes("manual-logo") ? `<button class="yp-btn yp-btn-manual-logo">Select logo manually</button>` : ""}
        ${config.buttons.includes("cancel-analysis") ? `<button class="yp-btn yp-btn-cancel">Cancel</button>` : ""}
        ${config.buttons.includes("handover-add") ? `<button class="yp-btn yp-btn-handover-add">Add to trusted</button>` : ""}
        ${config.buttons.includes("handover-analyse") ? `<button class="yp-btn yp-btn-handover-analyse">Analyse normally</button>` : ""}
        ${config.buttons.includes("handover-leave") ? `<button class="yp-btn yp-btn-handover-leave">Leave site</button>` : ""}
      </div>
    </div>
  `;
  // Replacing the banner is the acknowledgement for a synchronous action such
  // as Add-to-trusted. Keep the old controls single-flight until this point so
  // a double click cannot cancel and restart the new job during the delayed
  // progress transition.
  if (!preserveActionPending) bannerActionPending = false;
  const messageEl = bannerEl.querySelector(".yp-message");
  if (messageEl !== null) renderBannerMessage(messageEl, bannerMessageParts(verdict, data));

  // Both entry points into the trusted-site flow: the verdict banner's own
  // control, and the one the progress banner offers while an analysis the user
  // no longer wants to wait for is still running (issue #14).
  bannerEl.querySelectorAll(".yp-btn-add, .yp-btn-add-trusted").forEach((btn) => {
    btn.addEventListener("click", startTrustedAddFromBanner);
  });

  bannerEl.querySelector(".yp-btn-manual-logo")?.addEventListener("click", () => {
    void requestManualLogoSelection();
  });

  bannerEl.querySelector(".yp-btn-cancel")?.addEventListener("click", cancelAnalysisFromUser);

  // The handover prompt's three decisions (issue #24). Each consumes exactly
  // the displayed candidate; handleHandoverAction keeps them single-flight.
  bannerEl.querySelector(".yp-btn-handover-add")?.addEventListener("click", () => {
    void handleHandoverAction("add");
  });
  bannerEl.querySelector(".yp-btn-handover-analyse")?.addEventListener("click", () => {
    void handleHandoverAction("analyse");
  });
  bannerEl.querySelector(".yp-btn-handover-leave")?.addEventListener("click", () => {
    void handleHandoverAction("leave");
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
  if (preserveActionPending && bannerActionPending) setBannerActionsDisabled(true);
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
  }
  const seconds = Math.round(elapsedMs / 1000);
  if (elapsedMs < PROGRESS_NOTE_STILL_AFTER_MS) {
    note.textContent = `Analysis in progress… (${seconds}s) — Do not interact with the website until the analysis finishes.`;
  } else if (elapsedMs < PROGRESS_NOTE_LONG_AFTER_MS) {
    note.textContent = `Still analysing… (${seconds}s) — Do not interact with the website until the analysis finishes.`;
  } else {
    note.textContent = `Hold on… (${seconds}s) — Visual analysis can take longer on certain pages.`;
  }
}

function removeBanner() {
  clearProgressTimer();
  clearCaptureHold();
  capturePending = false;
  restorableVerdict = null;
  // Removing the banner is the other terminal path. It covers the routes that
  // clear the banner without a replacement verdict — silent same-document
  // cancellation, a bfcache restore, and cancel_analysis, which drops the
  // banner just before the logo selector mounts: leaving a pointer-blocking
  // shield up would make that selector unclickable (issue #8).
  removeBusyOverlay();
  stopProgressNote();
  const removedHost = bannerHostEl;
  removedHost?.remove();
  if (removedHost) markExtensionMutation(removedHost);
  bannerHostEl = null;
  bannerEl = null;
  bannerState = null;
}

// =============================================================================
// BUSY OVERLAY (during in-page analysis)
//
// One transparent, fixed, full-viewport element carrying cursor: progress. It
// is extension-owned (so the mutation observer never treats its own add/remove
// as a page change) and, being transparent, never appears in the screenshot —
// so unlike the banner it needs no capture-hiding (issue #77). `all: initial`
// first neutralizes page CSS that could hide or reposition an anonymous div;
// the explicit important properties then define the shield. It sits one
// z-index below the banner so the banner and its controls always stay on top.
// =============================================================================

const BUSY_OVERLAY_STYLE = Object.freeze({
  all: "initial",
  display: "block",
  position: "fixed",
  top: "0",
  left: "0",
  right: "0",
  bottom: "0",
  margin: "0",
  "z-index": "2147483646",
  background: "transparent",
  cursor: "progress",
  "pointer-events": "auto",
});

function showBusyOverlay() {
  if (busyOverlayEl !== null) return;
  const overlay = document.createElement("div");
  for (const [property, value] of Object.entries(BUSY_OVERLAY_STYLE)) {
    overlay.style.setProperty(property, value, "important");
  }
  document.body.appendChild(overlay);
  markExtensionMutation(overlay);
  busyOverlayEl = overlay;
}

function removeBusyOverlay() {
  if (busyOverlayEl === null) return;
  const removed = busyOverlayEl;
  busyOverlayEl = null;
  removed.remove();
  markExtensionMutation(removed);
}

// =============================================================================
// FORM SUBMISSION BLOCK (during in-page analysis)
// =============================================================================

function setChildFrameSubmissionBlocked(blocked) {
  chrome.runtime.sendMessage({
    type: "set_child_frame_submission_block",
    blocked,
  }).catch(() => {});
}

function blockFormSubmission() {
  if (submissionBlocker) return;
  const handler = (e) => e.preventDefault();
  document.addEventListener("submit", handler, { capture: true });
  submissionBlocker = handler;
  setChildFrameSubmissionBlocked(true);
}

function unblockFormSubmission() {
  if (!submissionBlocker) return;
  document.removeEventListener("submit", submissionBlocker, { capture: true });
  submissionBlocker = null;
  setChildFrameSubmissionBlocked(false);
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
  clearCaptureHold();
  // Device Code handling takes precedence over a pending handover (issue #24);
  // the advisory below replaces the prompt and its local state.
  clearHandoverLocalState();
  alreadyAnalysing = false;
  dismissed = false;
  analysisMode = null;
  interruptionPending = false;
  currentJobId = null;
  unblockFormSubmission();
  removeBusyOverlay();
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

// Issue #8: this tab may have been opened by a Settings "Move to trusted" to
// confirm the site's logo. If so, run the same add-to-trusted flow the banner's
// "Add to trusted" button uses instead of ordinary phishing analysis; the
// background supplies the close-tab and settings-focus context. Checked after
// the device-flow advisory, which always takes priority.
async function checkTrustedAddIntent() {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "get_trusted_add_intent" });
  } catch {
    return false; // background unreachable -- fail open, run the normal pipeline
  }
  if (response?.active !== true) return false;
  triggerTrustedAdd();
  return true;
}

// =============================================================================
// INITIAL CHECK ON PAGE LOAD
// =============================================================================

window.addEventListener("pageshow", async (event) => {
  if (!event.persisted) return;

  clearAnalysisDeadline();
  // Stale local handover timers and state die with the restore (issue #24);
  // whether a candidate still exists is re-asked below, never assumed.
  clearHandoverLocalState();
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
  if (await checkTrustedAddIntent()) return;

  const result = detectLoginPage();
  if (result.isLogin) {
    if (!analysisAttempted) {
      beginLoginHandling();
      return;
    }
    // The restored exact document may still own an active candidate -- the
    // prompt it showed before comes back only when the service worker still
    // vouches for it; otherwise the existing page-changed behavior stands.
    if (await restorePendingHandover()) return;
    showBanner("page_changed", {});
  }
});

(async function init() {
  if (await checkDeviceFlowStatus()) return;
  if (await checkTrustedAddIntent()) return;
  const result = detectLoginPage();
  if (result.isLogin) {
    beginLoginHandling();
  }
})();
