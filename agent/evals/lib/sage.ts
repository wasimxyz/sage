import { readSageJson, sageFetch } from "../../agent/lib/sage.ts";

import { embeddingFor } from "./query-embeddings.ts";

export interface JournalHit {
  date: string;
  id: number;
  score: number;
  snippet: string;
  title: string;
}

export interface FactHit {
  fact: string;
  id: number;
  score: number;
  sourceId: number;
  sourceType: string;
  subject: string;
}

export interface EventHit {
  event: string;
  id: number;
  occurredAt: string;
  score: number;
  sourceId: number;
  sourceType: string;
}

export interface ProfileFact {
  fact: string;
  id: number;
  sourceId: number;
  sourceType: string;
  subject: string;
}

export async function searchJournal(
  query: string,
  limit = 5
): Promise<JournalHit[]> {
  const payload = await postJson("/journal/search", { limit, query });
  return arrayOf(payload, "entries", (item) => {
    if (
      item === null ||
      typeof item !== "object" ||
      !("id" in item) ||
      typeof item.id !== "number" ||
      !("title" in item) ||
      typeof item.title !== "string" ||
      !("date" in item) ||
      typeof item.date !== "string" ||
      !("snippet" in item) ||
      typeof item.snippet !== "string"
    ) {
      return null;
    }
    const score =
      "score" in item && typeof item.score === "number" ? item.score : 0;
    return {
      date: item.date,
      id: item.id,
      score,
      snippet: item.snippet,
      title: item.title,
    };
  });
}

export async function searchFacts(
  query: string,
  limit = 10
): Promise<FactHit[]> {
  const payload = await postJson("/memory/facts/search", { limit, query });
  return arrayOf(payload, "results", (item) => {
    if (
      item === null ||
      typeof item !== "object" ||
      !("id" in item) ||
      typeof item.id !== "number" ||
      !("fact" in item) ||
      typeof item.fact !== "string" ||
      !("subject" in item) ||
      typeof item.subject !== "string"
    ) {
      return null;
    }
    const score =
      "score" in item && typeof item.score === "number" ? item.score : 0;
    const source = sourceFields(item);
    return {
      fact: item.fact,
      id: item.id,
      score,
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      subject: item.subject,
    };
  });
}

export async function searchEvents(
  query: string,
  limit = 10
): Promise<EventHit[]> {
  const payload = await postJson("/memory/events/search", { limit, query });
  return arrayOf(payload, "results", (item) => {
    if (
      item === null ||
      typeof item !== "object" ||
      !("id" in item) ||
      typeof item.id !== "number" ||
      !("event" in item) ||
      typeof item.event !== "string"
    ) {
      return null;
    }
    const score =
      "score" in item && typeof item.score === "number" ? item.score : 0;
    const occurredAt =
      "occurredAt" in item && typeof item.occurredAt === "string"
        ? item.occurredAt
        : "";
    const source = sourceFields(item);
    return {
      event: item.event,
      id: item.id,
      occurredAt,
      score,
      sourceId: source.sourceId,
      sourceType: source.sourceType,
    };
  });
}

export async function listProfile(): Promise<ProfileFact[]> {
  const response = await sageFetch("/memory/profile");
  const payload = await readSageJson(response);
  return arrayOf(payload, "facts", (item) => {
    if (
      item === null ||
      typeof item !== "object" ||
      !("id" in item) ||
      typeof item.id !== "number" ||
      !("fact" in item) ||
      typeof item.fact !== "string"
    ) {
      return null;
    }
    const subject =
      "subject" in item && typeof item.subject === "string"
        ? item.subject
        : "user";
    const source = sourceFields(item);
    return {
      fact: item.fact,
      id: item.id,
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      subject,
    };
  });
}

async function postJson(
  pathname: string,
  body: { limit: number; query: string }
): Promise<unknown> {
  const embedding = embeddingFor(body.query);
  const payload =
    embedding === undefined ? body : { ...body, embedding };
  const response = await sageFetch(pathname, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return readSageJson(response);
}

function sourceFields(item: object): { sourceId: number; sourceType: string } {
  const sourceType =
    "sourceType" in item &&
    typeof item.sourceType === "string" &&
    item.sourceType.length > 0
      ? item.sourceType
      : "entry";
  const sourceId =
    "sourceId" in item && typeof item.sourceId === "number" ? item.sourceId : 0;
  return { sourceId, sourceType };
}

function arrayOf<T>(
  payload: unknown,
  key: string,
  map: (item: unknown) => T | null
): T[] {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !(key in payload) ||
    !Array.isArray((payload as Record<string, unknown>)[key])
  ) {
    return [];
  }
  const rows: T[] = [];
  for (const item of (payload as Record<string, unknown>)[key] as unknown[]) {
    const mapped = map(item);
    if (mapped !== null) {
      rows.push(mapped);
    }
  }
  return rows;
}
