// =============================================================================
// ACTION POPUP — issue #51. The toolbar button now opens this menu instead of
// firing an analysis directly. The service worker still owns the analysis flow
// and the icon feedback (issue #15); the popup only asks for it and says what
// came back.
// =============================================================================

const runButton = document.getElementById("run-analysis");
const reportButton = document.getElementById("report-issue");
const reportPanel = document.getElementById("report-panel");
const statusLine = document.getElementById("status");

runButton.addEventListener("click", () => {
  void runManualAnalysis();
});

document.getElementById("open-settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

reportButton.addEventListener("click", () => {
  reportPanel.hidden = !reportPanel.hidden;
  reportButton.setAttribute("aria-expanded", String(!reportPanel.hidden));
});

async function runManualAnalysis() {
  runButton.disabled = true;
  showStatus("Starting…");
  const response = await requestManualAnalysis();
  // A started analysis announces itself on the page and on the icon, so the
  // popup gets out of the way rather than repeating it.
  if (response?.started === true) {
    window.close();
    return;
  }
  runButton.disabled = false;
  showStatus(response?.message ?? "Could not start the analysis. Try again.");
}

async function requestManualAnalysis() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return null;
    return await chrome.runtime.sendMessage({ type: "request_manual_analysis", tabId: tab.id });
  } catch {
    return null;
  }
}

function showStatus(text) {
  statusLine.textContent = text;
  statusLine.hidden = false;
}
