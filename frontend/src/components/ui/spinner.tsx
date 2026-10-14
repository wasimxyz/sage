import type * as React from "react";

import { cn } from "@/lib/utils";

// Eight spokes that fade in turn, like the Mac activity indicator. The whole
// icon turns one spoke per step, so the bright spoke appears to travel.
const spokeAngles = [0, 45, 90, 135, 180, 225, 270, 315];

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      aria-label="Loading"
      className={cn("size-4 animate-[spin_0.8s_steps(8)_infinite]", className)}
      data-slot="spinner"
      fill="none"
      role="status"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth={2.5}
      viewBox="0 0 24 24"
      {...props}
    >
      {spokeAngles.map((angle) => (
        <line
          key={angle}
          opacity={0.15 + (angle / 360) * 0.85}
          transform={`rotate(${angle} 12 12)`}
          x1="12"
          x2="12"
          y1="3"
          y2="8"
        />
      ))}
    </svg>
  );
}

export { Spinner };
