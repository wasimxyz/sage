import { defineMemory, defineMemoryProvider } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { memoryFeatureEnabled } from "../lib/memory-feature";
import { lastUserText } from "../lib/memory-text";
import { readSageJson, sageFetch } from "../lib/sage";

const defaultSearchLimit = 5;

const provider = defineMemoryProvider({
  recall: {
    async "turn.started"(ctx) {
      if (!(await memoryFeatureEnabled())) {
        return null;
      }
      try {
        const query = lastUserText(ctx.turn.input);
        if (query.length === 0) {
          return null;
        }
        const response = await sageFetch("/memory/facts/search", {
          body: JSON.stringify({ limit: defaultSearchLimit, query }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (!response.ok) {
          return null;
        }
        const payload: unknown = await response.json();
        const rows = searchFacts(payload);
        if (rows.length === 0) {
          return null;
        }
        return {
          messages: rows.map((row) => ({
            content: `${row.subject}: ${row.fact}`,
            id: `fact-${row.id}`,
          })),
        };
      } catch {
        return null;
      }
    },
  },
  async tools() {
    if (!(await memoryFeatureEnabled())) {
      return null;
    }
    return {
      search_memories: defineTool({
        description:
          "Search durable facts and dated events by meaning. Each result names its source as sourceType and sourceId. When sourceType is \"entry\", call get_journal_entry with that sourceId to read the full journal text. Sources of type \"conversation\" have no fetch tool.",
        inputSchema: z.object({
          query: z.string().min(1),
          limit: z.number().int().min(1).max(25).optional(),
        }),
        async execute({ query, limit }) {
          if (!(await memoryFeatureEnabled())) {
            return [];
          }
          const take = limit ?? defaultSearchLimit;
          const body = JSON.stringify({ limit: take, query });
          const headers = { "content-type": "application/json" };
          const [factsResponse, eventsResponse] = await Promise.all([
            sageFetch("/memory/facts/search", {
              body,
              headers,
              method: "POST",
            }),
            sageFetch("/memory/events/search", {
              body,
              headers,
              method: "POST",
            }),
          ]);
          const factHits = searchFacts(await readSageJson(factsResponse));
          const eventHits = searchEvents(await readSageJson(eventsResponse));
          const merged: MemorySearchHit[] = [
            ...factHits.map((row) => ({
              fact: row.fact,
              kind: "fact" as const,
              score: row.score,
              sourceId: row.sourceId,
              sourceType: row.sourceType,
              subject: row.subject,
            })),
            ...eventHits.map((row) => ({
              event: row.event,
              kind: "event" as const,
              occurredAt: row.occurredAt,
              score: row.score,
              sourceId: row.sourceId,
              sourceType: row.sourceType,
            })),
          ];
          merged.sort(byScoreDescending);
          return merged.slice(0, take);
        },
      }),
    };
  },
});

export default defineMemory({
  description:
    "Durable facts about people and relationships from the journal and past chats.",
  provider,
  scope: byPrincipal,
});

interface FactHit {
  fact: string;
  id: number;
  score: number;
  sourceId: number;
  sourceType: string;
  subject: string;
}

interface EventHit {
  event: string;
  id: number;
  occurredAt: string;
  score: number;
  sourceId: number;
  sourceType: string;
}

type MemorySearchHit =
  | {
      fact: string;
      kind: "fact";
      score: number;
      sourceId: number;
      sourceType: string;
      subject: string;
    }
  | {
      event: string;
      kind: "event";
      occurredAt: string;
      score: number;
      sourceId: number;
      sourceType: string;
    };

function byScoreDescending(left: MemorySearchHit, right: MemorySearchHit): number {
  return right.score - left.score;
}

function searchFacts(payload: unknown): FactHit[] {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("results" in payload) ||
    !Array.isArray(payload.results)
  ) {
    return [];
  }
  const rows: FactHit[] = [];
  for (const item of payload.results) {
    if (
      item !== null &&
      typeof item === "object" &&
      "id" in item &&
      "fact" in item &&
      "subject" in item &&
      typeof item.id === "number" &&
      typeof item.fact === "string" &&
      typeof item.subject === "string"
    ) {
      const source = sourceOf(item);
      rows.push({
        fact: item.fact,
        id: item.id,
        score: scoreOf(item),
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        subject: item.subject,
      });
    }
  }
  return rows;
}

function searchEvents(payload: unknown): EventHit[] {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("results" in payload) ||
    !Array.isArray(payload.results)
  ) {
    return [];
  }
  const rows: EventHit[] = [];
  for (const item of payload.results) {
    if (
      item !== null &&
      typeof item === "object" &&
      "id" in item &&
      "event" in item &&
      typeof item.id === "number" &&
      typeof item.event === "string"
    ) {
      const source = sourceOf(item);
      const occurredAt =
        "occurredAt" in item && typeof item.occurredAt === "string"
          ? item.occurredAt
          : "";
      rows.push({
        event: item.event,
        id: item.id,
        occurredAt,
        score: scoreOf(item),
        sourceId: source.sourceId,
        sourceType: source.sourceType,
      });
    }
  }
  return rows;
}

function scoreOf(item: object): number {
  return "score" in item && typeof item.score === "number" ? item.score : 0;
}

function sourceOf(item: object): { sourceId: number; sourceType: string } {
  const sourceType =
    "sourceType" in item && typeof item.sourceType === "string"
      ? item.sourceType
      : "";
  const sourceId =
    "sourceId" in item && typeof item.sourceId === "number" ? item.sourceId : 0;
  return { sourceId, sourceType };
}
