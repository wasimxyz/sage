import { defineDynamic, defineInstructions } from "eve/instructions";

import { memoryFeatureEnabled } from "../lib/memory-feature";
import { sageFetch } from "../lib/sage";

// eve runs this before every model call. The memo reads the profile once per
// session, as the session.started event did before eve 1.0.
export default defineDynamic(async (ctx) => {
  const content = await ctx.memo(["profile", ctx.session.id], () =>
    profileContent()
  );
  return content === null ? null : defineInstructions({ content });
});

async function profileContent(): Promise<string | null> {
  if (!(await memoryFeatureEnabled())) {
    return null;
  }
  const response = await sageFetch("/memory/profile").catch(() => null);
  if (response === null || !response.ok) {
    return null;
  }
  const facts = profileFacts(await response.json());
  if (facts.length === 0) {
    return null;
  }
  return [
    "Stable facts about the journal author, recalled from their journal:",
    ...facts.map((fact) => `- ${fact}`),
  ].join("\n");
}

function profileFacts(payload: unknown): string[] {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("facts" in payload) ||
    !Array.isArray(payload.facts)
  ) {
    return [];
  }
  const rows: string[] = [];
  for (const item of payload.facts) {
    if (
      item !== null &&
      typeof item === "object" &&
      "fact" in item &&
      typeof item.fact === "string" &&
      item.fact.length > 0
    ) {
      rows.push(item.fact);
    }
  }
  return rows;
}
