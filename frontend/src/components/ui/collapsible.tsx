import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
  )
}

function CollapsibleContent({ ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />
  )
}

/**
 * Classes that open and close a panel by its height. Base UI sets
 * `--collapsible-panel-height` and the starting and ending styles. Put any
 * border, padding, or margin on an element inside the panel, because a panel
 * with its own box would not measure to the right height.
 */
const collapsibleHeightMotion =
  "h-(--collapsible-panel-height) overflow-hidden outline-none transition-[height,opacity] duration-250 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 motion-reduce:transition-none"

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  collapsibleHeightMotion,
}
