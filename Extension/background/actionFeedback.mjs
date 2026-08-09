// =============================================================================
// ACTION ICON FEEDBACK — issue #15: every extension-icon click must produce
// immediate, unambiguous feedback.
//
// Pure decision logic with no chrome.* dependency, so it runs and can be
// unit-tested under plain Node. The service worker owns every side effect
// (delivering manual_trigger, writing the badge and the title); this module
// only answers three questions:
//   - can a tab's URL host the content script at all?
//   - what did the content script actually report for the click?
//   - what should the icon show for the resulting outcome?
// =============================================================================

// How long a click's badge/title stays up before the icon reverts to the tab's
// analysis state. Long enough to read, short enough that it cannot be mistaken
// for a durable verdict.
export const ACTION_FEEDBACK_DURATION_MS = 4_000;

// The five outcomes of one click. The first three are reported by content.js,
// which returns an explicit status for every manual trigger it handles; the
// last two are decided here, because no content script answered at all.
export const ACTION_OUTCOMES = Object.freeze({
  STARTED: "started",
  ANALYSING: "analysing",
  DEVICE_FLOW_ACTIVE: "device_flow_active",
  UNSUPPORTED_PAGE: "unsupported_page",
  DELIVERY_FAILED: "delivery_failed",
});

const CONTENT_STATUSES = new Set([
  ACTION_OUTCOMES.STARTED,
  ACTION_OUTCOMES.ANALYSING,
  ACTION_OUTCOMES.DEVICE_FLOW_ACTIVE,
]);

// Anything that is not one of the content script's own statuses means the
// message never reached a listener that could handle it -- an unanswered
// sendMessage, a stale content script from a previous extension version, a
// response shape this build does not recognize. All of them are delivery
// failures from the user's point of view: the click did not do anything.
export function classifyManualTriggerResponse(response) {
  const status = response?.status;
  return CONTENT_STATUSES.has(status) ? status : ACTION_OUTCOMES.DELIVERY_FAILED;
}

// Content scripts never run on browser-internal pages, on other extensions'
// pages (including this extension's own settings/interstitial pages), or on
// the Chrome Web Store. Recognizing those up front keeps them out of the
// delivery-failure bucket: the page is not broken and reloading it would not
// help, it is simply out of the extension's reach.
const CONTENT_SCRIPT_PROTOCOLS = new Set(["http:", "https:", "file:"]);

export function isAnalysablePageUrl(url, fileScanAllowed = true) {
  if (typeof url !== "string" || url === "") return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!CONTENT_SCRIPT_PROTOCOLS.has(parsed.protocol)) return false;
  if (parsed.protocol === "file:" && !fileScanAllowed) return false;
  if (parsed.hostname === "chromewebstore.google.com") return false;
  if (parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore")) return false;
  return true;
}

const BADGE_GREY = "#64748b";
const BADGE_ORANGE = "#e65100";
const BADGE_GREEN = "#16a34a";
const BADGE_RED = "#b71c1c";

// Durable per-tab analysis state, pushed by content.js via set_icon_state.
// The verdict states (issue #3) mirror the banner: green check when safe,
// orange "!" for a warning, red cross on a phishing page. "blocked" is the
// same alert asserted by an interstitial page itself (issue #76), which no
// content script can reach -- navigating to it clears the analysed page's own
// badge, so the icon would otherwise go idle behind a blocking warning.
const ICON_STATE_BADGES = Object.freeze({
  analysing: { text: "…", color: BADGE_GREY },
  interrupted: { text: "!", color: BADGE_ORANGE },
  unverified: { text: "?", color: BADGE_ORANGE },
  failed: { text: "✕", color: BADGE_ORANGE },
  device_flow: { text: "!", color: BADGE_ORANGE },
  safe: { text: "✓", color: BADGE_GREEN },
  suspicious: { text: "!", color: BADGE_ORANGE },
  phishing: { text: "✕", color: BADGE_RED },
  blocked: { text: "✕", color: BADGE_RED },
});

// Badge animations (issue #3): "analysing" pulses its dots, and the two red
// alert states blink. Frame 0 is the initial badge text written with the state.
export const ICON_STATE_ANIMATIONS = Object.freeze({
  analysing: Object.freeze([".", "..", "..."]),
  phishing: Object.freeze(["✕", ""]),
  blocked: Object.freeze(["✕", ""]),
});

const IDLE_BADGE = Object.freeze({ text: "", color: BADGE_GREEN });

export function badgeForIconState(state) {
  return ICON_STATE_BADGES[state] ?? IDLE_BADGE;
}

// Transient per-click feedback. `badge: null` means "leave the badge alone":
// a newly started analysis has already set its durable "…" badge. An
// already-running analysis gets an explicit transient badge because some
// internal analysis modes deliberately keep the durable icon in its idle
// state. The outcomes that cannot use page UI get visible badges of their own.
//
// `title` is the icon tooltip; `message` is the same answer written for the
// popup (issue #51), where the extension's name is already on screen.
const ACTION_FEEDBACK = Object.freeze({
  [ACTION_OUTCOMES.STARTED]: {
    badge: null,
    title: "Yodel Phish — checking this page…",
    message: "Checking this page…",
  },
  [ACTION_OUTCOMES.ANALYSING]: {
    badge: { text: "…", color: BADGE_GREY },
    title: "Yodel Phish — a check is already running on this page",
    message: "A check is already running on this page.",
  },
  [ACTION_OUTCOMES.DEVICE_FLOW_ACTIVE]: {
    badge: null,
    title: "Yodel Phish — device-code warning active on this page",
    message: "The device-code warning remains active on this page.",
  },
  [ACTION_OUTCOMES.UNSUPPORTED_PAGE]: {
    badge: { text: "—", color: BADGE_GREY },
    title: "Yodel Phish — this page cannot be checked",
    message: "This page cannot be checked.",
  },
  [ACTION_OUTCOMES.DELIVERY_FAILED]: {
    badge: { text: "!", color: BADGE_ORANGE },
    title: "Yodel Phish — could not reach this page. Reload it, then try again.",
    message: "Could not reach this page. Reload it, then try again.",
  },
});

export function actionFeedbackFor(outcome) {
  return ACTION_FEEDBACK[outcome] ?? ACTION_FEEDBACK[ACTION_OUTCOMES.DELIVERY_FAILED];
}
