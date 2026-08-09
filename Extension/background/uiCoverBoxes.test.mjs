import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  convertUiCoverBoxesToImageSpace,
  MAX_UI_COVER_BOXES,
  normalizeUiCoverCapture,
  readPngDimensions,
  readPngDimensionsFromDataUrl,
  uiCoverCapturesMatch,
} from "./uiCoverBoxes.mjs";

// A capture as the injected collector produces it: CSS pixels relative to the
// visible viewport, never document space.
function capture(boxes, viewportWidth = 1280, viewportHeight = 800, scrollX = 0, scrollY = 0) {
  return { boxes, viewportWidth, viewportHeight, scrollX, scrollY };
}

const geometryModule = (() => {
  const source = readFileSync(
    new URL("../../src/detection/core/geometry/boxes.ts", import.meta.url),
    "utf8"
  );
  const outputText = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));
})();

// Both helpers are deliberately one-sided with respect to boxIsCovered() in
// src/detection/core/geometry/boxes.ts, which treats a word as
// covered at >= 35% overlap or when its centre falls inside a cover box: full
// containment always satisfies that rule, zero overlap never can.
function contains(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

function overlapArea(a, b) {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return width * height;
}

// A PNG header carrying real dimensions, followed by filler standing in for the
// chunks a decoder would read past them.
function pngDataUrl(width, height) {
  const header = Buffer.alloc(29);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header.writeUInt8(8, 24);
  header.writeUInt8(6, 25);
  return "data:image/png;base64," + Buffer.concat([header, Buffer.alloc(64, 7)]).toString("base64");
}

test("document scroll offsets never reach the converted boxes", () => {
  // A field 300 CSS pixels below the fold occupies the same viewport rectangle
  // whether or not the page has been scrolled, and lands there in the capture.
  const viewportBox = [400, 300, 880, 344];
  assert.deepEqual(convertUiCoverBoxesToImageSpace(capture([viewportBox]), 1280, 800), [[400, 300, 880, 344]]);
  assert.deepEqual(convertUiCoverBoxesToImageSpace(capture([viewportBox]), 2560, 1600), [[800, 600, 1760, 688]]);

  // What the collector used to send for that same field on a page scrolled
  // 500px down, once window.scrollY had been added: below the captured
  // viewport, so it is discarded instead of being laid over unrelated content.
  const documentSpaceBox = [400, 300 + 500, 880, 344 + 500];
  assert.deepEqual(convertUiCoverBoxesToImageSpace(capture([documentSpaceBox]), 1280, 800), []);
});

test("boxes are scaled by the bitmap size at a non-1 device pixel ratio", () => {
  const converted = convertUiCoverBoxesToImageSpace(capture([[10, 20, 110, 60]]), 2560, 1600);
  assert.deepEqual(converted, [[20, 40, 220, 120]]);
});

test("boxes are scaled by the bitmap size under browser zoom", () => {
  // 125% zoom shrinks the CSS viewport of an unchanged 1280x800 capture.
  const converted = convertUiCoverBoxesToImageSpace(capture([[80, 40, 480, 80]], 1024, 640), 1280, 800);
  assert.deepEqual(converted, [[100, 50, 600, 100]]);
});

test("horizontal and vertical scales are derived independently", () => {
  const converted = convertUiCoverBoxesToImageSpace(capture([[0, 0, 640, 400]]), 1920, 800);
  assert.deepEqual(converted, [[0, 0, 960, 400]]);
});

test("partially off-screen elements are clipped to the viewport", () => {
  const converted = convertUiCoverBoxesToImageSpace(
    capture([
      [-40, 700, 200, 900],   // hangs off the left edge and below the fold
      [1200, -30, 1400, 50],  // hangs off the right edge and above the fold
    ]),
    2560,
    1600
  );

  assert.deepEqual(converted, [
    [0, 1400, 400, 1600],
    [2400, 0, 2560, 100],
  ]);
});

test("elements scrolled fully out of view are dropped", () => {
  const converted = convertUiCoverBoxesToImageSpace(
    capture([
      [100, 820, 300, 880],   // entirely below the viewport
      [100, -90, 300, -10],   // entirely above the viewport
      [1300, 100, 1500, 160], // entirely right of the viewport
      [200, 400, 400, 460],   // still visible
    ]),
    1280,
    800
  );

  assert.deepEqual(converted, [[200, 400, 400, 460]]);
});

test("converted boxes stay inside the bitmap", () => {
  const [box] = convertUiCoverBoxesToImageSpace(capture([[0, 0, 1280, 800]]), 1333, 999);
  assert.deepEqual(box, [0, 0, 1333, 999]);
});

test("degenerate and malformed rectangles are rejected", () => {
  const converted = convertUiCoverBoxesToImageSpace(
    capture([
      [100, 100, 100, 160],           // zero width
      [100, 100, 300, 100],           // zero height
      [100, Number.NaN, 300, 160],    // unusable coordinate
      [100, 100, Infinity, 160],      // unusable coordinate
      [100, 100, 300],                // wrong arity
      "not-a-box",
      [200, 400, 400, 460],           // the only usable one
    ]),
    1280,
    800
  );

  assert.deepEqual(converted, [[200, 400, 400, 460]]);
});

test("an unusable viewport or bitmap yields no boxes rather than misplaced ones", () => {
  const box = [200, 400, 400, 460];
  assert.deepEqual(convertUiCoverBoxesToImageSpace(capture([box], 0, 800), 1280, 800), []);
  assert.deepEqual(convertUiCoverBoxesToImageSpace(capture([box], 1280, 0), 1280, 800), []);
  assert.deepEqual(convertUiCoverBoxesToImageSpace(capture([box]), 0, 800), []);
  assert.deepEqual(convertUiCoverBoxesToImageSpace(capture([box]), 1280, Number.NaN), []);
  assert.deepEqual(convertUiCoverBoxesToImageSpace(undefined, 1280, 800), []);
  assert.deepEqual(convertUiCoverBoxesToImageSpace({ boxes: "nope" }, 1280, 800), []);
});

test("normalization keeps the viewport it clipped against", () => {
  const normalized = normalizeUiCoverCapture(capture([[-40, 700, 200, 900]]));
  assert.deepEqual(normalized, {
    boxes: [[0, 700, 200, 800]],
    viewportWidth: 1280,
    viewportHeight: 800,
    scrollX: 0,
    scrollY: 0,
  });
  assert.deepEqual(normalizeUiCoverCapture(undefined), {
    boxes: [],
    viewportWidth: 0,
    viewportHeight: 0,
    scrollX: 0,
    scrollY: 0,
  });
});

test("normalization deduplicates and caps page-provided boxes", () => {
  const duplicate = [10, 20, 30, 40];
  assert.deepEqual(normalizeUiCoverCapture(capture([duplicate, duplicate])).boxes, [duplicate]);

  const manyBoxes = Array.from({ length: MAX_UI_COVER_BOXES + 50 }, (_, index) =>
    [index, 0, index + 1, 10]
  );
  assert.equal(normalizeUiCoverCapture(capture(manyBoxes)).boxes.length, MAX_UI_COVER_BOXES);
});

test("capture snapshots must remain stable around the screenshot", () => {
  const stable = capture([[10, 20, 30, 40]], 1280, 800, 0, 500);
  assert.equal(uiCoverCapturesMatch(stable, structuredClone(stable)), true);
  assert.equal(uiCoverCapturesMatch(stable, capture(stable.boxes, 1280, 800, 0, 501)), false);
  assert.equal(uiCoverCapturesMatch(stable, capture(stable.boxes, 1024, 800, 0, 500)), false);
  assert.equal(uiCoverCapturesMatch(stable, capture([[11, 20, 30, 40]], 1280, 800, 0, 500)), false);
  assert.equal(uiCoverCapturesMatch(undefined, undefined), false);
});

test("overlapping cover boxes contribute their union area only", async () => {
  const { boxIsCovered, coverUnionOverlapArea } = await geometryModule;
  const word = { x: 0, y: 0, width: 10, height: 10 };
  const duplicateStrips = [[0, 0, 2, 10], [0, 0, 2, 10]];
  const adjacentStrips = [[0, 0, 2, 10], [2, 0, 4, 10]];

  assert.equal(coverUnionOverlapArea(word, duplicateStrips), 20);
  assert.equal(boxIsCovered(word, duplicateStrips), false, "duplicate 20% masks must not become 40%");
  assert.equal(coverUnionOverlapArea(word, adjacentStrips), 40);
  assert.equal(boxIsCovered(word, adjacentStrips), true);
});

test("OCR words inside a UI element are covered while text outside it is not", () => {
  // Page scrolled 500px down, 1280x800 CSS viewport captured at dpr 2. The
  // login field sits at CSS (400,300)-(880,344) in viewport space.
  const uiBoxes = convertUiCoverBoxesToImageSpace(capture([[400, 300, 880, 344]]), 2560, 1600);
  assert.equal(uiBoxes.length, 1);
  const [uiBox] = uiBoxes;

  // Screenshot-pixel OCR word boxes, the space matching.ts compares against.
  const placeholderInsideField = [820, 610, 1000, 650];
  const headlineAboveField = [200, 100, 600, 160];

  assert.ok(contains(uiBox, placeholderInsideField));
  assert.equal(overlapArea(uiBox, headlineAboveField), 0);
  // Tall enough to pass the isSignificantUiBox() filter in matching.ts.
  assert.ok(uiBox[3] - uiBox[1] >= 25);
});

test("PNG dimensions are read from the capture data URL", () => {
  assert.deepEqual(readPngDimensionsFromDataUrl(pngDataUrl(1280, 800)), { width: 1280, height: 800 });
  assert.deepEqual(readPngDimensionsFromDataUrl(pngDataUrl(2560, 1600)), { width: 2560, height: 1600 });
  assert.deepEqual(readPngDimensionsFromDataUrl(pngDataUrl(3840, 2160)), { width: 3840, height: 2160 });

  // A real 1x1 PNG, encoded the way captureVisibleTab encodes its result.
  const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" +
    "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  assert.deepEqual(readPngDimensionsFromDataUrl(onePixelPng), { width: 1, height: 1 });
});

test("unreadable image payloads report no dimensions", () => {
  assert.equal(readPngDimensionsFromDataUrl(undefined), null);
  assert.equal(readPngDimensionsFromDataUrl(""), null);
  assert.equal(readPngDimensionsFromDataUrl("data:image/png,%89PNG"), null, "not base64 encoded");
  assert.equal(readPngDimensionsFromDataUrl("data:image/png;base64,"), null, "empty payload");
  assert.equal(readPngDimensionsFromDataUrl("data:image/png;base64,####"), null, "not decodable");
  assert.equal(
    readPngDimensionsFromDataUrl(pngDataUrl(1280, 800).slice(0, 34)),
    null,
    "truncated before the IHDR dimensions"
  );
  assert.equal(
    readPngDimensionsFromDataUrl("data:image/jpeg;base64," + Buffer.alloc(64, 0xff).toString("base64")),
    null,
    "another format falls through to bitmap decoding"
  );

  const zeroSized = Buffer.from(pngDataUrl(0, 0).split(",")[1], "base64");
  assert.equal(readPngDimensions(zeroSized), null);
  assert.equal(readPngDimensions(new Uint8Array(0)), null);
  assert.equal(readPngDimensions(undefined), null);
});

test("the collector reports viewport space and the worker converts before dispatch", () => {
  const collectorSource = readFileSync(
    new URL("../../src/detection/browser/screenshotSource.ts", import.meta.url),
    "utf8"
  );
  const workerSource = readFileSync(new URL("./service_worker.js", import.meta.url), "utf8");

  assert.match(collectorSource, /\[rect\.left, rect\.top, rect\.right, rect\.bottom\]/);
  assert.doesNotMatch(collectorSource, /Math\.round\(rect\./);
  assert.doesNotMatch(collectorSource, /offsetParent/);
  assert.match(collectorSource, /rect\.width <= 0 \|\| rect\.height <= 0/);
  assert.match(collectorSource, /viewportWidth: window\.innerWidth/);
  assert.match(collectorSource, /viewportHeight: window\.innerHeight/);
  assert.match(collectorSource, /scrollX: Number\.isFinite\(window\.scrollX\)/);

  assert.match(workerSource, /convertUiCoverBoxesToImageSpace\(uiCoverCapture, dimensions\.width, dimensions\.height\)/);
  assert.match(workerSource, /uiCoverCapturesMatch\(uiCoverCaptureBefore, uiCoverCaptureAfter\)/);

  const beforeIndex = workerSource.indexOf("const uiCoverCaptureBefore");
  const screenshotIndex = workerSource.indexOf("const screenshot =", beforeIndex);
  const afterIndex = workerSource.indexOf("const uiCoverCaptureAfter", screenshotIndex);
  assert.ok(beforeIndex >= 0 && beforeIndex < screenshotIndex && screenshotIndex < afterIndex);
});
