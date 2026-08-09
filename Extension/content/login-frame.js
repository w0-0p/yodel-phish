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
// This watcher is therefore injected into every frame and does exactly one
// thing: tell the service worker when its own document *becomes* a login page.
// It never starts an analysis, captures anything, renders a banner, reads
// settings, touches the icon, or blocks submission. The top document decides
// what the report means; the service worker forwards it there.
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
    if (!isLogin) return;
    try {
      // An orphaned frame (the extension was reloaded or disabled under it)
      // throws synchronously rather than rejecting. Either way the report is
      // simply lost: nothing in this file has state worth recovering.
      chrome.runtime.sendMessage({ type: "child_frame_login_detected" }).catch(() => {});
    } catch {
      // no-op
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
