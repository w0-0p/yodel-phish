import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectRoot } from "./model-files.mjs";

const buildRoot = path.join(projectRoot, "build", "extension");
const packageJson = JSON.parse(
  await (await import("node:fs/promises")).readFile(
    path.join(projectRoot, "Extension", "package.json"),
    "utf8"
  )
);
const archive = path.join(projectRoot, "build", `yodel-phish-${packageJson.version}.zip`);
const sourceNotice = `${archive}.SOURCE.txt`;
const sourceUrl = `https://github.com/w0-0p/yodel-phish/tree/v${packageJson.version}`;

async function filesBelow(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

const files = (await filesBelow(buildRoot)).sort();
const epochSeconds = Number(process.env.SOURCE_DATE_EPOCH ?? 315532800);
if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 315532800) {
  throw new Error("SOURCE_DATE_EPOCH must be an integer at or after 1980-01-01");
}
const timestamp = new Date(epochSeconds * 1000);
for (const relative of files) await utimes(path.join(buildRoot, relative), timestamp, timestamp);

await rm(archive, { force: true });
const zip = spawnSync("zip", ["-X", "-q", archive, ...files], {
  cwd: buildRoot,
  stdio: "inherit"
});
if (zip.error) throw zip.error;
if (zip.status !== 0) throw new Error(`zip exited with status ${zip.status}`);

const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const info = await stat(archive);
await writeFile(
  sourceNotice,
  `Yodel Phish ${packageJson.version}\n` +
    `License: AGPL-3.0-only\n` +
    `Corresponding source: ${sourceUrl}\n`,
  "utf8"
);
console.log(`${archive}`);
console.log(`SHA-256 ${hash.digest("hex")}`);
console.log(`Size ${info.size} bytes`);
console.log(`Source notice ${sourceNotice}`);

