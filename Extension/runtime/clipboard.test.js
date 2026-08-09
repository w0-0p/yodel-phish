const { test } = require("node:test");
const assert = require("node:assert/strict");

const SCRIPT_PATH = require.resolve("./clipboard.js");

function loadClipboardWriter({ execImpl = () => true } = {}) {
  const listeners = [];
  const writes = [];
  const runtimeId = "extension-id";
  const workerUrl = `chrome-extension://${runtimeId}/dist/service_worker.js`;

  global.chrome = {
    runtime: {
      id: runtimeId,
      getURL(path) {
        return `chrome-extension://${runtimeId}/${path}`;
      },
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
    },
  };
  // The writer copies via a selected textarea and execCommand("copy") -- the
  // async Clipboard API cannot be used in a never-focused offscreen document.
  let selectedValue = null;
  global.document = {
    body: {
      appendChild(node) {
        return node;
      },
    },
    createElement() {
      const node = {
        value: "",
        select() {
          selectedValue = node.value;
        },
        remove() {},
      };
      return node;
    },
    execCommand(command) {
      if (command !== "copy" || selectedValue === null) return false;
      const copied = execImpl(selectedValue) === true;
      if (copied) writes.push(selectedValue);
      selectedValue = null;
      return copied;
    },
  };

  delete require.cache[SCRIPT_PATH];
  require(SCRIPT_PATH);

  function send(message, sender = { id: runtimeId, url: workerUrl }) {
    return new Promise((resolve) => {
      let handled = false;
      for (const listener of listeners) {
        const asyncResponse = listener(message, sender, (response) => {
          handled = true;
          resolve(response);
        });
        if (asyncResponse === true) handled = true;
      }
      if (!handled) resolve(undefined);
    });
  }

  return { writes, send, runtimeId, workerUrl };
}

test("writes the exact bounded text requested by the service worker", async () => {
  const writer = loadClipboardWriter();
  const response = await writer.send({
    target: "yodel-clickfix-clipboard",
    type: "write_text",
    text: "exact clipboard value",
  });

  assert.deepEqual(writer.writes, ["exact clipboard value"]);
  assert.deepEqual(response, { ok: true });
});

test("rejects requests from tabs and non-worker extension pages", async () => {
  const writer = loadClipboardWriter();
  const message = {
    target: "yodel-clickfix-clipboard",
    type: "write_text",
    text: "must not copy",
  };

  assert.equal(await writer.send(message, {
    id: writer.runtimeId,
    url: "https://page.test/",
    tab: { id: 1 },
  }), undefined);
  assert.equal(await writer.send(message, {
    id: writer.runtimeId,
    url: `chrome-extension://${writer.runtimeId}/settings/settings.html`,
  }), undefined);
  assert.deepEqual(writer.writes, []);
});

test("fails closed for invalid, oversized, or refused clipboard writes", async () => {
  const writer = loadClipboardWriter({ execImpl: () => false });

  assert.deepEqual(await writer.send({
    target: "yodel-clickfix-clipboard",
    type: "write_text",
    text: "x".repeat(65_537),
  }), { ok: false, error: "Invalid clipboard request" });

  assert.deepEqual(await writer.send({
    target: "yodel-clickfix-clipboard",
    type: "write_text",
    text: "text",
  }), { ok: false, error: "The offscreen document refused the copy command" });
  assert.deepEqual(writer.writes, []);
});
