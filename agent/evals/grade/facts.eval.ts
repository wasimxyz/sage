import { defineEval } from "eve/evals";

import { type LoadedPerson, loadPerson } from "../lib/dataset.ts";
import { gradeFactuality } from "../lib/grader.ts";
import { formatJournalContext } from "../lib/judge-context.ts";
import {
  type EvalDefinition,
  failEval,
  guardedEvals,
  tagsFor,
} from "../lib/pass.ts";
import { itemMetadata, makeItem, recordGraded } from "../lib/record.ts";
import { ENV_TODAY, parseItemId, type TranscriptRow } from "../lib/schema.ts";
import { loadTranscripts } from "../lib/transcripts.ts";

/** The reply Sage gave: the text of the last assistant turn. */
function replyOf(row: TranscriptRow): string | undefined {
  const reply = [...row.turns]
    .reverse()
    .find((turn) => turn.role === "assistant");
  return reply?.text;
}

function gradeEval(row: TranscriptRow, person: LoadedPerson): EvalDefinition {
  const key = parseItemId(row.itemId)?.key;
  const chat =
    key === undefined ? undefined : person.personCase.chat[Number(key) - 1];
  if (chat === undefined) {
    return failEval(
      `${row.itemId} (judge)`,
      new Error(`${person.id} has no chat question for ${row.itemId}.`)
    );
  }
  const item = makeItem(
    { itemId: row.itemId, kind: "chat", person: row.person },
    row.setupId,
    row.repeat
  );
  return defineEval({
    description: `${row.itemId}: chat factuality (judge)${row.repeat > 1 ? ` (repeat ${row.repeat})` : ""}`,
    metadata: itemMetadata(item),
    tags: tagsFor(person, "chat"),
    async test(t) {
      const reply = replyOf(row) ?? "";
      if (row.ended === "error" || reply.trim() === "") {
        t.skip("Generation did not produce a reply to grade.");
      }
      const graded = await gradeFactuality({
        context: formatJournalContext(person, {
          today: process.env[ENV_TODAY],
        }),
        label: `chat-factuality ${row.itemId}`,
        output: reply,
        question: chat.question,
        reference: chat.reference,
      });
      recordGraded(
        t,
        item,
        { checkId: "chat-factuality", tier: "soft" },
        graded
      );
    },
  });
}

export default await guardedEvals(
  "chat grade",
  async () => {
    const rows = loadTranscripts().filter((row) => row.kind === "chat");
    const ids = [...new Set(rows.map((row) => row.person))];
    const loaded = await Promise.all(ids.map((id) => loadPerson(id)));
    const people = new Map<string, LoadedPerson>(
      ids.map((id, index) => [id, loaded[index]])
    );
    return rows.flatMap((row) => {
      const person = people.get(row.person);
      return person === undefined ? [] : [gradeEval(row, person)];
    });
  },
  "No generated chat transcripts. Run make eval so the chat pass writes them."
);
