// Inline SVG rather than text symbols like "⚠"/"ⓘ", which depend on the
// installed fonts and render inconsistently at this size. Filled with
// currentColor so each warning kind's own text color applies.
const WARNING_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`;
const INFO_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`;

// Emphasis is built from real elements whose text is set with textContent,
// never from inline markup, so warning copy can never carry markup into the
// page even if a future message interpolates a value.
function emphasized(text, { underline = false } = {}) {
  const bold = document.createElement("strong");
  if (!underline) {
    bold.textContent = text;
    return bold;
  }
  const underlined = document.createElement("u");
  underlined.textContent = text;
  bold.appendChild(underlined);
  return bold;
}

// Clipboard values are security-sensitive evidence. Never place raw control,
// formatting, or policy-invisible characters in the warning UI: bidi controls
// can reorder what the user sees, while zero-width and line-control characters
// can conceal the command's actual structure. This is a display-only transform;
// approval remains keyed to the untouched value held by the service worker.
const CLICKFIX_DIAGNOSTIC_ESCAPE_RE =
  /[\p{Cc}\p{Cf}\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF]/gu;

function clickfixDiagnosticPreview(value) {
  return String(value ?? "").replace(CLICKFIX_DIAGNOSTIC_ESCAPE_RE, (character) => {
    if (character === "\t") return "⟦TAB⟧";
    if (character === "\n") return "⟦LF⟧\n";
    if (character === "\r") return "⟦CR⟧";
    const codePoint = character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    return `⟦U+${codePoint}⟧`;
  });
}

// The action badge mirrors the page on screen (issue #76). Navigating here
// cleared whatever badge the analysed page had set, and no content script runs
// on an extension page, so each warning re-asserts its own alert: "blocked"
// (blinking red cross) for a blocking page, "interrupted"/"suspicious" (orange
// "!") for a warn-level one. Only asserted when a real warning is displayed --
// a page whose record no longer exists has nothing left to alert about.
function showBadge(state, title) {
  chrome.runtime.sendMessage({ type: "set_icon_state", state, title }).catch(() => {});
}

document.addEventListener("DOMContentLoaded", async () => {
  // Issue #29: ClickFix has its own entry point, and the kind follows the
  // document rather than the query string. clickfix.html can therefore never
  // render another kind's copy, and interstitial.html -- whose static markup
  // carries the phishing heading -- can never be talked into rendering a
  // clipboard warning by an edited "?kind=".
  const requestedKind = new URLSearchParams(location.search).get("kind");
  const kind = /(?:^|\/)clickfix\.html$/.test(location.pathname)
    ? "clickfix"
    : requestedKind === "interrupted" || requestedKind === "device_flow"
      ? requestedKind
      : "phishing";

  const brandEl = document.getElementById("yp-brand");
  const iconEl = document.getElementById("yp-icon");
  const titleEl = document.getElementById("yp-title");
  const messageEl = document.getElementById("yp-message");
  const hintEl = document.getElementById("yp-hint");
  const commandReasonEl = document.getElementById("yp-command-reason");
  const commandLabelEl = document.getElementById("yp-command-label");
  const commandPreviewEl = document.getElementById("yp-command-preview");
  const closeBtn = document.getElementById("yp-btn-close");
  const proceedBtn = document.getElementById("yp-btn-proceed");
  const reanalyseBtn = document.getElementById("yp-btn-reanalyse");
  const continueBtn = document.getElementById("yp-btn-continue");
  const leaveBtn = document.getElementById("yp-btn-leave");

  // Issue #62: every interstitial names itself and its severity above the
  // heading. "Alert" is a blocking page (red), "Warning" a warn-level one
  // (orange) — the same split the background colour and the action badge
  // already make. It travels with showBadge because both answer the same
  // question, and because the states that display no warning at all (an
  // interruption or phishing record that no longer exists) call neither and
  // correctly keep the plain brand line. A ClickFix page has no such state: it
  // either renders its verdict or closes itself (issue #29).
  function announce(severity, badgeState, badgeTitle) {
    brandEl.textContent = severity === "alert" ? "Yodel Phish Alert" : "Yodel Phish Warning";
    showBadge(badgeState, badgeTitle);
  }

  // The preview documents a blocked command; it must not be a copy source
  // itself. user-select:none prevents selection, these close the remaining
  // context-menu and clipboard-event paths.
  for (const type of ["copy", "cut", "contextmenu"]) {
    commandPreviewEl.addEventListener(type, (event) => event.preventDefault());
  }

  if (kind === "clickfix") {
    document.title = "Clipboard warning — Yodel Phish";
    iconEl.innerHTML = WARNING_ICON;
    closeBtn.textContent = "Cancel";

    // State before navigation (issue #29): the background persists the verdict
    // bound to this exact tab and only then navigates the tab here, the way the
    // phishing and device-code pages already work. One lookup is therefore
    // authoritative -- there is no binding race left to retry against, so the
    // five-second retry loop and the expired-request page it fed are gone.
    const response = await chrome.runtime.sendMessage({ type: "get_clickfix_warning" }).catch(() => undefined);

    // A lookup that still fails means the record was removed or corrupted from
    // outside this flow. Nothing has been painted yet, and there is no honest
    // page to show: ask the background to take the tab down and hand focus back
    // to the page the request came from.
    if (response?.ok !== true) {
      chrome.runtime.sendMessage({ type: "clickfix_warning_unavailable" }).catch(() => {});
      return;
    }

    const strict = response.mode !== "warn";
    document.body.classList.add(strict ? "yp-kind-clickfix-block" : "yp-kind-clickfix-warn");
    titleEl.textContent = strict ? "Dangerous command blocked" : "Potentially dangerous command";
    announce(
      strict ? "alert" : "warning",
      strict ? "blocked" : "suspicious",
      `Yodel Phish — ${titleEl.textContent}`
    );
    messageEl.textContent = strict
      ? `${response.source_host} attempted to place a system command on your clipboard. It was not copied.`
      : `${response.source_host} attempted to place this command on your clipboard.`;
    hintEl.textContent =
      "Pasting commands from websites into Run, PowerShell, Command Prompt, or Terminal can install malware. " +
      "Continue only if you understand the command and intended to run it.";
    const explanation = [];
    if (typeof response.tool === "string" && response.tool !== "") {
      explanation.push(`Detected command tool: ${response.tool}.`);
    }
    if (typeof response.behavior === "string" && response.behavior !== "") {
      explanation.push(`Risky behavior: ${response.behavior}.`);
    }
    if (explanation.length === 0 && Array.isArray(response.reasons)) {
      const safeReasons = response.reasons
        .filter((reason) => typeof reason === "string" && reason !== "")
        .slice(0, 4);
      if (safeReasons.length > 0) explanation.push(`Reason: ${safeReasons.join("; ")}.`);
    }
    if (explanation.length > 0) {
      commandReasonEl.textContent = explanation.join(" ");
      commandReasonEl.hidden = false;
    }
    commandPreviewEl.textContent = clickfixDiagnosticPreview(response.text);
    commandLabelEl.hidden = false;
    commandPreviewEl.hidden = false;

    if (!strict) {
      proceedBtn.hidden = false;
      proceedBtn.textContent = "Copy underlying text anyway";
      proceedBtn.addEventListener("click", async function approveClickfix() {
        if (!this.dataset.confirm) {
          this.dataset.confirm = "1";
          this.textContent = "Confirm — copy underlying text";
          this.classList.add("yp-btn-proceed-confirm");
          return;
        }
        this.disabled = true;
        const result = await chrome.runtime.sendMessage({ type: "clickfix_copy_anyway" }).catch(() => undefined);
        if (result?.ok === true) {
          // The confirmation click was the user's last required action
          // (issue #3): the text is on the clipboard, so close immediately
          // and hand focus back to the original page.
          chrome.runtime.sendMessage({ type: "close_tab" }).catch(() => {});
          return;
        }
        proceedBtn.hidden = true;
        closeBtn.textContent = "Return to page";
        titleEl.textContent = "Command not copied";
        messageEl.textContent = "The clipboard request expired or the protected write failed.";
        hintEl.textContent = "Return to the original page and retry only if you still intend to copy it.";
        titleEl.focus({ preventScroll: true });
      });
    }

    closeBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "clickfix_cancel" }).catch(() => undefined);
      await chrome.runtime.sendMessage({ type: "close_tab" }).catch(() => undefined);
    });

    // The card carries the real verdict now; this is the page's first paint.
    document.body.classList.remove("yp-kind-clickfix-pending");
    titleEl.focus({ preventScroll: true });
    return;
  }

  // Issues #39/#75 — the provider page itself is authentic, so this is never
  // worded as impersonation; only the requested action (entering a code
  // supplied by someone else) is unsafe. This is a hard block mirroring the
  // phishing interstitial: it offers no proceed action (issue #93).
  if (kind === "device_flow") {
    document.title = "Device-code phishing risk — Yodel Phish";
    document.body.classList.add("yp-kind-device-flow");
    iconEl.innerHTML = WARNING_ICON;
    titleEl.textContent = "Device-code phishing risk";
    closeBtn.textContent = "Close tab";

    const response = await chrome.runtime.sendMessage({ type: "get_device_flow_warning" }).catch(() => undefined);
    if (response?.ok !== true) {
      messageEl.textContent = "No active device-code warning was found for this tab. You can close this page.";
      hintEl.textContent = "";
    } else {
      const provider = response.provider ?? "this provider";
      const sourceFqdn = typeof response.source_fqdn === "string" ? response.source_fqdn : null;
      // "policy": Device Code Authentication is blocked in settings, whatever
      // the navigation source. Otherwise the block is source-correlated.
      if (response.reason === "policy") {
        titleEl.textContent = "Device-code sign-in blocked";
        messageEl.textContent = sourceFqdn === null
          ? `This is the official ${provider} Device Code Login page. Device Code Authentication is blocked by your settings.`
          : `Official ${provider} Device Code Login page opened by ${sourceFqdn}. Device Code Authentication is blocked by your settings.`;
      } else {
        messageEl.textContent = `Official ${provider} Device Code Login page opened by ${sourceFqdn ?? "another website"}.`;
      }
      announce("alert", "blocked", `Yodel Phish — ${titleEl.textContent}`);
      hintEl.replaceChildren(
        emphasized(
          "Entering a code supplied by another person or website could authorize an application or device " +
          "controlled by someone else."
        ),
        document.createElement("br"),
        document.createTextNode("Close this tab."),
      );
    }

    closeBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "close_tab" }).catch(() => {});
    });
    titleEl.focus({ preventScroll: true });
    return;
  }

  if (kind === "interrupted") {
    document.title = "Analysis interrupted — Yodel Phish";
    document.body.classList.add("yp-kind-interrupted");
    closeBtn.hidden = true;
    iconEl.innerHTML = INFO_ICON;
    titleEl.textContent = "Analysis interrupted";

    const response = await chrome.runtime.sendMessage({ type: "get_interruption_state" }).catch(() => undefined);
    if (response?.ok !== true) {
      hintEl.textContent = "";
      messageEl.textContent = "No active interruption was found for this tab. You can close this page.";
      closeBtn.hidden = false;
      closeBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "close_tab" }).catch(() => {});
      });
    } else {
      hintEl.textContent = "Re-analyse for a current result, or continue unverified if this change was expected.";
      messageEl.textContent = "The displayed page changed in a way that may affect the security result.";
      if (response.reason) {
        const reasonEl = document.createElement("p");
        reasonEl.className = "yp-hint";
        reasonEl.textContent = response.reason;
        messageEl.after(reasonEl);
      }
      reanalyseBtn.hidden = false;
      continueBtn.hidden = false;
      leaveBtn.hidden = false;
      announce("warning", "interrupted", "Yodel Phish — analysis interrupted");
    }

    reanalyseBtn.addEventListener("click", async () => {
      reanalyseBtn.disabled = true;
      const result = await chrome.runtime.sendMessage({ type: "reanalyse_interrupted" }).catch(() => undefined);
      if (result?.ok !== true) {
        reanalyseBtn.disabled = false;
        messageEl.textContent = "The original page is no longer available. Choose another action.";
      }
    });

    continueBtn.addEventListener("click", async () => {
      continueBtn.disabled = true;
      const result = await chrome.runtime.sendMessage({ type: "continue_interrupted" }).catch(() => undefined);
      if (result?.ok !== true) {
        continueBtn.disabled = false;
        messageEl.textContent = "The original page is no longer available. You can leave this page.";
      }
    });

    leaveBtn.addEventListener("click", async () => {
      leaveBtn.disabled = true;
      const result = await chrome.runtime.sendMessage({ type: "leave_interrupted_page" }).catch(() => undefined);
      if (result?.ok !== true) leaveBtn.disabled = false;
    });
    if (response?.ok === true) {
      await chrome.runtime.sendMessage({ type: "interruption_ui_ready" }).catch(() => undefined);
    }
    return;
  }

  // kind === "phishing". The body class only scopes styling: every other kind
  // already sets one, and the hint here is the page's key instruction. This is
  // a hard block with no proceed action (issue #93): a false positive is
  // resolved by adding the exact hostname to Trusted or Muted Sites in
  // Advanced Settings, never by walking through the warning.
  document.body.classList.add("yp-kind-phishing");
  closeBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "close_tab" }).catch(() => {});
  });
  const response = await chrome.runtime.sendMessage({ type: "get_phishing_warning" }).catch(() => undefined);

  if (response?.ok !== true) {
    messageEl.textContent = "No active phishing warning was found for this tab. You can close this page.";
  } else {
    const fqdn = response.fqdn ?? "This site";
    const bestMatch = response.best_match_fqdn ?? "a trusted site";
    messageEl.textContent = `${fqdn} is highly likely impersonating ${bestMatch}.`;
    announce("alert", "blocked", "Yodel Phish — deceptive site blocked");
  }
});
