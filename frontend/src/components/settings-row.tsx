import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function SettingsRow({
  children,
  description,
  muted = false,
  title,
}: {
  children: ReactNode;
  description: string;
  muted?: boolean;
  title: string;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p
          className={cn(
            "font-medium text-sm",
            muted && "text-muted-foreground"
          )}
        >
          {title}
        </p>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
