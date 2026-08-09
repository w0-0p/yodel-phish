import type { NormalizedRect } from "../platform/PipelineServices";
import type { YoloBox } from "./yoloLogoDetector";

// Issue #90: the add-to-trusted flow shows YOLO's proposals to the user for
// confirmation instead of silently keeping the best-scored one. Precision comes
// from the human, so the floor sits well below the detection cutoff (0.25): on
// wide screens the letterboxed content shrinks until a real logo scores under
// that cutoff while page furniture scores above it (measured on a 3440px
// viewport: real logo 0.18, language dropdown 0.26). At 0.1 those logos stay
// selectable; below that the output is noise even for a human to sift.
export const TRUSTED_ADD_CANDIDATE_CONF = 0.1;

// A page producing more proposals than this would bury the overlay in boxes;
// the user can still draw over anything that was cut.
export const TRUSTED_ADD_CANDIDATE_LIMIT = 8;

export interface TrustedAddCandidate extends NormalizedRect {
  score: number;
}

/** Maps detector boxes (original-image pixels) to the viewport-ratio
 *  rectangles the selector overlay places over the live page, best score
 *  first. The capture is the visible viewport, so image ratios and viewport
 *  ratios are the same coordinate space regardless of device pixel ratio. */
export function yoloBoxesToCandidates(
  boxes: YoloBox[],
  imageWidth: number,
  imageHeight: number,
  limit: number = TRUSTED_ADD_CANDIDATE_LIMIT
): TrustedAddCandidate[] {
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    return [];
  }
  return [...boxes]
    .filter((box) => box.w > 0 && box.h > 0)
    .sort((left, right) => right.conf - left.conf)
    .slice(0, limit)
    .map((box) => ({
      xRatio: round4(box.x / imageWidth),
      yRatio: round4(box.y / imageHeight),
      widthRatio: round4(box.w / imageWidth),
      heightRatio: round4(box.h / imageHeight),
      score: box.conf,
    }));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
