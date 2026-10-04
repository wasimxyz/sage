import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const panelIconHoverClass =
  "hover:bg-foreground/10 hover:text-foreground";

export function PanelIconButton({
  className,
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn(panelIconHoverClass, className)}
      size="icon-sm"
      variant="ghost"
      {...props}
    />
  );
}
