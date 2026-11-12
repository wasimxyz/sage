import { defineEval } from "eve/evals";

import { sharedGrader } from "../lib/grader.ts";
import {
  gradeReplyCheckItem,
  isReplyPlanted,
  loadReplyCheckItems,
  recordReplyJudgeCheck,
  replyCheckItemId,
  resolveReplyCheckItem,
} from "../lib/judge-check.ts";
import { guardedEvals } from "../lib/pass.ts";
import { itemMetadata, makeItem } from "../lib/record.ts";
import { JUDGE_CHECK_PERSON, readPassEnv } from "../lib/schema.ts";

// The judge check, Chat half. Each labeled item is a reply to a real opener of
// a real person. The judge grades it the way it grades a real reply, and the
// check records `hard:judge-check`: a pass only when the checks the judge fails
// are the ones the labels list. It runs before any setup, so it takes no person
// and no setup id. The person and the opener of an item are looked up when the
// item runs, so loading this file reads only the YAML.
export default await guardedEvals(
  "reply judge-check",
  async () => {
    const items = await loadReplyCheckItems();
    const setupId = readPassEnv().setupId ?? "judge-check";
    return items.map((item) => {
      const ref = makeItem(
        {
          itemId: replyCheckItemId(item),
          kind: "opener",
          person: JUDGE_CHECK_PERSON,
        },
        setupId
      );
      return defineEval({
        description: `judge-check: reply ${isReplyPlanted(item) ? "planted failure" : "clean item"} ${item.id}`,
        metadata: itemMetadata(ref),
        tags: ["judge-check", "replies"],
        async test(t) {
          const resolved = await resolveReplyCheckItem(item);
          const result = await gradeReplyCheckItem(sharedGrader(), resolved);
          recordReplyJudgeCheck(t, ref, resolved, result);
        },
      });
    });
  },
  "No reply judge-check items."
);
