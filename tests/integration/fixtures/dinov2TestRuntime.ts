import type { ImageRef, LogoRegion, LogoRegionFeature, LogoShapeMask } from "../../../src/detection/core/types";
import type { NormalizedRect, OcrMaskHint, ProposeRegionsOptions } from "../../../src/detection/platform/PipelineServices";
import { createBrowserStackServices } from "../../../src/detection/browser/browserStackServices";
import { DinoV2EmbeddingEngine, type DinoV2Config } from "../../../src/detection/browser/dinov2EmbeddingEngine";
import { YoloLogoDetector } from "../../../src/detection/browser/yoloLogoDetector";

interface SerializedLogoShapeMask extends Omit<LogoShapeMask, "data"> {
  data: number[];
}

interface SerializedLogoRegionFeature extends Omit<LogoRegionFeature, "shapeMask" | "components"> {
  shapeMask?: SerializedLogoShapeMask | undefined;
  components?: SerializedLogoRegionFeature[] | undefined;
}

const yoloModelUrl = (globalThis as any).__YODEL_YOLO_MODEL_URL__ as string | undefined;
const yoloConf = (globalThis as any).__YODEL_YOLO_CONF__ as number | undefined;
const yoloDetector = yoloModelUrl !== undefined
  ? new YoloLogoDetector(yoloModelUrl, yoloConf)
  : undefined;
const services = createBrowserStackServices(undefined, yoloDetector);

const dinoModelUrl = (globalThis as any).__YODEL_DINOV2_MODEL_URL__ as string | undefined;
const dinoConfig = (globalThis as any).__YODEL_DINOV2_CONFIG__ as DinoV2Config | undefined;
const dinoEngine = dinoModelUrl !== undefined && dinoConfig !== undefined
  ? new DinoV2EmbeddingEngine(dinoModelUrl, dinoConfig)
  : undefined;

(globalThis as any).__YODEL_VALIDATION_SERVICES__ = {
  extractOcr: async (image: ImageRef) => services.ocr.extract(image),
  extractLogoCropOcr: async (image: ImageRef, region: LogoRegion) => {
    if (services.ocr.extractLogoCrop === undefined) return { text: "", tokens: [] };
    return services.ocr.extractLogoCrop(image, region);
  },
  proposeRegions: async (image: ImageRef, ocrMask?: OcrMaskHint, options?: ProposeRegionsOptions) =>
    services.logoRegions.proposeRegions(image, ocrMask, options),
  describeManualRegion: async (image: ImageRef, rect: NormalizedRect) =>
    services.logoRegions.describeManualRegion(image, rect),
  buildFeatures: async (image: ImageRef, regions: LogoRegion[], ocrMask?: OcrMaskHint | undefined) => {
    const features = await services.logoRegions.buildFeatures(image, regions, ocrMask);
    return features.map(serializeFeature);
  },
  embedLogoCrops: async (image: ImageRef, regions: LogoRegion[]): Promise<number[][]> => {
    if (dinoEngine === undefined) return [];
    return dinoEngine.embedLogoCrops(image, regions);
  }
};

function serializeFeature(feature: LogoRegionFeature): SerializedLogoRegionFeature {
  const serialized: SerializedLogoRegionFeature = {
    index: feature.index,
    region: feature.region
  };
  if (feature.trimmedRegion !== undefined) serialized.trimmedRegion = feature.trimmedRegion;
  if (feature.visualRejectReason !== undefined) serialized.visualRejectReason = feature.visualRejectReason;
  if (feature.ocr !== undefined) serialized.ocr = feature.ocr;
  if (feature.shapeMask !== undefined) serialized.shapeMask = serializeMask(feature.shapeMask);
  if (feature.components !== undefined) serialized.components = feature.components.map(serializeFeature);
  return serialized;
}

function serializeMask(mask: LogoShapeMask): SerializedLogoShapeMask {
  return {
    width: mask.width,
    height: mask.height,
    data: Array.from(mask.data)
  };
}
