// Issue #9: the in-page banner must render identically no matter what the host
// page's stylesheet does. The banner lives in a closed Shadow Root, so this
// test loads the real content script into two pages whose CSS pulls in
// opposite directions — a loud button theme with hostile !important rules and
// a global `all: unset` reset — shows the same banner states on both, and
// asserts the computed styles of every control are identical across the two
// pages (and match the intended design on both). It also asserts the reverse
// boundary: extension styling must not reach page-owned elements, including
// decoys reusing the banner's own class names.
//
// The content script is injected into the main world here rather than an
// isolated world; style isolation is a property of the DOM, not of the world
// the script runs in. Element.prototype.attachShadow is patched before the
// script loads so the test can reach behind the closed root — test-only
// scaffolding, nothing in the shipped code exposes the root.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "../../Extension/node_modules/playwright/index.mjs";

const loginDetectorSource = readFileSync(
  new URL("../../Extension/content/login-detector.js", import.meta.url),
  "utf8"
);
const contentSource = readFileSync(
  new URL("../../Extension/content/content.js", import.meta.url),
  "utf8"
);

// Both pages carry a decoy button reusing the banner's public-looking class
// names, proving those names are meaningless outside the shadow root.
const DECOY = `<button id="decoy" class="yp-btn yp-btn-add">page button</button>`;

const HOSTILE_PAGES = {
  themed: `<!doctype html><html><head><style>
      :root {
        --yp-blue: #ff00ff;
        --yp-green: #000000;
        --yp-white: #333333;
        --yp-bg: #123456;
        --yp-text-dark: #00ff00;
        --yp-font: "Comic Sans MS", cursive;
      }
      div { display: none !important; }
      button, .yp-btn {
        all: unset;
        background: purple !important;
        color: yellow !important;
        border: 5px dashed lime !important;
        border-radius: 20px !important;
        font: italic 900 30px/3 "Comic Sans MS", cursive !important;
        letter-spacing: 6px !important;
        text-transform: uppercase !important;
        text-shadow: 2px 2px red !important;
        box-shadow: 0 0 9px blue !important;
        padding: 30px !important;
        cursor: wait !important;
      }
      svg { display: none !important; width: 3px !important; }
      #yp-banner { position: absolute !important; background: black !important; }
      [hidden] { display: inline !important; }
      @keyframes yp-spin { to { transform: none; } }
    </style></head><body><p>themed page</p>${DECOY}</body></html>`,
  reset: `<!doctype html><html><head><style>
      * { all: unset !important; }
    </style></head><body><p>reset page</p>${DECOY}</body></html>`,
  rtl: `<!doctype html><html dir="rtl" lang="ar"><head><style>
      * { all: unset !important; }
      html, body { direction: rtl !important; unicode-bidi: bidi-override !important; }
    </style></head><body><p>rtl page</p>${DECOY}</body></html>`,
};

const configuredExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser = await chromium.launch({
  headless: true,
  ...(configuredExecutable ? { executablePath: configuredExecutable } : {}),
});

async function snapshotBannerOnPage(context, html) {
  const page = await context.newPage();
  await page.setContent(html);

  await page.evaluate(() => {
    window.__ypShadows = [];
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const shadow = originalAttachShadow.call(this, options);
      window.__ypShadows.push({ host: this, shadow, mode: options?.mode });
      return shadow;
    };
    window.chrome = {
      runtime: {
        onMessage: {
          addListener(listener) {
            window.__ypDispatch = listener;
          },
        },
        sendMessage() {
          return Promise.resolve({});
        },
      },
    };
  });
  await page.addScriptTag({ content: loginDetectorSource });
  await page.addScriptTag({ content: contentSource });

  const snapshot = await page.evaluate(() => {
    const BUTTON_PROPS = [
      "appearance", "background-color", "color",
      "border-top-style", "border-top-width", "border-top-color", "border-radius",
      "margin-top", "padding-top", "padding-left",
      "font-family", "font-size", "font-style", "font-weight", "line-height",
      "letter-spacing", "text-transform", "text-shadow", "text-decoration-line",
      "box-shadow", "cursor", "display", "opacity", "visibility",
    ];
    const pick = (element, props) => {
      const computed = getComputedStyle(element);
      return Object.fromEntries(props.map((prop) => [prop, computed.getPropertyValue(prop)]));
    };

    const captureState = (verdict, data, buttonSelectors) => {
      window.__ypDispatch({ type: "show_banner", verdict, data }, {}, () => {});
      const mounted = window.__ypShadows.at(-1);
      const banner = mounted.shadow.querySelector("#yp-banner");
      const buttons = {};
      for (const selector of buttonSelectors) {
        const button = banner.querySelector(selector);
        buttons[selector] = button === null ? null : pick(button, BUTTON_PROPS);
      }
      return {
        host: pick(mounted.host, [
          "display", "position", "top", "left", "right", "z-index",
          "direction", "unicode-bidi", "pointer-events",
        ]),
        banner: pick(banner, [
          "background-color", "color", "font-family", "font-size", "display",
          "direction", "pointer-events",
        ]),
        icon: pick(banner.querySelector(".yp-icon svg"), ["display", "width", "height"]),
        buttons,
      };
    };

    const states = {
      unknown: captureState("unknown", { fqdn: "accounts.example.test" }, [
        ".yp-btn-add", ".yp-btn-mute", ".yp-btn-close", ".yp-btn-reanalyse",
      ]),
      page_changed: captureState("page_changed", {}, [".yp-btn-reanalyse", ".yp-btn-close-x"]),
      analysis_failed: captureState("analysis_failed", { code: "job_timeout" }, [
        ".yp-btn-retry", ".yp-btn-close-x",
      ]),
    };

    const mounted = window.__ypShadows.at(-1);
    const banner = mounted.shadow.querySelector("#yp-banner");
    const visibleHitIsHost = document.elementFromPoint(5, 5) === mounted.host;
    banner.style.visibility = "hidden";
    const hiddenHitIsHost = document.elementFromPoint(5, 5) === mounted.host;
    banner.style.visibility = "";
    return {
      states,
      shadowMode: mounted.mode,
      hostId: mounted.host.getAttribute("id"),
      hostClass: mounted.host.getAttribute("class"),
      bannerLang: banner.getAttribute("lang"),
      bannerDir: banner.getAttribute("dir"),
      visibleHitIsHost,
      hiddenHitIsHost,
      bannerHeight: mounted.host.getBoundingClientRect().height,
      documentStyleCount: document.querySelectorAll("style").length,
      decoyBackground: getComputedStyle(document.getElementById("decoy")).backgroundColor,
    };
  });

  await page.close();
  return snapshot;
}

try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const themed = await snapshotBannerOnPage(context, HOSTILE_PAGES.themed);
  const reset = await snapshotBannerOnPage(context, HOSTILE_PAGES.reset);
  const rtl = await snapshotBannerOnPage(context, HOSTILE_PAGES.rtl);

  // The heart of the regression: every state and every control computes the
  // same styles on both conflicting pages.
  assert.deepEqual(themed.states, reset.states);
  assert.deepEqual(themed.states, rtl.states);

  for (const [label, snapshot] of [["themed", themed], ["reset", reset], ["rtl", rtl]]) {
    const { unknown, page_changed, analysis_failed } = snapshot.states;

    assert.equal(snapshot.shadowMode, "closed", `${label}: the banner root must be closed`);
    assert.equal(snapshot.hostId, null, `${label}: the host must not expose an id`);
    assert.equal(snapshot.hostClass, null, `${label}: the host must not expose a class`);

    // The host survives the page's own `div { display: none !important }` and
    // `* { all: unset !important }`: shadow-context !important outranks the
    // host document's rules on the host element.
    assert.equal(unknown.host.display, "block", `${label}: page CSS must not collapse the banner host`);
    assert.equal(unknown.host.position, "fixed", `${label}: page CSS must not reposition the banner`);
    assert.equal(unknown.host["z-index"], "2147483647", `${label}: the banner stays on top`);
    assert.equal(unknown.host.direction, "ltr", `${label}: host direction cannot reorder the banner`);
    assert.equal(unknown.host["unicode-bidi"], "isolate", `${label}: host bidi is isolated`);
    assert.equal(unknown.host["pointer-events"], "none", `${label}: the transparent host never intercepts clicks`);
    assert.equal(unknown.banner.direction, "ltr", `${label}: banner text direction is explicit`);
    assert.equal(unknown.banner["pointer-events"], "auto", `${label}: visible banner controls remain interactive`);
    assert.equal(snapshot.bannerLang, "en", `${label}: English banner copy is labelled`);
    assert.equal(snapshot.bannerDir, "ltr", `${label}: banner markup declares its direction`);
    assert.equal(snapshot.visibleHitIsHost, true, `${label}: a visible shadow banner participates in hit testing`);
    assert.equal(snapshot.hiddenHitIsHost, false, `${label}: a capture-hidden banner passes clicks through`);
    assert.ok(snapshot.bannerHeight > 0, `${label}: the banner must actually render`);

    // The unknown verdict's intended design, immune to the page's --yp-*
    // custom-property poisoning and typography.
    assert.equal(unknown.banner["background-color"], "rgb(245, 245, 245)", `${label}: --yp-white palette entry`);
    assert.equal(unknown.banner.color, "rgb(33, 33, 33)", `${label}: dark text on the light verdict`);
    assert.equal(unknown.banner["font-size"], "14px", `${label}: banner typography is its own`);
    assert.match(unknown.banner["font-family"], /system-ui/, `${label}: banner font ignores the page's`);
    assert.equal(unknown.icon.display, "block", `${label}: page svg rules must not hide the verdict icon`);
    assert.equal(unknown.icon.width, "21px", `${label}: icon is 1.5em of the banner's own font size`);

    // Every control renders its explicit intended style (issue #9's observed
    // bug: mute and close had no rules at all and fell back to page styling).
    const add = unknown.buttons[".yp-btn-add"];
    const mute = unknown.buttons[".yp-btn-mute"];
    const close = unknown.buttons[".yp-btn-close"];
    assert.equal(add["background-color"], "rgb(46, 125, 50)", `${label}: Add is the solid green action`);
    assert.equal(add.color, "rgb(255, 255, 255)", `${label}: Add keeps light text on any page`);
    assert.equal(mute["background-color"], "rgb(117, 117, 117)", `${label}: Mute is the solid grey action`);
    assert.equal(close["border-top-style"], "solid", `${label}: Close is the outlined action`);
    assert.equal(close["background-color"], "rgba(0, 0, 0, 0)", `${label}: Close stays transparent`);
    for (const [name, button] of Object.entries({ add, mute, close })) {
      assert.equal(button.appearance, "none", `${label}: ${name} resets native appearance`);
      assert.equal(button["font-size"], "13.02px", `${label}: ${name} is 0.93em of the banner text`);
      assert.equal(button["font-weight"], "500", `${label}: ${name} ignores the page font weight`);
      assert.equal(button["letter-spacing"], "normal", `${label}: ${name} ignores page letter-spacing`);
      assert.equal(button["text-transform"], "none", `${label}: ${name} ignores page text-transform`);
      assert.equal(button["text-shadow"], "none", `${label}: ${name} ignores page text-shadow`);
      assert.equal(button["box-shadow"], "none", `${label}: ${name} ignores page box-shadow`);
      assert.equal(button.cursor, "pointer", `${label}: ${name} keeps pointer behavior`);
      assert.match(button["font-family"], /system-ui/, `${label}: ${name} keeps the banner font`);
    }

    // Delayed re-analyse: hidden on a fresh unknown verdict (the page's
    // `[hidden] { display: inline !important }` cannot force it visible),
    // shown on page_changed.
    // Flex items blockify, so the revealed controls compute block/flex.
    assert.equal(unknown.buttons[".yp-btn-reanalyse"].display, "none", `${label}: re-analyse starts hidden`);
    assert.equal(page_changed.buttons[".yp-btn-reanalyse"].display, "block", `${label}: re-analyse is revealed`);
    assert.equal(page_changed.buttons[".yp-btn-close-x"].display, "flex", `${label}: icon-only close renders`);

    assert.equal(analysis_failed.buttons[".yp-btn-retry"]["background-color"], "rgb(46, 125, 50)", `${label}: Retry is styled`);
    assert.equal(analysis_failed.banner["background-color"], "rgb(230, 81, 0)", `${label}: failure banner is orange`);

    // The reverse boundary: no extension stylesheet lands in the document, and
    // page elements wearing the banner's class names take nothing from it.
    assert.equal(snapshot.documentStyleCount, 1, `${label}: only the page's own style element exists`);
    assert.notEqual(snapshot.decoyBackground, "rgb(46, 125, 50)", `${label}: banner CSS must not style page decoys`);
  }

  assert.equal(themed.decoyBackground, "rgb(128, 0, 128)", "the themed page's own button theme still applies to its button");

  await context.close();
  console.log("Banner isolation browser test passed");
} finally {
  await browser.close();
}
