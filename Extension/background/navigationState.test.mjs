import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANCELLATION_REASONS,
  cancellationPresentation,
  classifyTopFrameForJob,
  jobMatchesAddress,
  jobMatchesSameDocumentState,
  navigationDiagnostics,
} from "./navigationState.mjs";

const job = {
  url: "https://example.test/app#signin",
  documentId: "document-login",
};

test("an address notification for the active job's own URL is already represented", () => {
  assert.equal(jobMatchesAddress(job, job.url), true);
  assert.equal(jobMatchesAddress(job, "https://example.test/app#home"), false);
  assert.equal(jobMatchesAddress(null, job.url), false);
});

test("same-document state requires both the exact URL and exact document", () => {
  assert.equal(jobMatchesSameDocumentState(job, {
    url: job.url,
    documentId: job.documentId,
  }), true);
  assert.equal(jobMatchesSameDocumentState(job, {
    url: "https://example.test/app#home",
    documentId: job.documentId,
  }), false);
  assert.equal(jobMatchesSameDocumentState(job, {
    url: job.url,
    documentId: "replacement-document",
  }), false);
});

test("a job without a stable document identity never matches a same-document event", () => {
  assert.equal(jobMatchesSameDocumentState({ ...job, documentId: null }, {
    url: job.url,
    documentId: null,
  }), false);
  assert.equal(jobMatchesSameDocumentState({ ...job, documentId: "" }, {
    url: job.url,
    documentId: "",
  }), false);
});

test("ordinary-navigation cancellation resets surviving content without warning", () => {
  assert.deepEqual(cancellationPresentation("silent", { resetContent: true }), {
    notifyInterrupted: false,
    resetContent: true,
    scheduleInterruption: false,
  });
});

test("decision-required cancellation still warns and opens the interruption flow", () => {
  assert.deepEqual(cancellationPresentation("decision_required", { resetContent: true }), {
    notifyInterrupted: true,
    resetContent: false,
    scheduleInterruption: true,
  });
});

const activeFrame = {
  documentId: "document-login",
  documentLifecycle: "active",
  url: "https://accounts.example.test/authenticate?view=verify-email",
};

test("a resolved active top frame anchors the job to its own URL and document", () => {
  assert.deepEqual(
    classifyTopFrameForJob({ documentId: "document-login" }, activeFrame),
    { ok: true, url: activeFrame.url, documentId: "document-login" }
  );
});

test("a sender without a document id can never start a job", () => {
  for (const documentId of [undefined, "", null, 42]) {
    assert.deepEqual(classifyTopFrameForJob({ documentId }, activeFrame), {
      ok: false,
      reason: CANCELLATION_REASONS.STALE_SENDER_DOCUMENT,
    });
  }
});

test("a sender whose document no longer matches the live top frame is stale", () => {
  assert.deepEqual(
    classifyTopFrameForJob({ documentId: "document-login" }, { ...activeFrame, documentId: "document-replaced" }),
    { ok: false, reason: CANCELLATION_REASONS.STALE_SENDER_DOCUMENT }
  );
  assert.deepEqual(
    classifyTopFrameForJob({ documentId: "document-login" }, null),
    { ok: false, reason: CANCELLATION_REASONS.STALE_SENDER_DOCUMENT }
  );
});

test("an inactive or urlless top frame cannot anchor a job", () => {
  assert.deepEqual(
    classifyTopFrameForJob({ documentId: "document-login" }, { ...activeFrame, documentLifecycle: "pending" }),
    { ok: false, reason: CANCELLATION_REASONS.DOCUMENT_INACTIVE }
  );
  assert.deepEqual(
    classifyTopFrameForJob({ documentId: "document-login" }, { ...activeFrame, url: "" }),
    { ok: false, reason: CANCELLATION_REASONS.DOCUMENT_INACTIVE }
  );
});

test("navigation diagnostics report equality booleans and the source, never URLs", () => {
  const diagnostics = navigationDiagnostics({
    context: "add_to_trusted",
    source: "webNavigation.onHistoryStateUpdated",
    job,
    url: job.url,
    documentId: "replacement-document",
  });
  assert.deepEqual(diagnostics, {
    context: "add_to_trusted",
    source: "webNavigation.onHistoryStateUpdated",
    urlEqual: true,
    documentEqual: false,
  });
  // The authentication URL and its sensitive query string never appear in the
  // stored record (issue #18).
  assert.equal(JSON.stringify(diagnostics).includes(job.url), false);
});

test("navigation diagnostics fall back to safe defaults for a missing job or source", () => {
  assert.deepEqual(navigationDiagnostics({ url: "https://example.test/x", documentId: "d" }), {
    context: "detection",
    source: "unknown",
    urlEqual: false,
    documentEqual: false,
  });
});
