import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { LoadedEntry, LoadedPerson, Manifest } from "./dataset.ts";
import {
  chatMessageOf,
  chatSourceId,
  dreamAccuracyEvals,
  dreamItemId,
  dreamItemVerdicts,
  gradeDreamSource,
  groupDreamSources,
  listChatIds,
  MEMORY_OFF_REASON,
  NOTHING_WRITTEN_REASON,
  readDreamRows,
  recordDreamGrade,
  splitClaims,
} from "./dream-accuracy.ts";
import { createGradeCache } from "./dream-grade-cache.ts";
import {
  type DreamSource,
  formatFactSheet,
  formatSourceForJudge,
} from "./dream-judge-input.ts";
import type { Grader, JudgeCall, JudgeOutcome } from "./grader.ts";
import { makeItem, type ScoreHost } from "./record.ts";
import {
  type DreamSourceGrade,
  parsePersonCase,
  type UnsupportedClaim,
} from "./schema.ts";
import { type PassSetup, readPassSetup } from "./setup.ts";

const lostMiaLostMiaPattern = /^2026-09-03, "Lost Mia"\n\nLost Mia today\./u;
const sourceJournalEntryLostPattern =
  /^Source \(a journal entry\):\n2026-09-03, "Lost Mia"/u;
const whatTheAppWrotePattern =
  /What the app wrote from this source:\n\[summary\]\nMia died today\./u;
const factMiaWasThePattern = /\[fact\]\nMia: Was the author's best friend\./u;
const factSheetForSamPattern = /# Fact sheet for sam/u;
const miaFormerBestFriendPattern =
  /- Mia: former best friend, she\/her, alive\. Note: 'Lost Mia' means the friendship ended/u;
const bigTheFriendshipWithPattern =
  /- 2026-09-03 \(big\): The friendship with Mia ended/u;
const miaDiedPattern = /Mia died/u;
const whatTheAppWrotePattern2 = /What the app wrote from this source/u;
const samDreamOutputFromPattern = /sam: Dream output from entry 1/u;
const memoryOffPattern = /memory off/u;

const encryptedPattern = /encrypted/u;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MIA: LoadedEntry = {
  body: "Lost Mia today. I don't know how to write about it.",
  date: "2026-09-03",
  fileName: "2026-09-03-lost-mia.md",
  index: 1,
  stem: "2026-09-03-lost-mia",
  title: "Lost Mia",
  wordCount: 11,
};
const RUN: LoadedEntry = {
  body: "Ran five miles by the river.",
  date: "2026-09-10",
  fileName: "2026-09-10-river-run.md",
  index: 2,
  stem: "2026-09-10-river-run",
  title: "River run",
  wordCount: 6,
};

const person: LoadedPerson = {
  chats: [],
  dir: "/nowhere",
  empty: false,
  entries: [MIA, RUN],
  id: "sam",
  personCase: parsePersonCase({
    about: "A test author.",
    cast: [
      {
        alive: true,
        name: "Mia",
        note: "'Lost Mia' means the friendship ended",
        pronouns: "she/her",
        relation: "former best friend",
      },
    ],
    id: "sam",
    timeline: [
      {
        date: "2026-09-03",
        weight: "big",
        what: "The friendship with Mia ended",
      },
    ],
  }),
};

const manifest: Manifest = { cases: { sam: { journalIds: [101, 102] } } };

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "sage-dream-accuracy-"));
  const path = join(dir, "app.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE entry_summary (entry_id INTEGER PRIMARY KEY, summary TEXT NOT NULL);
    CREATE TABLE chat_conversation (id INTEGER PRIMARY KEY, title TEXT NOT NULL, title_locked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE chat_summary (conversation_id INTEGER PRIMARY KEY, summary TEXT NOT NULL);
    CREATE TABLE chat_event (conversation_id INTEGER NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (conversation_id, seq));
    CREATE TABLE semantic_fact (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, fact TEXT NOT NULL, source_type TEXT NOT NULL, source_id INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE episodic_event (id INTEGER PRIMARY KEY, event TEXT NOT NULL, occurred_at TEXT NOT NULL, source_type TEXT NOT NULL, source_id INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
  `);
  const summary = db.prepare(
    "INSERT INTO entry_summary (entry_id, summary) VALUES (?, ?)"
  );
  summary.run(101, "Mia died today.");
  summary.run(102, "A five mile run.");
  summary.run(999, "A summary of an entry the person does not have.");
  db.prepare(
    "INSERT INTO chat_conversation (id, title, title_locked) VALUES (?, ?, ?)"
  ).run(7, "Talking about Mia", 0);
  db.prepare(
    "INSERT INTO chat_conversation (id, title, title_locked) VALUES (?, ?, ?)"
  ).run(8, "My own title", 1);
  db.prepare(
    "INSERT INTO chat_summary (conversation_id, summary) VALUES (?, ?)"
  ).run(7, "The user misses Mia.");
  const event = db.prepare(
    "INSERT INTO chat_event (conversation_id, seq, event) VALUES (?, ?, ?)"
  );
  event.run(
    7,
    0,
    JSON.stringify({
      data: { message: "I miss Mia." },
      type: "message.received",
    })
  );
  event.run(
    7,
    1,
    JSON.stringify({ data: { status: "ok" }, type: "action.result" })
  );
  event.run(
    7,
    2,
    JSON.stringify({
      data: { message: "That sounds hard." },
      type: "message.completed",
    })
  );
  event.run(
    7,
    3,
    JSON.stringify({ data: { message: null }, type: "message.completed" })
  );
  const fact = db.prepare(
    "INSERT INTO semantic_fact (id, kind, subject, fact, source_type, source_id, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  fact.run(1, "profile", "user", "Writes to think.", "entry", 101, 0);
  fact.run(2, "fact", "Mia", "Was the author's best friend.", "entry", 101, 0);
  fact.run(3, "fact", "Mia", "A hidden fact.", "entry", 101, 1);
  fact.run(4, "fact", "Sam", "Added by the user.", "user", 0, 0);
  fact.run(5, "fact", "Mia", "Came up in a chat.", "conversation", 7, 0);
  fact.run(6, "fact", "Zed", "From an unknown entry.", "entry", 555, 0);
  const events = db.prepare(
    "INSERT INTO episodic_event (id, event, occurred_at, source_type, source_id, hidden) VALUES (?, ?, ?, ?, ?, ?)"
  );
  events.run(1, "Lost Mia.", "2026-09-03", "entry", 101, 0);
  events.run(2, "Went for a run.", "", "entry", 102, 0);
  db.close();
  return path;
}

function claim(overrides: Partial<UnsupportedClaim> = {}): UnsupportedClaim {
  return {
    itemKind: "summary",
    itemText: "Mia died today.",
    quote: "Mia died",
    reason: "The entry never says Mia died.",
    severity: "severe",
    ...overrides,
  };
}

interface Recorded {
  gate?: number;
  label?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  score?: number;
  soft?: number | "none";
}

function fakeHost(): { host: ScoreHost; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const host = {
    score(evaluation: unknown) {
      const input = evaluation as {
        message?: string;
        metadata?: Record<string, unknown>;
        score: number;
      };
      const entry: Recorded = {
        message: input.message,
        metadata: input.metadata,
        score: input.score,
      };
      recorded.push(entry);
      const handle = {
        gate(threshold?: number) {
          entry.gate = threshold ?? 1;
          return handle;
        },
        label(label: string) {
          entry.label = label;
          return handle;
        },
        soft(threshold?: number) {
          entry.soft = threshold ?? "none";
          return handle;
        },
      };
      return handle;
    },
  } as unknown as ScoreHost;
  return { host, recorded };
}

class Skipped extends Error {}

/** A stand-in for eve's context with `score` and a `skip` that throws. */
function fakeContext() {
  const { host, recorded } = fakeHost();
  const t = {
    score: host.score.bind(host),
    skip(reason: string): never {
      throw new Skipped(reason);
    },
  };
  return { recorded, t: t as never };
}

interface FakeGrader {
  calls: JudgeCall<never>[];
  grader: Grader;
}

/** A judge that answers every call from `answer`, and counts the calls. */
function fakeGrader(
  answer: (call: JudgeCall<never>) => JudgeOutcome<DreamSourceGrade>
): FakeGrader {
  const calls: JudgeCall<never>[] = [];
  const grader = {
    dreamRubric: "0123456789",
    judge: (call: JudgeCall<never>) => {
      calls.push(call);
      return Promise.resolve(answer(call));
    },
    modelId: "acme/judge-1",
    rubric: "abcdef0123",
  } as unknown as Grader;
  return { calls, grader };
}

function judged(claims: UnsupportedClaim[]): JudgeOutcome<DreamSourceGrade> {
  return {
    callId: "call-1",
    costUsd: 0.01,
    ok: true,
    usage: { inputTokens: 100, outputTokens: 10 },
    value: { unsupportedClaims: claims },
  };
}

function passFor(memory: "off" | "on"): PassSetup {
  const bare = readPassSetup({});
  return { ...bare, setup: { ...bare.setup, memory }, setupId: "0123456789" };
}

function asList<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------
// Reading and grouping
// ---------------------------------------------------------------------------

test("readDreamRows reads summaries, chats, facts, and events, without hidden rows", () => {
  const rows = readDreamRows(tempDb(), { memory: true });
  assert.deepEqual(
    rows.entrySummaries.map((row) => row.entryId),
    [101, 102, 999]
  );
  assert.deepEqual(
    rows.facts.map((row) => [row.id, row.kind]),
    [
      [1, "profile"],
      [2, "fact"],
      [4, "fact"],
      [5, "fact"],
      [6, "fact"],
    ]
  );
  assert.equal(rows.events.length, 2);
  const [chat] = rows.chats;
  assert.equal(chat.id, 7);
  assert.equal(chat.summary, "The user misses Mia.");
  assert.deepEqual(chat.messages, [
    { role: "user", text: "I miss Mia." },
    { role: "assistant", text: "That sounds hard." },
  ]);
  assert.equal(rows.chats[1].titleLocked, true);
  assert.equal(rows.chats[1].summary, null);
});

test("with memory off the facts and events are not read", () => {
  const rows = readDreamRows(tempDb(), { memory: false });
  assert.deepEqual(rows.facts, []);
  assert.deepEqual(rows.events, []);
  assert.equal(rows.entrySummaries.length, 3);
  assert.equal(rows.chats.length, 2);
});

test("an encrypted row stops the read", () => {
  const path = tempDb();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE entry_summary SET summary = ? WHERE entry_id = 101").run(
    "sage:v1:ciphertext"
  );
  db.close();
  assert.throws(() => readDreamRows(path, { memory: false }), encryptedPattern);
});

test("listChatIds lists chats, and gives an empty list for a missing or unreadable file", () => {
  assert.deepEqual(listChatIds(tempDb()), [7, 8]);
  const dir = mkdtempSync(join(tmpdir(), "sage-dream-accuracy-"));
  assert.deepEqual(listChatIds(join(dir, "app.db")), []);
  mkdirSync(join(dir, "folder.db"));
  assert.deepEqual(listChatIds(join(dir, "folder.db")), []);
});

test("chatMessageOf reads User and Sage messages only", () => {
  assert.deepEqual(
    chatMessageOf('{"type":"message.received","data":{"message":" hi "}}'),
    { role: "user", text: "hi" }
  );
  assert.deepEqual(
    chatMessageOf('{"type":"message.completed","data":{"message":"hello"}}'),
    { role: "assistant", text: "hello" }
  );
  assert.equal(
    chatMessageOf('{"type":"message.completed","data":{"message":null}}'),
    null
  );
  assert.equal(chatMessageOf('{"type":"action.result","data":{}}'), null);
  assert.equal(chatMessageOf("not json message.received"), null);
});

test("chatMessageOf reads eve 1.0 User and Sage messages", () => {
  const event = (type: string, data: Record<string, unknown>) =>
    JSON.stringify({ data, type });
  assert.deepEqual(
    chatMessageOf(
      event("delivery.consumed", {
        parts: [
          { kind: "file", mediaType: "image/png" },
          { kind: "text", text: " hi " },
        ],
      })
    ),
    { role: "user", text: "hi" }
  );
  assert.deepEqual(
    chatMessageOf(
      event("content.completed", {
        kind: "text",
        phase: "reply",
        value: "hello",
      })
    ),
    { role: "assistant", text: "hello" }
  );
  assert.equal(
    chatMessageOf(
      event("content.completed", { kind: "reasoning", value: "hm" })
    ),
    null
  );
  assert.equal(chatMessageOf(event("delivery.consumed", { parts: [] })), null);
  assert.equal(chatMessageOf(event("call.settled", { output: {} })), null);
});

test("everything Dream wrote is grouped under its source", () => {
  const rows = readDreamRows(tempDb(), { memory: true });
  const sources = groupDreamSources(rows, [
    { ...MIA, journalId: 101 },
    { ...RUN, journalId: 102 },
  ]);
  assert.deepEqual(
    sources.map((source) => [source.sourceId, source.sourceKind]),
    [
      ["2026-09-03-lost-mia", "entry"],
      ["2026-09-10-river-run", "entry"],
      ["chat-7", "chat"],
    ]
  );

  const [mia, run, chat] = sources;
  assert.deepEqual(
    mia.written.map((item) => [item.itemKind, item.text]),
    [
      ["summary", "Mia died today."],
      ["profile", "Writes to think."],
      ["fact", "Mia: Was the author's best friend."],
      ["event", "2026-09-03: Lost Mia."],
    ]
  );
  assert.match(mia.sourceText, lostMiaLostMiaPattern);
  assert.deepEqual(
    run.written.map((item) => [item.itemKind, item.text]),
    [
      ["summary", "A five mile run."],
      ["event", "Went for a run."],
    ]
  );
  assert.deepEqual(
    chat.written.map((item) => [item.itemKind, item.text]),
    [
      ["chat-summary", "The user misses Mia."],
      ["chat-title", "Talking about Mia"],
      ["fact", "Mia: Came up in a chat."],
    ]
  );
  assert.equal(chat.sourceText, "User: I miss Mia.\n\nSage: That sounds hard.");
});

test("rows the user added, rows from unknown sources, and a renamed chat's title are left out", () => {
  const rows = readDreamRows(tempDb(), { memory: true });
  const sources = groupDreamSources(rows, [
    { ...MIA, journalId: 101 },
    { ...RUN, journalId: 102 },
  ]);
  const text = sources.flatMap((source) =>
    source.written.map((item) => item.text)
  );
  assert.equal(
    text.some((line) => line.includes("Added by the user")),
    false
  );
  assert.equal(
    text.some((line) => line.includes("unknown entry")),
    false
  );
  assert.equal(text.includes("My own title"), false);
  assert.equal(
    sources.some((source) => source.sourceId === "chat-8"),
    false
  );
});

test("a source Dream wrote nothing from is left out", () => {
  const rows = readDreamRows(tempDb(), { memory: false });
  const sources = groupDreamSources(rows, [
    { ...MIA, journalId: 101 },
    { ...RUN, journalId: 4242 },
  ]);
  assert.deepEqual(
    sources.map((source) => source.sourceId),
    ["2026-09-03-lost-mia", "chat-7"]
  );
  assert.deepEqual(
    sources[0].written.map((item) => item.itemKind),
    ["summary"]
  );
});

test("the judge sees the source, then each written item under its kind, and a fact sheet with no journal", () => {
  const rows = readDreamRows(tempDb(), { memory: true });
  const [mia] = groupDreamSources(rows, [{ ...MIA, journalId: 101 }]);
  const text = formatSourceForJudge(mia);
  assert.match(text, sourceJournalEntryLostPattern);
  assert.match(text, whatTheAppWrotePattern);
  assert.match(text, factMiaWasThePattern);

  const sheet = formatFactSheet(person);
  assert.match(sheet, factSheetForSamPattern);
  assert.match(sheet, miaFormerBestFriendPattern);
  assert.match(sheet, bigTheFriendshipWithPattern);
  assert.equal(sheet.includes("Lost Mia today"), false);
  assert.equal(sheet.includes("# Journal"), false);
});

test("ids: entries use the stem and chats use chat-N", () => {
  assert.equal(
    dreamItemId("sam", "2026-09-03-lost-mia"),
    "sam/dream/2026-09-03-lost-mia"
  );
  assert.equal(chatSourceId(12), "chat-12");
});

// ---------------------------------------------------------------------------
// Severity, hard against counted
// ---------------------------------------------------------------------------

test("claims split by severity", () => {
  const { other, severe } = splitClaims([
    claim(),
    claim({ severity: "other" }),
    claim({ quote: "x", severity: "other" }),
  ]);
  assert.equal(severe.length, 1);
  assert.equal(other.length, 2);
});

const [mia] = groupDreamSources(readDreamRows(tempDb(), { memory: false }), [
  { ...MIA, journalId: 101 },
]);
const ref = makeItem(
  {
    itemId: "sam/dream/2026-09-03-lost-mia",
    kind: "dream-source",
    person: "sam",
  },
  "0123456789"
);

function recordWith(claims: UnsupportedClaim[]): Recorded[] {
  const { host, recorded } = fakeHost();
  recordDreamGrade(host, ref, mia, {
    cached: false,
    claims,
    model: "acme/judge-1",
    ok: true,
    rubric: "0123456789",
  });
  return recorded;
}

function byLabel(recorded: Recorded[], label: string): Recorded {
  const found = recorded.find((entry) => entry.label === label);
  assert.ok(found, `no ${label}`);
  return found;
}

test("a severe claim fails the hard check and leaves the counted one passing", () => {
  const recorded = recordWith([claim()]);
  const hard = byLabel(recorded, "hard:no-severe-unsupported");
  assert.equal(hard.gate, 1);
  assert.equal(hard.score, 0);
  assert.match(hard.message ?? "", miaDiedPattern);
  assert.deepEqual(hard.metadata?.claims, [claim()]);
  const counted = byLabel(recorded, "counted:dream-supported");
  assert.equal(counted.soft, 1);
  assert.equal(counted.score, 1);
  assert.deepEqual(counted.metadata?.claims, []);
});

test("an other claim fails the counted check and leaves the hard one passing", () => {
  const other = claim({ quote: "avoiding them", severity: "other" });
  const recorded = recordWith([other]);
  assert.equal(byLabel(recorded, "hard:no-severe-unsupported").score, 1);
  const counted = byLabel(recorded, "counted:dream-supported");
  assert.equal(counted.score, 0);
  assert.equal(counted.soft, 1);
  assert.deepEqual(counted.metadata?.claims, [other]);
  assert.equal(counted.metadata?.sourceId, "2026-09-03-lost-mia");
  assert.equal(counted.metadata?.judgeModel, "acme/judge-1");
});

test("no claims pass both checks, and the source goes in a soft score for the report", () => {
  const recorded = recordWith([]);
  assert.equal(byLabel(recorded, "hard:no-severe-unsupported").score, 1);
  assert.equal(byLabel(recorded, "counted:dream-supported").score, 1);
  const source = byLabel(recorded, "soft:dream-source");
  assert.equal(source.soft, "none");
  const dream = source.metadata?.dream as {
    sourceId: string;
    sourceKind: string;
    unsupportedClaims: unknown[];
    written: { itemKind: string }[];
  };
  assert.equal(dream.sourceId, "2026-09-03-lost-mia");
  assert.equal(dream.sourceKind, "entry");
  assert.deepEqual(dream.unsupportedClaims, []);
  assert.deepEqual(
    dream.written.map((item) => item.itemKind),
    ["summary"]
  );
});

test("a judge error records both checks as not graded, never as failed", () => {
  const { host, recorded } = fakeHost();
  recordDreamGrade(host, ref, mia, {
    model: "acme/judge-1",
    ok: false,
    reason: "not graded: spending cap",
    rubric: "0123456789",
  });
  for (const label of [
    "hard:no-severe-unsupported",
    "counted:dream-supported",
    "soft:dream-source",
  ]) {
    const entry = byLabel(recorded, label);
    assert.equal(entry.gate, undefined);
    assert.equal(entry.soft, "none");
    assert.equal(entry.metadata?.notGraded, true);
    assert.equal(entry.message, "not graded: spending cap");
  }
});

// ---------------------------------------------------------------------------
// dream-supported counts the items Dream wrote
// ---------------------------------------------------------------------------

const WRITTEN_SOURCE: DreamSource = {
  sourceId: "2026-09-03-lost-mia",
  sourceKind: "entry",
  sourceText: '2026-09-03, "Lost Mia"\n\nLost Mia today.',
  written: [
    {
      itemKind: "summary",
      text: "Mia died. Jordan, the author's husband, asked to talk.",
    },
    { itemKind: "fact", text: "Jordan: Is the author's husband." },
    { itemKind: "fact", text: "Mia: Was a friend of the author." },
    { itemKind: "event", text: "2026-09-03: Jordan moved out." },
  ],
};

function otherClaim(
  itemKind: UnsupportedClaim["itemKind"],
  quote: string,
  itemText = quote
): UnsupportedClaim {
  return {
    itemKind,
    itemText,
    quote,
    reason: "Not in the entry.",
    severity: "other",
  };
}

function recordSource(
  source: DreamSource,
  claims: UnsupportedClaim[]
): Recorded[] {
  const { host, recorded } = fakeHost();
  recordDreamGrade(host, ref, source, {
    cached: false,
    claims,
    model: "acme/judge-1",
    ok: true,
    rubric: "0123456789",
  });
  return recorded;
}

function countedScores(recorded: Recorded[]): number[] {
  return recorded
    .filter((entry) => entry.label === "counted:dream-supported")
    .map((entry) => entry.score ?? -1);
}

test("every item Dream wrote is one counted check, and a bad item is one failure", () => {
  const recorded = recordSource(WRITTEN_SOURCE, [
    otherClaim("fact", "Is the author's husband."),
  ]);
  assert.deepEqual(countedScores(recorded), [1, 0, 1, 1]);
  const counted = recorded.filter(
    (entry) => entry.label === "counted:dream-supported"
  );
  assert.ok(counted.every((entry) => entry.soft === 1));
  assert.deepEqual(
    counted.map((entry) => entry.metadata?.itemKind),
    ["summary", "fact", "fact", "event"]
  );
  assert.equal(
    counted[1]?.metadata?.itemText,
    "Jordan: Is the author's husband."
  );
  assert.equal(counted[1]?.metadata?.evidence, "Is the author's husband.");
});

test("three claims against one item are one failure, and three items with a claim each are three", () => {
  const same = recordSource(WRITTEN_SOURCE, [
    otherClaim("summary", "the author's husband"),
    otherClaim("summary", "asked to talk"),
    otherClaim("summary", "Mia died."),
  ]);
  assert.deepEqual(countedScores(same), [0, 1, 1, 1]);
  const first = byLabel(same, "counted:dream-supported");
  assert.deepEqual(first.metadata?.claims, [
    otherClaim("summary", "the author's husband"),
    otherClaim("summary", "asked to talk"),
    otherClaim("summary", "Mia died."),
  ]);

  const spread = recordSource(WRITTEN_SOURCE, [
    otherClaim("summary", "the author's husband"),
    otherClaim("fact", "Is the author's husband."),
    otherClaim("event", "Jordan moved out."),
  ]);
  assert.deepEqual(countedScores(spread), [0, 0, 1, 0]);
});

test("a severe claim is not counted against any item", () => {
  const recorded = recordSource(WRITTEN_SOURCE, [
    claim({ itemText: WRITTEN_SOURCE.written[0]?.text ?? "" }),
  ]);
  assert.deepEqual(countedScores(recorded), [1, 1, 1, 1]);
  assert.equal(byLabel(recorded, "hard:no-severe-unsupported").score, 0);
});

test("a claim finds its item by the whole text, a part of it, or only the quote, ignoring case and spacing", () => {
  const verdicts = (claims: UnsupportedClaim[]) =>
    dreamItemVerdicts(WRITTEN_SOURCE, claims).map((v) => v.claims.length);
  // The whole text, with other spacing and case.
  assert.deepEqual(
    verdicts([
      otherClaim("fact", "x", "  jordan:  IS the author's\nhusband. "),
    ]),
    [0, 1, 0, 0]
  );
  // A part of the text.
  assert.deepEqual(
    verdicts([otherClaim("event", "x", "Jordan moved out")]),
    [0, 0, 0, 1]
  );
  // Only the quote, since the item text is empty.
  assert.deepEqual(
    verdicts([otherClaim("fact", "Was a friend", "")]),
    [0, 0, 1, 0]
  );
});

test("a judge that names the wrong kind still reaches the item", () => {
  const verdicts = dreamItemVerdicts(WRITTEN_SOURCE, [
    otherClaim("profile", "Jordan moved out."),
  ]);
  assert.deepEqual(
    verdicts.map((v) => v.claims.length),
    [0, 0, 0, 1]
  );
});

test("a claim that fits nothing Dream wrote is still one failure, once for each text it names", () => {
  const verdicts = dreamItemVerdicts(WRITTEN_SOURCE, [
    otherClaim("fact", "owns a boat", "Jordan: Owns a boat."),
    otherClaim("fact", "a second quote", "jordan:  owns a BOAT."),
    otherClaim("summary", "never happened", "Something else."),
  ]);
  assert.equal(verdicts.length, WRITTEN_SOURCE.written.length + 2);
  assert.deepEqual(
    verdicts.map((v) => v.claims.length),
    [0, 0, 0, 0, 2, 1]
  );
  const recorded = recordSource(WRITTEN_SOURCE, [
    otherClaim("fact", "owns a boat", "Jordan: Owns a boat."),
  ]);
  assert.deepEqual(countedScores(recorded), [1, 1, 1, 1, 0]);
});

test("with no claims every item passes", () => {
  assert.deepEqual(
    countedScores(recordSource(WRITTEN_SOURCE, [])),
    [1, 1, 1, 1]
  );
});

// ---------------------------------------------------------------------------
// The grade cache, through the judge
// ---------------------------------------------------------------------------

function cacheIn(key = "snap"): ReturnType<typeof createGradeCache> {
  const cacheDir = mkdtempSync(join(tmpdir(), "sage-dream-cache-"));
  mkdirSync(join(cacheDir, key));
  return createGradeCache({
    cacheDir,
    enabled: true,
    key,
    model: "acme/judge-1",
    rubric: "0123456789",
  });
}

test("a miss calls the judge once, and the next read answers from the cache without calling it", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "sage-dream-cache-"));
  mkdirSync(join(cacheDir, "snap"));
  const location = {
    cacheDir,
    enabled: true,
    key: "snap",
    model: "acme/judge-1",
    rubric: "0123456789",
  };
  const { calls, grader } = fakeGrader(() => judged([claim()]));
  const input = { context: "sheet", grader, itemId: ref.itemId, source: mia };

  const first = await gradeDreamSource({
    ...input,
    cache: createGradeCache(location),
  });
  assert.equal(calls.length, 1);
  assert.equal(first.ok && first.cached, false);
  assert.equal(calls[0].schemaName, "dream_source_grade");
  assert.match(calls[0].item, whatTheAppWrotePattern2);
  assert.equal(calls[0].context, "sheet");

  // A new process reads the file.
  const second = await gradeDreamSource({
    ...input,
    cache: createGradeCache(location),
  });
  assert.equal(calls.length, 1);
  assert.ok(second.ok);
  assert.equal(second.cached, true);
  assert.deepEqual(second.claims, [claim()]);
  assert.equal(second.model, "acme/judge-1");
});

test("the cache is keyed by the Dream hash, and the result reports the whole rubric hash", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "sage-dream-cache-"));
  mkdirSync(join(cacheDir, "snap"));
  const location = {
    cacheDir,
    enabled: true,
    key: "snap",
    model: "acme/judge-1",
  };
  const { calls, grader } = fakeGrader(() => judged([]));
  const input = { context: "sheet", grader, itemId: ref.itemId, source: mia };
  const first = await gradeDreamSource({
    ...input,
    cache: createGradeCache({ ...location, rubric: grader.dreamRubric }),
  });
  assert.equal(first.rubric, grader.rubric);
  assert.notEqual(grader.rubric, grader.dreamRubric);

  // A cache named for the whole rubric hash is a different file and a miss.
  await gradeDreamSource({
    ...input,
    cache: createGradeCache({ ...location, rubric: grader.rubric }),
  });
  assert.equal(calls.length, 2);

  // The Dream hash finds the first grade.
  const again = await gradeDreamSource({
    ...input,
    cache: createGradeCache({ ...location, rubric: grader.dreamRubric }),
  });
  assert.equal(calls.length, 2);
  assert.ok(again.ok && again.cached);
  assert.equal(again.rubric, grader.rubric);
});

test("a changed fact sheet or a changed source is graded again", async () => {
  const cache = cacheIn();
  const { calls, grader } = fakeGrader(() => judged([]));
  const input = { cache, grader, itemId: ref.itemId, source: mia };
  await gradeDreamSource({ ...input, context: "sheet" });
  await gradeDreamSource({ ...input, context: "sheet" });
  assert.equal(calls.length, 1);
  await gradeDreamSource({ ...input, context: "edited sheet" });
  assert.equal(calls.length, 2);
  await gradeDreamSource({
    ...input,
    context: "edited sheet",
    source: {
      ...mia,
      written: [{ itemKind: "summary", text: "Another summary." }],
    },
  });
  assert.equal(calls.length, 3);
});

test("with no snapshot key the judge is called every time", async () => {
  const cache = createGradeCache({
    key: undefined,
    model: "acme/judge-1",
    rubric: "0123456789",
  });
  const { calls, grader } = fakeGrader(() => judged([]));
  const input = {
    cache,
    context: "sheet",
    grader,
    itemId: ref.itemId,
    source: mia,
  };
  await gradeDreamSource(input);
  await gradeDreamSource(input);
  assert.equal(calls.length, 2);
});

test("a judge error is not cached", async () => {
  const cache = cacheIn();
  // The first call fails and every later one succeeds.
  const outcomes: JudgeOutcome<DreamSourceGrade>[] = [
    { ok: false, reason: "not graded: judge error: boom" },
  ];
  const { calls, grader } = fakeGrader(() => outcomes.shift() ?? judged([]));
  const input = {
    cache,
    context: "sheet",
    grader,
    itemId: ref.itemId,
    source: mia,
  };
  const first = await gradeDreamSource(input);
  assert.equal(first.ok, false);
  const second = await gradeDreamSource(input);
  assert.ok(second.ok);
  assert.equal(second.cached, false);
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------------------
// The evals
// ---------------------------------------------------------------------------

function buildEvals(options: { grader: Grader; memory: "off" | "on" }) {
  const dbPath = tempDb();
  const reads: { memory: boolean }[] = [];
  const evals = dreamAccuracyEvals(
    { pass: passFor(options.memory), person },
    {
      cache: createGradeCache({ key: undefined, model: "m", rubric: "r" }),
      dbPath: () => dbPath,
      grader: options.grader,
      loadManifest: () => manifest,
      readRows: (path, readOptions) => {
        reads.push(readOptions);
        return readDreamRows(path, readOptions);
      },
    }
  );
  return { evals, reads };
}

test("one eval per entry and per chat, with item ids and tags", () => {
  const { grader } = fakeGrader(() => judged([]));
  const { evals } = buildEvals({ grader, memory: "on" });
  assert.deepEqual(
    evals.map((definition) => definition.metadata?.itemId),
    [
      "sam/dream/2026-09-03-lost-mia",
      "sam/dream/2026-09-10-river-run",
      "sam/dream/chat-7",
      "sam/dream/chat-8",
    ]
  );
  const [first] = evals;
  assert.deepEqual(first.metadata, {
    itemId: "sam/dream/2026-09-03-lost-mia",
    kind: "dream-source",
    person: "sam",
    repeat: 1,
    setupId: "0123456789",
  });
  assert.ok(first.tags?.includes("dream-accuracy"));
  assert.match(first.description ?? "", samDreamOutputFromPattern);
});

test("an entry eval grades its source and records the hard and counted checks", async () => {
  const { calls, grader } = fakeGrader(() => judged([claim()]));
  const { evals } = buildEvals({ grader, memory: "on" });
  const { recorded, t } = fakeContext();
  await evals[0].test(t);
  assert.equal(calls.length, 1);
  assert.match(calls[0].item, factMiaWasThePattern);
  // The fact sheet is the context, and the journal is not.
  assert.match(calls[0].context ?? "", factSheetForSamPattern);
  assert.equal((calls[0].context ?? "").includes("# Journal"), false);
  assert.equal(byLabel(recorded, "hard:no-severe-unsupported").score, 0);
  assert.equal(byLabel(recorded, "counted:dream-supported").score, 1);
  assert.equal(
    byLabel(recorded, "hard:no-severe-unsupported").metadata?.itemId,
    "sam/dream/2026-09-03-lost-mia"
  );
});

test("with memory off the memory half is not read and a skipped marker stands for it", async () => {
  const { calls, grader } = fakeGrader(() => judged([]));
  const { evals, reads } = buildEvals({ grader, memory: "off" });
  assert.equal(evals.length, 5);
  const marker = evals.at(-1);
  assert.ok(marker);
  assert.equal(marker.metadata?.itemId, "sam/dream/memory");
  assert.match(marker.description ?? "", memoryOffPattern);
  assert.throws(
    () => marker.test(fakeContext().t),
    (error) => {
      assert.ok(error instanceof Skipped);
      assert.equal(error.message, MEMORY_OFF_REASON);
      return true;
    }
  );

  const { recorded, t } = fakeContext();
  await evals[0].test(t);
  assert.deepEqual(reads, [{ memory: false }]);
  assert.equal(recorded.length, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].item.includes("[fact]"), false);
  assert.equal(calls[0].item.includes("[event]"), false);
});

test("with memory on there is no skipped marker, and facts are read", async () => {
  const { grader } = fakeGrader(() => judged([]));
  const { evals, reads } = buildEvals({ grader, memory: "on" });
  assert.equal(evals.length, 4);
  await evals[0].test(fakeContext().t);
  assert.deepEqual(reads, [{ memory: true }]);
});

test("a source Dream wrote nothing from is skipped, not failed", async () => {
  const dbPath = tempDb();
  const db = new DatabaseSync(dbPath);
  db.exec("DELETE FROM entry_summary WHERE entry_id = 102");
  db.exec("DELETE FROM episodic_event WHERE source_id = 102");
  db.close();
  const { grader } = fakeGrader(() => judged([]));
  const evals = dreamAccuracyEvals(
    { pass: passFor("on"), person },
    {
      cache: createGradeCache({ key: undefined, model: "m", rubric: "r" }),
      dbPath: () => dbPath,
      grader,
      loadManifest: () => manifest,
    }
  );
  await assert.rejects(
    async () => {
      await evals[1].test(fakeContext().t);
    },
    (error) => {
      assert.ok(error instanceof Skipped);
      assert.equal(error.message, NOTHING_WRITTEN_REASON);
      return true;
    }
  );
});

test("an empty journal in a memory build with no chats has nothing to grade", () => {
  const { grader } = fakeGrader(() => judged([]));
  const evals = dreamAccuracyEvals(
    {
      pass: passFor("on"),
      person: { ...person, empty: true, entries: [] },
    },
    { grader, listChatIds: () => [] }
  );
  assert.deepEqual(evals, []);
});

test("the eval list does not need a database at import", () => {
  const { grader } = fakeGrader(() => judged([]));
  const evals = dreamAccuracyEvals(
    { pass: passFor("on"), person },
    {
      dbPath: () => {
        throw new Error("SAGE_DATA_DIR is not set.");
      },
      grader,
    }
  );
  assert.equal(evals.length, 2);
  assert.deepEqual(
    asList(evals).map((definition) => definition.metadata?.itemId),
    ["sam/dream/2026-09-03-lost-mia", "sam/dream/2026-09-10-river-run"]
  );
});
