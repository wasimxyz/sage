import { defineEval } from "eve/evals";

import { rangeFromWhen, todayFromEnv } from "../../agent/lib/when.ts";
import { journalIdFor, loadManifest, resolveEntry } from "../lib/dataset.ts";
import { personEvals, tagsFor } from "../lib/pass.ts";
import {
  itemMetadata,
  makeItem,
  personItemId,
  recordCheck,
} from "../lib/record.ts";
import { searchJournal } from "../lib/sage.ts";

/** How many hits to read, so the expected entry's rank shows even when it is not first. */
const HITS_TO_READ = 10;

// An item that sets `when` is read the way the tool reads it, against the
// fixed day the runner sets in SAGE_TODAY.
function rangeFor(when: string | undefined) {
  return rangeFromWhen(when ?? "", todayFromEnv()) ?? undefined;
}

export default await personEvals("retrieval", ({ pass, person }) =>
  person.personCase.retrieval.map((retrieval, index) => {
    const entry = resolveEntry(person, retrieval.expectEntry);
    const item = makeItem(
      {
        itemId: personItemId(person.id, "retrieval", index + 1),
        kind: "retrieval",
        person: person.id,
      },
      pass.setupId
    );
    return defineEval({
      description: `${person.id}: retrieval ${index + 1} (${entry.stem})`,
      metadata: itemMetadata(item),
      tags: tagsFor(person, "retrieval"),
      async test(t) {
        const expectedId = journalIdFor(loadManifest(), person.id, entry);
        const hits = await searchJournal(
          retrieval.query,
          HITS_TO_READ,
          rangeFor(retrieval.when)
        );
        const hitIds = hits.map((hit) => hit.id);
        const position = hitIds.indexOf(expectedId);
        const rank = position < 0 ? null : position + 1;
        const extra = {
          expectedId,
          hitIds,
          query: retrieval.query,
          rank,
          ...(retrieval.when === undefined ? {} : { when: retrieval.when }),
        };
        recordCheck(t, item, {
          checkId: "retrieval-top-hit",
          extra,
          pass: rank === 1,
          reason:
            rank === 1
              ? undefined
              : `The expected entry ${rank === null ? "was not in the top hits" : `ranked ${rank}`}.`,
          tier: "counted",
        });
        // 1 for the top hit, 1/2 for second, and so on; 0 when it is missing.
        recordCheck(t, item, {
          checkId: "retrieval-rank",
          extra,
          score: rank === null ? 0 : 1 / rank,
          tier: "soft",
        });
      },
    });
  })
);
