// =============================================================================
// MANUAL LOGO SELECTOR SESSIONS — issue #24: durable and site-bound.
//
// A manual logo selection spans several user actions and two suspendable
// contexts, so its state cannot live in service-worker variables: MV3 may
// discard the worker between the click that opens the selector and the
// confirmation that saves the crop, which silently loses the flow. Everything
// the flow needs is therefore kept in chrome.storage.session, keyed by tab id
// and small enough to be cheap to rewrite: a session id, the fqdn the selection
// is bound to, the trusted variant it targets when it has one, and — for an
// add-to-trusted session (issue #90) — the parsed origin and score snapshot a
// new entry records, plus the YOLO candidate rectangles the overlay offers.
// The full analysis result is deliberately NOT stored; nothing downstream needs
// more than those scores and boxes.
//
// Being suspendable is only half of it. A tab id is not proof of what is on
// screen: the tab can navigate to another site, or stop being the active tab
// while captureVisibleTab() records whichever tab is active in that window
// instead. Every step that captures or saves therefore re-checks the session
// against the live tab through selectorSessionStatus(), and a selector overlay
// left over from an earlier session is rejected by its session id.
//
// No chrome.* dependency -- `storageArea` is injected so this can be unit
// tested under plain Node (see selectorSessions.test.mjs), the same pattern
// storageQueues.mjs and offscreenQueue.mjs use.
// =============================================================================

import { createStorageDomain } from "./storageQueues.mjs";

export const SELECTOR_STATE_KEY = "logo_selector_state";

export function emptySelectorState() {
  return { sessions_by_tab: {} };
}

export function normalizeSelectorState(value) {
  if (value === null || typeof value !== "object") return emptySelectorState();
  return {
    sessions_by_tab: normalizeRecordMap(value.sessions_by_tab),
  };
}

/**
 * Whether a confirmation may act on this session, and if not, which recoverable
 * reason to report:
 *
 *   - `selector_inactive` — no session for this tab, or the message came from a
 *     selector overlay belonging to a session that has since ended;
 *   - `tab_inactive` — the tab is not the active one in its window, so
 *     captureVisibleTab() would record a different page altogether;
 *   - `page_changed` — the tab navigated away from the fqdn the selection was
 *     opened for, so its content is no longer that site's.
 *
 * `tabFqdn` is the tab's *current* url host, not anything the selector sent: a
 * page cannot vouch for its own identity here.
 */
export function selectorSessionStatus(session, { sessionId, attemptId, tabActive, tabFqdn } = {}) {
  if (session === null || session === undefined) return "selector_inactive";
  if (typeof sessionId !== "string" || sessionId.length === 0) return "selector_inactive";
  if (sessionId !== session.sessionId) return "selector_inactive";
  if (attemptId !== undefined && attemptId !== session.attemptId) return "selector_inactive";
  if (typeof tabFqdn !== "string" || tabFqdn !== session.fqdn) return "page_changed";
  if (tabActive !== true) return "tab_inactive";
  return "ok";
}

/**
 * Tracks only captures currently running in this worker. Browser events mark a
 * matching guard permanently interrupted, so switching or navigating away and
 * back cannot fool two live-tab snapshots into accepting another page.
 */
export function createCaptureTracker() {
  const guards = new Set();
  return {
    begin(tabId, windowId) {
      const guard = { tabId, windowId, interrupted: false };
      guards.add(guard);
      return guard;
    },
    interruptTab(tabId) {
      for (const guard of guards) {
        if (guard.tabId === tabId) guard.interrupted = true;
      }
    },
    interruptWindow(windowId) {
      for (const guard of guards) {
        if (guard.windowId === windowId) guard.interrupted = true;
      }
    },
    isCurrent(guard, tabId, windowId) {
      return guards.has(guard) && !guard.interrupted && guard.tabId === tabId && guard.windowId === windowId;
    },
    end(guard) {
      guards.delete(guard);
    },
  };
}

/**
 * The session store the service worker uses. Every read goes to the injected
 * storage area, so a worker that was suspended and restarted resumes from the
 * same state rather than from an empty Map. Writes are serialized through one
 * FIFO domain queue, so concurrent tab events cannot interleave a read and a
 * write of the same key.
 */
export function createSelectorSessionStore(storageArea, {
  newSessionId = () => crypto.randomUUID(),
  queue,
} = {}) {
  const withState = createStorageDomain({
    storageArea,
    keys: [SELECTOR_STATE_KEY],
    load: (data) => ({ state: normalizeSelectorState(data[SELECTOR_STATE_KEY]), dirty: false }),
    persist: (state) => ({ [SELECTOR_STATE_KEY]: state }),
    ...(queue === undefined ? {} : { queue }),
  });

  return {
    /** The session bound to this tab, or null. */
    async get(tabId) {
      return withState((state) => ({
        value: state.sessions_by_tab[tabKey(tabId)] ?? null,
        changed: false,
      }));
    },

    /**
     * Binds a new session to a tab, replacing any earlier one — which is what
     * makes a leftover overlay's session id stale rather than merely duplicate.
     * Returns the stored session, including its generated id.
     */
    async start(tabId, session) {
      return withState((state) => {
        const stored = { ...session, sessionId: newSessionId() };
        state.sessions_by_tab[tabKey(tabId)] = stored;
        return { value: stored, changed: true };
      });
    },

    /** Starts a new confirmation attempt, superseding any older in-flight one. */
    async beginAttempt(tabId, sessionId) {
      return withState((state) => {
        const key = tabKey(tabId);
        const session = state.sessions_by_tab[key] ?? null;
        if (session === null || session.sessionId !== sessionId) {
          return { value: null, changed: false };
        }
        const stored = { ...session, attemptId: newSessionId() };
        state.sessions_by_tab[key] = stored;
        return { value: stored, changed: true };
      });
    },

    /**
     * Completes only the still-current attempt. A null result means
     * cancellation, replacement, or a newer retry won the race.
     */
    async completeAttempt(tabId, sessionId, attemptId) {
      return withState((state) => {
        const key = tabKey(tabId);
        const session = state.sessions_by_tab[key] ?? null;
        if (session === null || session.sessionId !== sessionId || session.attemptId !== attemptId) {
          return { value: null, changed: false };
        }
        delete state.sessions_by_tab[key];
        return { value: session, changed: true };
      });
    },

    /**
     * Ends a session and returns it, so the caller can run its teardown exactly
     * once. With a `sessionId`, ends only that session: a cancel from a stale
     * overlay must not tear down the session that replaced it.
     */
    async end(tabId, sessionId = undefined) {
      return withState((state) => {
        const key = tabKey(tabId);
        const session = state.sessions_by_tab[key] ?? null;
        if (session === null) return { value: null, changed: false };
        if (sessionId !== undefined && session.sessionId !== sessionId) {
          return { value: null, changed: false };
        }
        delete state.sessions_by_tab[key];
        return { value: session, changed: true };
      });
    },

    /** Drops everything held for a tab; used when the tab itself goes away. */
    async discardTab(tabId) {
      await withState((state) => {
        const key = tabKey(tabId);
        const changed = state.sessions_by_tab[key] !== undefined;
        delete state.sessions_by_tab[key];
        return { value: undefined, changed };
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
