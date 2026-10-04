import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  journalIdFor,
  loadAllCases,
  loadManifest,
  tagsFor,
} from "./lib/dataset.ts";
import { searchJournal } from "./lib/sage.ts";
import { skipEval } from "./lib/skip.ts";

const cases = await loadAllCases();
const evals = cases.flatMap((fixture) =>
  fixture.retrieval.map((item, index) =>
    defineEval({
      description: `${fixture.id}: retrieval ${index + 1}`,
      tags: tagsFor(fixture, "retrieval"),
      async test(t) {
        const expectedId = journalIdFor(
          loadManifest(),
          fixture.id,
          item.expectEntry
        );
        const hits = await searchJournal(item.query, 5);
        t.check(hits[0]?.id ?? null, equals(expectedId)).label("top hit");
      },
    })
  )
);

export default evals.length > 0
  ? evals
  : [skipEval("No retrieval cases in the dataset.")];
