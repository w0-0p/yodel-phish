// Issue #32: the current English Google identifier-first sign-in step, in a
// real browser. Localized form-less Google flows are deliberately out of scope:
// both the heading and named action cues used by this bridge are English-only.
//
// login-detector.js is exercised against small emulated fixtures under plain
// Node (content/login-detector.test.js). That emulation stands in for the
// engine behaviour the detector deliberately delegates to -- layout geometry,
// computed style, form ownership, :disabled -- so the shape this issue is about
// is pinned here a second time against Chromium itself, where a hidden step is
// hidden because CSS says so and `input.form` is the parser's answer.
//
// The page is a reduced copy of the current identifier-first step: no <form>
// and no dialog, an identity region holding the visible identifier together
// with the password view it will reveal, and the "Next" action in a sibling
// region -- so nothing smaller than <main> encloses all three. Every variant
// below changes exactly one thing about that page, and no assertion depends on
// a hostname, an id, or a generated class name.
//
// The detector is loaded as the page's own script, exactly as the content
// script loads it, and the page is served by intercepting the request so
// location.protocol really is https:.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "../../Extension/node_modules/playwright/index.mjs";

const loginDetectorSource = readFileSync(
  new URL("../../Extension/content/login-detector.js", import.meta.url),
  "utf8"
);

const PAGE_URL = "https://accounts.yodel-phish.test/signin/identifier";

// Meaning-free wrappers, as deeply nested as the real page's are. They carry no
// information the detector may read: only the tree shape matters.
const wrap = (levels, markup) =>
  Array.from({ length: levels }).reduce((inner) => `<div><div>${inner}</div></div>`, markup);

const HEADING = `<h1>Sign in</h1>`;

const IDENTIFIER_FIELD = wrap(3, `
  <label for="identifier">Email or phone</label>
  <input id="identifier" name="identifier" type="text"
         autocomplete="username webauthn" autocapitalize="none" spellcheck="false">`);

// The password view of the next step: in the DOM from the start, hidden by the
// page's own stylesheet, and carrying neither autocomplete="current-password"
// nor any authentication cue of its own.
const FUTURE_PASSWORD_STEP = wrap(3, `
  <div class="step-hidden"><input name="Passwd" type="password" autocomplete="off"></div>`);

const NEXT_ACTION = wrap(3, `<button type="button">Next</button>`);

function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <title>Sign in</title>
    <style>
      body { margin: 0; font: 16px system-ui, sans-serif; }
      main { max-width: 420px; margin: 48px auto; }
      .step-hidden { display: none; }
      input, button { font: inherit; padding: 8px; }
    </style></head><body>${body}</body></html>`;
}

// The page under test, plus the one-change variants that must not match.
const PAGES = {
  // The regression itself: identifier and its future password step share a
  // region below <main>, the action shares only <main>.
  identifierStep: page(`<main>${HEADING}
    <div>${IDENTIFIER_FIELD}${FUTURE_PASSWORD_STEP}</div>
    <div>${NEXT_ACTION}</div>
  </main>`),

  // Same tree with the authentication heading removed.
  noHeading: page(`<main>
    <div>${IDENTIFIER_FIELD}${FUTURE_PASSWORD_STEP}</div>
    <div>${NEXT_ACTION}</div>
  </main>`),

  // The password input is not part of the identity region: three unrelated
  // branches of one landmark are not a credential flow.
  passwordInUnrelatedBranch: page(`<main>${HEADING}
    <div>${IDENTIFIER_FIELD}</div>
    <div>${FUTURE_PASSWORD_STEP}</div>
    <div>${NEXT_ACTION}</div>
  </main>`),

  // A matching heading inside a separate dialog cannot name the landmark.
  headingInSeparateDialog: page(`<main>
    <div>${IDENTIFIER_FIELD}${FUTURE_PASSWORD_STEP}</div>
    <div>${NEXT_ACTION}</div>
    <div role="dialog"><h1>Sign in</h1></div>
  </main>`),

  // A nested application landmark owns its heading, so the surrounding main
  // cannot borrow that authentication cue.
  headingInNestedLandmark: page(`<main>
    <div>${IDENTIFIER_FIELD}${FUTURE_PASSWORD_STEP}</div>
    <div>${NEXT_ACTION}</div>
    <section role="application"><h1>Sign in</h1></section>
  </main>`),

  // A heading inside a separate native form names that form, not the main
  // landmark around it.
  headingInSeparateForm: page(`<main>
    <div>${IDENTIFIER_FIELD}${FUTURE_PASSWORD_STEP}</div>
    <div>${NEXT_ACTION}</div>
    <form action="/other"><h1>Sign in</h1></form>
  </main>`),

  // The password step is fenced inside a nested application landmark and
  // therefore cannot belong to the identifier in the surrounding main.
  passwordInNestedLandmark: page(`<main>${HEADING}
    <div>${IDENTIFIER_FIELD}<section role="application">${FUTURE_PASSWORD_STEP}</section></div>
    <div>${NEXT_ACTION}</div>
  </main>`),

  // The action belongs to another form, which the form-less identifier field is
  // not part of. `button.form` is the browser's own answer here.
  actionOwnedByAnotherForm: page(`<main>${HEADING}
    <div>${IDENTIFIER_FIELD}${FUTURE_PASSWORD_STEP}</div>
    <div><form action="/search" method="get">${wrap(2, `<button>Next</button>`)}</form></div>
  </main>`),

  // The action is inside a separate dialog region.
  actionInSeparateDialog: page(`<main>${HEADING}
    <div>${IDENTIFIER_FIELD}${FUTURE_PASSWORD_STEP}</div>
    <div role="dialog" aria-modal="true">${wrap(2, `<button type="button">Next</button>`)}</div>
  </main>`),

  // A newsletter widget whose honeypot password sits right beside its email
  // field, on a page whose landmark does carry a sign-in heading.
  newsletterHoneypot: page(`<main><h1>Sign in to read more</h1>
    <div>${wrap(3, `
      <label for="news">Email address</label>
      <input id="news" type="email" autocomplete="email">
      <input type="password" name="hp" class="step-hidden">`)}</div>
    <div>${wrap(3, `<button type="button">Subscribe</button>`)}</div>
    <div>${NEXT_ACTION}</div>
  </main>`),

  // The account-settings screen this pattern must never claim: a "Sign in
  // details" section heading, a profile region, and a forward action.
  profileSettings: page(`<main><h2>Sign in details</h2>
    <div><h3>Profile settings</h3>
      ${wrap(1, `<input name="identifier" type="text" autocomplete="username">`)}
      ${wrap(1, `<div class="step-hidden"><input name="Passwd" type="password"></div>`)}
    </div>
    <div>${wrap(3, `<button type="button">Continue</button>`)}</div>
  </main>`),
};

async function detectOn(context, html) {
  const page = await context.newPage();
  await page.route(`${PAGE_URL}*`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
  );
  await page.goto(PAGE_URL);
  await page.addScriptTag({ content: loginDetectorSource });
  const result = await page.evaluate(() => {
    const detector = window.YodelLoginDetector;
    return {
      ...detector.detectLoginPage(),
      identity: detector.IDENTITY_CONFIDENCE,
      password: detector.PASSWORD_CONFIDENCE,
    };
  });
  return { page, result };
}

const configuredExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser = await chromium.launch({
  headless: true,
  ...(configuredExecutable ? { executablePath: configuredExecutable } : {}),
});

try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });

  // ---------------------------------------------------------------------------
  // 1. The identifier step itself, and the credential step it leads to.
  // ---------------------------------------------------------------------------
  {
    const { page, result } = await detectOn(context, PAGES.identifierStep);
    assert.equal(result.isLogin, true, "the identifier-first step must be recognised as a login page");
    assert.equal(result.confidence, result.identity);

    // Step 2 in the same document: the page reveals the password view it was
    // already carrying. The active password field alone now decides.
    const revealed = await page.evaluate(() => {
      document.querySelector(".step-hidden").classList.remove("step-hidden");
      return window.YodelLoginDetector.detectLoginPage();
    });
    assert.equal(revealed.isLogin, true);
    assert.equal(revealed.confidence, result.password, "the revealed credential step keeps its own confidence");

    await page.close();
    console.log("  identifier step detected at identity confidence, credential step at password confidence");
  }

  // ---------------------------------------------------------------------------
  // 2. One change each: every condition of the pattern is load bearing, and
  //    sharing a landmark on its own never associates anything.
  // ---------------------------------------------------------------------------
  const negatives = [
    ["noHeading", "no authentication heading in the landmark"],
    ["passwordInUnrelatedBranch", "password step outside the identity region"],
    ["headingInSeparateDialog", "authentication heading inside a separate dialog"],
    ["headingInNestedLandmark", "authentication heading inside a nested application landmark"],
    ["headingInSeparateForm", "authentication heading inside an unrelated form"],
    ["passwordInNestedLandmark", "password step inside a nested application landmark"],
    ["actionOwnedByAnotherForm", "action owned by another form"],
    ["actionInSeparateDialog", "action inside a separate dialog"],
    ["newsletterHoneypot", "newsletter field with a hidden honeypot password"],
    ["profileSettings", "profile/settings region"],
  ];

  for (const [name, description] of negatives) {
    const { page, result } = await detectOn(context, PAGES[name]);
    assert.deepEqual(
      { isLogin: result.isLogin, confidence: result.confidence },
      { isLogin: false, confidence: 0 },
      `${description} must not be a login page`
    );
    await page.close();
    console.log(`  not a login page: ${description}`);
  }

  await context.close();
  console.log("Login detection browser test passed");
} finally {
  await browser.close();
}
