import type { BoxLike } from "../types";

export type CoverBox = [number, number, number, number];

export function intervalOverlap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

export function intervalGap(startA: number, endA: number, startB: number, endB: number): number {
  if (endA < startB) return startB - endA;
  if (endB < startA) return startA - endB;
  return 0;
}

export function coverOverlapArea(box: BoxLike, coveredBox: CoverBox): number {
  const ax1 = Math.trunc(box.x);
  const ay1 = Math.trunc(box.y);
  const ax2 = ax1 + Math.trunc(box.width);
  const ay2 = ay1 + Math.trunc(box.height);
  const [bx1, by1, bx2, by2] = coveredBox;
  return Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1)) *
    Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
}

export function boxCenterInsideCover(box: BoxLike, coveredBox: CoverBox): boolean {
  const cx = box.x + box.width / 2.0;
  const cy = box.y + box.height / 2.0;
  const [x1, y1, x2, y2] = coveredBox;
  return x1 <= cx && cx <= x2 && y1 <= cy && cy <= y2;
}

export function coverUnionOverlapArea(box: BoxLike, coveredBoxes: CoverBox[]): number {
  const left = Math.trunc(box.x);
  const top = Math.trunc(box.y);
  const right = left + Math.trunc(box.width);
  const bottom = top + Math.trunc(box.height);

  const intersections: CoverBox[] = [];
  for (const [coverLeft, coverTop, coverRight, coverBottom] of coveredBoxes) {
    const x1 = Math.max(left, coverLeft);
    const y1 = Math.max(top, coverTop);
    const x2 = Math.min(right, coverRight);
    const y2 = Math.min(bottom, coverBottom);
    if (
      Number.isFinite(x1) && Number.isFinite(y1) &&
      Number.isFinite(x2) && Number.isFinite(y2) &&
      x2 > x1 && y2 > y1
    ) {
      intersections.push([x1, y1, x2, y2]);
    }
  }
  if (intersections.length === 0) return 0;

  const xEdges = Array.from(new Set(intersections.flatMap(([x1, , x2]) => [x1, x2])))
    .sort((a, b) => a - b);
  let area = 0;

  for (let index = 0; index < xEdges.length - 1; index += 1) {
    const x1 = xEdges[index]!;
    const x2 = xEdges[index + 1]!;
    const intervals = intersections
      .filter(([rectLeft, , rectRight]) => rectLeft < x2 && rectRight > x1)
      .map(([, y1, , y2]) => [y1, y2] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    if (intervals.length === 0) continue;

    let coveredHeight = 0;
    let [mergedStart, mergedEnd] = intervals[0]!;
    for (let intervalIndex = 1; intervalIndex < intervals.length; intervalIndex += 1) {
      const [start, end] = intervals[intervalIndex]!;
      if (start <= mergedEnd) {
        mergedEnd = Math.max(mergedEnd, end);
      } else {
        coveredHeight += mergedEnd - mergedStart;
        mergedStart = start;
        mergedEnd = end;
      }
    }
    coveredHeight += mergedEnd - mergedStart;
    area += (x2 - x1) * coveredHeight;
  }

  return area;
}

export function boxIsCovered(box: BoxLike, coveredBoxes: CoverBox[]): boolean {
  if (coveredBoxes.length === 0) return false;
  const area = Math.max(1, Math.trunc(box.width) * Math.trunc(box.height));
  const overlap = coverUnionOverlapArea(box, coveredBoxes);
  return overlap / area >= 0.35 || coveredBoxes.some((coveredBox) => boxCenterInsideCover(box, coveredBox));
}

export function iou(a: BoxLike, b: BoxLike): number {
  const ax1 = a.x;
  const ay1 = a.y;
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx1 = b.x;
  const by1 = b.y;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const inter = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1)) *
    Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0.0;
}
