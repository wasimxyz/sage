import { AlertCircleIcon } from "lucide-react";
import { Component, lazy, type ReactNode, Suspense, useState } from "react";

import {
  loadChatLayout,
  loadedChatLayout,
} from "@/components/chat-layout-loader";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";

const LazyChatLayout = lazy(() =>
  loadChatLayout().then((module) => ({ default: module.ChatLayout }))
);

/**
 * Opens Chat. A module that is already here, as after a hover on the Chat row,
 * renders at once. Going through Suspense would still hold its spinner for
 * about 300 ms. Only a cold open takes the lazy path. This is decided once per
 * mount, so a load that finishes later never swaps the element and remounts
 * Chat.
 */
export function ChatRoute() {
  const [Loaded] = useState(() => loadedChatLayout());
  return (
    <ChatFailureBoundary>
      {Loaded ? (
        <Loaded />
      ) : (
        <Suspense fallback={<ChatLoading />}>
          <LazyChatLayout />
        </Suspense>
      )}
    </ChatFailureBoundary>
  );
}

function ChatLoading() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background">
      <Spinner />
    </div>
  );
}

/**
 * Keeps a Chat that cannot load or draw from taking the rest of Sage with it.
 * A module that failed to load stays failed for the life of the page, so the
 * only way back is a reload.
 */
// biome-ignore lint/style/useReactFunctionComponents: only a class can catch an error thrown while rendering its children
class ChatFailureBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state: { failed: boolean } = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <ChatFailed />;
    }
    return this.props.children;
  }
}

function reloadSage() {
  window.location.reload();
}

function ChatFailed() {
  return (
    <Empty className="min-h-0 flex-1 bg-background">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AlertCircleIcon />
        </EmptyMedia>
        <EmptyTitle>Could not open Chat</EmptyTitle>
        <EmptyDescription>
          Sage could not load Chat. Reload to try again.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={reloadSage} size="sm" variant="outline">
          Reload
        </Button>
      </EmptyContent>
    </Empty>
  );
}
