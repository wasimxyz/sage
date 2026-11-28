/**
 * Saved Chat events written by hand, for chats that scripts seed or show
 * without a model: the throwaway Sage's past chats and the screenshot chat.
 *
 * eve 1.0 saves stream version 27 events. Each stored line holds the events
 * of one state change, and each event carries its place as
 * `meta.position: { line, index }`. A turn takes in its message with
 * `delivery.consumed`, each model run starts with `model.started`, Sage's
 * text is a `content.completed`, and `turn.settled` ends the turn. The Chat
 * screen renders these with eve's `conversationOf`, and Sage's core reads the
 * User and Sage text from them.
 */

/** A tool call a turn made before its reply. */
export interface ChatEventToolCall {
  callId: string;
  input: Record<string, unknown>;
  name: string;
  output: unknown;
}

/**
 * One exchange: what the person asked, any tool call, and Sage's reply. A
 * turn with no question holds Sage's text before the person's first message,
 * and one with no reply ends without one.
 */
export interface ChatEventTurn {
  question?: string;
  reply?: string;
  tool?: ChatEventToolCall;
}

export interface ChatEventOptions {
  /** The time on every event. */
  at: string;
  /** The model each run names. */
  modelId?: string;
  /** Names this chat's turn, run, and delivery ids, so two chats differ. */
  prefix?: string;
}

/** One saved event. */
export interface SavedChatEvent {
  data: Record<string, unknown>;
  meta: {
    at: string;
    endOfLine: boolean;
    position: { index: number; line: number };
  };
  scope?: Record<string, string>;
  type: string;
}

type Fact = Omit<SavedChatEvent, "meta">;

class LineWriter {
  readonly events: SavedChatEvent[] = [];
  private line = 0;
  private readonly at: string;

  constructor(at: string) {
    this.at = at;
  }

  write(...facts: Fact[]): void {
    for (const [index, fact] of facts.entries()) {
      this.events.push({
        ...fact,
        meta: {
          at: this.at,
          endOfLine: index === facts.length - 1,
          position: { index, line: this.line },
        },
      });
    }
    this.line += 1;
  }
}

function modelRun(
  writer: LineWriter,
  turnId: string,
  runId: string,
  modelId: string
): void {
  const scope = { runId, turnId };
  writer.write(
    { data: { owner: { turnId }, runId }, scope, type: "model.requested" },
    { data: { attempt: 0, modelId, runId }, scope, type: "model.started" }
  );
}

function modelSettled(
  writer: LineWriter,
  turnId: string,
  runId: string,
  finishReason: string
): void {
  writer.write({
    data: { finishReason, outcome: "completed", runId },
    scope: { runId, turnId },
    type: "model.settled",
  });
}

function writeToolCall(
  writer: LineWriter,
  turnId: string,
  runId: string,
  tool: ChatEventToolCall
): void {
  const scope = { runId, turnId };
  writer.write({
    data: {
      callId: tool.callId,
      capability: { kind: "tool", name: tool.name },
      input: tool.input,
      owner: { runId },
    },
    scope,
    type: "call.requested",
  });
  writer.write(
    { data: { callId: tool.callId }, scope, type: "call.started" },
    {
      data: { callId: tool.callId, outcome: "completed", output: tool.output },
      scope,
      type: "call.settled",
    }
  );
}

/** The events of one session with `turns`, from its `session.started` on. */
export function chatSessionEvents(
  turns: readonly ChatEventTurn[],
  options: ChatEventOptions
): SavedChatEvent[] {
  const prefix = options.prefix ?? "chat";
  const modelId = options.modelId ?? "qwen3.5:9b";
  const writer = new LineWriter(options.at);
  writer.write({ data: {}, type: "session.started" });
  let follows: string | null = null;
  for (const [index, turn] of turns.entries()) {
    const turnId = `turn_${String(index)}`;
    const deliveryId = `${prefix}_delivery_${String(index)}`;
    const scope = { turnId };
    writer.write(
      { data: { deliveryId }, type: "delivery.admitted" },
      {
        data: { cause: { deliveryId }, follows, turnId },
        scope,
        type: "turn.started",
      }
    );
    writer.write({
      data: {
        deliveryId,
        parts:
          turn.question === undefined
            ? []
            : [{ kind: "text", text: turn.question }],
        turnId,
      },
      scope,
      type: "delivery.consumed",
    });
    let run = 0;
    const runId = () => `${prefix}_run_${String(index)}_${String(run)}`;
    if (turn.tool !== undefined) {
      modelRun(writer, turnId, runId(), modelId);
      writeToolCall(writer, turnId, runId(), turn.tool);
      modelSettled(writer, turnId, runId(), "tool-calls");
      run += 1;
    }
    const reply: string[] = [];
    if (turn.reply !== undefined) {
      const replyRun = runId();
      const partId = `${replyRun}.0`;
      modelRun(writer, turnId, replyRun, modelId);
      writer.write({
        data: {
          kind: "text",
          partId,
          phase: "reply",
          runId: replyRun,
          value: turn.reply,
        },
        scope: { runId: replyRun, turnId },
        type: "content.completed",
      });
      modelSettled(writer, turnId, replyRun, "stop");
      reply.push(partId);
    }
    writer.write(
      {
        data: { outcome: "completed", reply, turnId },
        scope,
        type: "turn.settled",
      },
      {
        data: { deliveryId, outcome: "handled", turnId },
        type: "delivery.settled",
      }
    );
    follows = turnId;
  }
  return writer.events;
}
