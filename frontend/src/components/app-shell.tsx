import {
  ChevronRightIcon,
  HouseIcon,
  MessageCircleIcon,
  NotebookTextIcon,
  RotateCcwClockIcon,
  SettingsIcon,
} from "lucide-react";
import { type CSSProperties, useEffect } from "react";

import { onOpenSettings } from "@/bridge";
import { AppTitlebar, onTitlebarPointerDown } from "@/components/app-titlebar";
import { ConversationsMenu } from "@/components/chat/conversations-menu";
import { ChatScreen } from "@/components/chat-screen";
import { DreamConfirmDialog, DreamNav } from "@/components/dream-nav";
import { HomeScreen } from "@/components/home-screen";
import {
  type SidebarMenu as SidebarMenuName,
  useJournal,
} from "@/components/journal-context";
import { JournalLayout } from "@/components/journal-layout";
import { MemoriesScreen } from "@/components/memories-screen";
import { useMemoryFeature } from "@/components/memory-feature-provider";
import { SearchDialog, SearchProvider } from "@/components/search-dialog";
import { SettingsMenu } from "@/components/settings-menu";
import { SettingsScreen } from "@/components/settings-screen";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useRouteSync } from "@/hooks/use-route-sync";
import { useWindowFullscreen } from "@/hooks/use-window-fullscreen";

export function AppShell() {
  const fullscreen = useWindowFullscreen();
  const {
    state: { section },
  } = useJournal();
  return (
    <SearchProvider>
      <div
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={
          {
            // 5.375rem clears the traffic lights inset 1rem. In fullscreen the
            // toggle icon lines up with the sidebar icons, which sit 1rem in:
            // 0.125rem + 0.5rem padding + 0.375rem inside the 1.75rem button.
            "--titlebar-leading": fullscreen ? "0.125rem" : "5.375rem",
          } as CSSProperties
        }
      >
        <RouteSync />
        <SettingsMenuListener />
        <AppTitlebar />
        <DreamConfirmDialog />
        <SearchDialog />
        <div className="flex min-h-0 min-w-0 flex-1">
          <AppSidebar />
          <SidebarInset className="min-h-0 overflow-hidden">
            {section === "chat" ? (
              <div
                className="h-(--titlebar-height) shrink-0"
                data-slot="window-drag"
                onPointerDown={onTitlebarPointerDown}
              />
            ) : null}
            <AppMain />
          </SidebarInset>
        </div>
      </div>
    </SearchProvider>
  );
}

function RouteSync() {
  useRouteSync();
  return null;
}

/** Sage > Settings opens the settings screen. */
function SettingsMenuListener() {
  const {
    actions: { showSettings },
  } = useJournal();
  useEffect(
    () =>
      onOpenSettings(() => {
        showSettings().catch(() => undefined);
      }),
    [showSettings]
  );
  return null;
}

function AppSidebar() {
  const {
    state: { sidebarMenu },
  } = useJournal();
  return (
    <Sidebar
      className="md:[&_[data-slot=sidebar-inner]]:pt-[calc(var(--titlebar-height)-0.5rem)]"
      collapsible="offcanvas"
    >
      <SidebarContent>
        <SidebarBody menu={sidebarMenu} />
      </SidebarContent>
      {sidebarMenu === "nav" ? <SettingsNav /> : null}
    </Sidebar>
  );
}

function SidebarBody({ menu }: { menu: SidebarMenuName }) {
  if (menu === "conversations") {
    return <ConversationsMenu />;
  }
  if (menu === "settings") {
    return <SettingsMenu />;
  }
  return <NavMenu />;
}

function NavMenu() {
  const {
    actions: { showChat, showHome, showJournal, showMemories },
    state: { section },
  } = useJournal();
  const { memoryEnabled } = useMemoryFeature();
  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={section === "home"}
                onClick={showHome}
                tooltip="Home"
              >
                <HouseIcon />
                <span>Home</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={section === "journal"}
                onClick={showJournal}
                tooltip="Journal"
              >
                <NotebookTextIcon />
                <span>Journal</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={section === "chat"}
                onClick={showChat}
                tooltip="Chat"
              >
                <MessageCircleIcon />
                <span>Chat</span>
                <ChevronRightIcon className="ml-auto" />
              </SidebarMenuButton>
            </SidebarMenuItem>
            {memoryEnabled ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={section === "memories"}
                  onClick={showMemories}
                  tooltip="Memories"
                >
                  <RotateCcwClockIcon />
                  <span>Memories</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <DreamNav />
    </>
  );
}

function SettingsNav() {
  const {
    actions: { showSettings },
  } = useJournal();
  return (
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            className="mb-0.5"
            onClick={showSettings}
            tooltip="Settings"
          >
            <SettingsIcon />
            <span>Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

function AppMain() {
  const {
    state: { section },
  } = useJournal();
  const { memoryEnabled } = useMemoryFeature();
  if (section === "home") {
    return <HomeScreen />;
  }
  if (section === "chat") {
    return <ChatScreen />;
  }
  if (section === "memories" && memoryEnabled) {
    return <MemoriesScreen />;
  }
  if (section === "settings") {
    return <SettingsScreen />;
  }
  return <JournalLayout />;
}
