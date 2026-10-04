import type { EveEvalContext } from "eve/evals";

type JudgeHost = Pick<EveEvalContext, "judge">;

export function judgeFactuality(
  t: JudgeHost,
  reference: string,
  output: string,
  label: string
): void {
  t.judge({
    state: { output, reference },
    questions: {
      factuality: {
        type: "boolean",
        instructions:
          "Is the output factually consistent with the reference? Paraphrase is allowed.",
      },
    },
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
    state: { output, reference },
    questions: {
      quality: {
        type: "boolean",
        instructions:
          "Does the output summarize the reference without adding unsupported claims?",
      },
    },
  }).quality.label(label);
}
