import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EveEvalTurn } from "eve/evals";

import type { LoadedPerson } from "./dataset.ts";
import {
  alsoEmptyOpeners,
  EMPTY_JOURNAL_PERSON,
  itemMatchesTags,
  matchingOpeners,
  needsEmptyJournal,
  openerEvals,
  openerKey,
  openerRuns,
  openerTags,
  splitOpenerKey,
} from "./openers.ts";
import type { PersonPass } from "./pass.ts";
import type { ScoreHost } from "./record.ts";
import { ENV_TRANSCRIPTS, parsePersonCase } from "./schema.ts";
import { type PassSetup, readPassSetup } from "./setup.ts";
import { loadTranscripts } from "./transcripts.ts";
import type { TimedEvent, TurnSender } from "./turn.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function opener(id: string, overrides: Record<string, unknown> = {}) {
  return {
    expect: "venting",
    fits: ["listen"],
    id,
    message: `Message for ${id}.`,
    ...overrides,
  };
}

function personOf(
  id: string,
  openers: Record<string, unknown>[],
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
      id,
      openers,
      tags: options.tags ?? [],
    }),
  };
}

const grief = personOf("grief", [
  opener("better-off", { expect: "crisis", tags: ["screen"] }),
  opener("claire-is-pregnant", { alsoEmpty: true, expect: "good-news" }),
  opener("thanksgiving"),
]);
const work = personOf(
  "work",
  [
    opener("eulogy", { alsoEmpty: true, tags: ["screen", "tricky"] }),
    opener("checklist", { tags: ["screen"] }),
  ],
  { tags: ["office"] }
);
const newUser = personOf(
  "new-user",
  [opener("gate", { tags: ["screen"] }), opener("what-for")],
  { empty: true }
);

function idsOf(runs: ReturnType<typeof openerRuns>): string[] {
  return runs.map((run) => `${run.owner.id}/${run.opener.id}/${run.journal}`);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

test("an item matches when its own tags or its person's tags share one with the sweep, and a sweep with none matches all", () => {
  assert.equal(itemMatchesTags([], [], []), true);
  assert.equal(itemMatchesTags(["office"], ["screen"], ["screen"]), true);
  assert.equal(itemMatchesTags(["example"], [], ["example"]), true);
  assert.equal(itemMatchesTags(["office"], ["tricky"], ["screen"]), false);
  assert.equal(itemMatchesTags([], [], ["screen"]), false);
});

test("a screen sweep runs only the openers tagged screen", () => {
  assert.deepEqual(
    matchingOpeners(grief, ["screen"]).map((item) => item.id),
    ["better-off"]
  );
  assert.deepEqual(
    matchingOpeners(grief, []).map((item) => item.id),
    ["better-off", "claire-is-pregnant", "thanksgiving"]
  );
  // A person's own tag brings in every one of their openers.
  assert.deepEqual(
    matchingOpeners(work, ["office"]).map((item) => item.id),
    ["eulogy", "checklist"]
  );
});

test("alsoEmpty openers are picked by the same tags", () => {
  assert.deepEqual(
    alsoEmptyOpeners(work, ["screen"]).map((item) => item.id),
    ["eulogy"]
  );
  assert.deepEqual(alsoEmptyOpeners(grief, ["screen"]), []);
  assert.deepEqual(
    alsoEmptyOpeners(grief, []).map((item) => item.id),
    ["claire-is-pregnant"]
  );
});

// ---------------------------------------------------------------------------
// Which openers a pass sends
// ---------------------------------------------------------------------------

test("a person with entries sends only their own openers, on their own journal", () => {
  assert.deepEqual(idsOf(openerRuns(grief, [work, newUser], [])), [
    "grief/better-off/own",
    "grief/claire-is-pregnant/own",
    "grief/thanksgiving/own",
  ]);
});

test("the empty-journal person also sends everyone else's alsoEmpty openers on the empty journal", () => {
  assert.deepEqual(idsOf(openerRuns(newUser, [grief, work, newUser], [])), [
    "new-user/gate/own",
    "new-user/what-for/own",
    "grief/claire-is-pregnant/empty",
    "work/eulogy/empty",
  ]);
  assert.deepEqual(
    idsOf(openerRuns(newUser, [grief, work, newUser], ["screen"])),
    ["new-user/gate/own", "work/eulogy/empty"]
  );
});

test("a host with entries never runs another person's openers", () => {
  const impostor = personOf("new-user", [opener("x")]);
  assert.deepEqual(idsOf(openerRuns(impostor, [grief], [])), [
    "new-user/x/own",
  ]);
  // And a person with another id and an empty journal does not host them either.
  const other = personOf("blank", [opener("y")], { empty: true });
  assert.deepEqual(idsOf(openerRuns(other, [grief], [])), ["blank/y/own"]);
});

test("the sweep needs the empty journal only when someone has a matching alsoEmpty opener", () => {
  assert.equal(needsEmptyJournal([grief, work], []), true);
  assert.equal(needsEmptyJournal([grief, work], ["screen"]), true);
  assert.equal(needsEmptyJournal([grief], ["screen"]), false);
  assert.equal(needsEmptyJournal([newUser], []), false);
  assert.equal(EMPTY_JOURNAL_PERSON, "new-user");
});

test("an empty-journal run has its own item key, apart from the person's own run", () => {
  assert.equal(openerKey("eulogy", "own"), "eulogy");
  assert.equal(openerKey("eulogy", "empty"), "eulogy.empty");
  assert.deepEqual(splitOpenerKey("eulogy"), {
    journal: "own",
    openerId: "eulogy",
  });
  assert.deepEqual(splitOpenerKey("eulogy.empty"), {
    journal: "empty",
    openerId: "eulogy",
  });
});

test("an opener's evals carry its person's tags, its own, and the pass names", () => {
  const [run] = openerRuns(work, [], []);
  assert.ok(run);
  assert.deepEqual(openerTags(run), [
    "office",
    "screen",
    "tricky",
    "chat",
    "openers",
  ]);
});

// ---------------------------------------------------------------------------
// The evals
// ---------------------------------------------------------------------------

function passFor(tags: string[], repeats = 1): PassSetup {
  const bare = readPassSetup({});
  return {
    ...bare,
    repeats,
    setup: { ...bare.setup, chatModel: "qwen3:8b" },
    setupId: "0123456789",
    sweep: { ...bare.sweep, tags },
  };
}

function contextOf(person: LoadedPerson, pass: PassSetup): PersonPass {
  return { pass, person };
}

test("one eval for each opener and repeat, with the item id, kind, and tags", async () => {
  const evals = await openerEvals(contextOf(grief, passFor([], 2)));
  assert.equal(evals.length, 6);
  assert.deepEqual(evals[0]?.metadata, {
    itemId: "grief/opener/better-off",
    kind: "opener",
    person: "grief",
    repeat: 1,
    setupId: "0123456789",
  });
  assert.equal(evals[1]?.metadata?.repeat, 2);
  assert.equal(evals[0]?.description, "grief: opener better-off (repeat 1)");
  assert.equal(evals[1]?.description, "grief: opener better-off (repeat 2)");
  const once = await openerEvals(contextOf(grief, passFor([])));
  assert.equal(once[0]?.description, "grief: opener better-off");
  assert.deepEqual(evals[0]?.tags, ["screen", "chat", "openers"]);
});

test("the sweep's tags pick the evals", async () => {
  const screen = await openerEvals(contextOf(grief, passFor(["screen"])));
  assert.deepEqual(
    screen.map((definition) => definition.metadata?.itemId),
    ["grief/opener/better-off"]
  );
  const none = await openerEvals(contextOf(grief, passFor(["no-such-tag"])));
  assert.deepEqual(none, []);
});

test("the empty-journal person runs the others' alsoEmpty openers, as journal empty", async () => {
  let loads = 0;
  const evals = await openerEvals(contextOf(newUser, passFor(["screen"])), {
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
      ["new-user/opener/gate", "new-user"],
      ["work/opener/eulogy.empty", "work"],
    ]
  );
  assert.equal(evals[1]?.description, "work: opener eulogy (empty journal)");
  assert.deepEqual(evals[1]?.tags, [
    "office",
    "screen",
    "tricky",
    "chat",
    "openers",
  ]);
});

test("the empty-journal person sends none of an excluded person's alsoEmpty openers", async () => {
  const long = personOf("long-history", [opener("o", { alsoEmpty: true })], {
    tags: ["long"],
  });
  const pass = passFor([]);
  const everyone = await openerEvals(contextOf(newUser, pass), {
    loadPeople: () => Promise.resolve([grief, long, newUser]),
  });
  assert.ok(
    everyone.some(
      (definition) => definition.metadata?.person === "long-history"
    )
  );
  const left = await openerEvals(
    contextOf(newUser, {
      ...pass,
      sweep: { ...pass.sweep, excludeTags: ["long"] },
    }),
    { loadPeople: () => Promise.resolve([grief, long, newUser]) }
  );
  assert.ok(
    left.every((definition) => definition.metadata?.person !== "long-history")
  );
  assert.ok(left.some((definition) => definition.metadata?.person === "grief"));
});

test("a person with entries does not load the other people", async () => {
  await openerEvals(contextOf(grief, passFor([])), {
    loadPeople: () => {
      throw new Error("should not load");
    },
  });
});

function turnOf(message: string): EveEvalTurn {
  const events: TimedEvent[] = [
    {
      data: { parts: [{ kind: "text", text: "Hi" }] },
      meta: { at: "2026-11-09T10:00:00.000Z" },
      type: "delivery.consumed",
    },
    {
      data: { modelId: "qwen3:8b" },
      meta: { at: "2026-11-09T10:00:00.010Z" },
      type: "model.started",
    },
    {
      data: { kind: "text", value: message },
      meta: { at: "2026-11-09T10:00:00.400Z" },
      type: "content.completed",
    },
    {
      data: {},
      meta: { at: "2026-11-09T10:00:00.900Z" },
      type: "turn.settled",
    },
  ];
  return {
    events,
    interactions: [],
    reply: message,
    status: "completed",
    toolCalls: [],
  } as unknown as EveEvalTurn;
}

function harness(reply: string) {
  const scores: {
    label?: string;
    metadata?: Record<string, unknown>;
    score: number;
  }[] = [];
  const sent: { headers?: Record<string, string>; text: unknown }[] = [];
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
      return Promise.resolve(turnOf(reply));
    },
  } as unknown as ScoreHost & TurnSender;
  return { scores, sent, t };
}

test("an opener is sent with the setup's headers, scored for turn-works, and written as an opener transcript", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sage-openers-"));
  const file = join(dir, "transcripts.jsonl");
  const before = process.env[ENV_TRANSCRIPTS];
  process.env[ENV_TRANSCRIPTS] = file;
  t.after(() => {
    if (before === undefined) {
      delete process.env[ENV_TRANSCRIPTS];
    } else {
      process.env[ENV_TRANSCRIPTS] = before;
    }
  });
  const evals = await openerEvals(contextOf(newUser, passFor(["screen"])), {
    loadPeople: () => Promise.resolve([grief, work, newUser]),
  });
  const { scores, sent, t: fake } = harness("That sounds like a long meeting.");
  for (const definition of evals) {
    // The order the openers were sent in is what the test reads back.
    // biome-ignore lint/performance/noAwaitInLoops: one opener at a time, as the chat pass runs them.
    await definition.test(fake as never);
  }
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.text, "Message for gate.");
  assert.equal(sent[1]?.text, "Message for eulogy.");
  for (const call of sent) {
    assert.deepEqual(call.headers, {
      "x-sage-context-length": "32768",
      "x-sage-model": "qwen3:8b",
      "x-sage-think": "0",
    });
  }
  const turnWorks = scores.filter(
    (entry) => entry.label === "counted:turn-works"
  );
  assert.equal(turnWorks.length, 2);
  assert.ok(turnWorks.every((entry) => entry.score === 1));
  assert.equal(
    scores.some((entry) => entry.label?.startsWith("soft:")),
    false,
    "an opener records no search check yet"
  );

  const rows = loadTranscripts(file);
  assert.deepEqual(
    rows.map((row) => [row.itemId, row.kind, row.journal, row.person]),
    [
      ["new-user/opener/gate", "opener", "own", "new-user"],
      ["work/opener/eulogy.empty", "opener", "empty", "work"],
    ]
  );
  const [first] = rows;
  assert.equal(first?.setupId, "0123456789");
  assert.equal(first?.turns[0]?.role, "user");
  assert.equal(first?.turns[0]?.text, "Message for gate.");
  assert.equal(first?.turns[1]?.text, "That sounds like a long meeting.");
  assert.deepEqual(first?.turns[1]?.timing, {
    firstVisibleMs: 400,
    toolMs: 0,
    totalMs: 900,
  });
  assert.equal(first?.ended, "done");
});
