import { MicIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { useChatDraftActions } from "@/components/chat/chat-draft";
import {
  useDictation,
  useDictationTail,
} from "@/components/dictation-provider";
import { Hint } from "@/components/hint";
import { useOnScreenHide, useScreenActive } from "@/components/screen-active";
import { Spinner } from "@/components/ui/spinner";
import { shortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

const micClass =
  "text-muted-foreground hover:text-foreground hover:!bg-foreground/6";
const listeningClass =
  "bg-destructive/10 text-destructive hover:!bg-destructive/20 hover:text-destructive";

/**
 * The mic in the message box. Dictated words go to the end of the box, and the
 * person presses Send. Dictation ends when the pane changes, when Chat is no
 * longer on screen, and on Send. It also ends when the box turns off, for
 * words that settled until then stay.
 */
export function ChatDictateButton({ locked }: { locked: boolean }) {
  const { appendText } = useChatDraftActions();
  const {
    actions: { leave, registerSink, stop, toggle },
    state: { available, owner, phase },
  } = useDictation();
  const active = useScreenActive();
  const activeRef = useRef(active);
  const lockedRef = useRef(locked);
  // The grey words, so they can settle if the session ends without them.
  const tailRef = useRef("");

  useEffect(() => {
    activeRef.current = active;
    lockedRef.current = locked;
  }, [active, locked]);

  useEffect(
    () =>
      registerSink("chat", {
        onStopped: (reason) => {
          const rest = tailRef.current;
          tailRef.current = "";
          // Leaving drops the grey words with the pane. Anything else keeps
          // them, so a stop that came early loses nothing.
          if (reason !== "discarded" && rest.trim().length > 0) {
            appendText(rest);
          }
        },
        onText: (final, volatile) => {
          if (final.length > 0) {
            appendText(final);
          }
          tailRef.current = volatile;
        },
        prepare: () => {
          tailRef.current = "";
          return activeRef.current && !lockedRef.current;
        },
      }),
    [appendText, registerSink]
  );

  // Chat stays mounted while another screen shows. Dictation must not go on
  // into a box nobody can see.
  useOnScreenHide(() => {
    leave("chat");
  });

  // The box turned off, as when Dream starts. What settled stays in it.
  const mine = owner === "chat";
  const on = mine && (phase === "starting" || phase === "listening");
  useEffect(() => {
    if (locked && on) {
      stop();
    }
  }, [locked, on, stop]);

  const handleClick = useCallback(() => {
    toggle("chat").catch(() => undefined);
  }, [toggle]);

  if (!available) {
    return null;
  }
  const busyElsewhere = owner !== null && !mine;
  const finishing = mine && phase === "finishing";
  const label = on ? "Stop dictating" : "Dictate";

  return (
    <Hint label={label} shortcut={shortcuts.dictate}>
      <PromptInputButton
        aria-label={label}
        aria-pressed={mine && phase === "listening"}
        className={cn(
          micClass,
          mine && phase === "listening" && listeningClass
        )}
        disabled={(locked && !on) || busyElsewhere || finishing}
        onClick={handleClick}
        size="icon-sm"
      >
        {mine && (phase === "starting" || finishing) ? (
          <Spinner aria-hidden />
        ) : (
          <MicIcon
            className={cn(
              mine && phase === "listening" && "motion-safe:animate-pulse"
            )}
          />
        )}
      </PromptInputButton>
    </Hint>
  );
}

/**
 * The grey words under the message box: what the person just said that has
 * not settled. They are not in the box, so Send never carries them.
 */
export function ChatDictationTail() {
  const tail = useDictationTail();
  const {
    state: { owner },
  } = useDictation();
  if (owner !== "chat" || tail.length === 0) {
    return null;
  }
  return (
    <p
      aria-hidden="true"
      className="text-muted-foreground line-clamp-2 w-full px-5 pb-2 text-sm"
      data-slot="chat-dictation-tail"
    >
      {tail}
    </p>
  );
}
