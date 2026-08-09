import { defaultPipelineConfig, type PipelineConfig } from "../core/config";
import type { ImageRef, LogoCropOcrResult, LogoRegion, LogoRegionFeature, LogoShapeMask, OcrExtraction, OcrWord } from "../core/types";
import { ocrSizeBucket, summarizeOcrWordSizes, tokenizeOcrText } from "../core/ocr/matching";
import type { NormalizedRect, OcrMaskHint, ProposeRegionsOptions, PipelineServices } from "../platform/PipelineServices";
import { YoloLogoDetector, type YoloBox } from "./yoloLogoDetector";
import { manualRegionBox } from "./manualRegion";
import { TRUSTED_ADD_CANDIDATE_CONF, yoloBoxesToCandidates, type TrustedAddCandidate } from "./trustedAddCandidates";

type Cv = Record<string, any>;

function timingEnabled(): boolean {
  return Boolean((globalThis as any).__YODEL_PIPELINE_TIMING__);
}

function nowMs(): number {
  const perf = (globalThis as any).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

function timingLog(message: string): void {
  if (timingEnabled()) console.log("[timing] " + message);
}

function timed<T>(label: string, fn: () => T): T {
  if (!timingEnabled()) return fn();
  const start = nowMs();
  timingLog(label + " start");
  try {
    return fn();
  } finally {
    timingLog(label + " done " + ((nowMs() - start) / 1000).toFixed(3) + "s");
  }
}

async function timedAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!timingEnabled()) return fn();
  const start = nowMs();
  timingLog(label + " start");
  try {
    return await fn();
  } finally {
    timingLog(label + " done " + ((nowMs() - start) / 1000).toFixed(3) + "s");
  }
}

const OCR_TOP_RATIO = 0.75;
const OCR_BOTTOM_WORD_Y_RATIO = 0.65;
const OCR_UPSCALE = 1.5;
const LOGO_REGION_OCR_MIN_HEIGHT_PX = 100;
const LOGO_REGION_MAX_WIDTH = 960;
const LOGO_REGION_TOP_N = 8;
// Region sources whose boxes the user or the detector already vouched for.
const MANUAL_REGION_SOURCE = "manual";
const YOLO_REGION_SOURCE = "yolo";
const TEXT_ATTACH_MAX_AREA_RATIO = 0.040;
const TEXT_ATTACH_MAX_WIDTH_RATIO = 0.34;
const TEXT_ATTACH_MAX_HEIGHT_RATIO = 0.11;

export function createBrowserStackServices(
  config?: PipelineConfig,
  yoloDetector?: YoloLogoDetector
): PipelineServices {
  const resolvedConfig = config ?? defaultPipelineConfig;
  return {
    ocr: new BrowserTesseractOcrEngine(resolvedConfig),
    logoRegions: new OpenCvLogoRegionEngine(resolvedConfig, yoloDetector)
  };
}

class BrowserTesseractOcrEngine {
  private workerPromise: Promise<any> | undefined;

  constructor(private readonly config: PipelineConfig) {}

  async extract(image: ImageRef): Promise<OcrExtraction> {
    const source = await imageRefToImageData(image);
    const topHeight = Math.max(1, Math.round(source.height * OCR_TOP_RATIO));
    const topCanvas = new OffscreenCanvas(
      Math.max(1, Math.round(source.width * OCR_UPSCALE)),
      Math.max(1, Math.round(topHeight * OCR_UPSCALE))
    );
    const topCtx = topCanvas.getContext("2d", { willReadFrequently: true });
    if (topCtx === null) return emptyOcrExtraction();

    const sourceCanvas = imageDataToCanvas(source);
    topCtx.drawImage(sourceCanvas, 0, 0, source.width, topHeight, 0, 0, topCanvas.width, topCanvas.height);
    autocontrast(topCtx, topCanvas.width, topCanvas.height);

    const worker = await this.worker();
    await worker.setParameters({ tessedit_pageseg_mode: "11" });
    const result = await worker.recognize(topCanvas, {}, { text: true, blocks: true });
    const text = String(result?.data?.text ?? "");
    const words = extractTesseractWords(result?.data?.words ?? [], source.height, OCR_UPSCALE, this.config);
    return {
      text,
      tokens: tokenizeOcrText(text),
      words,
      ...summarizeOcrWordSizes(words)
    };
  }

  async extractLogoCrop(image: ImageRef, region: LogoRegion): Promise<LogoCropOcrResult> {
    let cropSize = "unavailable";
    let ocrCanvasSize = "unavailable";
    try {
      const source = await imageRefToImageData(image);
      const crop = cropImageData(
        source,
        region.xOriginal ?? region.x,
        region.yOriginal ?? region.y,
        region.widthOriginal ?? region.width,
        region.heightOriginal ?? region.height
      );
      cropSize = `${crop.width}x${crop.height}`;
      const cropCanvas = imageDataToCanvas(crop);
      const scale = crop.height > 0 && crop.height < LOGO_REGION_OCR_MIN_HEIGHT_PX
        ? LOGO_REGION_OCR_MIN_HEIGHT_PX / crop.height
        : 1.0;
      const ocrCanvas = new OffscreenCanvas(
        Math.max(1, Math.round(crop.width * scale)),
        Math.max(1, Math.round(crop.height * scale))
      );
      ocrCanvasSize = `${ocrCanvas.width}x${ocrCanvas.height}`;
      const ocrCtx = ocrCanvas.getContext("2d", { willReadFrequently: true });
      if (ocrCtx === null) {
        return {
          text: "",
          tokens: [],
          diagnostics: { status: "error", cropSize, ocrCanvasSize, psm: "7", error: "2D context unavailable" }
        };
      }
      ocrCtx.drawImage(cropCanvas, 0, 0, crop.width, crop.height, 0, 0, ocrCanvas.width, ocrCanvas.height);
      autocontrast(ocrCtx, ocrCanvas.width, ocrCanvas.height);

      const worker = await this.worker();
      await worker.setParameters({ tessedit_pageseg_mode: "7" });
      const result = await worker.recognize(ocrCanvas, {}, { text: true });
      const text = String(result?.data?.text ?? "");
      const tokens = tokenizeOcrText(text);
      return {
        text,
        tokens,
        diagnostics: { status: tokens.length > 0 ? "text" : "empty", cropSize, ocrCanvasSize, psm: "7", error: "" }
      };
    } catch (error) {
      return {
        text: "",
        tokens: [],
        diagnostics: {
          status: "error",
          cropSize,
          ocrCanvasSize,
          psm: "7",
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private async worker(): Promise<any> {
    if (this.workerPromise === undefined) {
      this.workerPromise = (async () => {
        const mod = await import(/* webpackMode: "eager" */ "tesseract.js");
        const createWorker = (mod as any).createWorker;
        const assetBase = new URL("/tesseract/", globalThis.location.href);
        const worker = await createWorker("eng", 1, {
          workerPath: new URL("worker.min.js", assetBase).href,
          workerBlobURL: false,
          corePath: new URL("core/", assetBase).href,
          langPath: new URL("lang/", assetBase).href,
          gzip: false
        });
        return worker;
      })();
    }
    return this.workerPromise;
  }
}

class OpenCvLogoRegionEngine {
  constructor(
    private readonly config: PipelineConfig,
    private readonly yoloDetector?: YoloLogoDetector
  ) {}

  async proposeRegions(image: ImageRef, ocrMask?: OcrMaskHint, options?: ProposeRegionsOptions): Promise<LogoRegion[]> {
    const totalStart = nowMs();
    timingLog("proposeRegions " + image.id + " start");
    const cv = await timedAsync("proposeRegions loadCv", () => loadCv());
    const decoded = await timedAsync("proposeRegions imageRefToImageData", () => imageRefToImageData(image));

    // Try YOLO detection first if a detector is configured.
    // Mirrors the Python pipeline's propose_logo_regions_for_image():
    //   - YOLO runs on the original unmasked image
    //   - boxes are scaled to the detection-size image for feature description
    //   - if describe_candidate rejects a box (area filter), keep it anyway
    //     since YOLO precision is trusted — build minimal fields instead
    //   - fall back to the CV pipeline only when YOLO finds nothing
    // skipYolo is set by runDetection when this image's unmasked YOLO pass already
    // returned no boxes, so re-running it for each masked trusted-entry variant
    // would waste ~0.33 s per call producing the same empty result.
    if (this.yoloDetector !== undefined && options?.skipYolo !== true) {
      let yoloBoxes: YoloBox[];
      try {
        yoloBoxes = await timedAsync("proposeRegions yoloDetect", () => this.yoloDetector!.detect(decoded));
      } catch (err) {
        timingLog("proposeRegions yolo failed, falling back to CV: " + String(err));
        yoloBoxes = [];
      }
      if (yoloBoxes.length > 0) {
        timingLog("proposeRegions yolo found " + yoloBoxes.length + " box(es)");
        const srcDec = timed("proposeRegions matFromImageData yolo", () => cv.matFromImageData(decoded));
        const { mat: smallDec, scale } = timed("proposeRegions resizeForDetection yolo", () => resizeForDetection(cv, srcDec, LOGO_REGION_MAX_WIDTH));
        try {
          const imgW = decoded.width;
          const imgH = decoded.height;
          const candidates: LogoRegion[] = [];
          for (const b of yoloBoxes) {
            const boxSmall = toDetectionBox(
              { source: "yolo", x: b.x, y: b.y, width: b.w, height: b.h, componentArea: 0 },
              scale,
              smallDec.cols,
              smallDec.rows
            );
            let region = describeCandidate(cv, smallDec, boxSmall, scale);
            if (region === undefined) {
              // describe_candidate's area filter rejected the box — keep it anyway
              // since YOLO precision is trusted; build minimal fields from original coords.
              const aspect = b.w / Math.max(b.h, 1);
              region = {
                rank: 0,
                score: b.conf,
                source: "yolo",
                x: b.x,
                y: b.y,
                width: b.w,
                height: b.h,
                xOriginal: b.x,
                yOriginal: b.y,
                widthOriginal: b.w,
                heightOriginal: b.h,
                xRatio: round(b.x / Math.max(imgW, 1), 4),
                yRatio: round(b.y / Math.max(imgH, 1), 4),
                widthRatio: round(b.w / Math.max(imgW, 1), 4),
                heightRatio: round(b.h / Math.max(imgH, 1), 4),
                aspect: round(aspect, 4),
                areaRatio: round((b.w * b.h) / Math.max(imgW * imgH, 1), 6)
              };
            }
            candidates.push({ ...region, rank: candidates.length + 1 });
          }
          timingLog("proposeRegions " + image.id + " done (yolo) " + candidates.length + " region(s), " + ((nowMs() - totalStart) / 1000).toFixed(3) + "s");
          return candidates;
        } finally {
          srcDec.delete();
          smallDec.delete();
        }
      }
      timingLog("proposeRegions yolo found no boxes, falling back to CV");
    }

    // CV fallback (OCR mask applied — same as original behavior).
    const imageData = timed("proposeRegions applyOcrMask", () => applyOcrMask(decoded, ocrMask));
    const src = timed("proposeRegions matFromImageData", () => cv.matFromImageData(imageData));
    const { mat: small, scale } = timed("proposeRegions resizeForDetection", () => resizeForDetection(cv, src, LOGO_REGION_MAX_WIDTH));
    timingLog("proposeRegions working-size " + small.cols + "x" + small.rows + " scale=" + scale.toFixed(4));
    try {
      const rawBoxes = timed("proposeRegions proposeLogoBoxes", () => proposeLogoBoxes(cv, small));
      const candidates = timed("proposeRegions describeCandidates " + rawBoxes.length, () => rawBoxes
        .map((box) => describeCandidate(cv, small, box, scale))
        .filter((candidate): candidate is LogoRegion => candidate !== undefined)
        .sort((left, right) => right.score - left.score));

      const deduped: LogoRegion[] = [];
      for (const candidate of candidates) {
        if (deduped.every((existing) => regionIou(candidate, existing) < 0.55)) {
          deduped.push({ ...candidate, rank: deduped.length + 1 });
        }
        if (deduped.length >= LOGO_REGION_TOP_N) break;
      }
      timingLog("proposeRegions " + image.id + " done " + deduped.length + " region(s), " + ((nowMs() - totalStart) / 1000).toFixed(3) + "s");
      return deduped;
    } finally {
      src.delete();
      small.delete();
    }
  }

  // Issue #90: the add-to-trusted flow validates YOLO's proposals with the
  // user instead of trusting the best score, so this asks the detector for
  // everything above the human-review floor and never falls back to the CV
  // proposer — with nothing to offer, the selector opens in free-draw mode.
  async proposeTrustedAddCandidates(image: ImageRef): Promise<TrustedAddCandidate[]> {
    if (this.yoloDetector === undefined) return [];
    const decoded = await imageRefToImageData(image);
    try {
      const boxes = await this.yoloDetector.detect(decoded, TRUSTED_ADD_CANDIDATE_CONF);
      return yoloBoxesToCandidates(boxes, decoded.width, decoded.height);
    } catch (err) {
      timingLog("proposeTrustedAddCandidates yolo failed: " + String(err));
      return [];
    }
  }

  // A confirmed manual selection is described exactly like an automatic
  // candidate — same detection-size image, same pixel statistics, same grids and
  // histogram — so that geometry, layout, color and texture scoring compare it
  // against query regions on equal terms. Only the box itself is taken from the
  // user instead of from a proposal mask.
  async describeManualRegion(image: ImageRef, rect: NormalizedRect): Promise<LogoRegion> {
    const cv = await loadCv();
    const decoded = await imageRefToImageData(image);
    const box: CandidateBox = {
      ...manualRegionBox(rect, decoded.width, decoded.height),
      source: MANUAL_REGION_SOURCE,
      componentArea: 0
    };

    const src = cv.matFromImageData(decoded);
    const { mat: small, scale } = resizeForDetection(cv, src, LOGO_REGION_MAX_WIDTH);
    try {
      const region = describeCandidate(cv, small, toDetectionBox(box, scale, small.cols, small.rows), scale, {
        // The broad-page-band filter exists to drop speculative full-width
        // candidates; a rectangle the user drew is never speculative.
        skipBroadBandFilter: true
      });
      if (region === undefined) {
        throw new Error("Manual logo region could not be described");
      }
      // Descriptors are computed on the detection-size image, but the stored
      // box stays the user's exact selection: the logo crop, its OCR and its
      // embedding are all taken from the full-resolution screenshot.
      return {
        ...region,
        rank: 1,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        xOriginal: box.x,
        yOriginal: box.y,
        widthOriginal: box.width,
        heightOriginal: box.height
      };
    } finally {
      src.delete();
      small.delete();
    }
  }

  async buildFeatures(image: ImageRef, regions: LogoRegion[], ocrMask?: OcrMaskHint): Promise<LogoRegionFeature[]> {
    const cv = await loadCv();
    const imageData = applyOcrMask(await imageRefToImageData(image), ocrMask);
    return regions.map((region, index) => {
      const crop = cropImageData(imageData, region.x, region.y, region.width, region.height);
      const fgMask = foregroundFullMask(cv, crop);
      try {
        const shapeMask = foregroundShapeMask(cv, crop);
        const feature: LogoRegionFeature = {
          index: index + 1,
          region,
          visualRejectReason: isConfirmedRegionSource(region.source)
            ? ""
            : computeVisualRejectReason(cv, region, crop, fgMask)
        };
        if (shapeMask !== undefined) feature.shapeMask = letterboxMask(shapeMask, 96);
        const trimmedRgn = logoContentTrimmedDescriptor(cv, crop, region);
        if (trimmedRgn !== undefined) feature.trimmedRegion = trimmedRgn;
        if (fgMask !== undefined) {
          const comps = buildLogoComponents(cv, crop, region, fgMask);
          if (comps.length > 0) feature.components = comps;
        }
        return feature;
      } finally {
        if (fgMask !== undefined) (fgMask as any).delete();
      }
    });
  }
}

function applyOcrMask(imageData: ImageData, mask: OcrMaskHint | undefined): ImageData {
  if (mask === undefined || mask.words.length === 0) return imageData;
  const keepSet = new Set(mask.keepTokens);
  const result = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  for (const word of mask.words) {
    if (keepSet.has(word.token)) continue;
    const x1 = Math.max(0, Math.trunc(word.fullX ?? word.x));
    const y1 = Math.max(0, Math.trunc(word.fullY ?? word.y));
    const x2 = Math.min(imageData.width, x1 + Math.trunc(word.fullWidthPx ?? word.widthPx));
    const y2 = Math.min(imageData.height, y1 + Math.trunc(word.fullHeightPx ?? word.heightPx));
    for (let y = y1; y < y2; y += 1) {
      for (let x = x1; x < x2; x += 1) {
        const i = (y * imageData.width + x) * 4;
        result.data[i] = 255;
        result.data[i + 1] = 255;
        result.data[i + 2] = 255;
        result.data[i + 3] = 255;
      }
    }
  }
  return result;
}

async function loadCv(): Promise<Cv> {
  const globalCv = (globalThis as any).cv;
  if (globalCv?.Mat !== undefined) {
    timingLog("loadCv using global cv");
    return nonThenableCv(globalCv);
  }

  timingLog("loadCv import @techstark/opencv-js");
  const mod = await import(/* webpackMode: "eager" */ "@techstark/opencv-js");
  let cv = (mod as any).default ?? (mod as any).cv ?? (globalThis as any).cv ?? mod;
  timingLog("loadCv imported keys=" + Object.keys(mod as Record<string, unknown>).slice(0, 8).join(",") + " hasMat=" + Boolean(cv?.Mat) + " calledRun=" + Boolean(cv?.calledRun));

  // Emscripten modules expose a custom then() method, but they are not normal
  // Promises. Awaiting them can deadlock because the resolved value is the same
  // thenable module. Wait for readiness without resolving the module object.
  if (cv?.Mat === undefined && cv?.calledRun !== true && cv?.onRuntimeInitialized !== undefined) {
    timingLog("loadCv wait onRuntimeInitialized");
    await new Promise<void>((resolve) => {
      const previous = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = () => {
        if (typeof previous === "function") previous();
        resolve();
      };
    });
  }

  if (cv?.Mat === undefined) {
    throw new Error("OpenCV.js loaded but cv.Mat is unavailable. keys=" + Object.keys(cv ?? {}).slice(0, 20).join(","));
  }
  timingLog("loadCv ready");
  return nonThenableCv(cv);
}

function nonThenableCv(cv: Cv): Cv {
  if (typeof cv?.then !== "function") return cv;
  timingLog("loadCv disable Emscripten thenable");
  try {
    Object.defineProperty(cv, "then", { value: undefined, configurable: true });
    if (typeof cv.then !== "function") return cv;
  } catch {
    // Fall through to a proxy when the Emscripten module does not allow redefining then.
  }
  return new Proxy(cv, {
    get(target, property, receiver) {
      if (property === "then") return undefined;
      return Reflect.get(target, property, receiver);
    }
  });
}

async function imageRefToImageData(image: ImageRef): Promise<ImageData> {
  const blob = image.dataUrl !== undefined
    ? await (await fetch(image.dataUrl)).blob()
    : new Blob(image.bytes !== undefined ? [image.bytes] : [], { type: image.mimeType ?? "image/png" });
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new Error("2D canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

function imageDataToCanvas(imageData: ImageData): OffscreenCanvas {
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) throw new Error("2D canvas context unavailable");
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function emptyOcrExtraction(): OcrExtraction {
  return { text: "", tokens: [], words: [], medianTextHeightPx: 0.0, medianTextHeightRatio: 0.0 };
}

function extractTesseractWords(rawWords: any[], imageHeight: number, scale: number, config: PipelineConfig): OcrWord[] {
  const words: OcrWord[] = [];
  for (const raw of rawWords) {
    const rawText = String(raw?.text ?? "");
    let tokens = tokenizeOcrText(rawText);
    if (tokens.length === 0) {
      const alt = rawText.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (alt.length >= 3) tokens = [alt];
    }
    if (tokens.length === 0) continue;

    const bbox = raw?.bbox ?? {};
    const x = Number(raw?.left ?? bbox.x0 ?? 0);
    const y = Number(raw?.top ?? bbox.y0 ?? 0);
    const width = Number(raw?.width ?? ((bbox.x1 ?? 0) - (bbox.x0 ?? 0)));
    const height = Number(raw?.height ?? ((bbox.y1 ?? 0) - (bbox.y0 ?? 0)));
    if (height <= 0) continue;

    const fullX = Math.round(x / scale);
    const fullY = Math.round(y / scale);
    const fullWidth = Math.round(width / scale);
    const fullHeight = Math.round(height / scale);
    const heightRatio = height / Math.max(imageHeight * scale, 1);
    const sizeBucket = ocrSizeBucket(heightRatio, config);
    const region = imageHeight > 0 && fullY / imageHeight >= OCR_BOTTOM_WORD_Y_RATIO ? "bottom" : "top";

    for (const token of tokens) {
      words.push({
        text: rawText,
        token,
        region,
        x: Math.round(x),
        y: Math.round(y),
        widthPx: Math.round(width),
        heightPx: Math.round(height),
        heightRatio,
        sizeBucket,
        confidence: Number(raw?.confidence ?? raw?.conf ?? 0),
        fullX,
        fullY,
        fullWidthPx: fullWidth,
        fullHeightPx: fullHeight
      });
    }
  }
  return words;
}

// cutoffPercent mirrors Python's ImageOps.autocontrast(cutoff=1): clips the
// bottom and top 1% of the luminance histogram before stretching. Without this,
// a single rogue dark/bright pixel (border, shadow, antialiasing artifact)
// collapses the stretch range and leaves the image nearly flat for Tesseract.
function autocontrast(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number, cutoffPercent = 1): void {
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const n = data.length / 4;

  const grays = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    grays[i] = Math.round(0.299 * (data[o] ?? 0) + 0.587 * (data[o + 1] ?? 0) + 0.114 * (data[o + 2] ?? 0));
  }
  grays.sort();

  const clip = Math.max(0, Math.floor(n * cutoffPercent / 100));
  const min = grays[clip] ?? 0;
  const max = grays[Math.max(0, n - 1 - clip)] ?? 255;
  const range = Math.max(max - min, 1);

  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0));
    const out = Math.max(0, Math.min(255, Math.round((gray - min) * 255 / range)));
    data[i] = out;
    data[i + 1] = out;
    data[i + 2] = out;
  }
  ctx.putImageData(image, 0, 0);
}

interface CandidateBox {
  source: string;
  x: number;
  y: number;
  width: number;
  height: number;
  componentArea: number;
}

function resizeForDetection(cv: Cv, src: any, maxWidth: number): { mat: any; scale: number } {
  if (src.cols <= maxWidth) return { mat: src.clone(), scale: 1.0 };
  const scale = maxWidth / Math.max(src.cols, 1);
  const dst = new cv.Mat();
  cv.resize(src, dst, new cv.Size(Math.max(1, Math.round(src.cols * scale)), Math.max(1, Math.round(src.rows * scale))), 0, 0, cv.INTER_AREA);
  return { mat: dst, scale };
}

function proposeLogoBoxes(cv: Cv, src: any): CandidateBox[] {
  const masks = timed("proposeLogoBoxes buildCandidateMasks", () => buildCandidateMasks(cv, src));
  const raw: CandidateBox[] = [];
  let textMask: any = null;
  try {
    for (const [source, mask] of Object.entries(masks)) {
      raw.push(...timed("proposeLogoBoxes componentBoxes " + source, () => componentBoxes(cv, mask, source, src.cols, src.rows)));
    }
    timingLog("proposeLogoBoxes raw-boxes " + raw.length);
    const mergeGap = processingGap(src.cols, src.rows, 0.012, 4, 18);
    const textGap = processingGap(src.cols, src.rows, 0.010, 6, 30);
    const margin = processingGap(src.cols, src.rows, 0.006, 2, 10);
    const merged = timed("proposeLogoBoxes mergeNearbyBoxes", () => mergeNearbyBoxes(raw, mergeGap, src.cols, src.rows));
    const detailBoxes = timed("proposeLogoBoxes splitLargeDetailBands", () => splitLargeDetailBands(cv, src, merged));
    textMask = timed("proposeLogoBoxes buildTextMask", () => buildTextMask(cv, src));
    const textBoxes = timed("proposeLogoBoxes textComponentBoxes", () => textComponentBoxes(cv, textMask, src.cols, src.rows));
    timingLog("proposeLogoBoxes textBoxes " + textBoxes.length + " detailBoxes " + detailBoxes.length);
    const withText = timed("proposeLogoBoxes attachNearbyText", () =>
      attachNearbyText([...merged, ...detailBoxes], textBoxes, textGap, src.cols, src.rows)
    ).map((box) => expandBox(box, margin, src.cols, src.rows))
      .filter((box) => !isBroadPageBand(box, src.cols, src.rows));
    let result = timed("proposeLogoBoxes mergeOverlappingBoxes", () => mergeOverlappingBoxes(withText, src.cols, src.rows));
    result = timed("proposeLogoBoxes headerZoneFallback", () => addHeaderZoneFallback(cv, result, textMask, mergeGap, src.cols, src.rows));
    result = timed("proposeLogoBoxes headerBandFallback", () => addHeaderBandFallback(cv, src, result, masks["combined"] as any, src.cols, src.rows));
    return result;
  } finally {
    if (textMask !== null) (textMask as any).delete();
    Object.values(masks).forEach((mask) => mask.delete());
  }
}

function buildCandidateMasks(cv: Cv, src: any): Record<string, any> {
  const rgb = new cv.Mat();
  const gray = new cv.Mat();
  const hsv = new cv.Mat();
  const colorMask = new cv.Mat();
  const edges = new cv.Mat();
  const edgeMask = new cv.Mat();
  const inkMask = cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);
  const brightMask = cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);
  const combined = new cv.Mat();
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const lowerColor = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 45, 45, 0]);
    const upperColor = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [179, 255, 255, 255]);
    try {
      cv.inRange(hsv, lowerColor, upperColor, colorMask);
    } finally {
      lowerColor.delete();
      upperColor.delete();
    }
    cleanMask(cv, colorMask, [7, 7], [5, 5]);

    cv.Canny(gray, edges, 50, 150);
    const edgeDilK = cv.Mat.ones(3, 3, cv.CV_8U);
    try { cv.dilate(edges, edgeMask, edgeDilK); } finally { edgeDilK.delete(); }

    // Extract V channel and Gaussian-blur it for bright-on-dark detection.
    // Python: value_blur = GaussianBlur(value, (31,31), 0); bright = v > 160 && value_blur < 120 && edge
    const hsvChannels = new cv.MatVector();
    cv.split(hsv, hsvChannels);
    const hCh = hsvChannels.get(0);
    const sCh = hsvChannels.get(1);
    const vCh = hsvChannels.get(2);
    const vBlur = new cv.Mat();
    try {
      cv.GaussianBlur(vCh, vBlur, new cv.Size(31, 31), 0);
      const grayData = gray.data as Uint8Array;
      const edgeData = edgeMask.data as Uint8Array;
      const hsvData = hsv.data as Uint8Array;
      const inkData = inkMask.data as Uint8Array;
      const brightData = brightMask.data as Uint8Array;
      const vBlurData = vBlur.data as Uint8Array;
      const pixelCount = src.rows * src.cols;
      for (let i = 0; i < pixelCount; i += 1) {
        const g = grayData[i] ?? 0;
        const e = edgeData[i] ?? 0;
        const v = hsvData[i * 3 + 2] ?? 0;
        const vb = vBlurData[i] ?? 0;
        if (g < 175 && e > 0) inkData[i] = 255;
        if (v > 160 && vb < 120 && e > 0) brightData[i] = 255;
      }
    } finally {
      vBlur.delete();
      hCh.delete(); sCh.delete(); vCh.delete();
      hsvChannels.delete();
    }

    cleanMask(cv, inkMask, [17, 5], [9, 3]);
    cleanMask(cv, brightMask, [17, 5], [9, 3]);
    cv.bitwise_or(colorMask, inkMask, combined);
    cv.bitwise_or(combined, brightMask, combined);
    cleanMask(cv, combined, [13, 7], [5, 5]);
    return {
      color: colorMask.clone(),
      ink: inkMask.clone(),
      bright: brightMask.clone(),
      combined: combined.clone()
    };
  } finally {
    rgb.delete(); gray.delete(); hsv.delete(); colorMask.delete(); edges.delete(); edgeMask.delete(); inkMask.delete(); brightMask.delete(); combined.delete();
  }
}

function cleanMask(cv: Cv, mask: any, closeKernel: [number, number], dilateKernel: [number, number]): void {
  const k1 = cv.Mat.ones(3, 3, cv.CV_8U);
  const k2 = cv.Mat.ones(closeKernel[0], closeKernel[1], cv.CV_8U);
  const k3 = cv.Mat.ones(dilateKernel[0], dilateKernel[1], cv.CV_8U);
  try {
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k1);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k2);
    cv.dilate(mask, mask, k3);
  } finally {
    k1.delete(); k2.delete(); k3.delete();
  }
}

function componentBoxes(cv: Cv, mask: any, source: string, imageWidth: number, imageHeight: number): CandidateBox[] {
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const centroids = new cv.Mat();
  const boxes: CandidateBox[] = [];
  try {
    const count = cv.connectedComponentsWithStats(mask, labels, stats, centroids, 8);
    const area = Math.max(imageWidth * imageHeight, 1);
    for (let label = 1; label < count; label += 1) {
      const x = stats.intAt(label, cv.CC_STAT_LEFT ?? 0);
      const y = stats.intAt(label, cv.CC_STAT_TOP ?? 1);
      const width = stats.intAt(label, cv.CC_STAT_WIDTH ?? 2);
      const height = stats.intAt(label, cv.CC_STAT_HEIGHT ?? 3);
      const componentArea = stats.intAt(label, cv.CC_STAT_AREA ?? 4);
      if (width < 10 || height < 8 || componentArea < 30) continue;
      if (width > imageWidth * 0.75 || height > imageHeight * 0.35) continue;
      const areaRatio = (width * height) / area;
      if (areaRatio < 0.00008 || areaRatio > 0.12) continue;
      const aspect = width / Math.max(height, 1);
      if (aspect < 0.25 || aspect > 18.0) continue;
      boxes.push({ source, x, y, width, height, componentArea });
    }
    return boxes;
  } finally {
    labels.delete(); stats.delete(); centroids.delete();
  }
}

// The UI-control heuristics in computeVisualRejectReason are there to filter
// speculative CV proposals. A YOLO detection and a rectangle the user drew and
// confirmed are both already vouched for, so classifying either as an input or
// a button would silently discard a reference that was chosen on purpose.
function isConfirmedRegionSource(source: string): boolean {
  return source === YOLO_REGION_SOURCE || source === MANUAL_REGION_SOURCE;
}

// Maps an original-pixel box onto the downscaled image the descriptors are
// computed from, keeping it inside the mat so roi() cannot overflow.
function toDetectionBox(box: CandidateBox, scale: number, detectionWidth: number, detectionHeight: number): CandidateBox {
  const x = clampNumber(Math.round(box.x * scale), 0, Math.max(detectionWidth - 1, 0));
  const y = clampNumber(Math.round(box.y * scale), 0, Math.max(detectionHeight - 1, 0));
  return {
    ...box,
    x,
    y,
    width: clampNumber(Math.round(box.width * scale), 1, detectionWidth - x),
    height: clampNumber(Math.round(box.height * scale), 1, detectionHeight - y)
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function describeCandidate(
  cv: Cv,
  image: any,
  box: CandidateBox,
  scale: number,
  options?: { skipBroadBandFilter?: boolean }
): LogoRegion | undefined {
  const cropRect = new cv.Rect(box.x, box.y, box.width, box.height);
  const crop = image.roi(cropRect);
  const rgb = new cv.Mat();
  const gray = new cv.Mat();
  const hsv = new cv.Mat();
  const edges = new cv.Mat();
  try {
    cv.cvtColor(crop, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.Canny(gray, edges, 50, 150);

    const imageArea = Math.max(image.cols * image.rows, 1);
    const areaRatio = (box.width * box.height) / imageArea;
    if (options?.skipBroadBandFilter !== true && areaRatio > 0.055 && box.width / Math.max(image.cols, 1) > 0.40) {
      return undefined;
    }
    const aspect = box.width / Math.max(box.height, 1);
    const stats = pixelStats(hsv, gray, edges);
    const sourceBonus = sourceBonusValue(box.source);
    const colorOrEdge = Math.max(Math.min(stats.colorPixelRatio * 3.0, 1.0), Math.min(stats.edgeDensity * 6.0, 1.0));
    const score = Math.min(
      0.26 * scoreSize(areaRatio) +
      0.18 * scoreAspect(aspect) +
      0.18 * scorePosition(box.y / image.rows, box.height / image.rows) +
      0.16 * colorOrEdge +
      0.12 * Math.min(stats.edgeDensity * 8.0, 1.0) +
      0.10 * Math.min(stats.foregroundRatio * 2.0, 1.0) +
      sourceBonus,
      1.0
    );
    const invScale = 1.0 / scale;
    return {
      rank: 0,
      score: round(score, 4),
      source: box.source,
      x: Math.round(box.x * invScale),
      y: Math.round(box.y * invScale),
      width: Math.round(box.width * invScale),
      height: Math.round(box.height * invScale),
      xOriginal: Math.round(box.x * invScale),
      yOriginal: Math.round(box.y * invScale),
      widthOriginal: Math.round(box.width * invScale),
      heightOriginal: Math.round(box.height * invScale),
      xRatio: round(box.x / Math.max(image.cols, 1), 4),
      yRatio: round(box.y / Math.max(image.rows, 1), 4),
      widthRatio: round(box.width / Math.max(image.cols, 1), 4),
      heightRatio: round(box.height / Math.max(image.rows, 1), 4),
      aspect: round(aspect, 4),
      areaRatio: round(areaRatio, 6),
      foregroundRatio: round(stats.foregroundRatio, 4),
      colorPixelRatio: round(stats.colorPixelRatio, 4),
      meanSaturation: round(stats.meanSaturation, 2),
      edgeDensity: round(stats.edgeDensity, 4),
      dominantHueBin: stats.dominantHueBin,
      dominantHueFraction: stats.dominantHueFraction,
      colorGrid4x4: quantizedColorGrid(hsv),
      edgeGrid4x4: quantizedEdgeGrid(edges),
      edgeDirGrid: edgeDirectionGrid(cv, gray),
      colorHist: colorHistogram19(hsv)
    };
  } finally {
    crop.delete(); rgb.delete(); gray.delete(); hsv.delete(); edges.delete();
  }
}

function pixelStats(hsv: any, gray: any, edges: any): { foregroundRatio: number; colorPixelRatio: number; meanSaturation: number; edgeDensity: number; dominantHueBin: string; dominantHueFraction: number } {
  let colorPixels = 0;
  let foreground = 0;
  let edgePixels = 0;
  let saturationSum = 0;
  const hueBins = new Array<number>(15).fill(0);
  const total = Math.max(hsv.rows * hsv.cols, 1);
  const hsvData = hsv.data as Uint8Array;
  const grayData = gray.data as Uint8Array;
  const edgeData = edges.data as Uint8Array;
  for (let i = 0; i < total; i += 1) {
    const pi = i * 3;
    const h = hsvData[pi] ?? 0;
    const s = hsvData[pi + 1] ?? 0;
    const v = hsvData[pi + 2] ?? 0;
    const g = grayData[i] ?? 0;
    const e = edgeData[i] ?? 0;
    saturationSum += s;
    const color = s > 45 && v > 45;
    if (color) {
      colorPixels += 1;
      const hueBin = Math.min(Math.floor(h / 12), 14);
      hueBins[hueBin] = (hueBins[hueBin] ?? 0) + 1;
    }
    if (e > 0) edgePixels += 1;
    if (g < 210 || color || e > 0) foreground += 1;
  }
  const dominant = hueBins.reduce((best, value, index) => value > (hueBins[best] ?? 0) ? index : best, 0);
  return {
    foregroundRatio: foreground / total,
    colorPixelRatio: colorPixels / total,
    meanSaturation: saturationSum / total,
    edgeDensity: edgePixels / total,
    dominantHueBin: colorPixels > 0 ? String(dominant) : "",
    dominantHueFraction: colorPixels > 0 ? round((hueBins[dominant] ?? 0) / colorPixels, 4) : 0
  };
}

function foregroundShapeMask(cv: Cv, imageData: ImageData): LogoShapeMask | undefined {
  const data = imageData.data;
  if (data.length === 0) return undefined;
  const W = imageData.width;
  const H = imageData.height;
  const border = borderMedianRgb(imageData);
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      const hsv = rgbToHsv(r, g, b);
      const dist = Math.hypot(r - border[0], g - border[1], b - border[2]);
      if ((dist > 45 && hsv.v < 248) || (hsv.s > 70 && dist > 25 && hsv.v > 35) || (gray < 150 && dist > 25)) {
        mask[y * W + x] = 1;
      }
    }
  }
  // Python logo_region_shape_mask applies MORPH_OPEN(2×2) + MORPH_CLOSE(3×3) to clean the mask.
  const maskMat = new cv.Mat(H, W, cv.CV_8UC1);
  const matData = maskMat.data as Uint8Array;
  for (let i = 0; i < W * H; i += 1) matData[i] = (mask[i] ?? 0) === 1 ? 255 : 0;
  const openK = cv.Mat.ones(2, 2, cv.CV_8U);
  const closeK = cv.Mat.ones(3, 3, cv.CV_8U);
  try {
    cv.morphologyEx(maskMat, maskMat, cv.MORPH_OPEN, openK);
    cv.morphologyEx(maskMat, maskMat, cv.MORPH_CLOSE, closeK);
  } finally {
    openK.delete(); closeK.delete();
  }
  let count = 0;
  const cleaned = maskMat.data as Uint8Array;
  for (let i = 0; i < W * H; i += 1) {
    mask[i] = (cleaned[i] ?? 0) > 0 ? 1 : 0;
    if (mask[i] === 1) count += 1;
  }
  maskMat.delete();
  if (count < 20) return undefined;
  return trimMask({ width: W, height: H, data: mask });
}

function letterboxMask(mask: LogoShapeMask, canvasSize: number): LogoShapeMask {
  const scale = canvasSize / Math.max(mask.width, mask.height, 1);
  const newWidth = Math.max(1, Math.round(mask.width * scale));
  const newHeight = Math.max(1, Math.round(mask.height * scale));
  const resized = new Uint8Array(newWidth * newHeight);
  for (let y = 0; y < newHeight; y += 1) {
    for (let x = 0; x < newWidth; x += 1) {
      const sx = Math.min(mask.width - 1, Math.floor(x / scale));
      const sy = Math.min(mask.height - 1, Math.floor(y / scale));
      resized[y * newWidth + x] = mask.data[sy * mask.width + sx] ?? 0;
    }
  }
  const output = new Uint8Array(canvasSize * canvasSize);
  const xOff = Math.floor((canvasSize - newWidth) / 2);
  const yOff = Math.floor((canvasSize - newHeight) / 2);
  for (let y = 0; y < newHeight; y += 1) {
    for (let x = 0; x < newWidth; x += 1) {
      output[(y + yOff) * canvasSize + x + xOff] = resized[y * newWidth + x] ?? 0;
    }
  }
  return { width: canvasSize, height: canvasSize, data: output };
}

function trimMask(mask: LogoShapeMask): LogoShapeMask | undefined {
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if ((mask.data[y * mask.width + x] ?? 0) === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return undefined;
  const margin = 2;
  minX = Math.max(0, minX - margin);
  minY = Math.max(0, minY - margin);
  maxX = Math.min(mask.width - 1, maxX + margin);
  maxY = Math.min(mask.height - 1, maxY + margin);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      output[y * width + x] = mask.data[(y + minY) * mask.width + x + minX] ?? 0;
    }
  }
  return { width, height, data: output };
}

interface FullLogoVisualStats {
  whiteRatio: number; neutralRatio: number; colorRatio: number; edgeDensity: number;
  fillStd: number; borderEdgeRatio: number; centerEdgeRatio: number;
  foregroundRatio: number; foregroundCentered: number;
  foregroundWidthRatio: number; foregroundHeightRatio: number; foregroundColorRatio: number;
}

function emptyLogoVisualStats(): FullLogoVisualStats {
  return { whiteRatio: 0, neutralRatio: 0, colorRatio: 0, edgeDensity: 0, fillStd: 0, borderEdgeRatio: 0, centerEdgeRatio: 0, foregroundRatio: 0, foregroundCentered: 0, foregroundWidthRatio: 0, foregroundHeightRatio: 0, foregroundColorRatio: 0 };
}

// Mirrors Python logo_region_visual_stats. fgMask is an optional caller-owned CV_8UC1 mat.
function fullLogoVisualStats(cv: Cv, imageData: ImageData, fgMask?: any): FullLogoVisualStats {
  const W = imageData.width;
  const H = imageData.height;
  if (W <= 0 || H <= 0) return emptyLogoVisualStats();
  const src = cv.matFromImageData(imageData);
  const rgb = new cv.Mat();
  const gray = new cv.Mat();
  const hsv = new cv.Mat();
  const edges = new cv.Mat();
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.Canny(gray, edges, 50, 150);
    const rgbData = rgb.data as Uint8Array;
    const hsvData = hsv.data as Uint8Array;
    const edgeData = edges.data as Uint8Array;
    const total = W * H;
    const bt = Math.max(1, Math.floor(Math.min(W, H) / 10));
    let white = 0, neutral = 0, color = 0, edgePx = 0;
    let rSum = 0, gSum = 0, bSum = 0;
    let rSumSq = 0, gSumSq = 0, bSumSq = 0;
    let borderEdgePx = 0, borderTot = 0, centerEdgePx = 0, centerTot = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = y * W + x;
        const s = hsvData[i * 3 + 1] ?? 0;
        const v = hsvData[i * 3 + 2] ?? 0;
        const e = (edgeData[i] ?? 0) > 0 ? 1 : 0;
        if (s < 35 && v > 220) white += 1;
        if (s < 45) neutral += 1;
        if (s > 55 && v > 70) color += 1;
        if (e) edgePx += 1;
        const r = rgbData[i * 3] ?? 0;
        const g = rgbData[i * 3 + 1] ?? 0;
        const b = rgbData[i * 3 + 2] ?? 0;
        rSum += r; gSum += g; bSum += b;
        rSumSq += r * r; gSumSq += g * g; bSumSq += b * b;
        const isBorder = x < bt || x >= W - bt || y < bt || y >= H - bt;
        if (isBorder) { borderTot += 1; if (e) borderEdgePx += 1; }
        else { centerTot += 1; if (e) centerEdgePx += 1; }
      }
    }
    const rMean = rSum / total, gMean = gSum / total, bMean = bSum / total;
    // Single-pass variance: Var(X) = E[X²] - E[X]²
    const fillStd = (
      Math.sqrt(Math.max(rSumSq / total - rMean * rMean, 0)) +
      Math.sqrt(Math.max(gSumSq / total - gMean * gMean, 0)) +
      Math.sqrt(Math.max(bSumSq / total - bMean * bMean, 0))
    ) / 3.0;
    let foregroundRatio = 0, foregroundCentered = 0, foregroundWidthRatio = 0, foregroundHeightRatio = 0, foregroundColorRatio = 0;
    if (fgMask !== undefined) {
      const fgData = fgMask.data as Uint8Array;
      let fgCount = 0, fgColorCount = 0;
      let fgMinX = W, fgMinY = H, fgMaxX = -1, fgMaxY = -1;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const i = y * W + x;
          if ((fgData[i] ?? 0) > 0) {
            fgCount += 1;
            if (x < fgMinX) fgMinX = x; if (x > fgMaxX) fgMaxX = x;
            if (y < fgMinY) fgMinY = y; if (y > fgMaxY) fgMaxY = y;
            if ((hsvData[i * 3 + 1] ?? 0) > 45 && (hsvData[i * 3 + 2] ?? 0) > 70) fgColorCount += 1;
          }
        }
      }
      foregroundRatio = fgCount / Math.max(total, 1);
      if (fgCount >= 8 && fgMaxX >= fgMinX) {
        foregroundWidthRatio = (fgMaxX - fgMinX + 1) / Math.max(W, 1);
        foregroundHeightRatio = (fgMaxY - fgMinY + 1) / Math.max(H, 1);
        const cx = (fgMinX + fgMaxX + 1) / 2.0 / Math.max(W, 1);
        const cy = (fgMinY + fgMaxY + 1) / 2.0 / Math.max(H, 1);
        foregroundCentered = Math.abs(cx - 0.5) <= 0.18 && Math.abs(cy - 0.5) <= 0.22 ? 1.0 : 0.0;
        foregroundColorRatio = fgColorCount / Math.max(fgCount, 1);
      }
    }
    return {
      whiteRatio: white / total, neutralRatio: neutral / total, colorRatio: color / total,
      edgeDensity: edgePx / total, fillStd,
      borderEdgeRatio: borderTot > 0 ? borderEdgePx / borderTot : 0.0,
      centerEdgeRatio: centerTot > 0 ? centerEdgePx / centerTot : 0.0,
      foregroundRatio, foregroundCentered, foregroundWidthRatio, foregroundHeightRatio, foregroundColorRatio
    };
  } finally {
    src.delete(); rgb.delete(); gray.delete(); hsv.delete(); edges.delete();
  }
}

function logoRegionHasColoredForegroundMark(region: LogoRegion, stats: FullLogoVisualStats, aspect: number): boolean {
  const source = region.source ?? "";
  return (source.includes("color") || source.includes("combined"))
    && aspect >= 1.4 && aspect <= 4.8
    && stats.foregroundCentered >= 1.0
    && stats.foregroundRatio >= 0.08 && stats.foregroundRatio <= 0.24
    && stats.foregroundWidthRatio >= 0.32 && stats.foregroundWidthRatio <= 0.86
    && stats.foregroundHeightRatio >= 0.20 && stats.foregroundHeightRatio <= 0.58
    && stats.colorRatio >= 0.035
    && stats.foregroundColorRatio >= 0.30;
}

// Mirrors Python logo_region_reject_reason + logo_region_ui_control_reject_reason.
// fgMask is an optional caller-owned CV_8UC1 mat (reuse from buildFeatures to avoid recomputing).
function computeVisualRejectReason(cv: Cv, region: LogoRegion, crop: ImageData, fgMask?: any): string {
  const W = crop.width;
  const H = crop.height;
  if (W <= 0 || H <= 0) return "";
  const aspect = W / Math.max(H, 1);
  const areaRatio = region.areaRatio ?? 0.0;
  const yRatio = region.yRatio ?? 0.0;
  const stats = fullLogoVisualStats(cv, crop, fgMask);
  const longEnough = aspect >= 1.5 && areaRatio >= 0.0015;
  const likelyFormZone = yRatio >= 0.12;
  const hasMark = logoRegionHasColoredForegroundMark(region, stats, aspect);

  if (aspect >= 0.7 && aspect <= 1.3 && W < 110 && H < 110 && stats.colorRatio >= 0.20 && stats.foregroundRatio <= 0.65 && !hasMark) {
    return "small square UI icon";
  }
  if (longEnough && stats.whiteRatio >= 0.62 && stats.colorRatio <= 0.08 && stats.foregroundRatio <= 0.32 && stats.edgeDensity <= 0.12 && !hasMark) {
    return "input-like neutral rectangle";
  }
  if (longEnough && stats.neutralRatio >= 0.72 && stats.colorRatio <= 0.10 && stats.borderEdgeRatio >= Math.max(0.020, stats.centerEdgeRatio * 1.35) && stats.foregroundRatio <= 0.38) {
    return "input-like bordered rectangle";
  }
  if (likelyFormZone && longEnough && stats.fillStd <= 58.0 && stats.foregroundCentered >= 1.0 && stats.foregroundWidthRatio >= 0.08 && stats.foregroundWidthRatio <= 0.78 && stats.foregroundHeightRatio <= 0.62 && stats.edgeDensity <= 0.18 && (stats.colorRatio >= 0.30 || stats.neutralRatio >= 0.75) && !hasMark) {
    return "button-like centered text rectangle";
  }
  if (areaRatio >= 0.003 && aspect >= 2.4 && stats.whiteRatio >= 0.68 && stats.colorRatio <= 0.04 && stats.edgeDensity <= 0.09) {
    return "blank/control-like rectangle";
  }
  return "";
}

// ---- Foreground full mask (dominant-color exclusion) ----

// Mirrors Python logo_region_foreground_full_mask. Returns CV_8UC1 mat; caller must delete.
function foregroundFullMask(cv: Cv, imageData: ImageData): any | undefined {
  const W = imageData.width;
  const H = imageData.height;
  if (W <= 0 || H <= 0) return undefined;
  const src = cv.matFromImageData(imageData);
  const rgb = new cv.Mat();
  const gray = new cv.Mat();
  const hsv = new cv.Mat();
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const rgbData = rgb.data as Uint8Array;
    const hsvData = hsv.data as Uint8Array;
    const grayData = gray.data as Uint8Array;
    const total = W * H;
    const border = borderMedianRgb(imageData);
    const bgR = border[0], bgG = border[1], bgB = border[2];
    // Find dominant saturated hue for exclusion
    let saturatedCount = 0;
    const hueBins = new Array<number>(15).fill(0);
    for (let i = 0; i < total; i += 1) {
      const s = hsvData[i * 3 + 1] ?? 0;
      const v = hsvData[i * 3 + 2] ?? 0;
      if (s > 55 && v > 45) {
        saturatedCount += 1;
        const bin = Math.min(Math.floor((hsvData[i * 3] ?? 0) / 12), 14);
        hueBins[bin] = (hueBins[bin] ?? 0) + 1;
      }
    }
    let dominantBin = -1;
    if (saturatedCount > 0) {
      const bestBin = hueBins.reduce((best, val, idx) => val > (hueBins[best] ?? 0) ? idx : best, 0);
      const bestCount = hueBins[bestBin] ?? 0;
      if (bestCount / saturatedCount >= 0.55 && saturatedCount - bestCount >= 20) dominantBin = bestBin;
    }
    const maskMat = new cv.Mat(H, W, cv.CV_8UC1);
    const matData = maskMat.data as Uint8Array;
    for (let i = 0; i < total; i += 1) {
      const ri = rgbData[i * 3] ?? 0;
      const gi = rgbData[i * 3 + 1] ?? 0;
      const bi = rgbData[i * 3 + 2] ?? 0;
      const g = grayData[i] ?? 0;
      const s = hsvData[i * 3 + 1] ?? 0;
      const v = hsvData[i * 3 + 2] ?? 0;
      const dist = Math.sqrt((ri - bgR) ** 2 + (gi - bgG) ** 2 + (bi - bgB) ** 2);
      const isFg = (dist > 45 && v < 248) || (s > 70 && dist > 25 && v > 35) || (g < 150 && dist > 25);
      if (!isFg) { matData[i] = 0; continue; }
      if (dominantBin >= 0 && s > 55 && v > 45 && Math.min(Math.floor((hsvData[i * 3] ?? 0) / 12), 14) === dominantBin) {
        matData[i] = 0; continue;
      }
      matData[i] = 255;
    }
    const fgOpenK = cv.Mat.ones(2, 2, cv.CV_8U);
    const fgCloseK = cv.Mat.ones(3, 3, cv.CV_8U);
    try {
      cv.morphologyEx(maskMat, maskMat, cv.MORPH_OPEN, fgOpenK);
      cv.morphologyEx(maskMat, maskMat, cv.MORPH_CLOSE, fgCloseK);
    } finally {
      fgOpenK.delete(); fgCloseK.delete();
    }
    let count = 0;
    const fd = maskMat.data as Uint8Array;
    for (let i = 0; i < total; i += 1) { if ((fd[i] ?? 0) > 0) count += 1; }
    if (count < 20) { maskMat.delete(); return undefined; }
    return maskMat;
  } finally {
    src.delete(); rgb.delete(); gray.delete(); hsv.delete();
  }
}

// ---- Content trimming for trimmedRegion ----

// Mirrors Python logo_content_bbox.
function logoContentBbox(cv: Cv, imageData: ImageData): [number, number, number, number] | undefined {
  const W = imageData.width;
  const H = imageData.height;
  if (W <= 0 || H <= 0) return undefined;
  const src = cv.matFromImageData(imageData);
  const rgb = new cv.Mat();
  const gray = new cv.Mat();
  const hsv = new cv.Mat();
  const edges = new cv.Mat();
  const contentMat = cv.Mat.zeros(H, W, cv.CV_8UC1);
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.Canny(gray, edges, 50, 150);
    const hsvData = hsv.data as Uint8Array;
    const grayData = gray.data as Uint8Array;
    const edgeData = edges.data as Uint8Array;
    const contentData = contentMat.data as Uint8Array;
    const total = W * H;
    for (let i = 0; i < total; i += 1) {
      if (((hsvData[i * 3 + 1] ?? 0) > 35 && (hsvData[i * 3 + 2] ?? 0) > 45) || (grayData[i] ?? 0) < 225 || (edgeData[i] ?? 0) > 0) {
        contentData[i] = 255;
      }
    }
    const bboxCloseK = cv.Mat.ones(3, 3, cv.CV_8U);
    try { cv.morphologyEx(contentMat, contentMat, cv.MORPH_CLOSE, bboxCloseK); } finally { bboxCloseK.delete(); }
    let minX = W, minY = H, maxX = -1, maxY = -1, count = 0;
    const closed = contentMat.data as Uint8Array;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if ((closed[y * W + x] ?? 0) > 0) {
          count += 1;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (count < 20) return undefined;
    const m = 2;
    return [Math.max(0, minX - m), Math.max(0, minY - m), Math.min(W, maxX + m + 1), Math.min(H, maxY + m + 1)];
  } finally {
    src.delete(); rgb.delete(); gray.delete(); hsv.delete(); edges.delete(); contentMat.delete();
  }
}

// Mirrors Python trim_logo_content_with_box + logo_region_descriptor_from_crop.
// Returns undefined when the trim is trivial (< 3% reduction) or crop is too small.
function logoContentTrimmedDescriptor(cv: Cv, crop: ImageData, region: LogoRegion): LogoRegion | undefined {
  const bbox = logoContentBbox(cv, crop);
  if (bbox === undefined) return undefined;
  const [x1, y1, x2, y2] = bbox;
  const tw = x2 - x1, th = y2 - y1;
  if (tw < 8 || th < 8) return undefined;
  if (tw >= crop.width * 0.97 && th >= crop.height * 0.97) return undefined;
  const trimmedCrop = cropImageData(crop, x1, y1, tw, th);
  const src = cv.matFromImageData(trimmedCrop);
  const rgb = new cv.Mat();
  const gray = new cv.Mat();
  const hsv = new cv.Mat();
  const edges = new cv.Mat();
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.Canny(gray, edges, 50, 150);
    const ps = pixelStats(hsv, gray, edges);
    return {
      rank: region.rank, score: region.score, source: region.source,
      x: region.x + x1, y: region.y + y1, width: tw, height: th,
      aspect: round(tw / Math.max(th, 1), 4),
      foregroundRatio: round(ps.foregroundRatio, 4),
      colorPixelRatio: round(ps.colorPixelRatio, 4),
      meanSaturation: round(ps.meanSaturation, 2),
      edgeDensity: round(ps.edgeDensity, 4),
      dominantHueBin: ps.dominantHueBin,
      dominantHueFraction: ps.dominantHueFraction,
      colorGrid4x4: quantizedColorGrid(hsv),
      edgeGrid4x4: quantizedEdgeGrid(edges),
      edgeDirGrid: edgeDirectionGrid(cv, gray),
      colorHist: colorHistogram19(hsv)
    };
  } finally {
    src.delete(); rgb.delete(); gray.delete(); hsv.delete(); edges.delete();
  }
}

// ---- Logo component search ----

interface CompBox { x: number; y: number; w: number; h: number; area: number }

function compBoxMergeable(a: CompBox, b: CompBox, gap: number): boolean {
  const xGap = intervalGap(a.x, a.x + a.w, b.x, b.x + b.w);
  const yGap = intervalGap(a.y, a.y + a.h, b.y, b.y + b.h);
  const xOvlp = intervalOverlap(a.x, a.x + a.w, b.x, b.x + b.w) / Math.max(Math.min(a.w, b.w), 1);
  const yOvlp = intervalOverlap(a.y, a.y + a.h, b.y, b.y + b.h) / Math.max(Math.min(a.h, b.h), 1);
  return (xGap <= gap && yOvlp >= 0.28) || (yGap <= Math.max(2, Math.floor(gap / 3)) && xOvlp >= 0.55);
}

// Mirrors Python merge_logo_component_boxes.
function mergeLogoComponentBoxes(boxes: CompBox[], gap: number): CompBox[] {
  let merged = boxes.map((b) => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    const output: CompBox[] = [];
    const consumed = new Array<boolean>(merged.length).fill(false);
    for (let i = 0; i < merged.length; i += 1) {
      if (consumed[i] === true) continue;
      let cur = { ...(merged[i] as CompBox) };
      consumed[i] = true;
      let grew = true;
      while (grew) {
        grew = false;
        for (let j = 0; j < merged.length; j += 1) {
          if (consumed[j] === true) continue;
          const oth = merged[j] as CompBox;
          if (compBoxMergeable(cur, oth, gap)) {
            const x1 = Math.min(cur.x, oth.x), y1 = Math.min(cur.y, oth.y);
            const x2 = Math.max(cur.x + cur.w, oth.x + oth.w);
            const y2 = Math.max(cur.y + cur.h, oth.y + oth.h);
            cur = { x: x1, y: y1, w: x2 - x1, h: y2 - y1, area: cur.area + oth.area };
            consumed[j] = true; changed = true; grew = true;
          }
        }
      }
      output.push(cur);
    }
    merged = output;
  }
  return merged;
}

function compBoxIou(a: CompBox, b: CompBox): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0.0;
}

// Mirrors Python trusted_logo_component_regions. fgMask is caller-owned.
function buildLogoComponents(cv: Cv, crop: ImageData, region: LogoRegion, fgMask: any): LogoRegionFeature[] {
  const W = crop.width;
  const H = crop.height;
  const imageArea = Math.max(W * H, 1);
  const rawBoxes: CompBox[] = [];
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const centroids = new cv.Mat();
  try {
    const count = cv.connectedComponentsWithStats(fgMask, labels, stats, centroids, 8);
    for (let label = 1; label < count; label += 1) {
      const x = stats.intAt(label, cv.CC_STAT_LEFT ?? 0);
      const y = stats.intAt(label, cv.CC_STAT_TOP ?? 1);
      const w = stats.intAt(label, cv.CC_STAT_WIDTH ?? 2);
      const h = stats.intAt(label, cv.CC_STAT_HEIGHT ?? 3);
      const area = stats.intAt(label, cv.CC_STAT_AREA ?? 4);
      if (w < 3 || h < 3 || area < 12) continue;
      if ((w * h) / imageArea > 0.92) continue;
      rawBoxes.push({ x, y, w, h, area });
    }
  } finally {
    labels.delete(); stats.delete(); centroids.delete();
  }
  if (rawBoxes.length === 0) return [];
  const gap = Math.max(4, Math.min(28, Math.round(W * 0.035)));
  const margin = Math.max(2, Math.min(8, Math.round(Math.max(W, H) * 0.012)));
  const clusters = mergeLogoComponentBoxes(rawBoxes, gap);
  const components: LogoRegionFeature[] = [];
  const seen: CompBox[] = [];
  for (const cluster of clusters) {
    const bx = Math.max(0, cluster.x - margin);
    const by = Math.max(0, cluster.y - margin);
    const bx2 = Math.min(W, cluster.x + cluster.w + margin);
    const by2 = Math.min(H, cluster.y + cluster.h + margin);
    const bw = bx2 - bx, bh = by2 - by;
    if (bw <= 0 || bh <= 0) continue;
    const areaRatio = (bw * bh) / imageArea;
    if (areaRatio < 0.015 || areaRatio > 0.86) continue;
    if (bw / Math.max(W, 1) >= 0.92 && bh / Math.max(H, 1) >= 0.75) continue;
    const boxC: CompBox = { x: bx, y: by, w: bw, h: bh, area: cluster.area };
    if (seen.some((s) => compBoxIou(s, boxC) >= 0.80)) continue;
    seen.push(boxC);
    try {
      const compCrop = cropImageData(crop, bx, by, bw, bh);
      // Trim component to content before computing descriptors (mirrors Python trim_logo_content(component))
      const trimBbox = logoContentBbox(cv, compCrop);
      const descCrop = trimBbox !== undefined && trimBbox[2] - trimBbox[0] >= 8 && trimBbox[3] - trimBbox[1] >= 8
        ? cropImageData(compCrop, trimBbox[0], trimBbox[1], trimBbox[2] - trimBbox[0], trimBbox[3] - trimBbox[1])
        : compCrop;
      const compSrc = cv.matFromImageData(descCrop);
      const compRgb = new cv.Mat();
      const compGray = new cv.Mat();
      const compHsv = new cv.Mat();
      const compEdges = new cv.Mat();
      try {
        cv.cvtColor(compSrc, compRgb, cv.COLOR_RGBA2RGB);
        cv.cvtColor(compRgb, compGray, cv.COLOR_RGB2GRAY);
        cv.cvtColor(compRgb, compHsv, cv.COLOR_RGB2HSV);
        cv.Canny(compGray, compEdges, 50, 150);
        const ps = pixelStats(compHsv, compGray, compEdges);
        const compAspect = descCrop.width / Math.max(descCrop.height, 1);
        const compRegion: LogoRegion = {
          rank: 0, score: 0, source: "component",
          x: region.x + bx, y: region.y + by, width: bw, height: bh,
          aspect: round(compAspect, 4),
          areaRatio: round(areaRatio, 6),
          foregroundRatio: round(ps.foregroundRatio, 4),
          colorPixelRatio: round(ps.colorPixelRatio, 4),
          meanSaturation: round(ps.meanSaturation, 2),
          edgeDensity: round(ps.edgeDensity, 4),
          dominantHueBin: ps.dominantHueBin,
          dominantHueFraction: ps.dominantHueFraction,
          colorGrid4x4: quantizedColorGrid(compHsv),
          edgeGrid4x4: quantizedEdgeGrid(compEdges),
          edgeDirGrid: edgeDirectionGrid(cv, compGray),
          colorHist: colorHistogram19(compHsv)
        };
        const compShapeMask = foregroundShapeMask(cv, compCrop);
        const compFeature: LogoRegionFeature = { index: components.length + 1, region: compRegion };
        if (compShapeMask !== undefined) compFeature.shapeMask = letterboxMask(compShapeMask, 96);
        components.push(compFeature);
      } finally {
        compSrc.delete(); compRgb.delete(); compGray.delete(); compHsv.delete(); compEdges.delete();
      }
    } catch {
      // Skip components that fail processing
    }
  }
  components.sort((a, b) => (b.region.areaRatio ?? 0) - (a.region.areaRatio ?? 0));
  return components.slice(0, 8);
}

function cropImageData(source: ImageData, x: number, y: number, width: number, height: number): ImageData {
  const sx = Math.max(0, Math.min(source.width - 1, Math.trunc(x)));
  const sy = Math.max(0, Math.min(source.height - 1, Math.trunc(y)));
  const sw = Math.max(1, Math.min(source.width - sx, Math.trunc(width)));
  const sh = Math.max(1, Math.min(source.height - sy, Math.trunc(height)));
  const output = new ImageData(sw, sh);
  for (let row = 0; row < sh; row += 1) {
    const srcOff = ((sy + row) * source.width + sx) * 4;
    output.data.set(source.data.subarray(srcOff, srcOff + sw * 4), row * sw * 4);
  }
  return output;
}

function quantizedColorGrid(hsv: any): string {
  const cells: string[] = [];
  const data = hsv.data as Uint8Array;
  const cols = hsv.cols as number;
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const x = Math.min(cols - 1, Math.floor((col + 0.5) * cols / 4));
      const y = Math.min(hsv.rows - 1, Math.floor((row + 0.5) * hsv.rows / 4));
      const pi = (y * cols + x) * 3;
      const h = data[pi] ?? 0;
      const s = data[pi + 1] ?? 0;
      const v = data[pi + 2] ?? 0;
      if (v < 35) cells.push("k");
      else if (s < 35) cells.push(`g${Math.min(Math.floor(v / 64), 3)}`);
      else cells.push(`h${Math.min(Math.floor(h / 12), 14)}`);
    }
  }
  return cells.join("|");
}

function quantizedEdgeGrid(edges: any): string {
  const cells: string[] = [];
  const data = edges.data as Uint8Array;
  const cols = edges.cols as number;
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const y1 = Math.floor(row * edges.rows / 4);
      const y2 = Math.floor((row + 1) * edges.rows / 4);
      const x1 = Math.floor(col * cols / 4);
      const x2 = Math.floor((col + 1) * cols / 4);
      let count = 0;
      let total = 0;
      for (let y = y1; y < y2; y += 1) {
        for (let x = x1; x < x2; x += 1) {
          if ((data[y * cols + x] ?? 0) > 0) count += 1;
          total += 1;
        }
      }
      cells.push(String(Math.min(Math.floor((count / Math.max(total, 1)) * 10), 9)));
    }
  }
  return cells.join("|");
}

// Mirrors Python edge_direction_grid: 8×8 Sobel gradient orientation grid, 4 orientation bins (0–90°).
// Each of the 256 cells is a digit 0–9 representing the dominant orientation's weight.
function edgeDirectionGrid(cv: Cv, gray: any, gridSize: number = 8, nBins: number = 4): string {
  const gradX = new cv.Mat();
  const gradY = new cv.Mat();
  try {
    cv.Sobel(gray, gradX, cv.CV_32F, 1, 0, 3);
    cv.Sobel(gray, gradY, cv.CV_32F, 0, 1, 3);
    const rows = gray.rows as number;
    const cols = gray.cols as number;
    const gxData = gradX.data32F as Float32Array;
    const gyData = gradY.data32F as Float32Array;
    const binWidth = 90.0 / nBins;
    const cells: string[] = [];
    for (let row = 0; row < gridSize; row += 1) {
      for (let col = 0; col < gridSize; col += 1) {
        const y1 = Math.trunc(row * rows / gridSize);
        const y2 = Math.trunc((row + 1) * rows / gridSize);
        const x1 = Math.trunc(col * cols / gridSize);
        const x2 = Math.trunc((col + 1) * cols / gridSize);
        const binSums = new Float64Array(nBins);
        let totalMag = 1e-6;
        for (let y = y1; y < y2; y += 1) {
          for (let x = x1; x < x2; x += 1) {
            const idx = y * cols + x;
            const gx = gxData[idx] ?? 0;
            const gy = gyData[idx] ?? 0;
            const mag = Math.sqrt(gx * gx + gy * gy);
            totalMag += mag;
            const angle = Math.atan2(Math.abs(gy), Math.abs(gx)) * (180.0 / Math.PI);
            const bin = Math.min(Math.trunc(angle / binWidth), nBins - 1);
            binSums[bin] = (binSums[bin] ?? 0) + mag;
          }
        }
        for (let b = 0; b < nBins; b += 1) {
          cells.push(String(Math.min(Math.trunc((binSums[b] ?? 0) / totalMag * 9), 9)));
        }
      }
    }
    return cells.join("|");
  } finally {
    gradX.delete();
    gradY.delete();
  }
}

// Mirrors Python build_text_mask: edge + saturation/gray ink pixels, morphological close + dilate.
// Caller is responsible for deleting the returned mat.
function buildTextMask(cv: Cv, src: any): any {
  const rgb = new cv.Mat();
  const gray = new cv.Mat();
  const hsv = new cv.Mat();
  const edges = new cv.Mat();
  const edgeMask = new cv.Mat();
  const textMask = cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.Canny(gray, edges, 45, 140);
    const dilK1 = cv.Mat.ones(2, 2, cv.CV_8U);
    try { cv.dilate(edges, edgeMask, dilK1); } finally { dilK1.delete(); }
    const grayData = gray.data as Uint8Array;
    const hsvData = hsv.data as Uint8Array;
    const edgeData = edgeMask.data as Uint8Array;
    const textData = textMask.data as Uint8Array;
    const pixelCount = src.rows * src.cols;
    for (let i = 0; i < pixelCount; i += 1) {
      if ((edgeData[i] ?? 0) > 0 && ((grayData[i] ?? 0) < 235 || (hsvData[i * 3 + 1] ?? 0) > 35)) {
        textData[i] = 255;
      }
    }
    const closeK = cv.Mat.ones(9, 3, cv.CV_8U);
    const dilK2 = cv.Mat.ones(3, 2, cv.CV_8U);
    try {
      cv.morphologyEx(textMask, textMask, cv.MORPH_CLOSE, closeK);
      cv.dilate(textMask, textMask, dilK2);
    } finally {
      closeK.delete(); dilK2.delete();
    }
    return textMask;
  } catch (err) {
    textMask.delete();
    throw err;
  } finally {
    rgb.delete(); gray.delete(); hsv.delete(); edges.delete(); edgeMask.delete();
  }
}

// Mirrors Python text_component_boxes: relaxed size thresholds vs regular componentBoxes.
function textComponentBoxes(cv: Cv, mask: any, imageWidth: number, imageHeight: number): CandidateBox[] {
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const centroids = new cv.Mat();
  const boxes: CandidateBox[] = [];
  try {
    const count = cv.connectedComponentsWithStats(mask, labels, stats, centroids, 8);
    const imageArea = Math.max(imageWidth * imageHeight, 1);
    for (let label = 1; label < count; label += 1) {
      const x = stats.intAt(label, cv.CC_STAT_LEFT ?? 0);
      const y = stats.intAt(label, cv.CC_STAT_TOP ?? 1);
      const width = stats.intAt(label, cv.CC_STAT_WIDTH ?? 2);
      const height = stats.intAt(label, cv.CC_STAT_HEIGHT ?? 3);
      const componentArea = stats.intAt(label, cv.CC_STAT_AREA ?? 4);
      if (width < 3 || height < 3 || componentArea < 6) continue;
      if (width > imageWidth * 0.55 || height > imageHeight * 0.10) continue;
      const areaRatio = (width * height) / imageArea;
      if (areaRatio > 0.035) continue;
      const aspect = width / Math.max(height, 1);
      if (aspect < 0.20 || aspect > 32.0) continue;
      const fillRatio = componentArea / Math.max(width * height, 1);
      if (fillRatio > 0.95) continue;
      boxes.push({ source: "text", x, y, width, height, componentArea });
    }
    return boxes;
  } finally {
    labels.delete(); stats.delete(); centroids.delete();
  }
}

// Mirrors Python text_close_to_box: stricter overlap thresholds than boxesNear for text attachment.
function textCloseToBox(box: CandidateBox, textBox: CandidateBox, gap: number): boolean {
  const xGap = intervalGap(box.x, box.x + box.width, textBox.x, textBox.x + textBox.width);
  const yGap = intervalGap(box.y, box.y + box.height, textBox.y, textBox.y + textBox.height);
  const xOverlap = intervalOverlap(box.x, box.x + box.width, textBox.x, textBox.x + textBox.width) / Math.max(Math.min(box.width, textBox.width), 1);
  const yOverlap = intervalOverlap(box.y, box.y + box.height, textBox.y, textBox.y + textBox.height) / Math.max(Math.min(box.height, textBox.height), 1);
  if (xGap === 0 && yGap === 0) return true;
  return (xGap <= gap && yOverlap >= 0.55) || (yGap <= Math.max(2, Math.floor(gap / 5)) && xOverlap >= 0.65);
}

function canAttachText(base: CandidateBox, textBox: CandidateBox, imageWidth: number, imageHeight: number): boolean {
  const merged = unionBox(base, textBox, imageWidth, imageHeight);
  const areaRatio = (merged.width * merged.height) / Math.max(imageWidth * imageHeight, 1);
  return areaRatio <= TEXT_ATTACH_MAX_AREA_RATIO
    && merged.width <= imageWidth * TEXT_ATTACH_MAX_WIDTH_RATIO
    && merged.height <= imageHeight * TEXT_ATTACH_MAX_HEIGHT_RATIO;
}

// Mirrors Python attach_nearby_text: original box is tested for proximity, growing box for size limits.
function attachNearbyText(boxes: CandidateBox[], textBoxes: CandidateBox[], gap: number, imageWidth: number, imageHeight: number): CandidateBox[] {
  return boxes.map((box) => {
    let current = box;
    for (const textBox of textBoxes) {
      if (textCloseToBox(box, textBox, gap) && canAttachText(current, textBox, imageWidth, imageHeight)) {
        current = unionBox(current, textBox, imageWidth, imageHeight);
      }
    }
    return current;
  });
}

// Mirrors Python edge_detail_runs: finds column runs of high edge density within a gray crop.
function edgeDetailRuns(cv: Cv, gray: any): Array<[number, number]> {
  const edges = new cv.Mat();
  try {
    cv.Canny(gray, edges, 50, 150);
    const cols = gray.cols as number;
    const rows = gray.rows as number;
    if (cols < 16) return [];
    const edgeData = edges.data as Uint8Array;
    const colDensity = new Float32Array(cols);
    for (let x = 0; x < cols; x += 1) {
      let count = 0;
      for (let y = 0; y < rows; y += 1) {
        if ((edgeData[y * cols + x] ?? 0) > 0) count += 1;
      }
      colDensity[x] = count;
    }
    let hasNonZero = false;
    for (let x = 0; x < cols; x += 1) {
      if ((colDensity[x] ?? 0) > 0) { hasNonZero = true; break; }
    }
    if (!hasNonZero) return [];
    // np.convolve mode="same": zero-pad boundaries, always divide by 9
    const smoothed = new Float32Array(cols);
    for (let x = 0; x < cols; x += 1) {
      let sum = 0;
      for (let dx = -4; dx <= 4; dx += 1) {
        const idx = x + dx;
        if (idx >= 0 && idx < cols) sum += colDensity[idx] ?? 0;
      }
      smoothed[x] = sum / 9.0;
    }
    const sorted = Float32Array.from(smoothed).sort();
    const threshold = Math.max(1.0, sorted[Math.trunc(cols * 0.75)] ?? 1.0);
    const active: number[] = [];
    for (let x = 0; x < cols; x += 1) {
      if ((smoothed[x] ?? 0) > threshold) active.push(x);
    }
    if (active.length === 0) return [];
    const runs: Array<[number, number]> = [];
    let start = active[0] ?? 0;
    let prev = active[0] ?? 0;
    for (let i = 1; i < active.length; i += 1) {
      const val = active[i] ?? 0;
      if (val - prev > 8) { runs.push([start, prev]); start = val; }
      prev = val;
    }
    runs.push([start, prev]);
    return runs;
  } finally {
    edges.delete();
  }
}

// Mirrors Python split_large_detail_bands: splits wide flat-color bands into detail sub-boxes.
function splitLargeDetailBands(cv: Cv, src: any, boxes: CandidateBox[]): CandidateBox[] {
  const imageW = src.cols as number;
  const imageH = src.rows as number;
  const detailBoxes: CandidateBox[] = [];
  for (const box of boxes) {
    if (!box.source.split("+").includes("color")) continue;
    if (box.width < imageW * 0.35 || box.height > imageH * 0.18) continue;
    const cropRect = new cv.Rect(box.x, box.y, box.width, box.height);
    const crop = src.roi(cropRect);
    const rgb = new cv.Mat();
    const gray = new cv.Mat();
    const hsv = new cv.Mat();
    const edges = new cv.Mat();
    try {
      cv.cvtColor(crop, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      cv.Canny(gray, edges, 50, 150);
      const total = crop.rows * crop.cols;
      if (total === 0) continue;
      const hsvData = hsv.data as Uint8Array;
      const edgeData = edges.data as Uint8Array;
      let colorPixels = 0;
      let edgePixels = 0;
      for (let i = 0; i < total; i += 1) {
        if ((hsvData[i * 3 + 1] ?? 0) > 45 && (hsvData[i * 3 + 2] ?? 0) > 45) colorPixels += 1;
        if ((edgeData[i] ?? 0) > 0) edgePixels += 1;
      }
      if (colorPixels / total < 0.48 || edgePixels / total > 0.085) continue;
      const runs = edgeDetailRuns(cv, gray);
      for (const [start, end] of runs) {
        const width = end - start + 1;
        if (width < Math.max(16, Math.trunc(imageW * 0.025)) || width > imageW * 0.22) continue;
        detailBoxes.push(clampBox({
          source: mergeSources(box.source, "detail"),
          x: box.x + start,
          y: box.y,
          width,
          height: box.height,
          componentArea: box.componentArea
        }, imageW, imageH));
      }
    } finally {
      crop.delete(); rgb.delete(); gray.delete(); hsv.delete(); edges.delete();
    }
  }
  return detailBoxes;
}

// Mirrors Python header-zone fallback: adds text-mask components from the top 12% of the page.
function addHeaderZoneFallback(cv: Cv, boxes: CandidateBox[], textMask: any, mergeGap: number, imageWidth: number, imageHeight: number): CandidateBox[] {
  const headerH = Math.trunc(imageHeight * 0.12);
  const rawHdr = componentBoxes(cv, textMask, "text", imageWidth, imageHeight)
    .filter((b) => b.y + b.height / 2 < headerH);
  const hdrMerged = mergeNearbyBoxes(rawHdr, Math.max(2, Math.floor(mergeGap / 2)), imageWidth, imageHeight);
  const hdrCands = hdrMerged.filter(
    (b) => b.width >= imageWidth * 0.03
      && b.width < imageWidth * 0.35
      && boxes.every((r) => regionIou(boxToRegion(b), boxToRegion(r)) < 0.25)
  );
  return [...boxes, ...hdrCands];
}

// Mirrors Python full-width header-band fallback: horizontal edge-density runs within wide color bands.
function addHeaderBandFallback(cv: Cv, src: any, boxes: CandidateBox[], combinedMask: any, imageWidth: number, imageHeight: number): CandidateBox[] {
  if (combinedMask === undefined || combinedMask === null) return boxes;
  const iW = imageWidth;
  const iH = imageHeight;
  const bandZoneH = Math.trunc(iH * 0.18);
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const centroids = new cv.Mat();
  let result = [...boxes];
  try {
    const count = cv.connectedComponentsWithStats(combinedMask, labels, stats, centroids, 8);
    for (let i = 1; i < count; i += 1) {
      const by = stats.intAt(i, cv.CC_STAT_TOP ?? 1);
      const bw = stats.intAt(i, cv.CC_STAT_WIDTH ?? 2);
      const bh = stats.intAt(i, cv.CC_STAT_HEIGHT ?? 3);
      if (bw < iW * 0.65 || by > bandZoneH || bh > iH * 0.22 || by + bh > iH) continue;
      const bandRect = new cv.Rect(0, by, iW, bh);
      const bandCrop = src.roi(bandRect);
      const bandRgb = new cv.Mat();
      const bandGray = new cv.Mat();
      const bandEdges = new cv.Mat();
      try {
        cv.cvtColor(bandCrop, bandRgb, cv.COLOR_RGBA2RGB);
        cv.cvtColor(bandRgb, bandGray, cv.COLOR_RGB2GRAY);
        cv.Canny(bandGray, bandEdges, 50, 150);
        const edgeData = bandEdges.data as Uint8Array;
        const colProfile = new Float32Array(iW);
        for (let x = 0; x < iW; x += 1) {
          let sum = 0;
          for (let y = 0; y < bh; y += 1) {
            if ((edgeData[y * iW + x] ?? 0) > 0) sum += 1;
          }
          colProfile[x] = sum;
        }
        const smoothK = Math.max(8, Math.trunc(iW * 0.025));
        const halfK = Math.floor(smoothK / 2);
        const colSmooth = new Float32Array(iW);
        for (let x = 0; x < iW; x += 1) {
          let s = 0;
          for (let dx = -halfK; dx <= halfK; dx += 1) {
            const idx = x + dx;
            if (idx >= 0 && idx < iW) s += colProfile[idx] ?? 0;
          }
          colSmooth[x] = s / smoothK;
        }
        let peak = 0;
        for (let x = 0; x < iW; x += 1) peak = Math.max(peak, colSmooth[x] ?? 0);
        if (peak < 1) continue;
        const sortedSmooth = Float32Array.from(colSmooth).sort();
        const baseline = sortedSmooth[Math.trunc(iW / 2)] ?? 0;
        const threshold = baseline + (peak - baseline) * 0.50;
        const active = new Uint8Array(iW);
        for (let x = 0; x < iW; x += 1) {
          if ((colSmooth[x] ?? 0) > threshold) active[x] = 1;
        }
        // 1D dilation — mirrors cv2.dilate(active.reshape(1,-1), ones((1,smooth_k)))[0]
        const dilated = new Uint8Array(iW);
        for (let x = 0; x < iW; x += 1) {
          if (active[x] === 1) {
            for (let dx = -halfK; dx <= halfK; dx += 1) {
              const idx = x + dx;
              if (idx >= 0 && idx < iW) dilated[idx] = 1;
            }
          }
        }
        const runs: Array<[number, number]> = [];
        let inRun = false;
        let runStart = 0;
        for (let x = 0; x < iW; x += 1) {
          const a = dilated[x] ?? 0;
          if (a && !inRun) { runStart = x; inRun = true; }
          else if (!a && inRun) { runs.push([runStart, x]); inRun = false; }
        }
        if (inRun) runs.push([runStart, iW]);
        for (const [s, e] of runs) {
          const w = e - s;
          if (w < iW * 0.03 || w > iW * 0.45) continue;
          const pad = Math.max(4, Math.trunc(bh / 4));
          const xs = Math.max(0, s - pad);
          const xe = Math.min(iW, e + pad);
          const cand: CandidateBox = { source: "header_band", x: xs, y: by, width: xe - xs, height: bh, componentArea: 0 };
          if (result.every((r) => regionIou(boxToRegion(cand), boxToRegion(r)) < 0.25)) {
            result = [...result, cand];
          }
        }
      } finally {
        bandCrop.delete(); bandRgb.delete(); bandGray.delete(); bandEdges.delete();
      }
    }
  } finally {
    labels.delete(); stats.delete(); centroids.delete();
  }
  return result;
}

function colorHistogram19(hsv: any): number[] {
  const hist = new Array<number>(19).fill(0);
  const data = hsv.data as Uint8Array;
  const total_pixels = hsv.rows * hsv.cols;
  for (let i = 0; i < total_pixels; i += 1) {
    const pi = i * 3;
    const h = data[pi] ?? 0;
    const s = data[pi + 1] ?? 0;
    const v = data[pi + 2] ?? 0;
    if (v < 40) hist[0] = (hist[0] ?? 0) + 1;
    else if (v >= 200 && s < 30) hist[2] = (hist[2] ?? 0) + 1;
    else if (s < 35) hist[1] = (hist[1] ?? 0) + 1;
    else {
      const histIndex = 3 + Math.min(Math.floor(h / 180 * 16), 15);
      hist[histIndex] = (hist[histIndex] ?? 0) + 1;
    }
  }
  const total = hist.reduce((sum, value) => sum + value, 0);
  return total > 0 ? hist.map((value) => value / total) : hist;
}

function mergeNearbyBoxes(boxes: CandidateBox[], gap: number, imageWidth: number, imageHeight: number): CandidateBox[] {
  const pending = boxes.map((box) => clampBox(box, imageWidth, imageHeight));
  const merged: CandidateBox[] = [];
  while (pending.length > 0) {
    let current = pending.shift() as CandidateBox;
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const box = pending[index] as CandidateBox;
        if (boxesNear(current, box, gap)) {
          current = unionBox(current, box, imageWidth, imageHeight);
          pending.splice(index, 1);
          changed = true;
        }
      }
    }
    merged.push(current);
  }
  return merged;
}

function mergeOverlappingBoxes(boxes: CandidateBox[], imageWidth: number, imageHeight: number): CandidateBox[] {
  const output: CandidateBox[] = [];
  for (const box of boxes) {
    let merged = false;
    for (let index = 0; index < output.length; index += 1) {
      if (regionIou(boxToRegion(box), boxToRegion(output[index] as CandidateBox)) > 0.0) {
        output[index] = unionBox(output[index] as CandidateBox, box, imageWidth, imageHeight);
        merged = true;
        break;
      }
    }
    if (!merged) output.push(box);
  }
  return output;
}

function boxesNear(a: CandidateBox, b: CandidateBox, gap: number): boolean {
  const xGap = intervalGap(a.x, a.x + a.width, b.x, b.x + b.width);
  const yGap = intervalGap(a.y, a.y + a.height, b.y, b.y + b.height);
  const xOverlap = intervalOverlap(a.x, a.x + a.width, b.x, b.x + b.width) / Math.max(Math.min(a.width, b.width), 1);
  const yOverlap = intervalOverlap(a.y, a.y + a.height, b.y, b.y + b.height) / Math.max(Math.min(a.height, b.height), 1);
  if (xGap === 0 && yGap === 0) return true;
  return (xGap <= gap && yOverlap >= 0.35) || (yGap <= Math.max(2, Math.floor(gap / 3)) && xOverlap >= 0.55);
}

function unionBox(a: CandidateBox, b: CandidateBox, imageWidth: number, imageHeight: number): CandidateBox {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width);
  const y2 = Math.max(a.y + a.height, b.y + b.height);
  return clampBox({ source: mergeSources(a.source, b.source), x: x1, y: y1, width: x2 - x1, height: y2 - y1, componentArea: a.componentArea + b.componentArea }, imageWidth, imageHeight);
}

function clampBox(box: CandidateBox, imageWidth: number, imageHeight: number): CandidateBox {
  const x1 = Math.max(0, Math.min(imageWidth, Math.trunc(box.x)));
  const y1 = Math.max(0, Math.min(imageHeight, Math.trunc(box.y)));
  const x2 = Math.max(x1 + 1, Math.min(imageWidth, Math.trunc(box.x + box.width)));
  const y2 = Math.max(y1 + 1, Math.min(imageHeight, Math.trunc(box.y + box.height)));
  return { ...box, x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function expandBox(box: CandidateBox, margin: number, imageWidth: number, imageHeight: number): CandidateBox {
  return clampBox({ ...box, x: box.x - margin, y: box.y - margin, width: box.width + 2 * margin, height: box.height + 2 * margin }, imageWidth, imageHeight);
}

function regionIou(a: Pick<LogoRegion, "x" | "y" | "width" | "height">, b: Pick<LogoRegion, "x" | "y" | "width" | "height">): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0.0;
}

function boxToRegion(box: CandidateBox): LogoRegion {
  return { rank: 0, score: 0, source: box.source, x: box.x, y: box.y, width: box.width, height: box.height };
}

function isBroadPageBand(box: CandidateBox, imageWidth: number, imageHeight: number): boolean {
  const areaRatio = (box.width * box.height) / Math.max(imageWidth * imageHeight, 1);
  const widthRatio = box.width / Math.max(imageWidth, 1);
  return areaRatio > 0.055 && widthRatio > 0.40;
}

function mergeSources(...sources: string[]): string {
  const priority = new Map([["color", 0], ["combined", 1], ["bright", 2], ["ink", 3], ["text", 4]]);
  return [...new Set(sources.flatMap((source) => source.split("+").filter(Boolean)))]
    .sort((a, b) => (priority.get(a) ?? 99) - (priority.get(b) ?? 99) || a.localeCompare(b))
    .join("+");
}

function processingGap(width: number, height: number, ratio: number, minPx: number, maxPx: number): number {
  return Math.max(minPx, Math.min(maxPx, Math.round(Math.max(width, height) * ratio)));
}

function intervalOverlap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function intervalGap(startA: number, endA: number, startB: number, endB: number): number {
  if (endA < startB) return startB - endA;
  if (endB < startA) return startA - endB;
  return 0;
}

function scoreSize(areaRatio: number): number {
  if (areaRatio <= 0) return 0.0;
  return Math.max(0.0, Math.min(Math.exp(-Math.abs(Math.log(areaRatio) - Math.log(0.006)) / 1.25), 1.0));
}

function scoreAspect(aspect: number): number {
  if (0.75 <= aspect && aspect <= 8.0) return 1.0;
  if (0.35 <= aspect && aspect < 0.75) return 0.6;
  if (8.0 < aspect && aspect <= 14.0) return 0.65;
  return 0.25;
}

function scorePosition(yRatio: number, hRatio: number): number {
  const centerY = yRatio + hRatio / 2.0;
  if (centerY <= 0.65) return 1.0;
  if (centerY <= 0.82) return 0.65;
  return 0.25;
}

function sourceBonusValue(source: string): number {
  const bonuses: Record<string, number> = { color: 0.12, combined: 0.06, ink: 0.0, bright: 0.06, text: 0.0, detail: 0.04, header_band: 0.15 };
  const values = source.split("+").map((part) => bonuses[part] ?? 0.0);
  return Math.max(...values, 0.0);
}

function borderMedianRgb(imageData: ImageData): [number, number, number] {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const push = (x: number, y: number) => {
    const i = (y * imageData.width + x) * 4;
    rs.push(imageData.data[i] ?? 0);
    gs.push(imageData.data[i + 1] ?? 0);
    bs.push(imageData.data[i + 2] ?? 0);
  };
  for (let x = 0; x < imageData.width; x += 1) { push(x, 0); push(x, imageData.height - 1); }
  for (let y = 0; y < imageData.height; y += 1) { push(0, y); push(imageData.width - 1, y); }
  return [median(rs), median(gs), median(bs)];
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 30;
    if (h < 0) h += 180;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s: s * 255, v: max * 255 };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[mid] ?? 0 : ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
