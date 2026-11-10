import assert from "node:assert/strict";
import test from "node:test";

import type { EveEvalToolCall, EveEvalTurn } from "eve/evals";

import { type ChatQuestion, runChatQuestion } from "./chat-turn.ts";
import { makeItem, type ScoreHost } from "./record.ts";
import {
  expandSetups,
  parseSweepFile,
  parseTranscriptRow,
  type Setup,
} from "./schema.ts";
import type { TimedEvent, TurnSender } from "./turn.ts";

const thinkPattern = /<think>/u;
const gemma312bPattern = /gemma3:12b/u;
const didNotFinishStreamPattern = /did not finish.*Stream closed/u;
const notSupportedPattern = /not supported/u;

const BASE = Date.parse("2026-11-09T10:00:00.000Z");

function event(
  type: string,
  offsetMs: number,
  data: Record<string, unknown> = {}
): TimedEvent {
  return { data, meta: { at: new Date(BASE + offsetMs).toISOString() }, type };
}

function setupOf(overrides: Record<string, unknown> = {}): Setup {
  const [setup] = expandSetups(
    parseSweepFile({
      chatModels: ["qwen3:8b"],
      memory: ["on"],
      ...overrides,
    })
  );
  return setup;
}

function toolCall(
  name: string,
  input: Record<string, unknown> = {},
  status: EveEvalToolCall["status"] = "completed"
): EveEvalToolCall {
  return {
    input: input as EveEvalToolCall["input"],
    name,
    output: { ok: true },
    status,
    turnIndex: 0,
  };
}

interface FakeTurn {
  message?: string;
  status?: "completed" | "failed" | "waiting";
  stepModels?: string[];
  toolCalls?: EveEvalToolCall[];
}

function turnOf(fake: FakeTurn): EveEvalTurn {
  const events: TimedEvent[] = [
    event("message.received", 0),
    ...(fake.stepModels ?? ["qwen3:8b"]).map((modelId) =>
      event("step.started", 10, { modelId })
    ),
    event("message.appended", 400, { messageDelta: fake.message ?? "" }),
    event("turn.completed", 900),
  ];
  return {
    events,
    inputRequests: [],
    message: fake.message,
    status: fake.status ?? "waiting",
    toolCalls: fake.toolCalls ?? [],
  } as unknown as EveEvalTurn;
}

interface Harness {
  scores: {
    label?: string;
    metadata?: Record<string, unknown>;
    score: number;
  }[];
  sent: { headers?: Record<string, string>; text: unknown }[];
  t: ScoreHost & TurnSender;
}

function harness(respond: () => Promise<EveEvalTurn>): Harness {
  const scores: Harness["scores"] = [];
  const sent: Harness["sent"] = [];
  const t = {
    score(evaluation: { metadata?: Record<string, unknown>; score: number }) {
      const entry: Harness["scores"][number] = {
        metadata: evaluation.metadata,
        score: evaluation.score,
      };
      scores.push(entry);
      const handle = {
        gate: () => handle,
        label(label: string) {
          entry.label = label;
          return handle;
        },
        soft: () => handle,
      };
      return handle;
    },
    send(text: unknown, options?: { headers?: Record<string, string> }) {
      sent.push({ headers: options?.headers, text });
      return respond();
    },
  } as unknown as ScoreHost & TurnSender;
  return { scores, sent, t };
}

const item = makeItem(
  { itemId: "engaged/chat/1", kind: "chat", person: "engaged" },
  "0123456789"
);
const plain: ChatQuestion = {
  expectTool: false,
  expectWhen: false,
  question: "How is Jordan?",
};

function labels(h: Harness): string[] {
  return h.scores.map((entry) => entry.label ?? "");
}

test("a good turn passes turn-works and writes a valid transcript row", async () => {
  const h = harness(() =>
    Promise.resolve(
      turnOf({
        message: "Jordan is doing well.",
        toolCalls: [toolCall("search_journal", { query: "Jordan" })],
      })
    )
  );
  const row = await runChatQuestion(h.t, item, plain, setupOf());
  assert.deepEqual(labels(h), ["counted:turn-works"]);
  assert.equal(h.scores[0].score, 1);
  assert.deepEqual(h.sent[0].headers, {
    "x-sage-context-length": "32768",
    "x-sage-model": "qwen3:8b",
    "x-sage-think": "0",
  });
  assert.equal(h.sent[0].text, "How is Jordan?");

  assert.deepEqual(parseTranscriptRow(row), row);
  assert.equal(row.ended, "done");
  assert.equal(row.itemId, "engaged/chat/1");
  assert.equal(row.kind, "chat");
  assert.equal(row.journal, "own");
  assert.equal(row.setupId, "0123456789");
  assert.equal(row.turns[0].role, "user");
  assert.equal(row.turns[0].text, "How is Jordan?");
  assert.equal(row.turns[1].text, "Jordan is doing well.");
  assert.deepEqual(row.turns[1].stepModelIds, ["qwen3:8b"]);
  assert.deepEqual(row.turns[1].timing, {
    firstVisibleMs: 400,
    toolMs: 0,
    totalMs: 900,
  });
  assert.equal(row.turns[1].toolCalls[0].name, "search_journal");
});

test("a leaked think tag fails turn-works but the row still says done", async () => {
  const h = harness(() =>
    Promise.resolve(turnOf({ message: "<think>hmm</think> Hello." }))
  );
  const row = await runChatQuestion(h.t, item, plain, setupOf());
  assert.equal(h.scores[0].score, 0);
  assert.match(String(h.scores[0].metadata?.reason), thinkPattern);
  assert.equal(row.ended, "done");
});

test("a step on another model fails turn-works", async () => {
  const h = harness(() =>
    Promise.resolve(turnOf({ message: "Hi.", stepModels: ["gemma3:12b"] }))
  );
  await runChatQuestion(h.t, item, plain, setupOf());
  assert.equal(h.scores[0].score, 0);
  assert.match(String(h.scores[0].metadata?.reason), gemma312bPattern);
});

test("a turn that failed is an error row and a failed turn-works", async () => {
  const h = harness(() =>
    Promise.resolve(turnOf({ message: "", status: "failed" }))
  );
  const row = await runChatQuestion(h.t, item, plain, setupOf());
  assert.equal(h.scores[0].score, 0);
  assert.equal(row.ended, "error");
});

test("a send that throws is a counted failure and an error row, not a crash", async () => {
  const h = harness(() =>
    Promise.reject(new Error("Stream closed before a turn boundary."))
  );
  const row = await runChatQuestion(
    h.t,
    item,
    { ...plain, expectTool: true },
    setupOf()
  );
  assert.deepEqual(labels(h), ["counted:turn-works"]);
  assert.equal(h.scores[0].score, 0);
  assert.match(String(h.scores[0].metadata?.reason), didNotFinishStreamPattern);
  assert.equal(row.ended, "error");
  assert.equal(row.turns[1].text, "");
  assert.equal(row.turns[1].error, "Stream closed before a turn boundary.");
  assert.equal(parseTranscriptRow(row).kind, "chat");
});

test("a thinking level Chat cannot run stops the pass instead of counting as a failed turn", async () => {
  const h = harness(() => Promise.resolve(turnOf({ message: "Hi." })));
  await assert.rejects(
    runChatQuestion(h.t, item, plain, setupOf({ thinking: ["high"] })),
    notSupportedPattern
  );
  assert.equal(h.sent.length, 0);
  assert.equal(h.scores.length, 0);
});

test("expectTool is met by a completed journal search", async () => {
  const h = harness(() =>
    Promise.resolve(
      turnOf({ message: "Yes.", toolCalls: [toolCall("search_journal")] })
    )
  );
  await runChatQuestion(h.t, item, { ...plain, expectTool: true }, setupOf());
  assert.deepEqual(labels(h), [
    "counted:turn-works",
    "soft:searched-journal-or-memories",
  ]);
  assert.equal(h.scores[1].score, 1);
});

test("expectTool is not met by a search that never completed", async () => {
  const h = harness(() =>
    Promise.resolve(
      turnOf({
        message: "Yes.",
        toolCalls: [toolCall("search_journal", {}, "failed")],
      })
    )
  );
  await runChatQuestion(h.t, item, { ...plain, expectTool: true }, setupOf());
  assert.equal(h.scores[1].score, 0);
});

test("a memory search counts when memory is on", async () => {
  const calls = [toolCall("facts__search_memories")];
  const on = harness(() =>
    Promise.resolve(turnOf({ message: "Yes.", toolCalls: calls }))
  );
  await runChatQuestion(on.t, item, { ...plain, expectTool: true }, setupOf());
  assert.equal(on.scores[1].score, 1);
});

test("a memory search does not count when memory is off", async () => {
  const off = harness(() =>
    Promise.resolve(
      turnOf({
        message: "Yes.",
        toolCalls: [toolCall("facts__search_memories")],
      })
    )
  );
  await runChatQuestion(
    off.t,
    item,
    { ...plain, expectTool: true },
    setupOf({ memory: ["off"] })
  );
  assert.equal(off.scores[1].score, 0);
});

test("expectWhen needs a journal search that passed a non-blank when", async () => {
  const withWhen = harness(() =>
    Promise.resolve(
      turnOf({
        message: "In June.",
        toolCalls: [
          toolCall("search_journal", { query: "x", when: "in June" }),
        ],
      })
    )
  );
  await runChatQuestion(
    withWhen.t,
    item,
    { ...plain, expectWhen: true },
    setupOf()
  );
  assert.deepEqual(labels(withWhen), [
    "counted:turn-works",
    "soft:passed-when-to-search-journal",
  ]);
  assert.equal(withWhen.scores[1].score, 1);

  const blank = harness(() =>
    Promise.resolve(
      turnOf({
        message: "In June.",
        toolCalls: [toolCall("search_journal", { query: "x", when: "  " })],
      })
    )
  );
  await runChatQuestion(
    blank.t,
    item,
    { ...plain, expectWhen: true },
    setupOf()
  );
  assert.equal(blank.scores[1].score, 0);
});

test("the repeat number goes into the metadata and the row", async () => {
  const repeated = makeItem(
    { itemId: "engaged/chat/1", kind: "chat", person: "engaged" },
    "0123456789",
    3
  );
  const h = harness(() => Promise.resolve(turnOf({ message: "Hi." })));
  const row = await runChatQuestion(h.t, repeated, plain, setupOf());
  assert.equal(row.repeat, 3);
  assert.equal(h.scores[0].metadata?.repeat, 3);
});
