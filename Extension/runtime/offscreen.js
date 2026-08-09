import { createBrowserStackServices } from "../../src/detection/browser/browserStackServices";
import { DinoV2EmbeddingEngine } from "../../src/detection/browser/dinov2EmbeddingEngine";
import { runBrowserDetectionPipeline } from "../../src/detection/browser/serviceWorkerPipeline";
import { YoloLogoDetector } from "../../src/detection/browser/yoloLogoDetector";
import { OffscreenQueue, SchedulerError } from "../background/offscreenQueue.mjs";
import {
  GLOBAL_OFFSCREEN_CONCURRENCY,
  OFFSCREEN_QUEUE_CAPACITY,
  OFFSCREEN_REQUEST_TIMEOUT_MS,
  QUEUE_WAIT_TIMEOUT_MS,
} from "../background/inferenceLimits.mjs";

const TARGET = "yodel-offscreen";
const SERVICE_WORKER_URL = chrome.runtime.getURL("dist/service_worker.js");

const inferenceQueue = new OffscreenQueue({
  concurrency: GLOBAL_OFFSCREEN_CONCURRENCY,
  maxQueueLength: OFFSCREEN_QUEUE_CAPACITY,
  queueWaitTimeoutMs: QUEUE_WAIT_TIMEOUT_MS,
  onTimeout: (ticket) => {
    chrome.runtime.sendMessage({
      type: "offscreen_recycle_requested",
      ticketId: ticket.ticketId,
      reason: "request_timeout",
    }).catch(() => {});
  },
});

// Service construction is part of readiness: ping awaits this promise, so the
// service worker never treats a merely-loaded listener as an initialized
// inference runtime.
const servicesPromise = createServices().catch((error) => {
  const reason = `service_init_failed: ${error instanceof Error ? error.message : String(error)}`;
  console.error("[YodelPhish:offscreen] Service initialization failed:", error);
  chrome.runtime.sendMessage({ type: "offscreen_runtime_failed", reason }).catch(() => {});
  throw error;
});
servicesPromise.catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== TARGET) return false;
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined || sender.url !== SERVICE_WORKER_URL) {
    return false;
  }

  handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      console.error("[YodelPhish:offscreen] Detection job failed:", error);
      sendResponse({
        ok: false,
        code: error instanceof SchedulerError ? error.code : "offscreen_request_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
});

async function handleMessage(message) {
  if (message.type === "ping") {
    await servicesPromise;
    return { ready: true };
  }

  if (message.type === "cancel_tab") {
    return inferenceQueue.cancel(message.tabId, message.reason ?? "cancelled", {
      ticketId: message.ticketId,
    });
  }

  if (!Number.isInteger(message.tabId)) {
    throw new Error("Offscreen request is missing a valid tab ID");
  }

  return inferenceQueue.schedule(
    message.tabId,
    () => handleInference(message),
    {
      requestTimeoutMs: OFFSCREEN_REQUEST_TIMEOUT_MS,
      ticketId: message.ticketId,
    }
  );
}

async function handleInference(message) {
  const services = await servicesPromise;
  if (message.type === "detect") {
    const result = await runBrowserDetectionPipeline({
      screenshot: message.screenshot,
      trustedEntries: message.trustedEntries,
      services,
      uiCoveredBoxes: message.uiCoveredBoxes ?? [],
    });
    if (message.includeDiagnostics === true) {
      const winnerRegion = parseFormattedRegion(result.winner?.logo?.queryBox);
      result.winnerLogoImage = winnerRegion === null
        ? null
        : await cropImageToDataUrl(message.screenshot, winnerRegion).catch(() => null);
    }
    return result;
  }

  if (message.type === "preprocess_trusted") {
    return preprocessTrustedReference(message.screenshot, services);
  }

  if (message.type === "propose_trusted_add_candidates") {
    return services.logoRegions.proposeTrustedAddCandidates(message.screenshot);
  }

  if (message.type === "preprocess_trusted_region") {
    return preprocessTrustedReferenceWithRegion(message.screenshot, message.normalizedRect, services);
  }

  throw new Error(`Unsupported offscreen message type: ${String(message.type)}`);
}

async function createServices() {
  const configResponse = await fetch(chrome.runtime.getURL("models/dinov2_vits14_config.json"));
  if (!configResponse.ok) {
    throw new Error(`DINOv2 config load failed: ${configResponse.status}`);
  }
  const dinoConfig = await configResponse.json();
  const yoloDetector = new YoloLogoDetector(
    chrome.runtime.getURL("models/yolo-logo.onnx")
  );
  const services = createBrowserStackServices(undefined, yoloDetector);
  services.logoEmbeddings = new DinoV2EmbeddingEngine(
    chrome.runtime.getURL("models/dinov2_vits14.onnx"),
    dinoConfig
  );
  return services;
}

async function preprocessTrustedReference(screenshot, services) {
  const logoRegions = await services.logoRegions.proposeRegions(screenshot);
  const logoFeatures = await services.logoRegions.buildFeatures(screenshot, logoRegions);
  const primaryYoloIndex = logoRegions.findIndex((region) => region.source === "yolo");
  const primaryYoloRegion = primaryYoloIndex < 0 ? undefined : logoRegions[primaryYoloIndex];

  if (services.ocr.extractLogoCrop !== undefined) {
    for (const feature of logoFeatures) {
      feature.ocr = await services.ocr.extractLogoCrop(screenshot, feature.region);
    }
  }

  const embeddings = services.logoEmbeddings === undefined
    ? []
    : await services.logoEmbeddings.embedLogoCrops(screenshot, logoRegions.slice(0, 1));
  const primaryLogoOcr = primaryYoloIndex < 0 ? undefined : logoFeatures[primaryYoloIndex]?.ocr;

  return {
    logo_image: primaryYoloRegion === undefined
      ? null
      : await cropImageToDataUrl(screenshot, primaryYoloRegion),
    logo_regions: logoRegions,
    logo_features: logoFeatures.map(serializeFeature),
    ocr_words: [...new Set(primaryLogoOcr?.tokens ?? [])],
    ocr_diagnostics: primaryLogoOcr?.diagnostics ?? null,
    ocr_text: primaryLogoOcr?.text ?? "",
    logo_region: primaryYoloRegion ?? null,
    dinov2_embedding: embeddings[0] ?? null,
  };
}

async function preprocessTrustedReferenceWithRegion(screenshot, normalizedRect, services) {
  // The engine validates and clamps the selection against the decoded
  // screenshot and returns the same descriptor set an automatic candidate gets,
  // so the manual reference is scored on the same footing. An unusable
  // selection throws, which reaches the logo selector as a retryable error.
  const manualRegion = await services.logoRegions.describeManualRegion(screenshot, normalizedRect);

  const logoRegions = [manualRegion];
  const logoFeatures = await services.logoRegions.buildFeatures(screenshot, logoRegions);

  if (services.ocr.extractLogoCrop !== undefined) {
    for (const feature of logoFeatures) {
      feature.ocr = await services.ocr.extractLogoCrop(screenshot, feature.region);
    }
  }

  const embeddings = services.logoEmbeddings === undefined
    ? []
    : await services.logoEmbeddings.embedLogoCrops(screenshot, logoRegions);

  const primaryFeature = logoFeatures[0];

  return {
    logo_image: await cropImageToDataUrl(screenshot, manualRegion),
    logo_regions: logoRegions,
    logo_features: logoFeatures.map(serializeFeature),
    ocr_words: [...new Set(primaryFeature?.ocr?.tokens ?? [])],
    ocr_diagnostics: primaryFeature?.ocr?.diagnostics ?? null,
    ocr_text: primaryFeature?.ocr?.text ?? "",
    logo_region: manualRegion,
    dinov2_embedding: embeddings[0] ?? null,
  };
}

async function cropImageToDataUrl(image, region) {
  if (typeof image.dataUrl !== "string" || image.dataUrl.length === 0) {
    throw new Error("Trusted reference image has no data URL");
  }

  const response = await fetch(image.dataUrl);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const x = Math.max(0, Math.floor(region.xOriginal ?? region.x));
    const y = Math.max(0, Math.floor(region.yOriginal ?? region.y));
    const right = Math.min(bitmap.width, Math.ceil(x + (region.widthOriginal ?? region.width)));
    const bottom = Math.min(bitmap.height, Math.ceil(y + (region.heightOriginal ?? region.height)));
    const width = right - x;
    const height = bottom - y;
    if (width <= 0 || height <= 0) throw new Error("YOLO returned an invalid logo region");

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("2D context unavailable for logo crop");
    context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    return blobToDataUrl(await canvas.convertToBlob({ type: "image/png" }));
  } finally {
    bitmap.close();
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Logo encoding failed")));
    reader.readAsDataURL(blob);
  });
}

function parseFormattedRegion(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const [coordinates] = value.split(":", 1);
  const [x, y, width, height] = coordinates.split(",").map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height, xOriginal: x, yOriginal: y, widthOriginal: width, heightOriginal: height };
}

function serializeFeature(feature) {
  const serialized = {
    index: feature.index,
    region: feature.region,
  };
  if (feature.trimmedRegion !== undefined) serialized.trimmedRegion = feature.trimmedRegion;
  if (feature.visualRejectReason !== undefined) serialized.visualRejectReason = feature.visualRejectReason;
  if (feature.ocr !== undefined) serialized.ocr = feature.ocr;
  if (feature.shapeMask !== undefined) {
    serialized.shapeMask = {
      width: feature.shapeMask.width,
      height: feature.shapeMask.height,
      data: Array.from(feature.shapeMask.data),
    };
  }
  if (feature.components !== undefined) {
    serialized.components = feature.components.map(serializeFeature);
  }
  return serialized;
}
