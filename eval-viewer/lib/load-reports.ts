import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { get, list } from "@vercel/blob";
import { connection } from "next/server";
import { cache } from "react";

import { assembleReport, summaryFromXml } from "./reports/assemble.ts";
import { runIdFromPathname } from "./reports/run-id.ts";
import type { EvalReport, ReportFiles, RunSummary } from "./reports/types.ts";

export const defaultBlobPrefix = "sage-evals";
const trailingSlashes = /\/+$/;

export type ReportsSource =
  | { kind: "blob"; prefix: string }
  | { kind: "local"; dir: string }
  | { kind: "none"; reason: string };

interface RunFileIndex {
  log?: string;
  manifest?: string;
  xml?: string;
}

export const loadRunSummaries = cache(async (): Promise<RunSummary[]> => {
  await connection();
  const index = await listIndexedFiles();
  const summaries = await Promise.all(
    [...index.entries()].map(async ([id, files]) => {
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

const listIndexedFiles = cache(async (): Promise<Map<string, RunFileIndex>> => {
  const source = resolveSource();
  if (source.kind === "blob") {
    return await listBlobFiles(source.prefix);
  }
  if (source.kind === "local") {
    return await listLocalFiles(source.dir);
  }
  return new Map<string, RunFileIndex>();
});

async function listBlobFiles(
  prefix: string
): Promise<Map<string, RunFileIndex>> {
  const index = new Map<string, RunFileIndex>();
  let cursor: string | undefined;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: each Blob list page needs the previous cursor
    const page = await list({
      cursor,
      prefix: `${prefix}/`,
    });
    for (const blob of page.blobs) {
      addToIndex(index, blob.pathname);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor !== undefined);
  return index;
}

async function listLocalFiles(dir: string): Promise<Map<string, RunFileIndex>> {
  const index = new Map<string, RunFileIndex>();
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return index;
  }
  for (const name of names) {
    addToIndex(index, join(dir, name), name);
  }
  return index;
}

function addToIndex(
  index: Map<string, RunFileIndex>,
  pathname: string,
  fileName = pathname
): void {
  const id = runIdFromPathname(fileName);
  if (id === undefined) {
    return;
  }
  const current = index.get(id) ?? {};
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
  index.set(id, current);
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
