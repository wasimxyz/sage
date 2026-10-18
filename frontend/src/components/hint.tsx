import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ComponentProps, ReactElement, ReactNode } from "react";

import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent } from "@/components/ui/tooltip";

/**
 * A tooltip for a button. The button is the child, and it keeps its own props
 * and children. The label shows below it, with the shortcut greyed after it.
 *
 * The trigger is the primitive, not `TooltipTrigger`, which stamps its own
 * data-slot over the button's. Some selectors look the button up by its slot.
 */
export function Hint({
  children,
  label,
  shortcut,
  side = "bottom",
}: {
  children: ReactElement;
  label: ReactNode;
  shortcut?: string;
  side?: ComponentProps<typeof TooltipContent>["side"];
}) {
  return (
    <Tooltip>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipContent side={side}>
        {label}
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}
