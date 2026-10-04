import { ThemeProvider } from "next-themes";

import { AppShell } from "@/components/app-shell";
import { ChatProvider } from "@/components/chat-provider";
import { DreamProvider } from "@/components/dream-provider";
import { FileMenuProvider } from "@/components/file-menu-provider";
import { useJournal } from "@/components/journal-context";
import { JournalProvider } from "@/components/journal-provider";
import { LockProvider } from "@/components/lock-provider";
import { MemoriesProvider } from "@/components/memories-provider";
import { MemoryFeatureProvider } from "@/components/memory-feature-provider";
import { SettingsProvider } from "@/components/settings-provider";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTextSizeShortcuts } from "@/hooks/use-text-size-shortcuts";

export default function App() {
  useTextSizeShortcuts();
  // Keep color-scheme off the root so WebKit does not fill the page after reload.
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableColorScheme={false}
      enableSystem
    >
      <TooltipProvider>
        <SidebarProvider className="flex h-svh flex-col overflow-hidden">
          <LockProvider>
            <MemoryFeatureProvider>
              <DreamProvider>
                <SettingsProvider>
                  <JournalProvider>
                    <FileMenuProvider>
                      <ChatProvider>
                        <MemoriesProvider>
                          <AppShell />
                          <AppToaster />
                        </MemoriesProvider>
                      </ChatProvider>
                    </FileMenuProvider>
                  </JournalProvider>
                </SettingsProvider>
              </DreamProvider>
            </MemoryFeatureProvider>
          </LockProvider>
        </SidebarProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

function AppToaster() {
  const {
    state: { section },
  } = useJournal();
  const onChat = section === "chat";
  return (
    <Toaster
      offset={
        onChat ? { top: "calc(var(--titlebar-height) + 1rem)" } : undefined
      }
      position={onChat ? "top-right" : "bottom-right"}
    />
  );
}
