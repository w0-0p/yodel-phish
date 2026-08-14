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
