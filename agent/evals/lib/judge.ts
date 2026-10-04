import type { EveEvalContext } from "eve/evals";

type JudgeHost = Pick<EveEvalContext, "judge">;

export function judgeFactuality(
  t: JudgeHost,
  reference: string,
  output: string,
  label: string
): void {
  t.judge({
    questions: {
      factuality: {
        instructions:
          "Is the output factually consistent with the reference? Paraphrase is allowed.",
        type: "boolean",
      },
    },
    state: { output, reference },
  }).factuality.label(label);
}

export function judgeClosedQA(
  t: JudgeHost,
  criteria: string,
  output: string,
  label: string
): void {
  t.judge(criteria, { on: output }).label(label);
}

export function judgeSummary(
  t: JudgeHost,
  reference: string,
  output: string,
  label: string
): void {
  t.judge({
    questions: {
      quality: {
        instructions:
          "Does the output summarize the reference without adding unsupported claims?",
        type: "boolean",
      },
    },
    state: { output, reference },
  }).quality.label(label);
}
