import type { ReactNode } from "react";

import { onTitlebarPointerDown } from "@/components/app-titlebar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { pageColumnClass } from "@/lib/page-column";
import { cn } from "@/lib/utils";

/**
 * One settings pane. The title row is as tall as a sidebar menu button and
 * starts at the same offset, so the title sits level with Back. It scrolls
 * with the page. The strip above it stays put, so the window still drags there.
 */
export function SettingsSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="h-(--titlebar-height) shrink-0"
        data-slot="window-drag"
        onPointerDown={onTitlebarPointerDown}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn(pageColumnClass, "pb-8")}>
          <div
            className="flex h-8 items-center"
            data-slot="window-drag"
            onPointerDown={onTitlebarPointerDown}
          >
            <h1 className="min-w-0 truncate font-medium text-base">{title}</h1>
          </div>
          {description ? (
            <p className="text-muted-foreground text-sm">{description}</p>
          ) : null}
          {children}
        </div>
      </ScrollArea>
    </div>
  );
}
