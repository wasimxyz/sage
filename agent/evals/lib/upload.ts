import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const defaultBlobPrefix = "sage-evals";

export function listReportFiles(dir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) {
      continue;
    }
    const path = join(dir, name);
    if (!statSync(path).isFile()) {
      continue;
    }
    files.push(path);
  }
  return files;
}

export function blobPathname(
  filePath: string,
  prefix = defaultBlobPrefix
): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const fileName = slash === -1 ? filePath : filePath.slice(slash + 1);
  const folder = prefix.replace(/\/+$/, "");
  return `${folder}/${fileName}`;
}

export function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".xml")) {
    return "application/xml";
  }
  if (filePath.endsWith(".json")) {
    return "application/json";
  }
  if (filePath.endsWith(".log")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}
