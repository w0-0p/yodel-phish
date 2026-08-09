import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MANUAL_REGION_MIN_PX,
  manualRegionBox,
} from "../../src/detection/browser/manualRegion.ts";
import {
  TRUSTED_ADD_CANDIDATE_CONF,
  TRUSTED_ADD_CANDIDATE_LIMIT,
  yoloBoxesToCandidates,
} from "../../src/detection/browser/trustedAddCandidates.ts";

const offscreenSource = readFileSync(new URL("./offscreen.js", import.meta.url), "utf8");
const stackSource = readFileSync(
  new URL("../../src/detection/browser/browserStackServices.ts", import.meta.url),
  "utf8"
);

test("a confirmed manual selection is described by the region engine, not hand-built", () => {
  assert.match(
    offscreenSource,
    /services\.logoRegions\.describeManualRegion\(screenshot, normalizedRect\)/,
    "the manual reference path must go through the descriptor engine"
  );
  // The old path multiplied the ratios itself and shipped a bare box with an
  // unused confidence field, leaving every scoring descriptor undefined.
  assert.doesNotMatch(offscreenSource, /normalizedRect\.(?:xRatio|yRatio|widthRatio|heightRatio)/);
  assert.doesNotMatch(offscreenSource, /source: "manual"/);
  assert.doesNotMatch(offscreenSource, /confidence:/);
});

test("manual and YOLO regions both bypass automatic candidate rejection", () => {
  assert.match(
    stackSource,
    /visualRejectReason: isConfirmedRegionSource\(region\.source\)\s*\n\s*\?\s*""/,
    "buildFeatures must not run the UI-control heuristics over confirmed regions"
  );
  const bypass = /function isConfirmedRegionSource\(source: string\): boolean \{\s*return ([^;]+);/.exec(stackSource);
  assert.notEqual(bypass, null, "isConfirmedRegionSource must exist");
  assert.match(bypass[1], /YOLO_REGION_SOURCE/);
  assert.match(bypass[1], /MANUAL_REGION_SOURCE/);
});

test("manual regions keep the full descriptor path", () => {
  // describeCandidate is what fills rank/score/ratios/aspect/area and the
  // colour, edge and histogram descriptors; the broad-band filter that can
  // return undefined is skipped so a confirmed selection always gets them.
  assert.match(stackSource, /async describeManualRegion\(image: ImageRef, rect: NormalizedRect\): Promise<LogoRegion>/);
  assert.match(stackSource, /describeCandidate\(cv, small, toDetectionBox\([\s\S]*?skipBroadBandFilter: true/);
  assert.match(stackSource, /options\?\.skipBroadBandFilter !== true && areaRatio > 0\.055/);
});

test("manual rectangle conversion preserves only the part inside the image", () => {
  assert.deepEqual(
    manualRegionBox(
      { xRatio: -0.2, yRatio: -0.1, widthRatio: 0.3, heightRatio: 0.3 },
      1000,
      500
    ),
    { x: 0, y: 0, width: 100, height: 100 }
  );
  assert.deepEqual(
    manualRegionBox(
      { xRatio: 0.9, yRatio: 0.8, widthRatio: 0.3, heightRatio: 0.4 },
      1000,
      500
    ),
    { x: 900, y: 400, width: 100, height: 100 }
  );
});

test("manual rectangle conversion rejects malformed or unusable selections", () => {
  const valid = { xRatio: 0.1, yRatio: 0.1, widthRatio: 0.2, heightRatio: 0.2 };
  assert.throws(() => manualRegionBox({ ...valid, xRatio: Number.NaN }, 1000, 500), /non-numeric/);
  assert.throws(() => manualRegionBox({ ...valid, widthRatio: 0 }, 1000, 500), /no usable area/);
  assert.throws(() => manualRegionBox({ ...valid, widthRatio: -0.1 }, 1000, 500), /no usable area/);
  assert.throws(() => manualRegionBox(valid, 0, 500), /no image/);
  assert.throws(
    () => manualRegionBox(
      { xRatio: 0, yRatio: 0, widthRatio: (MANUAL_REGION_MIN_PX - 1) / 1000, heightRatio: 0.2 },
      1000,
      500
    ),
    /too small/
  );
  assert.throws(
    () => manualRegionBox({ xRatio: -0.2, yRatio: 0, widthRatio: 0.1, heightRatio: 0.2 }, 1000, 500),
    /too small/
  );
});

// =============================================================================
// Issue #90: the add-to-trusted selector offers YOLO's proposals for human
// confirmation — gathered with a lower floor than detection, never from the
// CV fallback, and mapped to viewport ratios the overlay can place.
// =============================================================================

test("the offscreen runtime serves candidate proposals through the region engine", () => {
  assert.match(
    offscreenSource,
    /if \(message\.type === "propose_trusted_add_candidates"\) \{\s*return services\.logoRegions\.proposeTrustedAddCandidates\(message\.screenshot\);/,
    "the proposal path must go through the shared services object"
  );
});

test("candidate proposals use the human-review floor and never the CV proposer", () => {
  const method = /async proposeTrustedAddCandidates\(image: ImageRef\)[\s\S]*?\n  \}/.exec(stackSource);
  assert.notEqual(method, null, "proposeTrustedAddCandidates must exist on the region engine");
  assert.match(method[0], /if \(this\.yoloDetector === undefined\) return \[\];/);
  assert.match(method[0], /detect\(decoded, TRUSTED_ADD_CANDIDATE_CONF\)/);
  assert.doesNotMatch(method[0], /proposeLogoBoxes|applyOcrMask|proposeRegions/, "no CV fallback: with nothing to offer the selector free-draws");

  const detectorSource = readFileSync(
    new URL("../../src/detection/browser/yoloLogoDetector.ts", import.meta.url),
    "utf8"
  );
  assert.match(detectorSource, /async detect\(imageData: ImageData, minConfidence: number = this\.conf\)/);
  assert.match(detectorSource, /if \(score < minConfidence\) continue;/);
});

test("detector boxes become viewport-ratio candidates, best score first and capped", () => {
  const boxes = [
    { x: 50, y: 40, w: 200, h: 80, conf: 0.31 },
    { x: 700, y: 16, w: 100, h: 40, conf: 0.62 },
    { x: 10, y: 10, w: 0, h: 40, conf: 0.9 }, // degenerate: no area
  ];

  assert.deepEqual(yoloBoxesToCandidates(boxes, 1000, 800), [
    { xRatio: 0.7, yRatio: 0.02, widthRatio: 0.1, heightRatio: 0.05, score: 0.62 },
    { xRatio: 0.05, yRatio: 0.05, widthRatio: 0.2, heightRatio: 0.1, score: 0.31 },
  ]);
});

test("candidate mapping caps the list and refuses images without dimensions", () => {
  const many = Array.from({ length: TRUSTED_ADD_CANDIDATE_LIMIT + 3 }, (_unused, index) => (
    { x: index * 10, y: 0, w: 10, h: 10, conf: (index + 1) / 100 }
  ));

  const capped = yoloBoxesToCandidates(many, 1000, 800);
  assert.equal(capped.length, TRUSTED_ADD_CANDIDATE_LIMIT);
  assert.equal(capped[0].score, (many.length) / 100, "the best-scored boxes survive the cap");

  assert.deepEqual(yoloBoxesToCandidates(many, 0, 800), []);
  assert.deepEqual(yoloBoxesToCandidates(many, 1000, Number.NaN), []);
});

test("the human-review floor sits below the detection cutoff", () => {
  // Wide screens shrink the letterboxed content until a real logo scores
  // under the pipeline's cutoff; the floor exists so it still reaches the
  // user as a selectable candidate.
  assert.equal(TRUSTED_ADD_CANDIDATE_CONF < 0.25, true);
  assert.equal(TRUSTED_ADD_CANDIDATE_CONF > 0, true);
});
