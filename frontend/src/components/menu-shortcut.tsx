import { Kbd } from "@/components/ui/kbd";

/**
 * A shortcut at the right edge of a sidebar menu item. It shows while the item
 * is hovered or focused. Put it inside the `SidebarMenuButton`, which names the
 * shortcut for screen readers through `aria-keyshortcuts`.
 */
export function MenuShortcut({ children }: { children: string }) {
  return (
    <Kbd
      aria-hidden
      className="ml-auto text-sidebar-foreground/70 opacity-0 transition-opacity group-hover/menu-button:opacity-100 group-focus-visible/menu-button:opacity-100"
    >
      {children}
    </Kbd>
  );
}
