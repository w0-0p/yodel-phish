import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "../../Extension/node_modules/playwright/index.mjs";
import ts from "../../Extension/node_modules/typescript/lib/typescript.js";
import {
  convertUiCoverBoxesToImageSpace,
  readPngDimensions,
  uiCoverCapturesMatch,
} from "../../Extension/background/uiCoverBoxes.mjs";

const collectorSource = readFileSync(
  new URL("../../src/detection/browser/screenshotSource.ts", import.meta.url),
  "utf8"
);
const collectorModuleSource = ts.transpileModule(collectorSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const { collectUiCoverCaptureFromDocument } = await import(
  "data:text/javascript;base64," + Buffer.from(collectorModuleSource).toString("base64")
);

const configuredExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser = await chromium.launch({
  headless: true,
  ...(configuredExecutable ? { executablePath: configuredExecutable } : {}),
});

try {
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.setContent(`
    <style>
      html, body { margin: 0; }
      body { height: 2000px; }
      #field {
        position: absolute;
        left: 100px;
        top: 900px;
        width: 300px;
        height: 40px;
        box-sizing: border-box;
      }
      #fixed {
        position: fixed;
        left: 30px;
        top: 20px;
        width: 200px;
        height: 40px;
        box-sizing: border-box;
      }
    </style>
    <input id="field" />
    <button id="fixed">Fixed action</button>
  `);
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForFunction(() => window.scrollY === 700);

  assert.equal(await page.locator("#fixed").evaluate((element) => element.offsetParent), null);
  const before = await page.evaluate(collectUiCoverCaptureFromDocument);
  const screenshot = await page.screenshot({ type: "png" });
  const after = await page.evaluate(collectUiCoverCaptureFromDocument);

  assert.equal(uiCoverCapturesMatch(before, after), true);
  assert.deepEqual(
    { width: before.viewportWidth, height: before.viewportHeight, scrollY: before.scrollY },
    { width: 800, height: 600, scrollY: 700 }
  );
  assert.deepEqual(readPngDimensions(screenshot), { width: 1600, height: 1200 });
  assert.deepEqual(
    convertUiCoverBoxesToImageSpace(after, 1600, 1200),
    [[200, 400, 800, 480], [60, 40, 460, 120]]
  );

  await context.close();
  console.log("UI cover browser smoke test passed");
} finally {
  await browser.close();
}
