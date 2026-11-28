// The real chats `make seed-dev CHATS=1` holds with Sage, after Dream has read
// the seed entries. `seed-dev.ts` calls `holdSeedChats` while the automation
// build of Sage is running against the dev journal.
//
// Sage's side is the real Chat agent: an `eve dev` server started from
// `agent/`, on qwen3.5:9b with Thinking on, calling the real tools against the
// running Sage. Its session files land in `agent/.eve/.workflow-data`, where
// `make dev` resumes them.
//
// Ben's side comes from `chats.yaml` in the seed folder. His first message in
// each chat is written there. Each later one is written by the same local
// model playing Ben (`writeBenMessage`), from his card, the chat's next beat,
// and the messages so far. Nothing here calls a cloud model.
//
// Each chat is checked when it ends. Every Sage turn must finish with visible
// text, on the model asked for (`checkTurnWorks`), and a chat with `expect`
// must have run that tool. A chat that fails runs once more on a new session.
// A second failure keeps the turns that worked and prints a warning.
//
// A chat is saved once it passes, with the session's whole event stream, the
// way the Chat screen saves a finished turn. Then its messages are indexed, so
// a later chat can find it with search_chats.

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  Client,
  type ClientSession,
  type MessageResponse,
  type MessageStreamEvent,
} from "eve/client";
import { loadYaml } from "eve/evals/loaders";
import { z } from "zod";

import {
  HEADER_CONTEXT_LENGTH,
  HEADER_MODEL,
  HEADER_THINK,
} from "../evals/lib/setup.ts";
import { checkTurnWorks, measureTurn } from "../evals/lib/turn.ts";
import { type Automation, callBridge } from "./automation.ts";
import { readServerToken, startEveServer } from "./eval/eve.ts";
import { killAllTracked, readLogTail } from "./eval/proc.ts";
import { type BridgeCall, indexChat, saveChatEvents } from "./seed-chats.ts";

/** The model a new chat starts with, and the one that plays Ben. */
export const CHAT_MODEL = "qwen3.5:9b";
/** What the Chat screen saves when a chat is new. */
export const CHAT_CONTEXT_LENGTH = 32_768;
export const CHATS_FILE = "chats.yaml";

/** The Chat screen cuts a new chat's title from its first message at this length. */
const TITLE_LIMIT = 60;
/** Longer than this, Ben's message is a speech, not a chat message. */
export const BEN_MAX_CHARS = 600;
/** A turn with thinking, a search, and a reply on a slow Mac stays well under this. */
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const BEN_TIMEOUT_MS = 5 * 60 * 1000;

const chatSchema = z
  .object({
    beats: z.array(z.string().trim().min(1)),
    expect: z.enum(["search_journal", "search_chats"]).optional(),
    name: z
      .string()
      .regex(/^[a-z0-9-]+$/u, "use lowercase letters, digits, and dashes"),
    opening: z.string().trim().min(1),
  })
  .strict();

const fileSchema = z
  .object({
    chats: z.array(chatSchema).min(1),
    person: z.string().trim().min(1),
  })
  .strict();

export type SeedChat = z.infer<typeof chatSchema>;
export type SeedChats = z.infer<typeof fileSchema>;

/** Reads and checks `chats.yaml` in the seed folder. */
export async function loadSeedChats(seedDir: string): Promise<SeedChats> {
  const file = join(seedDir, CHATS_FILE);
  if (!existsSync(file)) {
    throw new Error(
      `${seedDir} has no ${CHATS_FILE}, so CHATS=1 has no chats to hold. Run without CHATS=1, or add one like scripts/seed/${CHATS_FILE}.`
    );
  }
  let doc: unknown;
  try {
    doc = await loadYaml(file);
  } catch (error) {
    throw new Error(`Could not read ${file}.`, { cause: error });
  }
  return parseSeedChats(doc, file);
}

/** Checks the parsed file. `file` names it in an error. */
export function parseSeedChats(doc: unknown, file: string): SeedChats {
  const parsed = fileSchema.safeParse(doc);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `  ${issue.path.join(".") || "(top)"}: ${issue.message}`
    );
    throw new Error(`${file} is not right:\n${problems.join("\n")}`);
  }
  const names = parsed.data.chats.map((chat) => chat.name);
  const repeated = names.filter((name, index) => names.indexOf(name) !== index);
  if (repeated.length > 0) {
    throw new Error(
      `${file} names more than one chat ${[...new Set(repeated)].join(", ")}.`
    );
  }
  return parsed.data;
}

/** The title the Chat screen gives a new chat: its first message, cut to 60 characters. */
export function chatTitle(opening: string): string {
  const trimmed = opening.trim().replace(/\s+/gu, " ");
  if (trimmed.length <= TITLE_LIMIT) {
    return trimmed;
  }
  return `${trimmed.slice(0, TITLE_LIMIT - 1)}…`;
}

// ---------------------------------------------------------------------------
// Ben
// ---------------------------------------------------------------------------

/** A message as the person reads it: no tool calls, no Thought text. */
export interface VisibleMessage {
  role: "ben" | "sage";
  text: string;
}

export interface BenRequest {
  messages: { content: string; role: "system" | "user" }[];
}

/** Writes one message as Ben. The real one calls Ollama; a test answers for it. */
export type BenModel = (request: BenRequest) => Promise<string>;

/**
 * What the model playing Ben reads: his card and the beat for this message as
 * the system prompt, then the chat so far as one transcript. A transcript in
 * one message keeps the model on Ben's side, whatever its chat template does
 * with a conversation that opens on an assistant turn.
 */
export function benRequest(
  person: string,
  beat: string,
  messages: readonly VisibleMessage[]
): BenRequest {
  const system = [
    person.trim(),
    "You are writing to Sage, the private journal companion on your Mac. It has read your journal.",
    "Write your next message to Sage and nothing else: no name in front, no quotation marks, no notes about what you're doing.",
    `What happens in this message: ${beat.trim()}`,
    "Reply to what Sage just said, in your own words. Don't copy the wording above, and don't wrap the conversation up.",
  ].join("\n\n");
  const transcript = messages
    .map(
      (message) =>
        `${message.role === "ben" ? "Ben" : "Sage"}: ${message.text.trim()}`
    )
    .join("\n\n");
  return {
    messages: [
      { content: system, role: "system" },
      {
        content: `The chat so far:\n\n${transcript}\n\nWrite Ben's next message.`,
        role: "user",
      },
    ],
  };
}

const thinkBlock = /<think>[\s\S]*?<\/think>/giu;
const leadingName = /^\**ben\**\s*:\**\s*/iu;
const wrappingQuotes = /^["“]([\s\S]*)["”]$/u;
const sageLine = /^\**sage\**\s*:/imu;

/** Ben's message without a name in front, wrapping quotes, or a stray think block. */
export function cleanBenMessage(raw: string): string {
  let text = raw.replace(thinkBlock, "").trim();
  text = text.replace(leadingName, "").trim();
  const quoted = wrappingQuotes.exec(text);
  if (quoted?.[1] !== undefined) {
    text = quoted[1].trim();
  }
  return text;
}

/** Why a cleaned message can't be sent, or null when it can. */
export function benMessageProblem(text: string): string | null {
  if (text.length === 0) {
    return "was empty";
  }
  if (text.length > BEN_MAX_CHARS) {
    return `ran to ${text.length} characters`;
  }
  if (sageLine.test(text)) {
    return "wrote Sage's side too";
  }
  return null;
}

export type BenResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/** Asks for Ben's message, and once more if the first can't be sent. */
export async function writeBenMessage(
  model: BenModel,
  request: BenRequest
): Promise<BenResult> {
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the second ask only runs when the first fails.
      const text = cleanBenMessage(await model(request));
      const problem = benMessageProblem(text);
      if (problem === null) {
        return { ok: true, text };
      }
      reason = `Ben's message ${problem}`;
    } catch (error) {
      reason = `the model playing Ben failed: ${errorText(error)}`;
    }
  }
  return { ok: false, reason };
}

/** Ben on the local Ollama, through the native `/api/chat`. */
export function ollamaBen(
  apiBase: string,
  model: string = CHAT_MODEL
): BenModel {
  return async ({ messages }) => {
    const response = await fetch(`${apiBase}/chat`, {
      body: JSON.stringify({
        messages,
        model,
        // The Chat agent loads the model with this window. Asking for the same
        // one keeps Ollama from loading it again for every message.
        options: { num_ctx: CHAT_CONTEXT_LENGTH },
        stream: false,
        think: false,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(BEN_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Ollama answered ${response.status}: ${await response.text()}`
      );
    }
    const body = (await response.json()) as { message?: { content?: unknown } };
    const content = body.message?.content;
    return typeof content === "string" ? content : "";
  };
}

// ---------------------------------------------------------------------------
// Sage
// ---------------------------------------------------------------------------

/** What a turn reported, as the checks read it. */
export interface SentTurn {
  events: readonly MessageStreamEvent[];
  inputRequests: number;
  message: string;
  status: "completed" | "failed" | "waiting";
}

export interface SessionEvents {
  events: readonly MessageStreamEvent[];
  sessionId: string;
  streamIndex: number;
}

/** One conversation with the Chat agent. A test answers for it. */
export interface SageChat {
  /** Every event of the session so far, and its cursor. */
  events: () => Promise<SessionEvents>;
  send: (message: string) => Promise<SentTurn>;
}

export type StartSageChat = () => SageChat;

/** The headers the Chat screen sends with every turn of a new chat on qwen3.5:9b with Thinking on. */
export function chatHeaders(): Record<string, string> {
  return {
    [HEADER_CONTEXT_LENGTH]: String(CHAT_CONTEXT_LENGTH),
    [HEADER_MODEL]: CHAT_MODEL,
    [HEADER_THINK]: "1",
  };
}

/**
 * Chats on the seed's eve server. The headers ride on every request, because
 * eve drops request headers between the turns of a session.
 */
export function eveChats(url: string, token: string): StartSageChat {
  const client = new Client({
    auth: { bearer: token },
    headers: chatHeaders(),
    host: url,
    redirect: "error",
  });
  return () => {
    let session: ClientSession | null = null;
    return {
      async events() {
        if (session === null) {
          throw new Error("The chat has no session yet.");
        }
        const snapshot = await session.snapshot();
        return {
          events: snapshot.events,
          sessionId: snapshot.session.sessionId,
          streamIndex: snapshot.session.streamIndex,
        };
      },
      async send(message) {
        const signal = AbortSignal.timeout(TURN_TIMEOUT_MS);
        let response: MessageResponse;
        if (session === null) {
          ({ response, session } = await client.sessions.create({
            message,
            signal,
          }));
        } else {
          response = await session.send(message, { signal });
        }
        const result = await response.result();
        return {
          events: result.events,
          inputRequests: result.inputRequests.length,
          message: result.message ?? "",
          status: result.status,
        };
      },
    };
  };
}

export interface ToolUse {
  name: string;
  status: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Remembers the tool each call asked for, from an `actions.requested` event. */
function noteRequestedTools(
  data: Record<string, unknown>,
  names: Map<string, string>
): void {
  if (!Array.isArray(data.actions)) {
    return;
  }
  for (const action of data.actions) {
    if (
      isRecord(action) &&
      typeof action.callId === "string" &&
      typeof action.toolName === "string"
    ) {
      names.set(action.callId, action.toolName);
    }
  }
}

/** The tool and how it ended, from an `action.result` event. */
function resultTool(
  data: Record<string, unknown>,
  names: ReadonlyMap<string, string>
): ToolUse | null {
  if (!isRecord(data.result)) {
    return null;
  }
  const { callId, toolName } = data.result;
  const requested = typeof callId === "string" ? names.get(callId) : undefined;
  return {
    name:
      typeof toolName === "string" ? toolName : (requested ?? "unknown tool"),
    status: typeof data.status === "string" ? data.status : "unknown",
  };
}

/** The tools a turn ran, in order, with how each ended. */
export function toolUses(events: readonly MessageStreamEvent[]): ToolUse[] {
  const names = new Map<string, string>();
  const uses: ToolUse[] = [];
  for (const event of events) {
    const data: unknown = event.data;
    if (!isRecord(data)) {
      continue;
    }
    if (event.type === "actions.requested") {
      noteRequestedTools(data, names);
    } else if (event.type === "action.result") {
      const use = resultTool(data, names);
      if (use !== null) {
        uses.push(use);
      }
    }
  }
  return uses;
}

// ---------------------------------------------------------------------------
// One chat
// ---------------------------------------------------------------------------

export interface HeldTurn {
  ben: string;
  problems: string[];
  sage: string;
  tools: ToolUse[];
}

export interface Attempt {
  /** Problems with the chat as a whole: Ben's message failed, or a tool never ran. */
  problems: string[];
  sage: SageChat;
  turns: HeldTurn[];
}

export interface HeldChat {
  chat: SeedChat;
  final: Attempt;
  /** Why the first run was redone, when it was. */
  firstProblems?: string[];
}

export interface ChatDeps {
  ben: BenModel;
  log: (line: string) => void;
  person: string;
  startChat: StartSageChat;
}

/** Every problem in a run, turn by turn, then the chat's own. */
export function attemptProblems(attempt: Attempt): string[] {
  return [
    ...attempt.turns.flatMap((turn, index) =>
      turn.problems.map((problem) => `turn ${index + 1}: ${problem}`)
    ),
    ...attempt.problems,
  ];
}

/** The turns before the first one with a problem. */
export function finishedTurns(attempt: Attempt): HeldTurn[] {
  const firstBad = attempt.turns.findIndex((turn) => turn.problems.length > 0);
  return firstBad === -1 ? attempt.turns : attempt.turns.slice(0, firstBad);
}

async function attemptChat(chat: SeedChat, deps: ChatDeps): Promise<Attempt> {
  const sage = deps.startChat();
  const attempt: Attempt = { problems: [], sage, turns: [] };
  const seen: VisibleMessage[] = [];
  const total = chat.beats.length + 1;
  for (let n = 0; n < total; n += 1) {
    let ben = chat.opening;
    const beat = chat.beats[n - 1];
    if (beat !== undefined) {
      // biome-ignore lint/performance/noAwaitInLoops: each message answers the reply before it.
      const written = await writeBenMessage(
        deps.ben,
        benRequest(deps.person, beat, seen)
      );
      if (!written.ok) {
        attempt.problems.push(`turn ${n + 1}: ${written.reason}`);
        return attempt;
      }
      ben = written.text;
    }
    deps.log(`  ${chat.name} turn ${n + 1}/${total}`);
    let sent: SentTurn;
    try {
      sent = await sage.send(ben);
    } catch (error) {
      attempt.turns.push({
        ben,
        problems: [`the turn did not finish: ${errorText(error)}`],
        sage: "",
        tools: [],
      });
      return attempt;
    }
    const works = checkTurnWorks({
      chatModel: CHAT_MODEL,
      parkedOnInput: sent.inputRequests > 0,
      replyText: sent.message,
      status: sent.status,
      stepModelIds: measureTurn(sent.events).stepModelIds,
    });
    attempt.turns.push({
      ben,
      problems: works.problems,
      sage: sent.message,
      tools: toolUses(sent.events),
    });
    if (!works.pass) {
      return attempt;
    }
    seen.push({ role: "ben", text: ben }, { role: "sage", text: sent.message });
  }
  const { expect } = chat;
  const ran = attempt.turns.some((turn) =>
    turn.tools.some(
      (tool) => tool.name === expect && tool.status === "completed"
    )
  );
  if (expect !== undefined && !ran) {
    attempt.problems.push(`Sage never ran ${expect}`);
  }
  return attempt;
}

/** Holds one chat, and holds it once more if the first run has a problem. */
export async function holdChat(
  chat: SeedChat,
  deps: ChatDeps
): Promise<HeldChat> {
  const first = await attemptChat(chat, deps);
  const firstProblems = attemptProblems(first);
  if (firstProblems.length === 0) {
    return { chat, final: first };
  }
  deps.log(
    `  ${chat.name}: ${firstProblems.join("; ")}. Running it once more.`
  );
  return { chat, final: await attemptChat(chat, deps), firstProblems };
}

/**
 * The events to save: the whole stream when every turn worked, so the chat
 * resumes on its own session. Otherwise only the turns before the first bad
 * one, with no session, so `make dev` starts a new one from the transcript.
 */
export function eventsToSave(
  stream: SessionEvents,
  attempt: Attempt
): {
  events: readonly MessageStreamEvent[];
  eveSessionId: string | null;
  streamIndex: number;
} {
  const keep = finishedTurns(attempt).length;
  if (keep === attempt.turns.length) {
    return {
      events: stream.events,
      eveSessionId: stream.sessionId,
      streamIndex: stream.streamIndex,
    };
  }
  let received = 0;
  const cut = stream.events.findIndex((event) => {
    if (event.type !== "message.received") {
      return false;
    }
    received += 1;
    return received > keep;
  });
  return {
    events: cut === -1 ? stream.events : stream.events.slice(0, cut),
    eveSessionId: null,
    streamIndex: 0,
  };
}

/** Saves a held chat and indexes its messages. Returns its id, or null when no turn worked. */
export async function saveHeldChat(
  call: BridgeCall,
  held: HeldChat
): Promise<number | null> {
  if (finishedTurns(held.final).length === 0) {
    return null;
  }
  const toSave = eventsToSave(await held.final.sage.events(), held.final);
  const label = `seed-dev-${held.chat.name}`;
  const id = saveChatEvents(
    call,
    label,
    JSON.stringify(toSave.events),
    {
      contextLength: CHAT_CONTEXT_LENGTH,
      eveSessionId: toSave.eveSessionId,
      model: CHAT_MODEL,
      streamIndex: toSave.streamIndex,
      thinking: true,
      title: chatTitle(held.chat.opening),
    },
    `seed chat ${held.chat.name}`
  );
  indexChat(call, label, id);
  return id;
}

/** A held chat as the seed prints it: who said what, the tools, and any warning. */
export function formatHeldChat(held: HeldChat, savedId: number | null): string {
  const lines = [`== ${held.chat.name} ==`];
  for (const turn of held.final.turns) {
    lines.push(`Ben: ${turn.ben}`, "");
    if (turn.tools.length > 0) {
      lines.push(
        `[${turn.tools.map((tool) => (tool.status === "completed" ? tool.name : `${tool.name} (${tool.status})`)).join(", ")}]`
      );
    }
    lines.push(`Sage: ${turn.sage || "(no reply)"}`, "");
  }
  if (held.firstProblems !== undefined) {
    lines.push(`Ran twice. The first run: ${held.firstProblems.join("; ")}.`);
  }
  const problems = attemptProblems(held.final);
  if (savedId === null) {
    lines.push(`Warning: not saved. ${problems.join("; ")}.`);
  } else if (problems.length > 0) {
    lines.push(
      `Warning: saved as chat ${savedId} with problems: ${problems.join("; ")}.`
    );
  } else {
    lines.push(`Saved as chat ${savedId}.`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// All of them
// ---------------------------------------------------------------------------

export interface HoldOptions {
  agentDir: string;
  automation: Automation;
  /** The running Sage's agent-server.json. The server and the client read the token there. */
  discoveryFile: string;
  /** Where the eve server's log goes. */
  logFile: string;
  ollamaApiBase: string;
  seedChats: SeedChats;
}

export interface SeededChat {
  held: HeldChat;
  savedId: number | null;
}

/**
 * Stops the Chat agent if this process ends early. The agent runs in a
 * process group of its own, so Ctrl-C reaches this process and not it. Only
 * the children this process started are stopped. Returns a function that
 * takes the handlers back out.
 */
function stopAgentOnExit(): () => void {
  const onSignal = (): void => {
    killAllTracked();
    process.exit(130);
  };
  process.on("exit", killAllTracked);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("exit", killAllTracked);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

/**
 * Starts the Chat agent, holds every chat in order, saves each, and stops the
 * agent. Ctrl-C stops the agent only while it runs: Dream's wait is a loop
 * that never yields, so a handler there would swallow the signal.
 */
export async function holdSeedChats(
  options: HoldOptions
): Promise<SeededChat[]> {
  const release = stopAgentOnExit();
  try {
    return await holdWithAgent(options);
  } finally {
    release();
  }
}

async function holdWithAgent(options: HoldOptions): Promise<SeededChat[]> {
  const server = await startEveServer({
    agentDir: options.agentDir,
    discoveryFile: options.discoveryFile,
    logFile: options.logFile,
    ollamaBaseUrl: options.ollamaApiBase,
    root: options.agentDir,
    withWorkflowGuard: true,
  });
  try {
    const deps: ChatDeps = {
      ben: ollamaBen(options.ollamaApiBase),
      log: (line) => console.log(line),
      person: options.seedChats.person,
      startChat: eveChats(server.url, readServerToken(options.discoveryFile)),
    };
    const call: BridgeCall = (command, payload, id) =>
      callBridge(options.automation, command, payload, id);
    const seeded: SeededChat[] = [];
    const { chats } = options.seedChats;
    for (const [index, chat] of chats.entries()) {
      console.log(`Chat ${index + 1} of ${chats.length}: ${chat.name}`);
      // biome-ignore lint/performance/noAwaitInLoops: a later chat can search the ones before it, and local generation never overlaps.
      const held = await holdChat(chat, deps);
      if (attemptProblems(held.final).length > 0) {
        console.log(`Chat agent log:\n${readLogTail(options.logFile, 20)}`);
      }
      seeded.push({ held, savedId: await saveHeldChat(call, held) });
    }
    return seeded;
  } finally {
    await server.stop();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
