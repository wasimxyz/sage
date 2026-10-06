import { useEffect, useRef } from "react";

import { alignTitlebarButtons, waitForNativeBridge } from "@/bridge";

/**
 * Keeps the macOS traffic lights where the title bar expects them. The native
 * side moves them to line up with the row this ref is attached to, and again
 * after a resize or an appearance change, which resets them. It also mirrors
 * whether the window is in full screen onto `<html data-fullscreen>`, which
 * `useWindowFullscreen` reads.
 *
 * Every screen with its own title bar row needs this, or the lights stay where
 * macOS puts them and sit closer to the corner than the rest of the app.
 */
export function useTitlebarAlignment<T extends HTMLElement>() {
  const rowRef = useRef<T | null>(null);

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

  return rowRef;
}
