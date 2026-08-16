import { readFile, readdir, lstat, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModelLock, projectRoot, sha256File } from "./model-files.mjs";

const buildRoot = path.join(projectRoot, "build", "extension");
const extensionRoot = path.join(projectRoot, "Extension");
const releaseLayout = JSON.parse(
  await readFile(path.join(projectRoot, "scripts", "release-files.json"), "utf8")
);

async function walk(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Release package contains a symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...await walk(absolute, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Release package contains a non-regular entry: ${relative}`);
  }
  return files;
}

function requirePath(files, relative) {
  if (!files.has(relative)) throw new Error(`Required release file is missing: ${relative}`);
}

const files = new Set(await walk(buildRoot));
const exactAllowed = new Set([
  ...releaseLayout.staticFiles,
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md"
]);

for (const relative of files) {
  const inGeneratedRoot = releaseLayout.generatedRoots.some(
    (root) => relative.startsWith(root + "/")
  );
  if (!exactAllowed.has(relative) && !inGeneratedRoot) {
    throw new Error(`File is outside the package allowlist: ${relative}`);
  }
  if (
    relative.endsWith(".map") ||
    relative.endsWith(".ts") ||
    /(?:^|\/)node_modules(?:\/|$)/.test(relative) ||
    /(?:^|\/)tests?(?:\/|$)/.test(relative) ||
    /\.test\.[^.]+$/.test(relative) ||
    /\.(?:pem|crx|zip)$/.test(relative)
  ) {
    throw new Error(`Development or sensitive file entered the release: ${relative}`);
  }
}

for (const required of [
  "manifest.json",
  "dist/service_worker.js",
  "dist/offscreen.js",
  "dist/inference_worker.js",
  "models/dinov2_vits14.onnx",
  "models/dinov2_vits14_config.json",
  "models/yolo-logo.onnx",
  "opencv/opencv.js",
  "tesseract/worker.min.js",
  "tesseract/lang/eng.traineddata",
  "THIRD_PARTY_NOTICES.md"
]) {
  requirePath(files, required);
}
if (![...files].some((entry) => entry.startsWith("ort-wasm/") && entry.endsWith(".wasm"))) {
  throw new Error("No ONNX Runtime WASM artifact was packaged");
}

const manifest = JSON.parse(await readFile(path.join(buildRoot, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(path.join(extensionRoot, "package.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Packaged manifest is not Manifest V3");
if (manifest.version !== packageJson.version) {
  throw new Error(`Manifest version ${manifest.version} differs from package version ${packageJson.version}`);
}

const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_page,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((entry) => [...(entry.js ?? []), ...(entry.css ?? [])])
].filter((entry) => typeof entry === "string");
for (const relative of referenced) requirePath(files, relative);

const lock = await loadModelLock();
for (const asset of lock.assets) {
  const packaged = path.join(buildRoot, asset.runtimePath);
  const info = await stat(packaged);
  const digest = await sha256File(packaged);
  if (info.size !== asset.output.bytes || digest !== asset.output.sha256) {
    throw new Error(`Packaged artifact failed verification: ${asset.runtimePath}`);
  }
}

const sourceConfig = await readFile(path.join(projectRoot, "Models", "dinov2_vits14_config.json"));
const packagedConfig = await readFile(path.join(buildRoot, "models", "dinov2_vits14_config.json"));
if (!sourceConfig.equals(packagedConfig)) throw new Error("Packaged DINO config differs from its canonical source");

let totalBytes = 0;
for (const relative of files) totalBytes += (await stat(path.join(buildRoot, relative))).size;
console.log(`Validated ${files.size} packaged files (${(totalBytes / 1024 / 1024).toFixed(1)} MiB)`);
