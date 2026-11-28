import {
  ClientError,
  SessionNotActiveError,
  type SessionStreamEvent,
} from "eve/client";

import { historyTranscript } from "./chat-log.ts";

const historyContextPreamble =
  "The earlier conversation was restored after a session restart. Use it as context and do not quote it back wholesale.";
const omittedMarker = "_Earlier messages were omitted._\n\n";
const transcriptLimitBytes = 12 * 1024;
const turnSeparator = "\n\n";
const encoder = new TextEncoder();
// eve refuses a session that can no longer run: it ended (409
// session_not_active), an older eve built it (409 session_stranded), its
// history passed retention (410 session_expired), or the workflow store no
// longer has it (404 with no code, after the client's retries).
const endedSessionCodes = new Set([
  "session_expired",
  "session_not_active",
  "session_stranded",
]);
const notFoundMessages = new Set(["Session not found", "Session not found."]);

export function isEndedSessionError(error: unknown): boolean {
  // eve asks for a retry with session_not_ready. That session still runs.
  if (SessionNotActiveError.is(error)) {
    return error.code === "session_not_active";
  }
  if (ClientError.is(error)) {
    if (error.status === 404) {
      return notFoundMessages.has(error.message);
    }
    return (
      (error.status === 409 || error.status === 410) &&
      (endedSessionCodes.has(error.code) ||
        error.message === "The session is no longer active.")
    );
  }
  return (
    error instanceof Error &&
    error.message.includes("The session is no longer active.")
  );
}

/**
 * What you and Sage said in the saved sessions, as Markdown turns, newest
 * kept when it runs past the limit. eve's transcript leaves out reasoning,
 * tool calls, and text Sage wrote on the way to a tool call.
 */
export function buildHistoryTranscript(
  events: readonly SessionStreamEvent[]
): string {
  const turns = historyTranscript(events).flatMap((message) => {
    const text = message.text.trim();
    if (text.length === 0) {
      return [];
    }
    return [`**${message.role === "user" ? "User" : "Assistant"}**\n${text}`];
  });
  if (turns.length === 0) {
    return "";
  }
  const joined = turns.join(turnSeparator);
  if (utf8ByteLength(joined) <= transcriptLimitBytes) {
    return joined;
  }
  return trimTranscriptToLimit(turns);
}

export function historyClientContext(
  events: readonly SessionStreamEvent[]
): string | undefined {
  const transcript = buildHistoryTranscript(events);
  if (transcript.length === 0) {
    return undefined;
  }
  return `${historyContextPreamble}\n\n${transcript}`;
}

function trimTranscriptToLimit(turns: readonly string[]): string {
  const markerBytes = utf8ByteLength(omittedMarker);
  const budget = Math.max(0, transcriptLimitBytes - markerBytes);
  const kept: string[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const piece = turns[index];
    const separatorBytes = kept.length === 0 ? 0 : turnSeparator.length;
    const extra = utf8ByteLength(piece) + separatorBytes;
    if (kept.length > 0 && used + extra > budget) {
      break;
    }
    kept.unshift(piece);
    used += extra;
  }
  return `${omittedMarker}${kept.join(turnSeparator)}`;
}

function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}
