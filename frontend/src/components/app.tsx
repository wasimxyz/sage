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
import { ModelDownloadsProvider } from "@/components/model-downloads-provider";
import {
  OnboardingProvider,
  useOnboarding,
} from "@/components/onboarding-provider";
import { SettingsProvider } from "@/components/settings-provider";
import { SetupFlow } from "@/components/setup/setup-flow";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
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
            <ModelDownloadsProvider>
              <MemoryFeatureProvider>
                <DreamProvider>
                  <SettingsProvider>
                    <JournalProvider>
                      <FileMenuProvider>
                        <ChatProvider>
                          <MemoriesProvider>
                            <OnboardingProvider>
                              <OnboardingGate />
                              <AppToaster />
                            </OnboardingProvider>
                          </MemoriesProvider>
                        </ChatProvider>
                      </FileMenuProvider>
                    </JournalProvider>
                  </SettingsProvider>
                </DreamProvider>
              </MemoryFeatureProvider>
            </ModelDownloadsProvider>
          </LockProvider>
        </SidebarProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

/**
 * First launch shows setup in place of the app, with no sidebar. Everyone else
 * lands in the app. The providers above stay mounted either way, so a model
 * download that setup started keeps going after setup ends.
 */
function OnboardingGate() {
  const {
    state: { mode },
  } = useOnboarding();
  if (mode.kind === "loading") {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background">
        <Spinner />
      </div>
    );
  }
  if (mode.kind === "setup" || mode.kind === "protect") {
    return <SetupFlow />;
  }
  return <AppShell />;
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
