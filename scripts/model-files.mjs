import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const modelsRoot = path.join(projectRoot, "Models");
export const lockPath = path.join(modelsRoot, "models.lock.json");

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

export function resolveDestination(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error("Model destination must be a non-empty relative path");
  }
  const resolved = path.resolve(modelsRoot, relativePath);
  const prefix = modelsRoot + path.sep;
  if (!resolved.startsWith(prefix)) throw new Error(`Model destination escapes Models/: ${relativePath}`);
  return resolved;
}

export async function assertNoSymlinkComponents(destination) {
  const relative = path.relative(modelsRoot, destination);
  let current = modelsRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Model path must not contain a symlink: ${current}`);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

export async function loadModelLock() {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.assets) || lock.assets.length === 0) {
    throw new Error("Models/models.lock.json has an unsupported or empty schema");
  }
  const ids = new Set();
  const destinations = new Set();
  for (const asset of lock.assets) {
    if (typeof asset.id !== "string" || asset.id.length === 0 || ids.has(asset.id)) {
      throw new Error(`Invalid or duplicate model id: ${String(asset.id)}`);
    }
    ids.add(asset.id);
    const url = new URL(asset.url);
    if (url.protocol !== "https:") throw new Error(`Model URL must use HTTPS: ${asset.url}`);
    const destination = resolveDestination(asset.destination);
    if (destinations.has(destination)) throw new Error(`Duplicate model destination: ${asset.destination}`);
    destinations.add(destination);
    if (
      typeof asset.runtimePath !== "string" ||
      asset.runtimePath.startsWith("/") ||
      asset.runtimePath.includes("..")
    ) {
      throw new Error(`Invalid packaged runtime path for ${asset.id}`);
    }
    requirePositiveInteger(asset.download?.bytes, `${asset.id}.download.bytes`);
    requirePositiveInteger(asset.output?.bytes, `${asset.id}.output.bytes`);
    requireSha256(asset.download?.sha256, `${asset.id}.download.sha256`);
    requireSha256(asset.output?.sha256, `${asset.id}.output.sha256`);
    if (!["none", "gzip"].includes(asset.download?.compression)) {
      throw new Error(`Unsupported compression for ${asset.id}`);
    }
  }
  return lock;
}

export async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyAsset(asset) {
  const destination = resolveDestination(asset.destination);
  await assertNoSymlinkComponents(destination);
  try {
    const info = await stat(destination);
    if (!info.isFile()) return { ok: false, destination, reason: "not a regular file" };
    if (info.size !== asset.output.bytes) {
      return { ok: false, destination, reason: `size ${info.size}, expected ${asset.output.bytes}` };
    }
    const digest = await sha256File(destination);
    if (digest !== asset.output.sha256) {
      return { ok: false, destination, reason: `SHA-256 ${digest}, expected ${asset.output.sha256}` };
    }
    return { ok: true, destination, digest, bytes: info.size };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, destination, reason: "missing" };
    throw error;
  }
}

