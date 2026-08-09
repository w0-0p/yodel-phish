import type { NormalizedRect } from "../platform/PipelineServices";

export const MANUAL_REGION_MIN_PX = 8;

export interface ManualRegionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function manualRegionBox(
  rect: NormalizedRect,
  imageWidth: number,
  imageHeight: number
): ManualRegionBox {
  const ratios = [rect?.xRatio, rect?.yRatio, rect?.widthRatio, rect?.heightRatio];
  if (!ratios.every((ratio) => typeof ratio === "number" && Number.isFinite(ratio))) {
    throw new Error("Manual logo selection has non-numeric coordinates");
  }
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    throw new Error("Manual logo selection has no image to be placed on");
  }
  if (rect.widthRatio <= 0 || rect.heightRatio <= 0) {
    throw new Error("Manual logo selection has no usable area");
  }

  const rawLeft = rect.xRatio * imageWidth;
  const rawTop = rect.yRatio * imageHeight;
  const rawRight = (rect.xRatio + rect.widthRatio) * imageWidth;
  const rawBottom = (rect.yRatio + rect.heightRatio) * imageHeight;
  const x = Math.floor(clamp(rawLeft, 0, imageWidth));
  const y = Math.floor(clamp(rawTop, 0, imageHeight));
  const right = Math.ceil(clamp(rawRight, 0, imageWidth));
  const bottom = Math.ceil(clamp(rawBottom, 0, imageHeight));
  const width = right - x;
  const height = bottom - y;

  if (width < MANUAL_REGION_MIN_PX || height < MANUAL_REGION_MIN_PX) {
    throw new Error(
      `Manual logo selection is too small: ${width}x${height}px, minimum ${MANUAL_REGION_MIN_PX}px per side`
    );
  }
  return { x, y, width, height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
