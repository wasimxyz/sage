import { Experimental_EvaluationLanguageModel } from "@ai-sdk/provider-utils/experimental-evaluation";
import { defineEvalConfig } from "eve/evals";
import { createOllama } from "ollama-ai-provider-v2";

import { judgeModelId, ollamaBaseURL } from "./lib/models.ts";
import { sageEvalRecorder } from "./lib/recorder.ts";

const ollama = createOllama({
  baseURL: ollamaBaseURL(),
});

const resultsPath = process.env.SAGE_EVAL_RESULTS;

export default defineEvalConfig({
  judge: {
    model: new Experimental_EvaluationLanguageModel({
      model: ollama(judgeModelId()),
      provider: "ollama",
    }),
  },
  maxConcurrency: 1,
  reporters:
    resultsPath === undefined || resultsPath.length === 0
      ? []
      : [sageEvalRecorder(resultsPath)],
  timeoutMs: 600_000,
});
