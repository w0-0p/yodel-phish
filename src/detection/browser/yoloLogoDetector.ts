// YOLO logo detector for the browser pipeline.
//
// Mirrors the Python pipeline's _yolo_letterbox / _yolo_nms / _yolo_detect
// functions exactly:
//   - letterbox the full-resolution image into a 640×640 canvas (gray fill 114)
//   - run ONNX inference (output shape [1, 5, n_preds])
//   - decode boxes, filter by confidence, apply greedy NMS
//   - return boxes in original-image pixel coordinates
//
// Only the ONNX path is supported in the browser (no Ultralytics .pt).

export interface YoloBox {
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

const YOLO_LOGO_CONF_DEFAULT = 0.25;
const YOLO_NMS_IOU_THRESH = 0.45;
const YOLO_LETTERBOX_SIZE = 640;

let ortModule: any = undefined;

async function getOrt(): Promise<any> {
  if (ortModule !== undefined) return ortModule;
  const mod = await import(/* webpackMode: "eager" */ "onnxruntime-web");
  ortModule = (mod as any).default ?? mod;
  return ortModule;
}

export class YoloLogoDetector {
  private sessionPromise: Promise<any> | undefined;

  constructor(
    private readonly modelUrl: string,
    private readonly conf: number = YOLO_LOGO_CONF_DEFAULT
  ) {}

  // `minConfidence` overrides the detection cutoff for one call; the
  // add-to-trusted candidate proposal (issue #90) asks for everything a human
  // could still recognise instead of what the pipeline would act on alone.
  async detect(imageData: ImageData, minConfidence: number = this.conf): Promise<YoloBox[]> {
    let session: any;
    try {
      session = await this.getSession();
    } catch {
      return [];
    }
    const ort = await getOrt();
    const inputName: string = session.inputNames[0] ?? "images";

    // Letterbox the original image into [1, 3, imgsz, imgsz] CHW float32 [0,1]
    const imgsz = YOLO_LETTERBOX_SIZE;
    const { data, scale, padTop, padLeft } = letterboxImageData(imageData, imgsz);
    const origW = imageData.width;
    const origH = imageData.height;

    const tensor = new ort.Tensor("float32", data, [1, 3, imgsz, imgsz]);
    const results = await session.run({ [inputName]: tensor });
    const outputKey: string = session.outputNames[0] ?? Object.keys(results)[0];
    const outputTensor = results[outputKey];
    const raw = outputTensor?.data as Float32Array | undefined;
    if (raw === undefined || raw.length === 0) return [];

    // Output shape: [1, 5, n_preds] — flat in row-major order.
    // dims[2] gives n_preds directly; fall back to raw.length / 5.
    const dims: number[] | undefined = outputTensor?.dims;
    const nPreds = (dims !== undefined && dims.length >= 3 && (dims[2] ?? 0) > 0)
      ? dims[2] as number
      : Math.trunc(raw.length / 5);

    // Decode: channel layout is [x_c, y_c, bw, bh, score] × n_preds
    const boxes: YoloBox[] = [];
    for (let i = 0; i < nPreds; i += 1) {
      const xC = raw[i] ?? 0;
      const yC = raw[nPreds + i] ?? 0;
      const bw = raw[2 * nPreds + i] ?? 0;
      const bh = raw[3 * nPreds + i] ?? 0;
      const score = raw[4 * nPreds + i] ?? 0;
      if (score < minConfidence) continue;

      // Unpad and unscale back to original-image pixel coords
      const xCPx = (xC - padLeft) / scale;
      const yCPx = (yC - padTop) / scale;
      const bwPx = bw / scale;
      const bhPx = bh / scale;
      const x1 = Math.max(0, Math.trunc(xCPx - bwPx / 2));
      const y1 = Math.max(0, Math.trunc(yCPx - bhPx / 2));
      const x2 = Math.min(origW, Math.trunc(xCPx + bwPx / 2));
      const y2 = Math.min(origH, Math.trunc(yCPx + bhPx / 2));
      if (x2 > x1 && y2 > y1) {
        boxes.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, conf: Math.round(score * 1000) / 1000 });
      }
    }

    return yoloNms(boxes, YOLO_NMS_IOU_THRESH);
  }

  private getSession(): Promise<any> {
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
      throw new Error(`YOLO model fetch failed: ${response.status} ${this.modelUrl}`);
    }
    const modelBuffer = await response.arrayBuffer();
    return ort.InferenceSession.create(modelBuffer, { executionProviders: ["wasm"] });
  }
}

// Mirrors Python _yolo_letterbox:
//   scale = size / max(h, w)
//   pad centred with gray fill (114)
// Returns CHW Float32Array normalised to [0, 1].
function letterboxImageData(
  imageData: ImageData,
  size: number
): { data: Float32Array; scale: number; padTop: number; padLeft: number } {
  const origW = imageData.width;
  const origH = imageData.height;
  const scale = size / Math.max(origW, origH);
  const nw = Math.max(1, Math.trunc(origW * scale));
  const nh = Math.max(1, Math.trunc(origH * scale));
  const padLeft = Math.trunc((size - nw) / 2);
  const padTop = Math.trunc((size - nh) / 2);

  const srcCanvas = new OffscreenCanvas(origW, origH);
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
  if (srcCtx === null) throw new Error("2D context unavailable");
  srcCtx.putImageData(imageData, 0, 0);

  const dstCanvas = new OffscreenCanvas(size, size);
  const dstCtx = dstCanvas.getContext("2d", { willReadFrequently: true });
  if (dstCtx === null) throw new Error("2D context unavailable");
  dstCtx.fillStyle = "rgb(114,114,114)";
  dstCtx.fillRect(0, 0, size, size);
  dstCtx.drawImage(srcCanvas, 0, 0, origW, origH, padLeft, padTop, nw, nh);

  const pixels = dstCtx.getImageData(0, 0, size, size).data;
  const n = size * size;
  const float32 = new Float32Array(3 * n);
  for (let i = 0; i < n; i += 1) {
    const p = i * 4;
    float32[i] = (pixels[p] ?? 0) / 255.0;
    float32[n + i] = (pixels[p + 1] ?? 0) / 255.0;
    float32[2 * n + i] = (pixels[p + 2] ?? 0) / 255.0;
  }
  return { data: float32, scale, padTop, padLeft };
}

// Mirrors Python _yolo_nms: greedy NMS sorted by confidence descending.
function yoloNms(boxes: YoloBox[], iouThresh: number): YoloBox[] {
  if (boxes.length === 0) return [];
  const order = [...boxes.keys()].sort((a, b) => (boxes[b]?.conf ?? 0) - (boxes[a]?.conf ?? 0));
  const keep: number[] = [];
  while (order.length > 0) {
    const i = order.shift() as number;
    keep.push(i);
    const b = boxes[i] as YoloBox;
    let j = 0;
    while (j < order.length) {
      const o = boxes[order[j] as number] as YoloBox;
      const inter =
        Math.max(0, Math.min(b.x + b.w, o.x + o.w) - Math.max(b.x, o.x)) *
        Math.max(0, Math.min(b.y + b.h, o.y + o.h) - Math.max(b.y, o.y));
      const union = b.w * b.h + o.w * o.h - inter;
      if (inter / Math.max(union, 1) >= iouThresh) {
        order.splice(j, 1);
      } else {
        j += 1;
      }
    }
  }
  return keep.map((i) => boxes[i] as YoloBox);
}
