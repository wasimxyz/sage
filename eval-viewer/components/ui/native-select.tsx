import * as React from "react"
import { cn } from "cn"

// A plain <select>, so a GET form can send it without any script.
function NativeSelect({
  className,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:[&>option]:bg-popover",
        className
      )}
      {...props}
    />
  )
}

export { NativeSelect }
