import type { ReactNode } from "react";

import { onTitlebarPointerDown } from "@/components/app-titlebar";
import { cn } from "@/lib/utils";

// With the sidebar hidden, the header's left edge clears the traffic lights
// and the sidebar button. The padding follows the sidebar's slide: none
// extra while it is open, all of it once it is closed.
const leadingClass =
  "pl-[calc(1.5rem+(var(--titlebar-leading)+2.75rem)*(1-var(--sidebar-progress,1)))]";

/**
 * The title row of the main pane, level with the title bar. Its empty space
 * drags the window.
 */
export function PaneHeader({ children }: { children?: ReactNode }) {
  return (
    <div
      className={cn(
        "flex h-(--titlebar-height) shrink-0 items-center gap-2 pr-6",
        leadingClass
      )}
      data-slot="window-drag"
      onPointerDown={onTitlebarPointerDown}
    >
      {children}
    </div>
  );
}
