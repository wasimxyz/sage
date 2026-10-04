import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import {
  journalIdFor,
  loadAllCases,
  requireSeededManifest,
  tagsFor,
} from "./lib/dataset.ts";
import { judgeClosedQA, judgeFactuality } from "./lib/judge.ts";
import {
  compareCurrentAndStale,
  currentOutranksStale,
} from "./lib/rank.ts";
import { listProfile, searchEvents, searchFacts } from "./lib/sage.ts";
import { skipEval } from "./lib/skip.ts";

const cases = await loadAllCases();
const evals = [];

for (const fixture of cases) {
  for (const [index, fact] of fixture.facts.entries()) {
    evals.push(
      defineEval({
        description: `${fixture.id}: fact ${index + 1} (${fact.subject})`,
        tags: tagsFor(fixture, "extraction"),
        async test(t) {
          requireSeededManifest();
          const [facts, profile] = await Promise.all([
            searchFacts(fact.reference, 10),
            listProfile(),
          ]);
          const texts = [
            ...facts.map((row) => `${row.subject}: ${row.fact}`),
            ...profile.map((row) => `${row.subject}: ${row.fact}`),
          ];
          t.check(
            texts.length,
            satisfies((n: number) => n > 0, "memory returned a fact")
          ).label("fact present");
          judgeFactuality(
            t,
            fact.reference,
            texts.join("\n"),
            "fact factuality"
          );
          if (fact.stale !== undefined) {
            const ranked = facts.map((row) => `${row.subject}: ${row.fact}`);
            const order = compareCurrentAndStale(
              ranked,
              fact.reference,
              fact.stale
            );
            if (order === "current-first" || order === "stale-first") {
              t.check(currentOutranksStale(order), equals(true))
                .soft()
                .label("current ranks above stale");
            }
            judgeClosedQA(
              t,
              `The memories include this current fact: ${fact.reference}. They must not describe only this older state: ${fact.stale}.`,
              texts.join("\n"),
              "current state outranks stale"
            );
          }
        },
      })
    );
  }

  for (const [index, event] of fixture.events.entries()) {
    evals.push(
      defineEval({
        description: `${fixture.id}: event ${index + 1} (entry ${event.entry})`,
        tags: tagsFor(fixture, "extraction"),
        async test(t) {
          const expectedSourceId = journalIdFor(
            requireSeededManifest(),
            fixture.id,
            event.entry
          );
          const events = await searchEvents(event.reference, 10);
          const texts = events.map((row) =>
            row.occurredAt.length > 0
              ? `${row.occurredAt}: ${row.event}`
              : row.event
          );
          t.check(
            texts.length,
            satisfies((n: number) => n > 0, "memory returned an event")
          ).label("event present");
          t.check(
            events.some((row) => row.sourceId === expectedSourceId),
            equals(true)
          ).label("event source id");
          judgeFactuality(
            t,
            event.reference,
            texts.join("\n"),
            "event factuality"
          );
        },
      })
    );
  }
}

export default evals.length > 0
  ? evals
  : [skipEval("No extraction cases in the dataset.")];
