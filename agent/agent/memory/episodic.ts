import { defineMemory, defineMemoryProvider } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

import { memoryFeatureEnabled } from "../lib/memory-feature";
import { lastUserText } from "../lib/memory-text";
import { sageFetch } from "../lib/sage";

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
        const response = await sageFetch("/memory/events/search", {
          body: JSON.stringify({ limit: 5, query }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (!response.ok) {
          return null;
        }
        const payload: unknown = await response.json();
        const rows = searchEvents(payload);
        if (rows.length === 0) {
          return null;
        }
        return {
          messages: rows.map((row) => ({
            content:
              row.occurredAt.length > 0
                ? `${row.occurredAt}: ${row.event}`
                : row.event,
            id: `event-${row.id}`,
          })),
        };
      } catch {
        return null;
      }
    },
  },
});

export default defineMemory({
  description:
    "Specific things that happened, dated when the journal or chat recorded them.",
  provider,
  scope: byPrincipal,
});

function searchEvents(
  payload: unknown
): Array<{ event: string; id: number; occurredAt: string }> {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("results" in payload) ||
    !Array.isArray(payload.results)
  ) {
    return [];
  }
  const rows: Array<{ event: string; id: number; occurredAt: string }> = [];
  for (const item of payload.results) {
    if (
      item !== null &&
      typeof item === "object" &&
      "id" in item &&
      "event" in item &&
      typeof item.id === "number" &&
      typeof item.event === "string"
    ) {
      const occurredAt =
        "occurredAt" in item && typeof item.occurredAt === "string"
          ? item.occurredAt
          : "";
      rows.push({
        event: item.event,
        id: item.id,
        occurredAt,
      });
    }
  }
  return rows;
}
