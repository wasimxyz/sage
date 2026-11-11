import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type CachedGrade,
  createGradeCache,
  gradeCachePath,
  gradesFileName,
  inputHashOf,
} from "./dream-grade-cache.ts";

const MODEL = "moonshotai/kimi-k3.1-pro";
const RUBRIC = "abcdef0123";

function snapshotRoot(key = "key1"): string {
  const root = mkdtempSync(join(tmpdir(), "sage-dream-grades-"));
  mkdirSync(join(root, key));
  return root;
}

function grade(overrides: Partial<CachedGrade> = {}): CachedGrade {
  return {
    claims: [
      {
        itemKind: "summary",
        itemText: "Mia died.",
        quote: "Mia died",
        reason: "The entry never says that.",
        severity: "severe",
      },
    ],
    gradedAt: "2026-11-10T00:00:00.000Z",
    inputHash: "h1",
    itemId: "sam/dream/2026-09-03-lost-mia",
    model: MODEL,
    rubric: RUBRIC,
    ...overrides,
  };
}

test("the grades file is named for the model and the rubric hash", () => {
  assert.equal(
    gradesFileName(MODEL, RUBRIC),
    "grades-moonshotai_kimi-k3.1-pro-abcdef0123.jsonl"
  );
  assert.equal(
    gradesFileName("a:b/c d", RUBRIC),
    "grades-a_b_c_d-abcdef0123.jsonl"
  );
});

test("the path sits in the snapshot folder", () => {
  const cacheDir = snapshotRoot();
  assert.equal(
    gradeCachePath({
      cacheDir,
      enabled: true,
      key: "key1",
      model: MODEL,
      rubric: RUBRIC,
    }),
    join(cacheDir, "key1", gradesFileName(MODEL, RUBRIC))
  );
});

test("nothing is cached without a key, with a key that is not a plain name, with the cache off, or without a snapshot folder", () => {
  const cacheDir = snapshotRoot();
  const base = { cacheDir, enabled: true, model: MODEL, rubric: RUBRIC };
  assert.equal(gradeCachePath({ ...base, key: undefined }), undefined);
  assert.equal(gradeCachePath({ ...base, key: "  " }), undefined);
  assert.equal(gradeCachePath({ ...base, key: "../escape" }), undefined);
  assert.equal(gradeCachePath({ ...base, key: "a/b" }), undefined);
  assert.equal(
    gradeCachePath({ ...base, enabled: false, key: "key1" }),
    undefined
  );
  assert.equal(gradeCachePath({ ...base, key: "missing" }), undefined);
});

test("a cache with no path remembers nothing and writes nothing", () => {
  const cache = createGradeCache({
    key: undefined,
    model: MODEL,
    rubric: RUBRIC,
  });
  assert.equal(cache.path, undefined);
  cache.put(grade());
  assert.equal(cache.get(grade().itemId, "h1"), undefined);
});

test("a grade comes back from the file in a new cache", () => {
  const cacheDir = snapshotRoot();
  const location = {
    cacheDir,
    enabled: true,
    key: "key1",
    model: MODEL,
    rubric: RUBRIC,
  };
  const first = createGradeCache(location);
  assert.equal(first.get(grade().itemId, "h1"), undefined);
  first.put(grade());
  assert.deepEqual(first.get(grade().itemId, "h1"), grade());

  const second = createGradeCache(location);
  assert.deepEqual(second.get(grade().itemId, "h1"), grade());
  const lines = readFileSync(second.path ?? "", "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 1);
});

test("a different input, model, or rubric is a miss", () => {
  const cacheDir = snapshotRoot();
  const location = {
    cacheDir,
    enabled: true,
    key: "key1",
    model: MODEL,
    rubric: RUBRIC,
  };
  createGradeCache(location).put(grade());
  const cache = createGradeCache(location);
  assert.equal(cache.get(grade().itemId, "other-hash"), undefined);
  assert.equal(cache.get("sam/dream/another", "h1"), undefined);

  // The same file name with a row from another model (a name collision) is a miss.
  const path = cache.path ?? "";
  appendFileSync(
    path,
    `${JSON.stringify(grade({ itemId: "sam/dream/x", model: "other/model" }))}\n`
  );
  assert.equal(createGradeCache(location).get("sam/dream/x", "h1"), undefined);

  // Another rubric hash is another file.
  const next = createGradeCache({ ...location, rubric: "ffffffffff" });
  assert.equal(next.get(grade().itemId, "h1"), undefined);
});

test("a torn or foreign line is skipped, and the newest row for a source wins", () => {
  const cacheDir = snapshotRoot();
  const location = {
    cacheDir,
    enabled: true,
    key: "key1",
    model: MODEL,
    rubric: RUBRIC,
  };
  const path = gradeCachePath(location) ?? "";
  writeFileSync(
    path,
    [
      JSON.stringify(grade({ claims: [], inputHash: "old" })),
      '{"itemId": "torn',
      JSON.stringify({ itemId: "x" }),
      JSON.stringify(grade({ claims: [], inputHash: "new" })),
      "",
    ].join("\n")
  );
  const cache = createGradeCache(location);
  assert.equal(cache.get(grade().itemId, "old"), undefined);
  assert.deepEqual(cache.get(grade().itemId, "new")?.claims, []);
});

test("the input hash follows the fact sheet and the item", () => {
  const base = inputHashOf({ context: "sheet", item: "source" });
  assert.equal(base, inputHashOf({ context: "sheet", item: "source" }));
  assert.notEqual(base, inputHashOf({ context: "sheet 2", item: "source" }));
  assert.notEqual(base, inputHashOf({ context: "sheet", item: "source 2" }));
  // Moving text across the boundary does not give the same hash.
  assert.notEqual(
    inputHashOf({ context: "ab", item: "c" }),
    inputHashOf({ context: "a", item: "bc" })
  );
});
