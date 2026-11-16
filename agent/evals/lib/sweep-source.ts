/**
 * A finished sweep, read back from its files.
 *
 * Calibration sampling and head-to-head judging both start from a sweep that
 * already ran. The sweep leaves two kinds of files:
 *
 * - `agent/evals/reports/<sweep id>.sweep.json` and one
 *   `<sweep id>__<setup id>.report.json` for each setup. A report holds every
 *   item with its turns, tool calls, checks, and rubric.
 * - `agent/evals/.runs/<sweep id>/setups/<setup id>/<person>/transcripts.jsonl`,
 *   the rows the chat pass wrote. They stay on the machine that ran the sweep.
 *
 * The reports are enough on their own, so a sweep uploaded from another Mac
 * works. When a transcript row exists for an item, it wins, because it is the
 * row the grader read.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSetupReport,
  parseSweepSummary,
  REPORT_SUFFIX,
  type ReportItem,
  type SetupReport,
  type SweepSummary,
  sweepSummaryFileName,
  type TranscriptKind,
  type TranscriptRow,
  type Turn,
} from "./schema.ts";
import { loadTranscripts } from "./transcripts.ts";

/** The items of a report that are one message to Sage and one reply, or a whole conversation. */
export const REPLY_ITEM_KINDS: readonly TranscriptKind[] = [
  "opener",
  "chat",
  "conversation",
];

export function defaultReportsDir(): string {
  return fileURLToPath(new URL("../reports", import.meta.url));
}

export function defaultRunsDir(): string {
  return fileURLToPath(new URL("../.runs", import.meta.url));
}

export interface SweepDirs {
  reportsDir: string;
  /** The folder of run folders. Left out, only the reports are read. */
  runsDir?: string;
}

export function defaultSweepDirs(): SweepDirs {
  return { reportsDir: defaultReportsDir(), runsDir: defaultRunsDir() };
}

/** Where one setup's reply rows for one person are. */
export function transcriptsPathOf(
  runDir: string,
  setupId: string,
  person: string
): string {
  return join(runDir, "setups", setupId, person, "transcripts.jsonl");
}

/** `<setup id>|<item id>|<repeat>` */
export function rowKey(
  setupId: string,
  itemId: string,
  repeat: number
): string {
  return `${setupId}|${itemId}|${repeat}`;
}

function isReplyKind(kind: string): kind is TranscriptKind {
  return (REPLY_ITEM_KINDS as readonly string[]).includes(kind);
}

function turnOfReport(turn: ReportItem["turns"][number]): Turn {
  return {
    ...(turn.error === undefined ? {} : { error: turn.error }),
    role: turn.role,
    stepModelIds: turn.stepModelIds,
    text: turn.text,
    ...(turn.timing === undefined ? {} : { timing: turn.timing }),
    toolCalls: turn.toolCalls,
  };
}

/**
 * The transcript row of a report item, rebuilt from the report. Null for an
 * item that is not a reply or a conversation (a fact check, a Dream source).
 */
export function rowOfReportItem(
  item: ReportItem,
  setupId: string
): TranscriptRow | null {
  if (!isReplyKind(item.kind)) {
    return null;
  }
  return {
    ended: item.ended ?? "done",
    itemId: item.itemId,
    journal: item.journal,
    kind: item.kind,
    ...(item.note === undefined ? {} : { note: item.note }),
    person: item.person,
    repeat: item.repeat,
    setupId,
    simulatedUserFlags: [
      ...new Set(item.simulatedUserFlags.map((mark) => mark.flag)),
    ],
    turns: item.turns.map(turnOfReport),
  };
}

export interface SweepSource {
  /** Reports in ranking order, then any others by setup id. */
  reports: SetupReport[];
  summary: SweepSummary;
  /** Transcript rows from the run folder, by `rowKey`. Empty when it is gone. */
  transcripts: ReadonlyMap<string, TranscriptRow>;
}

function readJson(path: string, what: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${what} (${path}).`, { cause: error });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${what} is not valid JSON (${path}).`, { cause: error });
  }
}

/** The summary of a finished sweep. Throws a readable error when it is missing or invalid. */
export function loadSweepSummary(
  sweepId: string,
  reportsDir: string
): SweepSummary {
  const path = join(reportsDir, sweepSummaryFileName(sweepId));
  if (!existsSync(path)) {
    throw new Error(
      `No finished sweep ${sweepId}: ${path} does not exist. Run the sweep to its end first, or check the id.`
    );
  }
  return parseSweepSummary(readJson(path, `the summary of ${sweepId}`), path);
}

/** The ids of the setups that have a report file for a sweep. */
export function reportSetupIds(sweepId: string, reportsDir: string): string[] {
  const prefix = `${sweepId}__`;
  let names: string[];
  try {
    names = readdirSync(reportsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(REPORT_SUFFIX))
    .map((name) => name.slice(prefix.length, -REPORT_SUFFIX.length))
    .sort();
}

/** One setup's report. Throws a readable error when it is missing or invalid. */
export function loadSetupReport(
  sweepId: string,
  setupId: string,
  reportsDir: string
): SetupReport {
  const path = join(reportsDir, `${sweepId}__${setupId}${REPORT_SUFFIX}`);
  if (!existsSync(path)) {
    throw new Error(`Setup ${setupId} of ${sweepId} has no report (${path}).`);
  }
  return parseSetupReport(readJson(path, `the report of ${setupId}`), path);
}

const SETUPS_FOLDER = "setups";

/** Every transcript row in a run folder, by `rowKey`. A file that cannot be read is skipped. */
export function loadTranscriptIndex(
  runDir: string
): Map<string, TranscriptRow> {
  const index = new Map<string, TranscriptRow>();
  const setupsDir = join(runDir, SETUPS_FOLDER);
  let setups: string[];
  try {
    setups = readdirSync(setupsDir);
  } catch {
    return index;
  }
  for (const setupId of setups) {
    let people: string[];
    try {
      people = readdirSync(join(setupsDir, setupId));
    } catch {
      continue;
    }
    for (const person of people) {
      try {
        for (const row of loadTranscripts(
          transcriptsPathOf(runDir, setupId, person)
        )) {
          index.set(rowKey(row.setupId, row.itemId, row.repeat), row);
        }
      } catch {
        // A bad file leaves its items to the report.
      }
    }
  }
  return index;
}

/** Reads a finished sweep: its summary, every setup report, and the transcripts if they are still there. */
export function loadSweepSource(
  sweepId: string,
  dirs: SweepDirs = defaultSweepDirs()
): SweepSource {
  const summary = loadSweepSummary(sweepId, dirs.reportsDir);
  const onDisk = reportSetupIds(sweepId, dirs.reportsDir);
  const ranked = summary.ranking
    .map((entry) => entry.setupId)
    .filter((id) => onDisk.includes(id));
  const order = [...ranked, ...onDisk.filter((id) => !ranked.includes(id))];
  const reports = order.map((id) =>
    loadSetupReport(sweepId, id, dirs.reportsDir)
  );
  const transcripts =
    dirs.runsDir === undefined
      ? new Map<string, TranscriptRow>()
      : loadTranscriptIndex(join(dirs.runsDir, sweepId));
  return { reports, summary, transcripts };
}

/** The row of a report's item: the transcript when there is one, else the report's own turns. */
export function sourceRow(
  source: Pick<SweepSource, "transcripts">,
  setupId: string,
  item: ReportItem
): TranscriptRow | null {
  return (
    source.transcripts.get(rowKey(setupId, item.itemId, item.repeat)) ??
    rowOfReportItem(item, setupId)
  );
}
