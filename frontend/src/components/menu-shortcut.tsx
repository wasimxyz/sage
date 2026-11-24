import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/**
 * A shortcut at the right edge of a sidebar menu item. It shows while the item
 * is hovered or focused, or all the time with `always`. Put it inside the
 * `SidebarMenuButton`, which names the shortcut for screen readers through
 * `aria-keyshortcuts`.
 */
export function MenuShortcut({
  always = false,
  children,
}: {
  always?: boolean;
  children: string;
}) {
  return (
    <Kbd
      aria-hidden
      className={cn(
        "text-sidebar-foreground/70 ml-auto",
        !always &&
          "opacity-0 transition-opacity group-hover/menu-button:opacity-100 group-focus-visible/menu-button:opacity-100"
      )}
    >
      {children}
    </Kbd>
  );
}
