import { useLayoutEffect, useRef } from "react";

const positions = new Map<string, number>();
const readerEvents = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Keeps a scroll area where the reader left it when its screen unmounts and
 * comes back. Put the ref on any element inside the area's viewport.
 *
 * A viewport clamps the position until it has its size and content, so the
 * restore tries again as the area is measured. It stops as soon as the reader
 * scrolls, and a scroll made before then is not remembered.
 */
export function useRememberedScroll<T extends HTMLElement>(key: string) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const element: T | null = ref.current;
    const viewport = element?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    );
    if (!(element && viewport)) {
      return;
    }
    const target = positions.get(key) ?? 0;
    let restored = target === 0;
    const observer = new ResizeObserver(() => restore());

    const finish = () => {
      restored = true;
      observer.disconnect();
    };

    const restore = () => {
      if (restored) {
        return;
      }
      viewport.scrollTop = target;
      if (Math.abs(viewport.scrollTop - target) < 1) {
        finish();
      }
    };

    const remember = () => {
      if (restored) {
        positions.set(key, viewport.scrollTop);
      }
    };

    restore();
    if (!restored) {
      observer.observe(viewport);
      observer.observe(element);
    }
    viewport.addEventListener("scroll", remember, { passive: true });
    for (const name of readerEvents) {
      viewport.addEventListener(name, finish, { passive: true });
    }
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", remember);
      for (const name of readerEvents) {
        viewport.removeEventListener(name, finish);
      }
    };
  }, [key]);
  return ref;
}
