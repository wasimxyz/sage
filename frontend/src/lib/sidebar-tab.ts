import type { Section } from "@/components/journal-context";

/** The two tabs at the top of the sidebar. */
export type SidebarTab = "chat" | "journal";

/** The screens that belong to the Chat tab. */
export type ChatTabSection = "chat" | "memories";

/** A row under the tabs, above the list. */
export type SidebarAction =
  | "import"
  | "memories"
  | "new-chat"
  | "new-entry"
  | "search";

const chatActions: readonly SidebarAction[] = ["new-chat", "search"];
const chatActionsWithMemories: readonly SidebarAction[] = [
  "new-chat",
  "search",
  "memories",
];
const journalActions: readonly SidebarAction[] = [
  "new-entry",
  "search",
  "import",
];

/** The tab a screen belongs to. Memories sits in the Chat tab. */
export function tabForSection(section: Section): SidebarTab {
  return section === "journal" ? "journal" : "chat";
}

/**
 * Where the Chat tab goes: back to the screen last open in it. Memories only
 * counts in a memory build.
 */
export function chatTabSection(
  last: ChatTabSection,
  memoryEnabled: boolean
): ChatTabSection {
  return last === "memories" && memoryEnabled ? "memories" : "chat";
}

/** The rows under the tabs. Memories shows only in a memory build. */
export function sidebarActions(
  tab: SidebarTab,
  memoryEnabled: boolean
): readonly SidebarAction[] {
  if (tab === "journal") {
    return journalActions;
  }
  return memoryEnabled ? chatActionsWithMemories : chatActions;
}
