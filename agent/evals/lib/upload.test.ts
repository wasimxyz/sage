import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  blobPathname,
  contentTypeFor,
  listReportFiles,
} from "./upload.ts";

test("listReportFiles skips gitignore and hidden files", () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-eval-reports-"));
  writeFileSync(join(dir, ".gitignore"), "*\n");
  writeFileSync(join(dir, "run.xml"), "<testsuite/>\n");
  writeFileSync(join(dir, "run.manifest.json"), "{}\n");
  mkdirSync(join(dir, "nested"), { recursive: true });
  const listed = listReportFiles(dir).map((path) => path.slice(dir.length + 1));
  assert.deepEqual(listed, ["run.manifest.json", "run.xml"]);
});

test("listReportFiles returns an empty list when the folder is missing", () => {
  assert.deepEqual(
    listReportFiles(join(tmpdir(), "sage-eval-reports-missing")),
    []
  );
});

test("blobPathname keeps the local file name under sage-evals", () => {
  assert.equal(
    blobPathname(
      "/tmp/reports/qwen3_8b__nomic-embed-text__qwen3_8b__20260915T071658Z.xml"
    ),
    "sage-evals/qwen3_8b__nomic-embed-text__qwen3_8b__20260915T071658Z.xml"
  );
});

test("contentTypeFor maps report extensions", () => {
  assert.equal(contentTypeFor("run.xml"), "application/xml");
  assert.equal(contentTypeFor("run.manifest.json"), "application/json");
  assert.equal(contentTypeFor("run.sage.log"), "text/plain; charset=utf-8");
});
