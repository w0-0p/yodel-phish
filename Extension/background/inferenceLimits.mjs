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
// Issue #14 — a UX fallback, not a fault-containment limit. The automatic logo
// search behind "Add to trusted" only has to be quick enough that waiting for
// it beats picking the logo by hand; past this point the flow stops waiting and
// opens the manual selector instead. Nothing is treated as broken, so the
// limits above stay exactly as they are and keep containing genuine faults.
//
// The timer starts when the user clicks "Add to trusted", so it also covers
// offscreen runtime startup and screenshot preparation -- hence 30s rather than
// the 20s that would fit the logo-search step alone. Every add-to-trusted run
// records how long its search actually took (logo_search_ms in the analysis
// history), so this can later be retuned against the observed p95.
export const TRUSTED_ADD_LOGO_SEARCH_TIMEOUT_MS = 30_000;
export const GLOBAL_OFFSCREEN_CONCURRENCY = 1;
export const OFFSCREEN_QUEUE_CAPACITY = 8;

