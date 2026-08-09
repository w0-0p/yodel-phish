import { test } from "node:test";
import assert from "node:assert/strict";
import { OffscreenQueue, SchedulerError } from "./offscreenQueue.mjs";
import { readFileSync } from "node:fs";
import {
  JOB_TOTAL_TIMEOUT_MS,
  MESSAGE_RESPONSE_TIMEOUT_MS,
  OFFSCREEN_ROUND_TRIP_TIMEOUT_MS,
  OFFSCREEN_STARTUP_TIMEOUT_MS,
} from "./inferenceLimits.mjs";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A run() that never settles on its own -- stands in for a genuinely hung
// offscreen call. Tests that use this must either never await its promise, or
// force it to settle themselves (mirroring how recycling the offscreen
// document forces a wedged chrome.runtime.sendMessage call to finally reject).
function hold() {
  return new Promise(() => {});
}

test("global concurrency limit is honored across distinct keys", async () => {
  const queue = new OffscreenQueue({ concurrency: 1, maxQueueLength: 8 });
  let concurrentCount = 0;
  let maxConcurrent = 0;
  const makeRun = (label) => async () => {
    concurrentCount += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrentCount);
    await delay(15);
    concurrentCount -= 1;
    return label;
  };

  const results = await Promise.all([
    queue.schedule("tab1", makeRun("r1")),
    queue.schedule("tab2", makeRun("r2")),
    queue.schedule("tab3", makeRun("r3")),
  ]);

  assert.deepEqual(results.sort(), ["r1", "r2", "r3"]);
  assert.equal(maxConcurrent, 1, "concurrency=1 must never let two distinct-key runs overlap");
});

test("raising concurrency lets that many distinct keys run at once", async () => {
  const queue = new OffscreenQueue({ concurrency: 2, maxQueueLength: 8 });
  let concurrentCount = 0;
  let maxConcurrent = 0;
  const makeRun = (label) => async () => {
    concurrentCount += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrentCount);
    await delay(15);
    concurrentCount -= 1;
    return label;
  };

  await Promise.all([
    queue.schedule("tab1", makeRun("r1")),
    queue.schedule("tab2", makeRun("r2")),
    queue.schedule("tab3", makeRun("r3")),
  ]);

  assert.equal(maxConcurrent, 2, "concurrency=2 must allow exactly two concurrent runs, not more");
});

test("queued tickets for distinct keys start in FIFO order once a slot frees up", async () => {
  const queue = new OffscreenQueue({ concurrency: 1, maxQueueLength: 8 });
  const order = [];
  const makeRun = (label, ms) => async () => {
    await delay(ms);
    order.push(label);
    return label;
  };

  await Promise.all([
    queue.schedule("tab1", makeRun("a", 15)),
    queue.schedule("tab2", makeRun("b", 5)),
    queue.schedule("tab3", makeRun("c", 5)),
  ]);

  assert.deepEqual(order, ["a", "b", "c"]);
});

test("superseding a queued ticket removes it before it ever starts", async () => {
  const queue = new OffscreenQueue({ concurrency: 1, maxQueueLength: 8 });
  let firstTabStarted = false;
  // Holds the only slot briefly so both "tab1" schedule() calls below land in
  // the queue (not running) -- then frees on its own so we can prove
  // "superseding" was left behind and actually gets to run.
  const slotHolder = queue.schedule("other-tab", async () => {
    await delay(20);
    return "other-tab-done";
  });

  const superseded = queue.schedule("tab1", async () => {
    firstTabStarted = true;
    return "should never run";
  });
  const superseding = queue.schedule("tab1", async () => "second");

  await assert.rejects(superseded, (error) => error instanceof SchedulerError && error.code === "superseded");
  assert.equal(firstTabStarted, false);
  assert.equal(queue.queueLength, 1, "only \"superseding\" should remain queued for tab1");

  assert.equal(await slotHolder, "other-tab-done");
  const result = await superseding;
  assert.equal(result, "second");
});

test("superseding a running ticket rejects only its caller; the real run finishes and frees the slot on its own", async () => {
  const queue = new OffscreenQueue({ concurrency: 1, maxQueueLength: 8 });
  let firstFinished = false;
  let resolveFirstRun;
  const firstRunPromise = new Promise((resolve) => {
    resolveFirstRun = resolve;
  });

  const first = queue.schedule("tab1", async () => {
    const value = await firstRunPromise;
    firstFinished = true;
    return value;
  });
  assert.equal(queue.runningCount, 1);

  const second = queue.schedule("tab1", async () => "second");
  await assert.rejects(first, (error) => error instanceof SchedulerError && error.code === "superseded");

  // The real (superseded) run is still occupying the only slot -- "second"
  // must still be queued, not running, and the slot must not appear free.
  assert.equal(queue.queueLength, 1);
  assert.equal(queue.runningCount, 1);
  assert.equal(firstFinished, false);

  resolveFirstRun("first-real-result");
  await delay(10);

  assert.equal(firstFinished, true, "the superseded run must still complete on its own");
  const secondResult = await second;
  assert.equal(secondResult, "second");
  assert.equal(queue.runningCount, 0);
});

test("repeated supersession under one key never trips the overload policy", async () => {
  const queue = new OffscreenQueue({ concurrency: 1, maxQueueLength: 1 });
  const firstPromise = queue.schedule("tab1", hold);
  firstPromise.catch(() => {});

  for (let i = 0; i < 5; i += 1) {
    const p = queue.schedule("tab1", hold);
    p.catch(() => {});
  }

  assert.equal(queue.queueLength, 1);
  assert.equal(queue.runningCount, 1);
});

test("a brand-new distinct key beyond capacity is rejected immediately with queue_overloaded", async () => {
  const queue = new OffscreenQueue({ concurrency: 1, maxQueueLength: 2 });
  const startedKeys = [];
  const p1 = queue.schedule("tab1", async () => {
    startedKeys.push("tab1");
    return hold();
  });
  const p2 = queue.schedule("tab2", async () => {
    startedKeys.push("tab2");
    return hold();
  });
  p1.catch(() => {});
  p2.catch(() => {});

  await assert.rejects(
    queue.schedule("tab3", async () => {
      startedKeys.push("tab3");
      return "unreachable";
    }),
    (error) => error instanceof SchedulerError && error.code === "queue_overloaded"
  );

  await delay(5);
  assert.deepEqual(startedKeys, ["tab1"], "tab2 stays queued and tab3 must never be admitted");
  assert.equal(queue.queueLength, 1);
  assert.equal(queue.runningCount, 1);
});

test("a queued ticket that waits too long for a free slot times out and is dropped from the queue", async () => {
  const queue = new OffscreenQueue({ concurrency: 1, maxQueueLength: 8, queueWaitTimeoutMs: 20 });
  let secondStarted = false;
  const first = queue.schedule("tab1", async () => {
    await delay(200);
    return "first";
  });
  const second = queue.schedule("tab2", async () => {
    secondStarted = true;
    return "second";
  });

  await assert.rejects(second, (error) => error instanceof SchedulerError && error.code === "queue_wait_timeout");
  assert.equal(secondStarted, false);
  assert.equal(queue.queueLength, 0);

  assert.equal(await first, "first");
});

test("a hung request times out for its caller, and later queued work only starts once the slot is actually freed", async () => {
  let forceHungRunToSettle;
  const hungRunPromise = new Promise((_resolve, reject) => {
    forceHungRunToSettle = reject;
  });
  let onTimeoutCalls = 0;
  const queue = new OffscreenQueue({
    concurrency: 1,
    maxQueueLength: 8,
    onTimeout: async () => {
      onTimeoutCalls += 1;
      await delay(30);
      // Mirrors service_worker.js recycling the offscreen document: forcing
      // the abandoned call to finally settle so the slot can free.
      forceHungRunToSettle(new Error("offscreen document was recycled"));
    },
  });

  const hungResult = queue.schedule("tab1", () => hungRunPromise, { requestTimeoutMs: 20 });
  const secondResult = queue.schedule("tab2", async () => "second", { requestTimeoutMs: 5000 });

  await assert.rejects(hungResult, (error) => error instanceof SchedulerError && error.code === "request_timeout");
  assert.equal(onTimeoutCalls, 1);

  // The caller was released at ~20ms, but the real (hung) run is still
  // "occupying" the resource until onTimeout's simulated recycle finishes
  // (~20ms + 30ms) -- tab2 must not have started yet.
  assert.equal(queue.runningCount, 1);
  assert.equal(queue.queueLength, 1);

  const result = await secondResult;
  assert.equal(result, "second", "a timed-out job must not permanently block later queued work");
  assert.equal(queue.runningCount, 0);
});

test("a real run rejecting after its caller already timed out does not crash or double-settle", async () => {
  let rejectRun;
  const runPromise = new Promise((_resolve, reject) => {
    rejectRun = reject;
  });
  const queue = new OffscreenQueue({
    concurrency: 1,
    maxQueueLength: 8,
    onTimeout: async () => {
      rejectRun(new Error("late failure after recycle"));
    },
  });

  const result = queue.schedule("tab1", async () => runPromise, { requestTimeoutMs: 10 });
  await assert.rejects(result, (error) => error instanceof SchedulerError && error.code === "request_timeout");

  await delay(10);
  assert.equal(queue.runningCount, 0, "the slot must free once the late real rejection is observed");
});

test("cancel() removes a queued ticket before it starts", async () => {
  const queue = new OffscreenQueue({ concurrency: 1, maxQueueLength: 8 });
  const first = queue.schedule("tab1", hold);
  first.catch(() => {});
  let secondRan = false;
  const second = queue.schedule("tab2", async () => {
    secondRan = true;
    return "second";
  });

  assert.deepEqual(queue.cancel("tab2"), { queued: true, running: false });
  await assert.rejects(second, (error) => error instanceof SchedulerError && error.code === "cancelled");
  await delay(5);
  assert.equal(secondRan, false);
});

test("cancel() on a running ticket rejects the caller but the real run still owns the slot until it settles", async () => {
  const queue = new OffscreenQueue({ concurrency: 1, maxQueueLength: 8 });
  let resolveRun;
  const runPromise = new Promise((resolve) => {
    resolveRun = resolve;
  });
  const first = queue.schedule("tab1", async () => runPromise);
  assert.equal(queue.runningCount, 1);

  assert.deepEqual(queue.cancel("tab1"), { queued: false, running: true });
  await assert.rejects(first, (error) => error instanceof SchedulerError && error.code === "cancelled");
  assert.equal(queue.runningCount, 1, "slot bookkeeping must not free until the real run settles");

  resolveRun("done-late");
  await delay(5);
  assert.equal(queue.runningCount, 0);
});

test("cancel() on an unknown key is a no-op", () => {
  const queue = new OffscreenQueue({ concurrency: 1, maxQueueLength: 8 });
  assert.deepEqual(queue.cancel("ghost"), { queued: false, running: false });
});

test("tab cancellation removes its queued successor and marks its running ticket", async () => {
  const queue = new OffscreenQueue({ concurrency: 1, maxQueueLength: 8 });
  let releaseRunning;
  const realRun = new Promise((resolve) => {
    releaseRunning = resolve;
  });
  const running = queue.schedule("tab1", () => realRun, { ticketId: "old" });
  running.catch(() => {});
  const queued = queue.schedule("tab1", async () => "new", { ticketId: "new" });

  await assert.rejects(running, (error) => error.code === "superseded");
  assert.deepEqual(queue.cancel("tab1", "tab_closed"), { queued: true, running: true });
  await assert.rejects(queued, (error) => error.code === "cancelled");

  releaseRunning("done");
  await delay(5);
  assert.equal(queue.runningCount, 0);
  assert.equal(queue.queueLength, 0);
});

test("ticket-scoped cancellation cannot cancel a newer queued ticket", async () => {
  const queue = new OffscreenQueue({ concurrency: 1, maxQueueLength: 8 });
  let releaseOld;
  const oldRun = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const oldCaller = queue.schedule("tab1", () => oldRun, { ticketId: "old" });
  oldCaller.catch(() => {});
  const newer = queue.schedule("tab1", async () => "new-result", { ticketId: "new" });
  await assert.rejects(oldCaller, (error) => error.code === "superseded");

  assert.deepEqual(
    queue.cancel("tab1", "old-job-failed", { ticketId: "old" }),
    { queued: false, running: true }
  );
  assert.equal(queue.queueLength, 1, "the newer ticket must remain queued");

  releaseOld("old-result");
  assert.equal(await newer, "new-result");
});

test("same-tab work stays serialized even when global concurrency is raised", async () => {
  const queue = new OffscreenQueue({ concurrency: 2, maxQueueLength: 8 });
  let releaseFirst;
  let secondStarted = false;
  const firstRun = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = queue.schedule("tab1", () => firstRun);
  first.catch(() => {});
  const second = queue.schedule("tab1", async () => {
    secondStarted = true;
    return "second";
  });
  const other = queue.schedule("tab2", async () => "other");

  await assert.rejects(first, (error) => error.code === "superseded");
  assert.equal(await other, "other");
  assert.equal(secondStarted, false);
  releaseFirst("first");
  assert.equal(await second, "second");
});

test("a preprocessing failure reaches its caller and releases the shared slot", async () => {
  const queue = new OffscreenQueue({ concurrency: 1, maxQueueLength: 8 });
  const failed = queue.schedule("tab1", async () => {
    throw new Error("preprocessing failed");
  });
  const following = queue.schedule("tab2", async () => "following");

  await assert.rejects(failed, /preprocessing failed/);
  assert.equal(await following, "following");
  assert.equal(queue.runningCount, 0);
});

test("timeout hierarchy covers two offscreen round trips and remains below five minutes", () => {
  assert.ok(OFFSCREEN_STARTUP_TIMEOUT_MS + 2 * OFFSCREEN_ROUND_TRIP_TIMEOUT_MS <= JOB_TOTAL_TIMEOUT_MS);
  assert.ok(JOB_TOTAL_TIMEOUT_MS < MESSAGE_RESPONSE_TIMEOUT_MS);
  assert.ok(MESSAGE_RESPONSE_TIMEOUT_MS < 300_000);
});

test("the authoritative queue is owned by the offscreen document, not restartable worker globals", () => {
  const offscreenSource = readFileSync(new URL("../runtime/offscreen.js", import.meta.url), "utf8");
  const workerSource = readFileSync(new URL("./service_worker.js", import.meta.url), "utf8");

  assert.match(offscreenSource, /const inferenceQueue = new OffscreenQueue/);
  assert.doesNotMatch(workerSource, /new OffscreenQueue/);
  assert.match(workerSource, /type: "cancel_tab"/);
  assert.match(workerSource, /case "offscreen_recycle_requested"/);
});


test("offscreen control messages are restricted and terminal UI payloads expose codes only", () => {
  const offscreenSource = readFileSync(new URL("../runtime/offscreen.js", import.meta.url), "utf8");
  const workerSource = readFileSync(new URL("./service_worker.js", import.meta.url), "utf8");
  const contentSource = readFileSync(new URL("../content/content.js", import.meta.url), "utf8");

  assert.ok(offscreenSource.includes("sender.id !== chrome.runtime.id"));
  assert.ok(offscreenSource.includes("sender.url !== SERVICE_WORKER_URL"));
  assert.ok(workerSource.includes("if (!isOffscreenSender(sender)) return { ok: false }"));
  assert.match(workerSource, /type: "analysis_failed"[\s\S]*?code,/);
  assert.equal(contentSource.includes("enterFailedState(message.jobId, message.reason"), false);
  // The banner message is assembled from text nodes only. Interpolated values
  // (fqdn, provider, failure codes) must never reach innerHTML, so emphasized
  // segments get real elements with textContent rather than inline markup.
  assert.ok(contentSource.includes('messageEl.textContent = ""'));
  assert.ok(contentSource.includes("document.createTextNode(part.text)"));
  assert.equal(/messageEl\.innerHTML/.test(contentSource), false);
});


test("the extension runtime and storage contract use DINOv2 exclusively", () => {
  const offscreenSource = readFileSync(new URL("../runtime/offscreen.js", import.meta.url), "utf8");
  const workerSource = readFileSync(new URL("./service_worker.js", import.meta.url), "utf8");
  const webpackSource = readFileSync(new URL("../webpack.config.js", import.meta.url), "utf8");
  const combined = offscreenSource + workerSource + webpackSource;

  assert.ok(offscreenSource.includes("DinoV2EmbeddingEngine"));
  assert.ok(offscreenSource.includes("models/dinov2_vits14.onnx"));
  assert.ok(workerSource.includes("dinoV2LogoSimilarity"));
  assert.ok(workerSource.includes("dinov2_embedding"));
  assert.ok(webpackSource.includes('path.join(modelCacheRoot, "dinov2_vits14.onnx")'));
  assert.ok(webpackSource.includes('path.join(buildRoot, "models", "dinov2_vits14.onnx")'));
  assert.equal(/MobileCLIP|mobileclip|mobileClip/.test(combined), false);
});
