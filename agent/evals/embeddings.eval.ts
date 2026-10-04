import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { loadAllCases } from "./lib/dataset.ts";
import {
  collectEmbeddingTags,
  collectQueryTexts,
  embedQueryTexts,
  embeddingsPath,
  writeQueryEmbeddings,
} from "./lib/query-embeddings.ts";
import { skipEval } from "./lib/skip.ts";

const path = embeddingsPath();
const cases = path === undefined ? [] : await loadAllCases();
const texts = collectQueryTexts(cases);

export default path === undefined
  ? [
      skipEval(
        "No query embedding path. Run make eval so the runner sets SAGE_EVAL_EMBEDDINGS."
      ),
    ]
  : texts.length === 0
    ? [skipEval("No retrieval, extraction, or summary queries in the dataset.")]
    : [
        defineEval({
          description: "Embed eval search queries",
          tags: collectEmbeddingTags(cases),
          async test(t) {
            const rows = await embedQueryTexts(texts);
            writeQueryEmbeddings(rows);
            t.check(
              rows.length,
              satisfies(
                (count: number) => count === texts.length,
                "every query has an embedding"
              )
            ).label("embedding count");
            t.check(
              rows.every((row) => row.embedding.length > 0),
              satisfies((ok: boolean) => ok, "embeddings are non-empty")
            ).label("embedding present");
          },
        }),
      ];
