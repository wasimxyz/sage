import { defineEval } from "eve/evals";

import { sharedGrader } from "../lib/grader.ts";
import {
  conversationCheckItemId,
  gradeConversationCheckItem,
  isConversationPlanted,
  loadConversationCheckItems,
  recordConversationJudgeCheck,
  resolveConversationCheckItem,
} from "../lib/judge-check-conversations.ts";
import { guardedEvals } from "../lib/pass.ts";
import { itemMetadata, makeItem } from "../lib/record.ts";
import { JUDGE_CHECK_PERSON, readPassEnv } from "../lib/schema.ts";

// The judge check, conversation half. Each labeled item is a short conversation
// about a real person. The judge grades it the way it grades a real
// conversation, and the check records `hard:judge-check`: a pass only when the
// checks the judge fails, each on its turn, are the ones the labels list. It
// runs before any setup, so it takes no person and no setup id. The person of
// an item is looked up when the item runs, so loading this file reads only the
// YAML.
export default await guardedEvals(
  "conversation judge-check",
  async () => {
    const items = await loadConversationCheckItems();
    const setupId = readPassEnv().setupId ?? "judge-check";
    return items.map((item) => {
      const ref = makeItem(
        {
          itemId: conversationCheckItemId(item),
          kind: "conversation",
          person: JUDGE_CHECK_PERSON,
        },
        setupId
      );
      return defineEval({
        description: `judge-check: conversation ${isConversationPlanted(item) ? "planted failure" : "clean item"} ${item.id}`,
        metadata: itemMetadata(ref),
        tags: ["judge-check", "conversations"],
        async test(t) {
          const resolved = await resolveConversationCheckItem(item);
          const result = await gradeConversationCheckItem(
            sharedGrader(),
            resolved
          );
          recordConversationJudgeCheck(t, ref, resolved, result);
        },
      });
    });
  },
  "No conversation judge-check items."
);
