const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

test("the issue link targets the public repository", () => {
  const html = readFileSync(require.resolve("./popup.html"), "utf8");
  assert.match(html, /https:\/\/github\.com\/w0-0p\/yodel-phish\/issues/);
  assert.doesNotMatch(html, /github\.com\/example\//);
});
