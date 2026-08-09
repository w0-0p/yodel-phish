// =============================================================================
// STORAGE QUEUES — issue #13: centralize and serialize storage mutations.
//
// chrome.storage.local.get() followed by set() is not a transaction. Two
// concurrent read-modify-write cycles against the same key(s) can each read
// before the other writes, so the second write silently overwrites the
// first's result. This module gives every consistency domain (a set of keys
// that must be read and written together) one FIFO queue: every task queued
// against a domain runs only after every previously queued task on that same
// domain has settled, so a task's read always sees the latest committed
// state for its domain, never a snapshot a sibling task is racing to
// overwrite.
//
// No chrome.* dependency -- `storageArea` is injected so this can be unit
// tested under plain Node (see storageQueues.test.mjs), the same pattern
// offscreenQueue.mjs uses for the offscreen inference scheduler.
// =============================================================================

export class DomainQueue {
  #tail = Promise.resolve();

  /**
   * Runs `task` only after every previously queued task on this domain has
   * settled (resolved or rejected). Returns a promise for `task`'s own
   * outcome; a task's rejection never blocks tasks queued after it.
   */
  run(task) {
    const result = this.#tail.then(task);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/**
 * Builds a queued read-modify-write helper bound to one storage domain.
 *
 * - `keys`: the chrome.storage.local key(s) that make up this domain.
 * - `load(data)`: turns the raw get() result into `{ state, dirty }`, where
 *   `state` is the mutable object passed to callers' mutators and `dirty`
 *   flags a normalization/migration fix-up that must be persisted even if
 *   the mutator itself reports no change.
 * - `persist(state)`: turns `state` back into the object to set() when a
 *   commit is needed.
 * - `queue`: optional shared DomainQueue for helpers whose operations must be
 *   ordered together even when they load and persist different keys.
 *
 * The returned function takes a `mutator(state)` that may mutate `state` in
 * place (synchronously or via async work, e.g. an offscreen round trip) and
 * must return `{ value, changed }`. Every mutator sees the state as of the
 * moment its turn starts, not a snapshot taken earlier by its caller, which
 * is what makes a "read latest, apply the intended targeted change" pattern
 * safe under concurrency.
 */
export function createStorageDomain({ storageArea, keys, load, persist, queue = new DomainQueue() }) {
  return function withDomain(mutator) {
    return queue.run(async () => {
      const data = await storageArea.get(keys);
      const { state, dirty } = load(data);
      const outcome = await mutator(state);
      if (outcome.changed || dirty) {
        await storageArea.set(persist(state));
      }
      return outcome.value;
    });
  };
}

// =============================================================================
// TRUSTED/MUTED INVARIANTS — issue #12.
//
// A trusted fqdn may hold up to MAX_TRUSTED_VARIANTS_PER_FQDN reference
// variants: a drifted-but-still-acceptable capture is kept next to the older
// reference instead of overwriting it, so two trusted entries sharing an fqdn
// are NOT duplicates as long as their variant_id differs. Everything else
// about the two lists is an invariant defined and repaired here:
//
//   - both lists are arrays of non-null entry objects carrying a normalized,
//     non-empty fqdn;
//   - a trusted fqdn keeps at most MAX_TRUSTED_VARIANTS_PER_FQDN variants;
//   - every retained trusted variant has a non-empty variant_id, unique inside
//     its fqdn group. fqdn + variant_id is the identity the detection pipeline
//     caches a reference under (see ChromeTrustedSource), so a collision would
//     make two variants share one cache slot and silently compare a page
//     against the wrong reference;
//   - every trusted variant carries a storage_revision, which
//     compensateRevisionedEntry needs to undo exactly one commit;
//   - a muted fqdn has exactly one entry;
//   - no fqdn is in both lists. Repairing an existing overlap keeps the muted
//     entry, matching the order the runtime checks the lists in: a muted page
//     never reaches the trusted branch, so muted is what such a page already
//     behaves as.
//
// repairTrustedMutedLists() is idempotent: an entry that already satisfies the
// invariants is returned as the very same object, which is also how a caller
// detects that a repair was needed at all.
// =============================================================================

export const MAX_TRUSTED_VARIANTS_PER_FQDN = 2;
// Analysis score snapshots kept per entry (shared with the service worker's
// appendScore); older snapshots roll off.
export const MAX_STORED_SCORES = 3;
const MAX_FQDN_LENGTH = 253;
const MAX_VARIANT_ID_LENGTH = 128;
const ALLOWED_MUTED_UNTIL = new Set(["forever", "next_login"]);

/**
 * The canonical storage form of an fqdn: what parseOrigin() derives from a
 * URL, so a repaired entry is reachable by an ordinary lookup. Returns null
 * for anything that cannot be a host name.
 */
export function normalizeFqdn(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase().replace(/\.$/u, "");
  if (candidate.length === 0 || /[\/\\?#@:\s]/u.test(candidate)) return null;
  let fqdn;
  try {
    fqdn = new URL(`https://${candidate}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (fqdn.length === 0 || fqdn.length > MAX_FQDN_LENGTH) return null;
  const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  return fqdn.split(".").every((label) => validLabel.test(label)) ? fqdn : null;
}

/** How recent a stored reference variant is; "" when it has never been dated. */
export function variantRecency(entry) {
  if (typeof entry.updated_at === "string") return entry.updated_at;
  const scores = Array.isArray(entry.scores) ? entry.scores : [];
  const datetime = scores[scores.length - 1]?.datetime;
  return typeof datetime === "string" ? datetime : "";
}

/**
 * Trims every over-cap fqdn group down to `max` variants, using the eviction
 * policy refreshTrustedEntry applies: a manually chosen reference outranks an
 * automatic capture, then the most recent capture wins. Array.prototype.sort
 * is stable, so equally ranked variants keep their stored order and repeated
 * calls evict the same ones. Returns the original array when nothing is over
 * the cap, so callers can detect a no-op by identity.
 */
export function enforceTrustedVariantCap(entries, { max = MAX_TRUSTED_VARIANTS_PER_FQDN } = {}) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.fqdn);
    if (group === undefined) groups.set(entry.fqdn, [entry]);
    else group.push(entry);
  }

  const evicted = new Set();
  for (const group of groups.values()) {
    if (group.length <= max) continue;
    for (const entry of rankVariants(group).slice(max)) evicted.add(entry);
  }
  return evicted.size === 0 ? entries : entries.filter((entry) => !evicted.has(entry));
}

function rankVariants(variants) {
  return [...variants].sort(
    (left, right) => manualRank(right) - manualRank(left) || compareRecency(right, left)
  );
}

function manualRank(entry) {
  return entry.logo_source === "manual" ? 1 : 0;
}

function compareRecency(left, right) {
  const leftRecency = variantRecency(left);
  const rightRecency = variantRecency(right);
  if (leftRecency === rightRecency) return 0;
  return leftRecency < rightRecency ? -1 : 1;
}

function isEntryObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isLogoRegion(value) {
  return isEntryObject(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    value.width > 0 &&
    value.height > 0 &&
    (value.colorHist === undefined ||
      (Array.isArray(value.colorHist) && value.colorHist.every(isFiniteNumber)));
}

function isShapeMask(value) {
  if (!isEntryObject(value) ||
      !Number.isInteger(value.width) || value.width <= 0 ||
      !Number.isInteger(value.height) || value.height <= 0 ||
      !Array.isArray(value.data) ||
      !value.data.every(isFiniteNumber)) {
    return false;
  }
  return value.data.length === value.width * value.height;
}

function isLogoOcr(value) {
  return isEntryObject(value) &&
    typeof value.text === "string" &&
    isStringArray(value.tokens);
}

function isLogoFeature(value, seen = new Set()) {
  if (!isEntryObject(value) || seen.has(value) ||
      !isFiniteNumber(value.index) || !isLogoRegion(value.region)) {
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

function filterArray(value, predicate) {
  if (!Array.isArray(value)) return [];
  const filtered = value.filter(predicate);
  return filtered.length === value.length ? value : filtered;
}

// Collects the repairs both lists share, without building a new object for an
// entry that needs none.
function planSharedRepair(entry, fqdn) {
  const patch = {};
  const dropped = [];
  if (entry.fqdn !== fqdn) patch.fqdn = fqdn;
  // A screenshot is analysis input, never part of a stored record.
  if ("screenshot" in entry) dropped.push("screenshot");

  for (const field of ["user_words", "ocr_words"]) {
    if (!(field in entry)) continue;
    const repaired = filterArray(entry[field], (item) => typeof item === "string");
    if (repaired !== entry[field]) patch[field] = repaired;
  }
  if ("scores" in entry) {
    const repaired = filterArray(entry.scores, isEntryObject);
    if (repaired !== entry.scores) patch.scores = repaired;
  }

  const optionalArrayValidators = {
    logo_regions: (value) => Array.isArray(value) && value.every(isLogoRegion),
    logo_features: (value) => Array.isArray(value) && value.every((feature) => isLogoFeature(feature)),
    dinov2_embedding: (value) => Array.isArray(value) && value.every(isFiniteNumber),
  };
  for (const [field, validator] of Object.entries(optionalArrayValidators)) {
    if (field in entry && !validator(entry[field])) dropped.push(field);
  }
  return { patch, dropped };
}

function applyRepair(entry, patch, dropped) {
  if (Object.keys(patch).length === 0 && dropped.length === 0) return entry;
  const repaired = { ...entry, ...patch };
  for (const field of dropped) delete repaired[field];
  return repaired;
}

function repairTrustedEntry(entry, newId, variantIdsByFqdn) {
  if (!isEntryObject(entry)) return null;
  const fqdn = normalizeFqdn(entry.fqdn);
  if (fqdn === null) return null;

  const { patch, dropped } = planSharedRepair(entry, fqdn);

  let taken = variantIdsByFqdn.get(fqdn);
  if (taken === undefined) {
    taken = new Set();
    variantIdsByFqdn.set(fqdn, taken);
  }
  const stored = entry.variant_id;
  const variantId = typeof stored === "string" && stored.trim().length > 0 &&
    stored.length <= MAX_VARIANT_ID_LENGTH && !taken.has(stored)
    ? stored
    : newId();
  taken.add(variantId);
  if (variantId !== stored) patch.variant_id = variantId;

  if (typeof entry.storage_revision !== "string" || entry.storage_revision.length === 0) {
    patch.storage_revision = newId();
  }

  return applyRepair(entry, patch, dropped);
}

function repairMutedEntry(entry, seenFqdns) {
  if (!isEntryObject(entry)) return null;
  const fqdn = normalizeFqdn(entry.fqdn);
  if (fqdn === null || seenFqdns.has(fqdn)) return null;
  seenFqdns.add(fqdn);
  const { patch, dropped } = planSharedRepair(entry, fqdn);
  const mutedUntil = ALLOWED_MUTED_UNTIL.has(entry.muted_until) ? entry.muted_until : "forever";
  if (entry.muted_until !== mutedUntil) patch.muted_until = mutedUntil;
  return applyRepair(entry, patch, dropped);
}

function sameEntries(repaired, stored) {
  return repaired.length === stored.length && repaired.every((entry, index) => entry === stored[index]);
}

// An absent key is simply not written yet, not a value in need of repair;
// anything else that is not an array has to be replaced by one.
function isMalformedList(value) {
  return value !== undefined && !Array.isArray(value);
}

/**
 * Repairs one raw `{ trusted_list, muted_list }` storage read into the shape
 * every consumer is allowed to assume. `newId` is injected so the repair is
 * deterministic under test; `changed` reports whether anything had to be
 * rewritten, so a caller can persist the repair through the same serialized
 * queue as an ordinary mutation instead of as a side effect of a bare read.
 */
/**
 * Issue #7: stores a confirmed manual logo and reports where it landed, so the
 * selector flow can only be completed once the intended variant actually holds
 * it. One of three outcomes:
 *
 *   - `saved`          the targeted variant now carries the manual reference;
 *   - `entry_missing`  that variant was removed while the logo was being
 *                      processed and this session may not create one, so there
 *                      is nothing to write;
 *   - `variant_capped` the per-fqdn cap evicted the variant being added.
 *
 * `changed` is false for every outcome that wrote nothing: a save the user is
 * waiting on must never look like a committed write.
 *
 * `targetVariantId` is the variant the selector was opened for; when it is
 * absent any variant of the fqdn is updated (an add flow that finds the site
 * already trusted refreshes it instead of duplicating it). `addition` carries
 * what a brand new entry needs, or is null when this session may only update.
 */
export function applyManualLogoSelection(state, {
  fqdn,
  targetVariantId,
  logo,
  timestamp,
  storageRevision,
  addition = null,
}) {
  const entry = findTrustedVariant(state.trusted_list, fqdn, targetVariantId);
  if (entry !== null) {
    const before = { ...entry };
    Object.assign(entry, manualLogoFields(logo), {
      updated_at: timestamp,
      storage_revision: storageRevision,
    });
    delete entry.needs_reference_capture;
    if (addition !== null) {
      // Issue #90 routes every explicit add through this path, so an add that
      // finds the site already trusted still records its analysis snapshot and
      // visit date the way the old inline commit did.
      entry.scores = [...(entry.scores ?? []), ...addition.scores].slice(-MAX_STORED_SCORES);
      entry.last_visited = addition.lastVisited;
    }
    return {
      status: "saved",
      variantId: entry.variant_id,
      changed: true,
      commit: {
        isNew: false,
        fqdn: entry.fqdn,
        variantId: entry.variant_id,
        revision: storageRevision,
        before,
      },
    };
  }

  if (addition === null) return { status: "entry_missing", changed: false };

  const mutedIndex = state.muted_list.findIndex((item) => item.fqdn === addition.origin.fqdn);
  const mutedBefore = mutedIndex === -1 ? null : { ...state.muted_list[mutedIndex] };
  const previousVariants = state.trusted_list.filter((item) => item.fqdn === addition.origin.fqdn);
  const trustedList = enforceTrustedVariantCap([
    ...state.trusted_list,
    {
      fqdn: addition.origin.fqdn,
      storage_revision: storageRevision,
      etld1: addition.origin.etld1,
      protocol: addition.origin.protocol,
      ...(addition.origin.sourceUrl === undefined ? {} : { source_url: addition.origin.sourceUrl }),
      variant_id: addition.variantId,
      ocr_domain: addition.origin.ocrDomain,
      ...manualLogoFields(logo),
      user_words: [],
      scores: addition.scores,
      last_visited: addition.lastVisited,
      updated_at: timestamp,
    },
  ]);
  // The cap ranks and evicts what it was just handed, so the appended variant
  // is not guaranteed to be part of the result.
  if (findTrustedVariant(trustedList, addition.origin.fqdn, addition.variantId) === null) {
    return { status: "variant_capped", changed: false };
  }

  const retainedVariantIds = new Set(trustedList.map((item) => item.variant_id));
  const displaced = previousVariants.find((item) => !retainedVariantIds.has(item.variant_id));

  // Issue #12: trusting an fqdn removes its muted entry.
  state.muted_list = state.muted_list.filter((item) => item.fqdn !== addition.origin.fqdn);
  state.trusted_list = trustedList;
  return {
    status: "saved",
    variantId: addition.variantId,
    changed: true,
    commit: {
      isNew: displaced === undefined,
      fqdn: addition.origin.fqdn,
      variantId: addition.variantId,
      revision: storageRevision,
      ...(displaced === undefined ? {} : { before: { ...displaced } }),
      mutedBefore,
      mutedIndex,
    },
  };
}

function manualLogoFields(logo) {
  return {
    logo_image: logo.logo_image,
    logo_regions: logo.logo_regions,
    logo_features: logo.logo_features,
    ocr_words: logo.ocr_words,
    dinov2_embedding: logo.dinov2_embedding,
    logo_source: "manual",
  };
}

// Mirrors the service worker's findByVariant: an absent variant id means "any
// variant of this fqdn", which is how an add flow reaches an existing entry.
function findTrustedVariant(entries, fqdn, variantId) {
  if (typeof variantId !== "string" || variantId.length === 0) {
    return entries.find((entry) => entry.fqdn === fqdn) ?? null;
  }
  return entries.find((entry) => entry.fqdn === fqdn && entry.variant_id === variantId) ?? null;
}

export function repairTrustedMutedLists(data, {
  newId = () => crypto.randomUUID(),
  max = MAX_TRUSTED_VARIANTS_PER_FQDN,
} = {}) {
  const rawTrusted = data?.trusted_list;
  const rawMuted = data?.muted_list;
  const storedTrusted = Array.isArray(rawTrusted) ? rawTrusted : [];
  const storedMuted = Array.isArray(rawMuted) ? rawMuted : [];

  const mutedFqdns = new Set();
  const muted_list = [];
  for (const entry of storedMuted) {
    const repaired = repairMutedEntry(entry, mutedFqdns);
    if (repaired !== null) muted_list.push(repaired);
  }

  const variantIdsByFqdn = new Map();
  const trusted = [];
  for (const entry of storedTrusted) {
    const repaired = repairTrustedEntry(entry, newId, variantIdsByFqdn);
    if (repaired !== null && !mutedFqdns.has(repaired.fqdn)) trusted.push(repaired);
  }
  const trusted_list = enforceTrustedVariantCap(trusted, { max });

  return {
    trusted_list,
    muted_list,
    changed: isMalformedList(rawTrusted) || isMalformedList(rawMuted) ||
      !sameEntries(trusted_list, storedTrusted) || !sameEntries(muted_list, storedMuted),
  };
}

// =============================================================================
// MANUAL SITE MANAGEMENT — issue #93. The Advanced Settings page can add exact
// hostnames straight to the trusted or muted list, without visiting the site.
// Entries created (or edited) this way carry `manual_entry: true`, the
// provenance "Reset to defaults" uses to remove exactly them: it survives
// edits, moves between the lists, reference capture and drift refresh
// (service_worker.js propagates it to every variant of a manual fqdn). A
// hostname moved here out of the opposite list keeps that record's own
// provenance, so a site added through the normal in-page flow never becomes
// reset-removable merely because the move was performed from Advanced
// Settings.
// =============================================================================

export const MAX_MANUAL_SITES = 50;

/**
 * Adds (`previousFqdn` null) or edits (`previousFqdn` set) one manually
 * managed hostname. `origin` carries the already-normalized new hostname and
 * its derived fields ({ fqdn, etld1, ocrDomain }). Enforces the trusted/muted
 * mutual exclusion and the issue #93 duplicate rules in one atomic step:
 *
 *   - `saved`            the mutation landed; `changed` is true;
 *   - `already_trusted`/
 *     `already_muted`    the hostname is already in the target list — a no-op,
 *                        which also rejects editing onto a same-list hostname;
 *   - `not_found`        the edit's previous hostname is no longer a manual
 *                        entry of the target list;
 *   - `too_many_sites`   the manual-entry capacity would be exceeded.
 *
 * A trusted addition never carries reference data: like the Muted tab's "Move
 * to Trusted", the new variant owes one threshold-independent capture on its
 * next analysed visit. An edit deliberately reuses nothing from the previous
 * hostname — the old entry is removed outright and the new hostname starts
 * fresh (a hostname moved from the opposite list keeps that record's words and
 * history, exactly like the existing move flows).
 */
export function applyManualSiteMutation(state, {
  listType,
  origin,
  previousFqdn = null,
  timestamp,
  newId,
  maxManualSites = MAX_MANUAL_SITES,
}) {
  const fqdn = origin.fqdn;
  const sameList = listType === "trusted" ? state.trusted_list : state.muted_list;

  if (previousFqdn !== null &&
      !sameList.some((entry) => entry.fqdn === previousFqdn && entry.manual_entry === true)) {
    return { status: "not_found", changed: false };
  }

  if (sameList.some((entry) => entry.fqdn === fqdn)) {
    return { status: listType === "trusted" ? "already_trusted" : "already_muted", changed: false };
  }

  const oppositeList = listType === "trusted" ? state.muted_list : state.trusted_list;
  const oppositeEntries = oppositeList.filter((entry) => entry.fqdn === fqdn);
  // A new destination continues to be manual after an edit. If the
  // destination already came from the opposite list, preserve that record's
  // provenance so Reset never starts deleting an in-page entry.
  const manual = oppositeEntries.length === 0 ||
    oppositeEntries.some((entry) => entry.manual_entry === true);

  if (manual) {
    const manualFqdns = new Set(
      sameList
        .filter((entry) => entry.manual_entry === true && entry.fqdn !== previousFqdn)
        .map((entry) => entry.fqdn)
    );
    if (manualFqdns.size >= maxManualSites) return { status: "too_many_sites", changed: false };
  }
  const provenance = manual ? { manual_entry: true } : {};

  if (listType === "trusted") {
    if (previousFqdn !== null) {
      state.trusted_list = state.trusted_list.filter((entry) => entry.fqdn !== previousFqdn);
    }
    const movedMute = oppositeEntries[0] ?? null;
    state.muted_list = state.muted_list.filter((entry) => entry.fqdn !== fqdn);
    const base = movedMute === null
      ? {
        fqdn,
        etld1: origin.etld1,
        protocol: "https",
        ocr_domain: origin.ocrDomain,
        user_words: [],
        scores: [],
      }
      : { ...movedMute, muted_until: undefined };
    state.trusted_list = enforceTrustedVariantCap([
      ...state.trusted_list,
      {
        ...base,
        variant_id: newId(),
        storage_revision: newId(),
        updated_at: timestamp,
        needs_reference_capture: true,
        ...provenance,
      },
    ]);
    return { status: "saved", changed: true };
  }

  if (previousFqdn !== null) {
    state.muted_list = state.muted_list.filter((entry) => entry.fqdn !== previousFqdn);
  }
  // Issue #12: muting removes every trusted variant of the hostname.
  state.trusted_list = state.trusted_list.filter((entry) => entry.fqdn !== fqdn);
  const lastVisited = oppositeEntries.find(
    (entry) => typeof entry.last_visited === "string" && entry.last_visited.length > 0
  )?.last_visited;
  state.muted_list = [
    ...state.muted_list,
    {
      fqdn,
      etld1: origin.etld1,
      protocol: "https",
      muted_until: "forever",
      user_words: [],
      scores: [],
      ...(lastVisited === undefined ? {} : { last_visited: lastVisited }),
      ...provenance,
    },
  ];
  return { status: "saved", changed: true };
}

/**
 * Removes one manually managed hostname. Reports false — leaving the lists
 * untouched — when the hostname is not a manual entry of that list, so the
 * Advanced Settings controls can never delete an in-page record. A manual
 * trusted hostname loses every variant, including a drift capture stored next
 * to the manual reference: it is still that hostname's data.
 */
export function removeManualSiteEntries(state, listType, fqdn) {
  if (listType === "trusted") {
    if (!state.trusted_list.some((entry) => entry.fqdn === fqdn && entry.manual_entry === true)) return false;
    state.trusted_list = state.trusted_list.filter((entry) => entry.fqdn !== fqdn);
    return true;
  }
  const entry = state.muted_list.find((item) => item.fqdn === fqdn) ?? null;
  if (entry === null || entry.manual_entry !== true) return false;
  state.muted_list = state.muted_list.filter((item) => item.fqdn !== fqdn);
  return true;
}

/**
 * "Reset to default settings" (issue #93): removes every entry that carries
 * manual provenance — however much it was edited, moved or enriched since —
 * while every in-page record stays. Reports whether anything was removed.
 */
export function removeAllManualSiteEntries(state) {
  const manualTrustedFqdns = new Set(
    state.trusted_list.filter((entry) => entry.manual_entry === true).map((entry) => entry.fqdn)
  );
  const trusted = state.trusted_list.filter((entry) => !manualTrustedFqdns.has(entry.fqdn));
  const muted = state.muted_list.filter((entry) => entry.manual_entry !== true);
  const changed = trusted.length !== state.trusted_list.length || muted.length !== state.muted_list.length;
  state.trusted_list = trusted;
  state.muted_list = muted;
  return changed;
}

/**
 * Applies a targeted compensation only while the exact revision written by
 * the original commit is still current. Every later entry mutation must rotate
 * `storage_revision`, preventing compensation from erasing newer user edits.
 */
export function compensateRevisionedEntry(entries, commit) {
  const index = entries.findIndex(
    (entry) => entry.fqdn === commit.fqdn &&
      entry.variant_id === commit.variantId &&
      entry.storage_revision === commit.revision
  );
  if (index === -1) return { entries, changed: false };
  return {
    entries: commit.isNew
      ? entries.filter((_entry, entryIndex) => entryIndex !== index)
      : entries.map((entry, entryIndex) => (entryIndex === index ? commit.before : entry)),
    changed: true,
  };
}

/**
 * Reverts the trusted half of an add-to-trusted commit and restores the mute
 * that same commit removed. The mute is restored only when the exact trusted
 * revision is still current; any newer same-fqdn mutation removes or revises
 * that trusted entry, making compensation a deliberate no-op.
 */
export function compensateTrustedMutedCommit(trustedEntries, mutedEntries, commit) {
  const trustedOutcome = compensateRevisionedEntry(trustedEntries, commit);
  if (!trustedOutcome.changed) {
    return { trustedEntries, mutedEntries, changed: false };
  }

  let restoredMuted = mutedEntries;
  if (isEntryObject(commit.mutedBefore)) {
    const withoutFqdn = mutedEntries.filter((entry) => entry.fqdn !== commit.fqdn);
    const index = Number.isInteger(commit.mutedIndex)
      ? Math.max(0, Math.min(commit.mutedIndex, withoutFqdn.length))
      : withoutFqdn.length;
    restoredMuted = [
      ...withoutFqdn.slice(0, index),
      commit.mutedBefore,
      ...withoutFqdn.slice(index),
    ];
  }

  return {
    trustedEntries: trustedOutcome.entries,
    mutedEntries: restoredMuted,
    changed: true,
  };
}
