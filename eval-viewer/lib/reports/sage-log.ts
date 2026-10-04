import type { SessionLog } from "./types.ts";

const tsPattern = /\bts=(\d+)/;
const appPattern = /\bapp="([^"]+)"/;
const platformPattern = /\bplatform="([^"]+)"/;
const lineSplitPattern = /\r?\n/;

export function parseSageLog(log: string): SessionLog {
  const lines = log.split(lineSplitPattern).filter((line) => line.length > 0);
  let app = "Sage";
  let platform = "unknown";
  let firstTs: string | undefined;
  let lastTs: string | undefined;

  for (const line of lines) {
    const tsMatch = tsPattern.exec(line);
    if (tsMatch !== null) {
      const [, ts] = tsMatch;
      if (ts !== undefined) {
        firstTs ??= ts;
        lastTs = ts;
      }
    }
    const appMatch = appPattern.exec(line);
    if (appMatch !== null) {
      const [, capturedApp] = appMatch;
      if (capturedApp !== undefined) {
        app = capturedApp;
      }
    }
    const platformMatch = platformPattern.exec(line);
    if (platformMatch !== null) {
      const [, capturedPlatform] = platformMatch;
      if (capturedPlatform !== undefined) {
        platform = capturedPlatform;
      }
    }
  }

  const startedAt =
    firstTs === undefined ? undefined : isoFromTimestamp(firstTs);
  const endedAt = lastTs === undefined ? undefined : isoFromTimestamp(lastTs);
  const sessionSeconds =
    startedAt === undefined || endedAt === undefined
      ? undefined
      : Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 1000);

  return { app, endedAt, platform, sessionSeconds, startedAt };
}

function isoFromTimestamp(raw: string): string | undefined {
  const millis = millisFromTimestamp(raw);
  if (millis === undefined) {
    return undefined;
  }
  return new Date(millis).toISOString();
}

function millisFromTimestamp(raw: string): number | undefined {
  if (raw.length >= 16) {
    const millis = Number.parseInt(raw.slice(0, raw.length - 6), 10);
    return Number.isNaN(millis) ? undefined : millis;
  }
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    return undefined;
  }
  if (value > 1e14) {
    return Math.floor(value / 1_000_000);
  }
  if (value > 1e12) {
    return value;
  }
  return value * 1000;
}
