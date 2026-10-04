import type { ParsedRunId } from "./types.ts";

const timestampPattern = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

export function parseRunId(id: string): ParsedRunId {
  const parts = id.split("__");
  const last = parts.at(-1);
  if (last === undefined || !timestampPattern.test(last)) {
    throw new Error(`Run id is missing a timestamp: ${id}`);
  }
  const startedAt = timestampToIso(last);
  const models = parts.slice(0, -1);
  if (models.length < 2) {
    throw new Error(`Run id needs a dream model and an embed model: ${id}`);
  }
  const dreamModel = displayModelName(models[0] ?? "");
  const embedModel = displayModelName(models[1] ?? "");
  const chatModel =
    models.length >= 3
      ? displayModelName(models.slice(2).join("__"))
      : dreamModel;
  return {
    chatModel,
    dreamModel,
    embedModel,
    id,
    startedAt,
  };
}

export function runIdFromPathname(pathname: string): string | undefined {
  const slash = Math.max(pathname.lastIndexOf("/"), pathname.lastIndexOf("\\"));
  const fileName = slash === -1 ? pathname : pathname.slice(slash + 1);
  if (fileName.endsWith(".manifest.json")) {
    return fileName.slice(0, -".manifest.json".length);
  }
  if (fileName.endsWith(".sage.log")) {
    return fileName.slice(0, -".sage.log".length);
  }
  if (fileName.endsWith(".xml")) {
    return fileName.slice(0, -".xml".length);
  }
  return undefined;
}

export function displayModelName(value: string): string {
  const lastUnderscore = value.lastIndexOf("_");
  if (lastUnderscore <= 0) {
    return value;
  }
  return `${value.slice(0, lastUnderscore)}:${value.slice(lastUnderscore + 1)}`;
}

export function timestampToIso(stamp: string): string {
  const match = timestampPattern.exec(stamp);
  if (match === null) {
    throw new Error(`Not a run timestamp: ${stamp}`);
  }
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}
