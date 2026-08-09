/**
 * Standalone DINOv2 browser test — real HTTP server, no Playwright routing.
 *
 * A single Node.js HTTP server serves the test page, the model, the ORT WASM
 * files, and the validation bundle. Playwright (or any browser) navigates to it
 * as a normal URL. The ~88 MB model response flows through the real network
 * stack — no CDP body-size limit, no Private Network Access issues.
 *
 * Usage (from Extension/):
 *   npm run test:integration:dino
 *
 * Add --headed to open a visible browser window instead of headless.
 */

import { chromium } from "../../Extension/node_modules/playwright/index.mjs";
import { existsSync, statSync, createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "../..");
const headed = process.argv.includes("--headed");
const modelArgument = process.argv.slice(2).find((value) => value !== "--headed");
const dinoModelPath = modelArgument ?? path.join(projectDir, "Models/downloads/dinov2_vits14.onnx");
const EMBEDDING_DIMENSION = 384;

if (!existsSync(dinoModelPath)) {
  console.error("Model not found:", dinoModelPath);
  console.error("Run npm run models:download first, or pass a model path followed by --headed if desired.");
  process.exit(1);
}

const configPath = modelArgument === undefined
  ? path.join(projectDir, "Models/dinov2_vits14_config.json")
  : dinoModelPath.replace(/\.onnx$/i, "_config.json");
if (!existsSync(configPath)) {
  console.error("DINOv2 config not found:", configPath);
  process.exit(1);
}

let dinoConfig;
try {
  dinoConfig = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  console.error("DINOv2 config could not be parsed:", configPath, error.message);
  process.exit(1);
}

const distDir = path.join(projectDir, "build/test-runtime");
const ortDistDir = path.join(projectDir, "Extension/node_modules/onnxruntime-web/dist");
const opencvScriptPath = path.join(projectDir, "Extension/node_modules/@techstark/opencv-js/dist/opencv.js");
const modelFileSize = statSync(dinoModelPath).size;
console.log(`Model: ${dinoModelPath} (${(modelFileSize / 1024 / 1024).toFixed(1)} MB)`);
console.log(`Config: ${JSON.stringify(dinoConfig)}`);

// Single HTTP server — serves everything at the same origin so all fetches are
// same-origin (no CORS, no PNA). The model streams via real HTTP rather than
// going through a CDP message, so there is no body-size limit.
const server = createServer(async (req, res) => {
  const url = req.url ?? "/";

  if (url === "/" || url === "/test") {
    // COOP + COEP required for SharedArrayBuffer (threaded ORT WASM).
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html><head>
<script>
  // Globals the validation runtime reads on startup.
  globalThis.__YODEL_DINOV2_MODEL_URL__ = "/dinov2-model.onnx";
  globalThis.__YODEL_DINOV2_CONFIG__    = ${JSON.stringify(dinoConfig)};
</script>
</head><body></body></html>`);
    return;
  }

  if (url === "/dinov2-model.onnx") {
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", modelFileSize);
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    createReadStream(dinoModelPath).pipe(res);
    return;
  }

  // Serve dist assets and ORT WASM by filename (no path matching needed).
  const filename = path.basename(url);
  for (const dir of [distDir, ortDistDir]) {
    const filepath = path.join(dir, filename);
    if (existsSync(filepath)) {
      const ct = filename.endsWith(".wasm") ? "application/wasm" : "application/javascript";
      res.setHeader("Content-Type", ct);
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      createReadStream(filepath).pipe(res);
      return;
    }
  }

  res.writeHead(404).end(`Not found: ${url}`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const base = `http://localhost:${port}`;
console.log(`Test server: ${base}/test`);

const browser = await chromium.launch({ headless: !headed, args: ["--renderer-process-memory-limit=4096"] });
const page = await browser.newPage();
let crashed = false;

page.on("console", (msg) => {
  const text = msg.text();
  if (text.length > 0) console.log(`[browser:${msg.type()}]`, text);
});
page.on("pageerror", (err) => console.error("[browser:pageerror]", err.message));
page.on("crash", () => {
  crashed = true;
  console.error("[browser:CRASH] Renderer crashed — check: dmesg | tail -20");
});

await page.goto(`${base}/test`);
console.log(
  "crossOriginIsolated:", await page.evaluate(() => globalThis.crossOriginIsolated),
  " SharedArrayBuffer:", await page.evaluate(() => typeof SharedArrayBuffer !== "undefined")
);

// OpenCV must be inline (addScriptTag path) — it doesn't affect publicPath detection.
console.log("Loading OpenCV.js...");
await page.addScriptTag({ path: opencvScriptPath });
await page.waitForFunction(() => globalThis.cv?.Mat !== undefined, undefined, { timeout: 120_000 });
console.log("OpenCV ready.");

// Bundle loaded via URL so document.currentScript.src is set — webpack 'auto'
// publicPath uses it to resolve ORT worker and WASM asset URLs correctly.
console.log("Loading validation runtime...");
await page.addScriptTag({ url: `${base}/browser-validation-runtime.js` });
await page.waitForFunction(() => globalThis.__YODEL_VALIDATION_SERVICES__ !== undefined, undefined, { timeout: 30_000 });
console.log("Runtime ready.");

page.setDefaultTimeout(300_000);

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  OK   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail !== undefined ? " — " + detail : ""}`);
  }
}

// Build a set of synthetic test crops directly in the browser (canvas), covering
// wide, tall, square, small, monochrome, and transparent inputs, plus one region
// with invalid coordinates to exercise per-crop failure handling.
console.log("\n── Test: DINOv2 embedLogoCrops shapes/session/output-contract ──");
const t0 = Date.now();
try {
  const result = await page.evaluate(async () => {
    function makeImage(width, height, draw) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      draw(ctx, width, height);
      return canvas.convertToBlob({ type: "image/png" });
    }

    async function toDataUrl(blobPromise) {
      const blob = await blobPromise;
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }

    const shapes = {
      wide: { width: 300, height: 60, draw: (ctx, w, h) => {
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, "#ff0000");
        grad.addColorStop(1, "#0000ff");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      } },
      tall: { width: 60, height: 300, draw: (ctx, w, h) => {
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, "#00ff00");
        grad.addColorStop(1, "#ffff00");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      } },
      square: { width: 150, height: 150, draw: (ctx, w, h) => {
        ctx.fillStyle = "#222222";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#ff8800";
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, w / 3, 0, Math.PI * 2);
        ctx.fill();
      } },
      small: { width: 5, height: 5, draw: (ctx, w, h) => {
        ctx.fillStyle = "#123456";
        ctx.fillRect(0, 0, w, h);
      } },
      monochrome: { width: 150, height: 150, draw: (ctx, w, h) => {
        ctx.fillStyle = "#808080";
        ctx.fillRect(0, 0, w, h);
      } },
      transparent: { width: 150, height: 150, draw: (ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "rgba(50, 120, 200, 0.6)";
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, w / 4, 0, Math.PI * 2);
        ctx.fill();
      } }
    };

    const dataUrls = {};
    for (const [name, spec] of Object.entries(shapes)) {
      dataUrls[name] = await toDataUrl(makeImage(spec.width, spec.height, spec.draw));
    }

    const svc = globalThis.__YODEL_VALIDATION_SERVICES__;

    const shapeResults = {};
    for (const [name, spec] of Object.entries(shapes)) {
      const image = { id: `shape-${name}`, source: "test", dataUrl: dataUrls[name] };
      const region = { rank: 0, score: 1.0, source: "test", x: 0, y: 0, width: spec.width, height: spec.height };
      const [embedding] = await svc.embedLogoCrops(image, [region]);
      shapeResults[name] = embedding ?? [];
    }

    // Identical-input similarity: embed the same square crop twice in one call.
    const squareImage = { id: "shape-square", source: "test", dataUrl: dataUrls.square };
    const squareRegion = { rank: 0, score: 1.0, source: "test", x: 0, y: 0, width: 150, height: 150 };
    const [dupA, dupB] = await svc.embedLogoCrops(squareImage, [squareRegion, squareRegion]);

    // Failure-handling / index-alignment: middle region has NaN coordinates and
    // must fail without shifting the embedding for the region after it.
    const badRegion = { rank: 0, score: 1.0, source: "test", x: NaN, y: NaN, width: NaN, height: NaN };
    const monoImage = { id: "shape-monochrome", source: "test", dataUrl: dataUrls.monochrome };
    const alignment = await svc.embedLogoCrops(monoImage, [squareRegion, badRegion, squareRegion]);

    return {
      shapeResults,
      dup: { a: dupA, b: dupB },
      alignment
    };
  });

  const dim = dinoConfig.embeddingDimension ?? EMBEDDING_DIMENSION;

  console.log("\nShape/session/output-contract checks:");
  for (const [name, embedding] of Object.entries(result.shapeResults)) {
    check(`${name}: produced one ${dim}-value descriptor`, Array.isArray(embedding) && embedding.length === dim, `got length ${embedding.length}`);
    const finite = embedding.every((v) => Number.isFinite(v));
    check(`${name}: all values finite`, finite);
    if (embedding.length === dim) {
      const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
      check(`${name}: L2-normalized (norm≈1)`, Math.abs(norm - 1) < 1e-3, `norm=${norm}`);
    }
  }

  console.log("\nIdentical-input similarity check:");
  const dot = result.dup.a.reduce((s, v, i) => s + v * (result.dup.b[i] ?? 0), 0);
  check("identical crops → cosine ≈ 1.0", dot > 0.999, `dot=${dot}`);

  console.log("\nVaried-crop non-collapse check:");
  const squareEmb = result.shapeResults.square;
  const monoEmb = result.shapeResults.monochrome;
  const crossDot = squareEmb.reduce((s, v, i) => s + v * (monoEmb[i] ?? 0), 0);
  check("visually different crops do not collapse to ≈identical descriptors", crossDot < 0.999, `dot=${crossDot}`);

  console.log("\nFailure-handling / index-alignment check:");
  check("alignment array has one entry per region", result.alignment.length === 3, `got length ${result.alignment.length}`);
  check("region 1 (valid) embedded", result.alignment[0]?.length === dim);
  check("region 2 (invalid coords) failed without embedding", (result.alignment[1]?.length ?? -1) === 0);
  check("region 3 (valid, after the failure) still embedded at its own index", result.alignment[2]?.length === dim);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} in ${Date.now() - t0} ms`);
} catch (err) {
  failures += 1;
  if (crashed) {
    console.error(`FAILED after ${Date.now() - t0} ms: page CRASHED — check dmesg | tail -20`);
  } else {
    console.error(`FAILED after ${Date.now() - t0} ms:`, err.message);
  }
}

await browser.close().catch(() => {});
server.close();
process.exit(failures === 0 ? 0 : 1);
