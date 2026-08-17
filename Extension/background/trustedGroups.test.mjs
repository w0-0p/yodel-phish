import { test } from "node:test";
import assert from "node:assert/strict";
import { createStorageDomain } from "./storageQueues.mjs";
import {
  MAX_TRUSTED_GROUP_MEMBERS,
  MAX_TRUSTED_GROUP_NAME_LENGTH,
  MAX_TRUSTED_GROUPS,
  addTrustedGroupDestination,
  countTrustedGroupMemberOrigins,
  createTrustedGroup,
  findTrustedGroupForOrigin,
  isValidTrustedGroupId,
  normalizeTrustedGroupName,
  removeTrustedGroupDestination,
  renameTrustedGroup,
  repairTrustedGroups,
} from "./trustedGroups.mjs";

let idCounter = 0;
function newId() {
  idCounter += 1;
  return `generated-${idCounter}`;
}

function variant(overrides = {}) {
  return {
    fqdn: "login.microsoftonline.com",
    etld1: "microsoftonline.com",
    protocol: "https",
    variant_id: "variant-1",
    storage_revision: "rev-1",
    user_words: [],
    scores: [],
    ...overrides,
  };
}

function origin(fqdn) {
  return { fqdn, etld1: fqdn, ocrDomain: fqdn.split(".")[0], protocol: "https" };
}

function twoMemberState(overrides = {}) {
  return {
    trusted_groups: [{ id: "group-1", name: "Microsoft sign-in" }],
    trusted_list: [
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-1", trust_group_id: "group-1" }),
      variant({ fqdn: "login.live.com", variant_id: "live-1", trust_group_id: "group-1" }),
    ],
    muted_list: [],
    ...overrides,
  };
}

// =============================================================================
// Validation primitives
// =============================================================================

test("group names are trimmed, non-empty and bounded; ids are bounded strings", () => {
  assert.equal(normalizeTrustedGroupName("  Microsoft sign-in  "), "Microsoft sign-in");
  assert.equal(normalizeTrustedGroupName(""), null);
  assert.equal(normalizeTrustedGroupName("   "), null);
  assert.equal(normalizeTrustedGroupName(42), null);
  assert.equal(normalizeTrustedGroupName("x".repeat(MAX_TRUSTED_GROUP_NAME_LENGTH)), "x".repeat(MAX_TRUSTED_GROUP_NAME_LENGTH));
  assert.equal(normalizeTrustedGroupName("x".repeat(MAX_TRUSTED_GROUP_NAME_LENGTH + 1)), null);

  assert.equal(isValidTrustedGroupId("group-1"), true);
  assert.equal(isValidTrustedGroupId(""), false);
  assert.equal(isValidTrustedGroupId("x".repeat(129)), false);
  assert.equal(isValidTrustedGroupId(7), false);
});

// =============================================================================
// Storage repair and migration
// =============================================================================

test("repair: a missing trusted_groups key migrates to an empty list without a rewrite", () => {
  const trusted = [variant()];
  const result = repairTrustedGroups({ trusted_list: trusted, muted_list: [] });

  assert.deepEqual(result.trusted_groups, []);
  assert.equal(result.trusted_list, trusted, "existing entries must be preserved by identity");
  assert.equal(result.changed, false, "an unwritten key is not a repair");
});

test("repair: a non-array trusted_groups is replaced and reported as a change", () => {
  const result = repairTrustedGroups({ trusted_groups: "oops", trusted_list: [], muted_list: [] });
  assert.deepEqual(result.trusted_groups, []);
  assert.equal(result.changed, true);
});

test("repair: existing trusted entries remain ungrouped — nothing is grouped automatically", () => {
  const trusted = [
    variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-1" }),
    variant({ fqdn: "login.live.com", variant_id: "live-1" }),
  ];
  const result = repairTrustedGroups({ trusted_groups: [], trusted_list: trusted, muted_list: [] });

  assert.equal(result.changed, false);
  assert.equal(result.trusted_list, trusted);
  assert.ok(result.trusted_list.every((entry) => !("trust_group_id" in entry)));
});

test("repair: malformed and duplicate group records are removed, names are trimmed", () => {
  const state = twoMemberState();
  const result = repairTrustedGroups({
    trusted_groups: [
      null,
      "not-an-object",
      { id: "", name: "empty id" },
      { id: "group-1", name: "  Microsoft sign-in  ", future_field: true },
      { id: "group-1", name: "duplicate id" },
      { id: "no-name" },
      { id: "blank-name", name: "   " },
      { id: "long-name", name: "x".repeat(MAX_TRUSTED_GROUP_NAME_LENGTH + 1) },
    ],
    trusted_list: state.trusted_list,
    muted_list: [],
  });

  assert.equal(result.changed, true);
  assert.equal(result.trusted_groups.length, 1);
  assert.equal(result.trusted_groups[0].id, "group-1");
  assert.equal(result.trusted_groups[0].name, "Microsoft sign-in");
  assert.equal(result.trusted_groups[0].future_field, true, "forward-compatible fields are preserved");
});

test("repair: duplicate group names are collapsed case-insensitively, dissolving the later group", () => {
  const result = repairTrustedGroups({
    trusted_groups: [
      { id: "group-1", name: "Microsoft sign-in" },
      { id: "group-2", name: "microsoft SIGN-IN" },
    ],
    trusted_list: [
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-1", trust_group_id: "group-1" }),
      variant({ fqdn: "login.live.com", variant_id: "live-1", trust_group_id: "group-1" }),
      variant({ fqdn: "a.example.com", variant_id: "a-1", trust_group_id: "group-2" }),
      variant({ fqdn: "b.example.com", variant_id: "b-1", trust_group_id: "group-2" }),
    ],
    muted_list: [],
  });

  assert.deepEqual(result.trusted_groups.map((group) => group.id), ["group-1"]);
  const cleared = result.trusted_list.filter((entry) => !("trust_group_id" in entry));
  assert.deepEqual(cleared.map((entry) => entry.fqdn).sort(), ["a.example.com", "b.example.com"]);
  assert.equal(result.trusted_list.length, 4, "the dissolved group's origins stay trusted");
});

test("repair: dangling trust_group_id values are cleared while the origin stays trusted", () => {
  const trusted = [
    variant({ fqdn: "a.example.com", variant_id: "a-1", trust_group_id: "gone", trust_group_manual: true }),
  ];
  const result = repairTrustedGroups({ trusted_groups: [], trusted_list: trusted, muted_list: [] });

  assert.equal(result.changed, true);
  assert.equal(result.trusted_list.length, 1);
  assert.equal("trust_group_id" in result.trusted_list[0], false);
  assert.equal("trust_group_manual" in result.trusted_list[0], false);
  assert.equal(result.trusted_list[0].fqdn, "a.example.com");
});

test("repair: inconsistent membership between variants of one origin fails closed", () => {
  const conflicting = repairTrustedGroups({
    trusted_groups: [
      { id: "group-1", name: "One" },
      { id: "group-2", name: "Two" },
    ],
    trusted_list: [
      variant({ fqdn: "a.example.com", variant_id: "a-1", trust_group_id: "group-1" }),
      variant({ fqdn: "a.example.com", variant_id: "a-2", trust_group_id: "group-2" }),
      variant({ fqdn: "b.example.com", variant_id: "b-1", trust_group_id: "group-1" }),
      variant({ fqdn: "c.example.com", variant_id: "c-1", trust_group_id: "group-2" }),
    ],
    muted_list: [],
  });
  assert.ok(
    conflicting.trusted_list
      .filter((entry) => entry.fqdn === "a.example.com")
      .every((entry) => !("trust_group_id" in entry)),
    "conflicting group ids across variants must clear the whole origin's membership"
  );

  const partial = repairTrustedGroups({
    trusted_groups: [{ id: "group-1", name: "One" }],
    trusted_list: [
      variant({ fqdn: "a.example.com", variant_id: "a-1", trust_group_id: "group-1" }),
      variant({ fqdn: "a.example.com", variant_id: "a-2" }),
      variant({ fqdn: "b.example.com", variant_id: "b-1", trust_group_id: "group-1" }),
    ],
    muted_list: [],
  });
  assert.ok(
    partial.trusted_list
      .filter((entry) => entry.fqdn === "a.example.com")
      .every((entry) => !("trust_group_id" in entry)),
    "a variant without the sibling's membership is inconsistent, so the origin fails closed"
  );
});

test("repair: only https origins can hold membership and muted entries never do", () => {
  const result = repairTrustedGroups({
    trusted_groups: [{ id: "group-1", name: "One" }],
    trusted_list: [
      variant({ fqdn: "file-abc.local", protocol: "file", variant_id: "f-1", trust_group_id: "group-1" }),
      variant({ fqdn: "a.example.com", variant_id: "a-1", trust_group_id: "group-1" }),
      variant({ fqdn: "b.example.com", variant_id: "b-1", trust_group_id: "group-1" }),
    ],
    muted_list: [
      { fqdn: "muted.example.com", protocol: "https", muted_until: "forever", trust_group_id: "group-1" },
    ],
  });

  assert.equal("trust_group_id" in result.trusted_list[0], false, "a file reference cannot be a group member");
  assert.equal("trust_group_id" in result.muted_list[0], false, "muted entries cannot belong to trusted groups");
  assert.deepEqual(result.trusted_groups.map((group) => group.id), ["group-1"], "the two https members keep the group alive");
});

test("repair: groups with fewer than two distinct member origins are dissolved", () => {
  const result = repairTrustedGroups({
    trusted_groups: [
      { id: "solo", name: "Solo" },
      { id: "empty", name: "Empty" },
      { id: "alive", name: "Alive" },
    ],
    trusted_list: [
      // Two variants of one exact origin are still one member.
      variant({ fqdn: "solo.example.com", variant_id: "s-1", trust_group_id: "solo" }),
      variant({ fqdn: "solo.example.com", variant_id: "s-2", trust_group_id: "solo" }),
      variant({ fqdn: "a.example.com", variant_id: "a-1", trust_group_id: "alive" }),
      variant({ fqdn: "b.example.com", variant_id: "b-1", trust_group_id: "alive" }),
    ],
    muted_list: [],
  });

  assert.deepEqual(result.trusted_groups.map((group) => group.id), ["alive"]);
  const soloVariants = result.trusted_list.filter((entry) => entry.fqdn === "solo.example.com");
  assert.equal(soloVariants.length, 2, "the dissolved group's origin keeps every trusted variant");
  assert.ok(soloVariants.every((entry) => !("trust_group_id" in entry)));
});

test("repair: a consistent state is returned by identity and repair is idempotent", () => {
  const state = twoMemberState();
  const first = repairTrustedGroups({
    trusted_groups: state.trusted_groups,
    trusted_list: state.trusted_list,
    muted_list: state.muted_list,
  });
  assert.equal(first.changed, false);
  assert.equal(first.trusted_groups, state.trusted_groups);
  assert.equal(first.trusted_list, state.trusted_list);
  assert.equal(first.muted_list, state.muted_list);

  const broken = {
    trusted_groups: [
      { id: "group-1", name: " Microsoft sign-in " },
      { id: "group-1", name: "dup" },
      { id: "solo", name: "Solo" },
    ],
    trusted_list: [
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-1", trust_group_id: "group-1" }),
      variant({ fqdn: "login.live.com", variant_id: "live-1", trust_group_id: "group-1" }),
      variant({ fqdn: "solo.example.com", variant_id: "s-1", trust_group_id: "solo" }),
      variant({ fqdn: "dangling.example.com", variant_id: "d-1", trust_group_id: "gone" }),
    ],
    muted_list: [],
  };
  const once = repairTrustedGroups(broken);
  assert.equal(once.changed, true);
  const twice = repairTrustedGroups({
    trusted_groups: once.trusted_groups,
    trusted_list: once.trusted_list,
    muted_list: once.muted_list,
  });
  assert.equal(twice.changed, false, "repairing repaired state must change nothing further");
  assert.equal(twice.trusted_groups, once.trusted_groups);
  assert.equal(twice.trusted_list, once.trusted_list);
});

// =============================================================================
// Group operations
// =============================================================================

test("create: links two exact trusted origins and stamps every variant, without visual data", () => {
  const state = {
    trusted_groups: [],
    // No logo_image, logo_features, embeddings — creation reads none of them.
    trusted_list: [
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-1" }),
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-2" }),
      variant({ fqdn: "login.live.com", variant_id: "live-1" }),
      variant({ fqdn: "other.example.com", variant_id: "o-1" }),
    ],
    muted_list: [],
  };
  const outcome = createTrustedGroup(state, {
    name: "  Microsoft sign-in  ",
    origins: [origin("login.microsoftonline.com"), origin("login.live.com")],
    newId,
  });

  assert.equal(outcome.status, "saved");
  assert.equal(outcome.changed, true);
  assert.deepEqual(state.trusted_groups, [{ id: outcome.groupId, name: "Microsoft sign-in" }]);
  const members = state.trusted_list.filter((entry) => entry.trust_group_id === outcome.groupId);
  assert.deepEqual(members.map((entry) => entry.variant_id).sort(), ["live-1", "ms-1", "ms-2"],
    "every variant of each member origin carries the id");
  assert.equal("trust_group_id" in state.trusted_list[3], false);
  assert.equal(countTrustedGroupMemberOrigins(state, outcome.groupId), 2);
});

test("create: rejects bad names, duplicates, missing origins, grouped origins, and caps", () => {
  const base = () => ({
    trusted_groups: [{ id: "existing", name: "Existing" }],
    trusted_list: [
      variant({ fqdn: "a.example.com", variant_id: "a-1" }),
      variant({ fqdn: "b.example.com", variant_id: "b-1" }),
      variant({ fqdn: "grouped.example.com", variant_id: "g-1", trust_group_id: "existing" }),
    ],
    muted_list: [],
  });
  const twoOrigins = [origin("a.example.com"), origin("b.example.com")];

  assert.equal(createTrustedGroup(base(), { name: "  ", origins: twoOrigins, newId }).status, "invalid_group_name");
  assert.equal(
    createTrustedGroup(base(), { name: "x".repeat(MAX_TRUSTED_GROUP_NAME_LENGTH + 1), origins: twoOrigins, newId }).status,
    "invalid_group_name"
  );
  assert.equal(createTrustedGroup(base(), { name: "EXISTING", origins: twoOrigins, newId }).status, "duplicate_group_name");
  assert.equal(createTrustedGroup(base(), { name: "New", origins: [origin("a.example.com")], newId }).status, "invalid_group");
  assert.equal(
    createTrustedGroup(base(), { name: "New", origins: [origin("a.example.com"), origin("a.example.com")], newId }).status,
    "invalid_group",
    "two mentions of one origin are not two distinct origins"
  );
  assert.equal(
    createTrustedGroup(base(), { name: "New", origins: [origin("a.example.com"), origin("missing.example.com")], newId }).status,
    "not_found"
  );
  assert.equal(
    createTrustedGroup(base(), { name: "New", origins: [origin("a.example.com"), origin("grouped.example.com")], newId }).status,
    "already_in_other_group"
  );
  assert.equal(
    createTrustedGroup(base(), { name: "New", origins: twoOrigins, newId, maxGroups: 1 }).status,
    "too_many_groups"
  );
  assert.equal(
    createTrustedGroup(base(), { name: "New", origins: twoOrigins, newId, maxMembers: 1 }).status,
    "group_full"
  );
  assert.equal(MAX_TRUSTED_GROUPS, 50);
  assert.equal(MAX_TRUSTED_GROUP_MEMBERS, 50);
});

test("create: rejects non-https origins and invalid or colliding generated ids", () => {
  const state = {
    trusted_groups: [{ id: "existing", name: "Existing" }],
    trusted_list: [
      variant({ fqdn: "a.example.com", protocol: "http", variant_id: "a-1" }),
      variant({ fqdn: "b.example.com", protocol: "http", variant_id: "b-1" }),
      variant({ fqdn: "c.example.com", variant_id: "c-1" }),
      variant({ fqdn: "d.example.com", variant_id: "d-1" }),
    ],
    muted_list: [],
  };
  const snapshot = structuredClone(state);

  assert.equal(createTrustedGroup(state, {
    name: "HTTP group",
    origins: [
      { ...origin("a.example.com"), protocol: "http" },
      { ...origin("b.example.com"), protocol: "http" },
    ],
    newId,
  }).status, "invalid_group");
  assert.equal(createTrustedGroup(state, {
    name: "Missing protocol",
    origins: [
      { fqdn: "c.example.com" },
      origin("d.example.com"),
    ],
    newId,
  }).status, "invalid_group");
  assert.equal(createTrustedGroup(state, {
    name: "Bad id",
    origins: [origin("c.example.com"), origin("d.example.com")],
    newId: () => "",
  }).status, "invalid_group");
  assert.equal(createTrustedGroup(state, {
    name: "Colliding id",
    origins: [origin("c.example.com"), origin("d.example.com")],
    newId: () => "existing",
  }).status, "invalid_group");
  assert.deepEqual(state, snapshot, "every rejected creation leaves storage state untouched");
});

test("rename: preserves the id and membership, trims the name, and rejects bad names", () => {
  const state = twoMemberState();
  const membersBefore = state.trusted_list.map((entry) => entry.trust_group_id);

  const outcome = renameTrustedGroup(state, { groupId: "group-1", name: "  Microsoft login  " });
  assert.equal(outcome.status, "saved");
  assert.equal(outcome.changed, true);
  assert.deepEqual(state.trusted_groups, [{ id: "group-1", name: "Microsoft login" }]);
  assert.deepEqual(state.trusted_list.map((entry) => entry.trust_group_id), membersBefore);

  assert.equal(renameTrustedGroup(state, { groupId: "group-1", name: "" }).status, "invalid_group_name");
  assert.equal(
    renameTrustedGroup(state, { groupId: "group-1", name: "x".repeat(MAX_TRUSTED_GROUP_NAME_LENGTH + 1) }).status,
    "invalid_group_name"
  );
  assert.equal(renameTrustedGroup(state, { groupId: "missing", name: "Anything" }).status, "not_found");

  state.trusted_groups = [...state.trusted_groups, { id: "group-2", name: "Other" }];
  assert.equal(
    renameTrustedGroup(state, { groupId: "group-1", name: "  OTHER " }).status,
    "duplicate_group_name",
    "names are unique under trimmed, case-insensitive comparison"
  );

  const sameName = renameTrustedGroup(state, { groupId: "group-1", name: "Microsoft login" });
  assert.equal(sameName.status, "saved");
  assert.equal(sameName.changed, false, "re-asserting the current name writes nothing");
});

test("add: an unknown hostname creates one manual trusted entry that joins the group", () => {
  const state = twoMemberState();
  const outcome = addTrustedGroupDestination(state, {
    groupId: "group-1",
    origin: origin("login.example.com"),
    timestamp: "2026-08-17T00:00:00.000Z",
    newId,
  });

  assert.equal(outcome.status, "saved");
  const created = state.trusted_list.filter((entry) => entry.fqdn === "login.example.com");
  assert.equal(created.length, 1);
  assert.equal(created[0].protocol, "https");
  assert.equal(created[0].trust_group_id, "group-1");
  assert.equal(created[0].trust_group_manual, true);
  assert.equal(created[0].manual_entry, true);
  assert.equal(created[0].needs_reference_capture, true, "the reference is captured on the next visit");
  assert.equal(countTrustedGroupMemberOrigins(state, "group-1"), 3);
});

test("add: an existing ungrouped origin assigns every variant without creating one", () => {
  const state = twoMemberState({
    trusted_list: [
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-1", trust_group_id: "group-1" }),
      variant({ fqdn: "login.live.com", variant_id: "live-1", trust_group_id: "group-1" }),
      variant({ fqdn: "login.example.com", variant_id: "e-1", storage_revision: "rev-e1" }),
      variant({ fqdn: "login.example.com", variant_id: "e-2", storage_revision: "rev-e2" }),
    ],
  });
  const outcome = addTrustedGroupDestination(state, {
    groupId: "group-1",
    origin: origin("login.example.com"),
    timestamp: "2026-08-17T00:00:00.000Z",
    newId,
  });

  assert.equal(outcome.status, "saved");
  const variants = state.trusted_list.filter((entry) => entry.fqdn === "login.example.com");
  assert.equal(variants.length, 2, "no additional variant is created");
  assert.ok(variants.every((entry) => entry.trust_group_id === "group-1"));
  assert.ok(variants.every((entry) => entry.trust_group_manual === true));
  assert.ok(variants.every((entry) => entry.storage_revision.startsWith("generated-")),
    "assigning membership rotates each variant's storage revision");
});

test("add: a muted hostname is moved to trusted and the group atomically", () => {
  const state = twoMemberState({
    muted_list: [{
      fqdn: "login.example.com",
      etld1: "example.com",
      protocol: "https",
      muted_until: "forever",
      user_words: ["kept"],
      scores: [],
    }],
  });
  const outcome = addTrustedGroupDestination(state, {
    groupId: "group-1",
    origin: origin("login.example.com"),
    timestamp: "2026-08-17T00:00:00.000Z",
    newId,
  });

  assert.equal(outcome.status, "saved");
  assert.equal(state.muted_list.length, 0, "never left in both lists");
  const moved = state.trusted_list.filter((entry) => entry.fqdn === "login.example.com");
  assert.equal(moved.length, 1);
  assert.equal(moved[0].trust_group_id, "group-1");
  assert.equal(moved[0].needs_reference_capture, true);
  assert.deepEqual(moved[0].user_words, ["kept"], "the muted record's provenance survives the move");
});

test("add: existing members, foreign members, unknown groups and full groups are rejected", () => {
  const state = twoMemberState({
    trusted_groups: [
      { id: "group-1", name: "Microsoft sign-in" },
      { id: "group-2", name: "Other" },
    ],
    trusted_list: [
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-1", trust_group_id: "group-1" }),
      variant({ fqdn: "login.live.com", variant_id: "live-1", trust_group_id: "group-1" }),
      variant({ fqdn: "a.example.com", variant_id: "a-1", trust_group_id: "group-2" }),
      variant({ fqdn: "b.example.com", variant_id: "b-1", trust_group_id: "group-2" }),
    ],
  });
  const snapshot = structuredClone(state);
  const attempt = (groupId, fqdn, options = {}) => addTrustedGroupDestination(state, {
    groupId,
    origin: origin(fqdn),
    timestamp: "2026-08-17T00:00:00.000Z",
    newId,
    ...options,
  });

  assert.equal(attempt("group-1", "login.live.com").status, "already_in_group");
  assert.equal(attempt("group-1", "a.example.com").status, "already_in_other_group");
  assert.equal(attempt("missing", "fresh.example.com").status, "invalid_group");
  assert.equal(attempt("group-1", "fresh.example.com", { maxMembers: 2 }).status, "group_full");
  assert.equal(attempt("group-1", "fresh.example.com", { maxManualSites: 0 }).status, "too_many_sites");
  assert.deepEqual(state, snapshot, "every rejection leaves the state untouched");
});

test("add: a non-https record for the hostname is rejected as a destination", () => {
  const fileTrusted = twoMemberState({
    trusted_list: [
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-1", trust_group_id: "group-1" }),
      variant({ fqdn: "login.live.com", variant_id: "live-1", trust_group_id: "group-1" }),
      variant({ fqdn: "file-abc.local", protocol: "file", variant_id: "f-1" }),
    ],
  });
  assert.equal(addTrustedGroupDestination(fileTrusted, {
    groupId: "group-1",
    origin: origin("file-abc.local"),
    timestamp: "2026-08-17T00:00:00.000Z",
    newId,
  }).status, "invalid_hostname");

  const fileMuted = twoMemberState({
    muted_list: [{ fqdn: "file-abc.local", protocol: "file", muted_until: "forever" }],
  });
  assert.equal(addTrustedGroupDestination(fileMuted, {
    groupId: "group-1",
    origin: origin("file-abc.local"),
    timestamp: "2026-08-17T00:00:00.000Z",
    newId,
  }).status, "invalid_hostname");
  assert.equal(fileMuted.muted_list.length, 1, "the muted record is not moved");
});

test("remove: a three-member group keeps its other members", () => {
  const state = twoMemberState({
    trusted_list: [
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-1", trust_group_id: "group-1" }),
      variant({ fqdn: "login.live.com", variant_id: "live-1", trust_group_id: "group-1" }),
      variant({ fqdn: "login.live.com", variant_id: "live-2", trust_group_id: "group-1" }),
      variant({ fqdn: "login.example.com", variant_id: "e-1", trust_group_id: "group-1" }),
    ],
  });
  const outcome = removeTrustedGroupDestination(state, { groupId: "group-1", fqdn: "login.live.com", newId });

  assert.equal(outcome.status, "saved");
  assert.equal(outcome.dissolved, false);
  assert.equal(state.trusted_list.some((entry) => entry.fqdn === "login.live.com"), false,
    "every visual variant of the removed origin is deleted");
  assert.deepEqual(state.trusted_groups, [{ id: "group-1", name: "Microsoft sign-in" }]);
  assert.ok(state.trusted_list.every((entry) => entry.trust_group_id === "group-1"),
    "the other members keep their membership");
});

test("remove: a two-member group dissolves and the remaining origin stays trusted, ungrouped", () => {
  const state = twoMemberState({
    trusted_list: [
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-1", trust_group_id: "group-1", trust_group_manual: true }),
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-2", trust_group_id: "group-1", trust_group_manual: true }),
      variant({ fqdn: "login.live.com", variant_id: "live-1", trust_group_id: "group-1" }),
    ],
  });
  const outcome = removeTrustedGroupDestination(state, { groupId: "group-1", fqdn: "login.live.com", newId });

  assert.equal(outcome.status, "saved");
  assert.equal(outcome.dissolved, true);
  assert.deepEqual(state.trusted_groups, [], "the group metadata is deleted");
  const remaining = state.trusted_list.filter((entry) => entry.fqdn === "login.microsoftonline.com");
  assert.equal(remaining.length, 2, "the remaining origin keeps every trusted variant");
  assert.ok(remaining.every((entry) => !("trust_group_id" in entry) && !("trust_group_manual" in entry)));
});

test("remove: stale group/hostname pairings are not_found and touch nothing", () => {
  const state = twoMemberState({
    trusted_groups: [
      { id: "group-1", name: "Microsoft sign-in" },
      { id: "group-2", name: "Other" },
    ],
    trusted_list: [
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-1", trust_group_id: "group-1" }),
      variant({ fqdn: "login.live.com", variant_id: "live-1", trust_group_id: "group-1" }),
      variant({ fqdn: "a.example.com", variant_id: "a-1", trust_group_id: "group-2" }),
      variant({ fqdn: "b.example.com", variant_id: "b-1", trust_group_id: "group-2" }),
      variant({ fqdn: "solo.example.com", variant_id: "s-1" }),
    ],
  });
  const snapshot = structuredClone(state);

  assert.equal(removeTrustedGroupDestination(state, { groupId: "missing", fqdn: "login.live.com", newId }).status, "not_found");
  assert.equal(removeTrustedGroupDestination(state, { groupId: "group-1", fqdn: "solo.example.com", newId }).status, "not_found");
  assert.equal(
    removeTrustedGroupDestination(state, { groupId: "group-2", fqdn: "login.live.com", newId }).status,
    "not_found",
    "the worker-verified membership rejects a UI claim pairing the wrong group"
  );
  assert.deepEqual(state, snapshot);
});

test("lookup: the group of an exact origin comes from its stored entries alone", () => {
  const state = twoMemberState();

  assert.equal(findTrustedGroupForOrigin(state, { protocol: "https", fqdn: "login.live.com" })?.id, "group-1");
  assert.equal(findTrustedGroupForOrigin(state, { fqdn: "login.live.com" })?.id, "group-1",
    "the protocol defaults to https");
  assert.equal(findTrustedGroupForOrigin(state, { protocol: "http", fqdn: "login.live.com" }), null,
    "a different protocol is a different exact origin");
  assert.equal(findTrustedGroupForOrigin(state, { fqdn: "unknown.example.com" }), null);
});

// =============================================================================
// Queue integration — group mutations share the trusted/muted domain.
// =============================================================================

function createFakeStorageArea(initial = {}) {
  let backing = structuredClone(initial);
  return {
    async get(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of keyList) result[key] = backing[key];
      return structuredClone(result);
    },
    async set(patch) {
      backing = { ...backing, ...structuredClone(patch) };
    },
    dump() {
      return structuredClone(backing);
    },
  };
}

// The exact domain shape the service worker builds: repair on load, and the
// group invariants re-asserted on persist so a mutation that empties a group
// commits the dissolution in the same write.
function createGroupedDomain(storageArea) {
  return createStorageDomain({
    storageArea,
    keys: ["trusted_list", "muted_list", "trusted_groups"],
    load(data) {
      const groups = repairTrustedGroups({
        trusted_groups: data.trusted_groups,
        trusted_list: Array.isArray(data.trusted_list) ? data.trusted_list : [],
        muted_list: Array.isArray(data.muted_list) ? data.muted_list : [],
      });
      return {
        state: {
          trusted_list: groups.trusted_list,
          muted_list: groups.muted_list,
          trusted_groups: groups.trusted_groups,
        },
        dirty: groups.changed,
      };
    },
    persist(state) {
      const groups = repairTrustedGroups(state);
      return {
        trusted_list: groups.trusted_list,
        muted_list: groups.muted_list,
        trusted_groups: groups.trusted_groups,
      };
    },
  });
}

test("concurrent trusted and group mutations serialize on one domain, neither overwritten", async () => {
  const storageArea = createFakeStorageArea({
    trusted_groups: [{ id: "group-1", name: "Microsoft sign-in" }],
    trusted_list: [
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-1", trust_group_id: "group-1" }),
      variant({ fqdn: "login.live.com", variant_id: "live-1", trust_group_id: "group-1" }),
    ],
    muted_list: [],
  });
  const withDomain = createGroupedDomain(storageArea);

  await Promise.all([
    withDomain((state) => {
      const outcome = renameTrustedGroup(state, { groupId: "group-1", name: "Renamed" });
      return { value: outcome.status, changed: outcome.changed };
    }),
    withDomain((state) => {
      const outcome = addTrustedGroupDestination(state, {
        groupId: "group-1",
        origin: origin("login.example.com"),
        timestamp: "2026-08-17T00:00:00.000Z",
        newId,
      });
      return { value: outcome.status, changed: outcome.changed };
    }),
  ]);

  const stored = storageArea.dump();
  assert.deepEqual(stored.trusted_groups, [{ id: "group-1", name: "Renamed" }], "the rename landed");
  assert.equal(
    stored.trusted_list.filter((entry) => entry.trust_group_id === "group-1").length,
    3,
    "the concurrently added destination landed too"
  );
});

test("a trusted-list mutation that empties a group dissolves it in the same committed write", async () => {
  const storageArea = createFakeStorageArea({
    trusted_groups: [{ id: "group-1", name: "Microsoft sign-in" }],
    trusted_list: [
      variant({ fqdn: "login.microsoftonline.com", variant_id: "ms-1", trust_group_id: "group-1" }),
      variant({ fqdn: "login.live.com", variant_id: "live-1", trust_group_id: "group-1" }),
    ],
    muted_list: [],
  });
  const withDomain = createGroupedDomain(storageArea);

  // The ordinary remove-trusted-entry mutation, exactly as the worker performs
  // it — no group awareness in the mutator at all.
  await withDomain((state) => {
    state.trusted_list = state.trusted_list.filter((entry) => entry.fqdn !== "login.live.com");
    return { value: undefined, changed: true };
  });

  const stored = storageArea.dump();
  assert.deepEqual(stored.trusted_groups, [], "no orphaned group waits for a later restart");
  assert.equal(stored.trusted_list.length, 1);
  assert.equal(stored.trusted_list[0].fqdn, "login.microsoftonline.com");
  assert.equal("trust_group_id" in stored.trusted_list[0], false, "no dangling trust_group_id either");
});
