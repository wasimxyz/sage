import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as ProseNode, Slice } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import type { StepMap } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { joinPhrase, tidyParagraphs } from "./dictation-text.ts";

// Dictation in the entry editor.
//
// Words come in two kinds. Grey words are a guess that may still change, so
// they are only drawn, as a widget at the anchor, and are never part of the
// document. Final words are settled, and go into the document as plain text at
// the anchor, so autosave, undo, and search treat them like typing.
//
// The anchor is where the next words land. It follows the person: typing moves
// it, and so does the cursor. A phrase that is still grey settles where it
// started, and the next one starts at the cursor.

/** The stretch of the document that dictation filled, for Tidy. */
export interface DictatedRange {
  from: number;
  to: number;
}

export type TidyState =
  | {
      /** The person changed text inside the range while Tidy ran. */
      edited: boolean;
      from: number;
      id: number;
      kind: "working";
      original: Slice;
      to: number;
    }
  | { from: number; kind: "review"; original: Slice; to: number };

export interface DictationPluginState {
  /** A session is feeding this editor. */
  active: boolean;
  /** Where the next words land, unless `atEnd` says otherwise. */
  anchor: number;
  /** The next words go at the end of the body, in a new paragraph if the last one has text. */
  atEnd: boolean;
  /** Where the cursor moved to. The phrase after the one in progress starts here. */
  pending: number | null;
  range: DictatedRange | null;
  /** The grey words. */
  tail: string;
  tidy: TidyState | null;
  /** Settled phrases held back while an input method is composing. */
  waiting: string[];
}

/** The part of an editor view that dictation uses. A real `EditorView` fits. */
export interface DictationView {
  composing: boolean;
  dispatch: (tr: Transaction) => void;
  isDestroyed?: boolean;
  readonly state: EditorState;
}

export const dictationKey = new PluginKey<DictationPluginState>(
  "sageDictation"
);

const idle: DictationPluginState = {
  active: false,
  anchor: 0,
  atEnd: false,
  pending: null,
  range: null,
  tail: "",
  tidy: null,
  waiting: [],
};

interface StateMeta {
  set: DictationPluginState;
}

export function dictationState(state: EditorState): DictationPluginState {
  return dictationKey.getState(state) ?? idle;
}

function withState(tr: Transaction, next: DictationPluginState): Transaction {
  return tr.setMeta(dictationKey, { set: next } satisfies StateMeta);
}

/** Where dictation puts words for a cursor: after the selection, in a line of text. */
export function cursorPosition(
  state: Pick<EditorState, "doc" | "selection">
): number {
  const { selection } = state;
  if (selection.$to.parent.inlineContent) {
    return selection.to;
  }
  return Selection.near(selection.$to, -1).to;
}

function inlinePosition(doc: ProseNode, pos: number): number {
  const clamped = Math.min(Math.max(pos, 0), doc.content.size);
  const $pos = doc.resolve(clamped);
  return $pos.parent.inlineContent ? clamped : Selection.near($pos, -1).to;
}

interface Spot {
  pos: number;
  /** The words need a new paragraph of their own at `pos`. */
  wrap: boolean;
}

function spotFor(doc: ProseNode, ps: DictationPluginState): Spot {
  if (!ps.atEnd) {
    return { pos: inlinePosition(doc, ps.anchor), wrap: false };
  }
  const last = doc.lastChild;
  if (
    last !== null &&
    last.type.name === "paragraph" &&
    last.content.size === 0
  ) {
    return { pos: doc.content.size - 1, wrap: false };
  }
  return { pos: doc.content.size, wrap: true };
}

function around(doc: ProseNode, spot: Spot): { after: string; before: string } {
  if (spot.wrap) {
    return { after: "", before: "" };
  }
  const $pos = doc.resolve(spot.pos);
  return {
    after: doc.textBetween(
      spot.pos,
      Math.min($pos.end(), spot.pos + 2),
      "",
      "\n"
    ),
    before: doc.textBetween(
      Math.max($pos.start(), spot.pos - 2),
      spot.pos,
      "",
      "\n"
    ),
  };
}

// A cursor that moved while nothing was grey has no phrase to wait for.
function settled(next: DictationPluginState): DictationPluginState {
  if (next.active && next.tail === "" && next.pending !== null) {
    return { ...next, anchor: next.pending, atEnd: false, pending: null };
  }
  return next;
}

function stepTouches(map: StepMap, from: number, to: number): boolean {
  let touched = false;
  map.forEach((oldStart, oldEnd) => {
    const inside =
      oldStart === oldEnd
        ? oldStart > from && oldStart < to
        : oldStart < to && oldEnd > from;
    touched = touched || inside;
  });
  return touched;
}

/**
 * Whether an edit touched the inside of a range, and where the range is after
 * it. Typing at either end is outside, so it does not count.
 */
function followRange(
  tr: Transaction,
  range: { from: number; to: number }
): { from: number; to: number; touched: boolean } {
  let { from, to } = range;
  let touched = false;
  for (const map of tr.mapping.maps) {
    touched = touched || stepTouches(map, from, to);
    from = map.map(from, 1);
    to = map.map(to, -1);
  }
  return { from, to, touched };
}

function followTidy(tidy: TidyState | null, tr: Transaction): TidyState | null {
  if (tidy === null || tidy.kind === "review") {
    // Typing counts as Keep.
    return null;
  }
  const next = followRange(tr, tidy);
  return {
    ...tidy,
    edited: tidy.edited || next.touched,
    from: next.from,
    to: Math.max(next.from, next.to),
  };
}

function afterEdit(
  value: DictationPluginState,
  tr: Transaction
): DictationPluginState {
  if (value === idle) {
    return value;
  }
  return {
    ...value,
    anchor: tr.mapping.map(value.anchor, 1),
    pending: value.pending === null ? null : tr.mapping.map(value.pending, 1),
    // Any edit by the person ends the dictated stretch, undo included.
    range: null,
    tidy: followTidy(value.tidy, tr),
  };
}

function afterCursorMove(
  value: DictationPluginState,
  state: EditorState
): DictationPluginState {
  if (!value.active) {
    return value;
  }
  const cursor = cursorPosition(state);
  if (value.tail === "" && value.waiting.length === 0) {
    return { ...value, anchor: cursor, atEnd: false, pending: null };
  }
  return { ...value, pending: cursor };
}

function tailElement(text: string, block: boolean): HTMLElement {
  const element = document.createElement(block ? "p" : "span");
  element.className = "text-muted-foreground";
  element.dataset.dictationTail = "";
  element.setAttribute("aria-hidden", "true");
  element.textContent = text;
  return element;
}

function tailDecorations(state: EditorState): DecorationSet | null {
  const ps = dictationKey.getState(state);
  if (ps === undefined || !ps.active || ps.tail.length === 0) {
    return null;
  }
  const spot = spotFor(state.doc, ps);
  const { after, before } = around(state.doc, spot);
  const text = joinPhrase(before, ps.tail, after);
  if (text.length === 0) {
    return null;
  }
  return DecorationSet.create(state.doc, [
    Decoration.widget(spot.pos, () => tailElement(text, spot.wrap), {
      key: `${spot.wrap ? "block" : "inline"}:${text}`,
      side: 1,
    }),
  ]);
}

function createDictationPlugin(): Plugin<DictationPluginState> {
  return new Plugin<DictationPluginState>({
    key: dictationKey,
    props: {
      decorations: tailDecorations,
    },
    state: {
      apply(tr, value, _oldState, newState) {
        const meta = tr.getMeta(dictationKey) as StateMeta | undefined;
        if (meta !== undefined) {
          return meta.set;
        }
        if (tr.docChanged) {
          return afterEdit(value, tr);
        }
        if (tr.selectionSet) {
          return afterCursorMove(value, newState);
        }
        return value;
      },
      init: () => idle,
    },
  });
}

/**
 * Dictation for the entry editor. It adds the plugin that holds the anchor and
 * draws the grey words. The functions below drive it.
 */
export const Dictation = Extension.create({
  addProseMirrorPlugins() {
    return [createDictationPlugin()];
  },
  name: "dictation",
});

/**
 * Starts feeding this editor. `atEnd` puts the words at the end of the body,
 * for a person who has not been in the body. Otherwise they go at the cursor.
 * A Tidy that is waiting for its answer keeps waiting. A result the person
 * has not kept or undone counts as kept.
 */
export function startEditorDictation(
  view: DictationView,
  { atEnd }: { atEnd: boolean }
) {
  const { state } = view;
  const ps = dictationState(state);
  const tidy = ps.tidy?.kind === "working" ? ps.tidy : null;
  view.dispatch(
    withState(state.tr, {
      ...idle,
      active: true,
      anchor: cursorPosition(state),
      atEnd,
      tidy,
    })
  );
}

/**
 * Takes one message from the core: `final` is words that settled, `volatile`
 * is the whole grey tail now.
 */
export function pushEditorDictation(
  view: DictationView,
  final: string,
  volatile: string
) {
  const ps = dictationState(view.state);
  if (!ps.active) {
    return;
  }
  const phrases = final.trim().length > 0 ? [...ps.waiting, final] : ps.waiting;
  if (phrases.length > 0 && view.composing) {
    // An input method is composing here. Text put in now would break it, so the
    // settled words wait, and the grey tail keeps showing.
    view.dispatch(
      withState(view.state.tr, { ...ps, tail: volatile, waiting: phrases })
    );
    retryWhenIdle(view);
    return;
  }
  land(view, phrases, volatile, false);
}

/**
 * Ends the session. Words that are still grey or waiting go in as final text,
 * so nothing the person heard is lost. The dictated stretch stays for Tidy.
 */
export function settleEditorDictation(view: DictationView) {
  const ps = dictationState(view.state);
  if (!ps.active) {
    return;
  }
  const phrases = [
    ...ps.waiting,
    ...(ps.tail.trim().length > 0 ? [ps.tail] : []),
  ];
  land(view, phrases, "", true);
}

/** Forgets everything: the session, the dictated stretch, and any Tidy. */
export function resetEditorDictation(view: DictationView) {
  if (dictationState(view.state) === idle) {
    return;
  }
  view.dispatch(withState(view.state.tr, idle));
}

const retryMs = 50;
const retries = new WeakMap<object, ReturnType<typeof setTimeout>>();

function retryWhenIdle(view: DictationView) {
  if (retries.has(view)) {
    return;
  }
  retries.set(
    view,
    setTimeout(() => {
      retries.delete(view);
      if (view.isDestroyed === true) {
        return;
      }
      const ps = dictationState(view.state);
      if (!ps.active || ps.waiting.length === 0) {
        return;
      }
      if (view.composing) {
        retryWhenIdle(view);
        return;
      }
      land(view, ps.waiting, ps.tail, false);
    }, retryMs)
  );
}

/**
 * Puts settled phrases into the document at the anchor, as plain text, and
 * sets the grey tail. With `finish`, it ends the session too.
 */
function land(
  view: DictationView,
  phrases: string[],
  tail: string,
  finish: boolean
) {
  const { state } = view;
  const ps = dictationState(state);
  const spot = spotFor(state.doc, ps);
  const { after, before } = around(state.doc, spot);
  const piece = joinPhrase(before, phrases.join(" "), after);
  const base: DictationPluginState = {
    ...ps,
    active: !finish && ps.active,
    pending: finish ? null : ps.pending,
    tail: finish ? "" : tail,
    waiting: [],
  };
  if (piece.length === 0) {
    view.dispatch(withState(state.tr, settled(base)));
    return;
  }

  const { tr } = state;
  let from: number;
  let to: number;
  let end: number;
  if (spot.wrap) {
    tr.insert(
      spot.pos,
      state.schema.nodes.paragraph.create(null, state.schema.text(piece))
    );
    from = spot.pos + 1;
    to = from + piece.length;
    end = to;
  } else {
    tr.insert(spot.pos, state.schema.text(piece));
    from = spot.pos + piece.length - piece.trimStart().length;
    to = spot.pos + piece.trimEnd().length;
    end = spot.pos + piece.length;
  }

  // The stretch grows when these words follow it directly, and starts over
  // when they land somewhere else.
  const previous = ps.range;
  const joined =
    previous !== null &&
    !spot.wrap &&
    previous.to <= spot.pos &&
    state.doc.textBetween(previous.to, spot.pos).trim() === "";
  const range = joined ? { from: previous.from, to } : { from, to };

  const cursorMoved = ps.pending !== null;
  const cursorAtSpot =
    state.selection.empty && state.selection.from === spot.pos;
  const anchor = cursorMoved ? tr.mapping.map(ps.pending ?? 0, 1) : end;
  if (!cursorMoved && ps.atEnd) {
    // The words went to the end of the body while the cursor was elsewhere, or
    // in the title. Put the body's cursor after them.
    tr.setSelection(TextSelection.create(tr.doc, end));
  }
  if (!cursorMoved && (ps.atEnd || cursorAtSpot)) {
    tr.scrollIntoView();
  }

  withState(
    tr,
    settled({
      ...base,
      anchor,
      atEnd: false,
      pending: null,
      range,
      tidy: followTidy(ps.tidy, tr),
    })
  );
  view.dispatch(tr);
}

// --- Tidy ---

/**
 * True when every line in the range is a plain paragraph of unmarked text.
 * Tidy swaps the range for new paragraphs, which would lose anything else.
 */
export function isPlainRange(
  doc: ProseNode,
  from: number,
  to: number
): boolean {
  if (!(from >= 0 && to > from && to <= doc.content.size)) {
    return false;
  }
  let plain = true;
  let hasText = false;
  doc.nodesBetween(from, to, (node, _pos, parent) => {
    if (!plain) {
      return false;
    }
    if (node.isText) {
      plain = node.marks.length === 0;
      hasText = hasText || (node.text ?? "").trim().length > 0;
      return false;
    }
    if (node.type.name === "paragraph" && parent?.type.name === "doc") {
      return true;
    }
    plain = false;
    return false;
  });
  return plain && hasText;
}

export interface TidyRequest {
  id: number;
  /** The text to send, with a blank line between paragraphs. */
  text: string;
}

/**
 * Shrinks a range past the spaces and line breaks at both ends, as the
 * dictated stretch is. Tidy's reply has none, so leaving them in the range
 * would join the words around it. Null when the range has no words.
 */
function trimmedRange(
  doc: ProseNode,
  from: number,
  to: number
): DictatedRange | null {
  let first = -1;
  let last = -1;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) {
      return true;
    }
    const start = Math.max(from, pos) - pos;
    const end = Math.min(to, pos + node.nodeSize) - pos;
    const piece = (node.text ?? "").slice(start, end);
    const trimmed = piece.trim();
    if (trimmed.length > 0) {
      if (first < 0) {
        first = pos + start + piece.indexOf(trimmed);
      }
      last = pos + start + piece.trimEnd().length;
    }
    return false;
  });
  return first < 0 ? null : { from: first, to: last };
}

let lastTidyId = 0;

/**
 * Marks a range as being tidied and returns its text. Null when the range is
 * not plain paragraphs, when dictation is on, or when a Tidy is already open.
 */
export function beginTidy(
  view: DictationView,
  range: DictatedRange
): TidyRequest | null {
  const { state } = view;
  const ps = dictationState(state);
  if (ps.active || ps.tidy !== null) {
    return null;
  }
  const trimmed = trimmedRange(state.doc, range.from, range.to);
  if (trimmed === null || !isPlainRange(state.doc, trimmed.from, trimmed.to)) {
    return null;
  }
  const text = state.doc.textBetween(trimmed.from, trimmed.to, "\n\n");
  lastTidyId += 1;
  view.dispatch(
    withState(state.tr, {
      ...ps,
      tidy: {
        edited: false,
        from: trimmed.from,
        id: lastTidyId,
        kind: "working",
        original: state.doc.slice(trimmed.from, trimmed.to),
        to: trimmed.to,
      },
    })
  );
  return { id: lastTidyId, text };
}

/**
 * `applied` swapped the range for the reply. `edited` means the person changed
 * the range meanwhile, so nothing changed. `gone` means this Tidy is no longer
 * open, as after a new entry loaded. `unusable` means the reply had no words.
 */
export type TidyOutcome = "applied" | "edited" | "gone" | "unusable";

/** Closes the undo group, so the next change is a step of its own. */
function closeUndoGroup(view: DictationView) {
  view.dispatch(closeHistory(view.state.tr));
}

function paragraphSlice(state: EditorState, paragraphs: string[]): Slice {
  const { paragraph } = state.schema.nodes;
  return new Slice(
    Fragment.from(
      paragraphs.map((text) => paragraph.create(null, state.schema.text(text)))
    ),
    1,
    1
  );
}

/**
 * Swaps the range for the model's reply, as paragraphs and as one undo step.
 * The original stays in the plugin for Undo.
 */
export function finishTidy(
  view: DictationView,
  id: number,
  reply: string
): TidyOutcome {
  const { state } = view;
  const ps = dictationState(state);
  const { tidy } = ps;
  if (tidy === null || tidy.kind !== "working" || tidy.id !== id) {
    return "gone";
  }
  const paragraphs = tidyParagraphs(reply);
  // Typing and deleting are caught as they happen. A mark or a heading moves no
  // text, so compare the range with what Tidy sent.
  const edited =
    tidy.edited ||
    !state.doc.slice(tidy.from, tidy.to).content.eq(tidy.original.content) ||
    !isPlainRange(state.doc, tidy.from, tidy.to);
  if (edited || paragraphs.length === 0) {
    view.dispatch(withState(state.tr, { ...ps, tidy: null }));
    return edited ? "edited" : "unusable";
  }
  const tr = closeHistory(state.tr).replace(
    tidy.from,
    tidy.to,
    paragraphSlice(state, paragraphs)
  );
  withState(tr, {
    ...ps,
    range: null,
    tidy: {
      from: tr.mapping.map(tidy.from, -1),
      kind: "review",
      original: tidy.original,
      to: tr.mapping.map(tidy.to, 1),
    },
  });
  view.dispatch(tr);
  closeUndoGroup(view);
  return "applied";
}

/** Drops a Tidy that failed. The dictated stretch stays, so the person can try again. */
export function cancelTidy(view: DictationView, id: number) {
  const ps = dictationState(view.state);
  if (ps.tidy?.kind === "working" && ps.tidy.id === id) {
    view.dispatch(withState(view.state.tr, { ...ps, tidy: null }));
  }
}

/** Keeps the tidied text. */
export function keepTidy(view: DictationView) {
  const ps = dictationState(view.state);
  if (ps.tidy?.kind === "review") {
    view.dispatch(withState(view.state.tr, { ...ps, tidy: null }));
  }
}

/** Puts back the words as they were before Tidy, as one undo step. */
export function undoTidy(view: DictationView): boolean {
  const { state } = view;
  const ps = dictationState(state);
  const { tidy } = ps;
  if (tidy?.kind !== "review") {
    return false;
  }
  const tr = closeHistory(state.tr).replace(tidy.from, tidy.to, tidy.original);
  withState(tr, { ...ps, range: null, tidy: null });
  view.dispatch(tr);
  closeUndoGroup(view);
  return true;
}

// --- What the interface shows ---

export type TidyPhase = "idle" | "review" | "working";

export interface DictationEditorView {
  active: boolean;
  /** The stretch just dictated can be tidied. */
  canTidyDictated: boolean;
  /** The selection can be tidied. */
  canTidySelection: boolean;
  /** The selection is text, but not plain paragraphs. */
  selectionNeedsPlain: boolean;
  tidy: TidyPhase;
}

export function readDictationView(state: EditorState): DictationEditorView {
  const ps = dictationState(state);
  const busy = ps.active || ps.tidy !== null;
  const { empty, from, to } = state.selection;
  const plainSelection = !empty && isPlainRange(state.doc, from, to);
  return {
    active: ps.active,
    canTidyDictated:
      !busy &&
      ps.range !== null &&
      isPlainRange(state.doc, ps.range.from, ps.range.to),
    canTidySelection: !busy && plainSelection,
    selectionNeedsPlain: !(empty || plainSelection),
    tidy: ps.tidy?.kind ?? "idle",
  };
}

export function sameDictationView(
  current: DictationEditorView,
  previous: DictationEditorView | null
): boolean {
  return (
    previous !== null &&
    current.active === previous.active &&
    current.canTidyDictated === previous.canTidyDictated &&
    current.canTidySelection === previous.canTidySelection &&
    current.selectionNeedsPlain === previous.selectionNeedsPlain &&
    current.tidy === previous.tidy
  );
}
