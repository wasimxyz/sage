import { defineEval } from "eve/evals";

import { judgeFactuality } from "./lib/judge.ts";
import { skipEval } from "./lib/skip.ts";
import { loadChatTranscripts } from "./lib/transcripts.ts";

const rows = loadChatTranscripts();
const evals = rows.map((row) =>
  defineEval({
    description: `${row.caseId}: chat ${row.index + 1} (judge)`,
    tags: row.tags,
    metadata: {
      caseId: row.caseId,
      expectTool: row.expectTool,
      index: row.index,
      model: row.model,
      question: row.question,
      reference: row.reference,
      reply: row.reply,
    },
    async test(t) {
      judgeFactuality(t, row.reference, row.reply, "chat factuality");
    },
  })
);

export default evals.length > 0
  ? evals
  : [
      skipEval(
        "No generated chat transcripts. Run make eval so phase 1 writes them."
      ),
    ];
