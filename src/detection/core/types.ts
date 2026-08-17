export type Verdict = "unknown" | "suspicious" | "phishing";

export interface ImageRef {
  id: string;
  source: "validation-file" | "browser-screenshot" | "trusted-entry";
  mimeType?: string;
  bytes?: ArrayBuffer;
  dataUrl?: string;
  width?: number;
  height?: number;
}

export type TrustedOcrLabelKind = "main_domain" | "ocr_label" | "synthetic";

export interface TrustedOcrLabel {
  label: string;
  kind: TrustedOcrLabelKind;
}

export interface TrustedEntry {
  id: string;
  variantId?: string;
  fqdn: string;
  etld1?: string;
  protocol?: string;
  /**
   * Trusted-group membership (issue #19): management metadata copied verbatim
   * from the stored trusted entry. It never participates in matching and must
   * never be populated from a visual result.
   */
  trustGroupId?: string;
  sourceImage?: ImageRef;
  ocrDomain: string;
  ocrLabels: string[];
  logoRegions?: LogoRegion[];
  logoFeatures?: LogoRegionFeature[];
  dinoV2Embedding?: number[];
}

export interface BoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrWord {
  text: string;
  token: string;
  region: string;
  third?: string;
  x: number;
  y: number;
  widthPx: number;
  heightPx: number;
  heightRatio: number;
  sizeBucket: "small" | "medium" | "large" | "unknown";
  confidence?: number;
  fullX?: number;
  fullY?: number;
  fullWidthPx?: number;
  fullHeightPx?: number;
}

export interface OcrExtraction {
  text: string;
  tokens: string[];
  words: OcrWord[];
  medianTextHeightPx: number;
  medianTextHeightRatio: number;
}

export interface LogoCropOcrDiagnostics {
  status: "text" | "empty" | "error";
  cropSize: string;
  ocrCanvasSize: string;
  psm: string;
  error: string;
}

export type LogoCropOcrResult = Pick<OcrExtraction, "text" | "tokens"> & {
  diagnostics?: LogoCropOcrDiagnostics;
};

export interface OcrTokenMatch {
  label: string;
  token: string;
  weight: number;
  textPositionRatio: number;
  ocrWords: OcrWord[];
}

export interface OcrMatchResult {
  normalizedScore: number;
  fuzzyScore: number;
  matchedTokens: string;
  matchedTokensWithSize: string;
  fuzzyMatchedTokens: string;
  fuzzyMatchedTokensWithSize: string;
  rejectedSmallBottomTokens: string;
  rejectedUiTokens: string;
  visibleExactMatch: boolean;
  exactMatches: OcrTokenMatch[];
  substringMatches: OcrTokenMatch[];
  fuzzyMatches: OcrTokenMatch[];
  matchedMinHeightPx: number;
  matchedMedianHeightPx: number;
  matchedMaxHeightPx: number;
  matchedMinHeightRatio: number;
  matchedMedianHeightRatio: number;
}

export interface LogoShapeMask {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface LogoRegion {
  rank: number;
  score: number;
  source: string;
  x: number;
  y: number;
  width: number;
  height: number;
  xOriginal?: number;
  yOriginal?: number;
  widthOriginal?: number;
  heightOriginal?: number;
  xRatio?: number;
  yRatio?: number;
  widthRatio?: number;
  heightRatio?: number;
  aspect?: number;
  areaRatio?: number;
  foregroundRatio?: number;
  colorPixelRatio?: number;
  meanSaturation?: number;
  edgeDensity?: number;
  dominantHueBin?: string;
  dominantHueFraction?: number;
  dhash64?: string;
  colorGrid4x4?: string;
  edgeGrid4x4?: string;
  edgeDirGrid?: string;
  colorHist?: number[];
}

export interface LogoRegionFeature {
  index: number;
  region: LogoRegion;
  trimmedRegion?: LogoRegion;
  shapeMask?: LogoShapeMask;
  visualRejectReason?: string;
  ocr?: LogoCropOcrResult;
  components?: LogoRegionFeature[];
}

export interface LogoRegionComparison {
  logoRegionScore: number;
  logoRegionAssignedScore: number;
  preOcrScore: number;
  shapeScore: number;
  colorScore: number;
  textureScore: number;
  layoutScore: number;
  ocrScore: number;
  geometryScore: number;
  scoreWasCapped: boolean;
  colorConflict: boolean;
  colorHistogramSimilarity?: number;
  queryDominantHueBin?: string;
  queryDominantHueFraction?: number;
  trustedDominantHueBin?: string;
  trustedDominantHueFraction?: number;
  rejectedPairsWithoutEvidence: number;
  pair: string;
  queryBox: string;
  trustedBox: string;
  partialBox: string;
  queryCount: number;
  trustedCount: number;
  queryOcrText: string;
  trustedOcrText: string;
  ocrMatchedTokens: string;
  queryOcrDiagnostics?: LogoCropOcrDiagnostics;
  trustedOcrDiagnostics?: LogoCropOcrDiagnostics;
  reason: string;
}

export interface PerTrustedResult {
  imgPath?: string;
  variantId?: string;
  fqdn: string;
  dinoV2LogoSimilarity: number;
  logo: LogoRegionComparison;
  ocr: OcrMatchResult;
  ocrVisibleExactMatchBonus: number;
  ocrAssignedScore: number;
  effectiveOcrScore: number;
  effectiveLogoScore: number;
  ocrMedianTextHeightPx?: number;
  ocrMedianTextHeightRatio?: number;
  globalScore: number;
  verdict: Verdict;
}

export interface PipelineWinner {
  queryImage: string;
  matchedFqdn: string;
  matchedReferenceId?: string;
  matchedVariantId?: string;
  dinoV2LogoSimilarity: number;
  logo: LogoRegionComparison;
  ocr: OcrMatchResult;
  ocrVisibleExactMatchBonus: number;
  ocrAssignedScore: number;
  effectiveOcrScore: number;
  effectiveLogoScore: number;
  globalScore: number;
  verdict: Verdict;
}

export interface PipelineTimings {
  queryProposeMs: number;
  queryBuildFeaturesMs: number;
  queryLogoLabelOcrMs: number;
  queryCvMergeMs: number;
  queryFullOcrMs: number;
  queryDinoEmbedMs: number;
  ocrMatchCacheMs: number;
  perTrustedAnalysisMs: number;
  sortMs: number;
  totalMs: number;
}

// How the unmasked YOLO proposal set earned (or lost) its right to stand alone:
//   no-regions   — neither YOLO nor CV proposed anything
//   cv-fallback  — YOLO found nothing; CV proposals are the set (legacy miss path)
//   brand-text   — a YOLO crop's OCR matched a trusted label
//   dino-sim     — a YOLO crop reached yoloValidationMinDinoSim against a
//                  trusted embedding (or the gate is disabled)
//   merged       — no YOLO crop validated; CV ran additionally and the sets merged
export type YoloValidationOutcome =
  | "no-regions"
  | "cv-fallback"
  | "brand-text"
  | "dino-sim"
  | "merged";

export interface QueryStats {
  regionCount: number;
  yoloRegionCount: number;
  cvRegionCount: number;
  fullOcrRan: boolean;
  yoloValidation: YoloValidationOutcome;
}

export interface PipelineResult {
  winner: PipelineWinner;
  perTrusted: PerTrustedResult[];
  timings: PipelineTimings;
  queryStats: QueryStats;
}
