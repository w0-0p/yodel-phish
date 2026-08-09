import type { PipelineConfig, ScoreBand } from "./config";
import type { LogoRegionComparison, OcrMatchResult, Verdict } from "./types";

export function scoreFromBands(rawScore: number, bands: ScoreBand[]): number {
  for (const band of bands) {
    if (rawScore >= band.lowerInclusive && rawScore < band.upperExclusive) {
      return band.assignedScore;
    }
  }
  return 0.0;
}

export function computeVerdict(globalScore: number, config: PipelineConfig): Verdict {
  if (globalScore >= config.phishingThreshold) return "phishing";
  if (globalScore >= config.suspiciousThreshold) return "suspicious";
  return "unknown";
}

export function computeGlobalScore(input: {
  config: PipelineConfig;
  ocr: OcrMatchResult;
  logo: LogoRegionComparison;
  dinoV2LogoSimilarity: number;
}): {
  globalScore: number;
  logoAssignedScore: number;
  ocrAssignedScore: number;
  effectiveOcrScore: number;
  effectiveLogoScore: number;
  visibleExactMatchBonus: number;
} {
  const { config, ocr, logo, dinoV2LogoSimilarity } = input;
  // Logo crop OCR in a color-conflicting region is unreliable when the match is weak
  // (coincidental text like "swiss" matching "swisspass" on a wrong-color logo).
  // Strong OCR (≥ logoRegionMinEvidenceOcrScore) or well-matching colors
  // (colorScore ≥ colorConflictColorScoreGate) still count — the brand text is
  // genuinely present even if the YOLO crop has a hue mismatch.
  const logoOcrContribution =
    logo.colorConflict &&
    logo.colorScore < config.logoRegionColorConflictColorScoreGate &&
    logo.ocrScore < config.logoRegionMinEvidenceOcrScore
      ? 0.0
      : logo.ocrScore;
  const effectiveOcrScore = Math.max(ocr.normalizedScore, ocr.fuzzyScore, logoOcrContribution);
  const hasOcrEvidence = effectiveOcrScore > 0.0;
  const effectiveLogoScore =
    !hasOcrEvidence && dinoV2LogoSimilarity < config.dinoV2LogoGate
      ? 0.0
      : logo.logoRegionScore;

  const ocrAssignedScore = scoreFromBands(effectiveOcrScore, config.ocrScoreBands);
  const logoAssignedScore = scoreFromBands(effectiveLogoScore, config.logoRegionScoreBands);
  const visibleExactMatchBonus =
    ocr.normalizedScore >= config.ocrExactDomainScore && ocr.visibleExactMatch
      ? config.ocrVisibleExactMatchBonus
      : 0.0;

  let globalScore = round4(ocrAssignedScore + logoAssignedScore + visibleExactMatchBonus);

  if (
    !hasOcrEvidence &&
    (effectiveLogoScore <= config.noOcrLogoSuspiciousGate ||
      logo.rejectedPairsWithoutEvidence >= config.logoRegionMaxRejectedPairsNoOcr) &&
    globalScore >= config.suspiciousThreshold
  ) {
    globalScore = round4(config.suspiciousThreshold - 0.0001);
  }

  return {
    globalScore,
    logoAssignedScore,
    ocrAssignedScore,
    visibleExactMatchBonus,
    effectiveOcrScore,
    effectiveLogoScore
  };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
