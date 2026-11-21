import { useTiptap, useTiptapState } from "@tiptap/react";
import { CheckIcon, MicIcon, SparklesIcon, Undo2Icon } from "lucide-react";
import { useCallback, useEffect } from "react";

import { useDictation } from "@/components/dictation-provider";
import { Hint } from "@/components/hint";
import { useEntryLoading } from "@/components/journal-context";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useTidy } from "@/hooks/use-tidy";
import {
  dictationState,
  keepTidy,
  readDictationView,
  sameDictationView,
  undoTidy,
} from "@/lib/dictation-plugin";
import type { DictationPhase } from "@/lib/dictation-session";
import { isInEditor, isStopKey } from "@/lib/dictation-shortcut";
import { hasOpenSurface } from "@/lib/open-surface";
import { shortcuts } from "@/lib/shortcuts";

/**
 * The mic and Tidy controls in the editor header: the mic button, then Tidy for
 * the words just dictated, then Keep and Undo for a result. The plugin holds
 * the state, and the editor does not redraw on every transaction, so this reads
 * it with `useTiptapState`.
 */
export function EditorDictation() {
  const { editor } = useTiptap();
  const view = useTiptapState(
    ({ editor: current }) => readDictationView(current.state),
    sameDictationView
  );
  const tidy = useTidy();

  const handleTidy = useCallback(() => {
    if (editor.isDestroyed) {
      return;
    }
    const { range } = dictationState(editor.state);
    if (range !== null) {
      tidy(range).catch(() => undefined);
    }
  }, [editor, tidy]);

  const handleKeep = useCallback(() => {
    if (!editor.isDestroyed) {
      keepTidy(editor.view);
    }
  }, [editor]);

  const handleUndo = useCallback(() => {
    if (!editor.isDestroyed) {
      undoTidy(editor.view);
    }
  }, [editor]);

  // Esc keeps a result, as typing does.
  const reviewing = view.tidy === "review";
  useEffect(() => {
    if (!reviewing) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (!isStopKey(event, isInEditor(event.target)) || hasOpenSurface()) {
        return;
      }
      event.preventDefault();
      handleKeep();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleKeep, reviewing]);

  return (
    <>
      <MicButton />
      {view.tidy === "idle" && view.canTidyDictated ? (
        <Button onClick={handleTidy} size="sm" variant="ghost">
          <SparklesIcon data-icon="inline-start" />
          Tidy
        </Button>
      ) : null}
      {view.tidy === "working" ? (
        <span
          className="text-muted-foreground flex items-center gap-1.5 px-2 text-sm"
          role="status"
        >
          <Spinner aria-hidden />
          Tidying…
        </span>
      ) : null}
      {reviewing ? (
        <>
          <Button onClick={handleKeep} size="sm" variant="ghost">
            <CheckIcon data-icon="inline-start" />
            Keep
          </Button>
          <Button onClick={handleUndo} size="sm" variant="ghost">
            <Undo2Icon data-icon="inline-start" />
            Undo
          </Button>
        </>
      ) : null}
    </>
  );
}

function MicButton() {
  const {
    actions: { toggle },
    state: { available, owner, phase },
  } = useDictation();
  const loading = useEntryLoading();
  const handleClick = useCallback(() => {
    toggle("entry").catch(() => undefined);
  }, [toggle]);
  if (!available) {
    return null;
  }
  // The other owner has the mic, so this one waits for it.
  const mine: DictationPhase = owner === "entry" ? phase : "idle";
  const busyElsewhere = owner !== null && owner !== "entry";
  const off = loading || busyElsewhere || mine === "finishing";

  if (mine === "idle") {
    return (
      <Hint label="Dictate" shortcut={shortcuts.dictate}>
        <Button
          aria-label="Dictate"
          aria-pressed={false}
          disabled={off}
          onClick={handleClick}
          size="icon-sm"
          variant="ghost"
        >
          <MicIcon />
        </Button>
      </Hint>
    );
  }
  return (
    <Hint
      label={mine === "finishing" ? "Finishing" : "Stop dictating"}
      shortcut={shortcuts.dictate}
    >
      <Button
        aria-label={mine === "finishing" ? undefined : "Stop dictating"}
        aria-pressed={mine === "listening"}
        disabled={off}
        onClick={handleClick}
        size="sm"
        variant={mine === "listening" ? "destructive" : "ghost"}
      >
        {mine === "listening" ? (
          <MicIcon
            className="motion-safe:animate-pulse"
            data-icon="inline-start"
          />
        ) : (
          <Spinner aria-hidden data-icon="inline-start" />
        )}
        {mine === "listening" ? "Listening" : null}
        {mine === "starting" ? "Starting…" : null}
        {mine === "finishing" ? "Finishing…" : null}
      </Button>
    </Hint>
  );
}
