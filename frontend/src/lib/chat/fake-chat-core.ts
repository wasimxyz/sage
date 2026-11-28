/**
 * A stand-in for the core's chat commands, for tests that run the real bridge
 * in Node. It keeps chats in memory, pages `chat.get`, and takes `chat.save`
 * in chunks the way the core does. Install it before the bridge runs a
 * command.
 */

export interface FakeChat {
  eventFormat: number;
  events: unknown[];
}

export interface FakeSave {
  convert: boolean;
  done: boolean;
  id: number | null;
  offset: number;
}

export interface FakeChatCore {
  chats: Map<number, FakeChat>;
  /**
   * Fails the next save for this chat with the core error `code`, at its
   * `chunk`th call, counting from 0.
   */
  failNextSave: (id: number | null, code: string, chunk?: number) => void;
  /** Every `chat.save` call, chunk by chunk, in the order the core saw them. */
  saves: FakeSave[];
}

function coreError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

export function installFakeChatCore(): FakeChatCore {
  const chats = new Map<number, FakeChat>();
  const saves: FakeSave[] = [];
  const failures = new Map<number | null, { chunk: number; code: string }>();
  let nextId = 1000;
  let pending: { id: number | null; text: string } | null = null;

  function failIfAsked(id: number | null): void {
    const failure = failures.get(id);
    if (failure === undefined) {
      return;
    }
    if (failure.chunk > 0) {
      failure.chunk -= 1;
      return;
    }
    failures.delete(id);
    pending = null;
    throw coreError(failure.code);
  }

  function convertChat(id: number | null, events: unknown[]) {
    const chat = id === null ? undefined : chats.get(id);
    if (chat === undefined) {
      throw coreError("NotFound");
    }
    if (chat.eventFormat !== 26) {
      throw coreError("ChatConverted");
    }
    chat.events = events;
    chat.eventFormat = 27;
    return { id };
  }

  function saveChat(id: number | null, baseSeq: number, events: unknown[]) {
    let savedId = id;
    if (savedId === null) {
      savedId = nextId;
      nextId += 1;
    }
    const chat = chats.get(savedId) ?? { eventFormat: 27, events: [] };
    chat.events = [...chat.events.slice(0, baseSeq), ...events];
    chats.set(savedId, chat);
    return { id: savedId };
  }

  function save(payload: Record<string, unknown>): Record<string, unknown> {
    const id = typeof payload.id === "number" ? payload.id : null;
    const convert = payload.convert === true;
    const offset = Number(payload.offset);
    const done = payload.done === true;
    saves.push({ convert, done, id, offset });
    failIfAsked(id);
    if (offset === 0) {
      pending = { id, text: "" };
    }
    if (pending === null || pending.id !== id) {
      throw coreError("InvalidSaveChunk");
    }
    pending.text += String(payload.chunk);
    if (!done) {
      return { done: false, id };
    }
    const events = JSON.parse(pending.text) as unknown[];
    pending = null;
    return convert
      ? convertChat(id, events)
      : saveChat(id, Number(payload.baseSeq), events);
  }

  function get(payload: Record<string, unknown>): Record<string, unknown> {
    const id = Number(payload.id);
    const chat = chats.get(id);
    if (chat === undefined) {
      throw coreError("NotFound");
    }
    const offset = Number(payload.offset);
    const page = chat.events.slice(offset, offset + 32);
    const nextSeq = offset + page.length;
    return {
      contextLength: 8192,
      createdAt: "2026-10-20T10:00:00.000Z",
      done: nextSeq >= chat.events.length,
      eventFormat: chat.eventFormat,
      events: page,
      eveSessionId: null,
      id,
      model: "qwen3.5:9b",
      nextSeq,
      streamIndex: 0,
      thinking: false,
      title: `Chat ${String(id)}`,
      updatedAt: "2026-10-20T10:00:00.000Z",
    };
  }

  function list(): Record<string, unknown> {
    return {
      conversations: [...chats.keys()].map((id) => ({
        id,
        title: `Chat ${String(id)}`,
        updatedAt: "2026-10-20T10:00:00.000Z",
      })),
      unconverted: [...chats.entries()]
        .filter(([, chat]) => chat.eventFormat === 26)
        .map(([id]) => id),
    };
  }

  const handlers: Record<
    string,
    (payload: Record<string, unknown>) => unknown
  > = { "chat.get": get, "chat.list": list, "chat.save": save };

  Object.assign(globalThis, {
    window: {
      zero: {
        // Each answer comes back on a later turn of the event loop, as the
        // real bridge's do, so saves that were not queued would interleave.
        invoke: (command: string, payload: Record<string, unknown> = {}) =>
          new Promise((resolve, reject) => {
            setTimeout(() => {
              const handler = handlers[command];
              if (handler === undefined) {
                reject(coreError("UnknownCommand"));
                return;
              }
              try {
                resolve(JSON.parse(JSON.stringify(handler(payload))));
              } catch (error) {
                reject(error);
              }
            }, 0);
          }),
      },
    },
  });

  return {
    chats,
    failNextSave: (id, code, chunk = 0) => {
      failures.set(id, { chunk, code });
    },
    saves,
  };
}
