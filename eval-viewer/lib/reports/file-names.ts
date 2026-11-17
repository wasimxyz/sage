import { runIdFromPathname } from "./run-id.ts";

export const setupReportSuffix = ".report.json";
export const sweepSummarySuffix = ".sweep.json";

const idSeparator = "__";
const setupIdPattern = /^[0-9a-f]{10}$/u;

export type ReportFile =
  | { kind: "run"; id: string }
  | { kind: "setup"; setupId: string; sweepId: string }
  | { kind: "sweep"; sweepId: string };

/**
 * Sorts a report file by its suffix. This runs before parseRunId, which throws
 * on the new names. A legacy run has up to three files with the same run id.
 */
export function classifyReportFile(pathname: string): ReportFile | undefined {
  const fileName = baseName(pathname);
  if (fileName.endsWith(setupReportSuffix)) {
    return setupFile(fileName.slice(0, -setupReportSuffix.length));
  }
  if (fileName.endsWith(sweepSummarySuffix)) {
    const sweepId = fileName.slice(0, -sweepSummarySuffix.length);
    return sweepId.length === 0 ? undefined : { kind: "sweep", sweepId };
  }
  const id = runIdFromPathname(fileName);
  return id === undefined ? undefined : { id, kind: "run" };
}

/** `<sweepId>__<setupId>`. The setup id is the last 10 hex characters. */
function setupFile(stem: string): ReportFile | undefined {
  const cut = stem.lastIndexOf(idSeparator);
  if (cut <= 0) {
    return;
  }
  const sweepId = stem.slice(0, cut);
  const setupId = stem.slice(cut + idSeparator.length);
  if (!setupIdPattern.test(setupId)) {
    return;
  }
  return { kind: "setup", setupId, sweepId };
}

function baseName(pathname: string): string {
  const slash = Math.max(pathname.lastIndexOf("/"), pathname.lastIndexOf("\\"));
  return slash === -1 ? pathname : pathname.slice(slash + 1);
}
