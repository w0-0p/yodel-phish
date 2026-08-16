// =============================================================================
// OFFSCREEN QUEUE — issue #9: bound analysis execution with a global inference
// queue, timeouts, and cancellation.
//
// A small, dependency-free scheduler that serializes access to a shared,
// expensive resource (the inference Worker's OpenCV/OCR/ONNX runtime) behind
// a documented concurrency limit, a bounded queue, and per-request timeouts.
// It has no chrome.* dependency so it can run and be unit-tested under plain
// Node — all browser-specific behavior (creating/recycling the offscreen
// document, sending the actual chrome.runtime message) is injected by the
// caller via the `run` function passed to schedule() and the `onTimeout` hook.
//
// Model:
//   - Work is submitted as schedule(key, run, { requestTimeoutMs, cancelRun }).
//     `key` is whatever the caller considers "the same slot" (this extension
//     uses the tabId, since at most one job may be current per tab).
//   - A new call under a key already queued or running SUPERSEDES the old
//     ticket: if it was still queued, it is removed before it ever starts; if
//     it was already running, only its caller-facing promise is rejected —
//     the real run() keeps executing untouched (see "why not recycle on
//     supersession" in Requirements/extension.md) and still keeps its own
//     requestTimeoutMs countdown.
//   - Concurrency bookkeeping (a slot is "occupied") is tied to the REAL run()
//     settling, never to when the caller-facing promise settles. This means
//     the scheduler never believes a resource is free while it is still
//     actually busy, even after a caller has been rejected early (timeout or
//     supersession). Explicit cancellation/timeout may additionally stop the
//     real task when its ticket supplied the optional cancelRun hook.
//   - Capacity is counted in distinct keys currently queued+running;
//     superseding an existing key never consumes extra capacity.
// =============================================================================

/** Rejection reason codes: "superseded" | "queue_overloaded" | "queue_wait_timeout" | "request_timeout" | "cancelled" */
export class SchedulerError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "SchedulerError";
    this.code = code;
  }
}

export class OffscreenQueue {
  #concurrency;
  #maxQueueLength;
  #queueWaitTimeoutMs;
  #onTimeout;
  #queue = [];
  #runningByKey = new Map();
  #runningCount = 0;

  constructor({ concurrency = 1, maxQueueLength = 8, queueWaitTimeoutMs, onTimeout } = {}) {
    this.#concurrency = concurrency;
    this.#maxQueueLength = maxQueueLength;
    this.#queueWaitTimeoutMs = queueWaitTimeoutMs;
    this.#onTimeout = onTimeout;
  }

  get queueLength() {
    return this.#queue.length;
  }

  get runningCount() {
    return this.#runningCount;
  }

  /**
   * Schedule `run` (an async function taking no arguments) under `key`.
   * Returns a promise that resolves/rejects with run()'s outcome, or rejects
   * early with a SchedulerError on supersession, overload, or timeout. Never
   * throws synchronously.
   */
  schedule(key, run, { requestTimeoutMs, ticketId, cancelRun } = {}) {
    const queuedIndex = this.#queue.findIndex((ticket) => ticket.key === key);
    let supersededQueued = null;
    if (queuedIndex !== -1) {
      [supersededQueued] = this.#queue.splice(queuedIndex, 1);
    }
    const supersededRunning = this.#runningByKey.get(key);

    const isNewKey = supersededQueued === null && supersededRunning === undefined;

    const callerPromise = new Promise((resolve, reject) => {
      if (isNewKey && this.#distinctKeyCount() >= this.#maxQueueLength) {
        reject(new SchedulerError("queue_overloaded", "Offscreen queue is at capacity"));
        return;
      }

      const ticket = {
        key,
        ticketId,
        run,
        cancelRun,
        requestTimeoutMs,
        resolveCaller: resolve,
        rejectCaller: reject,
        callerSettled: false,
        realRunCancelled: false,
        queuedAt: Date.now(),
        queueTimeoutHandle: undefined,
      };

      if (this.#queueWaitTimeoutMs !== undefined) {
        ticket.queueTimeoutHandle = setTimeout(() => {
          const index = this.#queue.indexOf(ticket);
          if (index !== -1) this.#queue.splice(index, 1);
          this.#settleCaller(
            ticket,
            new SchedulerError("queue_wait_timeout", `Queued longer than ${this.#queueWaitTimeoutMs}ms`)
          );
        }, this.#queueWaitTimeoutMs);
      }

      this.#queue.push(ticket);
      this.#pump();
    });

    // Reject the superseded tickets' callers *after* the new ticket is queued
    // (order doesn't matter functionally, but keeps schedule() side effects
    // grouped together for anyone reading a trace).
    if (supersededQueued !== null) {
      if (supersededQueued.queueTimeoutHandle !== undefined) clearTimeout(supersededQueued.queueTimeoutHandle);
      this.#settleCaller(supersededQueued, new SchedulerError("superseded", "Superseded by a newer request for the same key"));
    }
    if (supersededRunning !== undefined) {
      this.#settleCaller(supersededRunning, new SchedulerError("superseded", "Superseded by a newer request for the same key"));
    }

    return callerPromise;
  }

  /**
   * Cancel queued and running tickets for `key` (optionally restricted to one
   * ticket ID). Returns independent flags because a superseding request can
   * leave one ticket running and a newer ticket queued under the same key.
   */
  cancel(key, reason = "cancelled", { ticketId } = {}) {
    const matches = (ticket) =>
      ticket.key === key && (ticketId === undefined || ticket.ticketId === ticketId);
    const queuedIndex = this.#queue.findIndex(matches);
    let queued = false;
    let running = false;
    if (queuedIndex !== -1) {
      const [ticket] = this.#queue.splice(queuedIndex, 1);
      if (ticket.queueTimeoutHandle !== undefined) clearTimeout(ticket.queueTimeoutHandle);
      this.#settleCaller(ticket, new SchedulerError("cancelled", reason));
      queued = true;
    }

    const runningTicket = this.#runningByKey.get(key);
    if (runningTicket !== undefined && matches(runningTicket)) {
      this.#cancelRealRun(runningTicket, reason);
      this.#settleCaller(runningTicket, new SchedulerError("cancelled", reason));
      running = true;
    }

    return { queued, running };
  }

  #pump() {
    while (this.#runningCount < this.#concurrency && this.#queue.length > 0) {
      const runnableIndex = this.#queue.findIndex((ticket) => !this.#runningByKey.has(ticket.key));
      if (runnableIndex === -1) return;
      const [ticket] = this.#queue.splice(runnableIndex, 1);
      if (ticket.queueTimeoutHandle !== undefined) {
        clearTimeout(ticket.queueTimeoutHandle);
        ticket.queueTimeoutHandle = undefined;
      }
      this.#start(ticket);
    }
  }

  #start(ticket) {
    this.#runningByKey.set(ticket.key, ticket);
    this.#runningCount += 1;

    let timeoutHandle;
    const runPromise = (async () => ticket.run())();

    // Always attach a handler to the REAL run() promise, independent of the
    // caller-facing race below. This is what actually frees the concurrency
    // slot (only once the resource is genuinely free) and is what prevents an
    // "unhandled rejection" warning when a request times out and the real
    // call later fails on its own (e.g. because the caller recycled the
    // underlying resource out from under it).
    runPromise.then(
      (value) => this.#onRealSettle(ticket, undefined, value),
      (error) => this.#onRealSettle(ticket, error, undefined)
    );

    const racers = [runPromise];
    if (ticket.requestTimeoutMs !== undefined) {
      racers.push(
        new Promise((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            const error = new SchedulerError("request_timeout", `Offscreen request timed out after ${ticket.requestTimeoutMs}ms`);
            reject(error);
            // Queue the public timeout rejection before cancelRun synchronously
            // rejects the underlying Worker RPC. Otherwise the termination error
            // can win Promise.race() and hide the stable request_timeout code.
            ticket.realRunCancelled = this.#cancelRealRun(ticket, error.message);
          }, ticket.requestTimeoutMs);
        })
      );
    }

    Promise.race(racers).then(
      (value) => this.#settleCaller(ticket, undefined, value),
      async (error) => {
        this.#settleCaller(ticket, error);
        if (error instanceof SchedulerError && error.code === "request_timeout" && !ticket.realRunCancelled) {
          await this.#safeOnTimeout(ticket);
        }
      }
    ).finally(() => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    });
  }

  #onRealSettle(ticket, error, value) {
    if (this.#runningByKey.get(ticket.key) === ticket) this.#runningByKey.delete(ticket.key);
    this.#runningCount -= 1;
    // If the caller wasn't already settled early (timeout/supersession), this
    // real outcome IS the caller's result.
    this.#settleCaller(ticket, error, value);
    this.#pump();
  }

  #settleCaller(ticket, error, value) {
    if (ticket.callerSettled) return;
    ticket.callerSettled = true;
    if (error !== undefined) ticket.rejectCaller(error);
    else ticket.resolveCaller(value);
  }

  // Most scheduler tasks cannot be interrupted safely, so cancelRun is
  // deliberately opt-in. The inference runtime supplies it because that work
  // lives in a dedicated Worker: terminating the Worker rejects the real
  // run() promise as well as its caller-facing promise, which means the global
  // slot is released only after the resource has genuinely stopped.
  #cancelRealRun(ticket, reason) {
    if (typeof ticket.cancelRun !== "function") return false;
    try {
      return ticket.cancelRun(reason) === true;
    } catch (error) {
      console.error("[OffscreenQueue] cancelRun hook failed:", error);
      return false;
    }
  }

  #distinctKeyCount() {
    return new Set([
      ...this.#runningByKey.keys(),
      ...this.#queue.map((ticket) => ticket.key),
    ]).size;
  }

  async #safeOnTimeout(ticket) {
    if (typeof this.#onTimeout !== "function") return;
    try {
      await this.#onTimeout(ticket);
    } catch (error) {
      console.error("[OffscreenQueue] onTimeout hook failed:", error);
    }
  }
}
