import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useMemo,
  useState,
} from "react";

import { useChat } from "@/components/chat-provider";

interface ChatDraftState {
  text: string;
}

interface ChatDraftActions {
  setText: (text: string) => void;
}

interface ChatDraftContextValue {
  actions: ChatDraftActions;
  meta: Record<string, never>;
  state: ChatDraftState;
}

const emptyMeta = {};

const ChatDraftContext = createContext<ChatDraftContextValue | null>(null);

export function useChatDraft(): ChatDraftContextValue {
  const value = use(ChatDraftContext);
  if (!value) {
    throw new Error("ChatDraftProvider is missing.");
  }
  return value;
}

/**
 * Holds the text in the message box. The box in a loading or failed pane and
 * the box in a live one read the same draft. A new chat or an opened chat
 * starts with an empty box, because the draft belongs to the pane it was
 * typed in.
 */
export function ChatDraftProvider({ children }: { children: ReactNode }) {
  const {
    state: { paneKey },
  } = useChat();
  const [draft, setDraft] = useState({ paneKey, text: "" });
  const text = draft.paneKey === paneKey ? draft.text : "";
  const setText = useCallback(
    (next: string) => {
      setDraft({ paneKey, text: next });
    },
    [paneKey]
  );
  const actions = useMemo<ChatDraftActions>(() => ({ setText }), [setText]);
  const value = useMemo<ChatDraftContextValue>(
    () => ({
      actions,
      meta: emptyMeta,
      state: { text },
    }),
    [actions, text]
  );
  return <ChatDraftContext value={value}>{children}</ChatDraftContext>;
}
