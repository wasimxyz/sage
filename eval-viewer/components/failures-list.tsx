import Link from "next/link";
import {
  DetailField,
  JudgeBody,
  MonoValue,
  TextValue,
} from "@/components/judge-detail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { failureTypeLabel, formatTime } from "@/lib/reports/format.ts";
import {
  type CategoryId,
  type CategorySummary,
  categoryIds,
  type FailureRecord,
  type RetrievalDetail,
} from "@/lib/reports/types.ts";

export type FailureFilter = CategoryId | "all";

export function parseFailureFilter(value: string | undefined): FailureFilter {
  if (value === undefined || value === "all") {
    return "all";
  }
  if ((categoryIds as readonly string[]).includes(value)) {
    return value as CategoryId;
  }
  return "all";
}

export function FailuresList({
  categories,
  failures,
  filter,
  runId,
}: {
  categories: CategorySummary[];
  failures: FailureRecord[];
  filter: FailureFilter;
  runId: string;
}) {
  const counts: Record<string, number> = { all: failures.length };
  for (const category of categories) {
    counts[category.id] = failures.filter(
      (item) => item.category === category.id
    ).length;
  }
  const visible =
    filter === "all"
      ? failures
      : failures.filter((item) => item.category === filter);
  const chips = [
    { id: "all" as const, label: "All" },
    ...categories
      .filter((category) => (counts[category.id] ?? 0) > 0)
      .map((category) => ({ id: category.id, label: category.label })),
  ];

  if (failures.length === 0) {
    return <NoFailures />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <Button
            key={chip.id}
            nativeButton={false}
            render={<Link href={filterHref(runId, chip.id)} />}
            size="sm"
            variant={filter === chip.id ? "default" : "outline"}
          >
            {chip.label} ({counts[chip.id] ?? 0})
          </Button>
        ))}
      </div>
      {visible.length === 0 ? (
        <NoFailuresInCategory />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((failure) => (
            <FailureRow failure={failure} key={failure.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function filterHref(runId: string, filter: FailureFilter): string {
  if (filter === "all") {
    return `/runs/${runId}#failures`;
  }
  return `/runs/${runId}?category=${filter}#failures`;
}

function NoFailures() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>No failures</EmptyTitle>
        <EmptyDescription>
          Every non-skipped eval in this run passed its hard checks.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function NoFailuresInCategory() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>No failures in this category</EmptyTitle>
        <EmptyDescription>
          Try All, or pick another category that still has failed tests.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function FailureRow({ failure }: { failure: FailureRecord }) {
  const typeLabel = failureTypeLabel[failure.type] ?? failure.type;
  return (
    <details className="rounded-lg border bg-card">
      <summary className="grid w-full list-none grid-cols-1 gap-2 px-4 py-3 text-left text-sm md:grid-cols-[7rem_7rem_1fr_4rem] md:items-center [&::-webkit-details-marker]:hidden">
        <span className="font-medium font-mono">{failure.id}</span>
        <Badge
          variant={failure.type === "call_failed" ? "destructive" : "outline"}
        >
          {typeLabel}
        </Badge>
        <span className="truncate text-muted-foreground">
          {failure.message}
        </span>
        <span className="font-mono text-muted-foreground md:text-right">
          {formatTime(failure.time)}
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm">
        <FailureBody failure={failure} />
        {failure.badges.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {failure.badges.map((badge) => (
              <Badge
                key={badge.label}
                variant={badge.passed ? "secondary" : "destructive"}
              >
                {badge.label}
                {badge.score === undefined ? "" : ` · ${badge.score}`}
                <span className="text-muted-foreground"> {badge.severity}</span>
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function FailureBody({ failure }: { failure: FailureRecord }) {
  if (failure.type === "timeout") {
    return <TimeoutBody message={failure.message} />;
  }
  if (failure.type === "wrong_hit" && failure.retrieval !== undefined) {
    return <WrongHitBody retrieval={failure.retrieval} />;
  }
  if (failure.judge !== undefined) {
    return <JudgeBody judge={failure.judge} />;
  }
  return <CallFailedBody message={failure.message} />;
}

function CallFailedBody({ message }: { message: string }) {
  return (
    <>
      <DetailField label="Error">
        <TextValue>{message}</TextValue>
      </DetailField>
      <DetailField label="Note">
        <TextValue>
          No assertions ran — the call never returned, so there is nothing for
          the judge to grade.
        </TextValue>
      </DetailField>
    </>
  );
}

function TimeoutBody({ message }: { message: string }) {
  return (
    <>
      <DetailField label="Error">
        <TextValue>{message}</TextValue>
      </DetailField>
      <DetailField label="Note">
        <TextValue>
          The chat model timed out before it returned an answer, so there is
          nothing for the judge to grade.
        </TextValue>
      </DetailField>
    </>
  );
}

function WrongHitBody({ retrieval }: { retrieval: RetrievalDetail }) {
  return (
    <>
      <DetailField label="Expected top hit (journal id)">
        <MonoValue>{retrieval.expected}</MonoValue>
      </DetailField>
      <DetailField label="Actual top hit (journal id)">
        <MonoValue>{retrieval.actual}</MonoValue>
      </DetailField>
    </>
  );
}
