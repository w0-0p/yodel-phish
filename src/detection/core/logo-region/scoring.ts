import type { PipelineConfig } from "../config";
import type { LogoRegion, LogoRegionComparison, LogoRegionFeature, LogoShapeMask, TrustedOcrLabel } from "../types";
import { logoRegionOcrScoreFromOcr, normalizedEditSimilarity } from "../ocr/matching";

export interface LogoRegionOcrPair {
  queryFeature: LogoRegionFeature;
  trustedFeature: LogoRegionFeature;
}

interface PairCandidate {
  queryFeature: LogoRegionFeature;
  trustedFeature: LogoRegionFeature;
  queryIndex: number;
  trustedIndex: number;
  queryRegion: LogoRegion;
  trustedRegion: LogoRegion;
  shapeScore: number;
  colorScore: number;
  textureScore: number;
  layoutScore: number;
  geometryScore: number;
  preOcrScore: number;
  colorConflict: boolean;
  matchMode: string;
  partialBox: string;
  ocrScore: number;
  ocrResult: { score: number; queryText: string; trustedText: string; matchedTokens: string };
  ocrRejected: boolean;
}

export function selectLogoRegionOcrPairs(input: {
  queryFeatures: LogoRegionFeature[];
  trustedFeatures: LogoRegionFeature[];
  config: PipelineConfig;
}): LogoRegionOcrPair[] {
  const candidates: Array<{ preOcrScore: number; queryFeature: LogoRegionFeature; trustedFeature: LogoRegionFeature }> = [];
  for (const queryFeature of input.queryFeatures) {
    if (queryFeature.visualRejectReason) continue;
    for (const trustedFeature of input.trustedFeatures) {
      if (trustedFeature.visualRejectReason) continue;
      const pairScores = logoRegionPairScores(queryFeature, trustedFeature, input.config);
      const queryRegion = queryFeature.region;
      const trustedRegion = trustedFeature.region;
      const layoutScore = logoRegionLayoutScore(queryRegion, trustedRegion);
      const preOcrScore = logoRegionPreOcrScore({
        shapeScore: pairScores.shapeScore,
        colorScore: pairScores.colorScore,
        geometryScore: pairScores.geometryScore,
        textureScore: pairScores.textureScore,
        trustedColorPixelRatio: regionNumber(trustedRegion, "colorPixelRatio"),
        trustedMeanSaturation: regionNumber(trustedRegion, "meanSaturation"),
        layoutScore
      });
      candidates.push({ preOcrScore, queryFeature, trustedFeature });
    }
  }
  candidates.sort((left, right) => right.preOcrScore - left.preOcrScore);
  return candidates.slice(0, input.config.logoRegionOcrTopPairs).map((candidate) => ({
    queryFeature: candidate.queryFeature,
    trustedFeature: candidate.trustedFeature
  }));
}

export function compareLogoRegionFeatures(input: {
  queryFeatures: LogoRegionFeature[];
  trustedFeatures: LogoRegionFeature[];
  labels: TrustedOcrLabel[];
  config: PipelineConfig;
  queryDinoEmbeddings?: number[][] | undefined;
  trustedDinoEmbedding?: number[] | undefined;
  embeddingSimilarity?: ((left: number[], right: number[]) => number) | undefined;
}): LogoRegionComparison {
  const { queryFeatures, trustedFeatures, labels, config } = input;
  const defaults = emptyLogoRegionComparison(queryFeatures.length, trustedFeatures.length, "no logo regions");
  if (queryFeatures.length === 0 || trustedFeatures.length === 0) return defaults;

  const candidates: PairCandidate[] = [];
  const rejectedCandidateKeys = new Set<string>();
  const rejectReasons = new Set<string>();
  let rejectedPairs = 0;

  for (const queryFeature of queryFeatures) {
    const qi = queryFeature.index;
    const queryReason = queryFeature.visualRejectReason ?? "";
    if (queryReason) {
      rejectedCandidateKeys.add(`query:${qi}`);
      rejectReasons.add(`query_logo_${qi}: ${queryReason}`);
      continue;
    }

    for (const trustedFeature of trustedFeatures) {
      const ti = trustedFeature.index;
      const trustedReason = trustedFeature.visualRejectReason ?? "";
      if (trustedReason) {
        rejectedCandidateKeys.add(`trusted:${ti}`);
        rejectReasons.add(`trusted_logo_${ti}: ${trustedReason}`);
        continue;
      }

      const pairScores = logoRegionPairScores(queryFeature, trustedFeature, config);
      const queryRegion = queryFeature.region;
      const trustedRegion = trustedFeature.region;
      const layoutScore = logoRegionLayoutScore(queryRegion, trustedRegion);
      const preOcrScore = logoRegionPreOcrScore({
        shapeScore: pairScores.shapeScore,
        colorScore: pairScores.colorScore,
        geometryScore: pairScores.geometryScore,
        textureScore: pairScores.textureScore,
        trustedColorPixelRatio: regionNumber(trustedRegion, "colorPixelRatio"),
        trustedMeanSaturation: regionNumber(trustedRegion, "meanSaturation"),
        layoutScore
      });

      candidates.push({
        queryFeature,
        trustedFeature,
        queryIndex: qi,
        trustedIndex: ti,
        queryRegion,
        trustedRegion,
        shapeScore: pairScores.shapeScore,
        colorScore: pairScores.colorScore,
        textureScore: pairScores.textureScore,
        layoutScore,
        geometryScore: pairScores.geometryScore,
        preOcrScore,
        colorConflict: logoRegionHasColorConflict(queryRegion, trustedRegion, config),
        matchMode: pairScores.mode,
        partialBox: pairScores.partialBox,
        ocrScore: 0.0,
        ocrResult: { score: 0.0, queryText: "", trustedText: "", matchedTokens: "" },
        ocrRejected: false
      });
    }
  }

  candidates.sort((left, right) => right.preOcrScore - left.preOcrScore);

  for (const candidate of candidates.slice(0, config.logoRegionOcrTopPairs)) {
    const ocrResult = logoRegionOcrScoreFromOcr({
      queryOcr: candidate.queryFeature.ocr,
      trustedOcr: candidate.trustedFeature.ocr,
      labels,
      config
    });
    candidate.ocrResult = ocrResult;
    candidate.ocrScore = ocrResult.score;
  }

  const scoredPairs: Array<{ score: number; capReason: string; candidate: PairCandidate }> = [];
  for (const candidate of candidates) {
    if (candidate.ocrRejected) continue;

    const qWidth = originalWidth(candidate.queryRegion) || 999;
    const qHeight = originalHeight(candidate.queryRegion) || 999;
    const tWidth = originalWidth(candidate.trustedRegion) || 999;
    const tHeight = originalHeight(candidate.trustedRegion) || 999;
    const qAspect = regionNumber(candidate.queryRegion, "aspect");
    const tAspect = regionNumber(candidate.trustedRegion, "aspect");
    const bothSmallSquare =
      0.7 <= qAspect && qAspect <= 1.4 &&
      0.7 <= tAspect && tAspect <= 1.4 &&
      qWidth < 150 && qHeight < 150 &&
      tWidth < 160 && tHeight < 160 &&
      candidate.ocrScore < config.logoRegionMinEvidenceOcrScore;

    const dinoPairSim = pairDinoV2Similarity(candidate.queryIndex, input);
    if (bothSmallSquare && dinoPairSim < config.dinoV2EvidenceGate) {
      rejectedPairs += 1;
      continue;
    }

    if (
      !logoRegionPairHasMatchEvidence({
        shapeScore: candidate.shapeScore,
        colorScore: candidate.colorScore,
        ocrScore: candidate.ocrScore,
        geometryScore: candidate.geometryScore,
        textureScore: candidate.textureScore,
        preOcrScore: candidate.preOcrScore,
        config
      }) && dinoPairSim < config.dinoV2EvidenceGate
    ) {
      rejectedPairs += 1;
      continue;
    }

    let logoScore = round(Math.max(candidate.preOcrScore, 0.9 * candidate.preOcrScore + 0.1 * candidate.ocrScore), 4);
    const capped = applyLogoRegionScoreCap({
      score: logoScore,
      shapeScore: candidate.shapeScore,
      colorScore: candidate.colorScore,
      colorConflict: candidate.colorConflict,
      ocrScore: candidate.ocrScore,
      config
    });
    logoScore = capped.score;
    let capReason = capped.reason;

    const qCenterY = regionNumber(candidate.queryRegion, "yRatio") + regionNumber(candidate.queryRegion, "heightRatio") / 2.0;
    const tCenterY = regionNumber(candidate.trustedRegion, "yRatio") + regionNumber(candidate.trustedRegion, "heightRatio") / 2.0;
    const worstCenterY = Math.max(qCenterY, tCenterY);
    if (worstCenterY > config.logoRegionBottomZoneYStart) {
      const excess = (worstCenterY - config.logoRegionBottomZoneYStart) / (1.0 - config.logoRegionBottomZoneYStart);
      const bottomCap = round(1.0 - excess * (1.0 - config.logoRegionBottomZoneMinScore), 4);
      if (logoScore > bottomCap) {
        logoScore = bottomCap;
        capReason = (`bottom-zone cap ${bottomCap.toFixed(2)}` + (capReason ? `; ${capReason}` : "")).trim();
      }
    }

    const contradictionResult = applyOcrContradictionCap({
      ocrScore: candidate.ocrScore,
      queryOcrText: candidate.ocrResult.queryText,
      trustedOcrText: candidate.ocrResult.trustedText,
      config
    });
    if (contradictionResult !== undefined && logoScore > contradictionResult.cap) {
      logoScore = contradictionResult.cap;
      capReason = capReason ? `${capReason}; ${contradictionResult.reason}` : contradictionResult.reason;
    }

    scoredPairs.push({ score: logoScore, capReason, candidate });
  }

  scoredPairs.sort((left, right) => right.score - left.score);
  if (scoredPairs.length === 0) {
    const reason = rejectedPairs > 0 || rejectedCandidateKeys.size > 0
      ? rejectionReason("no logo region pair passed filters", rejectedCandidateKeys, rejectedPairs, rejectReasons)
      : "compared logo regions";
    return { ...defaults, reason };
  }

  const winner = scoredPairs[0];
  if (winner === undefined) return defaults;
  const candidate = winner.candidate;
  const reasonBits: string[] = [];
  if (candidate.matchMode === "partial_trusted_component") reasonBits.push("partial trusted-component match");
  if (winner.capReason) reasonBits.push(winner.capReason);
  let reason = reasonBits.length > 0 ? `compared logo regions; ${reasonBits.join("; ")}` : "compared logo regions";
  if (rejectedCandidateKeys.size > 0 || rejectedPairs > 0) {
    reason = rejectionReason(reason, rejectedCandidateKeys, rejectedPairs, rejectReasons);
  }

  return {
    logoRegionScore: winner.score,
    logoRegionAssignedScore: 0.0,
    preOcrScore: candidate.preOcrScore,
    shapeScore: candidate.shapeScore,
    colorScore: candidate.colorScore,
    textureScore: candidate.textureScore,
    layoutScore: candidate.layoutScore,
    ocrScore: round(candidate.ocrScore, 4),
    geometryScore: candidate.geometryScore,
    scoreWasCapped: Boolean(winner.capReason),
    colorConflict: candidate.colorConflict,
    colorHistogramSimilarity: colorHistogramBhattacharyya(candidate.queryRegion.colorHist, candidate.trustedRegion.colorHist),
    queryDominantHueBin: candidate.queryRegion.dominantHueBin ?? "",
    queryDominantHueFraction: candidate.queryRegion.dominantHueFraction ?? 0.0,
    trustedDominantHueBin: candidate.trustedRegion.dominantHueBin ?? "",
    trustedDominantHueFraction: candidate.trustedRegion.dominantHueFraction ?? 0.0,
    rejectedPairsWithoutEvidence: rejectedPairs,
    pair: `query_logo_${candidate.queryIndex}->trusted_logo_${candidate.trustedIndex}`,
    queryBox: formatLogoRegion(candidate.queryRegion),
    trustedBox: formatLogoRegion(candidate.trustedRegion),
    partialBox: candidate.partialBox,
    queryCount: queryFeatures.length,
    trustedCount: trustedFeatures.length,
    queryOcrText: candidate.ocrResult.queryText,
    trustedOcrText: candidate.ocrResult.trustedText,
    ocrMatchedTokens: candidate.ocrResult.matchedTokens,
    ...(candidate.queryFeature.ocr?.diagnostics !== undefined
      ? { queryOcrDiagnostics: candidate.queryFeature.ocr.diagnostics }
      : {}),
    ...(candidate.trustedFeature.ocr?.diagnostics !== undefined
      ? { trustedOcrDiagnostics: candidate.trustedFeature.ocr.diagnostics }
      : {}),
    reason
  };
}

export function emptyLogoRegionComparison(queryCount = 0, trustedCount = 0, reason = "not compared"): LogoRegionComparison {
  return {
    logoRegionScore: 0.0,
    logoRegionAssignedScore: 0.0,
    preOcrScore: 0.0,
    shapeScore: 0.0,
    colorScore: 0.0,
    textureScore: 0.0,
    layoutScore: 0.0,
    ocrScore: 0.0,
    geometryScore: 0.0,
    scoreWasCapped: false,
    colorConflict: false,
    colorHistogramSimilarity: 0.0,
    queryDominantHueBin: "",
    queryDominantHueFraction: 0.0,
    trustedDominantHueBin: "",
    trustedDominantHueFraction: 0.0,
    rejectedPairsWithoutEvidence: 0,
    pair: "",
    queryBox: "",
    trustedBox: "",
    partialBox: "",
    queryCount,
    trustedCount,
    queryOcrText: "",
    trustedOcrText: "",
    ocrMatchedTokens: "",
    reason
  };
}

export function logoRegionPairScores(queryFeature: LogoRegionFeature, trustedFeature: LogoRegionFeature, config: PipelineConfig): {
  shapeScore: number;
  colorScore: number;
  textureScore: number;
  geometryScore: number;
  mode: string;
  partialBox: string;
} {
  const shapeScore = logoRegionShapeScoreFromFeatures(queryFeature, trustedFeature);
  const fullColorScore = logoRegionColorScore(queryFeature.region, trustedFeature.region);
  const fullTextureScore = logoRegionTextureScore(queryFeature.region, trustedFeature.region);
  const geometryScore = logoRegionGeometryScore(queryFeature.region, trustedFeature.region);
  // Mirror Python's trim-and-re-score: take the best of full vs content-trimmed descriptors.
  // trimmedRegion is populated by buildFeatures() when the platform service trims whitespace/padding.
  const trimmedColorScore = queryFeature.trimmedRegion !== undefined && trustedFeature.trimmedRegion !== undefined
    ? logoRegionColorScore(queryFeature.trimmedRegion, trustedFeature.trimmedRegion)
    : 0.0;
  const trimmedTextureScore = queryFeature.trimmedRegion !== undefined && trustedFeature.trimmedRegion !== undefined
    ? logoRegionTextureScore(queryFeature.trimmedRegion, trustedFeature.trimmedRegion)
    : 0.0;
  const colorScore = Math.max(fullColorScore, trimmedColorScore);
  const textureScore = Math.max(fullTextureScore, trimmedTextureScore);
  let best = {
    shapeScore,
    colorScore,
    textureScore,
    geometryScore,
    mode: "full",
    partialBox: "",
    partialPreScore: logoRegionPreOcrScore({
      shapeScore,
      colorScore,
      geometryScore,
      textureScore,
      trustedColorPixelRatio: regionNumber(trustedFeature.region, "colorPixelRatio"),
      trustedMeanSaturation: regionNumber(trustedFeature.region, "meanSaturation")
    })
  };

  if (shapeScore < config.logoRegionComponentSearchMinShapeScore) {
    return best;
  }

  for (const component of trustedFeature.components ?? []) {
    const componentShape = logoRegionShapeScoreFromFeatures(queryFeature, component);
    const queryRgnForComponent = queryFeature.trimmedRegion ?? queryFeature.region;
    const componentColor = logoRegionColorScore(queryRgnForComponent, component.region);
    const componentTexture = logoRegionTextureScore(queryRgnForComponent, component.region);
    const aspectGeometry = ratioSimilarity(regionNumber(queryFeature.region, "aspect"), regionNumber(component.region, "aspect"));
    const componentGeometry = Math.min(Math.max(geometryScore, aspectGeometry), config.logoRegionComponentGeometryCap);
    const componentPreScore = logoRegionPreOcrScore({
      shapeScore: componentShape,
      colorScore: componentColor,
      geometryScore: componentGeometry,
      textureScore: componentTexture,
      trustedColorPixelRatio: regionNumber(trustedFeature.region, "colorPixelRatio"),
      trustedMeanSaturation: regionNumber(trustedFeature.region, "meanSaturation")
    });
    const componentSizeSimilarity = ratioSimilarity(
      Math.max(regionNumber(queryFeature.region, "width") * regionNumber(queryFeature.region, "height"), 1),
      Math.max(regionNumber(component.region, "width") * regionNumber(component.region, "height"), 1)
    );
    const compatibleSize = componentSizeSimilarity >= config.logoRegionComponentPixelSizeSimilarity;
    const colorSupport = componentColor >= config.logoRegionComponentMinColorScore;
    const shapeGain = componentShape >= Math.max(shapeScore + 0.08, config.logoRegionMinEvidenceShapeScore + 0.15) &&
      componentColor >= config.logoRegionMinEvidenceColorScore;
    if (compatibleSize && (colorSupport || shapeGain) && componentPreScore > best.partialPreScore) {
      best = {
        shapeScore: Math.max(shapeScore, componentShape),
        colorScore: Math.max(colorScore, componentColor),
        textureScore: Math.max(textureScore, componentTexture),
        geometryScore: Math.max(geometryScore, componentGeometry),
        mode: "partial_trusted_component",
        partialBox: formatLogoRegion(component.region),
        partialPreScore: componentPreScore
      };
    }
  }

  return best;
}

export function logoRegionColorScore(queryRegion: LogoRegion, trustedRegion: LogoRegion): number {
  const hueScore = hueBinSimilarity(queryRegion.dominantHueBin ?? "", trustedRegion.dominantHueBin ?? "");
  const gridScore = quantizedGridSimilarity(queryRegion.colorGrid4x4 ?? "", trustedRegion.colorGrid4x4 ?? "");
  const histScore = colorHistogramBhattacharyya(queryRegion.colorHist, trustedRegion.colorHist);
  const colorRatioScore = ratioSimilarity(regionNumber(queryRegion, "colorPixelRatio"), regionNumber(trustedRegion, "colorPixelRatio"));
  const saturationScore = linearSimilarity(regionNumber(queryRegion, "meanSaturation"), regionNumber(trustedRegion, "meanSaturation"), 120.0);
  return round(0.15 * hueScore + 0.15 * gridScore + 0.45 * histScore + 0.15 * colorRatioScore + 0.10 * saturationScore, 4);
}

export function logoRegionTextureScore(queryRegion: LogoRegion, trustedRegion: LogoRegion): number {
  const edgeGridScore = quantizedGridSimilarity(queryRegion.edgeGrid4x4 ?? "", trustedRegion.edgeGrid4x4 ?? "");
  const edgeDirScore = edgeDirectionGridSimilarity(queryRegion.edgeDirGrid ?? "", trustedRegion.edgeDirGrid ?? "");
  const edgeDensityScore = ratioSimilarity(regionNumber(queryRegion, "edgeDensity"), regionNumber(trustedRegion, "edgeDensity"));
  const foregroundScore = ratioSimilarity(regionNumber(queryRegion, "foregroundRatio"), regionNumber(trustedRegion, "foregroundRatio"));
  return round(0.15 * edgeGridScore + 0.45 * edgeDirScore + 0.25 * edgeDensityScore + 0.15 * foregroundScore, 4);
}

export function logoRegionGeometryScore(queryRegion: LogoRegion, trustedRegion: LogoRegion): number {
  const qAspect = Math.max(regionNumber(queryRegion, "aspect"), 1e-6);
  const tAspect = Math.max(regionNumber(trustedRegion, "aspect"), 1e-6);
  return round(Math.max(0.0, Math.min(Math.exp(-Math.abs(Math.log(qAspect / tAspect))), 1.0)), 4);
}

export function logoRegionLayoutScore(queryRegion: LogoRegion, trustedRegion: LogoRegion): number {
  const qCy = regionNumber(queryRegion, "yRatio") + regionNumber(queryRegion, "heightRatio") / 2.0;
  const tCy = regionNumber(trustedRegion, "yRatio") + regionNumber(trustedRegion, "heightRatio") / 2.0;
  const qCx = regionNumber(queryRegion, "xRatio") + regionNumber(queryRegion, "widthRatio") / 2.0;
  const tCx = regionNumber(trustedRegion, "xRatio") + regionNumber(trustedRegion, "widthRatio") / 2.0;
  const ySim = linearSimilarity(qCy, tCy, 0.20);
  const xSim = linearSimilarity(qCx, tCx, 0.25);
  const sizeSim = ratioSimilarity(regionNumber(queryRegion, "areaRatio"), regionNumber(trustedRegion, "areaRatio"));
  return round(0.50 * ySim + 0.30 * xSim + 0.20 * sizeSim, 4);
}

export function logoRegionPreOcrScore(input: {
  shapeScore: number;
  colorScore: number;
  geometryScore: number;
  textureScore: number;
  trustedColorPixelRatio?: number;
  trustedMeanSaturation?: number;
  layoutScore?: number;
}): number {
  const distinctiveness = Math.min(((input.trustedColorPixelRatio ?? 0.0) * (input.trustedMeanSaturation ?? 0.0)) / 4000.0, 1.0);
  const colorWeight = 0.25 + 0.10 * distinctiveness;
  const shapeWeight = 0.35 - 0.10 * distinctiveness;
  return round(Math.min(
    shapeWeight * input.shapeScore +
    colorWeight * input.colorScore +
    0.20 * input.geometryScore +
    0.20 * input.textureScore +
    0.10 * (input.layoutScore ?? 0.0),
    1.0
  ), 4);
}

export function logoRegionShapeScoreFromFeatures(queryFeature: LogoRegionFeature, trustedFeature: LogoRegionFeature): number {
  const qMask = queryFeature.shapeMask;
  const tMask = trustedFeature.shapeMask;
  if (qMask === undefined || tMask === undefined) return 0.0;
  const dice = maskDiceScore(qMask, tMask);
  const convexitySim = logoRegionConvexitySimilarity(qMask, tMask);
  return round(0.75 * dice + 0.25 * convexitySim, 4);
}

export function maskDiceScore(a: LogoShapeMask, b: LogoShapeMask): number {
  if (a.width !== b.width || a.height !== b.height) return 0.0;
  let aCount = 0;
  let bCount = 0;
  let intersection = 0;
  const length = Math.min(a.data.length, b.data.length);
  for (let index = 0; index < length; index += 1) {
    const av = (a.data[index] ?? 0) > 0;
    const bv = (b.data[index] ?? 0) > 0;
    if (av) aCount += 1;
    if (bv) bCount += 1;
    if (av && bv) intersection += 1;
  }
  const denom = aCount + bCount;
  return denom === 0 ? 0.0 : (2.0 * intersection) / denom;
}

export function maskConvexity(mask: LogoShapeMask): number {
  const points: Array<[number, number]> = [];
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if ((mask.data[y * mask.width + x] ?? 0) > 0) points.push([x, y]);
    }
  }
  if (points.length < 6) return 1.0;
  const hullArea = convexHullArea(points);
  if (hullArea < 1.0) return 1.0;
  return round(Math.min(points.length / hullArea, 1.0), 4);
}

function convexHullArea(points: Array<[number, number]>): number {
  const n = points.length;
  if (n < 3) return 0.0;

  const pts = points.slice();

  // pivot = lowest y (top of image), leftmost on tie
  let pivotIdx = 0;
  for (let i = 1; i < n; i += 1) {
    const [px, py] = pts[pivotIdx]!;
    const [x, y] = pts[i]!;
    if (y < py || (y === py && x < px)) pivotIdx = i;
  }
  const tmp = pts[0]!;
  pts[0] = pts[pivotIdx]!;
  pts[pivotIdx] = tmp;
  const [ox, oy] = pts[0]!;

  // sort pts[1..] by polar angle from pivot; ties broken by distance (nearer first)
  const tail = pts.slice(1).sort((a, b) => {
    const cross = (a[0] - ox) * (b[1] - oy) - (a[1] - oy) * (b[0] - ox);
    if (cross !== 0) return cross > 0 ? -1 : 1;
    const da = (a[0] - ox) ** 2 + (a[1] - oy) ** 2;
    const db = (b[0] - ox) ** 2 + (b[1] - oy) ** 2;
    return da - db;
  });
  const sorted: Array<[number, number]> = [pts[0]!, ...tail];

  // Graham scan: pop non-left turns and collinear points
  const hull: Array<[number, number]> = [sorted[0]!, sorted[1]!];
  for (let i = 2; i < sorted.length; i += 1) {
    const p = sorted[i]!;
    while (hull.length >= 2) {
      const a = hull[hull.length - 2]!;
      const b = hull[hull.length - 1]!;
      if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) <= 0) hull.pop();
      else break;
    }
    hull.push(p);
  }
  if (hull.length < 3) return 0.0;

  // shoelace formula
  let area = 0.0;
  for (let i = 0; i < hull.length; i += 1) {
    const [x1, y1] = hull[i]!;
    const [x2, y2] = hull[(i + 1) % hull.length]!;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2.0;
}

export function logoRegionConvexitySimilarity(queryMask: LogoShapeMask, trustedMask: LogoShapeMask): number {
  return round(Math.max(0.0, 1.0 - Math.abs(maskConvexity(queryMask) - maskConvexity(trustedMask))), 4);
}

export function ratioSimilarity(aInput: number, bInput: number, floor = 1e-6): number {
  const a = Math.max(Number(aInput), floor);
  const b = Math.max(Number(bInput), floor);
  return Math.max(0.0, Math.min(Math.exp(-Math.abs(Math.log(a / b))), 1.0));
}

export function linearSimilarity(a: number, b: number, scale: number): number {
  if (scale <= 0) return 0.0;
  return round(Math.max(0.0, 1.0 - Math.min(Math.abs(a - b) / scale, 1.0)), 4);
}

export function quantizedGridSimilarity(left: string, right: string): number {
  const leftCells = splitQuantizedGrid(left);
  const rightCells = splitQuantizedGrid(right);
  if (leftCells.length === 0 || leftCells.length !== rightCells.length) return 0.0;
  let matches = 0;
  for (let index = 0; index < leftCells.length; index += 1) {
    if (leftCells[index] === rightCells[index]) matches += 1;
  }
  return round(matches / leftCells.length, 4);
}

export function edgeDirectionGridSimilarity(left: string, right: string): number {
  const leftCells = splitQuantizedGrid(left);
  const rightCells = splitQuantizedGrid(right);
  if (leftCells.length === 0 || leftCells.length !== rightCells.length) return 0.0;
  let totalDiff = 0;
  for (let index = 0; index < leftCells.length; index += 1) {
    totalDiff += Math.abs(Number.parseInt(leftCells[index] ?? "0", 10) - Number.parseInt(rightCells[index] ?? "0", 10));
  }
  const maxDiff = 9 * leftCells.length;
  return round(1.0 - totalDiff / Math.max(maxDiff, 1), 4);
}

export function hueBinCircularDistance(left: string, right: string): number | undefined {
  const leftBin = Number.parseInt(left, 10);
  const rightBin = Number.parseInt(right, 10);
  if (!Number.isFinite(leftBin) || !Number.isFinite(rightBin)) return undefined;
  const distance = Math.abs(leftBin - rightBin);
  return Math.min(distance, 15 - distance);
}

export function hueBinSimilarity(left: string, right: string): number {
  const circular = hueBinCircularDistance(left, right);
  if (circular === undefined) return 0.0;
  return round(Math.max(0.0, 1.0 - circular / 7.0), 4);
}

export function colorHistogramBhattacharyya(left?: number[], right?: number[]): number {
  if (left === undefined || right === undefined || left.length !== right.length) return 0.0;
  let sum = 0.0;
  for (let index = 0; index < left.length; index += 1) {
    sum += Math.sqrt(Math.max(left[index] ?? 0.0, 0.0) * Math.max(right[index] ?? 0.0, 0.0));
  }
  return round(sum, 4);
}

export function logoRegionHasColorConflict(queryRegion: LogoRegion, trustedRegion: LogoRegion, config: PipelineConfig): boolean {
  const queryColorRatio = regionNumber(queryRegion, "colorPixelRatio");
  const trustedColorRatio = regionNumber(trustedRegion, "colorPixelRatio");
  if (queryColorRatio < config.logoRegionColorfulPixelRatio || trustedColorRatio < config.logoRegionColorfulPixelRatio) return false;
  // Bypass: when both logos have no confidently dominant hue (i.e. genuinely multicoloured) and
  // their full colour histograms match well, a divergent dominant bin is a rendering artefact
  // rather than a brand colour conflict. The dominantHueFraction fallback of 1.0 keeps legacy
  // entries (which lack the field) on the conservative path.
  const histSim = colorHistogramBhattacharyya(queryRegion.colorHist, trustedRegion.colorHist);
  const maxDomFrac = config.logoRegionColorConflictMaxDominantFraction;
  const queryAmbiguous = (queryRegion.dominantHueFraction ?? 1.0) < maxDomFrac;
  const trustedAmbiguous = (trustedRegion.dominantHueFraction ?? 1.0) < maxDomFrac;
  if (histSim >= config.logoRegionColorConflictHistogramBypassScore && queryAmbiguous && trustedAmbiguous) {
    return false;
  }
  const hueDistance = hueBinCircularDistance(queryRegion.dominantHueBin ?? "", trustedRegion.dominantHueBin ?? "");
  return hueDistance !== undefined && hueDistance >= config.logoRegionHueConflictDistance;
}

export function applyLogoRegionScoreCap(input: {
  score: number;
  shapeScore: number;
  colorScore: number;
  colorConflict: boolean;
  ocrScore: number;
  config: PipelineConfig;
}): { score: number; reason: string } {
  let cap: number | undefined;
  if (input.shapeScore >= input.config.logoRegionMinEvidenceShapeScore && input.colorScore < input.config.logoRegionBrandColorSupportScore) {
    cap = input.config.logoRegionShapeOnlyHardCap;
  }
  if (cap !== undefined && input.ocrScore >= input.config.logoRegionMinEvidenceOcrScore) {
    cap = undefined;
  }
  let reason = cap !== undefined ? `shape-support cap ${cap.toFixed(2)}` : "";
  if (input.colorConflict && (cap === undefined || input.config.logoRegionColorConflictCap < cap)) {
    cap = input.config.logoRegionColorConflictCap;
    reason = `color-conflict cap ${cap.toFixed(2)}`;
  }
  // OCR evidence lifts the colour-conflict cap just as it lifts the shape-only cap above.
  if (cap !== undefined && input.ocrScore >= input.config.logoRegionMinEvidenceOcrScore) {
    cap = undefined;
    reason = "";
  }
  if (cap === undefined || input.score <= cap) return { score: input.score, reason: "" };
  return { score: round(cap, 4), reason };
}

export function logoRegionPairHasMatchEvidence(input: {
  shapeScore: number;
  colorScore: number;
  ocrScore: number;
  geometryScore: number;
  textureScore: number;
  preOcrScore: number;
  config: PipelineConfig;
}): boolean {
  const contextSupport = input.geometryScore >= input.config.logoRegionMinEvidenceGeometryScore ||
    input.textureScore >= input.config.logoRegionMinEvidenceTextureScore;
  const visualEvidence = input.shapeScore >= input.config.logoRegionMinEvidenceShapeScore &&
    input.colorScore >= input.config.logoRegionMinEvidenceColorScore &&
    contextSupport;
  return visualEvidence ||
    input.preOcrScore >= input.config.logoRegionMinCompositeEvidenceScore ||
    input.ocrScore >= input.config.logoRegionMinEvidenceOcrScore;
}

export function formatLogoRegion(region: LogoRegion | undefined): string {
  if (region === undefined) return "";
  const x = originalX(region);
  const y = originalY(region);
  const width = originalWidth(region);
  const height = originalHeight(region);
  return `${x},${y},${width},${height}:${region.score ?? 0.0}:${region.source ?? ""}`;
}

function pairDinoV2Similarity(queryIndex: number, input: {
  queryDinoEmbeddings?: number[][] | undefined;
  trustedDinoEmbedding?: number[] | undefined;
  embeddingSimilarity?: ((left: number[], right: number[]) => number) | undefined;
}): number {
  if (input.queryDinoEmbeddings === undefined || input.trustedDinoEmbedding === undefined || input.embeddingSimilarity === undefined) return 0.0;
  const queryEmbedding = input.queryDinoEmbeddings[queryIndex - 1];
  if (queryEmbedding === undefined) return 0.0;
  return input.embeddingSimilarity(queryEmbedding, input.trustedDinoEmbedding);
}

function rejectionReason(prefix: string, rejectedCandidateKeys: Set<string>, rejectedPairs: number, rejectReasons: Set<string>): string {
  const details: string[] = [];
  if (rejectedCandidateKeys.size > 0) details.push(`rejected_candidates=${rejectedCandidateKeys.size}`);
  if (rejectedPairs > 0) details.push(`rejected_pairs_without_evidence=${rejectedPairs}`);
  if (rejectReasons.size > 0) details.push([...rejectReasons].sort().slice(0, 4).join("; "));
  return `${prefix}; ${details.join("; ")}`;
}

function splitQuantizedGrid(value: string): string[] {
  if (!value) return [];
  return String(value).split("|").filter((part) => part !== "");
}

function regionNumber(region: LogoRegion, key: keyof LogoRegion, defaultValue = 0.0): number {
  const value = region[key];
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

function originalX(region: LogoRegion): number {
  return region.xOriginal ?? region.x;
}

function originalY(region: LogoRegion): number {
  return region.yOriginal ?? region.y;
}

function originalWidth(region: LogoRegion): number {
  return region.widthOriginal ?? region.width;
}

function originalHeight(region: LogoRegion): number {
  return region.heightOriginal ?? region.height;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ocrContradictionTokens(text: string, minLen: number): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= minLen);
}

function applyOcrContradictionCap(input: {
  ocrScore: number;
  queryOcrText: string;
  trustedOcrText: string;
  config: PipelineConfig;
}): { cap: number; reason: string } | undefined {
  if (input.ocrScore > 0) return undefined;
  const queryTokens = ocrContradictionTokens(input.queryOcrText, input.config.logoRegionOcrContradictionMinTokenLen);
  const trustedTokens = ocrContradictionTokens(input.trustedOcrText, input.config.logoRegionOcrContradictionMinTokenLen);
  if (queryTokens.length === 0 || trustedTokens.length === 0) return undefined;
  for (const qt of queryTokens) {
    for (const tt of trustedTokens) {
      if (normalizedEditSimilarity(qt, tt) >= input.config.ocrFuzzySimilarityThreshold) {
        return undefined;
      }
    }
  }
  const cap = input.config.logoRegionOcrContradictionCap;
  return { cap, reason: `ocr-contradiction cap ${cap.toFixed(2)}` };
}
