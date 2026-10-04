import { defineEval } from "eve/evals";

export function skipEval(reason: string) {
  return defineEval({
    description: reason,
    async test(t) {
      t.skip(reason);
    },
  });
}
