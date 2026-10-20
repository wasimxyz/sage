// Chat brings Markdown, code, math, and diagram rendering with it. None of
// that is needed until Chat first opens, so it loads on demand.
type ChatLayoutComponent = typeof import("@/components/chat-layout").ChatLayout;

// Set once the module has loaded, whether a hover, an open, or the first
// render started the load.
let loaded: ChatLayoutComponent | null = null;

export function loadChatLayout() {
  return import("@/components/chat-layout").then((module) => {
    loaded = module.ChatLayout;
    return module;
  });
}

/**
 * Starts the load and never rejects. A failed load shows when Chat opens, not
 * as an error from a hover or from the code that is about to open Chat.
 */
export function preloadChatLayout(): Promise<void> {
  return loadChatLayout().then(
    () => undefined,
    () => undefined
  );
}

/** The layout once its module has loaded, or null before that. */
export function loadedChatLayout(): ChatLayoutComponent | null {
  return loaded;
}
