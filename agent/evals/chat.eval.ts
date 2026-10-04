import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  loadAllCases,
  requireSeededManifest,
  tagsFor,
} from "./lib/dataset.ts";
import { chatModel } from "./lib/models.ts";
import { skipEval } from "./lib/skip.ts";
import { appendChatTranscript } from "./lib/transcripts.ts";

const cases = await loadAllCases();
const model = chatModel();
const evals = [];

for (const fixture of cases) {
  for (const [index, item] of fixture.chat.entries()) {
    const expectTool = item.expectTool === true;
    const tags = tagsFor(fixture, "chat");
    evals.push(
      defineEval({
        description: `${fixture.id}: chat ${index + 1}`,
        tags,
        metadata: {
          caseId: fixture.id,
          expectTool,
          index,
          model,
          question: item.question,
          reference: item.reference,
        },
        async test(t) {
          requireSeededManifest();
          const turn = await t.send(item.question, {
            headers: {
              "x-sage-model": model,
              "x-sage-think": "0",
            },
          });
          t.succeeded();
          if (expectTool) {
            t.check(
              turn.toolCalls.some(
                (call) =>
                  call.status === "completed" &&
                  (call.name === "search_journal" ||
                    call.name === "facts__search_memories")
              ),
              equals(true)
            )
              .soft()
              .label("searched journal or memories");
          }
          appendChatTranscript({
            caseId: fixture.id,
            expectTool,
            index,
            model,
            question: item.question,
            reference: item.reference,
            reply: turn.message ?? "",
            tags,
          });
        },
      })
    );
  }
}

export default evals.length > 0
  ? evals
  : [skipEval("No chat cases in the dataset.")];
