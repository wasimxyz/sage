import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { get, list } from "@vercel/blob";
import { connection } from "next/server";
import { cache } from "react";

import { assembleReport, summaryFromXml } from "./reports/assemble.ts";
import {
  classifyReportFile,
  sweepSummarySuffix,
} from "./reports/file-names.ts";
import { parseSetupReport, parseSweepSummary } from "./reports/sweep-parse.ts";
import type {
  ParseOutcome,
  SetupData,
  SetupReport,
  SweepData,
  SweepListItem,
  SweepSummary,
} from "./reports/sweep-types.ts";
import {
  compareSweepsNewestFirst,
  setupLabel,
  sweepDateIso,
  varyingDimensions,
} from "./reports/sweep-view.ts";
import type { EvalReport, ReportFiles, RunSummary } from "./reports/types.ts";

export const defaultBlobPrefix = "sage-evals";
const trailingSlashes = /\/+$/u;

export type ReportsSource =
  | { kind: "blob"; prefix: string }
  | { kind: "local"; dir: string }
  | { kind: "none"; reason: string };

/** The files of one legacy JUnit run. */
interface RunFileIndex {
  log?: string;
  manifest?: string;
  xml?: string;
}

/** The files of one sweep. `summaryTime` is when the summary file was written. */
interface SweepFileIndex {
  setups: Map<string, string>;
  summary?: string;
  summaryTime?: string;
}

interface ReportIndex {
  runs: Map<string, RunFileIndex>;
  sweeps: Map<string, SweepFileIndex>;
}

export const loadRunSummaries = cache(async (): Promise<RunSummary[]> => {
  await connection();
  const { runs } = await listIndexedFiles();
  const summaries = await Promise.all(
    [...runs.entries()].map(async ([id, files]) => {
      if (files.xml === undefined) {
        return;
      }
      const xml = await readText(files.xml);
      if (xml === undefined) {
        return;
      }
      return summaryFromXml(id, xml);
    })
  );
  return summaries
    .filter((item): item is RunSummary => item !== undefined)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
});

export const loadReport = cache(
  async (id: string): Promise<EvalReport | null> => {
    await connection();
    const source = resolveSource();
    const paths = pathsForRun(id, source);
    if (paths === undefined) {
      return null;
    }
    const xml = await readText(paths.xml);
    if (xml === undefined) {
      return null;
    }
    const [log, manifest] = await Promise.all([
      readText(paths.log),
      readText(paths.manifest),
    ]);
    const reportFiles: ReportFiles = { log, manifest, xml };
    return assembleReport(id, reportFiles);
  }
);

/** Every sweep that has a summary file, newest first. */
export const loadSweepList = cache(async (): Promise<SweepListItem[]> => {
  await connection();
  const { sweeps } = await listIndexedFiles();
  const items = await Promise.all(
    [...sweeps.entries()].map(async ([id, files]) => {
      if (files.summary === undefined) {
        return;
      }
      const outcome = await readOutcome(
        files.summary,
        parseSweepSummary,
        "sweep summary"
      );
      const top =
        outcome.kind === "ok"
          ? await topSetup(outcome.value, files)
          : undefined;
      const item: SweepListItem = {
        date: sweepDateIso(id, files.summaryTime),
        id,
        outcome,
        top,
      };
      return item;
    })
  );
  return items
    .filter((item): item is SweepListItem => item !== undefined)
    .sort(compareSweepsNewestFirst);
});

/** One sweep with all its setup reports, or null when it has no summary file. */
export const loadSweep = cache(
  async (id: string): Promise<SweepData | null> => {
    await connection();
    const files = (await listIndexedFiles()).sweeps.get(id);
    if (files?.summary === undefined) {
      return null;
    }
    const [summary, entries] = await Promise.all([
      readOutcome(files.summary, parseSweepSummary, "sweep summary"),
      Promise.all(
        [...files.setups.entries()].map(
          async ([setupId, path]) =>
            [
              setupId,
              await readOutcome(path, parseSetupReport, "setup report"),
            ] as const
        )
      ),
    ]);
    return {
      date: sweepDateIso(id, files.summaryTime),
      id,
      reports: new Map(entries),
      summary,
    };
  }
);

/** One setup report, or null when its file is not there. */
export const loadSetupReport = cache(
  async (sweepId: string, setupId: string): Promise<SetupData | null> => {
    await connection();
    const path = (await listIndexedFiles()).sweeps
      .get(sweepId)
      ?.setups.get(setupId);
    if (path === undefined) {
      return null;
    }
    return {
      outcome: await readOutcome(path, parseSetupReport, "setup report"),
      setupId,
      sweepId,
    };
  }
);

export function resolveSource(): ReportsSource {
  if (hasBlobCredentials()) {
    return {
      kind: "blob",
      prefix: (process.env.SAGE_EVAL_BLOB_PREFIX ?? defaultBlobPrefix).replace(
        trailingSlashes,
        ""
      ),
    };
  }
  const localDir =
    process.env.SAGE_EVAL_REPORTS ??
    join(process.cwd(), "..", "agent", "evals", "reports");
  return { dir: localDir, kind: "local" };
}

export function hasBlobCredentials(): boolean {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token !== undefined && token.length > 0) {
    return true;
  }
  const storeId = process.env.BLOB_STORE_ID;
  const oidc = process.env.VERCEL_OIDC_TOKEN;
  return (
    storeId !== undefined &&
    storeId.length > 0 &&
    oidc !== undefined &&
    oidc.length > 0
  );
}

export function blobAccess(): "private" | "public" {
  return process.env.SAGE_EVAL_BLOB_ACCESS === "public" ? "public" : "private";
}

function pathsForRun(
  id: string,
  source: ReportsSource
): { log: string; manifest: string; xml: string } | undefined {
  if (source.kind === "blob") {
    return {
      log: `${source.prefix}/${id}.sage.log`,
      manifest: `${source.prefix}/${id}.manifest.json`,
      xml: `${source.prefix}/${id}.xml`,
    };
  }
  if (source.kind === "local") {
    return {
      log: join(source.dir, `${id}.sage.log`),
      manifest: join(source.dir, `${id}.manifest.json`),
      xml: join(source.dir, `${id}.xml`),
    };
  }
  return undefined;
}

async function readOutcome<T>(
  pathname: string,
  parse: (raw: string) => ParseOutcome<T>,
  what: string
): Promise<ParseOutcome<T>> {
  const raw = await readText(pathname);
  if (raw === undefined) {
    return { kind: "invalid", message: `Could not read the ${what}.` };
  }
  return parse(raw);
}

/** The first setup in a sweep's ranking, named by the dimensions that differ. */
async function topSetup(
  summary: SweepSummary,
  files: SweepFileIndex
): Promise<SweepListItem["top"]> {
  const entry = summary.ranking.at(0);
  if (entry === undefined) {
    return;
  }
  const path = files.setups.get(entry.setupId);
  const outcome: ParseOutcome<SetupReport> | undefined =
    path === undefined
      ? undefined
      : await readOutcome(path, parseSetupReport, "setup report");
  const label =
    outcome?.kind === "ok"
      ? setupLabel(outcome.value.setup, varyingDimensions(summary.axes))
      : entry.setupId;
  return { entry, label };
}

const listIndexedFiles = cache(async (): Promise<ReportIndex> => {
  const source = resolveSource();
  if (source.kind === "blob") {
    return await listBlobFiles(source.prefix);
  }
  if (source.kind === "local") {
    return await listLocalFiles(source.dir);
  }
  return emptyIndex();
});

function emptyIndex(): ReportIndex {
  return { runs: new Map(), sweeps: new Map() };
}

async function listBlobFiles(prefix: string): Promise<ReportIndex> {
  const index = emptyIndex();
  let cursor: string | undefined;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: each Blob list page needs the previous cursor
    const page = await list({
      cursor,
      prefix: `${prefix}/`,
    });
    for (const blob of page.blobs) {
      addToIndex(index, blob.pathname, blob.pathname, blob.uploadedAt);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor !== undefined);
  return index;
}

async function listLocalFiles(dir: string): Promise<ReportIndex> {
  const index = emptyIndex();
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return index;
  }
  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      time: name.endsWith(sweepSummarySuffix)
        ? await modifiedAt(join(dir, name))
        : undefined,
    }))
  );
  for (const { name, time } of files) {
    addToIndex(index, join(dir, name), name, time);
  }
  return index;
}

async function modifiedAt(pathname: string): Promise<Date | undefined> {
  try {
    return (await stat(pathname)).mtime;
  } catch {
    return undefined;
  }
}

function addToIndex(
  index: ReportIndex,
  pathname: string,
  fileName: string,
  time?: Date
): void {
  const file = classifyReportFile(fileName);
  if (file === undefined) {
    return;
  }
  if (file.kind === "setup") {
    sweepEntry(index, file.sweepId).setups.set(file.setupId, pathname);
    return;
  }
  if (file.kind === "sweep") {
    const entry = sweepEntry(index, file.sweepId);
    entry.summary = pathname;
    entry.summaryTime = time?.toISOString();
    return;
  }
  const current = index.runs.get(file.id) ?? {};
  if (fileName.endsWith(".xml") || pathname.endsWith(".xml")) {
    current.xml = pathname;
  } else if (fileName.endsWith(".sage.log") || pathname.endsWith(".sage.log")) {
    current.log = pathname;
  } else if (
    fileName.endsWith(".manifest.json") ||
    pathname.endsWith(".manifest.json")
  ) {
    current.manifest = pathname;
  }
  index.runs.set(file.id, current);
}

function sweepEntry(index: ReportIndex, sweepId: string): SweepFileIndex {
  const existing = index.sweeps.get(sweepId);
  if (existing !== undefined) {
    return existing;
  }
  const created: SweepFileIndex = { setups: new Map() };
  index.sweeps.set(sweepId, created);
  return created;
}

const readText = cache(
  async (pathname: string): Promise<string | undefined> => {
    const source = resolveSource();
    if (source.kind === "local") {
      try {
        return await readFile(pathname, "utf8");
      } catch {
        return undefined;
      }
    }
    const result = await get(pathname, {
      access: blobAccess(),
      useCache: false,
    });
    if (result === null || result.statusCode !== 200) {
      return undefined;
    }
    return new Response(result.stream).text();
  }
);
