import type { ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * One section of the Settings dialog: its title and description over its
 * rows. It scrolls on its own, so the list of sections stays put.
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
    <ScrollArea className="min-h-0 flex-1">
      <div className="px-6 pt-4 pb-8">
        <div className="flex h-8 items-center">
          <h3 className="min-w-0 truncate text-base font-medium">{title}</h3>
        </div>
        {description ? (
          <p className="text-muted-foreground text-sm">{description}</p>
        ) : null}
        {children}
      </div>
    </ScrollArea>
  );
}
