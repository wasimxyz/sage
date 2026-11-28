import { type ChatConversation, chatGet } from "@/bridge";

import {
  convertStoredChat,
  legacyEventFormat,
} from "./convert-stored-chats.ts";

export type ChatLoadResult =
  | { conversation: ChatConversation | null; kind: "ready" }
  | { kind: "failed"; message: string };

type PendingThenable<T> = Promise<T> & {
  status: "pending";
};

type FulfilledThenable<T> = Promise<T> & {
  status: "fulfilled";
  value: T;
};

type RejectedThenable<T> = Promise<T> & {
  reason: unknown;
  status: "rejected";
};

export type TrackedPromise<T> =
  | FulfilledThenable<T>
  | PendingThenable<T>
  | RejectedThenable<T>;

export type ChatLoadPromise = TrackedPromise<ChatLoadResult>;

export function fulfilledPromise<T>(value: T): FulfilledThenable<T> {
  const promise = Promise.resolve(value) as FulfilledThenable<T>;
  promise.status = "fulfilled";
  promise.value = value;
  return promise;
}

export function trackPromise<T>(promise: Promise<T>): TrackedPromise<T> {
  const tracked = promise as TrackedPromise<T>;
  if (
    tracked.status === "fulfilled" ||
    tracked.status === "pending" ||
    tracked.status === "rejected"
  ) {
    return tracked;
  }
  const pending = promise as PendingThenable<T>;
  pending.status = "pending";
  promise.then(
    (value) => {
      const fulfilled = pending as unknown as FulfilledThenable<T>;
      fulfilled.status = "fulfilled";
      fulfilled.value = value;
    },
    (reason: unknown) => {
      const rejected = pending as unknown as RejectedThenable<T>;
      rejected.reason = reason;
      rejected.status = "rejected";
    }
  );
  return pending;
}

export const emptyChatLoad: ChatLoadPromise = fulfilledPromise({
  conversation: null,
  kind: "ready",
});

/**
 * Reads a saved chat. A chat saved before eve 1.0 is converted first, so
 * Chat only ever shows and saves eve's current events.
 */
async function readConversation(id: number): Promise<ChatConversation> {
  const conversation = await chatGet(id);
  if (conversation.eventFormat !== legacyEventFormat) {
    return conversation;
  }
  await convertStoredChat(id);
  return chatGet(id);
}

export function loadConversation(id: number): ChatLoadPromise {
  return trackPromise(
    readConversation(id)
      .then(
        (conversation): ChatLoadResult => ({
          conversation,
          kind: "ready",
        })
      )
      .catch(
        (error: unknown): ChatLoadResult => ({
          kind: "failed",
          message:
            error instanceof Error
              ? error.message
              : "Could not open that chat.",
        })
      )
  );
}

export function readyChatLoad(conversation: ChatConversation): ChatLoadPromise {
  return fulfilledPromise({ conversation, kind: "ready" });
}
