(function () {
  if (window.__YP_SELECTOR_ACTIVE__) return;
  window.__YP_SELECTOR_ACTIVE__ = true;

  const config = window.__YP_SELECTOR_CONFIG__ ?? {};
  const fqdn = config.fqdn ?? "";
  // Issue #24: the background binds this overlay to one selection session. The
  // id travels with every message so an overlay left behind by an earlier
  // session cannot save a crop into, or cancel, the session that replaced it.
  const sessionId = config.sessionId ?? "";

  // Issue #90: an add-to-trusted session sends along YOLO's proposals as
  // viewport-ratio rectangles for the user to confirm, edit or replace. They
  // were measured on the analysis screenshot, so anything that is not a finite
  // rectangle inside the viewport is dropped rather than drawn somewhere
  // misleading. Best score first; the best one starts out selected.
  const candidates = (Array.isArray(config.candidates) ? config.candidates : [])
    .filter((candidate) =>
      ["xRatio", "yRatio", "widthRatio", "heightRatio"].every(
        (key) => typeof candidate?.[key] === "number" && Number.isFinite(candidate[key])
      ) &&
      candidate.widthRatio > 0 && candidate.heightRatio > 0 &&
      candidate.xRatio >= 0 && candidate.yRatio >= 0 &&
      candidate.xRatio + candidate.widthRatio <= 1 &&
      candidate.yRatio + candidate.heightRatio <= 1)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));

  // Issue #14: why this selector opened without suggestions. Like a failure
  // code, it is a code the background sends and this file maps to fixed
  // wording — never display text the background chose. It explains a fallback,
  // not a failure, so it is styled as a notice rather than as an error.
  const NOTICE_MESSAGES = Object.freeze({
    logo_search_timeout: "The logo detection took too long, please select the logo manually",
  });
  const noticeText = NOTICE_MESSAGES[config.notice] ?? "";

  const host = document.createElement("div");
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    #overlay {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      cursor: crosshair;
      user-select: none;
      font-family: system-ui, -apple-system, sans-serif;
    }
    #backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
    }
    #instructions {
      position: absolute;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.82);
      color: #fff;
      padding: 9px 18px;
      border-radius: 6px;
      font-size: 14px;
      white-space: nowrap;
      pointer-events: none;
    }
    #notice {
      position: absolute;
      top: 58px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(230, 81, 0, 0.92);
      color: #fff;
      padding: 8px 18px;
      border-radius: 6px;
      font-size: 13px;
      display: none;
      max-width: 70vw;
      white-space: normal;
      text-align: center;
      pointer-events: none;
    }
    #selection {
      position: absolute;
      border: 2px solid #1976d2;
      background: rgba(25, 118, 210, 0.15);
      display: none;
      pointer-events: none;
      box-sizing: border-box;
    }
    .candidate {
      position: absolute;
      border: 2px dashed rgba(255, 255, 255, 0.65);
      background: rgba(128, 128, 128, 0.25);
      pointer-events: none;
      box-sizing: border-box;
    }
    #toolbar {
      position: absolute;
      display: none;
      flex-direction: row;
      gap: 8px;
    }
    .yp-btn {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 500;
      padding: 7px 15px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      line-height: 1;
    }
    #btn-confirm { background: #1976d2; color: #fff; }
    #btn-confirm:hover { background: #1565c0; }
    #btn-redo { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,0.55); }
    #btn-redo:hover { border-color: #fff; }
    #btn-cancel { background: #555; color: #fff; }
    #btn-cancel:hover { background: #333; }
    .yp-btn:disabled { opacity: 0.65; cursor: default; }
    #btn-confirm:disabled:hover { background: #1976d2; }
    #btn-redo:disabled:hover { border-color: rgba(255,255,255,0.55); }
    #btn-cancel:disabled:hover { background: #555; }
    #error-msg {
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #b71c1c;
      color: #fff;
      padding: 9px 18px;
      border-radius: 6px;
      font-size: 13px;
      display: none;
      max-width: 70vw;
      white-space: normal;
      text-align: center;
      pointer-events: none;
    }
  `;
  shadow.appendChild(style);

  const overlay = document.createElement("div");
  overlay.id = "overlay";

  const backdrop = document.createElement("div");
  backdrop.id = "backdrop";

  const DRAW_INSTRUCTIONS = fqdn
    ? `Draw a rectangle around the logo for ${fqdn}`
    : "Draw a rectangle around the logo";
  const SELECT_INSTRUCTIONS = fqdn
    ? `Select or edit the logo area for ${fqdn}`
    : "Select or edit the logo area";

  const instructions = document.createElement("div");
  instructions.id = "instructions";
  instructions.textContent = candidates.length > 0 ? SELECT_INSTRUCTIONS : DRAW_INSTRUCTIONS;

  const notice = document.createElement("div");
  notice.id = "notice";
  if (noticeText !== "") {
    notice.textContent = noticeText;
    notice.style.display = "block";
  }

  const selectionEl = document.createElement("div");
  selectionEl.id = "selection";

  const toolbar = document.createElement("div");
  toolbar.id = "toolbar";

  const btnConfirm = document.createElement("button");
  btnConfirm.id = "btn-confirm";
  btnConfirm.className = "yp-btn";
  btnConfirm.textContent = "Confirm logo";

  const btnRedo = document.createElement("button");
  btnRedo.id = "btn-redo";
  btnRedo.className = "yp-btn";
  btnRedo.textContent = "Redraw";

  const btnCancel = document.createElement("button");
  btnCancel.id = "btn-cancel";
  btnCancel.className = "yp-btn";
  btnCancel.textContent = "Cancel";

  toolbar.appendChild(btnConfirm);
  toolbar.appendChild(btnRedo);
  toolbar.appendChild(btnCancel);

  const errorMsg = document.createElement("div");
  errorMsg.id = "error-msg";

  // One box per suggestion, purely visual (no pointer events): selecting a
  // suggestion is hit-tested in the overlay's own mouse handlers so a drag can
  // still start on top of one to redraw over that area.
  const candidateEls = candidates.map((candidate, index) => {
    const box = document.createElement("div");
    box.id = `candidate-${index}`;
    box.className = "candidate";
    const rect = candidatePxRect(candidate);
    box.style.left = rect.x + "px";
    box.style.top = rect.y + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
    return box;
  });

  overlay.appendChild(backdrop);
  for (const candidateEl of candidateEls) overlay.appendChild(candidateEl);
  overlay.appendChild(instructions);
  overlay.appendChild(notice);
  overlay.appendChild(selectionEl);
  overlay.appendChild(toolbar);
  overlay.appendChild(errorMsg);
  shadow.appendChild(overlay);

  // The background never sends display text: a code is mapped to a fixed
  // message here, so a failure can never render raw internal error text.
  const FAILURE_MESSAGES = Object.freeze({
    capture_failed: "This page could not be captured. Make sure this tab is visible, then confirm again.",
    preprocess_failed: "That selection could not be processed. Redraw around the logo and confirm again.",
    save_failed: "The logo could not be saved. Please confirm again.",
    entry_missing: "That trusted entry no longer exists — it was removed while this logo was being processed. Cancel and add the site again.",
    variant_capped: "This site already has the maximum number of saved references. Remove one in settings, then confirm again.",
    selector_inactive: "This selection is no longer active. Cancel and start again.",
    tab_inactive: "This tab was not in the foreground. Bring it back to the front, then confirm again.",
    page_changed: "This tab is no longer showing " + fqdn + ". Go back to it, then confirm again.",
    capture_interrupted: "The tab or page changed during capture. Keep this page in front, then confirm again.",
    dispatch_failed: "The extension background process could not be reached. Please confirm again.",
    job_timeout: "Processing took too long. Please confirm again.",
    selection_failed: "Processing failed. Please confirm again.",
  });

  let isDragging = false;
  let pendingClick = false;
  let startX = 0;
  let startY = 0;
  let currentRect = null;
  let activeCandidate = null;
  // While a confirmation is in flight the overlay stays up but inert: the
  // selection it describes must not change under the request, and the result
  // has to land somewhere the user can see.
  let processing = false;

  function candidatePxRect(candidate) {
    return {
      x: candidate.xRatio * window.innerWidth,
      y: candidate.yRatio * window.innerHeight,
      width: candidate.widthRatio * window.innerWidth,
      height: candidate.heightRatio * window.innerHeight,
    };
  }

  // The smallest suggestion under the point wins, so a logo box nested inside
  // a larger proposal stays clickable.
  function candidateAt(clientX, clientY) {
    let best = null;
    let bestArea = Infinity;
    candidates.forEach((candidate, index) => {
      const rect = candidatePxRect(candidate);
      const inside = clientX >= rect.x && clientX <= rect.x + rect.width &&
        clientY >= rect.y && clientY <= rect.y + rect.height;
      const area = rect.width * rect.height;
      if (inside && area < bestArea) {
        best = index;
        bestArea = area;
      }
    });
    return best;
  }

  function positionToolbar(rect) {
    const tbBottom = rect.y + rect.height + 8 + 36;
    const tbTop = tbBottom < window.innerHeight ? (rect.y + rect.height + 8) : (rect.y - 44);
    // Measured after it is displayed, so a selection at the right edge cannot
    // push the buttons off screen.
    toolbar.style.display = "flex";
    const toolbarWidth = toolbar.offsetWidth ?? 0;
    const left = Math.max(8, Math.min(rect.x, window.innerWidth - toolbarWidth - 8));
    toolbar.style.left = left + "px";
    toolbar.style.top = tbTop + "px";
  }

  // The selected suggestion is shown with the same selection box and toolbar a
  // drawn rectangle gets; the others stay visible but grayed out. Confirming
  // it sends the suggestion's own ratios, untouched by the px round trip.
  function activateCandidate(index) {
    const candidate = candidates[index];
    const rect = candidatePxRect(candidate);
    activeCandidate = index;
    isDragging = false;
    currentRect = {
      ...rect,
      ratios: {
        xRatio: candidate.xRatio,
        yRatio: candidate.yRatio,
        widthRatio: candidate.widthRatio,
        heightRatio: candidate.heightRatio,
      },
    };
    candidateEls.forEach((candidateEl, elIndex) => {
      candidateEl.style.display = elIndex === index ? "none" : "";
    });
    selectionEl.style.left = rect.x + "px";
    selectionEl.style.top = rect.y + "px";
    selectionEl.style.width = rect.width + "px";
    selectionEl.style.height = rect.height + "px";
    selectionEl.style.display = "block";
    // Unlike a drawn rectangle, a pre-selected suggestion is not something the
    // user chose yet — keep the prompt on screen until they draw by hand.
    instructions.textContent = SELECT_INSTRUCTIONS;
    instructions.style.display = "";
    positionToolbar(rect);
    hideError();
  }

  function resetSelection(instructionText) {
    isDragging = false;
    pendingClick = false;
    currentRect = null;
    activeCandidate = null;
    candidateEls.forEach((candidateEl) => {
      candidateEl.style.display = "";
    });
    selectionEl.style.display = "none";
    toolbar.style.display = "none";
    instructions.textContent = instructionText ??
      (candidates.length > 0 ? SELECT_INSTRUCTIONS : DRAW_INSTRUCTIONS);
    instructions.style.display = "";
    hideError();
  }

  function setProcessing(active) {
    processing = active;
    btnConfirm.disabled = active;
    btnRedo.disabled = active;
    btnCancel.disabled = active;
    btnConfirm.textContent = active ? "Processing…" : "Confirm logo";
    overlay.style.cursor = active ? "progress" : "crosshair";
  }

  function showError(code) {
    errorMsg.textContent = FAILURE_MESSAGES[code] ?? FAILURE_MESSAGES.selection_failed;
    errorMsg.style.display = "block";
  }

  function hideError() {
    errorMsg.style.display = "none";
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "logo_selector_prepare_capture") {
      // Keep the disabled overlay mounted and blocking input, but make it fully
      // transparent for the screenshot. Two frames let the compositor catch up.
      overlay.style.opacity = "0";
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => sendResponse({ ok: true }));
      });
      return true;
    }
    if (message.type === "logo_selector_capture_complete") {
      overlay.style.opacity = "";
    }
    return false;
  });

  overlay.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || processing) return;
    startX = e.clientX;
    startY = e.clientY;
    if (toolbar.style.display === "flex") {
      // A selection is showing. Dragging must not disturb it, but a plain
      // click may still pick a different suggestion (resolved on mouseup).
      pendingClick = true;
      return;
    }
    isDragging = true;
    selectionEl.style.left = startX + "px";
    selectionEl.style.top = startY + "px";
    selectionEl.style.width = "0";
    selectionEl.style.height = "0";
    selectionEl.style.display = "block";
    hideError();
    e.preventDefault();
  });

  overlay.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    selectionEl.style.left = x + "px";
    selectionEl.style.top = y + "px";
    selectionEl.style.width = w + "px";
    selectionEl.style.height = h + "px";
  });

  overlay.addEventListener("mouseup", (e) => {
    if (pendingClick) {
      pendingClick = false;
      const moved = Math.abs(e.clientX - startX) >= 10 || Math.abs(e.clientY - startY) >= 10;
      if (moved) return;
      const hit = candidateAt(e.clientX, e.clientY);
      if (hit !== null && hit !== activeCandidate) activateCandidate(hit);
      return;
    }
    if (!isDragging) return;
    isDragging = false;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    if (w < 10 || h < 10) {
      const hit = candidateAt(e.clientX, e.clientY);
      if (hit !== null) {
        activateCandidate(hit);
        return;
      }
      resetSelection();
      return;
    }

    activeCandidate = null;
    candidateEls.forEach((candidateEl) => {
      candidateEl.style.display = "";
    });
    currentRect = { x, y, width: w, height: h };
    instructions.style.display = "none";
    // The notice explains why the user is drawing at all; once they have, it
    // has been read and would only crowd the selection.
    notice.style.display = "none";
    positionToolbar({ x, y, width: w, height: h });
  });

  // Prevent overlay mousedown from firing when clicking toolbar children
  toolbar.addEventListener("mousedown", (e) => e.stopPropagation());

  btnRedo.addEventListener("click", () => {
    if (processing) return;
    // Redrawing is an explicit intent to draw by hand, so the prompt switches
    // even when suggestions are still on screen (they stay clickable).
    resetSelection(DRAW_INSTRUCTIONS);
  });

  btnConfirm.addEventListener("click", async () => {
    if (currentRect === null || processing) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const normalizedRect = currentRect.ratios ?? {
      xRatio: currentRect.x / vw,
      yRatio: currentRect.y / vh,
      widthRatio: currentRect.width / vw,
      heightRatio: currentRect.height / vh,
    };

    hideError();
    setProcessing(true);
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "logo_selection_confirmed",
        fqdn,
        sessionId,
        normalizedRect,
      });
    } catch {
      // The background process is gone or was reloaded mid-request.
      response = { ok: false, code: "dispatch_failed" };
    }

    // The overlay only comes down once the entry is actually stored. On the
    // settings flow the background closes this tab first, in which case this
    // code no longer runs at all.
    if (response?.ok === true) {
      cleanup();
      return;
    }
    setProcessing(false);
    showError(response?.code);
  });

  btnCancel.addEventListener("click", cancel);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancel();
  }, { capture: true });

  function cancel() {
    if (processing) return;
    chrome.runtime.sendMessage({ type: "logo_selection_cancelled", fqdn, sessionId }).catch(() => {});
    cleanup();
  }

  function cleanup() {
    window.__YP_SELECTOR_ACTIVE__ = false;
    host.remove();
  }

  // Issue #90: the best-scored suggestion starts out selected, ready to
  // confirm; the user can still pick another one, redraw, or cancel.
  if (candidates.length > 0) activateCandidate(0);
})();
