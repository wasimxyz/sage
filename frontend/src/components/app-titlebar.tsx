import { type PointerEvent, useEffect, useRef } from "react";
import {
  alignTitlebarButtons,
  startWindowDrag,
  waitForNativeBridge,
} from "@/bridge";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export function AppTitlebar() {
  const { isMobile, open } = useSidebar();
  const rowRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    function sync() {
      if (cancelled) {
        return;
      }
      const height = rowRef.current?.getBoundingClientRect().height ?? 0;
      if (height > 0) {
        // 1rem matches the sidebar icon inset (header/group + button padding).
        const rem = Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize
        );
        alignTitlebarButtons(height, rem).then((nativeFullscreen) => {
          if (cancelled) {
            return;
          }
          document.documentElement.toggleAttribute(
            "data-fullscreen",
            nativeFullscreen
          );
        });
      }
    }
    function requestSync() {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    }
    waitForNativeBridge().then((ready) => {
      if (ready) {
        sync();
      }
    });
    // macOS resets traffic-light frames when appearance changes.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    let appearanceTimer = 0;
    function onAppearanceChange() {
      requestSync();
      window.clearTimeout(appearanceTimer);
      appearanceTimer = window.setTimeout(() => {
        appearanceTimer = 0;
        if (!cancelled) {
          sync();
        }
      }, 80);
    }
    window.addEventListener("resize", requestSync);
    media.addEventListener("change", onAppearanceChange);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", requestSync);
      media.removeEventListener("change", onAppearanceChange);
      window.clearTimeout(appearanceTimer);
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

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
