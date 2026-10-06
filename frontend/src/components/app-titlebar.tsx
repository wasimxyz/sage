import type { PointerEvent } from "react";
import { startWindowDrag } from "@/bridge";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { useTitlebarAlignment } from "@/hooks/use-titlebar-alignment";
import { cn } from "@/lib/utils";

export function AppTitlebar() {
  const { isMobile, open } = useSidebar();
  const rowRef = useTitlebarAlignment<HTMLElement>();

  return (
    <header
      className={cn(
        "absolute top-0 left-0 z-20 flex h-(--titlebar-height) items-center bg-transparent pr-2 pl-[calc(var(--titlebar-leading)+0.5rem)]",
        // Cover the open sidebar so empty title-bar space next to the toggle can drag.
        open && !isMobile && "w-(--sidebar-width)"
      )}
      data-slot="window-titlebar"
      onPointerDown={onTitlebarPointerDown}
      ref={rowRef}
    >
      <SidebarTrigger aria-pressed={open} />
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
