import {
  computeCacheKey,
  evalCacheEnabled,
  loadCacheKeyParts,
  snapshotDreamCacheFromEnv,
} from "../evals/lib/cache.ts";

const command = process.argv[2] ?? "";

if (command === "key") {
  const parts = await loadCacheKeyParts();
  process.stdout.write(`${computeCacheKey(parts)}\n`);
} else if (command === "snapshot") {
  if (!evalCacheEnabled()) {
    process.exit(0);
  }
  try {
    const key = process.argv[3];
    const dest = await snapshotDreamCacheFromEnv(
      key !== undefined && key.length > 0 ? key : undefined
    );
    console.error(`Saved Dream artifacts to ${dest}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Dream cache snapshot skipped: ${message}`);
    process.exit(0);
  }
} else {
  console.error("Usage: eval-cache.ts key|snapshot [key]");
  process.exit(1);
}
