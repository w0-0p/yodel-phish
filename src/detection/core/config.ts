export interface ScoreBand {
  lowerInclusive: number;
  upperExclusive: number;
  assignedScore: number;
}

export interface PipelineConfig {
  phishingThreshold: number;
  suspiciousThreshold: number;
  ocrExactDomainScore: number;
  ocrStrongDomainScore: number;
  ocrPartialDomainScore: number;
  ocrVisibleExactMatchBonus: number;
  noOcrLogoSuspiciousGate: number;
  ocrScoreBands: ScoreBand[];
  logoRegionScoreBands: ScoreBand[];
  dinoV2LogoGate: number;
  dinoV2EvidenceGate: number;
  ocrSmallTextHeightRatio: number;
  ocrLargeTextHeightRatio: number;
  ocrFuzzyMinLength: number;
  ocrFuzzySimilarityThreshold: number;
  ocrGenericDomainTokens: string[];
  logoRegionMinEvidenceShapeScore: number;
  logoRegionMinEvidenceColorScore: number;
  logoRegionMinEvidenceOcrScore: number;
  logoRegionOcrTopPairs: number;
  logoRegionComponentMinColorScore: number;
  logoRegionComponentGeometryCap: number;
  logoRegionShapeOnlyHardCap: number;
  logoRegionBrandColorSupportScore: number;
  logoRegionComponentSearchMinShapeScore: number;
  logoRegionComponentPixelSizeSimilarity: number;
  logoRegionColorConflictCap: number;
  logoRegionColorfulPixelRatio: number;
  logoRegionHueConflictDistance: number;
  logoRegionMinEvidenceGeometryScore: number;
  logoRegionMinEvidenceTextureScore: number;
  logoRegionMinCompositeEvidenceScore: number;
  logoRegionBottomZoneYStart: number;
  logoRegionBottomZoneMinScore: number;
  logoRegionMaxRejectedPairsNoOcr: number;
  logoRegionOcrContradictionMinTokenLen: number;
  logoRegionOcrContradictionCap: number;
  logoRegionColorConflictColorScoreGate: number;
  logoRegionColorConflictHistogramBypassScore: number;
  logoRegionColorConflictMaxDominantFraction: number;
  yoloValidationMinDinoSim: number;
}

export const defaultPipelineConfig: PipelineConfig = {
  phishingThreshold: 2.5,
  suspiciousThreshold: 1.5,
  ocrExactDomainScore: 0.8,
  ocrStrongDomainScore: 0.6,
  ocrPartialDomainScore: 0.5,
  ocrVisibleExactMatchBonus: 0.5,
  noOcrLogoSuspiciousGate: 0.92,
  ocrScoreBands: [
    { lowerInclusive: 0.8, upperExclusive: 1.01, assignedScore: 1.5 },
    { lowerInclusive: 0.6, upperExclusive: 0.8, assignedScore: 1.0 }
  ],
  logoRegionScoreBands: [
    { lowerInclusive: 0.85, upperExclusive: 1.01, assignedScore: 1.5 },
    { lowerInclusive: 0.6, upperExclusive: 0.85, assignedScore: 1.0 },
    { lowerInclusive: 0.5, upperExclusive: 0.6, assignedScore: 0.5 }
  ],
  dinoV2LogoGate: 0.65,
  dinoV2EvidenceGate: 0.75,
  ocrSmallTextHeightRatio: 0.015,
  ocrLargeTextHeightRatio: 0.03,
  ocrFuzzyMinLength: 5,
  ocrFuzzySimilarityThreshold: 0.88,
  ocrGenericDomainTokens: [
    "account", "accounts", "online", "web", "login", "signin", "sign", "sign in",
    "secure", "security", "bank", "banking", "service", "services", "portal",
    "home", "access"
  ],
  logoRegionMinEvidenceShapeScore: 0.6,
  logoRegionMinEvidenceColorScore: 0.45,
  logoRegionMinEvidenceOcrScore: 0.65,
  logoRegionOcrTopPairs: 3,
  logoRegionComponentMinColorScore: 0.7,
  logoRegionComponentGeometryCap: 0.78,
  logoRegionShapeOnlyHardCap: 0.54,
  logoRegionBrandColorSupportScore: 0.7,
  logoRegionComponentSearchMinShapeScore: 0.45,
  logoRegionComponentPixelSizeSimilarity: 0.25,
  logoRegionColorConflictCap: 0.54,
  logoRegionColorfulPixelRatio: 0.05,
  logoRegionHueConflictDistance: 2,
  logoRegionMinEvidenceGeometryScore: 0.5,
  logoRegionMinEvidenceTextureScore: 0.55,
  logoRegionMinCompositeEvidenceScore: 0.54,
  logoRegionBottomZoneYStart: 0.72,
  logoRegionBottomZoneMinScore: 0.54,
  logoRegionMaxRejectedPairsNoOcr: 2,
  logoRegionOcrContradictionMinTokenLen: 4,
  logoRegionOcrContradictionCap: 0.54,
  logoRegionColorConflictColorScoreGate: 0.6,
  logoRegionColorConflictHistogramBypassScore: 0.85,
  logoRegionColorConflictMaxDominantFraction: 0.40,
  // Arbitration gate for a YOLO-only proposal set: when no YOLO crop matches a
  // trusted label's text, at least one crop must reach this DINOv2 similarity
  // against a trusted embedding, or CV proposals run additionally and merge.
  // Deliberately below dinoV2LogoGate: this asks "does anything here resemble a
  // trusted logo at all", not "is it a match".
  // YOLO-monopoly behavior).
  yoloValidationMinDinoSim: 0.5
};

