import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none select-none font-sans text-muted-foreground text-xs in-data-[slot=tooltip-content]:text-background/60",
        className
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

export { Kbd };
