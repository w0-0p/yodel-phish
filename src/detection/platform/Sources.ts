import type { ImageRef, TrustedEntry } from "../core/types";

export interface QueryImageSource {
  getQueryImages(): AsyncIterable<ImageRef>;
}

export interface TrustedSource {
  getTrustedEntries(): Promise<TrustedEntry[]>;
}

export interface BrowserScreenshotSource {
  captureVisibleTab(tabId: number): Promise<ImageRef>;
}

