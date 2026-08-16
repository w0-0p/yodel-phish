// Clipboard mediation shares Chrome's one permitted offscreen document with
// the detection runtime. Keep that document lightweight until the worker asks
// for an inference-runtime ping; an ordinary clipboard write must not load the
// coordinator or its dedicated OpenCV/OCR/ONNX Worker.
const OFFSCREEN_TARGET = "yodel-offscreen";
const SERVICE_WORKER_URL = chrome.runtime.getURL("dist/service_worker.js");

let startupState = "idle";

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
  injectDetectionBundle();
}

function injectDetectionBundle() {
  if (startupState !== "idle") return;
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
