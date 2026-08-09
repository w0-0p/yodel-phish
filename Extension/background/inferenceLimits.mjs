// Shared by the service worker and the offscreen document. Keep every
// service-worker message round trip comfortably below Chrome's five-minute
// per-request limit.
export const OFFSCREEN_STARTUP_TIMEOUT_MS = 35_000;
export const OFFSCREEN_PING_ATTEMPT_TIMEOUT_MS = 5_000;
export const OFFSCREEN_REQUEST_TIMEOUT_MS = 60_000;
export const QUEUE_WAIT_TIMEOUT_MS = 45_000;
export const OFFSCREEN_ROUND_TRIP_TIMEOUT_MS =
  QUEUE_WAIT_TIMEOUT_MS + OFFSCREEN_REQUEST_TIMEOUT_MS + 5_000;
export const JOB_TOTAL_TIMEOUT_MS = 280_000;
export const MESSAGE_RESPONSE_TIMEOUT_MS = 285_000;
export const GLOBAL_OFFSCREEN_CONCURRENCY = 1;
export const OFFSCREEN_QUEUE_CAPACITY = 8;

