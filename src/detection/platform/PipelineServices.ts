import type {
  ImageRef,
  LogoRegion,
  LogoRegionComparison,
  LogoRegionFeature,
  LogoCropOcrResult,
  OcrExtraction,
  OcrWord,
  TrustedOcrLabel,
  TrustedEntry
} from "../core/types";

export interface OcrMaskHint {
  words: OcrWord[];
  keepTokens: string[];
}

export interface ProposeRegionsOptions {
  /** Skip the YOLO detection step and go straight to the CV fallback.
   *  Set this when YOLO has already been run on the same image and found no boxes,
   *  so repeated calls with different OCR masks do not re-run the same inference. */
  skipYolo?: boolean;
}

export interface OcrEngine {
  extract(image: ImageRef): Promise<OcrExtraction>;
  extractLogoCrop?(image: ImageRef, region: LogoRegion): Promise<LogoCropOcrResult>;
}

/** A rectangle expressed as fractions of the image it was drawn on, as the logo
 *  selector reports a user's confirmed selection. */
export interface NormalizedRect {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
}

export interface LogoRegionEngine {
  proposeRegions(image: ImageRef, ocrMask?: OcrMaskHint, options?: ProposeRegionsOptions): Promise<LogoRegion[]>;
  buildFeatures(image: ImageRef, regions: LogoRegion[], ocrMask?: OcrMaskHint): Promise<LogoRegionFeature[]>;
  /** Builds the descriptor set for a user-confirmed rectangle, using the same
   *  logic that describes automatic candidates so the region scores against
   *  query regions on equal terms. Rejects (throws) a rectangle that cannot be
   *  clamped to a usable area of the image. */
  describeManualRegion(image: ImageRef, rect: NormalizedRect): Promise<LogoRegion>;
  /** Issue #90: YOLO proposals above the human-review floor, as viewport-ratio
   *  rectangles for the add-to-trusted selector, best score first. Empty when
   *  no detector is configured or it finds nothing — never a CV fallback. */
  proposeTrustedAddCandidates?(image: ImageRef): Promise<Array<NormalizedRect & { score: number }>>;
  compare?(input: {
    queryImage: ImageRef;
    trustedImage: ImageRef;
    queryRegions: LogoRegion[];
    trustedRegions: LogoRegion[];
    queryFeatures: LogoRegionFeature[];
    trustedFeatures: LogoRegionFeature[];
    labels: TrustedOcrLabel[];
  }): Promise<LogoRegionComparison>;
}

export interface LogoEmbeddingEngine {
  embedLogoCrops(image: ImageRef, regions: LogoRegion[]): Promise<number[][]>;
  similarity(queryEmbedding: number[], trustedEmbedding: number[]): number;
}

export interface PipelineServices {
  ocr: OcrEngine;
  logoRegions: LogoRegionEngine;
  logoEmbeddings?: LogoEmbeddingEngine;
}
