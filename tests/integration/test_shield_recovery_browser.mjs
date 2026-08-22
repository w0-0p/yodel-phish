// Issue #23: the busy shield swallows every click on the page, so it may only
// ever be up while the user can still reach a Cancel control. This test drives
// the real, unmodified content script on a real HTTPS login page in Chromium
// and asserts that pairing with the browser's own hit testing --
// document.elementFromPoint() -- rather than with internal state:
//
//   1. a healthy capture hides the banner for the screenshot alone, and its
//      Cancel really releases the page afterwards;
//   2. a capture that never reports back recovers on its own deadline, with a
//      visible, clickable retry banner and an interactive page;
//   3. a page that removes the anonymous banner host from under a live shield
//      gets the banner back, still able to end the analysis;
//   4. a provisional trusted verdict removes the shield while its background
//      drift check continues;
//   5. a connected host moved below hidden page content is treated as
//      unreachable and remounted with a genuinely clickable Cancel.
//
// The page is served by intercepting the request, so location.protocol really
// is https: and the script takes exactly the code path it does in the wild.
// Element.prototype.attachShadow is patched before the script loads so the
// test can reach behind the closed banner root -- test-only scaffolding, and
// nothing in the shipped code exposes it.

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

// Must stay in step with CAPTURE_RECOVERY_TIMEOUT_MS in content.js. The test
// only ever waits *longer* than it, so a future increase makes this slower
// rather than flaky -- but it would stop proving the deadline is bounded, so
// the assertion below fails if recovery approaches a job deadline.
const CAPTURE_RECOVERY_TIMEOUT_MS = 10_000;
const RECOVERY_WAIT_MS = CAPTURE_RECOVERY_TIMEOUT_MS + 20_000;

const PAGE_URL = "https://login.yodel-phish.test/signin";

// Whether the automatic login detector or the explicit trigger below wins the
// race decides only the progress wording, never the lifecycle under test.
const PROGRESS_VERDICTS = new Set(["analysing", "analysing_manual"]);

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <title>Sign in</title>
  <style>
    body { margin: 0; font: 16px system-ui, sans-serif; }
    main { height: 100vh; display: flex; align-items: center; justify-content: center; }
    form { display: grid; gap: 12px; width: 280px; }
    input, button { font: inherit; padding: 8px; }
  </style></head>
  <body><main>
    <form id="signin" action="/session" method="post">
      <h1>Sign in</h1>
      <label for="user">Email</label>
      <input id="user" name="username" type="email" autocomplete="username">
      <label for="pass">Password</label>
      <input id="pass" name="password" type="password" autocomplete="current-password">
      <button id="submit" type="submit">Sign in</button>
    </form>
  </main></body></html>`;

// Installed before any page script: the extension messaging surface the
// content script expects, plus the observation helpers the test drives it
// through.
function installHarness() {
  window.__ypSent = [];
  window.__ypShadows = [];

  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (options) {
    const shadow = originalAttachShadow.call(this, options);
    window.__ypShadows.push({ host: this, shadow });
    return shadow;
  };

  window.chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          window.__ypDispatch = listener;
        },
      },
      sendMessage(message) {
        window.__ypSent.push(message);
        return Promise.resolve({});
      },
    },
  };

  // One inbound message, awaited the way the service worker awaits it: some
  // handlers answer synchronously and some (prepare_capture) return true and
  // answer later.
  window.__ypSend = (message) =>
    new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value ?? null);
      };
      const asynchronous = window.__ypDispatch(message, {}, done);
      if (asynchronous !== true) done(undefined);
    });

  // The banner as the *page* sees it: the most recent shadow host that is
  // still in the document. A host the page detached is not a banner.
  window.__ypBanner = () => {
    for (let index = window.__ypShadows.length - 1; index >= 0; index -= 1) {
      const entry = window.__ypShadows[index];
      if (entry.host.isConnected) return entry;
    }
    return null;
  };

  // The shield is the only body child carrying the busy cursor.
  window.__ypShield = () =>
    [...document.body.children].find((element) => getComputedStyle(element).cursor === "progress") ?? null;

  // What the browser says owns a point, which is the only thing that decides
  // whether the user can click anything.
  window.__ypHitAt = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    if (hit === null) return { kind: "none" };
    if (hit === window.__ypShield()) return { kind: "shield" };
    const banner = window.__ypBanner();
    if (banner !== null && hit === banner.host) return { kind: "banner" };
    return { kind: "page", id: hit.id, tag: hit.tagName };
  };

  window.__ypHitPageCentre = () =>
    window.__ypHitAt(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));

  // Inside the banner's own strip: only a *visible* banner takes hits there.
  window.__ypHitBannerStrip = () => {
    const banner = window.__ypBanner();
    if (banner === null) return { kind: "none" };
    const rect = banner.host.getBoundingClientRect();
    return window.__ypHitAt(Math.floor(rect.left + rect.width / 2), Math.floor(rect.top + rect.height / 2));
  };

  window.__ypBannerState = () => {
    const banner = window.__ypBanner();
    const element = banner?.shadow.querySelector("#yp-banner") ?? null;
    if (element === null) return null;
    return {
      verdict: element.getAttribute("data-verdict"),
      visibility: getComputedStyle(element).visibility,
      text: element.textContent.replace(/\s+/g, " ").trim(),
      controls: [...element.querySelectorAll(".yp-btn")].map((button) => button.className),
      hostCount: window.__ypShadows.length,
    };
  };

  window.__ypClickBannerControl = (selector) => {
    const button = window.__ypBanner()?.shadow.querySelector(selector) ?? null;
    if (button === null) return false;
    button.click();
    return true;
  };

  // A cancellable submission, to see whether the credential blocker is still on.
  window.__ypSubmissionBlocked = () =>
    !document.getElementById("signin").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );

  window.__ypCancelsSent = () =>
    window.__ypSent.filter((message) => message.type === "cancel_current_analysis").length;
}

async function openAnalysedLoginPage(context) {
  const page = await context.newPage();
  await page.route(`${PAGE_URL}*`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: LOGIN_PAGE })
  );
  await page.addInitScript(installHarness);
  await page.goto(PAGE_URL);
  await page.addScriptTag({ content: loginDetectorSource });
  await page.addScriptTag({ content: contentSource });

  // An explicit trigger, so the test never depends on detector tuning. It
  // reports the job id whether it started the job or found the automatic one
  // already in flight.
  const jobId = await page.evaluate(async () => {
    const response = await window.__ypSend({ type: "manual_trigger" });
    return response?.jobId ?? null;
  });
  assert.equal(typeof jobId, "string", "the content script should report a job id");

  // The shield goes up with the job; the progress banner is deliberately
  // delayed behind the pending screenshot.
  await page.waitForFunction(() => window.__ypBannerState() !== null, null, { timeout: 15_000 });
  assert.deepEqual(await page.evaluate(() => window.__ypHitPageCentre()), { kind: "shield" },
    "an analysis in flight must own page hit testing");

  return { page, jobId };
}

const configuredExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser = await chromium.launch({
  headless: true,
  ...(configuredExecutable ? { executablePath: configuredExecutable } : {}),
});

try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });

  // ---------------------------------------------------------------------------
  // 1. The healthy handshake: hidden for exactly the screenshot, and the way
  //    out works on the other side of it.
  // ---------------------------------------------------------------------------
  {
    const { page, jobId } = await openAnalysedLoginPage(context);

    const beforeCapture = await page.evaluate(() => window.__ypBannerState());
    assert.equal(beforeCapture.visibility, "visible", "the progress banner starts visible");
    assert.ok(beforeCapture.controls.includes("yp-btn yp-btn-cancel"), "progress offers Cancel");

    const prepared = await page.evaluate((id) => window.__ypSend({ type: "prepare_capture", jobId: id }), jobId);
    assert.deepEqual(prepared, { ok: true }, "the page reports itself ready for the screenshot");

    const duringCapture = await page.evaluate(() => ({
      banner: window.__ypBannerState(),
      strip: window.__ypHitBannerStrip(),
      shieldUp: window.__ypShield() !== null,
    }));
    assert.equal(duringCapture.banner.visibility, "hidden", "the screenshot must not contain the banner");
    assert.notEqual(duringCapture.strip.kind, "banner", "a hidden banner takes no hits either");
    assert.equal(duringCapture.shieldUp, true);

    await page.evaluate((id) => window.__ypSend({ type: "capture_complete", jobId: id }), jobId);

    const afterCapture = await page.evaluate(() => ({
      banner: window.__ypBannerState(),
      strip: window.__ypHitBannerStrip(),
      centre: window.__ypHitPageCentre(),
    }));
    assert.equal(afterCapture.banner.visibility, "visible", "the capture is what gives the banner back");
    assert.ok(PROGRESS_VERDICTS.has(afterCapture.banner.verdict), "the analysis is still in progress");
    assert.equal(afterCapture.strip.kind, "banner", "the visible banner owns its strip, so Cancel is clickable");
    assert.deepEqual(afterCapture.centre, { kind: "shield" }, "the page itself is still blocked");
    assert.equal(afterCapture.banner.hostCount, 1, "one banner host for the whole healthy flow");

    // Well past the recovery deadline: a capture that reported back must never
    // have its analysis cut short.
    await page.waitForTimeout(CAPTURE_RECOVERY_TIMEOUT_MS + 2_000);
    const stillRunning = await page.evaluate(() => ({
      banner: window.__ypBannerState(),
      shieldUp: window.__ypShield() !== null,
      cancels: window.__ypCancelsSent(),
    }));
    assert.ok(
      PROGRESS_VERDICTS.has(stillRunning.banner.verdict),
      "a healthy capture disarms the deadline, so the analysis is still running"
    );
    assert.equal(stillRunning.shieldUp, true);
    assert.equal(stillRunning.cancels, 0);

    const cancelled = await page.evaluate(() => {
      const clicked = window.__ypClickBannerControl(".yp-btn-cancel");
      return {
        clicked,
        banner: window.__ypBannerState(),
        shieldUp: window.__ypShield() !== null,
        centre: window.__ypHitPageCentre(),
        blocked: window.__ypSubmissionBlocked(),
        cancels: window.__ypCancelsSent(),
      };
    });
    assert.equal(cancelled.clicked, true);
    assert.equal(cancelled.banner, null, "Cancel leaves no banner behind");
    assert.equal(cancelled.shieldUp, false, "Cancel takes the shield down");
    assert.equal(cancelled.centre.kind, "page", "the page is clickable again");
    assert.equal(cancelled.blocked, false, "the credential blocker is released");
    assert.equal(cancelled.cancels, 1, "the background is told exactly once");

    await page.close();
    console.log("  healthy capture: banner hidden for the screenshot alone, Cancel releases the page");
  }

  // ---------------------------------------------------------------------------
  // 2. The reported lock: prepare_capture arrives, capture_complete never does.
  // ---------------------------------------------------------------------------
  {
    const { page, jobId } = await openAnalysedLoginPage(context);
    await page.evaluate((id) => window.__ypSend({ type: "prepare_capture", jobId: id }), jobId);

    const sealed = await page.evaluate(() => {
      const password = document.getElementById("pass").getBoundingClientRect();
      return {
        banner: window.__ypBannerState(),
        centre: window.__ypHitPageCentre(),
        password: window.__ypHitAt(Math.floor(password.left + 20), Math.floor(password.top + 10)),
        strip: window.__ypHitBannerStrip(),
      };
    });
    assert.equal(sealed.banner.visibility, "hidden", "this is the window the lock happened in");
    assert.deepEqual(sealed.centre, { kind: "shield" }, "the shield owns page hit testing");
    assert.equal(sealed.password.kind, "shield", "not even the password field can be reached");
    assert.notEqual(sealed.strip.kind, "banner", "and the banner cannot be clicked either");

    const startedAt = Date.now();
    await page.waitForFunction(() => window.__ypShield() === null, null, { timeout: RECOVERY_WAIT_MS });
    const recoveredAfterMs = Date.now() - startedAt;
    assert.ok(
      recoveredAfterMs < 60_000,
      `recovery must be bounded well below the job deadlines, took ${recoveredAfterMs}ms`
    );

    const recovered = await page.evaluate(() => ({
      banner: window.__ypBannerState(),
      centre: window.__ypHitPageCentre(),
      strip: window.__ypHitBannerStrip(),
      blocked: window.__ypSubmissionBlocked(),
      cancels: window.__ypCancelsSent(),
    }));
    assert.equal(recovered.centre.kind, "page", "the page must be usable again without a reload");
    assert.equal(recovered.banner.verdict, "analysis_failed", "recovery says what happened");
    assert.equal(recovered.banner.visibility, "visible", "the recovery banner has to be visible");
    assert.ok(recovered.banner.controls.includes("yp-btn yp-btn-retry"), "recovery is actionable");
    assert.equal(recovered.strip.kind, "banner", "and its Retry is really clickable");
    assert.equal(recovered.blocked, false, "the credential blocker is released with the shield");
    assert.equal(recovered.cancels, 1, "the abandoned job is cancelled in the background too");

    await page.close();
    console.log(`  stalled capture: page recovered after ${recoveredAfterMs}ms with a visible retry banner`);
  }

  // ---------------------------------------------------------------------------
  // 3. The page removes the anonymous banner host from under a live shield.
  // ---------------------------------------------------------------------------
  {
    const { page, jobId } = await openAnalysedLoginPage(context);
    await page.evaluate((id) => window.__ypSend({ type: "prepare_capture", jobId: id }), jobId);
    await page.evaluate((id) => window.__ypSend({ type: "capture_complete", jobId: id }), jobId);
    await page.waitForFunction(() => window.__ypBannerState()?.visibility === "visible", null, { timeout: 15_000 });

    const removal = await page.evaluate(() => {
      const host = document.body.firstElementChild;
      const wasBannerHost = host === window.__ypBanner()?.host;
      // Exactly what a single-page app clearing its root does.
      host.remove();
      return { wasBannerHost, shieldSurvived: window.__ypShield() !== null };
    });
    assert.equal(removal.wasBannerHost, true, "the prepended anonymous host is body.firstElementChild");
    assert.equal(removal.shieldSurvived, true, "the separately appended shield outlives the banner");

    await page.waitForFunction(
      () => window.__ypShield() === null || window.__ypBannerState() !== null,
      null,
      { timeout: 15_000 }
    );

    const restored = await page.evaluate(() => ({
      banner: window.__ypBannerState(),
      shieldUp: window.__ypShield() !== null,
      centre: window.__ypHitPageCentre(),
      strip: window.__ypHitBannerStrip(),
    }));
    if (restored.shieldUp) {
      assert.notEqual(restored.banner, null, "a live shield must have a mounted banner");
      assert.equal(restored.banner.visibility, "visible", "and a visible one");
      assert.ok(restored.banner.controls.includes("yp-btn yp-btn-cancel"), "with a way out on it");
      assert.equal(restored.strip.kind, "banner", "that the user can actually click");
      assert.ok(restored.banner.hostCount > 1, "the banner was genuinely remounted");
    } else {
      assert.equal(restored.centre.kind, "page", "an unrecoverable banner must release the page");
    }

    // Whichever branch it took, the analysis must still be endable and the page
    // must come back.
    const ended = await page.evaluate(() => {
      window.__ypClickBannerControl(".yp-btn-cancel");
      return {
        shieldUp: window.__ypShield() !== null,
        centre: window.__ypHitPageCentre(),
        blocked: window.__ypSubmissionBlocked(),
        cancels: window.__ypCancelsSent(),
      };
    });
    assert.equal(ended.shieldUp, false, "the remounted control ends the analysis");
    assert.equal(ended.centre.kind, "page");
    assert.equal(ended.blocked, false);
    assert.equal(ended.cancels, 1, "the background is told exactly once");

    await page.close();
    console.log("  detached banner host: controls remounted under the live shield and still ended the analysis");
  }

  // ---------------------------------------------------------------------------
  // 4. A provisional trusted verdict may keep analysing, but Safe. is not a
  //    progress surface and therefore cannot retain the pointer shield.
  // ---------------------------------------------------------------------------
  {
    const { page, jobId } = await openAnalysedLoginPage(context);

    await page.evaluate((id) => window.__ypSend({
      type: "show_banner",
      jobId: id,
      verdict: "trusted",
      data: {},
      provisional: true,
    }), jobId);
    await page.evaluate((id) => window.__ypSend({ type: "capture_complete", jobId: id }), jobId);
    await page.waitForFunction(() => window.__ypBannerState()?.verdict === "trusted", null, { timeout: 15_000 });

    const trusted = await page.evaluate(() => ({
      banner: window.__ypBannerState(),
      shieldUp: window.__ypShield() !== null,
      centre: window.__ypHitPageCentre(),
      blocked: window.__ypSubmissionBlocked(),
      cancels: window.__ypCancelsSent(),
    }));
    assert.equal(trusted.banner.verdict, "trusted");
    assert.equal(trusted.banner.text.includes("Safe."), true);
    assert.equal(trusted.shieldUp, false, "the provisional trusted verdict releases the pointer shield");
    assert.equal(trusted.centre.kind, "page", "the mailbox remains interactive during trusted drift analysis");
    assert.equal(trusted.blocked, false);
    assert.equal(trusted.cancels, 0, "the background drift job continues; only its shield is removed");

    await page.close();
    console.log("  provisional trusted verdict: Safe. releases the shield while drift analysis continues");
  }

  // ---------------------------------------------------------------------------
  // 5. A host can remain connected but become unreachable below hidden page
  //    content. Connectivity alone must not satisfy the shield invariant.
  // ---------------------------------------------------------------------------
  {
    const { page, jobId } = await openAnalysedLoginPage(context);
    await page.evaluate((id) => window.__ypSend({ type: "capture_complete", jobId: id }), jobId);
    await page.waitForFunction(() => window.__ypBannerState()?.visibility === "visible", null, { timeout: 15_000 });

    const moved = await page.evaluate(() => {
      const banner = window.__ypBanner();
      const parking = document.createElement("div");
      parking.style.display = "none";
      document.body.append(parking);
      parking.append(banner.host);
      return {
        connected: banner.host.isConnected,
        directBodyChild: banner.host.parentElement === document.body,
        shieldSurvived: window.__ypShield() !== null,
      };
    });
    assert.equal(moved.connected, true, "the reproduced host deliberately remains connected");
    assert.equal(moved.directBodyChild, false);
    assert.equal(moved.shieldSurvived, true);

    await page.waitForFunction(
      () => window.__ypShield() === null || window.__ypBannerState()?.hostCount > 1,
      null,
      { timeout: 15_000 }
    );
    const restored = await page.evaluate(() => ({
      banner: window.__ypBannerState(),
      directBodyChild: window.__ypBanner()?.host.parentElement === document.body,
      shieldUp: window.__ypShield() !== null,
      strip: window.__ypHitBannerStrip(),
    }));
    assert.equal(restored.shieldUp, true, "a recoverable reparenting keeps the analysis running");
    assert.equal(restored.directBodyChild, true, "the replacement host returns to its controlled mount point");
    assert.ok(restored.banner.controls.includes("yp-btn yp-btn-cancel"));
    assert.equal(restored.strip.kind, "banner", "the remounted Cancel is reachable by browser hit testing");

    const ended = await page.evaluate(() => {
      window.__ypClickBannerControl(".yp-btn-cancel");
      return { shieldUp: window.__ypShield() !== null, cancels: window.__ypCancelsSent() };
    });
    assert.equal(ended.shieldUp, false);
    assert.equal(ended.cancels, 1);

    await page.close();
    console.log("  connected hidden banner host: reachable controls remounted and Cancel ended the analysis");
  }

  await context.close();
  console.log("Shield recovery browser test passed");
} finally {
  await browser.close();
}
