import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EveEvalTurn } from "eve/evals";

import { conversationTimeoutMs } from "./conversation-run.ts";
import {
  alsoEmptyConversations,
  conversationEvals,
  conversationKey,
  conversationRuns,
  conversationTags,
  matchingConversations,
  needsEmptyJournalForConversations,
  splitConversationKey,
} from "./conversations.ts";
import type { LoadedPerson } from "./dataset.ts";
import {
  EMPTY_JOURNAL_PERSON,
  personExcluded,
  withoutExcluded,
} from "./openers.ts";
import type { PersonPass } from "./pass.ts";
import { ENV_TRANSCRIPTS, parsePersonCase } from "./schema.ts";
import { type PassSetup, readPassSetup } from "./setup.ts";
import type { SimulatedUser } from "./simulated-user.ts";
import { loadTranscripts } from "./transcripts.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function conversation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    expect: "venting",
    id,
    maxTurns: 4,
    opening: `Opening for ${id}.`,
    persona: {
      openness: "open",
      situation: "A hard week.",
      style: "terse",
      wants: "vent",
    },
    ...overrides,
  };
}

function personOf(
  id: string,
  conversations: Record<string, unknown>[],
  options: { empty?: boolean; tags?: string[] } = {}
): LoadedPerson {
  const empty = options.empty ?? false;
  return {
    chats: [],
    dir: `/data/people/${id}`,
    empty,
    entries: empty
      ? []
      : [
          {
            body: "A day.",
            date: "2026-09-03",
            fileName: "2026-09-03-a-day.md",
            index: 1,
            stem: "2026-09-03-a-day",
            title: "A day",
            wordCount: 2,
          },
        ],
    id,
    personCase: parsePersonCase({
      about: `${id} is made up.`,
      conversations,
      id,
      tags: options.tags ?? [],
    }),
  };
}

const grief = personOf("grief", [
  conversation("hard-night", { alsoEmpty: true, tags: ["deep"] }),
  conversation("anniversary"),
]);
const work = personOf(
  "work",
  [
    conversation("burnout", { tags: ["deep"] }),
    conversation("long-one", { alsoEmpty: true, maxTurns: 30, tags: ["deep"] }),
  ],
  { tags: ["office"] }
);
const longHistory = personOf(
  "long-history",
  [conversation("why-i-go-quiet", { alsoEmpty: true, maxTurns: 30 })],
  { tags: ["long"] }
);
const newUser = personOf(
  "new-user",
  [conversation("what-is-this", { tags: ["deep"] })],
  { empty: true }
);

function idsOf(runs: ReturnType<typeof conversationRuns>): string[] {
  return runs.map(
    (run) => `${run.owner.id}/${run.conversation.id}/${run.journal}`
  );
}

// ---------------------------------------------------------------------------
// Which conversations a pass runs
// ---------------------------------------------------------------------------

test("the sweep's tags pick the conversations, by their own tags or their person's", () => {
  assert.deepEqual(
    matchingConversations(grief, ["deep"]).map((item) => item.id),
    ["hard-night"]
  );
  assert.deepEqual(
    matchingConversations(grief, []).map((item) => item.id),
    ["hard-night", "anniversary"]
  );
  assert.deepEqual(
    matchingConversations(work, ["office"]).map((item) => item.id),
    ["burnout", "long-one"]
  );
  assert.deepEqual(matchingConversations(grief, ["screen"]), []);
});

test("alsoEmpty conversations are picked by the same tags", () => {
  assert.deepEqual(
    alsoEmptyConversations(grief, []).map((item) => item.id),
    ["hard-night"]
  );
  assert.deepEqual(alsoEmptyConversations(grief, ["screen"]), []);
  assert.deepEqual(
    alsoEmptyConversations(work, ["deep"]).map((item) => item.id),
    ["long-one"]
  );
});

test("a person with entries runs only their own conversations, on their own journal", () => {
  assert.deepEqual(idsOf(conversationRuns(grief, [work, newUser], [])), [
    "grief/hard-night/own",
    "grief/anniversary/own",
  ]);
});

test("the empty-journal person also runs everyone else's alsoEmpty conversations on the empty journal", () => {
  assert.deepEqual(
    idsOf(conversationRuns(newUser, [grief, work, newUser], [])),
    [
      "new-user/what-is-this/own",
      "grief/hard-night/empty",
      "work/long-one/empty",
    ]
  );
  assert.deepEqual(
    idsOf(conversationRuns(newUser, [grief, work, newUser], ["deep"])),
    [
      "new-user/what-is-this/own",
      "grief/hard-night/empty",
      "work/long-one/empty",
    ]
  );
});

test("a host with entries never runs another person's conversations", () => {
  const impostor = personOf("new-user", [conversation("x")]);
  assert.deepEqual(idsOf(conversationRuns(impostor, [grief], [])), [
    "new-user/x/own",
  ]);
});

test("the sweep needs the empty journal only when someone has a matching alsoEmpty conversation", () => {
  assert.equal(needsEmptyJournalForConversations([grief, work], []), true);
  assert.equal(needsEmptyJournalForConversations([grief], ["screen"]), false);
  assert.equal(needsEmptyJournalForConversations([newUser], []), false);
  assert.equal(EMPTY_JOURNAL_PERSON, "new-user");
});

test("an empty-journal run has its own item key, apart from the person's own run", () => {
  assert.equal(conversationKey("hard-night", "own"), "hard-night");
  assert.equal(conversationKey("hard-night", "empty"), "hard-night.empty");
  assert.deepEqual(splitConversationKey("hard-night"), {
    conversationId: "hard-night",
    journal: "own",
  });
  assert.deepEqual(splitConversationKey("hard-night.empty"), {
    conversationId: "hard-night",
    journal: "empty",
  });
});

test("a conversation's evals carry its person's tags, its own, and the pass names", () => {
  const [run] = conversationRuns(work, [], []);
  assert.ok(run);
  assert.deepEqual(conversationTags(run), [
    "office",
    "deep",
    "chat",
    "conversations",
  ]);
});

// ---------------------------------------------------------------------------
// People a sweep leaves out
// ---------------------------------------------------------------------------

test("a person is excluded when their tags hold one of the sweep's excluded tags", () => {
  assert.equal(personExcluded(longHistory, ["long"]), true);
  assert.equal(personExcluded(longHistory, ["office"]), false);
  assert.equal(personExcluded(longHistory, []), false);
  assert.equal(personExcluded(grief, ["long"]), false);
  assert.deepEqual(
    withoutExcluded([grief, longHistory, work], ["long"]).map(
      (person) => person.id
    ),
    ["grief", "work"]
  );
  assert.equal(withoutExcluded([grief], []).length, 1);
});

// ---------------------------------------------------------------------------
// The evals
// ---------------------------------------------------------------------------

function passFor(
  tags: string[],
  repeats = 1,
  excludeTags: string[] = []
): PassSetup {
  const bare = readPassSetup({});
  return {
    ...bare,
    repeats,
    setup: { ...bare.setup, chatModel: "qwen3:8b" },
    setupId: "0123456789",
    sweep: { ...bare.sweep, excludeTags, tags },
  };
}

function contextOf(person: LoadedPerson, pass: PassSetup): PersonPass {
  return { pass, person };
}

test("one eval for each conversation and repeat, with the item id, kind, tags, and time limit", async () => {
  const evals = await conversationEvals(contextOf(work, passFor([], 2)));
  assert.equal(evals.length, 4);
  assert.deepEqual(evals[0]?.metadata, {
    itemId: "work/conversation/burnout",
    kind: "conversation",
    person: "work",
    repeat: 1,
    setupId: "0123456789",
  });
  assert.equal(evals[1]?.metadata?.repeat, 2);
  assert.equal(evals[0]?.description, "work: conversation burnout (repeat 1)");
  const once = await conversationEvals(contextOf(work, passFor([])));
  assert.equal(once[0]?.description, "work: conversation burnout");
  assert.deepEqual(evals[0]?.tags, ["office", "deep", "chat", "conversations"]);
  // A conversation that can run past 12 person messages gets 2 hours, the rest 30 minutes.
  assert.equal(once[0]?.timeoutMs, 30 * 60 * 1000);
  assert.equal(once[1]?.timeoutMs, 2 * 60 * 60 * 1000);
  assert.equal(once[1]?.timeoutMs, conversationTimeoutMs(30));
});

test("the sweep's tags pick the evals", async () => {
  const deep = await conversationEvals(contextOf(grief, passFor(["deep"])));
  assert.deepEqual(
    deep.map((definition) => definition.metadata?.itemId),
    ["grief/conversation/hard-night"]
  );
  assert.deepEqual(
    await conversationEvals(contextOf(grief, passFor(["no-such-tag"]))),
    []
  );
});

test("the empty-journal person runs the others' alsoEmpty conversations, as journal empty", async () => {
  let loads = 0;
  const evals = await conversationEvals(contextOf(newUser, passFor([])), {
    loadPeople: () => {
      loads += 1;
      return Promise.resolve([grief, work, newUser]);
    },
  });
  assert.equal(loads, 1);
  assert.deepEqual(
    evals.map((definition) => [
      definition.metadata?.itemId,
      definition.metadata?.person,
    ]),
    [
      ["new-user/conversation/what-is-this", "new-user"],
      ["grief/conversation/hard-night.empty", "grief"],
      ["work/conversation/long-one.empty", "work"],
    ]
  );
  assert.equal(
    evals[1]?.description,
    "grief: conversation hard-night (empty journal)"
  );
});

test("a person the sweep excludes sends nothing, and the empty-journal person sends none of theirs", async () => {
  const withEverybody = [grief, longHistory, newUser];
  const everyone = await conversationEvals(contextOf(newUser, passFor([])), {
    loadPeople: () => Promise.resolve(withEverybody),
  });
  assert.ok(
    everyone.some(
      (definition) => definition.metadata?.person === "long-history"
    )
  );
  const left = await conversationEvals(
    contextOf(newUser, passFor([], 1, ["long"])),
    { loadPeople: () => Promise.resolve(withEverybody) }
  );
  assert.deepEqual(
    left.map((definition) => definition.metadata?.person),
    ["new-user", "grief"]
  );
});

test("a person with entries does not load the other people", async () => {
  await conversationEvals(contextOf(grief, passFor([])), {
    loadPeople: () => {
      throw new Error("should not load");
    },
  });
});

function harness(reply: string) {
  const scores: {
    label?: string;
    metadata?: Record<string, unknown>;
    score: number;
  }[] = [];
  const sent: { headers?: Record<string, string>; text: unknown }[] = [];
  const session = {
    send(text: unknown, options?: { headers?: Record<string, string> }) {
      sent.push({ headers: options?.headers, text });
      return Promise.resolve(turn);
    },
  };
  const turn = {
    events: [],
    inputRequests: [],
    message: reply,
    session,
    status: "completed",
    toolCalls: [],
  } as unknown as EveEvalTurn;
  const t = {
    score(evaluation: { metadata?: Record<string, unknown>; score: number }) {
      const entry: (typeof scores)[number] = {
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
      return Promise.resolve(turn);
    },
  };
  return { scores, sent, t: t as never };
}

const quietSimulator: SimulatedUser = {
  next: () =>
    Promise.resolve({
      costUsd: 0,
      ok: true,
      value: { done: false, message: "More." },
    }),
  rate: () =>
    Promise.resolve({
      costUsd: 0,
      ok: true,
      value: { rating: 4, reason: "Fine." },
    }),
};

test("an eval plays the conversation, sends the headers every turn, and writes one transcript row", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "sage-conv-")), "t.jsonl");
  const previous = process.env[ENV_TRANSCRIPTS];
  process.env[ENV_TRANSCRIPTS] = file;
  try {
    const [definition] = await conversationEvals(
      contextOf(grief, passFor(["deep"])),
      { simulator: quietSimulator }
    );
    assert.ok(definition?.test);
    const { scores, sent, t } = harness("That sounds hard. What happened?");
    await definition.test(t);
    // maxTurns is 4: the opening, then three from the simulated user.
    assert.equal(sent.length, 4);
    assert.equal(sent[0]?.text, "Opening for hard-night.");
    for (const entry of sent) {
      assert.equal(entry.headers?.["x-sage-model"], "qwen3:8b");
      assert.equal(entry.headers?.["x-sage-think"], "0");
    }
    assert.deepEqual(
      scores.map((entry) => entry.label),
      Array.from({ length: 4 }, () => "counted:turn-works")
    );
    const [row, ...rest] = loadTranscripts(file);
    assert.equal(rest.length, 0);
    assert.equal(row?.kind, "conversation");
    assert.equal(row?.itemId, "grief/conversation/hard-night");
    assert.equal(row?.ended, "max-turns");
    assert.equal(row?.turns.length, 8);
    assert.deepEqual(row?.userRating, { level: 4, reason: "Fine." });
    assert.ok(readFileSync(file, "utf8").endsWith("\n"));
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, ENV_TRANSCRIPTS);
    } else {
      process.env[ENV_TRANSCRIPTS] = previous;
    }
  }
});
