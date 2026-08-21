// Child-frame login watcher (issue #88).
//
// The full content script runs in the top document only: it owns the analysis
// job, screenshot capture, banners, form blocking, icon state and trusted /
// muted handling. Login UIs are routinely rendered inside iframes though —
// including sandboxed `srcdoc` documents, whose opaque origin the parent
// cannot read at all — so no amount of parent-side DOM traversal can find
// them. Chrome can inject into those frames; reading them from outside is what
// is impossible.
//
// This watcher is therefore injected into every frame and tells the service
// worker when its own document becomes a login page. It also owns the only
// submit listener capable of blocking a cross-origin child document: the top
// lifecycle tells it when to retain or release that guard. It still never
// starts analysis, captures, renders UI, reads settings, or touches the icon.
(function watchChildFrameLogin() {
  // The top document has the real content script. This file must stay inert
  // there, so a page can never end up with two owners of the same lifecycle.
  if (window.top === window) return;

  const detector = globalThis.YodelLoginDetector;
  if (detector === undefined) return;

  // Matches the top document's own debounce: one non-resetting timer, so
  // continuous churn inside the frame can never postpone discovery.
  const EVALUATION_DELAY_MS = 200;

  // Only the transition into "this frame is a login page" is worth a message.
  // A frame that keeps being one reports nothing further, so a noisy document
  // cannot flood the service worker; a frame that stops being one re-arms, so
  // a replacement document rendering a credential form is reported again.
  let reportedLogin = false;
  let evaluationScheduled = false;
  let detectionBlock = false;
  let lifecycleBlock = false;
  let submissionBlocker = null;
  let reportVersion = 0;
  let controlVersion = 0;

  function syncSubmissionBlocker() {
    const shouldBlock = detectionBlock || lifecycleBlock;
    if (shouldBlock && submissionBlocker === null) {
      submissionBlocker = (event) => event.preventDefault();
      document.addEventListener("submit", submissionBlocker, { capture: true });
    } else if (!shouldBlock && submissionBlocker !== null) {
      document.removeEventListener("submit", submissionBlocker, { capture: true });
      submissionBlocker = null;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "set_submission_blocked") return false;
    controlVersion += 1;
    lifecycleBlock = message.blocked === true;
    syncSubmissionBlocker();
    sendResponse({ ok: true });
    return false;
  });

  const observerOptions = {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [...detector.VISUAL_ATTRIBUTES, ...detector.DETECTION_ATTRIBUTES],
  };
  const observer = new MutationObserver(scheduleEvaluation);
  const observedShadowRoots = new WeakSet();

  function observeOpenShadowRoots() {
    for (const shadow of detector.collectOpenShadowRoots(document)) {
      if (!observedShadowRoots.has(shadow)) {
        observedShadowRoots.add(shadow);
        observer.observe(shadow, observerOptions);
      }
    }
  }

  function evaluate() {
    evaluationScheduled = false;
    observeOpenShadowRoots();
    const isLogin = detector.detectLoginPage(document, window).isLogin;
    if (isLogin === reportedLogin) return;
    reportedLogin = isLogin;
    reportVersion += 1;
    if (!isLogin) {
      detectionBlock = false;
      syncSubmissionBlocker();
      return;
    }

    // Block this exact frame before the asynchronous report leaves it. The top
    // response or lifecycle broadcast then decides whether the guard remains.
    detectionBlock = true;
    syncSubmissionBlocker();
    const ownReportVersion = reportVersion;
    const startingControlVersion = controlVersion;
    try {
      chrome.runtime.sendMessage({ type: "child_frame_login_detected" })
        .then((response) => {
          if (reportVersion !== ownReportVersion) return;
          detectionBlock = false;
          if (controlVersion === startingControlVersion) {
            lifecycleBlock = response?.blocked === true;
          }
          syncSubmissionBlocker();
        })
        .catch(() => {
          if (reportVersion !== ownReportVersion) return;
          detectionBlock = false;
          syncSubmissionBlocker();
        });
    } catch {
      detectionBlock = false;
      syncSubmissionBlocker();
    }
  }

  function scheduleEvaluation() {
    if (evaluationScheduled) return;
    evaluationScheduled = true;
    setTimeout(evaluate, EVALUATION_DELAY_MS);
  }

  if (document.body !== null && document.body !== undefined) {
    observer.observe(document.body, observerOptions);
  }

  // One scan at document_idle. A `srcdoc` or navigated child document is fully
  // parsed by then, so the common case needs no mutation at all.
  evaluate();
})();
