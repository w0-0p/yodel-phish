import type { ImageRef, LogoRegion } from "../core/types";
import type { LogoEmbeddingEngine } from "../platform/PipelineServices";

const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;
const DEFAULT_INPUT_NAME = "pixel_values";
const DEFAULT_OUTPUT_NAME = "image_features";
const DEFAULT_EMBEDDING_DIMENSION = 384;

export interface DinoV2Config {
  resizeSize: number;
  cropSize: number;
  mean: readonly [number, number, number];
  std: readonly [number, number, number];
  inputName: string;
  outputName: string;
  embeddingDimension: number;
}

export function validateDinoV2Config(config: DinoV2Config): DinoV2Config {
  if (typeof config !== "object" || config === null) {
    throw new Error("DINOv2 config must be an object");
  }
  if (config.resizeSize !== 256) {
    throw new Error(`DINOv2 config resizeSize must be 256, got ${String(config.resizeSize)}`);
  }
  if (config.cropSize !== 224) {
    throw new Error(`DINOv2 config cropSize must be 224, got ${String(config.cropSize)}`);
  }
  if (!hasExactValues(config.mean, IMAGENET_MEAN)) {
    throw new Error("DINOv2 config mean must be [0.485, 0.456, 0.406]");
  }
  if (!hasExactValues(config.std, IMAGENET_STD)) {
    throw new Error("DINOv2 config std must be [0.229, 0.224, 0.225]");
  }
  if (config.inputName !== DEFAULT_INPUT_NAME) {
    throw new Error(`DINOv2 config inputName must be "${DEFAULT_INPUT_NAME}", got ${String(config.inputName)}`);
  }
  if (config.outputName !== DEFAULT_OUTPUT_NAME) {
    throw new Error(`DINOv2 config outputName must be "${DEFAULT_OUTPUT_NAME}", got ${String(config.outputName)}`);
  }
  if (config.embeddingDimension !== DEFAULT_EMBEDDING_DIMENSION) {
    throw new Error(
      `DINOv2 config embeddingDimension must be ${DEFAULT_EMBEDDING_DIMENSION}, got ${String(config.embeddingDimension)}`
    );
  }

  return {
    resizeSize: config.resizeSize,
    cropSize: config.cropSize,
    mean: [...config.mean],
    std: [...config.std],
    inputName: config.inputName,
    outputName: config.outputName,
    embeddingDimension: config.embeddingDimension
  };
}

export class DinoV2EmbeddingEngine implements LogoEmbeddingEngine {
  private sessionPromise: Promise<any> | undefined;
  private readonly config: DinoV2Config;

  constructor(
    private readonly modelUrl: string,
    config: DinoV2Config
  ) {
    this.config = validateDinoV2Config(config);
  }

  // Returns one entry per region, in the same order as `regions`. A crop that
  // fails to embed becomes an empty array rather than being omitted, so index-based
  // lookups elsewhere in the pipeline (e.g. pairing a query region with its
  // embedding by position) can never shift onto the wrong region.
  async embedLogoCrops(image: ImageRef, regions: LogoRegion[]): Promise<number[][]> {
    if (regions.length === 0) return [];
    const imageData = await loadImageData(image);
    const session = await this.getSession();
    const ort = await getOrt();
    const { resizeSize, cropSize, mean, std, inputName, outputName, embeddingDimension } = this.config;
    const embeddings: number[][] = [];

    for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
      const region = regions[regionIndex];
      if (region === undefined) {
        embeddings.push([]);
        continue;
      }

      let tensor: any;
      try {
        const crop = cropRect(
          imageData,
          region.xOriginal ?? region.x,
          region.yOriginal ?? region.y,
          region.widthOriginal ?? region.width,
          region.heightOriginal ?? region.height
        );
        tensor = buildInputTensor(crop, resizeSize, cropSize, mean, std, ort);
      } catch (error) {
        console.warn(
          `[DINOv2] crop ${regionIndex + 1}/${regions.length} failed and was left empty: ${errorMessage(error)}`
        );
        embeddings.push([]);
        continue;
      }

      let outputs: Record<string, any>;
      try {
        outputs = await session.run({ [inputName]: tensor }) as Record<string, any>;
      } catch (error) {
        throw new Error(`DINOv2 inference failed for input "${inputName}": ${errorMessage(error)}`);
      }

      const output = outputs[outputName];
      if (output === undefined) {
        throw new Error(
          `DINOv2 output "${outputName}" is missing; received [${Object.keys(outputs).join(", ")}]`
        );
      }
      if (output.type !== "float32") {
        throw new Error(`DINOv2 output "${outputName}" must be float32, got ${String(output.type)}`);
      }
      const dims = Array.isArray(output.dims) ? output.dims : [];
      if (dims.length !== 2 || dims[0] !== 1 || dims[1] !== embeddingDimension) {
        throw new Error(
          `DINOv2 output "${outputName}" must have shape [1, ${embeddingDimension}], got [${dims.join(", ")}]`
        );
      }

      const features = output.data as ArrayLike<number> | undefined;
      if (features === undefined || features.length !== embeddingDimension) {
        throw new Error(
          `DINOv2 output "${outputName}" must contain ${embeddingDimension} values, got ${features?.length ?? "none"}`
        );
      }
      if (!isFinitePixelArray(features)) {
        throw new Error(`DINOv2 output "${outputName}" contains NaN or Infinity`);
      }
      embeddings.push(l2Normalize(Array.from(features)));
    }
    return embeddings;
  }

  similarity(queryEmbedding: number[], trustedEmbedding: number[]): number {
    if (
      queryEmbedding.length !== trustedEmbedding.length ||
      queryEmbedding.length !== this.config.embeddingDimension ||
      !isFinitePixelArray(queryEmbedding) ||
      !isFinitePixelArray(trustedEmbedding)
    ) {
      // An invalid or missing embedding pair carries no similarity evidence; the
      // pipeline already treats a lack of embedding evidence as "gate not passed",
      // so returning 0 here (rather than throwing) keeps that behavior consistent.
      return 0.0;
    }
    let dot = 0.0;
    for (let i = 0; i < queryEmbedding.length; i += 1) {
      dot += (queryEmbedding[i] ?? 0) * (trustedEmbedding[i] ?? 0);
    }
    return dot;
  }

  private async getSession(): Promise<any> {
    if (this.sessionPromise === undefined) {
      this.sessionPromise = this.initSession();
    }
    return this.sessionPromise;
  }

  private async initSession(): Promise<any> {
    const ort = await getOrt();
    ort.env.wasm.wasmPaths = new URL("/ort-wasm/", globalThis.location.href).href;
    ort.env.wasm.numThreads = 1;
    const response = await fetch(this.modelUrl);
    if (!response.ok) {
      throw new Error(`DINOv2 model fetch failed: ${response.status} ${this.modelUrl}`);
    }
    const modelBuffer = await response.arrayBuffer();
    try {
      return await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "disabled"
      });
    } catch (error) {
      throw new Error(`DINOv2 session creation failed: ${errorMessage(error)}`);
    }
  }
}

let ortModule: any = undefined;

async function getOrt(): Promise<any> {
  if (ortModule !== undefined) return ortModule;
  const mod = await import(/* webpackMode: "eager" */ "onnxruntime-web");
  ortModule = (mod as any).default ?? mod;
  return ortModule;
}

async function loadImageData(image: ImageRef): Promise<ImageData> {
  const blob = image.dataUrl !== undefined
    ? await (await fetch(image.dataUrl)).blob()
    : new Blob(image.bytes !== undefined ? [image.bytes] : [], { type: image.mimeType ?? "image/png" });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) throw new Error("2D canvas context unavailable");
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

function cropRect(src: ImageData, x: number, y: number, w: number, h: number): ImageData {
  const sx = Math.max(0, Math.min(src.width - 1, Math.trunc(x)));
  const sy = Math.max(0, Math.min(src.height - 1, Math.trunc(y)));
  const sw = Math.max(1, Math.min(src.width - sx, Math.trunc(w)));
  const sh = Math.max(1, Math.min(src.height - sy, Math.trunc(h)));
  const output = new ImageData(sw, sh);
  for (let row = 0; row < sh; row += 1) {
    const srcOff = ((sy + row) * src.width + sx) * 4;
    output.data.set(src.data.subarray(srcOff, srcOff + sw * 4), row * sw * 4);
  }
  return output;
}

// resizeSize/cropSize are independent: scale the shortest edge to resizeSize,
// then take a centered cropSize x cropSize crop (DINOv2/ImageNet contract).
function buildInputTensor(
  crop: ImageData,
  resizeSize: number,
  cropSize: number,
  mean: readonly [number, number, number],
  std: readonly [number, number, number],
  ort: any
): any {
  const scale = resizeSize / Math.min(crop.width, crop.height);
  const rw = Math.max(resizeSize, Math.round(crop.width * scale));
  const rh = Math.max(resizeSize, Math.round(crop.height * scale));

  const srcCanvas = new OffscreenCanvas(crop.width, crop.height);
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
  if (srcCtx === null) throw new Error("2D context unavailable");
  srcCtx.putImageData(crop, 0, 0);

  const rCanvas = new OffscreenCanvas(rw, rh);
  const rCtx = rCanvas.getContext("2d", { willReadFrequently: true });
  if (rCtx === null) throw new Error("2D context unavailable");
  rCtx.drawImage(srcCanvas, 0, 0, rw, rh);

  const cx = Math.floor((rw - cropSize) / 2);
  const cy = Math.floor((rh - cropSize) / 2);
  const pixels = rCtx.getImageData(cx, cy, cropSize, cropSize).data;

  const n = cropSize * cropSize;
  const float32 = new Float32Array(3 * n);
  for (let i = 0; i < n; i += 1) {
    const p = i * 4;
    float32[i] = ((pixels[p] ?? 0) / 255.0 - mean[0]) / std[0];
    float32[n + i] = ((pixels[p + 1] ?? 0) / 255.0 - mean[1]) / std[1];
    float32[2 * n + i] = ((pixels[p + 2] ?? 0) / 255.0 - mean[2]) / std[2];
  }
  return new ort.Tensor("float32", float32, [1, 3, cropSize, cropSize]);
}

function hasExactValues(value: unknown, expected: readonly number[]): boolean {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => Number.isFinite(item) && item === expected[index]);
}

function isFinitePixelArray(values: ArrayLike<number>): boolean {
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) return false;
  }
  return true;
}

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (!Number.isFinite(norm) || norm <= Number.EPSILON) {
    throw new Error(`DINOv2 output cannot be L2-normalized because its norm is ${String(norm)}`);
  }
  return vec.map((v) => v / norm);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
