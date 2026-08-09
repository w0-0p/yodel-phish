// Clipboard mediation shares Chrome's one permitted offscreen document with
// the detection runtime. Keep that document lightweight until the worker asks
// for an inference-runtime ping; an ordinary clipboard write must not load and
// retain OpenCV, ONNX runtimes, and the model stack.
const OPENCV_READY_TIMEOUT_MS = 30_000;
const OPENCV_POLL_INTERVAL_MS = 50;
const OFFSCREEN_TARGET = "yodel-offscreen";
const SERVICE_WORKER_URL = chrome.runtime.getURL("dist/service_worker.js");

let startupState = "idle";
let startedAt = 0;

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.target !== OFFSCREEN_TARGET || message.type !== "ping") return false;
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined || sender.url !== SERVICE_WORKER_URL) {
    return false;
  }
  startDetectionRuntime();
  // The detection bundle answers a later readiness ping after its services
  // are fully initialized. The bootstrap intentionally does not claim this
  // message or report premature readiness.
  return false;
});

function startDetectionRuntime() {
  if (startupState !== "idle") return;
  startupState = "loading_opencv";
  startedAt = Date.now();

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("opencv/opencv.js");
  script.onerror = () => reportStartupFailure("opencv_load_failed");
  document.body.appendChild(script);
  pollForOpenCv();
}

function isOpenCvUsable() {
  if (globalThis.cv?.Mat === undefined) return false;
  try {
    const probe = new globalThis.cv.Mat();
    probe.delete();
    return true;
  } catch {
    return false;
  }
}

function pollForOpenCv() {
  if (startupState !== "loading_opencv") return;
  if (isOpenCvUsable()) {
    injectDetectionBundle();
    return;
  }
  if (Date.now() - startedAt >= OPENCV_READY_TIMEOUT_MS) {
    reportStartupFailure("opencv_timeout");
    return;
  }
  setTimeout(pollForOpenCv, OPENCV_POLL_INTERVAL_MS);
}

function injectDetectionBundle() {
  if (startupState !== "loading_opencv") return;
  startupState = "loading_bundle";
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("dist/offscreen.js");
  script.onerror = () => reportStartupFailure("offscreen_bundle_load_failed");
  document.body.appendChild(script);
}

function reportStartupFailure(reason) {
  if (startupState === "failed") return;
  startupState = "failed";
  chrome.runtime.sendMessage({ type: "offscreen_runtime_failed", reason }).catch(() => {});
}
