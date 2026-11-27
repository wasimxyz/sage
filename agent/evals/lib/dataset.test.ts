import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { skipWithoutContent } from "./content.ts";
import {
  chatIdFor,
  countWords,
  evalDataRoot,
  journalIdFor,
  type LoadedPerson,
  loadEntryFiles,
  loadManifest,
  loadPeople,
  loadPerson,
  parseChatTurns,
  parseFrontmatter,
  resolveChat,
  resolveEntry,
  resolveNeed,
  validatePerson,
} from "./dataset.ts";

const pattern13 =
  /text before the first "User:" or "Sage:" line: "Hello there\."/u;
const pattern12 = /turn 2 has no text/u;
const pattern11 = /text before the first/u;
const pattern10 =
  /chats\/2026-09-16-three-questions\.md needs a YYYY-MM-DD date/u;
const pattern9 = /chats\/2026-09-16-three-questions\.md needs a title/u;
const pattern8 = /has no User: or Sage: turns/u;
const pattern7 =
  /chats\/2026-09-16-three-questions\.md: text before the first/u;
const pattern6 = /Write a past chat as chat:<stem>/u;
const pattern5 = /Leave off \.md/u;
const pattern4 = /no past chat with the stem "nope"/u;
const pattern3 = /Manifest has no ids for tmp/u;
const pattern2 = /no chat id for past chat 1/u;
const pattern1 = /chatIds that are not numbers/u;

const TODAY = "2026-11-15";

const missingPattern = /Manifest has no journal ids for missing/u;
const noEntry99Pattern = /no entry number 99/u;
const noEntry0Pattern = /no entry number 0/u;
const unknownStemPattern = /no entry with the stem "nope"/u;
const leaveOffMdPattern = /Leave off \.md/u;
const emptyJournalPattern = /empty journal/u;
const dateFormatPattern = /bad-date\.md needs a YYYY-MM-DD date/u;
const impossibleDatePattern = /impossible\.md needs a YYYY-MM-DD date/u;
const titlePattern = /no-title\.md needs a title/u;
const bodyPattern = /no-body\.md has an empty body/u;
const noCaseYamlPattern = /ghost has no case\.yaml/u;
const idMismatchPattern = /id "other".*match the folder name/u;
const badIdPattern = /not a person id/u;
const digitsStemPattern = /only with digits/u;
const schemaPattern = /Invalid case\.yaml for broken/u;
const unknownPersonPattern = /Unknown person "nobody"\. Known: alpha, beta/u;
const manifestEnvPattern = /SAGE_EVAL_MANIFEST is not set/u;
const badEventPattern = /^events\[0\]\.entry: .*no entry number 9/u;
const badSummaryPattern = /^summaries\[0\]\.entry: .*stem "missing-stem"/u;
const badRetrievalPattern =
  /^retrieval\[0\] \(query "q"\) expectEntry: .*stem "also-missing"/u;
const badChatPattern = /^chat\[0\]\.needs: .*no entry number 4/u;
const badOpenerPattern = /^openers \(in hello\)\.needs: .*stem "nope"/u;
const badScriptNeedPattern =
  /^conversations \(in asks\)\.script\.4\.needs: .*stem "nope"/u;
const lastMonthPattern =
  /retrieval\[4\].*when "last month" covers 2026-10-01 to 2026-10-31/u;
const unreadableWhenPattern = /when "whenever" does not read as a time/u;
const noJournalIdPattern = /no journal id for entry 3/u;
const noJournalIdsPattern = /alpha is missing journalIds/u;
const noCasesPattern = /missing a cases object/u;
const firstTimePattern = /first-time user/u;

function entryText(date: string, title: string, body: string): string {
  return `---\ndate: ${date}\ntitle: ${title}\n---\n\n${body}\n`;
}

/** A past chat file: frontmatter, then one line for each turn. */
function chatText(date: string, title: string, turns: string[]): string {
  return `---\ndate: ${date}\ntitle: ${title}\n---\n${turns.join("\n")}\n`;
}

/** A data root with a `people/` folder. Each person is a map of file name to text. */
function makeRoot(people: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "sage-eval-people-"));
  for (const [id, files] of Object.entries(people)) {
    const dir = join(root, "people", id);
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    }
  }
  return root;
}

// The data root is one environment variable for the whole process, so two
// roots cannot be set at once. A call waits for the ones before it, or the
// last one to finish would put back the root of another call.
let rootTurn: Promise<unknown> = Promise.resolve();

function withRoot<T>(root: string, run: () => Promise<T> | T): Promise<T> {
  const result = rootTurn.then(async () => {
    const previous = process.env.SAGE_EVAL_DATA;
    process.env.SAGE_EVAL_DATA = root;
    try {
      return await run();
    } finally {
      if (previous === undefined) {
        delete process.env.SAGE_EVAL_DATA;
      } else {
        process.env.SAGE_EVAL_DATA = previous;
      }
      rmSync(root, { force: true, recursive: true });
    }
  });
  rootTurn = result.catch(() => undefined);
  return result;
}

const tinyCase = (id: string, extra = "") =>
  `id: ${id}\nabout: A made-up person.\n${extra}`;

/** A person with three entries and no answer key. */
function threeEntries(
  id: string,
  extra = ""
): Record<string, Record<string, string>> {
  return {
    [id]: {
      "2026-04-12-first-run.md": entryText("2026-04-12", "First run", "Ran."),
      "2026-05-22-shins.md": entryText("2026-05-22", "Shins", "Hurt."),
      "2026-06-15-told-sam.md": entryText("2026-06-15", "Told Sam", "Told."),
      "case.yaml": tinyCase(id, extra),
    },
  };
}

async function personWith(extra: string): Promise<LoadedPerson> {
  const root = makeRoot(threeEntries("tmp", extra));
  return await withRoot(root, () => loadPerson("tmp"));
}

test("parseFrontmatter reads date, title, and body", () => {
  const parsed = parseFrontmatter(
    "---\ndate: 2026-06-15\ntitle: Told Sam\n---\n\nWe started dating.\n"
  );
  assert.equal(parsed.date, "2026-06-15");
  assert.equal(parsed.title, "Told Sam");
  assert.equal(parsed.body.trim(), "We started dating.");
});

test("countWords splits on whitespace", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("  one two  three "), 3);
});

test("evalDataRoot prefers SAGE_EVAL_DATA", () => {
  const previous = process.env.SAGE_EVAL_DATA;
  process.env.SAGE_EVAL_DATA = "/tmp/sage-eval-data";
  try {
    assert.equal(evalDataRoot(), "/tmp/sage-eval-data");
  } finally {
    if (previous === undefined) {
      delete process.env.SAGE_EVAL_DATA;
    } else {
      process.env.SAGE_EVAL_DATA = previous;
    }
  }
});

test("loadPerson reads entries in filename order with stems and counts", async () => {
  const root = makeRoot(threeEntries("alpha"));
  const person = await withRoot(root, () => loadPerson("alpha"));
  assert.equal(person.id, "alpha");
  assert.equal(person.empty, false);
  assert.equal(person.personCase.about, "A made-up person.");
  assert.deepEqual(
    person.entries.map((entry) => [entry.index, entry.stem, entry.date]),
    [
      [1, "2026-04-12-first-run", "2026-04-12"],
      [2, "2026-05-22-shins", "2026-05-22"],
      [3, "2026-06-15-told-sam", "2026-06-15"],
    ]
  );
  assert.equal(person.entries[0]?.fileName, "2026-04-12-first-run.md");
  assert.equal(person.entries[0]?.title, "First run");
  assert.equal(person.entries[0]?.body, "Ran.");
  assert.equal(person.entries[0]?.wordCount, 1);
});

test("a folder with only case.yaml is an empty journal", async () => {
  const root = makeRoot({ quiet: { "case.yaml": tinyCase("quiet") } });
  const person = await withRoot(root, () => loadPerson("quiet"));
  assert.equal(person.empty, true);
  assert.deepEqual(person.entries, []);
  assert.deepEqual(validatePerson(person, TODAY), []);
});

test("chats and other files beside the entries are not entries", async () => {
  const root = makeRoot({
    alpha: {
      "2026-04-12-first-run.md": entryText("2026-04-12", "First run", "Ran."),
      "case.yaml": tinyCase("alpha"),
      "chats/2026-05-01-first-chat.md": chatText("2026-05-01", "First chat", [
        "User: hi",
        "Sage: hello",
      ]),
      "notes.txt": "not an entry",
    },
  });
  const person = await withRoot(root, () => loadPerson("alpha"));
  assert.deepEqual(
    person.entries.map((entry) => entry.stem),
    ["2026-04-12-first-run"]
  );
  assert.deepEqual(
    person.chats.map((chat) => chat.stem),
    ["2026-05-01-first-chat"]
  );
});

test("loadPeople loads every person in id order, and only limits it", async () => {
  const root = makeRoot({
    ...threeEntries("beta"),
    ...threeEntries("alpha"),
    quiet: { "case.yaml": tinyCase("quiet") },
  });
  const [all, some] = await withRoot(root, async () => [
    await loadPeople(),
    await loadPeople({ only: ["quiet", "alpha"] }),
  ]);
  assert.deepEqual(
    all?.map((person) => person.id),
    ["alpha", "beta", "quiet"]
  );
  assert.deepEqual(
    some?.map((person) => person.id),
    ["alpha", "quiet"]
  );
});

test("loadPeople names the people it knows when only has a stranger", async () => {
  const root = makeRoot({ ...threeEntries("alpha"), ...threeEntries("beta") });
  await withRoot(root, async () => {
    await assert.rejects(
      () => loadPeople({ only: ["nobody"] }),
      unknownPersonPattern
    );
  });
});

test("loadPeople returns an empty list when there is no people folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "sage-eval-nopeople-"));
  await withRoot(root, async () => {
    assert.deepEqual(await loadPeople(), []);
  });
});

test("loadPerson rejects a missing case.yaml, a wrong id, and a path as an id", async () => {
  const root = makeRoot({
    ghost: {
      "2026-04-12-first-run.md": entryText("2026-04-12", "Run", "Ran."),
    },
    mismatch: { "case.yaml": tinyCase("other") },
  });
  await withRoot(root, async () => {
    await assert.rejects(() => loadPerson("ghost"), noCaseYamlPattern);
    await assert.rejects(() => loadPerson("mismatch"), idMismatchPattern);
    await assert.rejects(() => loadPerson("../alpha"), badIdPattern);
  });
});

test("loadPerson names the field that does not match the schema", async () => {
  const root = makeRoot({
    broken: { "case.yaml": tinyCase("broken", "tags: nope\nfacts: 3\n") },
  });
  await withRoot(root, async () => {
    await assert.rejects(() => loadPerson("broken"), schemaPattern);
  });
});

test("loadPerson rejects a file named only with digits", async () => {
  const root = makeRoot({
    nums: {
      "007.md": entryText("2026-04-12", "Bond", "Shaken."),
      "case.yaml": tinyCase("nums"),
    },
  });
  await withRoot(root, async () => {
    await assert.rejects(() => loadPerson("nums"), digitsStemPattern);
  });
});

test("entry files need a real date, a title, and a body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-eval-entries-"));
  try {
    writeFileSync(
      join(dir, "bad-date.md"),
      "---\ntitle: No date\n---\n\nBody.\n"
    );
    await assert.rejects(() => loadEntryFiles(dir), dateFormatPattern);
    rmSync(join(dir, "bad-date.md"));

    writeFileSync(
      join(dir, "impossible.md"),
      entryText("2026-02-30", "Never", "Body.")
    );
    await assert.rejects(() => loadEntryFiles(dir), impossibleDatePattern);
    rmSync(join(dir, "impossible.md"));

    writeFileSync(
      join(dir, "no-title.md"),
      "---\ndate: 2026-06-01\n---\n\nBody.\n"
    );
    await assert.rejects(() => loadEntryFiles(dir), titlePattern);
    rmSync(join(dir, "no-title.md"));

    writeFileSync(
      join(dir, "no-body.md"),
      entryText("2026-06-01", "Empty", "")
    );
    await assert.rejects(() => loadEntryFiles(dir), bodyPattern);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("loadEntryFiles gives an empty list for a folder with no entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-eval-noentries-"));
  try {
    assert.deepEqual(await loadEntryFiles(dir), []);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("resolveEntry takes a 1-based number or a file stem", async () => {
  const person = await personWith("");
  assert.equal(resolveEntry(person, 1).stem, "2026-04-12-first-run");
  assert.equal(resolveEntry(person, 3).stem, "2026-06-15-told-sam");
  assert.equal(resolveEntry(person, "2026-05-22-shins").index, 2);
});

test("resolveEntry throws a readable error", async () => {
  const person = await personWith("");
  assert.throws(() => resolveEntry(person, 99), noEntry99Pattern);
  assert.throws(() => resolveEntry(person, 0), noEntry0Pattern);
  assert.throws(() => resolveEntry(person, "nope"), unknownStemPattern);
  assert.throws(
    () => resolveEntry(person, "2026-05-22-shins.md"),
    leaveOffMdPattern
  );
  const root = makeRoot({ quiet: { "case.yaml": tinyCase("quiet") } });
  const quiet = await withRoot(root, () => loadPerson("quiet"));
  assert.throws(() => resolveEntry(quiet, 1), emptyJournalPattern);
});

test("validatePerson accepts a sound person", async () => {
  const person = await personWith(
    [
      "events:",
      "  - { entry: 3, reference: They started dating }",
      "summaries:",
      "  - { entry: 2026-04-12-first-run, reference: A run }",
      "retrieval:",
      "  - { query: running, when: April, expectEntry: 2026-04-12-first-run }",
      "  - { query: running, when: May, expectEntry: 2 }",
      "chat:",
      "  - { question: Q, reference: R, needs: [1, 2026-06-15-told-sam] }",
      "",
    ].join("\n")
  );
  assert.deepEqual(validatePerson(person, TODAY), []);
});

test("validatePerson allows an entry dated today and flags a later one", async () => {
  const person = await personWith("");
  assert.deepEqual(validatePerson(person, "2026-06-15"), []);
  assert.deepEqual(validatePerson(person, "2026-06-14"), [
    "2026-06-15-told-sam.md is dated 2026-06-15, after 2026-06-14.",
  ]);
});

test("validatePerson flags a today that is not a date", async () => {
  const person = await personWith("");
  assert.equal(validatePerson(person, "soon").length, 1);
  assert.equal(validatePerson(person, "2026-02-30").length, 1);
});

test("validatePerson names every ref that matches no entry", async () => {
  const person = await personWith(
    [
      "events:",
      "  - { entry: 9, reference: E }",
      "summaries:",
      "  - { entry: missing-stem, reference: S }",
      "retrieval:",
      "  - { query: q, expectEntry: also-missing }",
      "chat:",
      "  - { question: Q, reference: R, needs: [4] }",
      "openers:",
      "  - { id: hello, message: hi, expect: question, needs: [nope] }",
      "",
    ].join("\n")
  );
  const problems = validatePerson(person, TODAY);
  assert.equal(problems.length, 5);
  assert.match(problems[0] ?? "", badEventPattern);
  assert.match(problems[1] ?? "", badSummaryPattern);
  assert.match(problems[2] ?? "", badRetrievalPattern);
  assert.match(problems[3] ?? "", badChatPattern);
  assert.match(problems[4] ?? "", badOpenerPattern);
});

test("validatePerson checks that a when window holds the expected entry", async () => {
  const person = await personWith(
    [
      "retrieval:",
      "  - { query: running, when: May, expectEntry: 1 }",
      "  - { query: running, when: in April, expectEntry: 1 }",
      "  - { query: told, when: June, expectEntry: 3 }",
      "  - { query: told, when: since March, expectEntry: 3 }",
      "  - { query: told, when: last month, expectEntry: 3 }",
      "",
    ].join("\n")
  );
  const problems = validatePerson(person, TODAY);
  assert.equal(problems.length, 2);
  assert.equal(
    problems[0],
    'retrieval[0] (query "running"): when "May" covers 2026-05-01 to 2026-05-31 on 2026-11-15, but 2026-04-12-first-run.md is dated 2026-04-12.'
  );
  assert.match(problems[1] ?? "", lastMonthPattern);
});

test("validatePerson reads when against the day it is given", async () => {
  const person = await personWith(
    "retrieval:\n  - { query: told, when: last month, expectEntry: 3 }\n"
  );
  assert.equal(validatePerson(person, TODAY).length, 1);
  assert.deepEqual(validatePerson(person, "2026-07-02"), []);
});

test("validatePerson flags a when that does not read as a time", async () => {
  const person = await personWith(
    "retrieval:\n  - { query: q, when: whenever, expectEntry: 1 }\n"
  );
  const problems = validatePerson(person, TODAY);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", unreadableWhenPattern);
});

test("journalIdFor maps an entry's index onto its seeded journal id", async () => {
  const person = await personWith("");
  const manifest = { cases: { tmp: { journalIds: [10, 11, 12] } } };
  assert.equal(journalIdFor(manifest, "tmp", resolveEntry(person, 3)), 12);
  assert.equal(
    journalIdFor(manifest, "tmp", resolveEntry(person, "2026-04-12-first-run")),
    10
  );
});

test("journalIdFor rejects a missing person or a missing id", async () => {
  const person = await personWith("");
  const entry = resolveEntry(person, 3);
  assert.throws(
    () => journalIdFor({ cases: {} }, "missing", entry),
    missingPattern
  );
  assert.throws(
    () => journalIdFor({ cases: { tmp: { journalIds: [10] } } }, "tmp", entry),
    noJournalIdPattern
  );
});

test("loadManifest reads a path, or SAGE_EVAL_MANIFEST by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-eval-manifest-"));
  const path = join(dir, "manifest.json");
  writeFileSync(
    path,
    `${JSON.stringify({ cases: { "sam-example": { journalIds: [10, 11] } } })}\n`
  );
  const previous = process.env.SAGE_EVAL_MANIFEST;
  try {
    delete process.env.SAGE_EVAL_MANIFEST;
    assert.throws(() => loadManifest(), manifestEnvPattern);
    assert.deepEqual(
      loadManifest(path).cases["sam-example"].journalIds,
      [10, 11]
    );
    process.env.SAGE_EVAL_MANIFEST = path;
    assert.deepEqual(loadManifest().cases["sam-example"].journalIds, [10, 11]);
  } finally {
    if (previous === undefined) {
      delete process.env.SAGE_EVAL_MANIFEST;
    } else {
      process.env.SAGE_EVAL_MANIFEST = previous;
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("loadManifest rejects a file without journal ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-eval-manifest-"));
  try {
    const path = join(dir, "manifest.json");
    writeFileSync(path, JSON.stringify({ cases: { alpha: {} } }));
    assert.throws(() => loadManifest(path), noJournalIdsPattern);
    writeFileSync(path, "{}");
    assert.throws(() => loadManifest(path), noCasesPattern);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("the shipped people load and validate as of the pinned day", {
  skip: skipWithoutContent(),
}, async () => {
  const people = await loadPeople();
  assert.ok(people.length > 0);
  for (const person of people) {
    assert.deepEqual(
      validatePerson(person, TODAY),
      [],
      `${person.id} has problems`
    );
  }
});

test("the Sam example is one person with the look-alike pair and both stale facts", {
  skip: skipWithoutContent(),
}, async () => {
  const sam = await loadPerson("sam-example");
  assert.equal(sam.empty, false);
  assert.ok(sam.personCase.tags.includes("example"));
  assert.ok(sam.entries.length >= 18 && sam.entries.length <= 22);
  assert.equal(sam.entries[0]?.stem, "2026-04-12-first-half-marathon");
  assert.equal(sam.entries[1]?.stem, "2026-05-22-shin-splints");
  assert.deepEqual(
    sam.personCase.facts.map((fact) => [
      fact.subject,
      fact.stale !== undefined,
    ]),
    [
      ["Sam", true],
      ["user", true],
    ]
  );
  assert.equal(
    resolveEntry(sam, sam.personCase.retrieval[0]?.expectEntry ?? 0).stem,
    "2026-06-15-told-sam"
  );
  assert.deepEqual(
    sam.personCase.retrieval.slice(-2).map((item) => item.when),
    ["April", "May"]
  );
  for (const entry of sam.entries) {
    assert.ok(entry.date <= TODAY, `${entry.fileName} is after ${TODAY}`);
  }
  // The fillers stay out of the months the `when` checks read.
  const fillers = sam.entries.filter((entry) => entry.date >= "2026-07-01");
  assert.ok(fillers.length >= 12);
  for (const entry of sam.entries) {
    const month = entry.date.slice(0, 7);
    if (month === "2026-04" || month === "2026-05") {
      assert.ok(
        entry.stem === "2026-04-12-first-half-marathon" ||
          entry.stem === "2026-05-22-shin-splints",
        `${entry.fileName} sits in a month the when checks read`
      );
    }
  }
});

test("new-user is an empty journal", {
  skip: skipWithoutContent(),
}, async () => {
  const person = await loadPerson("new-user");
  assert.equal(person.empty, true);
  assert.deepEqual(person.entries, []);
  assert.match(person.personCase.about, firstTimePattern);
});

// ---------------------------------------------------------------------------
// Past chats
// ---------------------------------------------------------------------------

const CHAT_STEM = "2026-09-16-three-questions";

/** Three entries, and a past chat of the given file text. */
function withChat(
  chat: string,
  extra = ""
): Record<string, Record<string, string>> {
  const files = threeEntries("tmp", extra);
  files.tmp = { ...files.tmp, [`chats/${CHAT_STEM}.md`]: chat };
  return files;
}

const goodChat = chatText("2026-09-16", "Three questions", [
  "User: Help me with a list.",
  "Sage: Sure. What is it for?",
  "User: A meeting.",
  "Sage: Then start with what you want from it.",
]);

test("parseChatTurns splits a body into User and Sage turns", () => {
  assert.deepEqual(
    parseChatTurns("User: Hi.\nSage: Hello.\n\nUser:   Bye.\n"),
    [
      { role: "user", text: "Hi." },
      { role: "assistant", text: "Hello." },
      { role: "user", text: "Bye." },
    ]
  );
});

test("a turn can run over several lines, and a marker later in a line is not a marker", () => {
  const turns = parseChatTurns(
    "User: First line.\nSecond line.\n\nThird after a gap. Sage: not a marker.\nSage: Reply."
  );
  assert.equal(turns.length, 2);
  assert.equal(
    turns[0]?.text,
    "First line.\nSecond line.\n\nThird after a gap. Sage: not a marker."
  );
  assert.equal(turns[1]?.text, "Reply.");
});

test("parseChatTurns rejects text before the first marker and a turn with no text", () => {
  assert.throws(() => parseChatTurns("Hello there.\nUser: Hi."), pattern13);
  assert.throws(
    () => parseChatTurns("User: Hi.\nSage:\nUser: Bye."),
    pattern12
  );
  assert.deepEqual(parseChatTurns("\n\n"), []);
  // A marker needs the capital letter and the colon at the start of the line.
  assert.throws(() => parseChatTurns("user: hi"), pattern11);
  assert.throws(() => parseChatTurns("  User: hi"), pattern11);
});

test("loadPerson reads past chats in filename order with stems, dates, titles, and turns", async () => {
  const files = withChat(goodChat);
  files.tmp = {
    ...files.tmp,
    "chats/2026-07-01-earlier.md": chatText("2026-07-01", "Earlier", [
      "User: One.",
      "Sage: Two.",
    ]),
  };
  const person = await withRoot(makeRoot(files), () => loadPerson("tmp"));
  assert.deepEqual(
    person.chats.map((chat) => [chat.index, chat.stem, chat.date, chat.title]),
    [
      [1, "2026-07-01-earlier", "2026-07-01", "Earlier"],
      [2, CHAT_STEM, "2026-09-16", "Three questions"],
    ]
  );
  assert.equal(person.chats[1]?.turns.length, 4);
  assert.equal(person.chats[1]?.turns[0]?.role, "user");
  assert.equal(person.chats[1]?.turns[1]?.role, "assistant");
  assert.equal(person.chats[1]?.wordCount, 20);
  assert.deepEqual(validatePerson(person, TODAY), []);
});

test("a person with no chats folder has no past chats", async () => {
  const person = await personWith("");
  assert.deepEqual(person.chats, []);
});

test("a chat file needs a real date, a title, and a turn, and says which file is wrong", async () => {
  const bad = async (text: string) =>
    await withRoot(makeRoot(withChat(text)), () => loadPerson("tmp"));
  await assert.rejects(
    bad(chatText("soon", "T", ["User: a", "Sage: b"])),
    pattern10
  );
  await assert.rejects(
    bad(chatText("2026-09-16", "", ["User: a", "Sage: b"])),
    pattern9
  );
  await assert.rejects(bad(chatText("2026-09-16", "T", [])), pattern8);
  await assert.rejects(
    bad(chatText("2026-09-16", "T", ["Hi there", "User: a"])),
    pattern7
  );
});

test("validatePerson flags a chat dated after today", async () => {
  const person = await withRoot(makeRoot(withChat(goodChat)), () =>
    loadPerson("tmp")
  );
  assert.deepEqual(validatePerson(person, "2026-09-16"), []);
  assert.deepEqual(validatePerson(person, "2026-09-15"), [
    `chats/${CHAT_STEM}.md is dated 2026-09-16, after 2026-09-15.`,
  ]);
});

test("validatePerson flags turns that do not alternate, starting with the person", async () => {
  const twoUsers = chatText("2026-09-16", "T", [
    "User: a",
    "User: b",
    "Sage: c",
  ]);
  const startsWithSage = chatText("2026-09-16", "T", ["Sage: a", "User: b"]);
  const cases = [
    [twoUsers, 2, "Sage:"],
    [startsWithSage, 1, "User:"],
  ] as const;
  await Promise.all(
    cases.map(async ([text, turn, marker]) => {
      const person = await withRoot(makeRoot(withChat(text)), () =>
        loadPerson("tmp")
      );
      const problems = validatePerson(person, TODAY);
      assert.equal(problems.length, 1);
      assert.equal(
        problems[0],
        `chats/${CHAT_STEM}.md: turn ${turn} should start with ${marker}. Turns alternate, starting with User:.`
      );
    })
  );
});

test("needs can name a past chat as chat:<stem>, and a bad one is named in the problems", async () => {
  const extra = [
    "chat:",
    `  - { question: Q, reference: R, needs: [1, "chat:${CHAT_STEM}"] }`,
    "openers:",
    "  - id: last-time",
    "    message: Last time we talked.",
    "    expect: question",
    `    needs: ["chat:${CHAT_STEM}", 2026-04-12-first-run]`,
    "  - id: wrong",
    "    message: Hm.",
    "    expect: question",
    '    needs: ["chat:nope", "chat:", 2026-04-12-first-run]',
    "",
  ].join("\n");
  const root = makeRoot(withChat(goodChat, extra));
  // A bare "chat:" is refused by the schema before the loader checks anything.
  await assert.rejects(
    withRoot(root, () => loadPerson("tmp")),
    pattern6
  );
  const fixed = extra.replace(', "chat:", ', ", ");
  const person = await withRoot(makeRoot(withChat(goodChat, fixed)), () =>
    loadPerson("tmp")
  );
  assert.deepEqual(validatePerson(person, TODAY), [
    'openers (in wrong).needs: tmp has no past chat with the stem "nope". A stem looks like "2026-09-16-three-questions".',
  ]);
});

test("an opener that also runs on the empty journal cannot say search: needed", async () => {
  const person = await personWith(
    [
      "openers:",
      "  - { id: hey, message: hey, expect: question, search: none, alsoEmpty: true }",
      "  - { id: maybe, message: hm, expect: question, search: optional, alsoEmpty: true }",
      "  - { id: plain, message: hm, expect: question, alsoEmpty: true }",
      "  - { id: look, message: hm, expect: question, search: needed }",
      "  - { id: bad, message: hm, expect: question, search: needed, alsoEmpty: true }",
      "",
    ].join("\n")
  );
  assert.deepEqual(validatePerson(person, TODAY), [
    "openers (in bad): alsoEmpty is set, but search is needed. The empty journal has nothing to find, so use search none or optional, or take alsoEmpty off.",
  ]);
});

test("a conversation's script entries are checked like an opener's needs, and cannot ask for a hit on the empty journal", async () => {
  const person = await personWith(
    [
      "conversations:",
      "  - id: asks",
      "    opening: hi",
      "    expect: question",
      "    persona: { situation: s, wants: vent, style: terse, openness: open }",
      "    script:",
      "      2: { message: what did I say, search: needed, needs: [2026-04-12-first-run] }",
      '      3: "and then?"',
      "      4: { message: and the other time, needs: [nope] }",
      "  - id: also",
      "    opening: hi",
      "    expect: question",
      "    alsoEmpty: true",
      "    persona: { situation: s, wants: vent, style: terse, openness: open }",
      "    script:",
      "      2: { message: what did I say, search: optional }",
      "      3: { message: and then, search: needed }",
      "",
    ].join("\n")
  );
  const problems = validatePerson(person, TODAY);
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0] ?? "", badScriptNeedPattern);
  assert.equal(
    problems[1],
    "conversations (in also).script.3: alsoEmpty is set, but search is needed. The empty journal has nothing to find, so use search none or optional, or take alsoEmpty off."
  );
});

test("a person with no chats names no stem for a chat: need", async () => {
  const person = await personWith(
    [
      "openers:",
      "  - id: a",
      "    message: m",
      "    expect: question",
      '    needs: ["chat:x"]',
      "",
    ].join("\n")
  );
  assert.deepEqual(validatePerson(person, TODAY), [
    'openers (in a).needs: tmp has no past chats, so there is no chat "x".',
  ]);
});

test("resolveChat takes a stem or a whole chat: ref, and resolveNeed picks the kind", async () => {
  const person = await withRoot(makeRoot(withChat(goodChat)), () =>
    loadPerson("tmp")
  );
  assert.equal(resolveChat(person, CHAT_STEM).title, "Three questions");
  assert.equal(resolveChat(person, `chat:${CHAT_STEM}`).stem, CHAT_STEM);
  assert.throws(() => resolveChat(person, `${CHAT_STEM}.md`), pattern5);
  const chat = resolveNeed(person, `chat:${CHAT_STEM}`);
  assert.equal(chat.kind, "chat");
  const entry = resolveNeed(person, "2026-04-12-first-run");
  assert.equal(entry.kind, "entry");
  assert.equal(resolveNeed(person, 2).kind, "entry");
  assert.throws(() => resolveNeed(person, "chat:nope"), pattern4);
});

test("chatIdFor maps a chat's index onto the id the seed step saved it under", async () => {
  const person = await withRoot(makeRoot(withChat(goodChat)), () =>
    loadPerson("tmp")
  );
  const [chat] = person.chats;
  assert.ok(chat);
  const manifest = {
    cases: { tmp: { chatIds: [31], journalIds: [10, 11, 12] } },
  };
  assert.equal(chatIdFor(manifest, "tmp", chat), 31);
  assert.throws(() => chatIdFor({ cases: {} }, "tmp", chat), pattern3);
  assert.throws(
    () => chatIdFor({ cases: { tmp: { journalIds: [1] } } }, "tmp", chat),
    pattern2
  );
});

test("loadManifest keeps chatIds, and refuses ones that are not numbers", () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-eval-manifest-"));
  try {
    const path = join(dir, "manifest.json");
    writeFileSync(
      path,
      JSON.stringify({
        cases: {
          a: { chatIds: [3, 4], journalIds: [1] },
          b: { journalIds: [2] },
        },
      })
    );
    const manifest = loadManifest(path);
    assert.deepEqual(manifest.cases.a.chatIds, [3, 4]);
    assert.equal(manifest.cases.b.chatIds, undefined);
    writeFileSync(
      path,
      JSON.stringify({ cases: { a: { chatIds: ["x"], journalIds: [1] } } })
    );
    assert.throws(() => loadManifest(path), pattern1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("the shipped past chats load, alternate, and are dated before the pinned day", {
  skip: skipWithoutContent(),
}, async () => {
  const people = await loadPeople();
  const withChats = people.filter((person) => person.chats.length > 0);
  assert.ok(withChats.length >= 9);
  let total = 0;
  for (const person of withChats) {
    for (const chat of person.chats) {
      total += 1;
      assert.ok(chat.date <= TODAY, `${person.id} ${chat.fileName}`);
      assert.ok(chat.turns.length >= 4, `${person.id} ${chat.fileName}`);
      assert.equal(chat.turns[0]?.role, "user");
    }
  }
  assert.equal(total, 27);
  const newUser = people.find((person) => person.id === "new-user");
  assert.deepEqual(newUser?.chats, []);
});

test("every opener that needs a past chat names one the person has", {
  skip: skipWithoutContent(),
}, async () => {
  const people = await loadPeople();
  let named = 0;
  for (const person of people) {
    for (const opener of person.personCase.openers) {
      for (const ref of opener.needs) {
        if (typeof ref === "string" && ref.startsWith("chat:")) {
          named += 1;
          assert.equal(
            resolveNeed(person, ref).kind,
            "chat",
            `${person.id} ${opener.id}`
          );
        }
      }
    }
  }
  assert.ok(named >= 8, `${named} openers name a past chat`);
});
