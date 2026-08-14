import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cancellationPresentation,
  jobMatchesAddress,
  jobMatchesSameDocumentState,
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
