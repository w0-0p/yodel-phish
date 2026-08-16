// Pure navigation comparisons used by the analysis job lifecycle (issue #88).
// Chrome event handling stays in service_worker.js; keeping these two decisions
// chrome-free lets their complete state matrix be tested directly.

export function jobMatchesAddress(job, url) {
  return job !== null && job !== undefined && job.url === url;
}

export function jobMatchesSameDocumentState(job, { url, documentId } = {}) {
  return jobMatchesAddress(job, url) &&
    typeof job.documentId === "string" &&
    job.documentId !== "" &&
    job.documentId === documentId;
}

// Specific cancellation reasons (issue #18). The old overloaded
// "address_changed" could not tell a same-document History API push from a
// fragment update, genuine navigation, replacement document, or stale message
// sender. Each value is a stable diagnostics code.
export const CANCELLATION_REASONS = Object.freeze({
  URL_CHANGED: "url_changed",
  HISTORY_STATE_CHANGED: "history_state_changed",
  REFERENCE_FRAGMENT_CHANGED: "reference_fragment_changed",
  DOCUMENT_REPLACED: "document_replaced",
  STALE_SENDER_DOCUMENT: "stale_sender_document",
  DOCUMENT_INACTIVE: "document_inactive",
});

// Whether the authoritative current top frame can anchor a new job for this
// message sender, and if not, why (issue #18). The sender's own MessageSender
// snapshot is never trusted: a History API change between page load and the
// message can leave sender.url pointing at a route the browser's navigation
// events no longer report, so a job bound to it is cancelled the moment the
// next same-document event arrives. `frame` is the chrome.webNavigation.getFrame
// result resolved from the sender's document id (or null when it could not be
// resolved). run_pipeline and add_to_trusted share this exact decision.
export function classifyTopFrameForJob(sender, frame) {
  const senderDocumentId = sender?.documentId;
  if (typeof senderDocumentId !== "string" || senderDocumentId === "") {
    return { ok: false, reason: CANCELLATION_REASONS.STALE_SENDER_DOCUMENT };
  }
  // A resolved frame whose document id no longer matches the sender's means the
  // top document was replaced after the message was posted: the sender is stale.
  if (frame === null || frame === undefined || frame.documentId !== senderDocumentId) {
    return { ok: false, reason: CANCELLATION_REASONS.STALE_SENDER_DOCUMENT };
  }
  if (frame.documentLifecycle !== "active") {
    return { ok: false, reason: CANCELLATION_REASONS.DOCUMENT_INACTIVE };
  }
  if (typeof frame.url !== "string" || frame.url === "") {
    return { ok: false, reason: CANCELLATION_REASONS.DOCUMENT_INACTIVE };
  }
  return { ok: true, url: frame.url, documentId: frame.documentId };
}

// Safe comparison data for a cancellation diagnostics record (issue #18). Only
// the equality booleans, the event source, and the job kind are returned --
// never the URLs themselves, because authentication URLs carry request, nonce,
// and state values in their query strings that must not be stored.
export function navigationDiagnostics({ context = "detection", source, job = null, url, documentId } = {}) {
  return {
    context: typeof context === "string" && context !== "" ? context : "detection",
    source: typeof source === "string" && source !== "" ? source : "unknown",
    urlEqual: job !== null && job !== undefined && job.url === url,
    documentEqual:
      job !== null && job !== undefined &&
      typeof job.documentId === "string" && job.documentId !== "" &&
      job.documentId === documentId,
  };
}

// Cancellation has two independent effects: invalidating the computation and
// presenting that invalidation to the user. Keeping the presentation decision
// pure makes it impossible for a later cleanup path to accidentally turn an
// ordinary-navigation cancellation back into a warning.
export function cancellationPresentation(interruptionMode, { resetContent = false } = {}) {
  const silent = interruptionMode === "silent";
  return {
    notifyInterrupted: !silent,
    resetContent: silent && resetContent,
    scheduleInterruption: !silent,
  };
}
