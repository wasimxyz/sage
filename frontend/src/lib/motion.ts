import type { SpringOptions } from "motion/react";

/**
 * The spring for anything you can interrupt: critically damped, so it settles
 * with no overshoot, and it picks up the speed of the motion it replaces.
 * Bounce belongs only to motion that began with a flick.
 *
 * It sets `visualDuration`, the time the move takes to look finished. A value
 * made by `useSpring` jumps to its end when given `duration` instead.
 */
export const spring: SpringOptions = { bounce: 0, visualDuration: 0.35 };

/**
 * The same spring for a value that runs from 0 to 1. The default rest
 * distance of 0.01 would stop a 14rem sidebar about 2px short.
 */
export const unitSpring: SpringOptions = { ...spring, restDelta: 0.0005 };
