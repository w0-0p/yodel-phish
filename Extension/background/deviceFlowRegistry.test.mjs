import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DEVICE_FLOW_REGISTRY,
  canonicalizeHostname,
  canonicalizePath,
  normalizeDeviceFlowEndpointParts,
  isValidDeviceFlowHostname,
  isValidDeviceFlowPath,
  isTrustedDeviceFlowInitiator,
  matchDeviceFlowEndpoint,
  parseDeviceFlowEndpointInput,
} from "./deviceFlowRegistry.mjs";

test("every default registry entry matches its own exact URL", () => {
  for (const entry of DEFAULT_DEVICE_FLOW_REGISTRY) {
    const match = matchDeviceFlowEndpoint(`https://${entry.hostname}${entry.path}`, DEFAULT_DEVICE_FLOW_REGISTRY);
    assert.equal(match?.id, entry.id, `expected a match for ${entry.hostname}${entry.path}`);
  }
});

test("query strings, extra parameters, and fragments are ignored", () => {
  const url = "https://github.com/login/device?user_code=ABCD-EFGH&extra=1#section";
  const match = matchDeviceFlowEndpoint(url, DEFAULT_DEVICE_FLOW_REGISTRY);
  assert.equal(match?.provider, "GitHub");
});

test("a single optional trailing slash matches, but not a longer suffix", () => {
  assert.ok(matchDeviceFlowEndpoint("https://github.com/login/device/", DEFAULT_DEVICE_FLOW_REGISTRY));
  assert.equal(matchDeviceFlowEndpoint("https://github.com/login/device/extra", DEFAULT_DEVICE_FLOW_REGISTRY), null);
  assert.equal(matchDeviceFlowEndpoint("https://github.com/login/device//", DEFAULT_DEVICE_FLOW_REGISTRY), null);
});

test("hostname lookalikes and prefixes never match", () => {
  assert.equal(matchDeviceFlowEndpoint("https://github.com.attacker.test/login/device", DEFAULT_DEVICE_FLOW_REGISTRY), null);
  assert.equal(matchDeviceFlowEndpoint("https://notgithub.com/login/device", DEFAULT_DEVICE_FLOW_REGISTRY), null);
  assert.equal(matchDeviceFlowEndpoint("https://sub.github.com/login/device", DEFAULT_DEVICE_FLOW_REGISTRY), null);
});

test("path lookalikes and prefixes never match", () => {
  assert.equal(matchDeviceFlowEndpoint("https://github.com/login/device2", DEFAULT_DEVICE_FLOW_REGISTRY), null);
  assert.equal(matchDeviceFlowEndpoint("https://github.com/login/devices", DEFAULT_DEVICE_FLOW_REGISTRY), null);
  assert.equal(matchDeviceFlowEndpoint("https://github.com/login", DEFAULT_DEVICE_FLOW_REGISTRY), null);
});

test("a generic path only matches the specific registered authority", () => {
  // "/devicelogin" is registered only for microsoft.com, not an arbitrary host.
  assert.equal(matchDeviceFlowEndpoint("https://evil.example/devicelogin", DEFAULT_DEVICE_FLOW_REGISTRY), null);
});

test("plain http never matches", () => {
  assert.equal(matchDeviceFlowEndpoint("http://github.com/login/device", DEFAULT_DEVICE_FLOW_REGISTRY), null);
});

test("an account-picker-style extra query parameter still matches", () => {
  const url = "https://login.microsoftonline.com/common/oauth2/deviceauth?otc=1234-5678&login_hint=user%40example.com";
  const match = matchDeviceFlowEndpoint(url, DEFAULT_DEVICE_FLOW_REGISTRY);
  assert.equal(match?.provider, "Microsoft Entra");
});

test("malformed URLs and an empty registry are handled without throwing", () => {
  assert.equal(matchDeviceFlowEndpoint("not a url", DEFAULT_DEVICE_FLOW_REGISTRY), null);
  assert.equal(matchDeviceFlowEndpoint("https://github.com/login/device", []), null);
});

test("canonicalizeHostname lowercases and drops a trailing dot", () => {
  assert.equal(canonicalizeHostname("GitHub.com."), "github.com");
});

test("canonicalizePath strips exactly one trailing slash", () => {
  assert.equal(canonicalizePath("/a/"), "/a");
  assert.equal(canonicalizePath("/"), "/");
  assert.equal(canonicalizePath("/a"), "/a");
});
test("stored endpoint parts are normalized before persistence", () => {

  assert.deepEqual(normalizeDeviceFlowEndpointParts("  Login.Example.COM.  ", "/device/"),
    { hostname: "login.example.com", path: "/device" });
  assert.equal(normalizeDeviceFlowEndpointParts("not a hostname", "/device"), null);
});

test("isValidDeviceFlowHostname / Path reject malformed stored values", () => {
  assert.equal(isValidDeviceFlowHostname("login.example.com"), true);
  assert.equal(isValidDeviceFlowHostname("not a hostname"), false);
  assert.equal(isValidDeviceFlowHostname(""), false);
  assert.equal(isValidDeviceFlowHostname("a".repeat(300)), false);

  assert.equal(isValidDeviceFlowPath("/device"), true);
  assert.equal(isValidDeviceFlowPath("device"), false); // must start with /
  assert.equal(isValidDeviceFlowPath("/device?x=1"), false);
  assert.equal(isValidDeviceFlowPath("/device#frag"), false);
  assert.equal(isValidDeviceFlowPath("/has space"), false);
});

test("a user endpoint without a provider label matches on exact host and path", () => {
  const registry = [...DEFAULT_DEVICE_FLOW_REGISTRY, { id: "user-1", hostname: "sso.corp.example", path: "/device" }];
  const match = matchDeviceFlowEndpoint("https://sso.corp.example/device?user_code=X", registry);
  assert.equal(match?.id, "user-1");
  assert.equal(match.provider, undefined);
});

test("parseDeviceFlowEndpointInput accepts host/path with or without an https scheme", () => {
  assert.deepEqual(parseDeviceFlowEndpointInput("login.example.com/device"),
    { hostname: "login.example.com", path: "/device" });
  assert.deepEqual(parseDeviceFlowEndpointInput("https://login.example.com/device/"),
    { hostname: "login.example.com", path: "/device" });
  assert.deepEqual(parseDeviceFlowEndpointInput("  Login.Example.COM/device  "),
    { hostname: "login.example.com", path: "/device" });
});

test("parseDeviceFlowEndpointInput strips query and fragment", () => {
  assert.deepEqual(parseDeviceFlowEndpointInput("login.example.com/device?user_code=SECRET#top"),
    { hostname: "login.example.com", path: "/device" });
});

test("parseDeviceFlowEndpointInput rejects http, missing paths, and malformed input", () => {
  assert.equal(parseDeviceFlowEndpointInput("http://login.example.com/device"), null);
  assert.equal(parseDeviceFlowEndpointInput("login.example.com"), null);
  assert.equal(parseDeviceFlowEndpointInput("login.example.com/"), null);
  assert.equal(parseDeviceFlowEndpointInput("not a url"), null);
  assert.equal(parseDeviceFlowEndpointInput(""), null);
  assert.equal(parseDeviceFlowEndpointInput(42), null);
});

test("built-in trusted initiator policies are explicit, frozen, and consistent per provider", () => {
  const expected = new Map([
    ["Microsoft Entra", ["microsoft.com", "microsoftonline.com"]],
    ["Microsoft consumer/Xbox/Minecraft", ["microsoft.com", "live.com"]],
    ["GitHub", ["github.com"]],
    ["Google", ["google.com"]],
    ["Facebook", ["facebook.com"]],
    ["Docker", ["docker.com"]],
  ]);

  for (const entry of DEFAULT_DEVICE_FLOW_REGISTRY) {
    assert.deepEqual(entry.trustedInitiatorDomains, expected.get(entry.provider));
    assert.equal(Object.isFrozen(entry.trustedInitiatorDomains), true);
    entry.trustedInitiatorDomains.forEach((domain) => {
      assert.equal(domain, domain.toLowerCase());
      assert.doesNotMatch(domain, /[:/]/);
    });
  }
});

test("built-in initiator trust uses only the endpoint's explicit policy", () => {
  const entra = DEFAULT_DEVICE_FLOW_REGISTRY.find((entry) => entry.id === "seed-ms-entra-1");
  assert.equal(isTrustedDeviceFlowInitiator("https://portal.microsoft.com/start", entra), true);
  assert.equal(isTrustedDeviceFlowInitiator("https://login.microsoftonline.com/common", entra), true);
  assert.equal(isTrustedDeviceFlowInitiator("https://aka.ms/devicelogin", entra), false,
    "an endpoint or shortener domain is not automatically a trusted initiator");
  assert.equal(isTrustedDeviceFlowInitiator("https://microsoft.com.evil.test/start", entra), false);
  assert.equal(isTrustedDeviceFlowInitiator("https://evil-microsoft.com/start", entra), false);

  const sameLabelWithoutPolicy = {
    provider: entra.provider,
    hostname: "unlisted.example",
    path: "/device",
  };
  assert.equal(isTrustedDeviceFlowInitiator("https://microsoft.com/start", sameLabelWithoutPolicy), false,
    "the provider display label must never confer trust");
});

test("custom endpoints trust only their own registrable domain", () => {
  const custom = { id: "custom", hostname: "login.corp.example.com", path: "/device" };
  assert.equal(isTrustedDeviceFlowInitiator("https://portal.example.com/start", custom), true);
  assert.equal(isTrustedDeviceFlowInitiator("https://other.example.net/start", custom), false);

  const privateSuffixEndpoint = { id: "private", hostname: "tenant.github.io", path: "/device" };
  assert.equal(isTrustedDeviceFlowInitiator("https://app.tenant.github.io/start", privateSuffixEndpoint), true);
  assert.equal(isTrustedDeviceFlowInitiator("https://other.github.io/start", privateSuffixEndpoint), false);
});

test("malformed and non-web initiator origins are never trusted", () => {
  const github = DEFAULT_DEVICE_FLOW_REGISTRY.find((entry) => entry.provider === "GitHub");
  assert.equal(isTrustedDeviceFlowInitiator("not a URL", github), false);
  assert.equal(isTrustedDeviceFlowInitiator("file:///tmp/github.com", github), false);
  assert.equal(isTrustedDeviceFlowInitiator("about:blank", github), false);
  assert.equal(isTrustedDeviceFlowInitiator("https://github.com", null), false);
});
