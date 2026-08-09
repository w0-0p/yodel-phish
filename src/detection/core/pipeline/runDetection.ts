import type { PipelineConfig } from "../config";
import type { ImageRef, LogoRegion, LogoRegionFeature, OcrExtraction, OcrMatchResult, PerTrustedResult, PipelineResult, TrustedEntry, YoloValidationOutcome } from "../types";
import type { DebugSink } from "../../platform/DebugSink";
import type { OcrMaskHint, ProposeRegionsOptions, PipelineServices } from "../../platform/PipelineServices";
import type { CoverBox } from "../geometry/boxes";
import { buildTrustedLabels, tokenizeOcrText } from "../ocr/labels";
import { buildOcrMatches, emptyOcrMatchResult } from "../ocr/matching";
import { computeGlobalScore, computeVerdict } from "../scoring";
import { compareLogoRegionFeatures, emptyLogoRegionComparison, selectLogoRegionOcrPairs } from "../logo-region/scoring";

export async function runDetection(input: {
  queryImage: ImageRef;
  trustedEntries: TrustedEntry[];
  config: PipelineConfig;
  services: PipelineServices;
  uiCoveredBoxes?: CoverBox[] | undefined;
  debug?: DebugSink | undefined;
}): Promise<PipelineResult> {
  const { queryImage, trustedEntries, config, services, debug } = input;
  const uiCoveredBoxes = input.uiCoveredBoxes ?? [];
  const detectionStartMs = nowMs();

  await debug?.emit({
    type: "pipeline-start",
    queryImageId: queryImage.id,
    trustedCount: trustedEntries.length
  });

  let stageStartMs = nowMs();
  const unmaskedRegions = await services.logoRegions.proposeRegions(queryImage);
  const queryProposeMs = nowMs() - stageStartMs;

  stageStartMs = nowMs();
  const unmaskedFeatures = await services.logoRegions.buildFeatures(queryImage, unmaskedRegions);
  const queryBuildFeaturesMs = nowMs() - stageStartMs;

  // Skip full-page OCR only when a logo crop already contains text that matches
  // one of the trusted brand labels (exact, substring, or fuzzy). Noise tokens
  // from garbled crops do NOT trigger the skip — they won't match any label.
  stageStartMs = nowMs();
  const queryLogoHasBrandText = await queryLogoFeaturesMatchAnyLabel(
    queryImage, unmaskedFeatures, trustedEntries, config, services
  );
  const queryLogoLabelOcrMs = nowMs() - stageStartMs;

  stageStartMs = nowMs();
  let queryLogoEmbeddings = services.logoEmbeddings !== undefined
    ? await services.logoEmbeddings.embedLogoCrops(queryImage, unmaskedRegions)
    : [];
  const queryDinoEmbedMs = nowMs() - stageStartMs;

  // A YOLO-only proposal set keeps CV from ever running (proposeRegions falls
  // back to CV only when YOLO returns nothing), so a single wrong box can both
  // hide the real logo and disable the detector that would have found it.
  // YOLO keeps that monopoly only when one of its crops is semantically tied to
  // a trusted brand — by crop text or by DINOv2 similarity. Otherwise CV runs
  // additionally and the candidate sets merge; the YOLO boxes stay in, so
  // per-trusted comparison still arbitrates among all of them.
  let baseRegions = unmaskedRegions;
  let baseFeatures = unmaskedFeatures;
  let queryCvMergeMs = 0;
  let yoloValidation: YoloValidationOutcome;
  const yoloOnlyProposals = unmaskedRegions.length > 0 && unmaskedRegions.every((r) => r.source === "yolo");
  if (unmaskedRegions.length === 0) {
    yoloValidation = "no-regions";
  } else if (!yoloOnlyProposals) {
    yoloValidation = "cv-fallback";
  } else if (queryLogoHasBrandText) {
    yoloValidation = "brand-text";
  } else if (
    config.yoloValidationMinDinoSim <= 0 ||
    maxEmbeddingSimilarityAcrossTrusted(queryLogoEmbeddings, trustedEntries, services) >= config.yoloValidationMinDinoSim
  ) {
    yoloValidation = "dino-sim";
  } else {
    yoloValidation = "merged";
    stageStartMs = nowMs();
    const cvRegions = await services.logoRegions.proposeRegions(queryImage, undefined, { skipYolo: true });
    const cvNew = cvRegions.filter((candidate) =>
      unmaskedRegions.every((existing) => regionOverlapIou(candidate, existing) < 0.55)
    );
    if (cvNew.length > 0) {
      const cvFeatures = await services.logoRegions.buildFeatures(queryImage, cvNew);
      baseRegions = [...unmaskedRegions, ...cvNew].map((region, index) => ({ ...region, rank: index + 1 }));
      baseFeatures = [...unmaskedFeatures, ...cvFeatures];
      if (services.logoEmbeddings !== undefined) {
        queryLogoEmbeddings = [
          ...queryLogoEmbeddings,
          ...await services.logoEmbeddings.embedLogoCrops(queryImage, cvNew)
        ];
      }
      // Deliberately NOT extending queryLogoHasBrandText from the merged CV
      // crops: the full-OCR skip is only safe when the brand text sits in a
      // crop the pre-merge path already trusted — a merged-in CV crop that
      // happens to contain brand text would cancel the page-level OCR
      // evidence the merge was supposed to protect (the AT&T flip,
      // 643c46f30b85b76ae21c0be4). Merged crops still feed logo scoring via
      // ensureTopLogoPairOcr.
    }
    queryCvMergeMs = nowMs() - stageStartMs;
  }

  const fullOcrRan = !queryLogoHasBrandText;
  let queryFullOcrMs = 0;
  let queryOcr: OcrExtraction;
  if (queryLogoHasBrandText) {
    queryOcr = emptyOcrExtraction();
  } else {
    stageStartMs = nowMs();
    queryOcr = await services.ocr.extract(queryImage);
    queryFullOcrMs = nowMs() - stageStartMs;
  }

  stageStartMs = nowMs();
  // Keyed by the labels an entry actually matches on, not by its fqdn: one
  // fqdn may have several saved reference variants whose extracted and
  // user-added words differ, and those must not share one match result.
  const ocrCache = new Map<string, OcrMatchResult>();
  for (const trusted of trustedEntries) {
    const cacheKey = buildTrustedLabelCacheKey(trusted);
    if (ocrCache.has(cacheKey)) continue;
    const labels = buildTrustedLabels(trusted.ocrDomain, trusted.ocrLabels);
    ocrCache.set(cacheKey, labels.length > 0
      ? buildOcrMatches({
        tokens: queryOcr.tokens,
        labels,
        text: queryOcr.text,
        words: queryOcr.words,
        uiCoveredBoxes,
        config
      })
      : emptyOcrMatchResult()
    );
  }

  const ocrMatchCacheMs = nowMs() - stageStartMs;

  const perTrusted: PerTrustedResult[] = [];
  const trustedFeatureCache = new Map<string, { regions: TrustedEntry["logoRegions"]; features: TrustedEntry["logoFeatures"] }>();
  // Cache masked query features by the same inputs Python uses for its masked query cache.
  const queryFeatureCache = new Map<string, { regions: LogoRegion[]; features: LogoRegionFeature[] }>();
  const hasOcrWords = queryOcr.words.length > 0;
  // YOLO ignores the OCR mask entirely, so it produces the same result regardless
  // of which trusted entry's mask is applied. Two cases where re-running YOLO per
  // trusted entry is therefore wasteful:
  //   1. The unmasked pass used YOLO successfully → reuse those regions for all
  //      trusted entries (the CV path is never reached).
  //   2. The unmasked pass fell back to CV (YOLO found nothing) → skip YOLO in
  //      masked calls via ProposeRegionsOptions.skipYolo; each masked call still
  //      runs CV on a differently-masked image, which is the only part that varies.
  // A merged (yolo + cv) base set intentionally fails this check: it behaves
  // like the YOLO-miss path, where masked CV re-proposals per label set are the
  // part that varies and YOLO is never re-run.
  const unmaskedUsedYolo = baseRegions.length > 0 && baseRegions.every((r) => r.source === "yolo");
  const maskedCallOptions: ProposeRegionsOptions = { skipYolo: !unmaskedUsedYolo };

  stageStartMs = nowMs();
  for (const trusted of trustedEntries) {
    const labels = buildTrustedLabels(trusted.ocrDomain, trusted.ocrLabels);

    let queryRegions: LogoRegion[];
    let queryFeatures: LogoRegionFeature[];
    if (!hasOcrWords || unmaskedUsedYolo) {
      queryRegions = baseRegions;
      queryFeatures = baseFeatures;
    } else {
      // Build mask hint: preserve only tokens belonging to this brand; mask everything else.
      const ocrMask: OcrMaskHint = {
        words: queryOcr.words,
        keepTokens: buildOcrMaskKeepTokens(trusted, labels)
      };

      const queryCacheKey = buildTrustedLabelCacheKey(trusted);
      const cachedQuery = queryFeatureCache.get(queryCacheKey);
      if (cachedQuery !== undefined) {
        queryRegions = cachedQuery.regions;
        queryFeatures = cachedQuery.features;
      } else {
        queryRegions = await services.logoRegions.proposeRegions(queryImage, ocrMask, maskedCallOptions);
        queryFeatures = await services.logoRegions.buildFeatures(queryImage, queryRegions, ocrMask);
        queryFeatureCache.set(queryCacheKey, { regions: queryRegions, features: queryFeatures });
      }
    }

    const trustedCached = trustedFeatureCache.get(trusted.id);
    const trustedImage = trusted.sourceImage !== undefined && hasImagePayload(trusted.sourceImage)
      ? trusted.sourceImage
      : undefined;
    const trustedRegions = trustedCached?.regions ?? trusted.logoRegions ?? (
      trustedImage === undefined ? [] : await services.logoRegions.proposeRegions(trustedImage)
    );
    const trustedFeatures = trustedCached?.features ?? trusted.logoFeatures ?? (
      trustedImage === undefined ? [] : await services.logoRegions.buildFeatures(trustedImage, trustedRegions)
    );
    trustedFeatureCache.set(trusted.id, { regions: trustedRegions, features: trustedFeatures });

    const dinoV2LogoSimilarity = bestEmbeddingSimilarity(
      queryLogoEmbeddings,
      trusted.dinoV2Embedding,
      services
    );

    await ensureTopLogoPairOcr({
      queryImage,
      trustedImage,
      queryFeatures,
      trustedFeatures,
      config,
      services
    });

    const logo = services.logoRegions.compare !== undefined && trustedImage !== undefined
      ? await services.logoRegions.compare({
        queryImage,
        trustedImage,
        queryRegions,
        trustedRegions,
        queryFeatures,
        trustedFeatures,
        labels
      })
      : compareLogoRegionFeatures({
        queryFeatures,
        trustedFeatures,
        labels,
        config,
        queryDinoEmbeddings: queryLogoEmbeddings,
        trustedDinoEmbedding: trusted.dinoV2Embedding,
        embeddingSimilarity: services.logoEmbeddings?.similarity.bind(services.logoEmbeddings)
      });

    const ocr = ocrCache.get(buildTrustedLabelCacheKey(trusted)) ?? emptyOcrMatchResult();

    const global = computeGlobalScore({
      config,
      ocr,
      logo,
      dinoV2LogoSimilarity
    });
    logo.logoRegionAssignedScore = global.logoAssignedScore;

    const result: PerTrustedResult = {
      imgPath: trusted.id,
      ...(trusted.variantId !== undefined ? { variantId: trusted.variantId } : {}),
      fqdn: trusted.fqdn,
      dinoV2LogoSimilarity,
      logo,
      ocr,
      ocrVisibleExactMatchBonus: round4(global.visibleExactMatchBonus),
      ocrAssignedScore: global.ocrAssignedScore,
      effectiveOcrScore: global.effectiveOcrScore,
      effectiveLogoScore: global.effectiveLogoScore,
      ocrMedianTextHeightPx: queryOcr.medianTextHeightPx,
      ocrMedianTextHeightRatio: queryOcr.medianTextHeightRatio,
      globalScore: global.globalScore,
      verdict: computeVerdict(global.globalScore, config)
    };

    perTrusted.push(result);
    await debug?.emit({ type: "per-trusted-result", queryImageId: queryImage.id, result });
  }
  const perTrustedAnalysisMs = nowMs() - stageStartMs;

  stageStartMs = nowMs();
  perTrusted.sort((left, right) => {
    const byGlobal = right.globalScore - left.globalScore;
    if (byGlobal !== 0) return byGlobal;
    const byLogo = right.logo.logoRegionScore - left.logo.logoRegionScore;
    if (byLogo !== 0) return byLogo;
    const byOcr = right.ocr.normalizedScore - left.ocr.normalizedScore;
    if (byOcr !== 0) return byOcr;
    return left.fqdn.localeCompare(right.fqdn);
  });
  const sortMs = nowMs() - stageStartMs;

  const winnerRow = perTrusted[0];
  const timings = {
    queryProposeMs,
    queryBuildFeaturesMs,
    queryLogoLabelOcrMs,
    queryCvMergeMs,
    queryFullOcrMs,
    queryDinoEmbedMs,
    ocrMatchCacheMs,
    perTrustedAnalysisMs,
    sortMs,
    totalMs: nowMs() - detectionStartMs
  };
  const yoloRegionCount = baseRegions.filter((region) => region.source === "yolo").length;
  const queryStats = {
    regionCount: baseRegions.length,
    yoloRegionCount,
    cvRegionCount: baseRegions.length - yoloRegionCount,
    fullOcrRan,
    yoloValidation
  };
  const result: PipelineResult = {
    winner: {
      queryImage: queryImage.id,
      matchedFqdn: winnerRow?.fqdn ?? "",
      matchedReferenceId: winnerRow?.imgPath ?? "",
      matchedVariantId: winnerRow?.variantId ?? "",
      dinoV2LogoSimilarity: winnerRow?.dinoV2LogoSimilarity ?? 0.0,
      logo: winnerRow?.logo ?? emptyLogoRegionComparison(),
      ocr: winnerRow?.ocr ?? emptyOcrMatchResult(),
      ocrVisibleExactMatchBonus: winnerRow?.ocrVisibleExactMatchBonus ?? 0.0,
      ocrAssignedScore: winnerRow?.ocrAssignedScore ?? 0.0,
      effectiveOcrScore: winnerRow?.effectiveOcrScore ?? 0.0,
      effectiveLogoScore: winnerRow?.effectiveLogoScore ?? 0.0,
      globalScore: winnerRow?.globalScore ?? 0.0,
      verdict: winnerRow?.verdict ?? "unknown"
    },
    perTrusted,
    timings,
    queryStats
  };

  logYoloMissTiming({
    queryImage,
    trustedEntries,
    unmaskedUsedYolo,
    unmaskedRegions,
    unmaskedFeatures,
    queryOcr,
    queryFeatureCache,
    hasOcrWords,
    perTrusted,
    queryProposeMs,
    queryBuildFeaturesMs,
    queryLogoLabelOcrMs,
    queryFullOcrMs,
    queryDinoEmbedMs,
    ocrMatchCacheMs,
    perTrustedAnalysisMs,
    sortMs,
    totalMs: timings.totalMs
  });

  await debug?.emit({ type: "pipeline-result", queryImageId: queryImage.id, result });
  return result;
}

function emptyOcrExtraction(): OcrExtraction {
  return { text: "", tokens: [], words: [], medianTextHeightPx: 0.0, medianTextHeightRatio: 0.0 };
}

async function queryLogoFeaturesMatchAnyLabel(
  queryImage: ImageRef,
  queryFeatures: LogoRegionFeature[],
  trustedEntries: TrustedEntry[],
  config: PipelineConfig,
  services: PipelineServices
): Promise<boolean> {
  const allLabels = trustedEntries.flatMap((trusted) =>
    buildTrustedLabels(trusted.ocrDomain, trusted.ocrLabels)
  );
  if (allLabels.length === 0) return false;

  for (const feature of queryFeatures) {
    const ocr = await ensureLogoFeatureOcr(queryImage, feature, services);
    const match = buildOcrMatches({
      tokens: ocr.tokens,
      labels: allLabels,
      text: ocr.text,
      words: [],
      config
    });
    if (match.normalizedScore > 0.0 || match.fuzzyScore > 0.0) return true;
  }
  return false;
}

async function ensureTopLogoPairOcr(input: {
  queryImage: ImageRef;
  trustedImage: ImageRef | undefined;
  queryFeatures: LogoRegionFeature[];
  trustedFeatures: LogoRegionFeature[];
  config: PipelineConfig;
  services: PipelineServices;
}): Promise<void> {
  const pairs = selectLogoRegionOcrPairs({
    queryFeatures: input.queryFeatures,
    trustedFeatures: input.trustedFeatures,
    config: input.config
  });
  for (const pair of pairs) {
    await ensureLogoFeatureOcr(input.queryImage, pair.queryFeature, input.services);
    await ensureLogoFeatureOcr(input.trustedImage, pair.trustedFeature, input.services);
  }
}

async function ensureLogoFeatureOcr(
  image: ImageRef | undefined,
  feature: LogoRegionFeature,
  services: PipelineServices
): Promise<Pick<OcrExtraction, "text" | "tokens">> {
  if (feature.ocr !== undefined) return feature.ocr;
  const ocr = services.ocr.extractLogoCrop !== undefined && image !== undefined
    ? await services.ocr.extractLogoCrop(image, feature.region)
    : { text: "", tokens: [] };
  feature.ocr = ocr;
  return ocr;
}

// Everything an OCR match and an OCR-masked query pass depend on. Two trusted
// entries sharing this key produce identical results and may share both caches;
// two variants of one fqdn with different labels may not.
function buildTrustedLabelCacheKey(trusted: TrustedEntry): string {
  return JSON.stringify([trusted.fqdn, trusted.ocrDomain, trusted.ocrLabels]);
}

// Highest DINOv2 similarity any query crop reaches against any trusted
// embedding — the "does anything here resemble a trusted logo at all" signal
// the YOLO arbitration gate reads. Entries without an embedding contribute
// nothing, so a trusted list with no embeddings at all validates nothing and
// the gate falls through to the CV merge (fail toward thoroughness).
function maxEmbeddingSimilarityAcrossTrusted(
  queryEmbeddings: number[][],
  trustedEntries: TrustedEntry[],
  services: PipelineServices
): number {
  if (services.logoEmbeddings === undefined || queryEmbeddings.length === 0) return 0.0;
  let best = 0.0;
  for (const trusted of trustedEntries) {
    if (trusted.dinoV2Embedding === undefined) continue;
    for (const embedding of queryEmbeddings) {
      best = Math.max(best, services.logoEmbeddings.similarity(embedding, trusted.dinoV2Embedding));
    }
  }
  return best;
}

// IoU in original-image coordinates, used to drop CV proposals that re-find a
// box YOLO already proposed. Mirrors the 0.55 dedupe the CV path applies to
// its own candidates.
function regionOverlapIou(a: LogoRegion, b: LogoRegion): number {
  const ax = a.xOriginal ?? a.x;
  const ay = a.yOriginal ?? a.y;
  const aw = a.widthOriginal ?? a.width;
  const ah = a.heightOriginal ?? a.height;
  const bx = b.xOriginal ?? b.x;
  const by = b.yOriginal ?? b.y;
  const bw = b.widthOriginal ?? b.width;
  const bh = b.heightOriginal ?? b.height;
  const inter =
    Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx)) *
    Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  const union = aw * ah + bw * bh - inter;
  return union <= 0 ? 0.0 : inter / union;
}

function bestEmbeddingSimilarity(
  queryEmbeddings: number[][],
  trustedEmbedding: number[] | undefined,
  services: PipelineServices
): number {
  if (trustedEmbedding === undefined || services.logoEmbeddings === undefined || queryEmbeddings.length === 0) {
    return 0.0;
  }

  return Math.max(
    ...queryEmbeddings.map((embedding) => services.logoEmbeddings?.similarity(embedding, trustedEmbedding) ?? 0.0)
  );
}

const ignoredOcrMaskFqdnTokens = new Set([
  "account", "accounts", "online", "web", "login", "signin", "sign", "secure",
  "security", "bank", "banking", "service", "services", "portal", "home", "access",
  "com", "de", "fr", "ch", "au", "uk", "us", "gt", "be", "nl", "it",
  "es", "ca", "www", "http", "https", "net", "org", "edu", "gov", "io", "co"
]);

function buildOcrMaskKeepTokens(trusted: TrustedEntry, labels: ReturnType<typeof buildTrustedLabels>): string[] {
  const tokens = new Set(buildKeepTokens(labels));
  for (const token of tokenizeOcrText(trusted.fqdn)) {
    if (!ignoredOcrMaskFqdnTokens.has(token)) tokens.add(token);
  }
  return [...tokens];
}

function buildKeepTokens(labels: ReturnType<typeof buildTrustedLabels>): string[] {
  const tokens = new Set<string>();
  for (const item of labels) {
    for (const token of tokenizeOcrText(item.label)) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function hasImagePayload(image: ImageRef): boolean {
  return (typeof image.dataUrl === "string" && image.dataUrl.length > 0) || image.bytes !== undefined;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}


let yoloMissTimingLogCount = 0;
const maxYoloMissTimingLogs = 10;

function logYoloMissTiming(input: {
  queryImage: ImageRef;
  trustedEntries: TrustedEntry[];
  unmaskedUsedYolo: boolean;
  unmaskedRegions: LogoRegion[];
  unmaskedFeatures: LogoRegionFeature[];
  queryOcr: OcrExtraction;
  queryFeatureCache: Map<string, { regions: LogoRegion[]; features: LogoRegionFeature[] }>;
  hasOcrWords: boolean;
  perTrusted: PerTrustedResult[];
  queryProposeMs: number;
  queryBuildFeaturesMs: number;
  queryLogoLabelOcrMs: number;
  queryFullOcrMs: number;
  queryDinoEmbedMs: number;
  ocrMatchCacheMs: number;
  perTrustedAnalysisMs: number;
  sortMs: number;
  totalMs: number;
}): void {
  if (!timingEnabled()) return;
  if (input.unmaskedUsedYolo) return;
  if (yoloMissTimingLogCount >= maxYoloMissTimingLogs) return;

  yoloMissTimingLogCount += 1;
  timingLog(
    "yolo-miss analysis " + input.queryImage.id +
    " query_regions=" + input.unmaskedRegions.length +
    " query_features=" + input.unmaskedFeatures.length +
    " trusted_entries=" + input.trustedEntries.length +
    " per_trusted=" + input.perTrusted.length +
    " has_ocr_words=" + String(input.hasOcrWords) +
    " query_ocr_words=" + input.queryOcr.words.length +
    " query_feature_cache_entries=" + input.queryFeatureCache.size +
    " propose=" + formatSeconds(input.queryProposeMs) +
    " build_features=" + formatSeconds(input.queryBuildFeaturesMs) +
    " logo_label_ocr=" + formatSeconds(input.queryLogoLabelOcrMs) +
    " full_ocr=" + formatSeconds(input.queryFullOcrMs) +
    " dino_embed=" + formatSeconds(input.queryDinoEmbedMs) +
    " ocr_match_cache=" + formatSeconds(input.ocrMatchCacheMs) +
    " per_trusted_analysis=" + formatSeconds(input.perTrustedAnalysisMs) +
    " sort=" + formatSeconds(input.sortMs) +
    " total=" + formatSeconds(input.totalMs)
  );
}

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

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(3) + "s";
}
