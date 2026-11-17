// Prints a Dream cache key, or snapshots a finished Dream run, for one person.
// The runner calls the same functions from `lib/cache.ts` directly. This
// script is for checking a key by hand.
//
//   eval-cache.ts key --person sam-example --memory on
//   eval-cache.ts snapshot [key] --person sam-example --memory on
//
// `snapshot` reads SAGE_DATA_DIR and SAGE_EVAL_MANIFEST. Ollama must answer on
// OLLAMA_BASE_URL (default 127.0.0.1:11436) for the model digests.

import { parseArgs } from "node:util";

import {
  baselineDreamPrompt,
  computeCacheKey,
  evalCacheDir,
  evalCacheEnabled,
  loadCacheKeyParts,
  snapshotDreamRun,
} from "../evals/lib/cache.ts";
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_SUMMARY_MODEL,
  MEMORY_VALUES,
  type Memory,
} from "../evals/lib/schema.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "dream-prompt": { default: baselineDreamPrompt, type: "string" },
    "embed-model": { default: DEFAULT_EMBED_MODEL, type: "string" },
    memory: { default: "off", type: "string" },
    person: { type: "string" },
    "summary-model": { default: DEFAULT_SUMMARY_MODEL, type: "string" },
  },
});
const [command = "", keyArg] = positionals;

function usage(): never {
  console.error(
    "Usage: eval-cache.ts key|snapshot [key] --person <id> [--memory on|off] [--summary-model m] [--embed-model m] [--dream-prompt name]"
  );
  process.exit(1);
}

function memoryValue(raw: string): Memory {
  const found = MEMORY_VALUES.find((value) => value === raw);
  if (found === undefined) {
    console.error(`--memory must be one of: ${MEMORY_VALUES.join(", ")}.`);
    process.exit(1);
  }
  return found;
}

if (values.person === undefined || values.person.length === 0) {
  usage();
}

const parts = await loadCacheKeyParts({
  dreamPrompt: values["dream-prompt"],
  embedModel: values["embed-model"],
  memory: memoryValue(values.memory),
  person: values.person,
  summaryModel: values["summary-model"],
});

if (command === "key") {
  process.stdout.write(`${computeCacheKey(parts)}\n`);
} else if (command === "snapshot") {
  if (!evalCacheEnabled()) {
    process.exit(0);
  }
  const dataDir = process.env.SAGE_DATA_DIR;
  const manifestPath = process.env.SAGE_EVAL_MANIFEST;
  if (
    dataDir === undefined ||
    dataDir.length === 0 ||
    manifestPath === undefined ||
    manifestPath.length === 0
  ) {
    console.error("Set SAGE_DATA_DIR and SAGE_EVAL_MANIFEST.");
    process.exit(1);
  }
  try {
    const dest = snapshotDreamRun({
      cacheDir: evalCacheDir(),
      dataDir,
      dreamPrompt: values["dream-prompt"],
      key:
        keyArg !== undefined && keyArg.length > 0
          ? keyArg
          : computeCacheKey(parts),
      manifestPath,
      parts,
    });
    console.error(`Saved Dream artifacts to ${dest}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Dream cache snapshot skipped: ${message}`);
  }
} else {
  usage();
}
