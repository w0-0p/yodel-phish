// Chrome-specific coordinator. It receives chrome.runtime messages and
// connects queue tickets to the inference Worker.
import { OffscreenQueue, SchedulerError } from "../background/offscreenQueue.mjs";
import {
  GLOBAL_OFFSCREEN_CONCURRENCY,
  OFFSCREEN_QUEUE_CAPACITY,
  OFFSCREEN_REQUEST_TIMEOUT_MS,
  QUEUE_WAIT_TIMEOUT_MS,
} from "../background/inferenceLimits.mjs";
import { InferenceWorkerClient } from "./inferenceWorkerClient.mjs";

const TARGET = "yodel-offscreen";
const SERVICE_WORKER_URL = chrome.runtime.getURL("dist/service_worker.js");
const inferenceWorker = new InferenceWorkerClient({
  workerUrl: chrome.runtime.getURL("dist/inference_worker.js"),
});

const inferenceQueue = new OffscreenQueue({
  concurrency: GLOBAL_OFFSCREEN_CONCURRENCY,
  maxQueueLength: OFFSCREEN_QUEUE_CAPACITY,
  queueWaitTimeoutMs: QUEUE_WAIT_TIMEOUT_MS,
  onTimeout: (ticket) => {
    chrome.runtime.sendMessage({
      type: "offscreen_recycle_requested",
      ticketId: ticket.ticketId,
      reason: "request_timeout",
    }).catch(() => {});
  },
});

// Readiness includes Worker creation plus OpenCV/model-service initialization.
// The clipboard-only offscreen document remains lightweight until the first
// inference ping causes this bundle to be loaded.
const servicesPromise = inferenceWorker.ready().catch((error) => {
  const reason = `service_init_failed: ${error instanceof Error ? error.message : String(error)}`;
  console.error("[YodelPhish:offscreen] Inference Worker failed to start:", error);
  chrome.runtime.sendMessage({ type: "offscreen_runtime_failed", reason }).catch(() => {});
  throw error;
});
servicesPromise.catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== TARGET) return false;
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined || sender.url !== SERVICE_WORKER_URL) {
    return false;
  }

  handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      console.error("[YodelPhish:offscreen] Detection job failed:", error);
      sendResponse({
        ok: false,
        code: error instanceof SchedulerError ? error.code : "offscreen_request_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
});

async function handleMessage(message) {
  if (message.type === "ping") {
    await servicesPromise;
    return { ready: true };
  }

  if (message.type === "cancel_tab") {
    return inferenceQueue.cancel(message.tabId, message.reason ?? "cancelled", {
      ticketId: message.ticketId,
    });
  }

  if (!Number.isInteger(message.tabId)) {
    throw new Error("Offscreen request is missing a valid tab ID");
  }

  return inferenceQueue.schedule(
    message.tabId,
    () => inferenceWorker.run(message, message.ticketId),
    {
      requestTimeoutMs: OFFSCREEN_REQUEST_TIMEOUT_MS,
      ticketId: message.ticketId,
      // This is the crucial difference from the old caller-only cancellation:
      // terminating the dedicated Worker stops the real ONNX/OCR/OpenCV task,
      // so a manual selection can use a fresh runtime instead of waiting behind
      // abandoned automatic detection.
      cancelRun: (reason) => inferenceWorker.terminate(message.ticketId, reason),
    }
  );
}
