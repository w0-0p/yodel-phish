// =============================================================================
// INIT
// =============================================================================

let developerMode = false;

const RENDERED_KEYS = ["trusted_list", "muted_list", "trusted_groups", "settings", "analysis_history"];
const renderedState = {
  trusted_list: [],
  muted_list: [],
  trusted_groups: [],
  settings: {},
  analysis_history: [],
};
const renderedSnapshots = new Map();
let refreshChain = Promise.resolve();

document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  setupAnalysisHistoryControls();
  await loadAndRender();
  setupDeveloperModeToggle();
  setupManualSiteControls();
  setupTrustedGroupControls();
  setupDeviceCodeAuthControls();
  setupResetDefaultsControl();
  setupBannerFontSizeControls();
  setupClickfixControls();
  setupDeviceFlowControls();
  await loadDeviceFlowBuiltins();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const changedState = {};
  RENDERED_KEYS.forEach((key) => {
    if (changes[key] !== undefined) changedState[key] = changes[key].newValue;
  });
  if (Object.keys(changedState).length === 0) return;
  queueRefresh(() => applyStoredState(changedState)).catch((error) => {
    console.warn("[YodelPhish] Could not refresh settings after a storage change:", error);
  });
});

// A suspended settings page may miss a storage event. Re-read when it becomes
// visible; per-key snapshots below make an unchanged reconciliation a no-op.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  refreshFromStorage().catch((error) => {
    console.warn("[YodelPhish] Could not reconcile settings after becoming visible:", error);
  });
});

// Initial reads, visibility reconciliation and storage events share one order,
// so an older asynchronous read cannot overwrite a newer event.
function queueRefresh(operation) {
  const refresh = refreshChain.then(operation);
  refreshChain = refresh.catch(() => {});
  return refresh;
}

function refreshFromStorage() {
  return queueRefresh(async () => {
    const stored = await chrome.storage.local.get(RENDERED_KEYS);
    // In a full read an absent key means "unset" (fresh install), not
    // "unchanged" as in a storage event: materialize it so every section
    // still renders its defaults — the developer-mode rows must be hidden by
    // this pass, never by trusting the static hidden attributes in the HTML.
    RENDERED_KEYS.forEach((key) => {
      if (!Object.hasOwn(stored, key)) stored[key] = undefined;
    });
    applyStoredState(stored);
  });
}

function normalizedStateValue(key, value) {
  if (key === "settings") return asObject(value);
  if (key === "trusted_list" || key === "muted_list") return asEntryList(value);
  if (key === "trusted_groups") return asGroupList(value);
  return asArray(value);
}

// Update only the sections whose stored values changed. Every open settings
// page runs this listener, so storage itself provides cross-tab synchronization.
function applyStoredState(state) {
  const changed = new Set();
  const nextSnapshots = new Map();
  RENDERED_KEYS.forEach((key) => {
    if (!Object.hasOwn(state, key)) return;
    const value = normalizedStateValue(key, state[key]);
    const snapshot = JSON.stringify(value);
    if (renderedSnapshots.get(key) === snapshot) return;
    renderedState[key] = value;
    nextSnapshots.set(key, snapshot);
    changed.add(key);
  });

  if (changed.has("settings")) applySettings(renderedState.settings);
  if (changed.has("trusted_list") || changed.has("settings") || changed.has("trusted_groups")) {
    renderList("trusted-list", renderedState.trusted_list, "trusted");
  }
  if (changed.has("muted_list") || changed.has("settings")) {
    renderList("muted-list", renderedState.muted_list, "muted");
  }
  if (changed.has("trusted_list") || changed.has("muted_list")) {
    renderManualSites();
  }
  if (changed.has("trusted_groups")) {
    renderTrustedGroupControls();
  }
  if (changed.has("analysis_history") || changed.has("settings")) {
    renderAnalysisHistory(renderedState.analysis_history);
  }

  // A failed render remains retryable on the next event or reconciliation.
  nextSnapshots.forEach((snapshot, key) => renderedSnapshots.set(key, snapshot));
}

// =============================================================================
// TABS
// =============================================================================

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

// =============================================================================
// LOAD & RENDER
// =============================================================================

// The service worker is the sole writer of trusted_list/muted_list/settings/
// analysis_history (see issue #13). This trusted extension page asks the
// worker to initialize storage access and migrations, then reads the render
// snapshot directly so large image/embedding records never cross Chrome's
// runtime-message size boundary.
async function loadAndRender() {
  const ready = await chrome.runtime.sendMessage({ type: "prepare_settings_state" });
  if (ready?.ok !== true) throw new Error("Settings storage is unavailable");
  await refreshFromStorage();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asStringArray(value) {
  return asArray(value).filter((item) => typeof item === "string");
}

function asObjectArray(value) {
  return asArray(value).filter(
    (item) => item !== null && typeof item === "object" && !Array.isArray(item)
  );
}

// Only entries a card can actually be built and acted on: the fqdn identifies
// the record in every mutation request this page sends.
function asEntryList(value) {
  return asArray(value).filter(
    (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
      typeof entry.fqdn === "string" && entry.fqdn.length > 0
  );
}

// Only group records the page can act on: the id keys every mutation request
// and the name is what the user sees (issue #19).
function asGroupList(value) {
  return asArray(value).filter(
    (group) => group !== null && typeof group === "object" && !Array.isArray(group) &&
      typeof group.id === "string" && group.id.length > 0 &&
      typeof group.name === "string" && group.name.trim().length > 0
  );
}

function applySettings(settings) {
  developerMode = settings.developer_mode === true;

  document.getElementById("developer-mode-toggle").checked = developerMode;
  // Hiding the manual add/edit controls never deactivates the entries they
  // created (issue #93): those stay on the normal Trusted/Muted lists.
  document.getElementById("manual-sites-section").hidden = !developerMode;
  // The group-destination form follows developer mode the same way; the groups
  // themselves stay visible on the Trusted Sites tab (issue #19).
  document.getElementById("trusted-group-section").hidden = !developerMode;
  // ClickFix warn mode and device-code endpoints are technical-user controls;
  // both stay hidden until Developer mode is enabled (issue #3).
  document.getElementById("clickfix-warn-mode-row").hidden = !developerMode;
  document.getElementById("device-code-auth-row").hidden = !developerMode;
  document.getElementById("device-flow-section").hidden = !developerMode;
  document.getElementById("reset-defaults-row").hidden = !developerMode;

  document.getElementById("device-code-auth-toggle").checked = settings.device_code_auth === "allowed";

  renderBannerFontSize(settings.banner_font_size);
  renderClickfixSettings(asObject(settings.clickfix));
  renderDeviceFlowUserEndpoints(asObjectArray(settings.device_flow_user_endpoints));
}

function renderList(containerId, entries, type) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  if (entries.length === 0) {
    container.innerHTML = `<p class="empty-state">No ${type} sites yet.</p>`;
    return;
  }

  // Trusted-group members (issue #19) render together, ahead of the ungrouped
  // sites. An entry referencing an unknown group renders as ungrouped rather
  // than disappearing; the worker's repair clears such references.
  let ungrouped = entries;
  if (type === "trusted") {
    const groups = renderedState.trusted_groups;
    const groupIds = new Set(groups.map((group) => group.id));
    const membersByGroup = new Map();
    ungrouped = [];
    entries.forEach((entry) => {
      if (typeof entry.trust_group_id === "string" && groupIds.has(entry.trust_group_id)) {
        if (!membersByGroup.has(entry.trust_group_id)) membersByGroup.set(entry.trust_group_id, []);
        membersByGroup.get(entry.trust_group_id).push(entry);
      } else {
        ungrouped.push(entry);
      }
    });
    groups.forEach((group) => {
      const members = membersByGroup.get(group.id);
      if (members !== undefined) container.appendChild(buildTrustedGroupSection(group, members));
    });
  }

  // A trusted fqdn may have up to 2 stored reference variants (see [B.2] in
  // REVIEW_FINDINGS.md) — group them visually so they read as one site.
  groupByFqdn(ungrouped).forEach((group) => {
    if (group.length > 1) {
      const wrapper = element("div", "entry-group");
      wrapper.appendChild(element("p", "entry-group-label", `${group.length} saved references for this site`));
      group.forEach((entry) => wrapper.appendChild(buildEntryCard(entry, type)));
      container.appendChild(wrapper);
    } else {
      container.appendChild(buildEntryCard(group[0], type));
    }
  });
}

function groupByFqdn(entries) {
  const order = [];
  const byFqdn = new Map();
  entries.forEach((entry) => {
    if (!byFqdn.has(entry.fqdn)) {
      byFqdn.set(entry.fqdn, []);
      order.push(entry.fqdn);
    }
    byFqdn.get(entry.fqdn).push(entry);
  });
  return order.map((fqdn) => byFqdn.get(fqdn));
}

// =============================================================================
// ENTRY CARD BUILDER
// =============================================================================

function buildEntryCard(entry, type) {
  const tpl = document.getElementById(`tpl-${type}-entry`);
  const card = tpl.content.cloneNode(true).querySelector(".entry-card");

  const entryLabel = entry.protocol === "file" && typeof entry.source_url === "string"
    ? entry.source_url
    : entry.fqdn;
  card.dataset.fqdn = entry.fqdn;
  card.querySelector(".entry-fqdn").textContent         = entryLabel;
  card.querySelector(".entry-etld1").textContent        = entry.etld1 ?? "—";
  card.querySelector(".entry-last-visited").textContent = formatDate(entry.last_visited);
  card.querySelector(".badge-protocol").textContent     = entry.protocol ?? "—";

  card.querySelectorAll(".advanced-field").forEach((field) => {
    field.hidden = !developerMode;
  });

  // Detected logo (trusted only)
  const logo = card.querySelector(".entry-logo");
  if (logo) {
    const missingLogo = card.querySelector(".entry-logo-missing");
    if (typeof entry.logo_image === "string" && entry.logo_image.length > 0) {
      logo.src = entry.logo_image;
      missingLogo.hidden = true;
    } else {
      logo.hidden = true;
      missingLogo.hidden = false;
    }
  }

  card.querySelector(".btn-modify-logo")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "open_logo_selector", fqdn: entry.fqdn, variantId: entry.variant_id });
  });

  // Extracted words (trusted only — read-only tags)
  const ocrWordsEl = card.querySelector(".entry-ocr-words");
  if (ocrWordsEl) {
    renderReadOnlyTags(ocrWordsEl, asStringArray(entry.ocr_words));
  }

  // User-added words
  const userWordsEl = card.querySelector(".entry-user-words");
  renderUserWordTags(userWordsEl, asStringArray(entry.user_words), entry.fqdn, type, entry.variant_id);

  // Add word button
  card.querySelector(".btn-add-word").addEventListener("click", () => {
    const input = card.querySelector(".word-input");
    addUserWord(entry.fqdn, type, input.value.trim(), card, entry.variant_id);
    input.value = "";
    input.focus();
  });

  card.querySelector(".word-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") card.querySelector(".btn-add-word").click();
  });

  // Muted until select (muted only)
  const mutedSelect = card.querySelector(".muted-until-select");
  if (mutedSelect) {
    mutedSelect.value = entry.muted_until ?? "forever";
    mutedSelect.addEventListener("change", () => {
      updateMutedUntil(entry.fqdn, mutedSelect.value);
    });
  }

  // Move to trusted (muted only)
  card.querySelector(".btn-move-trusted")?.addEventListener("click", async () => {
    await moveToTrusted(entry.fqdn);
  });

  // Remove
  card.querySelector(".btn-remove").addEventListener("click", async () => {
    if (confirm(`Remove ${entryLabel} from the ${type} list?`)) {
      await removeEntry(entry.fqdn, type, entry.variant_id);
    }
  });

  return card;
}

// =============================================================================
// TRUSTED GROUPS (issue #19) — grouped origins render together on the Trusted
// Sites tab: a shared, editable name, every member origin's saved references,
// and one removal action per exact member origin. All mutations go through the
// service worker; storage change events re-render this section afterwards.
// =============================================================================

// In-flight guards survive the re-renders storage events trigger, so a second
// click can never double-send while a mutation is pending.
const trustedGroupRenamePending = new Set();
const trustedGroupRemovalPending = new Set();

function buildTrustedGroupSection(group, entries) {
  const section = element("div", "trusted-group");
  section.dataset.groupId = group.id;

  const header = element("div", "trusted-group-header");
  const nameEl = element("span", "trusted-group-name", group.name);
  const editButton = element("button", "btn-secondary trusted-group-edit-name", "Edit name");
  header.append(nameEl, editButton);

  const editRow = element("div", "word-input-row trusted-group-edit");
  editRow.hidden = true;
  const nameInput = element("input", "word-input trusted-group-name-input");
  nameInput.value = group.name;
  const saveButton = element("button", "btn-add-word trusted-group-save-name", "Save");
  const cancelButton = element("button", "btn-secondary trusted-group-cancel-name", "Cancel");
  editRow.append(nameInput, saveButton, cancelButton);

  const errorEl = element("p", "clickfix-error trusted-group-name-error");
  errorEl.hidden = true;

  editButton.addEventListener("click", () => {
    nameInput.value = group.name;
    errorEl.hidden = true;
    editRow.hidden = false;
    editButton.hidden = true;
    nameInput.focus();
  });
  cancelButton.addEventListener("click", () => {
    if (trustedGroupRenamePending.has(group.id)) return;
    errorEl.hidden = true;
    editRow.hidden = true;
    editButton.hidden = false;
    nameInput.value = group.name;
  });
  saveButton.addEventListener("click", async () => {
    if (trustedGroupRenamePending.has(group.id)) return;
    const name = nameInput.value.trim();
    if (name.length === 0 || name.length > 80) {
      errorEl.textContent = trustedGroupErrorMessage("invalid_group_name");
      errorEl.hidden = false;
      return;
    }
    trustedGroupRenamePending.add(group.id);
    nameInput.disabled = true;
    saveButton.disabled = true;
    cancelButton.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "rename_trusted_group", groupId: group.id, name });
      if (response?.ok === true) {
        // The committed name lands through storage.onChanged, which re-renders
        // this section on every open settings page. Until then the displayed
        // name stays what storage still holds.
        errorEl.hidden = true;
      } else {
        errorEl.textContent = trustedGroupErrorMessage(response?.code);
        errorEl.hidden = false;
      }
    } catch {
      errorEl.textContent = trustedGroupErrorMessage("unavailable");
      errorEl.hidden = false;
    } finally {
      trustedGroupRenamePending.delete(group.id);
      nameInput.disabled = false;
      saveButton.disabled = false;
      cancelButton.disabled = false;
    }
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveButton.click();
  });

  const members = element("div", "trusted-group-members");
  groupByFqdn(entries).forEach((variants) => {
    const fqdn = variants[0].fqdn;
    const member = element("div", "trusted-group-member");
    member.dataset.fqdn = fqdn;
    if (variants.length > 1) {
      member.appendChild(element("p", "entry-group-label", `${variants.length} saved references for this site`));
    }
    variants.forEach((entry) => {
      const card = buildEntryCard(entry, "trusted");
      // One removal action per exact member origin, not one per variant: the
      // per-variant Remove stays hidden inside a group.
      const cardRemove = card.querySelector(".btn-remove");
      if (cardRemove) cardRemove.hidden = true;
      member.appendChild(card);
    });
    const removeButton = element("button", "btn-remove-destination", "Remove destination");
    removeButton.addEventListener("click", async () => {
      if (trustedGroupRemovalPending.has(group.id)) return;
      const confirmed = confirm(
        `Remove ${fqdn} from “${group.name}”? The origin and all its saved references ` +
        "will be removed from Trusted Sites."
      );
      if (!confirmed) return;
      trustedGroupRemovalPending.add(group.id);
      removeButton.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({
          type: "remove_trusted_group_destination",
          groupId: group.id,
          hostname: fqdn,
        });
        if (response?.ok !== true) await loadAndRender();
      } catch {
        await loadAndRender();
      } finally {
        trustedGroupRemovalPending.delete(group.id);
        removeButton.disabled = false;
      }
    });
    member.appendChild(removeButton);
    members.appendChild(member);
  });

  section.append(header, editRow, errorEl, members);
  return section;
}

function trustedGroupErrorMessage(code) {
  if (code === "invalid_group" || code === "not_found") return "This group no longer exists.";
  if (code === "invalid_group_name") return "Enter a group name of at most 80 characters.";
  if (code === "duplicate_group_name") return "Another group already uses this name.";
  if (code === "already_in_group") return "This destination is already in this group.";
  if (code === "already_in_other_group") return "This destination already belongs to another trusted group.";
  if (code === "group_full") return "This group has reached its maximum number of destinations.";
  if (code === "too_many_sites") return "You have reached the maximum number of manually added sites.";
  if (code === "unavailable") return "The extension could not update this group. Please try again.";
  return "Enter an exact hostname (e.g. login.example.com) — no scheme, path, port, or wildcard.";
}

// =============================================================================
// TAG RENDERING
// =============================================================================

function renderReadOnlyTags(container, words) {
  container.innerHTML = "";
  if (words.length === 0) {
    container.textContent = "—";
    return;
  }
  words.forEach((word) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = word;
    container.appendChild(tag);
  });
}

function renderUserWordTags(container, words, fqdn, type, variantId) {
  container.innerHTML = "";
  words.forEach((word) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = word;
    const removeButton = document.createElement("button");
    removeButton.className = "tag-remove";
    removeButton.title = "Remove";
    removeButton.textContent = "×";
    removeButton.addEventListener("click", async () => {
      const response = await removeUserWord(fqdn, type, word, variantId);
      if (response?.ok === true) {
        renderUserWordTags(container, asStringArray(response.user_words), fqdn, type, variantId);
      } else {
        await loadAndRender();
      }
    });
    tag.append(" ", removeButton);
    container.appendChild(tag);
  });
}

// =============================================================================
// ANALYSIS HISTORY
// =============================================================================

function setupAnalysisHistoryControls() {
  document.getElementById("clear-analysis-history").addEventListener("click", async () => {
    if (confirm("Clear all stored analysis diagnostics?")) {
      const response = await chrome.runtime.sendMessage({ type: "clear_analysis_history" });
      if (response?.ok !== true) await loadAndRender();
    }
  });

  document.getElementById("export-analysis-history").addEventListener("click", async () => {
    const data = await chrome.storage.local.get("analysis_history");
    const blob = new Blob([JSON.stringify(data.analysis_history ?? [], null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `yodel-phish-analysis-history-${new Date().toISOString().replaceAll(":", "-")}.json`;
    link.click();
    URL.revokeObjectURL(href);
  });
}

function renderAnalysisHistory(history) {
  const section = document.getElementById("analysis-history-section");
  const container = document.getElementById("analysis-history-list");
  section.hidden = !developerMode;
  if (!developerMode) return;

  container.replaceChildren();
  document.getElementById("export-analysis-history").disabled = history.length === 0;
  document.getElementById("clear-analysis-history").disabled = history.length === 0;
  if (history.length === 0) {
    container.appendChild(element("p", "empty-state", "No analyses recorded yet."));
    return;
  }

  [...history].reverse().forEach((record) => container.appendChild(buildAnalysisCard(record)));
}

function buildAnalysisCard(record) {
  const completed = record.status !== "error" && record.status !== "cancelled";
  const details = element("details", `analysis-card verdict-${record.displayed_verdict ?? record.status}`);
  const summary = element("summary", "analysis-summary");
  // Always the analysed page, never record.matched_fqdn: for an unknown result
  // the latter is only the pipeline's closest candidate, so titling the card
  // with it would name an unrelated brand instead of the page that was scanned.
  const title = element("span", "analysis-summary-title", record.origin?.fqdn || "Local file");
  const verdict = element("span", "analysis-verdict", completed
    ? String(record.displayed_verdict ?? "unknown").toUpperCase()
    : String(record.status).toUpperCase());
  const score = element("span", "analysis-score", completed ? `Global ${orDash(fmt4(record.global_score))}` : "");
  const date = element("span", "analysis-date", formatDatetime(record.datetime));
  summary.append(title, verdict, score, date);
  details.appendChild(summary);
  details.appendChild(completed ? buildCompletedBody(record) : buildIncompleteBody(record));
  return details;
}

// A failed or interrupted analysis produced no verdict, scores or candidates.
// Rendering the completed-analysis layout over one left a column of dashes
// where its fields would have been, so it gets only what it actually holds.
function buildIncompleteBody(record) {
  const body = element("div", "analysis-body");
  appendMetrics(body, [
    ["Origin", record.origin?.fqdn],
    ["Context", record.context],
    ["Extension version", record.extension_version],
    ["Failure code", record.failure_code],
    ["Reason", record.reason],
    ["Logo search", logoSearchDuration(record.logo_search_ms)],
  ]);
  appendSection(body, "Pipeline error", record.error);
  return body;
}

function buildCompletedBody(record) {
  const body = element("div", "analysis-body");
  // Matched domain and variant name the reference the pipeline actually matched,
  // so they belong here only for a confirmed match. For an unknown result the
  // pipeline merely had a closest candidate; naming it as "matched" would
  // misrepresent it -- it survives as a diagnostic in the winner/reference
  // sections below instead. The pipeline verdict stays for every completed
  // record because it can legitimately differ from the displayed verdict
  // (phishing presented as suspicious). Records carry the analysed page's
  // hostname and nothing more of its address -- see compactOrigin.
  const confirmedMatch = record.pipeline_verdict === "phishing" &&
    typeof record.matched_fqdn === "string" &&
    record.matched_fqdn !== "";
  appendMetrics(body, [
    ["Origin", record.origin?.fqdn],
    ["Context", record.context],
    ["Pipeline verdict", record.pipeline_verdict],
    ...(confirmedMatch ? [
      ["Matched domain", record.matched_fqdn],
      ["Matched variant", record.matched_variant_id],
    ] : []),
    ["Extension version", record.extension_version],
    ["Logo search", logoSearchDuration(record.logo_search_ms)],
    ["Protocol", record.origin?.protocol],
    ["Origin mismatch", yesNo(record.origin?.origin_mismatch)],
    ["Trusted page", yesNo(record.origin?.in_trusted_list)],
  ]);

  const winner = record.winner;
  if (winner !== null && winner !== undefined) {
    appendMetrics(body, [
      ["Reason", winner.logo?.reason],
      ["Query crop OCR", winner.logo?.query_ocr_text],
      ["Reference crop OCR", winner.logo?.trusted_ocr_text],
      ["Crop OCR matches", winner.logo?.ocr_matched_tokens],
      ...cropOcrDiagnosticRows("Query", winner.logo?.query_ocr_diagnostics),
      ...cropOcrDiagnosticRows("Reference", winner.logo?.trusted_ocr_diagnostics),
    ], "Logo comparison");
    appendMetrics(body, [
      ["Matched tokens", winner.ocr?.matched_tokens],
      ["Fuzzy matches", winner.ocr?.fuzzy_matched_tokens],
      ["Visible exact match", yesNo(winner.ocr?.visible_exact_match)],
    ], "OCR evidence");
  }

  if (record.reference !== null && record.reference !== undefined) {
    // logo_fingerprint stays out of the card: it means nothing on screen, and
    // exports keep it for correlating a result with a since-changed reference.
    appendMetrics(body, [
      ["FQDN", record.reference.fqdn],
      ["Variant ID", record.reference.variant_id],
      ["Logo source", record.reference.logo_source],
      ["OCR domain", record.reference.ocr_domain],
      ["Extracted words", (record.reference.ocr_words ?? []).join(", ")],
      ["User words", (record.reference.user_words ?? []).join(", ")],
    ], "Saved reference");
  }

  return body;
}

// Crop OCR that returned text explains itself through the crop text already
// shown above it. Its canvas size, crop size and error only ever say anything
// when the crop came back empty or the pass failed.
function cropOcrDiagnosticRows(label, diagnostics) {
  if (diagnostics === null || diagnostics === undefined) return [];
  if (diagnostics.status === "text") return [];
  return [
    [`${label} crop OCR status`, diagnostics.status],
    [`${label} crop size`, diagnostics.cropSize],
    [`${label} OCR canvas`, diagnostics.ocrCanvasSize],
    [`${label} crop OCR error`, diagnostics.error],
  ];
}

// Missing values are dropped instead of being rendered as a dash: an absent
// field says nothing, and a grid full of dashes hides the fields that do say
// something. `false` and `0` are answers, so only undefined, null and the
// empty string are removed. Returns null when no row survives, which is how
// callers know not to open a section around it.
function metricGrid(entries) {
  const rows = entries.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (rows.length === 0) return null;
  const grid = element("dl", "metric-grid");
  rows.forEach(([label, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = humanize(label);
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    grid.append(dt, dd);
  });
  return grid;
}

// Appends a metric grid, titled or bare, and nothing at all when every row of
// it was empty.
function appendMetrics(parent, entries, title = undefined) {
  const grid = metricGrid(entries);
  if (grid === null) return;
  parent.appendChild(title === undefined ? grid : sectionBlock(title, grid));
}

// Same rule for whole sections: no candidates, no timings, no error text means
// no heading either.
function appendSection(parent, title, content) {
  if (content === null || content === undefined || content === "") return;
  parent.appendChild(sectionBlock(title, content));
}

function sectionBlock(title, content) {
  const section = element("section", "analysis-block");
  section.appendChild(element("h3", "", title));
  if (content instanceof Node) section.appendChild(content);
  else section.appendChild(element("pre", "analysis-error", content));
  return section;
}

function element(tag, className = "", text = undefined) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Undefined rather than a dash, so metricGrid can drop the row. Callers that
// must fill a fixed slot -- a table cell, the summary line -- wrap the result
// in orDash themselves.
function yesNo(value) {
  if (value === undefined || value === null) return undefined;
  return value ? "yes" : "no";
}

function orDash(value) {
  return value === undefined || value === null || value === "" ? "—" : String(value);
}

// Issue #14: how long the automatic logo search behind "Add to trusted" ran
// before it finished, was bypassed, or hit its fallback deadline. Only that
// flow's records carry it, so every other card drops the row.
function logoSearchDuration(milliseconds) {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) return undefined;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

function humanize(value) {
  return String(value).replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

// =============================================================================
// MUTATION REQUESTS — sent to the service worker (see handleMessage's
// "SETTINGS PAGE MUTATIONS" cases in service_worker.js), which is the sole
// writer of these chrome.storage.local keys.
// =============================================================================

async function addUserWord(fqdn, type, word, card, variantId) {
  if (!word) return;
  const response = await chrome.runtime.sendMessage({ type: "add_user_word", listType: type, fqdn, variantId, word });
  if (response?.ok !== true) {
    await loadAndRender();
    return;
  }

  // Re-render only the affected tags, preserving focus in the word input.
  const userWordsEl = card.querySelector(".entry-user-words");
  renderUserWordTags(userWordsEl, asStringArray(response.user_words), fqdn, type, variantId);
}

function removeUserWord(fqdn, type, word, variantId) {
  return chrome.runtime.sendMessage({ type: "remove_user_word", listType: type, fqdn, variantId, word });
}

async function updateMutedUntil(fqdn, value) {
  const response = await chrome.runtime.sendMessage({ type: "update_muted_until", fqdn, value });
  if (response?.ok !== true) await loadAndRender();
}

async function removeEntry(fqdn, type, variantId) {
  const response = await chrome.runtime.sendMessage({ type: "remove_list_entry", listType: type, fqdn, variantId });
  if (response?.ok !== true || response.removed !== true) await loadAndRender();
}

// Issue #8: this no longer moves the entry itself. It opens the site in a new
// tab and hands off to the same interactive logo confirmation as "Add to
// trusted"; the entry stays muted until the user confirms there, at which point
// storage.onChanged re-renders both lists. Nothing to do here on success — the
// new tab has taken focus. If the request could not even start, re-render so a
// stale card cannot look mid-move.
async function moveToTrusted(fqdn) {
  const response = await chrome.runtime.sendMessage({ type: "move_muted_to_trusted", fqdn });
  if (response?.ok !== true) await loadAndRender();
}

// =============================================================================
// DEVELOPER MODE TOGGLE
// =============================================================================

function setupDeveloperModeToggle() {
  document.getElementById("developer-mode-toggle").addEventListener("change", async (e) => {
    const response = await chrome.runtime.sendMessage({ type: "set_developer_mode", enabled: e.target.checked });
    if (response?.ok !== true) await loadAndRender();
  });
}

// =============================================================================
// MANUAL TRUSTED/MUTED SITES (issue #93)
// =============================================================================

// The fqdn currently being edited per list, or null when the form adds.
const manualSiteEditing = { trusted: null, muted: null };
const manualSitePending = { trusted: false, muted: false };

function manualSiteElements(listType) {
  const prefix = listType === "trusted" ? "manual-trusted" : "manual-muted";
  return {
    list: document.getElementById(`${prefix}-list`),
    input: document.getElementById(`${prefix}-input`),
    addButton: document.getElementById(`${prefix}-add`),
    cancelButton: document.getElementById(`${prefix}-cancel`),
    errorEl: document.getElementById(`${prefix}-error`),
  };
}

// The section renders the same underlying trusted_list/muted_list records as
// the list tabs — only the entries carrying manual provenance, one tag per
// hostname however many reference variants it has accumulated.
function manualSiteFqdns(listType) {
  const entries = listType === "trusted" ? renderedState.trusted_list : renderedState.muted_list;
  const fqdns = [];
  const seen = new Set();
  entries.forEach((entry) => {
    // A manually created trusted destination that belongs to a group is
    // managed from that group's card on the Trusted Sites tab. Hiding it here
    // avoids a second generic Edit/Remove path that could silently alter or
    // dissolve the group without naming that consequence.
    if (entry.manual_entry !== true ||
        (listType === "trusted" && typeof entry.trust_group_id === "string") ||
        seen.has(entry.fqdn)) return;
    seen.add(entry.fqdn);
    fqdns.push(entry.fqdn);
  });
  return fqdns;
}

function renderManualSites() {
  ["trusted", "muted"].forEach((listType) => {
    const { list } = manualSiteElements(listType);
    list.innerHTML = "";
    const fqdns = manualSiteFqdns(listType);
    if (fqdns.length === 0) {
      list.appendChild(element("span", "empty-state", `No manually added ${listType} sites.`));
      return;
    }
    fqdns.forEach((fqdn) => {
      const tag = element("span", "tag", fqdn);
      const editButton = document.createElement("button");
      editButton.className = "tag-edit";
      editButton.title = "Edit";
      editButton.textContent = "✎";
      editButton.addEventListener("click", () => beginManualSiteEdit(listType, fqdn));
      const removeButton = document.createElement("button");
      removeButton.className = "tag-remove";
      removeButton.title = "Remove";
      removeButton.textContent = "×";
      removeButton.addEventListener("click", async () => {
        if (removeButton.disabled) return;
        if (!confirm(`Remove ${fqdn} from your ${listType} sites?`)) return;
        const { errorEl } = manualSiteElements(listType);
        removeButton.disabled = true;
        try {
          const response = await chrome.runtime.sendMessage({ type: "remove_manual_site", listType, fqdn });
          if (response?.ok !== true) await loadAndRender();
        } catch {
          errorEl.textContent = manualSiteErrorMessage("unavailable");
          errorEl.hidden = false;
        } finally {
          removeButton.disabled = false;
        }
      });
      tag.append(" ", editButton, removeButton);
      list.appendChild(tag);
    });
  });
}

function beginManualSiteEdit(listType, fqdn) {
  if (manualSitePending[listType]) return;
  manualSiteEditing[listType] = fqdn;
  const { input, addButton, cancelButton } = manualSiteElements(listType);
  input.value = fqdn;
  addButton.textContent = "Save";
  cancelButton.hidden = false;
  input.focus();
}

function resetManualSiteForm(listType) {
  manualSiteEditing[listType] = null;
  const { input, addButton, cancelButton } = manualSiteElements(listType);
  input.value = "";
  addButton.textContent = "Add";
  cancelButton.hidden = true;
}

function manualSiteErrorMessage(code) {
  if (code === "already_trusted") return "This hostname is already in your Trusted Sites.";
  if (code === "already_muted") return "This hostname is already in your Muted Sites.";
  if (code === "too_many_sites") return "You have reached the maximum number of manually added sites.";
  if (code === "not_found") return "This entry no longer exists.";
  if (code === "unavailable") return "The extension could not update this hostname. Please try again.";
  return "Enter an exact hostname (e.g. login.example.com) — no scheme, path, port, or wildcard.";
}

// Mirror the worker's small hostname canonicalizer so the confirmation can
// name exactly what will be stored. The worker still validates independently.
function normalizeManualSiteHostname(value) {
  const candidate = String(value ?? "").trim().toLowerCase().replace(/\.$/u, "");
  if (candidate.length === 0 || /[\/\\?#@:\s]/u.test(candidate)) return null;
  try {
    const hostname = new URL(`https://${candidate}`).hostname.toLowerCase();
    const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
    return hostname.length > 0 && hostname.length <= 253 &&
      hostname.split(".").every((label) => validLabel.test(label))
      ? hostname
      : null;
  } catch {
    return null;
  }
}

// Adding a hostname changes what the extension warns about, so it is
// confirmed like every other protection-reducing action (issue #82): the
// dialog names the exact hostname and its effect before anything is stored.
function manualSiteConfirmationText(listType, hostname, editingFqdn) {
  const effect = listType === "trusted"
    ? `https://${hostname} will be treated as a trusted site, and its reference data will be captured on your next visit`
    : `normal phishing detection will be muted on ${hostname}; ClickFix and Device Code protection remain enforced`;
  if (editingFqdn === null) {
    return `Add ${hostname} as a ${listType} site? ${capitalize(effect)}. Continue?`;
  }
  return `Replace ${editingFqdn} with ${hostname}? The old entry is removed, and ${effect}. Continue?`;
}

function capitalize(text) {
  return text.replace(/^./, (letter) => letter.toUpperCase());
}

async function submitManualSite(listType) {
  if (manualSitePending[listType]) return;
  const { input, addButton, cancelButton, errorEl } = manualSiteElements(listType);
  const hostname = normalizeManualSiteHostname(input.value);
  if (hostname === null) {
    errorEl.textContent = manualSiteErrorMessage("invalid_hostname");
    errorEl.hidden = false;
    return;
  }
  const editingFqdn = manualSiteEditing[listType];
  if (!confirm(manualSiteConfirmationText(listType, hostname, editingFqdn))) return;
  const message = editingFqdn === null
    ? { type: "add_manual_site", listType, hostname }
    : { type: "edit_manual_site", listType, fqdn: editingFqdn, hostname };
  manualSitePending[listType] = true;
  input.disabled = true;
  addButton.disabled = true;
  cancelButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (response?.ok === true) {
      errorEl.hidden = true;
      resetManualSiteForm(listType);
      // The entry appears once the worker's storage commit lands (onChanged),
      // so a failed mutation can never leave a tag that was not persisted.
    } else {
      errorEl.textContent = manualSiteErrorMessage(response?.code);
      errorEl.hidden = false;
    }
  } catch {
    errorEl.textContent = manualSiteErrorMessage("unavailable");
    errorEl.hidden = false;
  } finally {
    manualSitePending[listType] = false;
    input.disabled = false;
    addButton.disabled = false;
    cancelButton.disabled = false;
  }
}

function setupManualSiteControls() {
  ["trusted", "muted"].forEach((listType) => {
    const { input, addButton, cancelButton, errorEl } = manualSiteElements(listType);
    addButton.addEventListener("click", () => submitManualSite(listType));
    cancelButton.addEventListener("click", () => {
      if (manualSitePending[listType]) return;
      errorEl.hidden = true;
      resetManualSiteForm(listType);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addButton.click();
    });
  });
}

// =============================================================================
// ADD DESTINATION TO TRUSTED GROUP (issue #19) — Advanced Settings. Like the
// manual Trusted/Muted controls: exact hostnames only, normalized locally so
// the confirmation names what will be stored, re-validated independently by
// the worker, single-flight while a request is pending.
// =============================================================================

let trustedGroupAddPending = false;

function trustedGroupControlElements() {
  return {
    select: document.getElementById("trusted-group-select"),
    input: document.getElementById("trusted-group-destination-input"),
    addButton: document.getElementById("trusted-group-add"),
    emptyEl: document.getElementById("trusted-group-empty"),
    errorEl: document.getElementById("trusted-group-error"),
  };
}

// Re-rendered whenever trusted_groups changes: option values are group ids,
// labels are group names, and the current selection survives as long as its
// group still exists. Without any group the whole form is disabled behind an
// explanatory empty state — groups are created by linking two trusted sign-in
// origins, not from this form.
function renderTrustedGroupControls() {
  const { select, input, addButton, emptyEl } = trustedGroupControlElements();
  const groups = renderedState.trusted_groups;
  const previous = select.value;
  select.innerHTML = "";
  groups.forEach((group) => {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = group.name;
    select.appendChild(option);
  });
  select.value = groups.some((group) => group.id === previous) ? previous : (groups[0]?.id ?? "");
  const hasGroups = groups.length > 0;
  emptyEl.hidden = hasGroups;
  select.disabled = !hasGroups || trustedGroupAddPending;
  input.disabled = !hasGroups || trustedGroupAddPending;
  addButton.disabled = !hasGroups || trustedGroupAddPending;
}

async function submitTrustedGroupDestination() {
  if (trustedGroupAddPending) return;
  const { select, input, addButton, errorEl } = trustedGroupControlElements();
  const group = renderedState.trusted_groups.find((candidate) => candidate.id === select.value);
  if (group === undefined) {
    errorEl.textContent = trustedGroupErrorMessage("invalid_group");
    errorEl.hidden = false;
    return;
  }
  const hostname = normalizeManualSiteHostname(input.value);
  if (hostname === null) {
    errorEl.textContent = trustedGroupErrorMessage("invalid_hostname");
    errorEl.hidden = false;
    return;
  }
  // Adding a destination weakens protection, so it is confirmed like every
  // other protection-reducing action (issue #82): the dialog names the exact
  // origin, the group, and the limits of what becomes trusted.
  const confirmed = confirm(
    `Add https://${hostname} to “${group.name}”? This exact origin will be treated as trusted. ` +
    "Subdomains, paths on other origins, and sibling domains are not included."
  );
  if (!confirmed) return;
  trustedGroupAddPending = true;
  select.disabled = true;
  input.disabled = true;
  addButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "add_manual_trusted_group_destination",
      groupId: group.id,
      hostname,
    });
    if (response?.ok === true) {
      errorEl.hidden = true;
      input.value = "";
      // The new membership arrives through storage.onChanged, which re-renders
      // the Trusted Sites tab and this form's dropdown.
    } else {
      errorEl.textContent = trustedGroupErrorMessage(response?.code);
      errorEl.hidden = false;
    }
  } catch {
    errorEl.textContent = trustedGroupErrorMessage("unavailable");
    errorEl.hidden = false;
  } finally {
    trustedGroupAddPending = false;
    renderTrustedGroupControls();
  }
}

function setupTrustedGroupControls() {
  const { input, addButton } = trustedGroupControlElements();
  addButton.addEventListener("click", () => submitTrustedGroupDestination());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addButton.click();
  });
}

// =============================================================================
// DEVICE CODE AUTHENTICATION (issue #75)
// =============================================================================

// Allowing device-code sign-ins is a confirmed reduction of protection, like
// switching ClickFix to warn mode.
function setupDeviceCodeAuthControls() {
  document.getElementById("device-code-auth-toggle").addEventListener("change", async (e) => {
    if (e.target.checked) {
      const confirmed = confirm(
        "Allowing Device Code Authentication reduces protection: device-code sign-in " +
        "pages will only show a warning instead of being blocked, except when they were " +
        "opened by an unrelated website. Continue?"
      );
      if (!confirmed) {
        e.target.checked = false;
        return;
      }
    }
    const response = await chrome.runtime.sendMessage({
      type: "set_device_code_auth",
      mode: e.target.checked ? "allowed" : "blocked",
    });
    if (response?.ok !== true) await loadAndRender();
  });
}

function setupResetDefaultsControl() {
  document.getElementById("reset-defaults-btn").addEventListener("click", async () => {
    const confirmed = confirm(
      "Reset every setting on this tab to its secure default? This turns Advanced Settings " +
      "off, blocks Device Code Authentication, restores strict ClickFix mode, and removes " +
      "your ClickFix trusted domains, your device-code endpoints, and the Trusted and Muted " +
      "Sites you added manually here. Sites added through page banners are kept."
    );
    if (!confirmed) return;
    const response = await chrome.runtime.sendMessage({ type: "reset_advanced_settings" });
    if (response?.ok !== true) await loadAndRender();
  });
}

// =============================================================================
// BANNER TEXT SIZE (issue #3)
// =============================================================================

function renderBannerFontSize(size) {
  const active = size === "medium" || size === "large" ? size : "small";
  document.querySelectorAll(".font-size-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.size === active);
  });
  document.getElementById("banner-font-preview").dataset.size = active;
}

function setupBannerFontSizeControls() {
  document.querySelectorAll(".font-size-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      renderBannerFontSize(btn.dataset.size); // instant preview feedback
      const response = await chrome.runtime.sendMessage({ type: "set_banner_font_size", size: btn.dataset.size });
      if (response?.ok !== true) await loadAndRender();
    });
  });
}

// =============================================================================
// CLICKFIX PROTECTION (issue #26)
// =============================================================================

function renderClickfixSettings(rawClickfix) {
  const clickfix = asObject(rawClickfix);
  const warnMode = clickfix.mode === "warn";
  document.getElementById("clickfix-warn-mode-toggle").checked = warnMode;
  document.getElementById("clickfix-exclusions").hidden = !warnMode || !developerMode;
  renderClickfixDomainList(asStringArray(clickfix.excluded_domains));
}

function renderClickfixDomainList(domains) {
  const container = document.getElementById("clickfix-domain-list");
  container.innerHTML = "";
  if (domains.length === 0) {
    container.appendChild(element("span", "empty-state", "No excluded domains."));
    return;
  }
  domains.forEach((domain) => {
    const tag = element("span", "tag", domain);
    const removeButton = document.createElement("button");
    removeButton.className = "tag-remove";
    removeButton.title = "Remove";
    removeButton.textContent = "×";
    removeButton.addEventListener("click", async () => {
      const response = await chrome.runtime.sendMessage({ type: "remove_clickfix_domain_exclusion", domain });
      if (response?.ok === true) renderClickfixSettings(response.clickfix);
      else await loadAndRender();
    });
    tag.append(" ", removeButton);
    container.appendChild(tag);
  });
}

// Switching to warn mode is an explicit, confirmed action (issue #26): the
// dialog names the reduced protection before the mode actually changes.
function setupClickfixControls() {
  document.getElementById("clickfix-warn-mode-toggle").addEventListener("change", async (e) => {
    if (e.target.checked) {
      const confirmed = confirm(
        "Warn mode is less restrictive than strict mode: instead of blocking every " +
        "recognized command outright, it only prompts when a system tool is combined " +
        "with suspicious download or execution syntax, and lets you continue anyway. " +
        "Continue switching to warn mode?"
      );
      if (!confirmed) {
        e.target.checked = false;
        return;
      }
    }
    const response = await chrome.runtime.sendMessage({
      type: "set_clickfix_mode",
      mode: e.target.checked ? "warn" : "strict",
    });
    if (response?.ok === true) renderClickfixSettings(response.clickfix);
    else await loadAndRender();
  });

  document.getElementById("clickfix-domain-add").addEventListener("click", async () => {
    const input = document.getElementById("clickfix-domain-input");
    const errorEl = document.getElementById("clickfix-domain-error");
    const domain = input.value.trim();
    if (!domain) return;
    const response = await chrome.runtime.sendMessage({ type: "add_clickfix_domain_exclusion", domain });
    if (response?.ok === true) {
      errorEl.hidden = true;
      input.value = "";
      renderClickfixSettings(response.clickfix);
    } else {
      errorEl.textContent = response?.code === "too_many_domains"
        ? "You have reached the maximum number of excluded domains."
        : "Enter a valid domain (e.g. example.com).";
      errorEl.hidden = false;
    }
  });
  document.getElementById("clickfix-domain-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("clickfix-domain-add").click();
  });
}

// =============================================================================
// DEVICE-CODE PHISHING PROTECTION (issue #39)
// =============================================================================

let deviceFlowEditingId = null;

function deviceFlowEndpointLabel(entry) {
  return `${entry.hostname}${entry.path}`;
}

// Built-ins ship as code in the service worker, not in storage, so this page
// asks for them once. They render without edit or remove controls.
async function loadDeviceFlowBuiltins() {
  const container = document.getElementById("device-flow-builtin-list");
  const initiatorContainer = document.getElementById("device-flow-trusted-initiator-list");
  const response = await chrome.runtime.sendMessage({ type: "get_device_flow_builtin_endpoints" }).catch(() => undefined);
  container.innerHTML = "";
  initiatorContainer.innerHTML = "";
  if (response?.ok !== true || !Array.isArray(response.endpoints)) {
    container.appendChild(element("span", "empty-state", "Built-in endpoints could not be loaded."));
    initiatorContainer.appendChild(element("span", "empty-state", "Recognized domains could not be loaded."));
    return;
  }
  const initiatorsByProvider = new Map();
  response.endpoints.forEach((entry) => {
    container.appendChild(element("span", "tag", `${entry.provider}: ${deviceFlowEndpointLabel(entry)}`));
    if (!initiatorsByProvider.has(entry.provider)) initiatorsByProvider.set(entry.provider, new Set());
    if (Array.isArray(entry.trustedInitiatorDomains)) {
      entry.trustedInitiatorDomains.forEach((domain) => {
        if (typeof domain === "string" && domain !== "") {
          initiatorsByProvider.get(entry.provider).add(domain);
        }
      });
    }
  });
  initiatorsByProvider.forEach((domains, provider) => {
    const label = domains.size === 0 ? "none" : [...domains].join(", ");
    initiatorContainer.appendChild(element("span", "tag", `${provider}: ${label}`));
  });
}

function renderDeviceFlowUserEndpoints(entries) {
  const container = document.getElementById("device-flow-user-list");
  container.innerHTML = "";
  if (entries.length === 0) {
    container.appendChild(element("span", "empty-state", "No endpoints added yet."));
    return;
  }
  entries.forEach((entry) => {
    const tag = element("span", "tag", deviceFlowEndpointLabel(entry));
    const editButton = document.createElement("button");
    editButton.className = "tag-edit";
    editButton.title = "Edit";
    editButton.textContent = "✎";
    editButton.addEventListener("click", () => beginDeviceFlowEdit(entry));
    const removeButton = document.createElement("button");
    removeButton.className = "tag-remove";
    removeButton.title = "Remove";
    removeButton.textContent = "×";
    removeButton.addEventListener("click", async () => {
      const response = await chrome.runtime.sendMessage({ type: "remove_device_flow_endpoint", id: entry.id });
      if (response?.ok === true) renderDeviceFlowUserEndpoints(asObjectArray(response.device_flow_user_endpoints));
      else await loadAndRender();
    });
    tag.append(" ", editButton, removeButton);
    container.appendChild(tag);
  });
}

function beginDeviceFlowEdit(entry) {
  deviceFlowEditingId = entry.id;
  const input = document.getElementById("device-flow-endpoint-input");
  input.value = deviceFlowEndpointLabel(entry);
  document.getElementById("device-flow-endpoint-add").textContent = "Save";
  document.getElementById("device-flow-endpoint-cancel").hidden = false;
  input.focus();
}

function resetDeviceFlowForm() {
  deviceFlowEditingId = null;
  document.getElementById("device-flow-endpoint-input").value = "";
  document.getElementById("device-flow-endpoint-add").textContent = "Add";
  document.getElementById("device-flow-endpoint-cancel").hidden = true;
}

function deviceFlowErrorMessage(code) {
  if (code === "duplicate_endpoint") return "This endpoint is already covered.";
  if (code === "too_many_endpoints") return "You have reached the maximum number of endpoints.";
  if (code === "not_found") return "This endpoint no longer exists.";
  return "Enter an https endpoint with a hostname and path (e.g. login.example.com/device).";
}

function setupDeviceFlowControls() {
  document.getElementById("device-flow-endpoint-add").addEventListener("click", async () => {
    const input = document.getElementById("device-flow-endpoint-input");
    const errorEl = document.getElementById("device-flow-endpoint-error");
    const endpoint = input.value.trim();
    if (!endpoint) return;
    const message = deviceFlowEditingId === null
      ? { type: "add_device_flow_endpoint", endpoint }
      : { type: "update_device_flow_endpoint", id: deviceFlowEditingId, endpoint };
    const response = await chrome.runtime.sendMessage(message);
    if (response?.ok === true) {
      errorEl.hidden = true;
      resetDeviceFlowForm();
      renderDeviceFlowUserEndpoints(asObjectArray(response.device_flow_user_endpoints));
    } else {
      errorEl.textContent = deviceFlowErrorMessage(response?.code);
      errorEl.hidden = false;
    }
  });

  document.getElementById("device-flow-endpoint-cancel").addEventListener("click", () => {
    document.getElementById("device-flow-endpoint-error").hidden = true;
    resetDeviceFlowForm();
  });

  document.getElementById("device-flow-endpoint-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("device-flow-endpoint-add").click();
  });
}

// =============================================================================
// UTILS
// =============================================================================

function formatDate(ddmmyyyy) {
  if (!ddmmyyyy || ddmmyyyy.length !== 8) return ddmmyyyy ?? "—";
  return `${ddmmyyyy.slice(0, 2)}/${ddmmyyyy.slice(2, 4)}/${ddmmyyyy.slice(4)}`;
}

function formatDatetime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

// Undefined for a missing score, on the same contract as yesNo.
function fmt4(val) {
  if (val === undefined || val === null || Number.isNaN(Number(val))) return undefined;
  return Number(val).toFixed(4);
}
