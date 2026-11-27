import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  collectSetupData,
  personPassFiles,
  readTranscripts,
  setupPassFiles,
} from "./collect.ts";
import { tempDir } from "./test-fixtures.ts";

const setupId = "0123456789";

function transcriptLine(itemId: string, repeat = 1): string {
  return JSON.stringify({
    ended: "done",
    itemId,
    journal: "own",
    kind: "chat",
    person: itemId.split("/")[0],
    repeat,
    setupId,
    turns: [
      { role: "user", text: "How was my week?" },
      { role: "assistant", text: "You wrote about the market." },
    ],
  });
}

function resultLine(id: string): string {
  return JSON.stringify({
    assertions: [],
    completedAt: "2026-11-10T03:00:01.000Z",
    id,
    metadata: { itemId: id },
    startedAt: "2026-11-10T03:00:00.000Z",
    verdict: "passed",
  });
}

test("each pass has its own results file, and the chat and grade passes share transcripts", () => {
  const person = personPassFiles("/run", "abcdef0123", "sam");
  assert.equal(person.dir, "/run/dream/abcdef0123/sam");
  assert.equal(
    person.results,
    "/run/dream/abcdef0123/sam/person.results.jsonl"
  );
  assert.equal(person.log, "/run/dream/abcdef0123/sam/person.log");

  const chat = setupPassFiles("/run", setupId, "sam", "chat");
  const grade = setupPassFiles("/run", setupId, "sam", "grade");
  assert.equal(chat.dir, `/run/setups/${setupId}/sam`);
  assert.notEqual(chat.results, grade.results);
  assert.equal(chat.results, `/run/setups/${setupId}/sam/chat.results.jsonl`);
  assert.equal(grade.results, `/run/setups/${setupId}/sam/grade.results.jsonl`);
  assert.equal(chat.transcripts, grade.transcripts);
});

test("readTranscripts reads valid rows and skips damaged lines", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "transcripts.jsonl");
  writeFileSync(
    file,
    `${transcriptLine("sam/chat/1")}\nnot json\n\n${JSON.stringify({ itemId: "bad" })}\n${transcriptLine("sam/chat/2")}\n`
  );
  const rows = readTranscripts(file);
  assert.deepEqual(
    rows.map((row) => row.itemId),
    ["sam/chat/1", "sam/chat/2"]
  );
  assert.equal(rows[0]?.turns.length, 2);
  assert.deepEqual(readTranscripts(join(dir, "missing.jsonl")), []);
});

test("collectSetupData gathers the person, chat, and grade rows for a setup", (t) => {
  const runDir = tempDir(t);
  const dreamKeyId = "abcdef0123";
  for (const person of ["sam", "jo"]) {
    const personFiles = personPassFiles(runDir, dreamKeyId, person);
    mkdirSync(personFiles.dir, { recursive: true });
    writeFileSync(personFiles.results, `${resultLine(`${person}/fact/1`)}\n`);

    const chat = setupPassFiles(runDir, setupId, person, "chat");
    const grade = setupPassFiles(runDir, setupId, person, "grade");
    mkdirSync(chat.dir, { recursive: true });
    writeFileSync(chat.results, `${resultLine(`${person}/chat/1`)}\n`);
    writeFileSync(grade.results, `${resultLine(`${person}/chat/1`)}\n`);
    writeFileSync(chat.transcripts, `${transcriptLine(`${person}/chat/1`)}\n`);
  }
  const data = collectSetupData(runDir, { dreamKeyId, setupId }, [
    "sam",
    "jo",
    "kim",
  ]);
  const passes = data.rows.map((entry) => entry.pass).sort();
  assert.deepEqual(passes, [
    "chat",
    "chat",
    "grade",
    "grade",
    "person",
    "person",
  ]);
  assert.equal(data.transcripts.length, 2);
});

test("a setup that never ran has no rows", (t) => {
  const runDir = tempDir(t);
  const data = collectSetupData(runDir, { dreamKeyId: "abcdef0123", setupId }, [
    "sam",
  ]);
  assert.deepEqual(data, { rows: [], transcripts: [] });
});

test("a damaged results file is reported and reads as empty", (t) => {
  const runDir = tempDir(t);
  const grade = setupPassFiles(runDir, setupId, "sam", "grade");
  mkdirSync(grade.dir, { recursive: true });
  writeFileSync(grade.results, "{not json}\n");
  const data = collectSetupData(runDir, { dreamKeyId: "abcdef0123", setupId }, [
    "sam",
  ]);
  assert.deepEqual(data.rows, []);
});
