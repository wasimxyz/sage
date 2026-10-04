import { JudgeBody } from "@/components/judge-detail";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { formatTime } from "@/lib/reports/format.ts";
import type { ChatScore } from "@/lib/reports/types.ts";

export function ChatScoresList({ scores }: { scores: ChatScore[] }) {
  if (scores.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No Chat rows</EmptyTitle>
          <EmptyDescription>
            This run had no Chat evals, or Chat generation was skipped.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {scores.map((score) => (
        <ChatScoreRow key={score.id} score={score} />
      ))}
    </div>
  );
}

function ChatScoreRow({ score }: { score: ChatScore }) {
  const judgeScore = score.judge?.score;
  return (
    <details className="rounded-lg border bg-card">
      <summary className="grid w-full list-none grid-cols-1 gap-2 px-4 py-3 text-left text-sm md:grid-cols-[7rem_7rem_1fr_4rem] md:items-center [&::-webkit-details-marker]:hidden">
        <span className="font-medium font-mono">{score.id}</span>
        <Badge variant={score.failed ? "destructive" : "secondary"}>
          {score.failed ? "failed" : "passed"}
        </Badge>
        <span className="truncate text-muted-foreground">
          {judgeScore === undefined
            ? "no judge score"
            : `factuality ${judgeScore}`}
        </span>
        <span className="font-mono text-muted-foreground md:text-right">
          {formatTime(score.time)}
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm">
        {score.judge === undefined ? (
          <p className="text-muted-foreground">
            {score.message.length > 0
              ? score.message
              : "No judge score was recorded for this turn."}
          </p>
        ) : (
          <JudgeBody judge={score.judge} />
        )}
      </div>
    </details>
  );
}
