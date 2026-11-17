import { defineEvalConfig } from "eve/evals";

import { sageEvalRecorder } from "./lib/recorder.ts";

const resultsPath = process.env.SAGE_EVAL_RESULTS;

// No judge model here. The cloud judge runs through lib/grader.ts, which
// counts every call against the sweep's spending cap, and eve's own
// `t.judge` is not used.
export default defineEvalConfig({
  maxConcurrency: 1,
  reporters:
    resultsPath === undefined || resultsPath.length === 0
      ? []
      : [sageEvalRecorder(resultsPath)],
  timeoutMs: 600_000,
});
