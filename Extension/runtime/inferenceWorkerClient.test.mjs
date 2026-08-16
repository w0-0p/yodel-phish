import { test } from "node:test";
import assert from "node:assert/strict";
import { InferenceWorkerClient, InferenceWorkerError } from "./inferenceWorkerClient.mjs";

class FakeWorker {
  listeners = new Map();
  messages = [];
  terminated = false;

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  postMessage(message) {
    if (this.terminated) throw new Error("worker terminated");
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  respond(index, result) {
    const request = this.messages[index];
    this.listeners.get("message")?.({ data: { requestId: request.requestId, ok: true, result } });
  }
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("terminating a matching inference ticket rejects the real run and recreates a clean Worker", async () => {
  const workers = [];
  const client = new InferenceWorkerClient({
    workerUrl: "inference-worker.js",
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });

  const firstRun = client.run({ type: "detect" }, "job-1");
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages[0].type, "ping", "runtime readiness is part of the cancellable run");
  workers[0].respond(0, { ready: true });
  await nextTurn();
  assert.equal(workers[0].messages[1].type, "run");

  assert.equal(client.terminate("another-job"), false, "a stale cancel cannot touch the active Worker");
  assert.equal(client.terminate("job-1", "manual_logo_selection"), true);
  assert.equal(workers[0].terminated, true);
  await assert.rejects(
    firstRun,
    (error) => error instanceof InferenceWorkerError && error.code === "cancelled"
  );

  const secondRun = client.run({ type: "preprocess_trusted_region" }, "manual-1");
  assert.equal(workers.length, 2, "the request after cancellation owns a fresh runtime");
  workers[1].respond(0, { ready: true });
  await nextTurn();
  workers[1].respond(1, { logo_image: "data:image/png;base64,AA==" });
  assert.deepEqual(await secondRun, { logo_image: "data:image/png;base64,AA==" });
  assert.equal(workers[1].terminated, false);
});

test("successful inference requests reuse the warmed Worker", async () => {
  const workers = [];
  const client = new InferenceWorkerClient({
    workerUrl: "inference-worker.js",
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });

  const first = client.run({ type: "detect" }, "job-1");
  workers[0].respond(0, { ready: true });
  await nextTurn();
  workers[0].respond(1, "first");
  assert.equal(await first, "first");

  const second = client.run({ type: "preprocess_trusted_region" }, "job-2");
  await nextTurn();
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages[2].type, "run", "readiness is cached for the warmed Worker");
  workers[0].respond(2, "second");
  assert.equal(await second, "second");
});
