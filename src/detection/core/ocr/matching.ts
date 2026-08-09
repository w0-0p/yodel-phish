import type { PipelineConfig } from "../config";
import type { BoxLike, OcrExtraction, OcrMatchResult, OcrTokenMatch, OcrWord, TrustedOcrLabel } from "../types";
import { boxIsCovered, type CoverBox } from "../geometry/boxes";

export function normalizeOcrLabel(text: string): string {
  return text.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function containsAliasAtWordBoundaries(text: string, label: string): boolean {
  let start = 0;
  while (start <= text.length - label.length) {
    const index = text.indexOf(label, start);
    if (index < 0) return false;

    const before = index > 0 ? text[index - 1] ?? "" : "";
    const afterIndex = index + label.length;
    const after = afterIndex < text.length ? text[afterIndex] ?? "" : "";
    const validBefore = before === "" || !/[a-z0-9]/.test(before);
    const validAfter = after === "" || !/[a-z0-9]/.test(after);
    if (validBefore && validAfter) return true;

    start = index + 1;
  }
  return false;
}

export function tokenizeOcrText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

export function buildTrustedLabels(ocrDomain: string, ocrLabels: string[] | string = []): TrustedOcrLabel[] {
  const mainDomain = ocrDomain.toLowerCase().trim();
  const labels: TrustedOcrLabel[] = [];
  if (mainDomain && mainDomain !== "www") {
    labels.push({ label: mainDomain, kind: "main_domain" });
    if (mainDomain === "microsoftonline") {
      labels.push({ label: "microsoft", kind: "synthetic" });
    }
  }

  const labelParts = Array.isArray(ocrLabels) ? ocrLabels : ocrLabels.split("|");
  for (const value of labelParts) {
    const label = normalizeOcrLabel(value);
    if (label) labels.push({ label, kind: "ocr_label" });
  }
  return labels;
}

export function levenshteinDistance(aInput: string, bInput: string): number {
  if (aInput === bInput) return 0;
  let a = aInput;
  let b = bInput;
  if (a.length < b.length) {
    a = bInput;
    b = aInput;
  }
  let previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    const ca = a[i - 1] ?? "";
    for (let j = 1; j <= b.length; j += 1) {
      const cb = b[j - 1] ?? "";
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (ca === cb ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[previous.length - 1] ?? 0;
}

export function normalizedEditSimilarity(a: string, b: string): number {
  if (!a || !b) return 0.0;
  return 1.0 - levenshteinDistance(a, b) / Math.max(a.length, b.length);
}

export function ocrSizeBucket(heightRatio: number, config: PipelineConfig): "small" | "medium" | "large" {
  if (heightRatio < config.ocrSmallTextHeightRatio) return "small";
  if (heightRatio < config.ocrLargeTextHeightRatio) return "medium";
  return "large";
}

export function summarizeOcrWordSizes(words: OcrWord[]): Pick<OcrExtraction, "medianTextHeightPx" | "medianTextHeightRatio"> {
  const heights = words.map((word) => word.heightPx).filter((height) => height > 0).sort((a, b) => a - b);
  const ratios = words.map((word) => word.heightRatio).filter((ratio) => ratio > 0).sort((a, b) => a - b);
  return {
    medianTextHeightPx: heights.length > 0 ? round(median(heights), 2) : 0.0,
    medianTextHeightRatio: ratios.length > 0 ? round(median(ratios), 4) : 0.0
  };
}

export function buildOcrMatches(input: {
  tokens: string[];
  labels: TrustedOcrLabel[];
  text?: string;
  words?: OcrWord[];
  uiCoveredBoxes?: CoverBox[];
  config: PipelineConfig;
}): OcrMatchResult {
  const { tokens, labels, config } = input;
  const text = input.text ?? "";
  const words = input.words ?? [];
  const uiCoveredBoxes = input.uiCoveredBoxes ?? [];
  const exactMatches: OcrTokenMatch[] = [];
  const substringMatches: OcrTokenMatch[] = [];
  const fuzzyMatches: OcrTokenMatch[] = [];
  const rejectedSmallBottomMatches: OcrTokenMatch[] = [];
  const rejectedUiElementMatches: OcrTokenMatch[] = [];
  const genericTokens = new Set(config.ocrGenericDomainTokens);
  let bestScore = 0.0;
  let bestFuzzyScore = 0.0;
  const normalizedText = normalizeOcrLabel(text);

  const textPositionRatio = (needle: string): number => {
    if (!needle || !normalizedText) return -1.0;
    const index = normalizedText.indexOf(needle);
    if (index < 0) return -1.0;
    return round(index / Math.max(normalizedText.length, 1), 4);
  };

  for (const item of labels) {
    const label = item.label;

    if (item.kind === "ocr_label") {
      if (label.length > 0 && containsAliasAtWordBoundaries(normalizedText, label)) {
        const matchedWords = findOcrWordsForLabel(words, label);
        const match = makeMatch(label, label, config.ocrExactDomainScore, textPositionRatio(label), matchedWords);
        if (allOcrWordsSmallBottom(matchedWords)) {
          rejectedSmallBottomMatches.push({ ...match, weight: 0.0 });
        } else if (allOcrWordsInUiElement(matchedWords, uiCoveredBoxes)) {
          rejectedUiElementMatches.push({ ...match, weight: 0.0 });
        } else {
          exactMatches.push(match);
          bestScore = Math.max(bestScore, config.ocrExactDomainScore);
        }
        continue;
      }

      // OCR commonly joins a multi-part brand label into one token (for example,
      // "la poste" -> "laposte"). Accept that formatting difference only as an
      // exact token match; do not expose the compact form to substring or fuzzy
      // matching, where removing separators would increase accidental matches.
      const compactLabel = label.replace(/[^a-z0-9]+/g, "");
      if (
        compactLabel !== label &&
        compactLabel.length >= config.ocrFuzzyMinLength &&
        !genericTokens.has(compactLabel)
      ) {
        const compactExact = tokens.find((token) => token === compactLabel);
        if (compactExact !== undefined) {
          const matchedWords = findOcrWordsForToken(words, compactExact);
          const match = makeMatch(
            label,
            compactExact,
            config.ocrExactDomainScore,
            textPositionRatio(compactExact),
            matchedWords
          );
          if (allOcrWordsSmallBottom(matchedWords)) {
            rejectedSmallBottomMatches.push({ ...match, weight: 0.0 });
          } else if (allOcrWordsInUiElement(matchedWords, uiCoveredBoxes)) {
            rejectedUiElementMatches.push({ ...match, weight: 0.0 });
          } else {
            exactMatches.push(match);
            bestScore = Math.max(bestScore, config.ocrExactDomainScore);
          }
          continue;
        }
      }

      // Multi-word aliases only match as complete phrases. Single-word aliases
      // fall through to the same substring and fuzzy safeguards as domains.
      if (tokenizeOcrText(label).length !== 1) continue;
    }

    const exact = tokens.find((token) => token === label);
    if (exact !== undefined) {
      const matchedWords = findOcrWordsForToken(words, exact);
      const match = makeMatch(label, exact, config.ocrExactDomainScore, textPositionRatio(exact), matchedWords);
      if (allOcrWordsSmallBottom(matchedWords)) {
        rejectedSmallBottomMatches.push({ ...match, weight: 0.0 });
      } else if (allOcrWordsInUiElement(matchedWords, uiCoveredBoxes)) {
        rejectedUiElementMatches.push({ ...match, weight: 0.0 });
      } else {
        exactMatches.push(match);
        bestScore = Math.max(bestScore, config.ocrExactDomainScore);
        continue;
      }
    }

    if (label.length < 5) continue;

    const substrCandidates = tokens.filter((token) =>
      token.length >= 5 &&
      !genericTokens.has(token) &&
      label.length > 0 &&
      (token.includes(label) || label.includes(token))
    );
    for (const substr of substrCandidates) {
      const coverage = Math.min(substr.length, label.length) / Math.max(substr.length, label.length);
      if (coverage < 0.65) continue;

      const matchedWords = findOcrWordsForToken(words, substr);
      const position = textPositionRatio(substr);
      if (allOcrWordsSmallBottom(matchedWords)) {
        rejectedSmallBottomMatches.push(makeMatch(label, substr, 0.0, position, matchedWords));
        continue;
      }
      if (allOcrWordsInUiElement(matchedWords, uiCoveredBoxes)) {
        rejectedUiElementMatches.push(makeMatch(label, substr, 0.0, position, matchedWords));
        continue;
      }
      const weight = coverage >= 0.8
        ? config.ocrStrongDomainScore
        : config.ocrPartialDomainScore;
      substringMatches.push(makeMatch(label, substr, weight, position, matchedWords));
      bestScore = Math.max(bestScore, weight);
      break;
    }

    const fuzzyCandidates = tokens.filter((token) =>
      label.length >= config.ocrFuzzyMinLength &&
      token.length >= config.ocrFuzzyMinLength &&
      !genericTokens.has(token) &&
      token !== label
    );
    for (const token of fuzzyCandidates) {
      const similarity = normalizedEditSimilarity(token, label);
      if (similarity < config.ocrFuzzySimilarityThreshold) continue;
      const matchedWords = findOcrWordsForToken(words, token);
      if (allOcrWordsSmallBottom(matchedWords)) continue;
      if (allOcrWordsInUiElement(matchedWords, uiCoveredBoxes)) continue;
      fuzzyMatches.push(makeMatch(label, token, round(similarity, 4), textPositionRatio(token), matchedWords));
      bestFuzzyScore = Math.max(bestFuzzyScore, similarity);
    }
  }

  const allMatches = [...exactMatches, ...substringMatches];
  const dedupedSmallBottom = dedupeRejected(rejectedSmallBottomMatches);
  const dedupedUi = dedupeRejected(rejectedUiElementMatches);
  const sizeSummary = summarizeOcrMatchSizes(allMatches);
  const matchedTokens = [...exactMatches, ...substringMatches]
    .map((match) => `${match.token}(${match.label})`)
    .join("|");

  return {
    exactMatches,
    substringMatches,
    fuzzyMatches,
    normalizedScore: round(bestScore, 4),
    fuzzyScore: round(bestFuzzyScore, 4),
    matchedTokens,
    matchedTokensWithSize: formatOcrMatchesWithSize(allMatches, config),
    fuzzyMatchedTokens: fuzzyMatches.map((match) => `${match.token}(${match.label}:${match.weight})`).join("|"),
    fuzzyMatchedTokensWithSize: formatOcrMatchesWithSize(fuzzyMatches, config),
    rejectedSmallBottomTokens: formatOcrMatchesWithSize(dedupedSmallBottom, config),
    rejectedUiTokens: formatOcrMatchesWithSize(dedupedUi, config),
    visibleExactMatch: hasVisibleNonBottomExactOcrMatch(exactMatches, config),
    ...sizeSummary
  };
}

export function emptyOcrMatchResult(): OcrMatchResult {
  return {
    normalizedScore: 0.0,
    fuzzyScore: 0.0,
    matchedTokens: "",
    matchedTokensWithSize: "",
    fuzzyMatchedTokens: "",
    fuzzyMatchedTokensWithSize: "",
    rejectedSmallBottomTokens: "",
    rejectedUiTokens: "",
    visibleExactMatch: false,
    exactMatches: [],
    substringMatches: [],
    fuzzyMatches: [],
    matchedMinHeightPx: 0.0,
    matchedMedianHeightPx: 0.0,
    matchedMaxHeightPx: 0.0,
    matchedMinHeightRatio: 0.0,
    matchedMedianHeightRatio: 0.0
  };
}

export function logoRegionOcrScoreFromOcr(input: {
  queryOcr?: Pick<OcrExtraction, "text" | "tokens"> | undefined;
  trustedOcr?: Pick<OcrExtraction, "text" | "tokens"> | undefined;
  labels: TrustedOcrLabel[];
  config: PipelineConfig;
}): { score: number; queryText: string; trustedText: string; matchedTokens: string } {
  const { labels, config } = input;
  if (labels.length === 0) return { score: 0.0, queryText: "", trustedText: "", matchedTokens: "" };
  const queryOcr = input.queryOcr ?? { text: "", tokens: [] };
  const trustedOcr = input.trustedOcr ?? { text: "", tokens: [] };
  const queryMatch = buildOcrMatches({ tokens: queryOcr.tokens, labels, text: queryOcr.text, words: [], config });
  const trustedMatch = buildOcrMatches({ tokens: trustedOcr.tokens, labels, text: trustedOcr.text, words: [], config });
  const queryScore = queryMatch.normalizedScore;
  const trustedScore = trustedMatch.normalizedScore;
  const baseScore = trustedScore === 0.0 ? queryScore : Math.max(queryScore, Math.min(queryScore, trustedScore));
  const mutualMatch = baseScore < config.ocrStrongDomainScore
    ? mutualLogoDomainToken(queryOcr.tokens, trustedOcr.tokens, labels, config)
    : undefined;
  const score = mutualMatch === undefined ? baseScore : config.ocrStrongDomainScore;
  const matchedTokens = [...queryMatch.exactMatches, ...queryMatch.substringMatches]
    .map((match) => match.token + "(" + match.label + ")");
  if (mutualMatch !== undefined) {
    matchedTokens.push("mutual:" + mutualMatch.token + "(" + mutualMatch.label + ")");
  }
  return {
    score: round(score, 4),
    queryText: queryOcr.text.split(/\s+/).filter(Boolean).join(" "),
    trustedText: trustedOcr.text.split(/\s+/).filter(Boolean).join(" "),
    matchedTokens: matchedTokens.join("|")
  };
}

function mutualLogoDomainToken(
  queryTokens: string[],
  trustedTokens: string[],
  labels: TrustedOcrLabel[],
  config: PipelineConfig
): { token: string; label: string } | undefined {
  for (const rawToken of queryTokens) {
    const token = rawToken.toLowerCase();
    if (token.length < 5 || config.ocrGenericDomainTokens.includes(token)) continue;
    if (!trustedTokens.some((trustedToken) => trustedToken.toLowerCase() === token)) continue;
    for (const label of labels) {
      if (label.kind === "main_domain" && label.label.includes(token)) {
        return { token, label: label.label };
      }
    }
  }
  return undefined;
}

function makeMatch(label: string, token: string, weight: number, textPositionRatio: number, ocrWords: OcrWord[]): OcrTokenMatch {
  return { label, token, weight, textPositionRatio, ocrWords };
}

function findOcrWordsForToken(words: OcrWord[], token: string): OcrWord[] {
  return words.filter((word) => word.token === token);
}

function findOcrWordsForLabel(words: OcrWord[], label: string): OcrWord[] {
  let labelTokens = new Set(tokenizeOcrText(label));
  if (labelTokens.size === 0) {
    const alt = label.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (alt.length >= 3) labelTokens = new Set([alt]);
  }
  if (labelTokens.size === 0) return [];
  return words.filter((word) => labelTokens.has(word.token));
}

function allOcrWordsSmallBottom(words: OcrWord[]): boolean {
  return words.length > 0 && words.every((word) => word.sizeBucket === "small" && word.region === "bottom");
}

function allOcrWordsInUiElement(words: OcrWord[], uiCoveredBoxes: CoverBox[]): boolean {
  if (words.length === 0 || uiCoveredBoxes.length === 0) return false;
  // Exclude degenerate boxes: hairline-thin strips (h < 25px) or extreme aspect
  // ratios (w/h > 20). These arise when Square/Weebly render form inputs as
  // nearly full-viewport-width underlines (e.g. 1888×19), which would otherwise
  // cover brand text that happens to sit in the same vertical band.
  const usableBoxes = uiCoveredBoxes.filter(isSignificantUiBox);
  if (usableBoxes.length === 0) return false;
  for (const word of words) {
    const width = Math.trunc(word.fullWidthPx ?? word.widthPx ?? 0);
    const height = Math.trunc(word.fullHeightPx ?? word.heightPx ?? 0);
    if (width <= 0 || height <= 0) continue;
    const box: BoxLike = {
      x: Math.trunc(word.fullX ?? word.x ?? 0),
      y: Math.trunc(word.fullY ?? word.y ?? 0),
      width,
      height
    };
    if (!boxIsCovered(box, usableBoxes)) return false;
  }
  return true;
}

function isSignificantUiBox(box: CoverBox): boolean {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  return h >= 25 && w <= h * 20;
}

function hasVisibleNonBottomExactOcrMatch(exactMatches: OcrTokenMatch[], config: PipelineConfig): boolean {
  for (const match of exactMatches) {
    if (match.weight < config.ocrExactDomainScore) continue;
    if (match.ocrWords.length === 0) continue;
    if (match.ocrWords.every((word) => word.sizeBucket !== "small" && word.region !== "bottom")) {
      return true;
    }
  }
  return false;
}

function formatOcrMatchesWithSize(matches: OcrTokenMatch[], config: PipelineConfig): string {
  return matches.map((match) => {
    const words = match.ocrWords;
    const positionText = match.textPositionRatio >= 0 ? `pos=${formatNumber(match.textPositionRatio)}` : "pos=unknown";
    if (words.length === 0) {
      return `${match.token}(${match.label}):0px:0:unknown:unknown:${positionText}`;
    }
    const heights = words.map((word) => word.heightPx).filter((height) => height > 0).sort((a, b) => a - b);
    const ratios = words.map((word) => word.heightRatio).filter((ratio) => ratio > 0).sort((a, b) => a - b);
    const medianHeight = heights.length > 0 ? round(median(heights), 2) : 0.0;
    const medianRatio = ratios.length > 0 ? round(median(ratios), 4) : 0.0;
    const bucket = medianRatio > 0 ? ocrSizeBucket(medianRatio, config) : "unknown";
    const locations = [...new Set(words.map((word) => `${word.third ?? "full"}_${word.region || "unknown"}`))].sort().join(",") || "unknown";
    return `${match.token}(${match.label}):${formatNumber(medianHeight)}px:${formatNumber(medianRatio)}:${bucket}:${locations}:${positionText}`;
  }).join("|");
}

function summarizeOcrMatchSizes(matches: OcrTokenMatch[]): Pick<OcrMatchResult, "matchedMinHeightPx" | "matchedMedianHeightPx" | "matchedMaxHeightPx" | "matchedMinHeightRatio" | "matchedMedianHeightRatio"> {
  const seen = new Set<string>();
  const words: OcrWord[] = [];
  for (const match of matches) {
    for (const word of match.ocrWords) {
      const key = [word.token, word.x, word.y, word.widthPx, word.heightPx].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      words.push(word);
    }
  }
  const heights = words.map((word) => word.heightPx).filter((height) => height > 0).sort((a, b) => a - b);
  const ratios = words.map((word) => word.heightRatio).filter((ratio) => ratio > 0).sort((a, b) => a - b);
  if (heights.length === 0) {
    return {
      matchedMinHeightPx: 0.0,
      matchedMedianHeightPx: 0.0,
      matchedMaxHeightPx: 0.0,
      matchedMinHeightRatio: 0.0,
      matchedMedianHeightRatio: 0.0
    };
  }
  return {
    matchedMinHeightPx: round(Math.min(...heights), 2),
    matchedMedianHeightPx: round(median(heights), 2),
    matchedMaxHeightPx: round(Math.max(...heights), 2),
    matchedMinHeightRatio: round(Math.min(...ratios), 4),
    matchedMedianHeightRatio: round(median(ratios), 4)
  };
}

function dedupeRejected(matches: OcrTokenMatch[]): OcrTokenMatch[] {
  const seen = new Set<string>();
  const output: OcrTokenMatch[] = [];
  for (const match of matches) {
    const key = `${match.label}:${match.token}:${match.textPositionRatio}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(match);
  }
  return output;
}

function median(values: number[]): number {
  if (values.length === 0) return 0.0;
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[mid] ?? 0.0;
  return ((values[mid - 1] ?? 0.0) + (values[mid] ?? 0.0)) / 2.0;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, "").replace(/\.$/, "");
}
