import { defineEval } from "eve/evals";

import { journalIdFor, loadManifest, resolveEntry } from "../lib/dataset.ts";
import { gradeSummary } from "../lib/grader.ts";
import { formatJournalContext } from "../lib/judge-context.ts";
import { personEvals, tagsFor } from "../lib/pass.ts";
import {
  itemMetadata,
  makeItem,
  personItemId,
  recordCheck,
  recordGraded,
} from "../lib/record.ts";
import { ENV_TODAY } from "../lib/schema.ts";
import { summaryForEntry } from "../lib/store.ts";

export default await personEvals("summaries", ({ pass, person }) => {
  const context = formatJournalContext(person, {
    today: process.env[ENV_TODAY],
  });
  return person.personCase.summaries.map((summary, index) => {
    const entry = resolveEntry(person, summary.entry);
    const item = makeItem(
      {
        itemId: personItemId(person.id, "summary", index + 1),
        kind: "summary",
        person: person.id,
      },
      pass.setupId
    );
    return defineEval({
      description: `${person.id}: summary of entry ${entry.index} (${entry.title})`,
      metadata: itemMetadata(item),
      tags: tagsFor(person, "summaries"),
      async test(t) {
        const id = journalIdFor(loadManifest(), person.id, entry);
        const text = await summaryForEntry(id, entry.title);
        const exists = text !== null && text.trim().length > 0;
        recordCheck(t, item, {
          checkId: "summary-exists",
          pass: exists,
          reason: exists ? undefined : "Dream wrote no summary for this entry.",
          tier: "counted",
        });
        if (!exists) {
          recordCheck(t, item, {
            checkId: "summary-quality",
            pass: false,
            reason: "There is no summary to grade.",
            tier: "soft",
          });
          return;
        }
        const graded = await gradeSummary({
          context,
          label: `summary-quality ${item.itemId}`,
          output: text,
          reference: summary.reference,
        });
        recordGraded(
          t,
          item,
          { checkId: "summary-quality", tier: "soft" },
          graded
        );
      },
    });
  });
});
