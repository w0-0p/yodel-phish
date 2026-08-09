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
