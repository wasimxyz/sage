import { AlertCircleIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { useChat } from "@/components/chat-provider";
import {
  OllamaNotice,
  OllamaNoticeCopy,
  OllamaNoticeIcon,
  OllamaStartNotice,
} from "@/components/ollama-notice";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function ChatErrorAlert() {
  const {
    actions: { clearError },
    state: { error },
  } = useChat();
  if (error === null) {
    return null;
  }
  return (
    <Alert variant="destructive">
      <AlertCircleIcon />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
      <AlertAction>
        <Button
          aria-label="Dismiss"
          onClick={clearError}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  );
}

export function ChatAgentAlert() {
  const {
    state: { agent },
  } = useChat();
  if (agent.kind !== "down") {
    return null;
  }
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>Chat agent isn't running</AlertTitle>
      <AlertDescription>
        {import.meta.env.DEV ? (
          <>
            Start it with{" "}
            <code className="font-mono text-current">
              npm --prefix agent run dev
            </code>
            {"."}
          </>
        ) : (
          agent.message
        )}
      </AlertDescription>
    </Alert>
  );
}

function OllamaEmptyNotice() {
  return (
    <OllamaNotice>
      <OllamaNoticeIcon>
        <TriangleAlertIcon aria-hidden />
      </OllamaNoticeIcon>
      <OllamaNoticeCopy
        description={
          <>
            Pull a model with{" "}
            <code className="font-mono text-current">
              ollama pull qwen3.5:9b
            </code>
            .
          </>
        }
        title="No chat models"
      />
    </OllamaNotice>
  );
}

export function ChatOllamaAlert() {
  const {
    actions: { startOllama },
    state: { models, ollamaStart },
  } = useChat();
  if (models.kind === "down") {
    return <OllamaStartNotice onStart={startOllama} start={ollamaStart} />;
  }
  if (models.kind === "empty") {
    return <OllamaEmptyNotice />;
  }
  return null;
}
