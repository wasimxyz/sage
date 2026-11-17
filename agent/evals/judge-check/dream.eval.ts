import { defineEval } from "eve/evals";

import { sharedGrader } from "../lib/grader.ts";
import {
  gradeCheckItem,
  isPlanted,
  judgeCheckItemId,
  loadDreamCheckItems,
  recordJudgeCheck,
} from "../lib/judge-check.ts";
import { guardedEvals } from "../lib/pass.ts";
import { itemMetadata, makeItem } from "../lib/record.ts";
import { JUDGE_CHECK_PERSON, readPassEnv } from "../lib/schema.ts";

// The judge check, Dream half. It grades each labeled item with the judge the
// sweep names and records `hard:judge-check`: a pass only when the verdicts
// match the labels. It runs before any setup, so it takes no person and no
// setup id.
export default await guardedEvals(
  "Dream judge-check",
  async () => {
    const items = await loadDreamCheckItems();
    const setupId = readPassEnv().setupId ?? "judge-check";
    return items.map((item) => {
      const ref = makeItem(
        {
          itemId: judgeCheckItemId(item),
          kind: "dream-source",
          person: JUDGE_CHECK_PERSON,
        },
        setupId
      );
      return defineEval({
        description: `judge-check: Dream ${isPlanted(item) ? "planted failure" : "clean item"} ${item.id}`,
        metadata: itemMetadata(ref),
        tags: ["judge-check", "dream"],
        async test(t) {
          const result = await gradeCheckItem(sharedGrader(), item);
          recordJudgeCheck(t, ref, item, result);
        },
      });
    });
  },
  "No Dream judge-check items."
);
