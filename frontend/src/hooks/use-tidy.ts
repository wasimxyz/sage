import { useTiptap } from "@tiptap/react";
import { useCallback } from "react";
import { toast } from "sonner";

import { tidyText } from "@/bridge";
import { useOllama } from "@/components/ollama-provider";
import {
  beginTidy,
  cancelTidy,
  type DictatedRange,
  finishTidy,
} from "@/lib/dictation-plugin";
import { tidyEditedMessage, tidyFailure } from "@/lib/tidy-errors";

const tidyToastId = "tidy";

/**
 * Tidy for a range of the open entry. It sends the words to the local model,
 * and swaps them for the reply unless the person changed them meanwhile. The
 * result waits for Keep or Undo in the editor header.
 */
export function useTidy() {
  const { editor } = useTiptap();
  const {
    actions: { startOllama },
  } = useOllama();

  return useCallback(
    async (range: DictatedRange) => {
      if (editor.isDestroyed) {
        return;
      }
      const request = beginTidy(editor.view, range);
      if (request === null) {
        return;
      }
      try {
        const reply = await tidyText(request.text);
        if (editor.isDestroyed) {
          return;
        }
        const outcome = finishTidy(editor.view, request.id, reply);
        if (outcome === "edited") {
          toast(tidyEditedMessage, { id: tidyToastId });
        } else if (outcome === "unusable") {
          toast.error("Could not tidy the text.", { id: tidyToastId });
        }
      } catch (error) {
        if (editor.isDestroyed) {
          return;
        }
        cancelTidy(editor.view, request.id);
        const failure = tidyFailure(error);
        toast.error(failure.message, {
          action: failure.startLocalAi
            ? {
                label: "Start local AI",
                onClick: () => {
                  startOllama().catch(() => undefined);
                },
              }
            : undefined,
          id: tidyToastId,
        });
      }
    },
    [editor, startOllama]
  );
}
