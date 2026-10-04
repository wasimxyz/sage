import {
  computeCacheKey,
  evalCacheEnabled,
  loadCacheKeyParts,
  snapshotDreamCacheFromEnv,
} from "../evals/lib/cache.ts";

const [, , commandArg, keyArg] = process.argv;
const command = commandArg ?? "";

if (command === "key") {
  const parts = await loadCacheKeyParts();
  process.stdout.write(`${computeCacheKey(parts)}\n`);
} else if (command === "snapshot") {
  if (!evalCacheEnabled()) {
    process.exit(0);
  }
  try {
    const dest = await snapshotDreamCacheFromEnv(
      keyArg !== undefined && keyArg.length > 0 ? keyArg : undefined
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
