import assert from "node:assert/strict";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../Extension/node_modules/playwright/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");
const extensionRoot = path.join(projectRoot, "build", "extension");
const workerPath = path.join(extensionRoot, "dist", "inference_worker.js");

if (!existsSync(workerPath)) {
  throw new Error("Built inference Worker is missing; run the extension build first");
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript"],
  [".mjs", "application/javascript"],
  [".json", "application/json"],
  [".wasm", "application/wasm"],
  [".onnx", "application/octet-stream"],
  [".traineddata", "application/octet-stream"],
]);

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (pathname === "/") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><html><body></body></html>");
    return;
  }

  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const filePath = path.resolve(extensionRoot, relative);
  if (!filePath.startsWith(extensionRoot + path.sep) || !existsSync(filePath)) {
    response.writeHead(404).end("Not found");
    return;
  }
  response.setHeader("Content-Type", contentTypes.get(path.extname(filePath)) ?? "application/octet-stream");
  response.setHeader("Content-Length", statSync(filePath).size);
  createReadStream(filePath).pipe(response);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  page.on("console", (message) => console.log(`[inference-worker:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[inference-worker:pageerror] ${error.message}`));
  page.setDefaultTimeout(120_000);
  await page.goto(baseUrl);

  const result = await page.evaluate(async () => {
    const worker = new Worker("/dist/inference_worker.js");
    let nextRequestId = 1;
    const pending = new Map();
    worker.addEventListener("message", (event) => {
      const request = pending.get(event.data?.requestId);
      if (request === undefined) return;
      pending.delete(event.data.requestId);
      if (event.data.ok === true) request.resolve(event.data.result);
      else request.reject(new Error(event.data.error ?? event.data.code ?? "worker request failed"));
    });
    worker.addEventListener("error", (event) => {
      for (const request of pending.values()) request.reject(new Error(event.message));
      pending.clear();
    });
    const send = (payload) => new Promise((resolve, reject) => {
      const requestId = nextRequestId;
      nextRequestId += 1;
      pending.set(requestId, { resolve, reject });
      worker.postMessage({ requestId, ...payload });
    });

    await send({ type: "ping" });
    const canvas = new OffscreenCanvas(640, 360);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#1976d2";
    context.fillRect(40, 30, 180, 70);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result)));
      reader.addEventListener("error", () => reject(reader.error));
      reader.readAsDataURL(blob);
    });
    const candidates = await send({
      type: "run",
      message: {
        type: "propose_trusted_add_candidates",
        screenshot: { id: "worker-smoke", source: "browser-screenshot", dataUrl },
      },
    });
    const manual = await send({
      type: "run",
      message: {
        type: "preprocess_trusted_region",
        screenshot: { id: "worker-smoke", source: "browser-screenshot", dataUrl },
        normalizedRect: { xRatio: 40 / 640, yRatio: 30 / 360, widthRatio: 180 / 640, heightRatio: 70 / 360 },
      },
    });
    worker.terminate();
    return { candidates, manual };
  });

  assert.ok(Array.isArray(result.candidates), "YOLO candidate proposal must return an array");
  for (const candidate of result.candidates) {
    assert.ok(Number.isFinite(candidate.xRatio));
    assert.ok(Number.isFinite(candidate.yRatio));
    assert.ok(Number.isFinite(candidate.widthRatio));
    assert.ok(Number.isFinite(candidate.heightRatio));
  }
  assert.match(result.manual.logo_image, /^data:image\/png;base64,/);
  assert.equal(result.manual.logo_region.source, "manual");
  assert.equal(result.manual.logo_regions.length, 1);
  assert.equal(result.manual.logo_features.length, 1);
  assert.equal(result.manual.dinov2_embedding.length, 384);
  assert.ok(result.manual.dinov2_embedding.every(Number.isFinite));
  console.log("Inference Worker browser smoke test passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
