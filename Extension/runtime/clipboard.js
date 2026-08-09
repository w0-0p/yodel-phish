// Lightweight clipboard endpoint loaded immediately by the offscreen page.
// It does not wait for OpenCV or the inference bundle, so ordinary clipboard
// mediation does not depend on model initialization.
(function installClickfixClipboardWriter() {
  const TARGET = "yodel-clickfix-clipboard";
  const SERVICE_WORKER_URL = chrome.runtime.getURL("dist/service_worker.js");
  const MAX_TEXT_LENGTH = 65_536;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== TARGET) return false;
    if (sender.id !== chrome.runtime.id || sender.tab !== undefined || sender.url !== SERVICE_WORKER_URL) {
      return false;
    }
    if (message.type !== "write_text" || typeof message.text !== "string" ||
        message.text.length > MAX_TEXT_LENGTH) {
      sendResponse({ ok: false, error: "Invalid clipboard request" });
      return false;
    }

    // navigator.clipboard.writeText is unusable here: the async Clipboard API
    // requires a focused document, and an offscreen document is never focused,
    // so every write rejects with "Document is not focused". Copying a
    // selected textarea with execCommand is the supported offscreen
    // CLIPBOARD path and needs no focus.
    try {
      const textarea = document.createElement("textarea");
      textarea.value = message.text;
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("The offscreen document refused the copy command");
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  });
})();
