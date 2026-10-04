import { createContext, type ReactNode, use, useMemo, useState } from "react";

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

export function ChatDraftProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const actions = useMemo<ChatDraftActions>(() => ({ setText }), []);
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
