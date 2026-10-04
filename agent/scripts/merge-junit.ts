import { readFileSync, writeFileSync } from "node:fs";

import { mergeJunit } from "../evals/lib/junit.ts";
import { loadRecordedResults } from "../evals/lib/recorder.ts";

const [, , outPath, ...inputs] = process.argv;

if (outPath === undefined || outPath.length === 0 || inputs.length === 0) {
  console.error(
    "Usage: merge-junit.ts <out.xml> <in1.xml> [in2.xml ...] [results.jsonl]"
  );
  process.exit(1);
}

const xmlPaths = inputs.filter((path) => !path.endsWith(".jsonl"));
const resultsPath = inputs.find((path) => path.endsWith(".jsonl"));
if (xmlPaths.length === 0) {
  console.error(
    "Usage: merge-junit.ts <out.xml> <in1.xml> [in2.xml ...] [results.jsonl]"
  );
  process.exit(1);
}

const results =
  resultsPath === undefined ? [] : loadRecordedResults(resultsPath);

let merged = "";
for (const path of xmlPaths) {
  merged = mergeJunit(merged, readXml(path));
}
merged = mergeJunit(merged, "", results);
writeFileSync(outPath, merged);

function readXml(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return "";
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}
