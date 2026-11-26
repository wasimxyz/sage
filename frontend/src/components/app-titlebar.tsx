import type { PointerEvent } from "react";
import { startWindowDrag } from "@/bridge";
import { Hint } from "@/components/hint";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { useTitlebarAlignment } from "@/hooks/use-titlebar-alignment";
import { shortcuts } from "@/lib/shortcuts";

/**
 * The sidebar button beside the traffic lights. It covers only the button,
 * so the Chat / Journal switch further along the row stays clickable. The
 * sidebar's own top row drags the window around it.
 */
export function AppTitlebar() {
  const { open } = useSidebar();
  const rowRef = useTitlebarAlignment<HTMLElement>();

  return (
    <header
      className="absolute top-0 left-0 z-20 flex h-(--titlebar-height) items-center bg-transparent pr-2 pl-[calc(var(--titlebar-leading)+0.5rem)]"
      data-slot="window-titlebar"
      onPointerDown={onTitlebarPointerDown}
      ref={rowRef}
    >
      <Hint label="Toggle sidebar" shortcut={shortcuts.toggleSidebar}>
        <SidebarTrigger
          aria-pressed={open}
          className="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground dark:hover:bg-sidebar-accent"
        />
      </Hint>
    </header>
  );
}

export function onTitlebarPointerDown(event: PointerEvent<HTMLElement>) {
  if (event.button !== 0) {
    return;
  }
  const { target } = event;
  if (!(target instanceof Element)) {
    return;
  }
  if (
    target.closest(
      "button, a, input, textarea, [role='button'], [data-slot='toggle']"
    )
  ) {
    return;
  }
  startWindowDrag();
}
