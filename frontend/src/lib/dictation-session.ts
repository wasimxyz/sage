// What the page knows about the one dictation that can run at a time. The core
// keeps the real session. This is the page's copy of it, and it only moves on
// what the core says, so a late or repeated message cannot move it back.

export type DictationOwner = "chat" | "entry";

export type DictationPhase = "finishing" | "idle" | "listening" | "starting";

/** Why the core ended a session. */
export type DictationStopReason =
  | "denied"
  | "discarded"
  | "engine_failed"
  | "input_lost"
  | "locked"
  | "no_input"
  | "quit"
  | "user";

export const dictationStopReasons: readonly DictationStopReason[] = [
  "denied",
  "discarded",
  "engine_failed",
  "input_lost",
  "locked",
  "no_input",
  "quit",
  "user",
];

export interface DictationSessionState {
  /** The `seq` of the last text message taken, 0 before the first. */
  lastSeq: number;
  /** A text message went missing during this session. */
  lostWords: boolean;
  owner: DictationOwner | null;
  phase: DictationPhase;
  /** The core's id for the session, once `dictation.start` has answered. */
  session: number | null;
}

export const idleSession: DictationSessionState = {
  lastSeq: 0,
  lostWords: false,
  owner: null,
  phase: "idle",
  session: null,
};

export type DictationAction =
  | { session: number; type: "accepted" }
  | { type: "failed" }
  | { type: "left" }
  | { owner: DictationOwner; type: "requested" }
  | { session: number; type: "started" }
  | { type: "stop" }
  | { session: number; type: "stopped" }
  | { seq: number; session: number; type: "text" };

/** True for a message about the session this page is in. */
export function isCurrentSession(
  state: DictationSessionState,
  session: number
): boolean {
  return (
    state.phase !== "idle" &&
    state.session !== null &&
    state.session === session
  );
}

/** True while the person is talking: the mic is starting or on. */
export function isDictating(state: DictationSessionState): boolean {
  return state.phase === "starting" || state.phase === "listening";
}

/**
 * What to do with a text message. `ok` is the next one in order. `gap` came
 * after one went missing. `ignore` is for another session or one already
 * taken.
 */
export function textVerdict(
  state: DictationSessionState,
  session: number,
  seq: number
): "gap" | "ignore" | "ok" {
  if (!isCurrentSession(state, session) || seq <= state.lastSeq) {
    return "ignore";
  }
  return seq === state.lastSeq + 1 ? "ok" : "gap";
}

function acceptText(
  state: DictationSessionState,
  session: number,
  seq: number
): DictationSessionState {
  const verdict = textVerdict(state, session, seq);
  if (verdict === "ignore") {
    return state;
  }
  return {
    ...state,
    lastSeq: seq,
    lostWords: state.lostWords || verdict === "gap",
    // Words only come once the mic is on, so a lost `started` does not leave
    // the button saying Starting.
    phase: state.phase === "starting" ? "listening" : state.phase,
  };
}

export function reduceDictation(
  state: DictationSessionState,
  action: DictationAction
): DictationSessionState {
  switch (action.type) {
    case "requested":
      return state.phase === "idle"
        ? { ...idleSession, owner: action.owner, phase: "starting" }
        : state;
    case "accepted":
      return state.phase === "starting" && state.session === null
        ? { ...state, session: action.session }
        : state;
    case "failed":
      return state.phase === "starting" && state.session === null
        ? idleSession
        : state;
    case "started":
      return state.phase === "starting" && state.session === action.session
        ? { ...state, phase: "listening" }
        : state;
    case "text":
      return acceptText(state, action.session, action.seq);
    case "stop":
      return isDictating(state) && state.session !== null
        ? { ...state, phase: "finishing" }
        : state;
    case "stopped":
      return isCurrentSession(state, action.session) ? idleSession : state;
    case "left":
      return state.phase === "idle" ? state : idleSession;
    default:
      return state;
  }
}

export const deniedMessage =
  "Sage can't hear you. Allow the microphone in System Settings.";
export const lostWordsMessage = "Some dictated words did not arrive.";
export const modelDownloadingMessage = "Downloading the speech model…";
export const modelReadyMessage =
  "The speech model is ready. Press ⌘D to dictate.";
export const modelFailedMessage = "Could not download the speech model.";

const stopFallbacks: Partial<Record<DictationStopReason, string>> = {
  engine_failed: "Dictation stopped working.",
  input_lost: "The microphone stopped working.",
  no_input: "Sage can't find a microphone.",
};

export type StopNotice =
  | { kind: "denied" }
  | { kind: "error"; message: string };

/**
 * What to tell the person when a session ends. Ending because they asked, or
 * because Sage locked or quit, needs no word.
 */
export function stopNotice(
  reason: DictationStopReason,
  message: string | null
): StopNotice | null {
  if (reason === "denied") {
    return { kind: "denied" };
  }
  const fallback = stopFallbacks[reason];
  if (fallback === undefined) {
    return null;
  }
  return {
    kind: "error",
    message: message !== null && message.length > 0 ? message : fallback,
  };
}

/** How `dictation.start` failed, from the error name the core sent. */
export type StartFailure =
  | "busy"
  | "denied"
  | "download"
  | "locked"
  | "other"
  | "unavailable";

export function startFailure(code: string | null): StartFailure {
  switch (code) {
    case "MicrophoneDenied":
      return "denied";
    case "SpeechModelMissing":
      return "download";
    case "DictationBusy":
      return "busy";
    case "DictationUnavailable":
      return "unavailable";
    case "Locked":
    case "Securing":
      return "locked";
    default:
      return "other";
  }
}

export const startFailureMessages: Record<
  Exclude<StartFailure, "denied" | "download" | "locked">,
  string
> = {
  busy: "Dictation is still stopping. Try again in a moment.",
  other: "Could not start dictation.",
  unavailable: "Dictation isn't available on this Mac.",
};

/** The speech model's download as a percent, or null before it has a size. */
export function speechModelPercent(fraction: number | null): string | null {
  if (fraction === null || !Number.isFinite(fraction)) {
    return null;
  }
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}
