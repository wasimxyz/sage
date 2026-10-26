import type { PointerEvent } from "react";
import { startWindowDrag } from "@/bridge";
import { Hint } from "@/components/hint";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { useTitlebarAlignment } from "@/hooks/use-titlebar-alignment";
import { shortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

export function AppTitlebar() {
  const { isMobile, open } = useSidebar();
  const rowRef = useTitlebarAlignment<HTMLElement>();
  const sidebarCoversButton = open && !isMobile;

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
      <Hint label="Toggle sidebar" shortcut={shortcuts.toggleSidebar}>
        <SidebarTrigger
          aria-pressed={open}
          className={cn(
            "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground dark:hover:bg-sidebar-accent",
            // Home's cloud band sits under the button once the sidebar is out
            // of the way, and the band is dark enough to need white.
            sidebarCoversButton ||
              "in-data-[titlebar=band]:text-white in-data-[titlebar=band]:hover:bg-white/15 in-data-[titlebar=band]:hover:text-white in-data-[titlebar=band]:focus-visible:ring-white/70"
          )}
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
