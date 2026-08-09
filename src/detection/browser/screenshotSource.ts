import type { ImageRef } from "../core/types";
import type { CoverBox } from "../core/geometry/boxes";
import type { BrowserScreenshotSource } from "../platform/Sources";

interface ChromeTabsApi {
  get(tabId: number): Promise<{ active?: boolean; windowId?: number }>;
  captureVisibleTab(windowId: number | null, options: { format: "png" }): Promise<string>;
}

interface ChromeScriptingInjectionResult {
  result: unknown;
}

interface ChromeScriptingApi {
  executeScript(injection: {
    target: { tabId: number };
    func: () => unknown;
  }): Promise<ChromeScriptingInjectionResult[]>;
}

interface ChromeApi {
  tabs: ChromeTabsApi;
  scripting: ChromeScriptingApi;
}

interface CaptureTracker {
  begin(tabId: number, windowId: number): unknown;
  isCurrent(guard: unknown, tabId: number, windowId: number): boolean;
  end(guard: unknown): void;
}

declare const chrome: ChromeApi;

export class CaptureInterruptedError extends Error {
  readonly code = "capture_interrupted";

  constructor() {
    super("The active tab changed while it was being captured");
    this.name = "CaptureInterruptedError";
  }
}

export class ChromeScreenshotSource implements BrowserScreenshotSource {
  constructor(private readonly captures: CaptureTracker) {}

  async captureVisibleTab(tabId: number): Promise<ImageRef> {
    const before = await chrome.tabs.get(tabId);
    if (before.active !== true || before.windowId === undefined) {
      throw new Error("Cannot capture inactive tab " + tabId);
    }

    const guard = this.captures.begin(tabId, before.windowId);
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(before.windowId, { format: "png" });
      const after = await chrome.tabs.get(tabId);
      if (
        after.active !== true ||
        after.windowId !== before.windowId ||
        !this.captures.isCurrent(guard, tabId, after.windowId)
      ) {
        throw new CaptureInterruptedError();
      }
      return {
        id: `tab-${tabId}-${Date.now()}`,
        source: "browser-screenshot",
        mimeType: "image/png",
        dataUrl
      };
    } finally {
      this.captures.end(guard);
    }
  }
}

/**
 * UI element rectangles in CSS pixels, relative to the visible viewport — the
 * area chrome.tabs.captureVisibleTab() records — together with that viewport's
 * CSS size. Rectangles are raw: they may extend past the viewport and are not
 * yet in screenshot-pixel space. Callers convert both with the decoded
 * screenshot's real bitmap size (see Extension/background/uiCoverBoxes.mjs)
 * before handing the boxes to OCR matching, which measures word boxes in
 * screenshot pixels.
 */
export interface UiCoverCapture {
  boxes: CoverBox[];
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
}

// This function is deliberately self-contained: Chrome serializes it before
// running it in the page, so it cannot close over module-level declarations.
export function collectUiCoverCaptureFromDocument(): UiCoverCapture {
  const sel = 'input, button, select, textarea, [role="button"], [type="submit"], iframe';
  const maxBoxes = 256;
  const boxes: CoverBox[] = [];
  const seen = new Set<string>();

  const elements = document.querySelectorAll(sel);
  const examined = Math.min(elements.length, maxBoxes);
  for (let index = 0; index < examined; index += 1) {
    const el = elements.item(index);
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    // getBoundingClientRect() is viewport-relative and the screenshot is too.
    // Keep sub-pixel precision until conversion to decoded-image pixels.
    const box: CoverBox = [rect.left, rect.top, rect.right, rect.bottom];
    const key = box.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    boxes.push(box);
  }

  return {
    boxes,
    // innerWidth/innerHeight span the captured area, scrollbars included;
    // clientWidth/clientHeight are only fallbacks.
    viewportWidth: window.innerWidth || document.documentElement.clientWidth || 0,
    viewportHeight: window.innerHeight || document.documentElement.clientHeight || 0,
    scrollX: Number.isFinite(window.scrollX) ? window.scrollX : 0,
    scrollY: Number.isFinite(window.scrollY) ? window.scrollY : 0
  };
}

export async function collectUiCoveredBoxes(tabId: number): Promise<UiCoverCapture> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: collectUiCoverCaptureFromDocument
    });
    const raw = results[0]?.result as Partial<UiCoverCapture> | undefined;
    if (raw === undefined || raw === null) return emptyUiCoverCapture();
    return {
      boxes: Array.isArray(raw.boxes)
        ? raw.boxes.filter((b): b is CoverBox =>
          Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number")
        )
        : [],
      viewportWidth: typeof raw.viewportWidth === "number" ? raw.viewportWidth : 0,
      viewportHeight: typeof raw.viewportHeight === "number" ? raw.viewportHeight : 0,
      scrollX: typeof raw.scrollX === "number" ? raw.scrollX : 0,
      scrollY: typeof raw.scrollY === "number" ? raw.scrollY : 0
    };
  } catch {
    return emptyUiCoverCapture();
  }
}

function emptyUiCoverCapture(): UiCoverCapture {
  return { boxes: [], viewportWidth: 0, viewportHeight: 0, scrollX: 0, scrollY: 0 };
}
