import { defaultPipelineConfig } from "../core/config";
import { runDetection } from "../core/pipeline/runDetection";
import type { ImageRef, PipelineResult, TrustedEntry } from "../core/types";
import type { CoverBox } from "../core/geometry/boxes";
import type { DebugSink } from "../platform/DebugSink";
import type { PipelineServices } from "../platform/PipelineServices";

export async function runBrowserDetectionPipeline(input: {
  screenshot: ImageRef;
  trustedEntries: TrustedEntry[];
  services: PipelineServices;
  uiCoveredBoxes?: CoverBox[] | undefined;
  debug?: DebugSink | undefined;
}): Promise<PipelineResult> {
  return runDetection({
    queryImage: input.screenshot,
    trustedEntries: input.trustedEntries,
    config: defaultPipelineConfig,
    services: input.services,
    uiCoveredBoxes: input.uiCoveredBoxes,
    debug: input.debug
  });
}


export { createBrowserStackServices } from "./browserStackServices";
