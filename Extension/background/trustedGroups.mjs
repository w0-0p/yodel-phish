// =============================================================================
// TRUSTED DOMAIN GROUPS — issue #19. A group is a user-approved, named
// collection of at least two exact trusted origins (protocol + fqdn). Group
// membership is derived solely from the `trust_group_id` stored on exact
// trusted entries: it is management metadata for the Settings page and the
// future login-flow feature, and it is NEVER inferred from logos, visual
// similarity, redirects, or detection results. Every member remains an
// independently trusted exact origin because it exists in trusted_list; the
// group changes nothing about how a page is analysed.
//
// Storage shape:
//
//   trusted_groups: [{ id, name }]        — group records; membership lives on
//   trusted_list:   [{ ..., trust_group_id?, trust_group_manual? }]
//
// Invariants (repairTrustedGroups() re-establishes all of them):
//
//   - group ids are stable, non-empty and unique; names are trimmed, non-empty,
//     bounded, and unique under case-insensitive comparison;
//   - a trusted origin belongs to at most one group, and every visual variant
//     of one exact origin carries the same trust_group_id;
//   - only an https origin can be a member; muted entries never carry
//     membership;
//   - a referenced group exists, and a group keeps at least two distinct
//     member origins — anything smaller is dissolved, keeping the remaining
//     origin trusted but ungrouped.
//
// Like storageQueues.mjs this module has no chrome.* dependency, so it is unit
// tested under plain Node (trustedGroups.test.mjs). Every mutation the service
// worker performs with these helpers runs through the shared trusted/muted/
// group storage queue.
// =============================================================================

import { applyManualSiteMutation } from "./storageQueues.mjs";

export const MAX_TRUSTED_GROUPS = 50;
export const MAX_TRUSTED_GROUP_MEMBERS = 50;
export const MAX_TRUSTED_GROUP_NAME_LENGTH = 80;
const MAX_TRUSTED_GROUP_ID_LENGTH = 128;

export function isValidTrustedGroupId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TRUSTED_GROUP_ID_LENGTH;
}

/** The canonical display form of a group name, or null when it cannot be one. */
export function normalizeTrustedGroupName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_TRUSTED_GROUP_NAME_LENGTH ? name : null;
}

// Two groups may not differ only in letter case: the names exist to be told
// apart by a human.
export function trustedGroupNameKey(name) {
  return name.trim().toLowerCase();
}

// Exact origin identity for every group operation: protocol + fqdn, encoded as
// a JSON tuple so no delimiter that could appear in either component is relied
// on (the same trick ChromeTrustedSource uses for variant identity).
export function trustedGroupOriginKey(entry) {
  return JSON.stringify([entry.protocol ?? null, entry.fqdn]);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// An absent key is simply not written yet; anything else that is not an array
// has to be replaced by one.
function isMalformedList(value) {
  return value !== undefined && !Array.isArray(value);
}

function sameEntries(repaired, stored) {
  return repaired.length === stored.length && repaired.every((entry, index) => entry === stored[index]);
}

function carriesGroupFields(entry) {
  return "trust_group_id" in entry || "trust_group_manual" in entry;
}

function stripGroupFields(entry) {
  if (!isRecord(entry) || !carriesGroupFields(entry)) return entry;
  const stripped = { ...entry };
  delete stripped.trust_group_id;
  delete stripped.trust_group_manual;
  return stripped;
}

function hasGroupMembership(entry) {
  return typeof entry.trust_group_id === "string" && entry.trust_group_id.length > 0;
}

/** Distinct exact origins currently belonging to `groupId`. */
export function countTrustedGroupMemberOrigins(state, groupId) {
  const origins = new Set();
  for (const entry of state.trusted_list) {
    if (entry.trust_group_id === groupId) origins.add(trustedGroupOriginKey(entry));
  }
  return origins.size;
}

/** The group an exact origin belongs to, or null. Derived from stored entries only. */
export function findTrustedGroupForOrigin(state, origin) {
  const key = trustedGroupOriginKey({ protocol: origin.protocol ?? "https", fqdn: origin.fqdn });
  const member = state.trusted_list.find(
    (entry) => trustedGroupOriginKey(entry) === key && hasGroupMembership(entry)
  ) ?? null;
  if (member === null) return null;
  return state.trusted_groups.find((group) => group.id === member.trust_group_id) ?? null;
}

/**
 * Repairs one raw `{ trusted_groups, trusted_list, muted_list }` read into the
 * shape every consumer may assume, mirroring repairTrustedMutedLists (which
 * must run first, so the lists this sees are already entry objects):
 *
 *   - a missing trusted_groups key is an empty list, not a repair;
 *   - malformed group records, duplicate ids, and duplicate names are removed;
 *   - a dangling trust_group_id (group gone, non-https origin, or variants of
 *     one exact origin disagreeing about their membership) fails closed: the
 *     origin stays trusted, its membership is cleared;
 *   - muted entries never carry group fields;
 *   - a group left with fewer than two distinct member origins is dissolved,
 *     keeping the remaining origin trusted but clearing its trust_group_id.
 *
 * Existing entries are never grouped automatically. Unrelated and
 * forward-compatible fields on group records and entries are preserved, and
 * the repair is idempotent: unchanged inputs come back as the same objects,
 * which is also how `changed` is derived.
 */
export function repairTrustedGroups(data) {
  const rawGroups = data?.trusted_groups;
  const storedGroups = Array.isArray(rawGroups) ? rawGroups : [];
  const storedTrusted = Array.isArray(data?.trusted_list) ? data.trusted_list : [];
  const storedMuted = Array.isArray(data?.muted_list) ? data.muted_list : [];

  const seenIds = new Set();
  const seenNames = new Set();
  let groups = [];
  for (const record of storedGroups) {
    if (!isRecord(record) || !isValidTrustedGroupId(record.id) || seenIds.has(record.id)) continue;
    const name = normalizeTrustedGroupName(record.name);
    if (name === null) continue;
    const nameKey = trustedGroupNameKey(name);
    if (seenNames.has(nameKey)) continue;
    seenIds.add(record.id);
    seenNames.add(nameKey);
    groups.push(name === record.name ? record : { ...record, name });
  }

  const muted = storedMuted.map((entry) => stripGroupFields(entry));

  // What membership, if any, each exact origin can keep: every variant must
  // carry the same existing group id, and the origin must be https.
  const groupIds = new Set(groups.map((group) => group.id));
  const claimsByOrigin = new Map();
  for (const entry of storedTrusted) {
    const key = trustedGroupOriginKey(entry);
    let claims = claimsByOrigin.get(key);
    if (claims === undefined) {
      claims = new Set();
      claimsByOrigin.set(key, claims);
    }
    claims.add("trust_group_id" in entry ? entry.trust_group_id : undefined);
  }

  const membershipByOrigin = new Map();
  const memberOriginsByGroup = new Map();
  claimsByOrigin.forEach((claims, key) => {
    if (claims.size !== 1) return;
    const [claim] = claims;
    if (typeof claim !== "string" || !groupIds.has(claim)) return;
    const [protocol] = JSON.parse(key);
    if (protocol !== "https") return;
    membershipByOrigin.set(key, claim);
    let members = memberOriginsByGroup.get(claim);
    if (members === undefined) {
      members = new Set();
      memberOriginsByGroup.set(claim, members);
    }
    members.add(key);
  });

  const dissolved = new Set();
  for (const group of groups) {
    if ((memberOriginsByGroup.get(group.id)?.size ?? 0) < 2) dissolved.add(group.id);
  }
  if (dissolved.size > 0) groups = groups.filter((group) => !dissolved.has(group.id));

  const trusted = storedTrusted.map((entry) => {
    const membership = membershipByOrigin.get(trustedGroupOriginKey(entry));
    const keeps = membership !== undefined && !dissolved.has(membership);
    return keeps ? entry : stripGroupFields(entry);
  });

  const trusted_groups = sameEntries(groups, storedGroups) ? storedGroups : groups;
  const trusted_list = sameEntries(trusted, storedTrusted) ? storedTrusted : trusted;
  const muted_list = sameEntries(muted, storedMuted) ? storedMuted : muted;
  return {
    trusted_groups,
    trusted_list,
    muted_list,
    changed: isMalformedList(rawGroups) ||
      trusted_groups !== storedGroups || trusted_list !== storedTrusted || muted_list !== storedMuted,
  };
}

function stampGroupMembership(state, fqdn, groupId, newId, { manual }) {
  state.trusted_list = state.trusted_list.map((entry) => entry.fqdn === fqdn
    ? {
      ...entry,
      trust_group_id: groupId,
      ...(manual ? { trust_group_manual: true } : {}),
      storage_revision: newId(),
    }
    : entry);
}

function clearedGroupFields(entry, newId) {
  const cleared = { ...entry };
  delete cleared.trust_group_id;
  delete cleared.trust_group_manual;
  cleared.storage_revision = newId();
  return cleared;
}

/**
 * Creates a group from two or more distinct trusted exact origins. This is the
 * helper the future login-flow feature calls when the user validates a handoff
 * whose source has no group yet; nothing in this operation reads or compares
 * visual-reference data. Outcomes:
 *
 *   - `saved` (with `groupId`)   the group exists and every variant of every
 *                                member origin carries its id;
 *   - `invalid_group_name` / `duplicate_group_name` / `too_many_groups`
 *   - `invalid_group`            fewer than two distinct origins were given;
 *   - `group_full`               more origins than a group may hold;
 *   - `not_found`                an origin has no trusted entry;
 *   - `already_in_other_group`   an origin already belongs to a group.
 */
export function createTrustedGroup(state, {
  name,
  origins,
  newId,
  maxGroups = MAX_TRUSTED_GROUPS,
  maxMembers = MAX_TRUSTED_GROUP_MEMBERS,
}) {
  const groupName = normalizeTrustedGroupName(name);
  if (groupName === null) return { status: "invalid_group_name", changed: false };
  const nameKey = trustedGroupNameKey(groupName);
  if (state.trusted_groups.some((group) => trustedGroupNameKey(group.name) === nameKey)) {
    return { status: "duplicate_group_name", changed: false };
  }
  if (state.trusted_groups.length >= maxGroups) return { status: "too_many_groups", changed: false };

  const memberKeys = new Set();
  for (const origin of Array.isArray(origins) ? origins : []) {
    if (!isRecord(origin) || origin.protocol !== "https" ||
        typeof origin.fqdn !== "string" || origin.fqdn.length === 0) {
      return { status: "invalid_group", changed: false };
    }
    memberKeys.add(trustedGroupOriginKey(origin));
  }
  if (memberKeys.size < 2) return { status: "invalid_group", changed: false };
  if (memberKeys.size > maxMembers) return { status: "group_full", changed: false };

  for (const key of memberKeys) {
    const variants = state.trusted_list.filter((entry) => trustedGroupOriginKey(entry) === key);
    if (variants.length === 0) return { status: "not_found", changed: false };
    if (variants.some(hasGroupMembership)) return { status: "already_in_other_group", changed: false };
  }

  const groupId = newId();
  if (!isValidTrustedGroupId(groupId) || state.trusted_groups.some((group) => group.id === groupId)) {
    return { status: "invalid_group", changed: false };
  }
  state.trusted_groups = [...state.trusted_groups, { id: groupId, name: groupName }];
  state.trusted_list = state.trusted_list.map((entry) => memberKeys.has(trustedGroupOriginKey(entry))
    ? { ...entry, trust_group_id: groupId, storage_revision: newId() }
    : entry);
  return { status: "saved", changed: true, groupId };
}

/**
 * Renames a group, preserving its id and membership. `saved` even when the
 * name did not change (with `changed` false), otherwise `not_found`,
 * `invalid_group_name`, or `duplicate_group_name` (case-insensitive, other
 * groups only — re-casing a group's own name is a rename like any other).
 */
export function renameTrustedGroup(state, { groupId, name }) {
  const groupName = normalizeTrustedGroupName(name);
  if (groupName === null) return { status: "invalid_group_name", changed: false };
  const group = state.trusted_groups.find((candidate) => candidate.id === groupId) ?? null;
  if (group === null) return { status: "not_found", changed: false };
  const nameKey = trustedGroupNameKey(groupName);
  if (state.trusted_groups.some(
    (candidate) => candidate.id !== groupId && trustedGroupNameKey(candidate.name) === nameKey
  )) {
    return { status: "duplicate_group_name", changed: false };
  }
  if (group.name === groupName) return { status: "saved", changed: false, name: groupName };
  state.trusted_groups = state.trusted_groups.map(
    (candidate) => candidate.id === groupId ? { ...candidate, name: groupName } : candidate
  );
  return { status: "saved", changed: true, name: groupName };
}

/**
 * Adds one exact https origin to an existing group, atomically covering every
 * state the hostname can currently be in (issue #19's Advanced Settings "Add
 * destination" control, and the login-flow "source already has a group" path):
 *
 *   - unknown hostname          a manual trusted entry is created through
 *                               applyManualSiteMutation (manual_entry,
 *                               needs_reference_capture — the reference is
 *                               captured on the next visit) and joins the group;
 *   - muted hostname            moved to trusted by that same helper, exactly
 *                               like the manual "Add to Trusted" control, then
 *                               joins the group — never left in both lists;
 *   - ungrouped trusted origin  every visual variant is assigned to the group;
 *                               no new variant is created;
 *   - `already_in_group`        a member of this group already — a no-op;
 *   - `already_in_other_group`  membership is exclusive; nothing is moved or
 *                               merged implicitly;
 *   - `invalid_group`           the group does not exist;
 *   - `group_full`              the group holds its maximum distinct origins;
 *   - `invalid_hostname`        the hostname's trusted or muted record is not
 *                               an https origin (e.g. a local-file reference);
 *   - `too_many_sites`          bubbled from the manual-entry capacity.
 *
 * Every variant this operation touches carries `trust_group_manual: true`, the
 * provenance of a manually assigned membership.
 */
export function addTrustedGroupDestination(state, {
  groupId,
  origin,
  timestamp,
  newId,
  maxMembers = MAX_TRUSTED_GROUP_MEMBERS,
  maxManualSites = undefined,
}) {
  const group = state.trusted_groups.find((candidate) => candidate.id === groupId) ?? null;
  if (group === null) return { status: "invalid_group", changed: false };

  const variants = state.trusted_list.filter((entry) => entry.fqdn === origin.fqdn);
  if (variants.some((entry) => entry.trust_group_id === groupId)) {
    return { status: "already_in_group", changed: false };
  }
  if (variants.some(hasGroupMembership)) return { status: "already_in_other_group", changed: false };
  if (countTrustedGroupMemberOrigins(state, groupId) >= maxMembers) {
    return { status: "group_full", changed: false };
  }

  if (variants.length === 0) {
    const mutedEntry = state.muted_list.find((entry) => entry.fqdn === origin.fqdn) ?? null;
    if (mutedEntry !== null && mutedEntry.protocol !== "https") {
      return { status: "invalid_hostname", changed: false };
    }
    const outcome = applyManualSiteMutation(state, {
      listType: "trusted",
      origin,
      timestamp,
      newId,
      ...(maxManualSites === undefined ? {} : { maxManualSites }),
    });
    if (outcome.status !== "saved") return { status: outcome.status, changed: false };
  } else if (!variants.every((entry) => entry.protocol === "https")) {
    // Groups link https origins only; a trusted record for the same hostname
    // under another protocol is a different exact origin.
    return { status: "invalid_hostname", changed: false };
  }

  stampGroupMembership(state, origin.fqdn, groupId, newId, { manual: true });
  return { status: "saved", changed: true };
}

/**
 * Removes one exact member origin from a group. The hostname's current
 * membership in exactly the supplied group is verified here — the UI's claim
 * about the relationship is never trusted; a stale request is `not_found`.
 *
 * Every trusted visual variant of the removed origin is deleted (removal from
 * a group is removal from Trusted Sites, never a silently ungrouped-but-still-
 * trusted origin). The group is then reconciled atomically: with two or more
 * distinct member origins left it survives, otherwise it is dissolved — its
 * record deleted and the remaining origin kept trusted with its membership
 * fields cleared (`dissolved` reports which happened).
 */
export function removeTrustedGroupDestination(state, { groupId, fqdn, newId }) {
  const group = state.trusted_groups.find((candidate) => candidate.id === groupId) ?? null;
  if (group === null) return { status: "not_found", changed: false };
  if (!state.trusted_list.some((entry) => entry.fqdn === fqdn && entry.trust_group_id === groupId)) {
    return { status: "not_found", changed: false };
  }

  state.trusted_list = state.trusted_list.filter(
    (entry) => !(entry.fqdn === fqdn && entry.trust_group_id === groupId)
  );

  const dissolved = countTrustedGroupMemberOrigins(state, groupId) < 2;
  if (dissolved) {
    state.trusted_groups = state.trusted_groups.filter((candidate) => candidate.id !== groupId);
    state.trusted_list = state.trusted_list.map(
      (entry) => entry.trust_group_id === groupId ? clearedGroupFields(entry, newId) : entry
    );
  }
  return { status: "saved", changed: true, dissolved };
}
