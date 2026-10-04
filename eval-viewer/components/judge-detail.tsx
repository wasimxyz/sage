import type { ReactNode } from "react";

import type { JudgeDetail } from "@/lib/reports/types.ts";

export function JudgeBody({ judge }: { judge: JudgeDetail }) {
  const judgeLabel =
    judge.judgeModel === undefined
      ? "Judge rationale"
      : `Judge (${judge.judgeModel}) rationale`;
  return (
    <>
      <DetailField label="Prompt">
        <TextValue>{judge.prompt}</TextValue>
      </DetailField>
      <DetailField label="Expected answer">
        <TextValue>{judge.expected}</TextValue>
      </DetailField>
      <DetailField label="What the agent returned">
        {judge.output.length > 0 ? (
          <TextValue>{judge.output}</TextValue>
        ) : (
          <EmptyValue>(no answer returned)</EmptyValue>
        )}
      </DetailField>
      <DetailField label={judgeLabel}>
        <TextValue>{judge.rationale ?? "—"}</TextValue>
      </DetailField>
    </>
  );
}

export function DetailField({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-dashed pb-3 last:border-b-0 last:pb-0">
      <p className="text-muted-foreground text-xs">{label}</p>
      {children}
    </div>
  );
}

export function TextValue({ children }: { children: string }) {
  return <p>{children}</p>;
}

export function MonoValue({ children }: { children: string }) {
  return <p className="font-mono">{children}</p>;
}

export function EmptyValue({ children }: { children: string }) {
  return <p className="text-muted-foreground italic">{children}</p>;
}
