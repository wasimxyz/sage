import { useSpring } from "motion/react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
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
 * Moves a panel to a target size, in percent, with the shared spring. A move
 * starts when `step` changes, and `getTarget` says where it ends. Reading the
 * target in the effect, not during render, lets it come from a ref. A new
 * step mid-move turns the spring around at its current speed.
 *
 * A panel with a minimum size snaps to collapsed or to that minimum when a
 * resize lands below it. Moving through those sizes needs the minimum off, so
 * the move starts a render after `moving` turns true. With reduced motion the
 * panel jumps to the target, one frame later for the same reason.
 *
 * `onSettled` gets the step the panel has reached. It also runs when the
 * panel was already there, so a caller can finish what it waited on.
 */
export function usePanelSpring(
  panelRef: RefObject<PanelImperativeHandle | null>,
  step: string,
  getTarget: () => number,
  onSettled?: (step: string) => void
): PanelSpring {
  const reduceMotion = usePrefersReducedMotion();
  const value = useSpring(0, spring);
  const [moving, setMoving] = useState(false);
  const movingRef = useRef<boolean>(false);
  const pendingRef = useRef<number | null>(null);
  const targetRef = useRef(0);
  const stepRef = useRef(step);
  const getTargetRef = useRef(getTarget);
  const onSettledRef = useRef(onSettled);

  useEffect(() => {
    getTargetRef.current = getTarget;
    onSettledRef.current = onSettled;
  });

  const setMovingNow = useCallback((next: boolean) => {
    movingRef.current = next;
    setMoving(next);
  }, []);

  const settle = useCallback(() => {
    panelRef.current?.resize(`${targetRef.current}%`);
    setMovingNow(false);
    onSettledRef.current?.(stepRef.current);
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
    const target = getTargetRef.current();
    targetRef.current = target;
    stepRef.current = step;
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: setMovingNow flips movingRef between steps
    if (movingRef.current) {
      // A move is under way. Steer it, and drop a target that was waiting.
      pendingRef.current = null;
      if (reduceMotion) {
        value.jump(target);
        settle();
      } else {
        value.set(target);
      }
      return;
    }
    const current = panel.getSize().asPercentage;
    if (Math.abs(current - target) < sameSize) {
      onSettledRef.current?.(step);
      return;
    }
    value.jump(current);
    pendingRef.current = target;
    setMovingNow(true);
  }, [panelRef, reduceMotion, settle, setMovingNow, step, value]);

  // The loosened minimum has rendered, so the move can start.
  useEffect(() => {
    if (!moving || pendingRef.current === null) {
      return;
    }
    const target = pendingRef.current;
    pendingRef.current = null;
    if (!reduceMotion) {
      value.set(target);
      return;
    }
    const frame = requestAnimationFrame(() => {
      value.jump(target);
      settle();
    });
    return () => cancelAnimationFrame(frame);
  }, [moving, reduceMotion, settle, value]);

  return { moving, movingRef, stop };
}
