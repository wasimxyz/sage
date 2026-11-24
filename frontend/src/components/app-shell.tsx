import { type CSSProperties, useEffect, useState } from "react";

import { onOpenSettings } from "@/bridge";
import { AppSidebar } from "@/components/app-sidebar";
import { AppTitlebar } from "@/components/app-titlebar";
import { RenameChatProvider } from "@/components/chat/rename-chat-dialog";
import { useChat } from "@/components/chat-provider";
import { ChatRoute } from "@/components/chat-route";
import {
  DreamConfirmDialog,
  DreamStartAnnouncement,
} from "@/components/dream-nav";
import EditorPane from "@/components/editor";
import {
  type Section,
  useJournalActions,
  useJournalView,
} from "@/components/journal-context";
import { MemoriesScreen } from "@/components/memories-screen";
import { useMemoryFeature } from "@/components/memory-feature-provider";
import { ProtectReminder } from "@/components/protect-reminder";
import { ScreenActiveProvider } from "@/components/screen-active";
import { SearchDialog, SearchProvider } from "@/components/search-dialog";
import { SettingsScreen } from "@/components/settings-screen";
import { SidebarInset } from "@/components/ui/sidebar";
import { useDictationShortcut } from "@/hooks/use-dictation-shortcut";
import { useNewShortcut } from "@/hooks/use-new-shortcut";
import { useRouteSync } from "@/hooks/use-route-sync";
import { useWindowFullscreen } from "@/hooks/use-window-fullscreen";
import { cn } from "@/lib/utils";

/**
 * Two columns: the sidebar, with its Chat and Journal tabs, and the pane
 * that shows the open chat, entry, Memories, or Settings.
 */
export function AppShell() {
  const fullscreen = useWindowFullscreen();
  const [routeApplied, setRouteApplied] = useState(false);
  useNewShortcut();
  useDictationShortcut();
  return (
    <SearchProvider>
      {/* The chat rows in the sidebar and the open chat's ⋯ menu share one
          rename dialog. */}
      <RenameChatProvider>
        <div
          className="relative flex min-h-0 min-w-0 flex-1 flex-col"
          style={
            {
              // 4.75rem clears the traffic lights inset 1rem. In fullscreen the
              // toggle icon lines up with the sidebar icons, which sit 1rem in:
              // 0.125rem + 0.5rem padding + 0.375rem inside the 1.75rem button.
              "--titlebar-leading": fullscreen ? "0.125rem" : "4.75rem",
            } as CSSProperties
          }
        >
          <RouteSync onApplied={setRouteApplied} />
          <LaunchReminder routeApplied={routeApplied} />
          <SettingsMenuListener />
          <AppTitlebar />
          <DreamConfirmDialog />
          <DreamStartAnnouncement />
          <SearchDialog />
          <div className="flex min-h-0 min-w-0 flex-1">
            <AppSidebar />
            <SidebarInset className="min-h-0 overflow-hidden">
              <AppMain />
            </SidebarInset>
          </div>
        </div>
      </RenameChatProvider>
    </SearchProvider>
  );
}

// Its own component, so the many states route sync reads redraw only this.
function RouteSync({ onApplied }: { onApplied: (applied: boolean) => void }) {
  const applied = useRouteSync();
  useEffect(() => {
    onApplied(applied);
  }, [applied, onApplied]);
  return null;
}

/**
 * The protect reminder waits for the new chat Sage opens on. Chat mounts at
 * launch before the address is read, so it also waits for the route: a
 * launch that lands on an entry never shows it over the entry.
 */
function LaunchReminder({ routeApplied }: { routeApplied: boolean }) {
  const { section } = useJournalView();
  const {
    state: { listLoaded, selection },
  } = useChat();
  const onNewChat = section === "chat" && selection.kind === "new";
  return <ProtectReminder ready={routeApplied && listLoaded && onNewChat} />;
}

/** Sage > Settings opens the settings screen. */
function SettingsMenuListener() {
  const { showSettings } = useJournalActions();
  useEffect(
    () =>
      onOpenSettings(() => {
        showSettings().catch(() => undefined);
      }),
    [showSettings]
  );
  return null;
}

// One element for the life of the shell. A render of AppMain, such as for a
// change in the journal, then leaves the hidden chat alone.
const chatLayout = <ChatRoute />;

function AppMain() {
  const { section } = useJournalView();
  const onChat = section === "chat";
  // Chat mounts the first time it opens and then stays, out of sight while
  // another screen shows. The transcript, its scroll, and a reply that is
  // still coming in are as you left them when you come back. It is hidden,
  // not removed from the layout, so the scroll keeps measuring.
  const [chatMounted, setChatMounted] = useState(onChat);
  if (onChat && !chatMounted) {
    setChatMounted(true);
  }
  return (
    <>
      {chatMounted ? (
        <ScreenActiveProvider active={onChat}>
          <div
            aria-hidden={onChat ? undefined : true}
            className={cn(
              "absolute inset-0 flex min-h-0 min-w-0 flex-col",
              !onChat && "invisible"
            )}
            inert={!onChat}
          >
            {chatLayout}
          </div>
        </ScreenActiveProvider>
      ) : null}
      {onChat ? null : <OtherScreen section={section} />}
    </>
  );
}

/** Every screen but Chat. These unmount when you leave them. */
function OtherScreen({ section }: { section: Section }) {
  const { memoryEnabled } = useMemoryFeature();
  if (section === "memories" && memoryEnabled) {
    return <MemoriesScreen />;
  }
  if (section === "settings") {
    return <SettingsScreen />;
  }
  return <EditorPane />;
}
