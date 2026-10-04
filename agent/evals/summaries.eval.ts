import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import {
  journalIdFor,
  loadAllCases,
  loadManifest,
  tagsFor,
} from "./lib/dataset.ts";
import { judgeSummary } from "./lib/judge.ts";
import { skipEval } from "./lib/skip.ts";
import { summaryForEntry } from "./lib/store.ts";

const cases = await loadAllCases();
const evals = cases.flatMap((fixture) =>
  fixture.summaries.flatMap((summary) => {
    const entry = fixture.entries[summary.entry - 1];
    if (entry === undefined) {
      return [];
    }
    return [
      defineEval({
        description: `${fixture.id}: summary of entry ${summary.entry} (${entry.title})`,
        tags: tagsFor(fixture, "summaries"),
        async test(t) {
          const id = journalIdFor(loadManifest(), fixture.id, summary.entry);
          const text = await summaryForEntry(id, entry.title);
          t.check(
            text,
            satisfies(
              (value: string | null) =>
                value !== null && value.trim().length > 0,
              "summary text is present"
            )
          ).label("summary present");
          judgeSummary(t, summary.reference, text ?? "", "summary quality");
        },
      }),
    ];
  })
);

export default evals.length > 0
  ? evals
  : [skipEval("No summary cases in the dataset.")];
