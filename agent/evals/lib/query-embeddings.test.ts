import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadAllCases } from "./dataset.ts";
import {
  collectEmbeddingTags,
  collectQueryTexts,
  embeddingFor,
  loadQueryEmbeddings,
  parseEmbedResponse,
  type QueryEmbedding,
  writeQueryEmbeddings,
} from "./query-embeddings.ts";

const notValidJSONPattern = /not valid JSON/;
const twoQueriesPattern = /2 queries/;

test("embeddingFor returns undefined when SAGE_EVAL_EMBEDDINGS is unset", () => {
  const previous = process.env.SAGE_EVAL_EMBEDDINGS;
  process.env.SAGE_EVAL_EMBEDDINGS = "";
  try {
    assert.equal(embeddingFor("when did I start dating Sam"), undefined);
  } finally {
    restoreEnv("SAGE_EVAL_EMBEDDINGS", previous);
  }
});

test("writeQueryEmbeddings writes rows that embeddingFor reads back", () => {
  const previous = process.env.SAGE_EVAL_EMBEDDINGS;
  const path = join(
    mkdtempSync(join(tmpdir(), "sage-eval-embeddings-")),
    "query-embeddings.jsonl"
  );
  process.env.SAGE_EVAL_EMBEDDINGS = path;
  const first = sampleRow("alpha", [0.1, 0.2]);
  const second = sampleRow("beta", [0.3, 0.4, 0.5]);
  try {
    writeQueryEmbeddings([first, second]);
    assert.deepEqual(loadQueryEmbeddings(), [first, second]);
    assert.deepEqual(embeddingFor("alpha"), [0.1, 0.2]);
    assert.deepEqual(embeddingFor("  alpha  "), [0.1, 0.2]);
    assert.deepEqual(embeddingFor("beta"), [0.3, 0.4, 0.5]);
    assert.equal(embeddingFor("missing"), undefined);
  } finally {
    restoreEnv("SAGE_EVAL_EMBEDDINGS", previous);
  }
});

test("writeQueryEmbeddings skips the write when SAGE_EVAL_EMBEDDINGS is unset", () => {
  const previous = process.env.SAGE_EVAL_EMBEDDINGS;
  process.env.SAGE_EVAL_EMBEDDINGS = "";
  try {
    writeQueryEmbeddings([sampleRow("alpha", [1])]);
  } finally {
    restoreEnv("SAGE_EVAL_EMBEDDINGS", previous);
  }
});

test("loadQueryEmbeddings returns an empty list when the file is missing", () => {
  const previous = process.env.SAGE_EVAL_EMBEDDINGS;
  process.env.SAGE_EVAL_EMBEDDINGS = join(
    tmpdir(),
    "sage-eval-embeddings-missing.jsonl"
  );
  try {
    assert.deepEqual(loadQueryEmbeddings(), []);
  } finally {
    restoreEnv("SAGE_EVAL_EMBEDDINGS", previous);
  }
});

test("loadQueryEmbeddings throws on a malformed line", () => {
  const previous = process.env.SAGE_EVAL_EMBEDDINGS;
  const path = join(
    mkdtempSync(join(tmpdir(), "sage-eval-embeddings-")),
    "query-embeddings.jsonl"
  );
  writeFileSync(path, "not-json\n");
  process.env.SAGE_EVAL_EMBEDDINGS = path;
  try {
    assert.throws(() => loadQueryEmbeddings(), notValidJSONPattern);
  } finally {
    restoreEnv("SAGE_EVAL_EMBEDDINGS", previous);
  }
});

test("collectQueryTexts keeps unique retrieval, fact, event, and title strings", () => {
  const texts = collectQueryTexts([
    {
      chat: [],
      dir: "/tmp/a",
      entries: [
        {
          body: "one",
          date: "2026-06-15",
          fileName: "01.md",
          index: 1,
          title: "Climbing Thursday",
          wordCount: 1,
        },
        {
          body: "two",
          date: "2026-06-16",
          fileName: "02.md",
          index: 2,
          title: "Climbing Thursday",
          wordCount: 1,
        },
      ],
      events: [{ entry: 1, reference: "The user and Sam started dating" }],
      facts: [
        {
          reference: "Sam is the user's boyfriend or partner",
          subject: "Sam",
        },
      ],
      id: "sam-example",
      kind: "timeline",
      retrieval: [{ expectEntry: 1, query: "when did I start dating Sam" }],
      summaries: [],
      tags: ["example"],
    },
  ]);
  assert.deepEqual(texts, [
    "when did I start dating Sam",
    "Sam is the user's boyfriend or partner",
    "The user and Sam started dating",
    "Climbing Thursday",
  ]);
});

test("collectQueryTexts includes Sam retrieval, facts, events, and titles", async () => {
  const cases = await loadAllCases();
  const texts = collectQueryTexts(cases);
  assert.ok(texts.includes("when did I start dating Sam"));
  assert.ok(texts.includes("Sam is the user's boyfriend or partner"));
  assert.ok(texts.includes("The user and Sam started dating"));
  assert.ok(texts.includes("Climbing Thursday"));
  assert.ok(texts.includes("Told Sam"));
});

test("collectEmbeddingTags unions case tags with extraction, retrieval, and summaries", async () => {
  const cases = await loadAllCases();
  const tags = collectEmbeddingTags(cases);
  assert.ok(tags.includes("example"));
  assert.ok(tags.includes("timeline"));
  assert.ok(tags.includes("standalone"));
  assert.ok(tags.includes("extraction"));
  assert.ok(tags.includes("retrieval"));
  assert.ok(tags.includes("summaries"));
});

test("parseEmbedResponse pairs vectors with the input texts", () => {
  assert.deepEqual(
    parseEmbedResponse({ embeddings: [[0.1, 0.2], [0.3]] }, ["alpha", "beta"]),
    [sampleRow("alpha", [0.1, 0.2]), sampleRow("beta", [0.3])]
  );
});

test("parseEmbedResponse throws when the vector count does not match", () => {
  assert.throws(
    () => parseEmbedResponse({ embeddings: [[0.1]] }, ["a", "b"]),
    twoQueriesPattern
  );
});

function sampleRow(text: string, embedding: number[]): QueryEmbedding {
  return { embedding, text };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
