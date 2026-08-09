import type { ImageRef, PipelineResult, PerTrustedResult } from "../core/types";

export type DebugEvent =
  | { type: "pipeline-start"; queryImageId: string; trustedCount: number }
  | { type: "per-trusted-result"; queryImageId: string; result: PerTrustedResult }
  | { type: "pipeline-result"; queryImageId: string; result: PipelineResult }
  | { type: "warning"; message: string; details?: unknown };

export interface DebugSink {
  emit(event: DebugEvent): void | Promise<void>;
  writeImage?(name: string, image: ImageRef, metadata?: Record<string, unknown>): Promise<string | undefined>;
  flush?(): Promise<void>;
}

export class NullDebugSink implements DebugSink {
  emit(): void {
    return undefined;
  }
}

