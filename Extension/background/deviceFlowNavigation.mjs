// Pure navigation policy for Device Code Authentication (issue #75).
// Keeping transition and source-frame decisions outside the service worker
// makes the security boundaries directly testable without a fake Chrome.

export const DEVICE_FLOW_UNKNOWN_SOURCE = "unknown";

const DIRECT_TRANSITION_TYPES = new Set([
  "typed",
  "auto_bookmark",
  "generated",
  "start_page",
  "keyword",
  "keyword_generated",
]);

// Returns "direct" for browser-UI navigation, "preserve" when an existing
// relationship should survive, and "page" for document-driven navigation.
// Unknown future transition types fail safely as page-driven.
export function classifyDeviceFlowNavigation(details) {
  const qualifiers = Array.isArray(details?.transitionQualifiers)
    ? details.transitionQualifiers
    : [];
  if (qualifiers.includes("from_address_bar") || DIRECT_TRANSITION_TYPES.has(details?.transitionType)) {
    return "direct";
  }
  if (qualifiers.includes("forward_back") || details?.transitionType === "reload") {
    return "preserve";
  }
  return "page";
}

// Resolve the actual frame that opened a new target. Falling back to the
// top-level tab is safe only when the opener itself was the top-level frame;
// doing so for a missing child frame would grant the parent page's trust to an
// unrelated iframe.
export async function resolveDeviceFlowSourceOrigin(details, { getFrame, getTab }) {
  const sourceTabId = details?.sourceTabId;
  const sourceFrameId = details?.sourceFrameId;
  if (!Number.isInteger(sourceTabId) || sourceTabId < 0 ||
      !Number.isInteger(sourceFrameId) || sourceFrameId < 0) {
    return DEVICE_FLOW_UNKNOWN_SOURCE;
  }

  const frame = await Promise.resolve()
    .then(() => getFrame({ tabId: sourceTabId, frameId: sourceFrameId }))
    .catch(() => null);
  let candidateUrl = frame?.url;

  if ((typeof candidateUrl !== "string" || candidateUrl === "") && sourceFrameId === 0) {
    const tab = await Promise.resolve().then(() => getTab(sourceTabId)).catch(() => null);
    candidateUrl = tab?.url;
  }

  try {
    const parsed = new URL(candidateUrl);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin !== "null") {
      return parsed.origin;
    }
  } catch {
    // Opaque, missing, and malformed source URLs stay fail-closed.
  }
  return DEVICE_FLOW_UNKNOWN_SOURCE;
}
