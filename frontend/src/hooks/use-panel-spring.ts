import { useReducedMotion, useSpring } from "motion/react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { spring } from "@/lib/motion";

interface PanelSpring {
  /** True while the panel moves. Set `minSize` to 0 for that time. */
  moving: boolean;
  /** The same flag, readable inside a resize callback with no render lag. */
  movingRef: RefObject<boolean>;
  /** Stop where the panel is, for when the owner takes hold of the divider. */
  stop: () => void;
}

const sameSize = 0.1;

/**
 * Moves a panel to a target size, in percent, with the shared spring. A new
 * target mid-move turns the spring around at its current speed.
 *
 * A panel with a minimum size snaps to collapsed or to that minimum when a
 * resize lands below it. Moving through those sizes needs the minimum off, so
 * the move starts a render after `moving` turns true. With reduced motion the
 * panel jumps to the target.
 */
export function usePanelSpring(
  panelRef: RefObject<PanelImperativeHandle | null>,
  target: number,
  onSettled?: () => void
): PanelSpring {
  const reduceMotion = useReducedMotion();
  const value = useSpring(target, spring);
  const [moving, setMoving] = useState(false);
  const movingRef = useRef<boolean>(false);
  const pendingRef = useRef<number | null>(null);
  const targetRef = useRef(target);
  const onSettledRef = useRef(onSettled);

  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  const setMovingNow = useCallback((next: boolean) => {
    movingRef.current = next;
    setMoving(next);
  }, []);

  const settle = useCallback(() => {
    panelRef.current?.resize(`${targetRef.current}%`);
    setMovingNow(false);
    onSettledRef.current?.();
  }, [panelRef, setMovingNow]);

  const stop = useCallback(() => {
    value.stop();
    pendingRef.current = null;
    setMovingNow(false);
  }, [setMovingNow, value]);

  // Each frame of the spring resizes the panel.
  useEffect(
    () =>
      value.on("change", (size) => {
        panelRef.current?.resize(`${size}%`);
      }),
    [panelRef, value]
  );
  useEffect(() => value.on("animationComplete", settle), [settle, value]);

  useEffect(() => {
    targetRef.current = target;
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const current = panel.getSize().asPercentage;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: setMovingNow flips movingRef between target changes
    if (!movingRef.current && Math.abs(current - target) < sameSize) {
      return;
    }
    if (reduceMotion) {
      value.jump(target);
      settle();
      return;
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: setMovingNow flips movingRef between target changes
    if (movingRef.current) {
      value.set(target);
      return;
    }
    value.jump(current);
    pendingRef.current = target;
    setMovingNow(true);
  }, [panelRef, reduceMotion, settle, setMovingNow, target, value]);

  // The loosened minimum has rendered, so the move can start.
  useEffect(() => {
    if (moving && pendingRef.current !== null) {
      value.set(pendingRef.current);
      pendingRef.current = null;
    }
  }, [moving, value]);

  return { moving, movingRef, stop };
}
