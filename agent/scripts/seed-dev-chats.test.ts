import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { conversationOf, type SessionStreamEvent } from "eve/client";

import {
  type ChatEventTurn,
  chatSessionEvents,
} from "../evals/lib/chat-events.ts";
import type { BridgeCall } from "./seed-chats.ts";
import {
  BEN_MAX_CHARS,
  type BenModel,
  benMessageProblem,
  benRequest,
  CHAT_CONTEXT_LENGTH,
  CHAT_MODEL,
  type ChatDeps,
  chatHeaders,
  chatTitle,
  cleanBenMessage,
  eventsToSave,
  formatHeldChat,
  holdChat,
  loadSeedChats,
  parseSeedChats,
  type SageChat,
  type SeedChat,
  type SentTurn,
  type SessionEvents,
  saveHeldChat,
  toolUses,
  writeBenMessage,
} from "./seed-dev-chats.ts";

const seedDir = fileURLToPath(new URL("../../scripts/seed", import.meta.url));
const notRightPattern = /chats\.yaml is not right/u;
const repeatedPattern = /more than one chat party/u;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** One of the fake's turns as eve 1.0 events: an optional search, then the reply. */
function eventTurn(
  message: string,
  fake: FakeTurn,
  turn: number
): ChatEventTurn {
  const [name] = fake.tools ?? [];
  return {
    question: message,
    ...(fake.reply.length > 0 ? { reply: fake.reply } : {}),
    ...(name === undefined
      ? {}
      : {
          tool: { callId: `call_${turn}`, input: {}, name, output: [] },
        }),
  };
}

interface FakeTurn {
  reply: string;
  status?: SentTurn["status"];
  tools?: string[];
}

/**
 * Chats that answer from one queue of turns, so a chat that runs again takes
 * the next turns. Each chat's stream is one eve session of the turns it sent.
 */
function fakeSage(queue: FakeTurn[]): {
  sent: string[];
  startChat: () => SageChat;
} {
  const sent: string[] = [];
  let sessions = 0;
  const startChat = (): SageChat => {
    sessions += 1;
    const sessionId = `wrun_${sessions}`;
    const turns: ChatEventTurn[] = [];
    let stream: SessionStreamEvent[] = [];
    return {
      events: (): Promise<SessionEvents> =>
        Promise.resolve({
          events: stream,
          sessionId,
          streamIndex: stream.length,
        }),
      send: (message: string): Promise<SentTurn> => {
        sent.push(message);
        const next = queue.shift();
        if (next === undefined) {
          return Promise.reject(new Error("no more turns"));
        }
        turns.push(eventTurn(message, next, sent.length));
        const before = stream.length;
        stream = chatSessionEvents(turns, {
          at: "2026-11-27T12:00:00.000Z",
          modelId: CHAT_MODEL,
          prefix: sessionId,
        }) as unknown as SessionStreamEvent[];
        return Promise.resolve({
          events: stream.slice(before),
          message: next.reply,
          parkedOnInput: false,
          status: next.status ?? "waiting",
        });
      },
    };
  };
  return { sent, startChat };
}

function benSaying(...lines: string[]): { calls: number; model: BenModel } {
  const state = { calls: 0, model: (() => Promise.resolve("")) as BenModel };
  state.model = () => {
    const line = lines[state.calls] ?? lines.at(-1) ?? "";
    state.calls += 1;
    return Promise.resolve(line);
  };
  return state;
}

function deps(startChat: () => SageChat, ben: BenModel): ChatDeps {
  return { ben, log: () => undefined, person: "You are Ben.", startChat };
}

const twoTurnChat: SeedChat = {
  beats: ["He admits it felt like relief."],
  expect: "search_journal",
  name: "quiet",
  opening: "I think I'm doing the thing again.",
};

/** A bridge that answers `chat.save` with an id and `embeddings.generate` with no more. */
function fakeBridge(): {
  call: BridgeCall;
  calls: { command: string; payload: Record<string, unknown> }[];
} {
  const calls: { command: string; payload: Record<string, unknown> }[] = [];
  const call: BridgeCall = (command, payload, id) => {
    calls.push({ command, payload });
    if (command === "chat.save") {
      return { id, ok: true, result: { id: 7 } };
    }
    return { id, ok: true, result: { more: false } };
  };
  return { call, calls };
}

// ---------------------------------------------------------------------------
// The chats file
// ---------------------------------------------------------------------------

test("scripts/seed/chats.yaml holds the five chats in order", async () => {
  const { chats, person } = await loadSeedChats(seedDir);

  assert.ok(person.includes("Ben"));
  assert.deepEqual(
    chats.map((chat) => [
      chat.name,
      chat.beats.length + 1,
      chat.expect ?? null,
    ]),
    [
      ["party", 3, "search_journal"],
      ["quiet", 2, "search_journal"],
      ["toast", 3, "search_journal"],
      ["long-day", 1, null],
      ["booked", 1, "search_chats"],
    ]
  );
});

test("a chats file with a stray key, a bad tool, or a repeated name is refused", () => {
  const chat = { beats: [], name: "party", opening: "Hi." };
  assert.throws(
    () =>
      parseSeedChats(
        { chats: [{ ...chat, turns: 2 }], person: "Ben" },
        "chats.yaml"
      ),
    notRightPattern
  );
  assert.throws(
    () =>
      parseSeedChats(
        { chats: [{ ...chat, expect: "get_chat" }], person: "Ben" },
        "chats.yaml"
      ),
    notRightPattern
  );
  assert.throws(
    () => parseSeedChats({ chats: [chat, chat], person: "Ben" }, "chats.yaml"),
    repeatedPattern
  );
});

test("a chat's title is its first message, cut to 60 characters like the Chat screen's", () => {
  assert.equal(chatTitle("  Short   one. "), "Short one.");
  const long = chatTitle("a".repeat(80));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
});

test("every turn asks for qwen3.5:9b with Thinking on and the new-chat context length", () => {
  assert.deepEqual(chatHeaders(), {
    "x-sage-context-length": String(CHAT_CONTEXT_LENGTH),
    "x-sage-model": "qwen3.5:9b",
    "x-sage-think": "1",
  });
});

// ---------------------------------------------------------------------------
// Ben
// ---------------------------------------------------------------------------

test("Ben's message loses a name in front, wrapping quotes, and a think block", () => {
  assert.equal(cleanBenMessage("Ben: Yeah, that's it."), "Yeah, that's it.");
  assert.equal(cleanBenMessage("**Ben:** “Yeah.”"), "Yeah.");
  assert.equal(cleanBenMessage("<think>plan</think>\nOkay."), "Okay.");
  assert.equal(benMessageProblem(""), "was empty");
  assert.equal(
    benMessageProblem("x".repeat(BEN_MAX_CHARS + 1)),
    `ran to ${BEN_MAX_CHARS + 1} characters`
  );
  assert.equal(
    benMessageProblem("Fine.\nSage: Good."),
    "wrote Sage's side too"
  );
  assert.equal(benMessageProblem("Fine."), null);
});

test("the model playing Ben reads his card, the beat, and only the visible messages", () => {
  const request = benRequest("You are Ben.", "He admits it felt like relief.", [
    { role: "ben", text: "I skipped pottery." },
    { role: "sage", text: "What made this week different?" },
  ]);
  const [system, user] = request.messages;

  assert.equal(system?.role, "system");
  assert.ok(system?.content.startsWith("You are Ben."));
  assert.ok(
    system?.content.includes(
      "What happens in this message: He admits it felt like relief."
    )
  );
  assert.equal(user?.role, "user");
  assert.ok(
    user?.content.includes(
      "Ben: I skipped pottery.\n\nSage: What made this week different?"
    )
  );
});

test("Ben gets one more try, and then the chat says why", async () => {
  const retried = benSaying("x".repeat(BEN_MAX_CHARS + 50), "Okay, fine.");
  assert.deepEqual(
    await writeBenMessage(retried.model, benRequest("Ben", "b", [])),
    {
      ok: true,
      text: "Okay, fine.",
    }
  );
  assert.equal(retried.calls, 2);

  const empty = benSaying("");
  assert.deepEqual(
    await writeBenMessage(empty.model, benRequest("Ben", "b", [])),
    {
      ok: false,
      reason: "Ben's message was empty",
    }
  );

  const down: BenModel = () => Promise.reject(new Error("connection refused"));
  const failed = await writeBenMessage(down, benRequest("Ben", "b", []));
  assert.equal(failed.ok, false);
  assert.ok(!failed.ok && failed.reason.includes("connection refused"));
});

// ---------------------------------------------------------------------------
// Holding a chat
// ---------------------------------------------------------------------------

test("a chat that works runs once, and Ben's later message answers Sage", async () => {
  const sage = fakeSage([
    {
      reply: "That sounds heavy. What made this week different?",
      tools: ["search_journal"],
    },
    { reply: "Relief makes sense. What would a small yes look like?" },
  ]);
  const ben = benSaying("Ben: Honestly, canceling felt like relief.");

  const held = await holdChat(twoTurnChat, deps(sage.startChat, ben.model));

  assert.equal(held.firstProblems, undefined);
  assert.deepEqual(sage.sent, [
    "I think I'm doing the thing again.",
    "Honestly, canceling felt like relief.",
  ]);
  assert.deepEqual(held.final.turns[0]?.tools, [
    { name: "search_journal", status: "completed" },
  ]);
  assert.deepEqual(held.final.problems, []);
});

test("a chat that never searches runs again, then is kept with a warning", async () => {
  const sage = fakeSage([
    { reply: "Tell me more." },
    { reply: "I hear you." },
    { reply: "Tell me more." },
    { reply: "I hear you." },
  ]);
  const ben = benSaying("It felt like relief.");

  const held = await holdChat(twoTurnChat, deps(sage.startChat, ben.model));

  assert.deepEqual(held.firstProblems, ["Sage never ran search_journal"]);
  assert.deepEqual(held.final.problems, ["Sage never ran search_journal"]);
  assert.equal(held.final.turns.length, 2);
  const { call } = fakeBridge();
  const id = await saveHeldChat(call, held);
  assert.equal(id, 7);
  assert.ok(
    formatHeldChat(held, id).includes("Warning: saved as chat 7 with problems")
  );
});

test("a failed turn keeps the turns before it, with no session to resume", async () => {
  const sage = fakeSage([
    { reply: "What made this week different?", tools: ["search_journal"] },
    { reply: "", status: "failed" },
    { reply: "What made this week different?", tools: ["search_journal"] },
    { reply: "", status: "failed" },
  ]);
  const held = await holdChat(
    twoTurnChat,
    deps(sage.startChat, benSaying("Relief.").model)
  );
  const stream = await held.final.sage.events();

  const saved = eventsToSave(stream, held.final);

  assert.equal(saved.eveSessionId, null);
  assert.equal(saved.streamIndex, 0);
  assert.equal(
    saved.events.filter((event) => event.type === "delivery.consumed").length,
    1
  );
  assert.ok(saved.events.length < stream.events.length);
  // The cut falls between turns, before the next message is admitted.
  assert.equal(saved.events.at(-1)?.type, "delivery.settled");
  assert.equal(stream.events[saved.events.length]?.type, "delivery.admitted");
});

test("a chat where no turn worked is not saved", async () => {
  const sage = fakeSage([
    { reply: "", status: "failed" },
    { reply: "", status: "failed" },
  ]);
  const held = await holdChat(
    twoTurnChat,
    deps(sage.startChat, benSaying("x").model)
  );
  const { call, calls } = fakeBridge();

  assert.equal(await saveHeldChat(call, held), null);
  assert.equal(calls.length, 0);
  assert.ok(formatHeldChat(held, null).includes("Warning: not saved."));
});

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

test("a saved chat carries its session and picker, then gets indexed", async () => {
  const sage = fakeSage([
    { reply: "What made this week different?", tools: ["search_journal"] },
    { reply: "Relief makes sense." },
  ]);
  const held = await holdChat(
    twoTurnChat,
    deps(sage.startChat, benSaying("Relief.").model)
  );
  const { call, calls } = fakeBridge();

  await saveHeldChat(call, held);

  const saves = calls.filter((entry) => entry.command === "chat.save");
  assert.ok(saves.length > 0);
  const first = saves[0]?.payload;
  assert.equal(first?.title, "I think I'm doing the thing again.");
  assert.equal(first?.model, "qwen3.5:9b");
  assert.equal(first?.thinking, true);
  assert.equal(first?.contextLength, CHAT_CONTEXT_LENGTH);
  assert.equal(first?.eveSessionId, "wrun_1");
  assert.ok(Number(first?.streamIndex) > 0);
  assert.deepEqual(calls.at(-1), {
    command: "embeddings.generate",
    payload: { chatId: 7 },
  });
});

/** A real turn's shape: a question, one journal search, and an answer. */
function searchTurnEvents(): SessionStreamEvent[] {
  return chatSessionEvents(
    [
      {
        question: "How have my Sundays changed?",
        reply: "They changed.",
        tool: {
          callId: "call_search",
          input: { query: "Sundays" },
          name: "search_journal",
          output: [{ date: "2026-10-11", id: "entry-13", title: "Sunday" }],
        },
      },
    ],
    { at: "2026-11-27T12:00:00.000Z", modelId: CHAT_MODEL }
  ) as unknown as SessionStreamEvent[];
}

test("the saved stream reads through eve's conversationOf as the Chat screen shows it", async () => {
  const stream = searchTurnEvents();
  const held = await holdChat(
    { beats: [], name: "sundays", opening: "How have my Sundays changed?" },
    deps(
      () => ({
        events: () =>
          Promise.resolve({
            events: stream,
            sessionId: "wrun_9",
            streamIndex: stream.length,
          }),
        send: () =>
          Promise.resolve({
            events: stream,
            message: "They changed.",
            parkedOnInput: false,
            status: "waiting",
          }),
      }),
      benSaying("unused").model
    )
  );
  const { call, calls } = fakeBridge();

  await saveHeldChat(call, held);

  const json = calls
    .filter((entry) => entry.command === "chat.save")
    .map((entry) => String(entry.payload.chunk))
    .join("");
  const { messages } = conversationOf(JSON.parse(json) as SessionStreamEvent[]);
  const [user, assistant] = messages;
  assert.equal(user?.role, "user");
  assert.equal(assistant?.role, "assistant");
  const tool = assistant?.parts.find((part) => part.type === "tool");
  assert.equal(tool?.type === "tool" ? tool.name : null, "search_journal");
  assert.deepEqual(toolUses(stream), [
    { name: "search_journal", status: "completed" },
  ]);
});
