import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useRef } from "react";

import { useDictationActions } from "@/components/dictation-provider";
import { useEntryActions, useEntryLoading } from "@/components/journal-context";
import {
  pushEditorDictation,
  resetEditorDictation,
  settleEditorDictation,
  startEditorDictation,
} from "@/lib/dictation-plugin";

type FocusedIn = "body" | "title" | null;

/**
 * Connects the entry editor to dictation: it is where the owner "entry" types
 * words, and it settles the grey words before the entry is left.
 *
 * Words go where the cursor is, once the person has been in the body. With the
 * title focused, or before they have been in the body, they go at the end of
 * the body instead, so a first ⌘D never lands at the top of an old entry.
 *
 * Returns `abort`, for an editor that is about to show another entry. It drops
 * the session without keeping its grey words.
 */
export function useEntryDictation(editor: Editor | null) {
  const { registerBeforeLeave } = useEntryActions();
  const { leave, registerSink } = useDictationActions();
  const loading = useEntryLoading();
  const loadingRef = useRef(loading);
  const focusedRef = useRef<FocusedIn>(null);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  // Whichever of the title and the body had focus last.
  useEffect(() => {
    function onFocusIn(event: FocusEvent) {
      const { target } = event;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.id === "entry-title") {
        focusedRef.current = "title";
      } else if (target.closest(".tiptap") !== null) {
        focusedRef.current = "body";
      }
    }
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    return registerSink("entry", {
      onStopped: () => {
        if (!editor.isDestroyed) {
          settleEditorDictation(editor.view);
        }
      },
      onText: (final, volatile) => {
        if (!editor.isDestroyed) {
          pushEditorDictation(editor.view, final, volatile);
        }
      },
      prepare: () => {
        if (editor.isDestroyed || loadingRef.current) {
          return false;
        }
        startEditorDictation(editor.view, {
          atEnd: focusedRef.current !== "body",
        });
        return true;
      },
    });
  }, [editor, registerSink]);

  // Leaving the entry: put in the grey words, then end the session, all before
  // the save that goes with leaving.
  useEffect(
    () => registerBeforeLeave(() => leave("entry")),
    [leave, registerBeforeLeave]
  );

  return useCallback(() => {
    focusedRef.current = null;
    if (editor && !editor.isDestroyed) {
      // Reset first, so ending the session has no grey words to keep.
      resetEditorDictation(editor.view);
    }
    leave("entry");
  }, [editor, leave]);
}
