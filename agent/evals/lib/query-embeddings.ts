import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EvalCase } from "./dataset.ts";
import { embedModel, ollamaBaseURL } from "./models.ts";

const lineBreakPattern = /\r?\n/;
const trailingSlashPattern = /\/$/;

export interface QueryEmbedding {
  embedding: number[];
  text: string;
}

const embedPipelines = ["extraction", "retrieval", "summaries"] as const;

let cachedPath: string | undefined;
let cachedRows: Map<string, number[]> | undefined;

export function embeddingsPath(): string | undefined {
  const path = process.env.SAGE_EVAL_EMBEDDINGS;
  if (path === undefined || path.length === 0) {
    return undefined;
  }
  return path;
}

export function collectQueryTexts(cases: EvalCase[]): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const fixture of cases) {
    for (const item of fixture.retrieval) {
      addUnique(texts, seen, item.query);
    }
    for (const fact of fixture.facts) {
      addUnique(texts, seen, fact.reference);
    }
    for (const event of fixture.events) {
      addUnique(texts, seen, event.reference);
    }
    for (const entry of fixture.entries) {
      addUnique(texts, seen, entry.title);
    }
  }
  return texts;
}

export function collectEmbeddingTags(cases: EvalCase[]): string[] {
  const tags = new Set<string>();
  for (const fixture of cases) {
    for (const tag of fixture.tags) {
      tags.add(tag);
    }
    tags.add(fixture.kind);
    for (const pipeline of embedPipelines) {
      tags.add(pipeline);
    }
  }
  return [...tags];
}

export function embeddingFor(text: string): number[] | undefined {
  const rows = loadEmbeddingMap();
  if (rows === undefined) {
    return undefined;
  }
  return rows.get(text.trim());
}

export function writeQueryEmbeddings(rows: QueryEmbedding[]): void {
  const path = embeddingsPath();
  if (path === undefined) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const lines = rows.map((row) => JSON.stringify(row));
  writeFileSync(
    path,
    lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    "utf8"
  );
  cachedPath = path;
  cachedRows = mapFromRows(rows);
}

export function loadQueryEmbeddings(): QueryEmbedding[] {
  const path = embeddingsPath();
  if (path === undefined) {
    return [];
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  const rows: QueryEmbedding[] = [];
  const lines = raw.split(lineBreakPattern);
  for (const [offset, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(trimmed, path, offset + 1));
  }
  return rows;
}

export async function embedQueryTexts(
  texts: string[]
): Promise<QueryEmbedding[]> {
  if (texts.length === 0) {
    return [];
  }
  const url = `${ollamaBaseURL().replace(trailingSlashPattern, "")}/embed`;
  const response = await fetch(url, {
    body: JSON.stringify({
      input: texts,
      keep_alive: 0,
      model: embedModel(),
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Ollama embed returned HTTP ${response.status}.`);
  }
  return parseEmbedResponse(await response.json(), texts);
}

export function parseEmbedResponse(
  payload: unknown,
  texts: string[]
): QueryEmbedding[] {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("embeddings" in payload) ||
    !Array.isArray((payload as { embeddings: unknown }).embeddings)
  ) {
    throw new Error("Ollama embed response is missing embeddings.");
  }
  const { embeddings } = payload as { embeddings: unknown[] };
  if (embeddings.length !== texts.length) {
    throw new Error(
      `Ollama embed returned ${embeddings.length} vectors for ${texts.length} queries.`
    );
  }
  return texts.map((text, index) => ({
    embedding: floatList(embeddings[index], index),
    text,
  }));
}

function loadEmbeddingMap(): Map<string, number[]> | undefined {
  const path = embeddingsPath();
  if (path === undefined) {
    return undefined;
  }
  if (cachedPath === path && cachedRows !== undefined) {
    return cachedRows;
  }
  const rows = loadQueryEmbeddings();
  cachedPath = path;
  cachedRows = mapFromRows(rows);
  return cachedRows;
}

function mapFromRows(rows: QueryEmbedding[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const row of rows) {
    map.set(row.text, row.embedding);
  }
  return map;
}

function parseRow(
  line: string,
  path: string,
  lineNumber: number
): QueryEmbedding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`${path}:${lineNumber} is not valid JSON.`, {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${path}:${lineNumber} must be a JSON object.`);
  }
  const row = parsed as Record<string, unknown>;
  const label = `${path}:${lineNumber}`;
  const { text } = row;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error(`${label} is missing text.`);
  }
  return {
    embedding: floatList(row.embedding, label),
    text,
  };
}

function floatList(value: unknown, label: string | number): number[] {
  const where =
    typeof label === "number" ? `embedding ${label}` : String(label);
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${where} is missing a non-empty embedding.`);
  }
  if (
    !value.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    throw new Error(`${where} embedding must be a list of finite numbers.`);
  }
  return value;
}

function addUnique(texts: string[], seen: Set<string>, value: string): void {
  const text = value.trim();
  if (text.length === 0 || seen.has(text)) {
    return;
  }
  seen.add(text);
  texts.push(text);
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}
