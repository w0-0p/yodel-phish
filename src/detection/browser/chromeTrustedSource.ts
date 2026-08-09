import type { LogoRegion, LogoRegionFeature, TrustedEntry } from "../core/types";
import type { TrustedSource } from "../platform/Sources";

interface ChromeStorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

interface ChromeApi {
  storage: { local: ChromeStorageArea };
}

declare const chrome: ChromeApi;

// What the service worker stores per trusted reference. Every field is read as
// `unknown`: chrome.storage.local is shared, migrated, user-visible state, so a
// record reaching this reader may predate any given field or have been written
// by an older build. The service worker repairs these records (see the storage
// invariants in Extension/background/storageQueues.mjs); this reader still
// validates them, because a malformed record must degrade one reference rather
// than break the whole detection run.
interface StoredTrustedEntry {
  fqdn?: unknown;
  variant_id?: unknown;
  etld1?: unknown;
  protocol?: unknown;
  ocr_domain?: unknown;
  ocr_words?: unknown;
  user_words?: unknown;
  logo_regions?: unknown;
  logo_features?: unknown;
  dinov2_embedding?: unknown;
}

export class ChromeTrustedSource implements TrustedSource {
  async getTrustedEntries(): Promise<TrustedEntry[]> {
    const data = await chrome.storage.local.get(["trusted_list"]);
    const storedList: unknown[] = Array.isArray(data.trusted_list) ? data.trusted_list : [];

    const entries: TrustedEntry[] = [];
    const seenIds = new Set<string>();
    for (const record of storedList) {
      const entry = toTrustedEntry(record);
      if (entry === null) continue;
      // Two references sharing an id would also share the pipeline's
      // per-trusted caches, so a record that cannot be told apart from one
      // already accepted is skipped instead of silently merged into it.
      if (seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      entries.push(entry);
    }
    return entries;
  }
}

function toTrustedEntry(record: unknown): TrustedEntry | null {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const stored = record as StoredTrustedEntry;

  const fqdn = normalizedFqdn(stored.fqdn);
  if (fqdn === null) return null;

  const etld1 = optionalString(stored.etld1);
  const variantId = validVariantId(stored.variant_id);
  const trusted: TrustedEntry = {
    id: trustedVariantIdentity(fqdn, variantId),
    fqdn,
    ocrDomain: optionalString(stored.ocr_domain) ?? etld1?.split(".")[0] ?? fqdn.split(".")[0] ?? "",
    ocrLabels: [...stringArray(stored.ocr_words), ...stringArray(stored.user_words)]
  };

  if (variantId !== undefined) trusted.variantId = variantId;
  if (etld1 !== undefined) trusted.etld1 = etld1;
  const protocol = optionalString(stored.protocol);
  if (protocol !== undefined) trusted.protocol = protocol;
  const logoRegions = logoRegionArray(stored.logo_regions);
  if (logoRegions !== null) trusted.logoRegions = logoRegions;
  const logoFeatures = logoFeatureArray(stored.logo_features);
  if (logoFeatures !== null) trusted.logoFeatures = logoFeatures;
  const embedding = numberArray(stored.dinov2_embedding);
  if (embedding !== null) trusted.dinoV2Embedding = embedding;

  return trusted;
}

// One fqdn may hold several saved reference variants, so the identity the
// pipeline caches a reference under is the variant, not the domain: keying by
// fqdn alone would let one variant's regions, features, and crops be reused for
// the other and compare a page against a reference it was never captured from.
// JSON tuple encoding keeps legacy and variant identities collision-free without
// relying on a delimiter that could also appear in either component.
function trustedVariantIdentity(fqdn: string, variantId: string | undefined): string {
  return JSON.stringify([fqdn, variantId ?? null]);
}

function normalizedFqdn(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase().replace(/\.$/u, "");
  if (candidate.length === 0 || /[\/\\?#@:\s]/u.test(candidate)) return null;
  try {
    const fqdn = new URL(`https://${candidate}`).hostname.toLowerCase();
    if (fqdn.length === 0 || fqdn.length > 253) return null;
    const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
    return fqdn.split(".").every((label) => validLabel.test(label)) ? fqdn : null;
  } catch {
    return null;
  }
}

function validVariantId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLogoRegion(value: unknown): value is LogoRegion {
  return isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    value.width > 0 &&
    value.height > 0 &&
    (value.colorHist === undefined ||
      (Array.isArray(value.colorHist) && value.colorHist.every(isFiniteNumber)));
}

function isShapeMask(value: unknown): boolean {
  return isRecord(value) &&
    Number.isInteger(value.width) && Number(value.width) > 0 &&
    Number.isInteger(value.height) && Number(value.height) > 0 &&
    Array.isArray(value.data) &&
    value.data.every(isFiniteNumber) &&
    value.data.length === Number(value.width) * Number(value.height);
}

function isLogoOcr(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.text === "string" &&
    Array.isArray(value.tokens) &&
    value.tokens.every((token) => typeof token === "string");
}

function isLogoFeature(value: unknown, seen = new Set<object>()): value is LogoRegionFeature {
  if (!isRecord(value) || seen.has(value) || !isFiniteNumber(value.index) || !isLogoRegion(value.region)) {
    return false;
  }
  seen.add(value);
  const valid = (value.trimmedRegion === undefined || isLogoRegion(value.trimmedRegion)) &&
    (value.shapeMask === undefined || isShapeMask(value.shapeMask)) &&
    (value.visualRejectReason === undefined || typeof value.visualRejectReason === "string") &&
    (value.ocr === undefined || isLogoOcr(value.ocr)) &&
    (value.components === undefined ||
      (Array.isArray(value.components) && value.components.every((component) => isLogoFeature(component, seen))));
  seen.delete(value);
  return valid;
}

function logoRegionArray(value: unknown): LogoRegion[] | null {
  return Array.isArray(value) && value.every(isLogoRegion) ? value : null;
}

function logoFeatureArray(value: unknown): LogoRegionFeature[] | null {
  return Array.isArray(value) && value.every((feature) => isLogoFeature(feature)) ? value : null;
}

// A partially numeric embedding would poison every similarity it takes part in,
// so it is discarded whole rather than repaired.
function numberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const isNumeric = value.every((item) => typeof item === "number" && Number.isFinite(item));
  return isNumeric ? (value as number[]) : null;
}
