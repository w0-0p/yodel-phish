import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
  assertNoSymlinkComponents,
  loadModelLock,
  resolveDestination,
  verifyAsset,
} from "./model-files.mjs";

const repair = process.argv.includes("--repair");

function meter(expectedBytes) {
  let bytes = 0;
  const hash = createHash("sha256");
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > expectedBytes) {
        callback(new Error(`Download exceeded expected size of ${expectedBytes} bytes`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  return {
    stream,
    result: () => ({ bytes, sha256: hash.digest("hex") })
  };
}

function assertDigest(actual, expected, label) {
  if (actual.bytes !== expected.bytes) {
    throw new Error(`${label} size ${actual.bytes}, expected ${expected.bytes}`);
  }
  if (actual.sha256 !== expected.sha256) {
    throw new Error(`${label} SHA-256 ${actual.sha256}, expected ${expected.sha256}`);
  }
}

async function downloadAsset(asset) {
  const destination = resolveDestination(asset.destination);
  await assertNoSymlinkComponents(destination);
  await mkdir(path.dirname(destination), { recursive: true });

  const nonce = `${process.pid}-${Date.now()}`;
  const downloadPart = `${destination}.${nonce}.download.part`;
  const outputPart = `${destination}.${nonce}.output.part`;
  try {
    const response = await fetch(asset.url, {
      redirect: "follow",
      headers: { "accept-encoding": "identity" }
    });
    if (!response.ok || response.body === null) {
      throw new Error(`Download failed for ${asset.id}: HTTP ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) !== asset.download.bytes) {
      throw new Error(
        `Unexpected Content-Length for ${asset.id}: ${contentLength}, expected ${asset.download.bytes}`
      );
    }

    const downloaded = meter(asset.download.bytes);
    await pipeline(
      Readable.fromWeb(response.body),
      downloaded.stream,
      createWriteStream(downloadPart, { flags: "wx", mode: 0o600 })
    );
    assertDigest(downloaded.result(), asset.download, `${asset.id} download`);

    let readyPart = downloadPart;
    if (asset.download.compression === "gzip") {
      const output = meter(asset.output.bytes);
      await pipeline(
        createReadStream(downloadPart),
        createGunzip(),
        output.stream,
        createWriteStream(outputPart, { flags: "wx", mode: 0o600 })
      );
      assertDigest(output.result(), asset.output, `${asset.id} decompressed output`);
      readyPart = outputPart;
    } else {
      assertDigest(asset.download, asset.output, `${asset.id} lock entry`);
    }

    if (repair) await rm(destination, { force: true });
    await rename(readyPart, destination);
    console.log(`Downloaded and verified ${asset.id} -> ${asset.destination}`);
  } finally {
    await rm(downloadPart, { force: true });
    await rm(outputPart, { force: true });
  }
}

try {
  const lock = await loadModelLock();
  for (const asset of lock.assets) {
    const current = await verifyAsset(asset);
    if (current.ok) {
      console.log(`Cached and verified ${asset.id}`);
      continue;
    }
    if (current.reason !== "missing" && !repair) {
      throw new Error(
        `${asset.destination} is invalid (${current.reason}); rerun with --repair to replace it`
      );
    }
    await downloadAsset(asset);
    const installed = await verifyAsset(asset);
    if (!installed.ok) throw new Error(`Post-download verification failed for ${asset.id}: ${installed.reason}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
