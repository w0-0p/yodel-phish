// =============================================================================
// TRUSTED-ADD INTENTS — issue #8.
//
// A Settings-initiated "Move to trusted" no longer moves a muted site silently
// and captures its logo unvalidated on a later visit. Instead it opens the site
// in a new tab and runs the same interactive logo confirmation as "Add to
// trusted": the move commits only once the user confirms the logo, and a cancel
// leaves the site muted (issue #8).
//
// The one fact that newly opened tab needs — that it is such a confirmation
// flow, not an ordinary visit to analyse for phishing — must survive an MV3
// worker suspension between opening the tab and the content script asking what
// to do. It therefore lives in chrome.storage.session, keyed by tab id, and
// records only what the confirmation needs beyond the tab's own URL: the
// Settings tab to return focus to, and the fqdn the move was started for.
//
// No chrome.* dependency — `storageArea` is injected so this can be unit tested
// under plain Node (see trustedAddIntents.test.mjs), the same pattern
// selectorSessions.mjs and storageQueues.mjs use.
// =============================================================================

import { createStorageDomain } from "./storageQueues.mjs";

export const TRUSTED_ADD_INTENTS_KEY = "trusted_add_intents";

export function emptyTrustedAddIntents() {
  return { intents_by_tab: {} };
}

export function normalizeTrustedAddIntents(value) {
  if (value === null || typeof value !== "object") return emptyTrustedAddIntents();
  return { intents_by_tab: normalizeRecordMap(value.intents_by_tab) };
}

/**
 * The intent store the service worker uses. Every read goes to the injected
 * storage area, so a worker that was suspended and restarted resumes from the
 * same state rather than from an empty map. Writes are serialized through one
 * FIFO domain queue, so concurrent tab events cannot interleave a read and a
 * write of the same key.
 */
export function createTrustedAddIntentStore(storageArea, { queue } = {}) {
  const withState = createStorageDomain({
    storageArea,
    keys: [TRUSTED_ADD_INTENTS_KEY],
    load: (data) => ({ state: normalizeTrustedAddIntents(data[TRUSTED_ADD_INTENTS_KEY]), dirty: false }),
    persist: (state) => ({ [TRUSTED_ADD_INTENTS_KEY]: state }),
    ...(queue === undefined ? {} : { queue }),
  });

  return {
    /** Records that this tab was opened for a move-to-trusted confirmation. */
    async set(tabId, intent) {
      return withState((state) => {
        state.intents_by_tab[tabKey(tabId)] = { ...intent };
        return { value: undefined, changed: true };
      });
    },

    /**
     * The intent bound to this tab, or null. Read-only and never consuming, so
     * it keeps resolving across the reloads and same-site redirects a login
     * page performs before the user confirms. It stays fqdn-scoped at the call
     * site and is consumed when the selector session takes ownership (or
     * discarded by navigation/tab cleanup), so it can never attach to an
     * unrelated site the tab later navigates to.
     */
    async get(tabId) {
      return withState((state) => ({
        value: state.intents_by_tab[tabKey(tabId)] ?? null,
        changed: false,
      }));
    },

    /**
     * Atomically drops and returns whatever is held for a tab. The return value
     * lets navigation/error cleanup recover the Settings tab to refocus while
     * ensuring only one competing cleanup path owns that follow-up.
     */
    async discardTab(tabId) {
      return withState((state) => {
        const key = tabKey(tabId);
        const intent = state.intents_by_tab[key] ?? null;
        delete state.intents_by_tab[key];
        return { value: intent, changed: intent !== null };
      });
    },
  };
}

function tabKey(tabId) {
  return String(tabId);
}

function normalizeRecordMap(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) entries[key] = item;
  }
  return entries;
}
