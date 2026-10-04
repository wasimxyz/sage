import { LeafIcon } from "lucide-react";

import {
  ASSISTANT_PROSE_INSET,
  ASSISTANT_PROSE_SPACING,
} from "@/components/chat/transcript-column";
import { cn } from "@/lib/utils";

export function AssistantPending() {
  return (
    <div className="flex w-full justify-start" data-role="assistant">
      <div
        aria-label="Waiting for reply"
        className={cn(
          "flex min-h-5 items-center",
          ASSISTANT_PROSE_SPACING,
          ASSISTANT_PROSE_INSET
        )}
        data-assistant-pending=""
        role="status"
      >
        <span
          aria-hidden="true"
          className="inline-flex size-4 shrink-0 items-center justify-center motion-safe:[animation:assistant-pending-pulse_1.5s_ease-in-out_infinite]"
        >
          <LeafIcon className="size-4 text-muted-foreground" />
        </span>
      </div>
    </div>
  );
}
