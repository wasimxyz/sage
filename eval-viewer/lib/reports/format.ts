export function formatTime(seconds: number): string {
  if (seconds < 1) {
    return `${Math.round(seconds * 1000)}ms`;
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return formatTime(seconds);
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  });
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${date.toLocaleString("en-US", {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "UTC",
  })} UTC`;
}

export function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${date.toLocaleString("en-US", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

const dash = "—";

/** A share from 0 to 1 as a percent with one decimal. It can pass 100%. */
export function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** A rubric score on the 0 to 1 scale. */
export function formatScore(score: number | null): string {
  return score === null ? dash : score.toFixed(2);
}

export function formatSpread(spread: number | null): string {
  return spread === null ? dash : `±${spread.toFixed(2)}`;
}

/** Milliseconds as seconds. */
export function formatMs(ms: number | null): string {
  return ms === null ? dash : formatTime(ms / 1000);
}

export function formatUsd(value: number | null): string {
  return value === null ? dash : `$${value.toFixed(2)}`;
}

export function formatHours(value: number | null): string {
  return value === null ? dash : `${value.toFixed(1)} h`;
}

export function formatMegabytes(value: number | null): string {
  return value === null ? dash : `${Math.round(value)} MB`;
}

export function passRate(passed: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return Math.round((passed / total) * 100);
}

export type PassRateTone = "fail" | "pass" | "warn";

const passToneFloor = 90;
const warnToneFloor = 70;

export function passRateTone(rate: number): PassRateTone {
  if (rate >= passToneFloor) {
    return "pass";
  }
  if (rate >= warnToneFloor) {
    return "warn";
  }
  return "fail";
}

export const failureTypeLabel: Record<string, string> = {
  call_failed: "call failed",
  other: "error",
  timeout: "timed out",
  wrong_hit: "wrong top hit",
};
