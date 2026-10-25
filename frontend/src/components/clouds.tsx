import { useCallback } from "react";

import {
  type CloudOptions,
  drawClouds,
  MAX_PIXEL_RATIO,
  readCloudPalette,
} from "@/lib/clouds";

type CloudsProps = Pick<CloudOptions, "anchor" | "clearUntil" | "offset"> & {
  className?: string;
};

/**
 * The website's dot clouds, held still. It fills its parent, so the parent
 * sets the size and the sky color behind it. It draws again when it resizes,
 * when the theme changes, and when a prop changes. Nothing else.
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
      const paint = () => {
        const { height, width } = canvas.getBoundingClientRect();
        const pixelRatio = Math.min(
          window.devicePixelRatio || 1,
          MAX_PIXEL_RATIO
        );
        canvas.width = Math.max(1, Math.round(width * pixelRatio));
        canvas.height = Math.max(1, Math.round(height * pixelRatio));
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        drawClouds(context, {
          anchor,
          clearUntil,
          height,
          offset,
          palette: readCloudPalette(canvas),
          width,
        });
      };

      paint();
      const resizeObserver = new ResizeObserver(paint);
      resizeObserver.observe(canvas);
      // next-themes switches the theme by changing the class on <html>.
      const themeObserver = new MutationObserver(paint);
      themeObserver.observe(document.documentElement, {
        attributeFilter: ["class"],
        attributes: true,
      });
      return () => {
        resizeObserver.disconnect();
        themeObserver.disconnect();
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
