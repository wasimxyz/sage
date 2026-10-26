import { useCallback, useEffect, useRef } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import {
  type CloudOptions,
  drawClouds,
  FRAME_MS,
  MAX_PIXEL_RATIO,
  readCloudPalette,
} from "@/lib/clouds";

type CloudsProps = Pick<CloudOptions, "anchor" | "clearUntil" | "offset"> & {
  className?: string;
  /** Draws one frame and holds it, for a screen that can stay open for hours. */
  still?: boolean;
};

// Shared by every set of clouds, so a change of screen or a new clearing keeps
// the drift going instead of starting it over.
const epoch = performance.now();

/**
 * The website's dot clouds, drifting slowly. They fill their parent, so the
 * parent sets the size and the sky color behind it. They hold still with
 * Reduce motion on, and stop drawing while the window is hidden or the clouds
 * are scrolled out of view.
 */
export function Clouds({
  anchor,
  className,
  clearUntil,
  offset,
  still = false,
}: CloudsProps) {
  const reduceMotion = usePrefersReducedMotion();
  const animate = !(still || reduceMotion);
  // The options sit in a ref, so a new clearing redraws the same canvas
  // without taking its observers down and putting them up again.
  const options = useRef({ anchor, clearUntil, offset });
  const redraw = useRef<(() => void) | null>(null);

  useEffect(() => {
    options.current = { anchor, clearUntil, offset };
    redraw.current?.();
  }, [anchor, clearUntil, offset]);

  // A new ref callback when `animate` changes: React runs the old cleanup and
  // then this with the same canvas.
  const attach = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      const context = canvas?.getContext("2d");
      if (!(canvas && context)) {
        return;
      }
      let palette = readCloudPalette(canvas);
      let size = { height: 0, width: 0 };
      let onScreen = true;
      let timer = 0;
      let stopWatchingPixelRatio: () => void = () => undefined;

      const draw = (now: number) => {
        drawClouds(context, {
          ...options.current,
          height: size.height,
          palette,
          seconds: animate ? (now - epoch) / 1000 : 0,
          width: size.width,
        });
      };
      const resize = () => {
        const { height, width } = canvas.getBoundingClientRect();
        const pixelRatio = Math.min(
          window.devicePixelRatio || 1,
          MAX_PIXEL_RATIO
        );
        size = { height, width };
        canvas.width = Math.max(1, Math.round(width * pixelRatio));
        canvas.height = Math.max(1, Math.round(height * pixelRatio));
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        draw(performance.now());
      };
      const tick = () => {
        draw(performance.now());
        timer = window.setTimeout(tick, FRAME_MS);
      };
      // No timer runs while the clouds are still, hidden, or off screen, so
      // the page is not woken up for frames nobody sees.
      const sync = () => {
        const running = animate && onScreen && !document.hidden;
        if (running === (timer !== 0)) {
          return;
        }
        if (running) {
          tick();
        } else {
          window.clearTimeout(timer);
          timer = 0;
        }
      };
      // The canvas keeps its size in CSS pixels when the window moves to a
      // screen with another pixel ratio, so a media query watches for that.
      const watchPixelRatio = () => {
        const query = window.matchMedia(
          `(resolution: ${window.devicePixelRatio}dppx)`
        );
        const handleChange = () => {
          resize();
          watchPixelRatio();
        };
        query.addEventListener("change", handleChange, { once: true });
        stopWatchingPixelRatio = () =>
          query.removeEventListener("change", handleChange);
      };
      // next-themes switches the theme by changing the class on <html>.
      const changeTheme = () => {
        palette = readCloudPalette(canvas);
        draw(performance.now());
      };

      redraw.current = () => draw(performance.now());
      resize();
      watchPixelRatio();
      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(canvas);
      const themeObserver = new MutationObserver(changeTheme);
      themeObserver.observe(document.documentElement, {
        attributeFilter: ["class"],
        attributes: true,
      });
      const visibilityObserver = new IntersectionObserver(([entry]) => {
        onScreen = entry?.isIntersecting ?? true;
        sync();
      });
      visibilityObserver.observe(canvas);
      document.addEventListener("visibilitychange", sync);
      sync();
      return () => {
        window.clearTimeout(timer);
        redraw.current = null;
        stopWatchingPixelRatio();
        document.removeEventListener("visibilitychange", sync);
        resizeObserver.disconnect();
        themeObserver.disconnect();
        visibilityObserver.disconnect();
      };
    },
    [animate]
  );

  return (
    <div aria-hidden="true" className={className}>
      <canvas className="size-full" ref={attach} />
    </div>
  );
}
