import { useCallback } from "react";

import {
  type CloudOptions,
  drawClouds,
  FRAME_MS,
  MAX_PIXEL_RATIO,
  readCloudPalette,
} from "@/lib/clouds";

type CloudsProps = Pick<CloudOptions, "anchor" | "clearUntil" | "offset"> & {
  className?: string;
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
export function Clouds({ anchor, className, clearUntil, offset }: CloudsProps) {
  // A new ref callback, so a changed prop draws again: React runs the old
  // cleanup and then this with the same canvas.
  const attach = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      const context = canvas?.getContext("2d");
      if (!(canvas && context)) {
        return;
      }
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      let palette = readCloudPalette(canvas);
      let size = { height: 0, width: 0 };
      let onScreen = true;
      let frame = 0;
      let lastDrawn = 0;

      const draw = (now: number) => {
        drawClouds(context, {
          anchor,
          clearUntil,
          height: size.height,
          offset,
          palette,
          seconds: reduceMotion ? 0 : (now - epoch) / 1000,
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
      const loop = (now: number) => {
        frame = requestAnimationFrame(loop);
        if (document.hidden || !onScreen || now - lastDrawn < FRAME_MS) {
          return;
        }
        lastDrawn = now;
        draw(now);
      };
      // next-themes switches the theme by changing the class on <html>.
      const changeTheme = () => {
        palette = readCloudPalette(canvas);
        draw(performance.now());
      };

      resize();
      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(canvas);
      const themeObserver = new MutationObserver(changeTheme);
      themeObserver.observe(document.documentElement, {
        attributeFilter: ["class"],
        attributes: true,
      });
      const visibilityObserver = new IntersectionObserver(([entry]) => {
        onScreen = entry?.isIntersecting ?? true;
      });
      visibilityObserver.observe(canvas);
      if (!reduceMotion) {
        frame = requestAnimationFrame(loop);
      }
      return () => {
        cancelAnimationFrame(frame);
        resizeObserver.disconnect();
        themeObserver.disconnect();
        visibilityObserver.disconnect();
      };
    },
    [anchor, clearUntil, offset]
  );

  return (
    <div aria-hidden="true" className={className}>
      <canvas className="size-full" ref={attach} />
    </div>
  );
}
