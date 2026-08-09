import path from "node:path";
import { loadModelLock, modelsRoot, verifyAsset } from "./model-files.mjs";

try {
  const lock = await loadModelLock();
  let failures = 0;
  for (const asset of lock.assets) {
    const result = await verifyAsset(asset);
    if (result.ok) {
      console.log(`OK   ${path.relative(modelsRoot, result.destination)}  ${result.digest}`);
    } else {
      failures += 1;
      console.error(`FAIL ${asset.destination}: ${result.reason}`);
    }
  }
  if (failures > 0) {
    console.error("\nRun npm run models:download to populate the verified build cache.");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

