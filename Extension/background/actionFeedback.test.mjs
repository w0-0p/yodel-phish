import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_OUTCOMES,
  ICON_STATE_ANIMATIONS,
  actionFeedbackFor,
  badgeForIconState,
  classifyManualTriggerResponse,
  isAnalysablePageUrl,
} from "./actionFeedback.mjs";

// The whole point of issue #15 is that a click never silently does nothing,
// so the classifier's default has to be a real outcome rather than a gap:
// anything that is not an explicit content-script status is a delivery
// failure, including the shapes the old fire-and-forget path swallowed.
test("only the content script's explicit statuses survive classification", () => {
  assert.equal(classifyManualTriggerResponse({ status: "started" }), ACTION_OUTCOMES.STARTED);
  assert.equal(classifyManualTriggerResponse({ status: "analysing" }), ACTION_OUTCOMES.ANALYSING);
  assert.equal(classifyManualTriggerResponse({ status: "device_flow_active" }), ACTION_OUTCOMES.DEVICE_FLOW_ACTIVE);
});

test("a missing, empty or unrecognized response is a delivery failure", () => {
  for (const response of [
    undefined,
    null,
    {},
    { ok: true },
    { status: "" },
    { status: "queued" },
    { status: "no_login_found" },
    "started",
  ]) {
    assert.equal(
      classifyManualTriggerResponse(response),
      ACTION_OUTCOMES.DELIVERY_FAILED,
      `${JSON.stringify(response)} must not pass as a handled click`
    );
  }
});

test("pages that can host the content script are analysable", () => {
  for (const url of [
    "https://example.test/login",
    "http://example.test/login",
    "https://chrome.google.com/search?q=webstore",
    "file:///home/user/login.html",
  ]) {
    assert.equal(isAnalysablePageUrl(url), true, `${url} should be analysable`);
  }
});

test("a file page is analysable only while a file scan is permitted", () => {
  assert.equal(isAnalysablePageUrl("file:///home/user/login.html", true), true);
  assert.equal(isAnalysablePageUrl("file:///home/user/login.html", false), false);
  // Nothing else changes with the permission -- it is not a general override.
  assert.equal(isAnalysablePageUrl("https://example.test/login", false), true);
  assert.equal(isAnalysablePageUrl("chrome://extensions", true), false);
});

test("pages no content script can run on are recognized as unsupported", () => {
  for (const url of [
    "chrome://extensions",
    "chrome://newtab/",
    "chrome-extension://abcdefghijklmnop/settings/settings.html",
    "devtools://devtools/bundled/inspector.html",
    "about:blank",
    "view-source:https://example.test/login",
    "data:text/html,<input type=password>",
    "ftp://example.test/login",
    "https://chromewebstore.google.com/detail/abcdef",
    "https://chrome.google.com/webstore/detail/abcdef",
    "not a url",
    "",
    undefined,
  ]) {
    assert.equal(isAnalysablePageUrl(url), false, `${url} should not be analysable`);
  }
});

// "Unambiguous" is the acceptance criterion, so no two outcomes may explain
// themselves the same way.
test("every outcome has feedback, and no two outcomes read alike", () => {
  const outcomes = Object.values(ACTION_OUTCOMES);
  const titles = new Set();
  for (const outcome of outcomes) {
    const { title } = actionFeedbackFor(outcome);
    assert.ok(typeof title === "string" && title.length > 0, `${outcome} must have a title`);
    titles.add(title);
  }
  assert.equal(titles.size, outcomes.length, "each outcome needs its own title");
});

// The two outcomes that used to produce nothing at all are the ones where the
// icon is the only surface the extension controls, so they must be visible
// without hovering for the title.
// The popup (issue #51) reports the same outcome in words, so its wording has
// to be as complete and as distinct as the icon's.
test("every outcome has its own popup message", () => {
  const messages = new Set();
  for (const outcome of Object.values(ACTION_OUTCOMES)) {
    const { message } = actionFeedbackFor(outcome);
    assert.ok(typeof message === "string" && message.length > 0, `${outcome} must have a message`);
    messages.add(message);
  }
  assert.equal(messages.size, Object.values(ACTION_OUTCOMES).length, "each outcome needs its own message");
});

test("unsupported pages and delivery failures get a visible badge", () => {
  assert.notEqual(actionFeedbackFor(ACTION_OUTCOMES.UNSUPPORTED_PAGE).badge, null);
  assert.notEqual(actionFeedbackFor(ACTION_OUTCOMES.DELIVERY_FAILED).badge, null);
  assert.notEqual(
    actionFeedbackFor(ACTION_OUTCOMES.UNSUPPORTED_PAGE).badge.text,
    actionFeedbackFor(ACTION_OUTCOMES.DELIVERY_FAILED).badge.text
  );
});

test("started analysis and device-flow feedback leave their durable badges untouched", () => {
  assert.equal(actionFeedbackFor(ACTION_OUTCOMES.STARTED).badge, null);
  assert.equal(actionFeedbackFor(ACTION_OUTCOMES.DEVICE_FLOW_ACTIVE).badge, null);
  assert.match(actionFeedbackFor(ACTION_OUTCOMES.DEVICE_FLOW_ACTIVE).message, /warning remains active/i);
});

test("an already-running analysis always gets visible click feedback", () => {
  assert.equal(actionFeedbackFor(ACTION_OUTCOMES.ANALYSING).badge.text, "…");
});

test("an unknown outcome still produces feedback rather than nothing", () => {
  assert.deepEqual(actionFeedbackFor("something_new"), actionFeedbackFor(ACTION_OUTCOMES.DELIVERY_FAILED));
});

test("icon states map to badges, and an unknown or absent state clears the badge", () => {
  assert.equal(badgeForIconState("analysing").text, "…");
  assert.equal(badgeForIconState("interrupted").text, "!");
  assert.equal(badgeForIconState("unverified").text, "?");
  assert.equal(badgeForIconState("failed").text, "✕");
  assert.equal(badgeForIconState("device_flow").text, "!");
  assert.notEqual(badgeForIconState("device_flow").color, badgeForIconState("active").color);
  assert.equal(badgeForIconState("active").text, "");
  assert.equal(badgeForIconState(undefined).text, "");
});

// Issue #76: an interstitial is the one warning the user cannot miss, so its
// badge is the same blinking red alert a phishing verdict raises.
test("a blocking interstitial raises the blinking red alert", () => {
  assert.equal(badgeForIconState("blocked").color, badgeForIconState("phishing").color);
  assert.equal(badgeForIconState("blocked").text, "✕");
  assert.deepEqual(ICON_STATE_ANIMATIONS.blocked, ICON_STATE_ANIMATIONS.phishing);
});
