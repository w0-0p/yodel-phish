// Owns the one heavyweight inference Worker used by the offscreen coordinator.
// Successful requests reuse the warmed Worker. Cancelling an in-flight ticket
// terminates it, rejects the real request promise, and lets the coordinator
// create a fresh runtime lazily for the next request.

export class InferenceWorkerError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "InferenceWorkerError";
    this.code = code;
  }
}

export class InferenceWorkerClient {
  #createWorker;
  #workerUrl;
  #worker = null;
  #pending = new Map();
  #nextRequestId = 1;
  #readyPromise = null;
  #activeTicketId = null;

  constructor({ workerUrl, createWorker = (url) => new Worker(url) }) {
    this.#workerUrl = workerUrl;
    this.#createWorker = createWorker;
  }

  ready() {
    if (this.#readyPromise === null) {
      this.#readyPromise = this.#request({ type: "ping" })
        .then(() => undefined)
        .catch((error) => {
          this.#readyPromise = null;
          throw error;
        });
    }
    return this.#readyPromise;
  }

  async run(message, ticketId) {
    if (this.#activeTicketId !== null) {
      throw new InferenceWorkerError("worker_busy", "Inference Worker already has an active request");
    }
    this.#activeTicketId = ticketId;
    try {
      await this.ready();
      return await this.#request({ type: "run", message });
    } finally {
      if (this.#activeTicketId === ticketId) this.#activeTicketId = null;
    }
  }

  terminate(ticketId, reason = "cancelled") {
    if (this.#activeTicketId === null || this.#activeTicketId !== ticketId) return false;
    this.#activeTicketId = null;
    this.#destroy(new InferenceWorkerError("cancelled", reason));
    return true;
  }

  dispose(reason = "disposed") {
    this.#activeTicketId = null;
    this.#destroy(new InferenceWorkerError("cancelled", reason));
  }

  #ensureWorker() {
    if (this.#worker !== null) return this.#worker;
    const worker = this.#createWorker(this.#workerUrl);
    worker.addEventListener("message", (event) => this.#handleMessage(worker, event.data));
    worker.addEventListener("error", (event) => {
      event.preventDefault?.();
      const message = typeof event.message === "string" && event.message.length > 0
        ? event.message
        : "Inference Worker crashed";
      if (this.#worker === worker) this.#destroy(new InferenceWorkerError("worker_failed", message));
    });
    this.#worker = worker;
    return worker;
  }

  #request(payload) {
    const worker = this.#ensureWorker();
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      try {
        worker.postMessage({ requestId, ...payload });
      } catch (error) {
        this.#pending.delete(requestId);
        reject(error);
      }
    });
  }

  #handleMessage(worker, response) {
    if (worker !== this.#worker || !Number.isInteger(response?.requestId)) return;
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) return;
    this.#pending.delete(response.requestId);
    if (response.ok === true) {
      pending.resolve(response.result);
      return;
    }
    pending.reject(new InferenceWorkerError(
      typeof response.code === "string" ? response.code : "worker_failed",
      typeof response.error === "string" ? response.error : "Inference Worker request failed"
    ));
  }

  #destroy(error) {
    const worker = this.#worker;
    this.#worker = null;
    this.#readyPromise = null;
    worker?.terminate();
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) request.reject(error);
  }
}
