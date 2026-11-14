import assert from "node:assert/strict";
import test from "node:test";

import type { LoadedPerson, Manifest } from "./dataset.ts";
import type { ToolCall } from "./schema.ts";
import {
  describeCall,
  idsInResult,
  readTarget,
  resolveSearchNeeds,
  type SearchCheckInput,
  type SearchCheckResult,
  type SearchNeed,
  searchChecks,
  searchKey,
  toolUseOf,
} from "./search-checks.ts";
import {
  countSearchCalls,
  countsTowardTurn,
  isMemoryTool,
  isSearchCall,
} from "./tool-names.ts";

const pattern14 = /1 search on a turn that needed none/u;
const pattern13 = /search_journal "what is a thinking trap"/u;
const pattern12 = /2026-09-03-rent \(entry-41\) is in no search result/u;
const pattern11 = /found but not read in full/u;
const pattern10 =
  /chat:2026-09-16-rent-talk \(chat-7\) is in no search result/u;
const pattern9 = /7 tool calls in one turn, over the limit of 6/u;
const pattern8 = /the same search sent 2 times: search_journal "My Dad"/u;
const pattern7 = /7 tool calls/u;
const pattern6 = /the same search sent 2 times/u;
const pattern5 = /0 tool calls/u;
const pattern4 = /no entry with the stem "nope"/u;
const pattern3 = /no past chat with the stem "nope"/u;
const pattern2 = /no chat id for past chat 1/u;
const pattern1 = /no manifest/u;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function call(
  name: string,
  input: Record<string, unknown>,
  output: unknown = {},
  status: ToolCall["status"] = "completed"
): ToolCall {
  return {
    input: input as ToolCall["input"],
    name,
    output: output as ToolCall["output"],
    status,
  };
}

const RENT_ENTRY_TEXT =
  "Rent went up fifteen percent this month and I have no idea how to cover it.";
const RENT: SearchNeed = {
  id: "entry-41",
  ref: "2026-09-03-rent",
  text: RENT_ENTRY_TEXT,
};
const TALK: SearchNeed = {
  id: "chat-7",
  ref: "chat:2026-09-16-rent-talk",
  text: "Rent went up and I froze.\nThat sounds heavy.",
};

function inputOf(overrides: Partial<SearchCheckInput> = {}): SearchCheckInput {
  return {
    journalEmpty: false,
    maxToolCallsPerTurn: 6,
    memory: false,
    needs: [],
    search: undefined,
    toolCalls: [],
    ...overrides,
  };
}

function byId(results: SearchCheckResult[], id: string): SearchCheckResult {
  const found = results.find((result) => result.checkId === id);
  assert.ok(found, `no ${id} in ${results.map((r) => r.checkId).join(", ")}`);
  return found;
}

function ids(results: SearchCheckResult[]): string[] {
  return results.map((result) => result.checkId);
}

const journalHit = (id: string, snippet: string) =>
  call(
    "search_journal",
    { query: "rent" },
    { entries: [{ date: "2026-09-03", id, snippet, title: "Rent" }] }
  );

// ---------------------------------------------------------------------------
// Which calls are searches
// ---------------------------------------------------------------------------

test("search_journal and search_chats are searches, and the memory tool is one only with memory on", () => {
  for (const name of ["search_journal", "search_chats"]) {
    assert.equal(isSearchCall(name, false), true, name);
    assert.equal(isSearchCall(name, true), true, name);
  }
  assert.equal(isSearchCall("facts__search_memories", true), true);
  assert.equal(isSearchCall("facts__search_memories", false), false);
  assert.equal(isSearchCall("search_memories", true), true);
  for (const name of ["get_journal_entry", "get_chat", "mystery_tool"]) {
    assert.equal(isSearchCall(name, true), false, name);
  }
});

test("a memory-off setup does not count the memory tool at all, not even as a tool call", () => {
  assert.equal(isMemoryTool("facts__search_memories"), true);
  assert.equal(isMemoryTool("episodic__search_memories"), true);
  assert.equal(isMemoryTool("search_journal"), false);
  assert.equal(countsTowardTurn("facts__search_memories", false), false);
  assert.equal(countsTowardTurn("facts__search_memories", true), true);
  assert.equal(countsTowardTurn("search_journal", false), true);
});

test("countSearchCalls counts every kind of search the judge could see", () => {
  assert.equal(
    countSearchCalls([
      call("search_journal", { query: "a" }),
      call("facts__search_memories", { query: "a" }),
      call("get_chat", { id: "chat-1" }),
    ]),
    2
  );
  assert.equal(countSearchCalls([]), 0);
});

// ---------------------------------------------------------------------------
// needless-search and missed-search
// ---------------------------------------------------------------------------

test("needless-search fails when Chat searched on a search: none turn, and passes when it did not", () => {
  const searched = searchChecks(
    inputOf({
      search: "none",
      toolCalls: [call("search_journal", { query: "what is a thinking trap" })],
    })
  );
  const failed = byId(searched, "needless-search");
  assert.equal(failed.pass, false);
  assert.equal(failed.tier, "search");
  assert.match(failed.reason, pattern14);
  assert.match(failed.evidence ?? "", pattern13);

  const quiet = searchChecks(inputOf({ search: "none" }));
  assert.equal(byId(quiet, "needless-search").pass, true);
});

test("needless-search and missed-search apply only to their own label", () => {
  for (const search of ["optional", undefined] as const) {
    const results = searchChecks(
      inputOf({ search, toolCalls: [call("search_journal", { query: "a" })] })
    );
    assert.deepEqual(ids(results), ["no-runaway-search"], String(search));
  }
  assert.deepEqual(ids(searchChecks(inputOf({ search: "none" }))), [
    "needless-search",
    "no-runaway-search",
  ]);
  assert.deepEqual(ids(searchChecks(inputOf({ search: "needed" }))), [
    "missed-search",
    "no-runaway-search",
  ]);
});

test("missed-search fails with no search on a search: needed turn, and a read alone is not a search", () => {
  assert.equal(
    byId(searchChecks(inputOf({ search: "needed" })), "missed-search").pass,
    false
  );
  const readOnly = searchChecks(
    inputOf({
      search: "needed",
      toolCalls: [call("get_journal_entry", { id: "entry-3" })],
    })
  );
  assert.equal(byId(readOnly, "missed-search").pass, false);
  const searched = searchChecks(
    inputOf({
      search: "needed",
      toolCalls: [call("search_chats", { query: "last time" })],
    })
  );
  assert.equal(byId(searched, "missed-search").pass, true);
});

test("a search that failed is still a search", () => {
  const results = searchChecks(
    inputOf({
      search: "needed",
      toolCalls: [call("search_journal", {}, undefined, "failed")],
    })
  );
  assert.equal(byId(results, "missed-search").pass, true);
  const none = searchChecks(
    inputOf({
      search: "none",
      toolCalls: [call("search_journal", {}, undefined, "failed")],
    })
  );
  assert.equal(byId(none, "needless-search").pass, false);
});

test("with memory off the memory tool is not a search, so it cannot cause a needless search or satisfy a missed one", () => {
  const memoryCall = call("facts__search_memories", { query: "rent" });
  assert.equal(
    byId(
      searchChecks(
        inputOf({ memory: false, search: "none", toolCalls: [memoryCall] })
      ),
      "needless-search"
    ).pass,
    true
  );
  assert.equal(
    byId(
      searchChecks(
        inputOf({ memory: false, search: "needed", toolCalls: [memoryCall] })
      ),
      "missed-search"
    ).pass,
    false
  );
  // With memory on it is a search both ways.
  assert.equal(
    byId(
      searchChecks(
        inputOf({ memory: true, search: "none", toolCalls: [memoryCall] })
      ),
      "needless-search"
    ).pass,
    false
  );
  assert.equal(
    byId(
      searchChecks(
        inputOf({ memory: true, search: "needed", toolCalls: [memoryCall] })
      ),
      "missed-search"
    ).pass,
    true
  );
});

// ---------------------------------------------------------------------------
// found-needed
// ---------------------------------------------------------------------------

test("found-needed passes when the entry was found and read in full", () => {
  const results = searchChecks(
    inputOf({
      needs: [RENT],
      toolCalls: [
        journalHit("entry-41", "A summary of the rent entry."),
        call(
          "get_journal_entry",
          { id: "entry-41" },
          { body: RENT_ENTRY_TEXT }
        ),
      ],
    })
  );
  const found = byId(results, "found-needed");
  assert.equal(found.pass, true);
  assert.equal(found.tier, "search");
  assert.deepEqual(found.extra, {
    needs: [
      {
        found: true,
        id: "entry-41",
        read: true,
        readRequired: true,
        ref: "2026-09-03-rent",
      },
    ],
  });
});

test("found-needed fails when the need is in no search result", () => {
  const results = searchChecks(
    inputOf({
      needs: [RENT],
      toolCalls: [journalHit("entry-9", "Something else.")],
    })
  );
  const found = byId(results, "found-needed");
  assert.equal(found.pass, false);
  assert.match(found.reason, pattern12);
});

test("found-needed fails when the entry was found but not read and its snippet was only a cut of it", () => {
  const results = searchChecks(
    inputOf({
      needs: [RENT],
      toolCalls: [
        journalHit("entry-41", "Rent went up fifteen percent this..."),
      ],
    })
  );
  const found = byId(results, "found-needed");
  assert.equal(found.pass, false);
  assert.match(found.reason, pattern11);
});

test("found-needed passes without a read when a snippet holds the whole entry", () => {
  const results = searchChecks(
    inputOf({
      needs: [RENT],
      toolCalls: [journalHit("entry-41", RENT_ENTRY_TEXT)],
    })
  );
  const found = byId(results, "found-needed");
  assert.equal(found.pass, true);
  const outcomes = found.extra?.needs as { readRequired: boolean }[];
  assert.equal(outcomes[0]?.readRequired, false);
  // Spacing differences do not matter, but a trailing ellipsis means a cut.
  const spaced = searchChecks(
    inputOf({
      needs: [RENT],
      toolCalls: [
        journalHit("entry-41", `${RENT_ENTRY_TEXT.replace(" ", "\n ")}`),
      ],
    })
  );
  assert.equal(byId(spaced, "found-needed").pass, true);
});

test("a chat is never shown whole by a search, so a past-chat need must be read with get_chat", () => {
  const search = call(
    "search_chats",
    { query: "rent" },
    {
      chats: [
        {
          hits: [
            { from: "user", message: 0, text: "Rent went up and I froze." },
          ],
          id: "chat-7",
        },
      ],
    }
  );
  const unread = searchChecks(inputOf({ needs: [TALK], toolCalls: [search] }));
  assert.equal(byId(unread, "found-needed").pass, false);
  const read = searchChecks(
    inputOf({
      needs: [TALK],
      toolCalls: [search, call("get_chat", { id: "chat-7" }, { messages: [] })],
    })
  );
  assert.equal(byId(read, "found-needed").pass, true);
});

test("found-needed asks for every need, and names the ones missed", () => {
  const results = searchChecks(
    inputOf({
      needs: [RENT, TALK],
      toolCalls: [
        journalHit("entry-41", "Summary."),
        call("get_journal_entry", { id: 41 }),
      ],
    })
  );
  const found = byId(results, "found-needed");
  assert.equal(found.pass, false);
  assert.match(found.reason, pattern10);
  assert.equal(found.reason.includes("2026-09-03-rent"), false);
});

test("a read counts only when it is completed and reads the right kind of id", () => {
  const search = journalHit("entry-41", "Summary.");
  const failedRead = searchChecks(
    inputOf({
      needs: [RENT],
      toolCalls: [
        search,
        call("get_journal_entry", { id: "entry-41" }, undefined, "failed"),
      ],
    })
  );
  assert.equal(byId(failedRead, "found-needed").pass, false);
  const wrongTool = searchChecks(
    inputOf({
      needs: [RENT],
      toolCalls: [search, call("get_chat", { id: "entry-41" })],
    })
  );
  assert.equal(byId(wrongTool, "found-needed").pass, false);
  const plainNumber = searchChecks(
    inputOf({
      needs: [RENT],
      toolCalls: [search, call("get_journal_entry", { id: "41" })],
    })
  );
  assert.equal(byId(plainNumber, "found-needed").pass, true);
});

test("only a search that completed can find a need", () => {
  const failed = call(
    "search_journal",
    { query: "rent" },
    { entries: [{ id: "entry-41", snippet: RENT_ENTRY_TEXT }] },
    "failed"
  );
  const results = searchChecks(inputOf({ needs: [RENT], toolCalls: [failed] }));
  assert.equal(byId(results, "found-needed").pass, false);
});

test("a memory hit finds the need only with memory on", () => {
  const memory = call("facts__search_memories", { query: "rent" }, [
    { event: "Rent went up.", kind: "event", source: "entry-41" },
  ]);
  const read = call("get_journal_entry", { id: "entry-41" });
  assert.equal(
    byId(
      searchChecks(
        inputOf({ memory: true, needs: [RENT], toolCalls: [memory, read] })
      ),
      "found-needed"
    ).pass,
    true
  );
  assert.equal(
    byId(
      searchChecks(
        inputOf({ memory: false, needs: [RENT], toolCalls: [memory, read] })
      ),
      "found-needed"
    ).pass,
    false
  );
});

test("found-needed does not apply with no needs, on the empty journal, or on a search: none turn", () => {
  assert.equal(
    ids(
      searchChecks(inputOf({ toolCalls: [journalHit("entry-41", "x")] }))
    ).includes("found-needed"),
    false
  );
  assert.equal(
    ids(searchChecks(inputOf({ journalEmpty: true, needs: [RENT] }))).includes(
      "found-needed"
    ),
    false
  );
  assert.equal(
    ids(searchChecks(inputOf({ needs: [RENT], search: "none" }))).includes(
      "found-needed"
    ),
    false
  );
});

// ---------------------------------------------------------------------------
// no-runaway-search
// ---------------------------------------------------------------------------

function queries(count: number, name = "search_journal"): ToolCall[] {
  return Array.from({ length: count }, (_, index) =>
    call(name, { query: `topic ${index}` })
  );
}

test("no-runaway-search passes at the limit and fails one call over it", () => {
  const at = byId(
    searchChecks(inputOf({ toolCalls: queries(6) })),
    "no-runaway-search"
  );
  assert.equal(at.pass, true);
  assert.equal(at.tier, "counted");
  const over = byId(
    searchChecks(inputOf({ toolCalls: queries(7) })),
    "no-runaway-search"
  );
  assert.equal(over.pass, false);
  assert.match(over.reason, pattern9);
  const looser = byId(
    searchChecks(inputOf({ maxToolCallsPerTurn: 8, toolCalls: queries(7) })),
    "no-runaway-search"
  );
  assert.equal(looser.pass, true);
});

test("every tool call counts toward the limit, reads included", () => {
  const calls = [
    ...queries(3),
    call("get_journal_entry", { id: "entry-1" }),
    call("get_journal_entry", { id: "entry-2" }),
    call("get_chat", { id: "chat-3" }),
    call("get_chat", { id: "chat-4" }),
  ];
  assert.equal(
    byId(searchChecks(inputOf({ toolCalls: calls })), "no-runaway-search").pass,
    false
  );
});

test("the same search sent twice fails, however it is spaced or cased, and limit does not make it different", () => {
  const twice = searchChecks(
    inputOf({
      toolCalls: [
        call("search_journal", { query: "My Dad ", when: "last week" }),
        call("search_journal", {
          limit: 10,
          query: "my  dad",
          when: "Last Week",
        }),
      ],
    })
  );
  const result = byId(twice, "no-runaway-search");
  assert.equal(result.pass, false);
  assert.match(result.reason, pattern8);
});

test("searches that differ in the tool, the query, or when are not the same search", () => {
  const results = searchChecks(
    inputOf({
      toolCalls: [
        call("search_journal", { query: "dad" }),
        call("search_chats", { query: "dad" }),
        call("search_journal", { query: "dad", when: "June" }),
        call("search_journal", { query: "mom" }),
      ],
    })
  );
  assert.equal(byId(results, "no-runaway-search").pass, true);
});

test("reading the same entry twice is not a repeated search", () => {
  const results = searchChecks(
    inputOf({
      toolCalls: [
        call("get_journal_entry", { id: "entry-1" }),
        call("get_journal_entry", { id: "entry-1" }),
      ],
    })
  );
  assert.equal(byId(results, "no-runaway-search").pass, true);
});

test("a memory-off setup leaves the memory tool out of the count and out of the repeats", () => {
  const memory = call("facts__search_memories", { query: "dad" });
  const calls = [...queries(5), memory, memory];
  const off = searchChecks(inputOf({ memory: false, toolCalls: calls }));
  assert.equal(byId(off, "no-runaway-search").pass, true);
  const on = searchChecks(inputOf({ memory: true, toolCalls: calls }));
  const failed = byId(on, "no-runaway-search");
  assert.equal(failed.pass, false);
  assert.match(failed.reason, pattern7);
  assert.match(failed.reason, pattern6);
});

test("a turn with no tool calls passes no-runaway-search", () => {
  const result = byId(searchChecks(inputOf()), "no-runaway-search");
  assert.equal(result.pass, true);
  assert.match(result.reason, pattern5);
});

// ---------------------------------------------------------------------------
// Counts, ids, and keys
// ---------------------------------------------------------------------------

test("toolUseOf counts searches, reads, and tool calls for the setup's memory value", () => {
  const calls = [
    call("search_journal", { query: "a" }),
    call("facts__search_memories", { query: "a" }),
    call("get_journal_entry", { id: "entry-1" }),
    call("get_chat", { id: "chat-1" }),
    call("get_chat", {}),
  ];
  assert.deepEqual(toolUseOf(calls, true), {
    reads: 2,
    searches: 2,
    toolCalls: 5,
  });
  assert.deepEqual(toolUseOf(calls, false), {
    reads: 2,
    searches: 1,
    toolCalls: 4,
  });
  assert.deepEqual(toolUseOf([], false), {
    reads: 0,
    searches: 0,
    toolCalls: 0,
  });
});

test("idsInResult finds entry and chat ids anywhere in a result, and nothing else", () => {
  assert.deepEqual(
    [
      ...idsInResult({
        chats: [{ hits: [{ text: "see entry-9 for more" }], id: "chat-7" }],
        entries: [{ id: "entry-41" }, { id: "42" }, { id: "Entry-43" }],
        note: "none",
      }),
    ].sort(),
    ["chat-7", "entry-41", "entry-43"]
  );
  assert.equal(idsInResult(undefined).size, 0);
  assert.equal(idsInResult("entry-0").size, 0);
});

test("readTarget reads an id the way the tools do", () => {
  assert.equal(
    readTarget(call("get_journal_entry", { id: "entry-12" })),
    "entry-12"
  );
  assert.equal(readTarget(call("get_journal_entry", { id: 12 })), "entry-12");
  assert.equal(
    readTarget(call("get_journal_entry", { id: " 12 " })),
    "entry-12"
  );
  assert.equal(readTarget(call("get_chat", { id: "chat-3" })), "chat-3");
  assert.equal(readTarget(call("get_chat", { id: "entry-3" })), null);
  assert.equal(readTarget(call("get_journal_entry", { id: "chat-3" })), null);
  assert.equal(readTarget(call("get_journal_entry", {})), null);
  assert.equal(readTarget(call("search_journal", { id: "entry-3" })), null);
});

test("searchKey ignores case, spacing, and limit, and describeCall reads like the call", () => {
  assert.equal(
    searchKey(call("search_journal", { limit: 3, query: " A  b " })),
    searchKey(call("search_journal", { query: "a b" }))
  );
  assert.notEqual(
    searchKey(call("search_journal", { query: "a" })),
    searchKey(call("search_chats", { query: "a" }))
  );
  assert.equal(
    describeCall(call("search_chats", { query: "dad", when: "last week" })),
    'search_chats "dad" when "last week"'
  );
  assert.equal(describeCall(call("get_chat", { id: "chat-1" })), "get_chat");
});

// ---------------------------------------------------------------------------
// From needs to ids
// ---------------------------------------------------------------------------

function ownerOf(): LoadedPerson {
  return {
    chats: [
      {
        date: "2026-09-16",
        fileName: "2026-09-16-rent-talk.md",
        index: 1,
        stem: "2026-09-16-rent-talk",
        title: "Rent talk",
        turns: [
          { role: "user", text: "Rent went up and I froze." },
          { role: "assistant", text: "That sounds heavy." },
        ],
        wordCount: 9,
      },
    ],
    dir: "/nowhere",
    empty: false,
    entries: [
      {
        body: RENT_ENTRY_TEXT,
        date: "2026-09-03",
        fileName: "2026-09-03-rent.md",
        index: 1,
        stem: "2026-09-03-rent",
        title: "Rent",
        wordCount: 14,
      },
    ],
    id: "sam",
    personCase: {
      about: "Made up.",
      cast: [],
      chat: [],
      conversations: [],
      events: [],
      facts: [],
      id: "sam",
      openers: [],
      retrieval: [],
      summaries: [],
      tags: [],
      timeline: [],
    },
  };
}

const MANIFEST: Manifest = {
  cases: { sam: { chatIds: [7], journalIds: [41] } },
};

test("resolveSearchNeeds turns entry stems, numbers, and chat refs into the ids the tools show", () => {
  const { needs, problems } = resolveSearchNeeds(
    ownerOf(),
    ["2026-09-03-rent", 1, "chat:2026-09-16-rent-talk"],
    MANIFEST
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(
    needs.map((need) => [need.ref, need.id]),
    [
      ["2026-09-03-rent", "entry-41"],
      ["2026-09-03-rent", "entry-41"],
      ["chat:2026-09-16-rent-talk", "chat-7"],
    ]
  );
  assert.equal(needs[0]?.text, RENT_ENTRY_TEXT);
  assert.equal(needs[2]?.text, "Rent went up and I froze.\nThat sounds heavy.");
});

test("resolveSearchNeeds reports a ref that matches nothing, and a manifest that lacks an id", () => {
  const unknown = resolveSearchNeeds(
    ownerOf(),
    ["nope", "chat:nope"],
    MANIFEST
  );
  assert.equal(unknown.needs.length, 0);
  assert.equal(unknown.problems.length, 2);
  assert.match(unknown.problems[0] ?? "", pattern4);
  assert.match(unknown.problems[1] ?? "", pattern3);

  const old = resolveSearchNeeds(ownerOf(), ["chat:2026-09-16-rent-talk"], {
    cases: { sam: { journalIds: [41] } },
  });
  assert.match(old.problems[0] ?? "", pattern2);

  const none = resolveSearchNeeds(ownerOf(), ["2026-09-03-rent"], undefined);
  assert.match(none.problems[0] ?? "", pattern1);
});
