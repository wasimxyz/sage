import { defineEval } from "eve/evals";

import { journalIdFor, loadManifest, resolveEntry } from "../lib/dataset.ts";
import {
  type Graded,
  gradeExtraction,
  gradeFactuality,
} from "../lib/grader.ts";
import { formatJournalContext } from "../lib/judge-context.ts";
import { personEvals, tagsFor } from "../lib/pass.ts";
import { compareCurrentAndStale, currentOutranksStale } from "../lib/rank.ts";
import {
  itemMetadata,
  makeItem,
  personItemId,
  recordCheck,
  recordGraded,
} from "../lib/record.ts";
import { listProfile, searchEvents, searchFacts } from "../lib/sage.ts";
import { ENV_TODAY } from "../lib/schema.ts";
import { memoryOn } from "../lib/setup.ts";

const MEMORY_OFF =
  "Memory is off in this setup, so Dream wrote no facts or events.";

/** A grade that needs no judge: memory returned nothing, so there is nothing to grade. */
function nothingReturned(model: string): Graded {
  return {
    evidence: "",
    model,
    notGraded: false,
    pass: false,
    reason: "Memory returned nothing for this reference.",
    rubric: "none",
  };
}

export default await personEvals("extraction", ({ pass, person }) => {
  const context = formatJournalContext(person, {
    today: process.env[ENV_TODAY],
  });
  const judgeModel = pass.sweep.judge.model;
  const base = { person: person.id };
  const gradeCurrentState = (
    fact: { reference: string; stale?: string },
    empty: boolean,
    label: string,
    output: string
  ): Promise<Graded> | undefined => {
    if (fact.stale === undefined) {
      return undefined;
    }
    return empty
      ? Promise.resolve(nothingReturned(judgeModel))
      : gradeExtraction({
          context,
          current: fact.reference,
          label: `current-state ${label}`,
          output,
          stale: fact.stale,
        });
  };

  const facts = person.personCase.facts.map((fact, index) => {
    const item = makeItem(
      {
        ...base,
        itemId: personItemId(person.id, "fact", index + 1),
        kind: "fact",
      },
      pass.setupId
    );
    return defineEval({
      description: `${person.id}: fact ${index + 1} (${fact.subject})`,
      metadata: itemMetadata(item),
      tags: tagsFor(person, "extraction"),
      async test(t) {
        if (!memoryOn(pass.setup)) {
          t.skip(MEMORY_OFF);
        }
        const [found, profile] = await Promise.all([
          searchFacts(fact.reference, 10),
          listProfile(),
        ]);
        const ranked = found.map((row) => `${row.subject}: ${row.fact}`);
        const texts = [
          ...ranked,
          ...profile.map((row) => `${row.subject}: ${row.fact}`),
        ];
        const output = texts.join("\n");
        recordCheck(t, item, {
          checkId: "memory-returns",
          pass: texts.length > 0,
          reason:
            texts.length > 0
              ? undefined
              : "Memory returned no fact for this reference.",
          tier: "counted",
        });
        if (fact.stale !== undefined) {
          const order = compareCurrentAndStale(
            ranked,
            fact.reference,
            fact.stale
          );
          if (order === "current-first" || order === "stale-first") {
            recordCheck(t, item, {
              checkId: "current-outranks-stale",
              extra: { order },
              pass: currentOutranksStale(order),
              tier: "soft",
            });
          }
        }
        const [factuality, currentState] = await Promise.all([
          texts.length === 0
            ? nothingReturned(judgeModel)
            : gradeFactuality({
                context,
                label: `fact-factuality ${item.itemId}`,
                output,
                reference: fact.reference,
              }),
          gradeCurrentState(fact, texts.length === 0, item.itemId, output),
        ]);
        recordGraded(
          t,
          item,
          { checkId: "fact-factuality", tier: "soft" },
          factuality
        );
        if (currentState !== undefined) {
          recordGraded(
            t,
            item,
            { checkId: "current-state", tier: "soft" },
            currentState
          );
        }
      },
    });
  });

  const events = person.personCase.events.map((event, index) => {
    const entry = resolveEntry(person, event.entry);
    const item = makeItem(
      {
        ...base,
        itemId: personItemId(person.id, "event", index + 1),
        kind: "event",
      },
      pass.setupId
    );
    return defineEval({
      description: `${person.id}: event ${index + 1} (entry ${entry.index}: ${entry.stem})`,
      metadata: itemMetadata(item),
      tags: tagsFor(person, "extraction"),
      async test(t) {
        if (!memoryOn(pass.setup)) {
          t.skip(MEMORY_OFF);
        }
        const expectedSourceId = journalIdFor(loadManifest(), person.id, entry);
        const found = await searchEvents(event.reference, 10);
        const texts = found.map((row) =>
          row.occurredAt.length > 0
            ? `${row.occurredAt}: ${row.event}`
            : row.event
        );
        recordCheck(t, item, {
          checkId: "memory-returns",
          pass: texts.length > 0,
          reason:
            texts.length > 0
              ? undefined
              : "Memory returned no event for this reference.",
          tier: "counted",
        });
        recordCheck(t, item, {
          checkId: "event-source",
          extra: {
            expectedSourceId,
            sourceIds: found.map((row) => row.sourceId),
          },
          pass: found.some((row) => row.sourceId === expectedSourceId),
          tier: "counted",
        });
        const factuality =
          texts.length === 0
            ? nothingReturned(judgeModel)
            : await gradeFactuality({
                context,
                label: `event-factuality ${item.itemId}`,
                output: texts.join("\n"),
                reference: event.reference,
              });
        recordGraded(
          t,
          item,
          { checkId: "event-factuality", tier: "soft" },
          factuality
        );
      },
    });
  });

  return [...facts, ...events];
});
