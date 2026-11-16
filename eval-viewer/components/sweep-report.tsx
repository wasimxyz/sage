import Link from "next/link";
import { ReportProblem } from "@/components/report-problem";
import { Stat } from "@/components/stat";
import { JudgeCheckBadge } from "@/components/sweeps-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { checkLabel } from "@/lib/reports/check-info.ts";
import {
  formatDate,
  formatHours,
  formatMegabytes,
  formatMs,
  formatRate,
  formatScore,
  formatSpread,
  formatUsd,
} from "@/lib/reports/format.ts";
import type {
  JudgeCheckMiss,
  SweepData,
  SweepSummary,
} from "@/lib/reports/sweep-types.ts";
import {
  nextRankingSort,
  type RankingRow,
  type RankingSort,
  type RankingSortKey,
  rankingRows,
  rankingSortHref,
  setupHref,
  sortRankingRows,
  sweepHref,
} from "@/lib/reports/sweep-view.ts";

export function SweepReport({
  sort,
  sweep,
}: {
  sort: RankingSort;
  sweep: SweepData;
}) {
  const { summary } = sweep;
  return (
    <div className="flex flex-col gap-8">
      <Link
        className="text-muted-foreground w-fit text-sm underline-offset-4 hover:underline"
        href="/"
      >
        ← Back to overview
      </Link>
      {summary.kind === "ok" ? (
        <SweepBody sort={sort} summary={summary.value} sweep={sweep} />
      ) : (
        <>
          <h1 className="font-mono text-2xl font-medium tracking-tight">
            {sweep.id}
          </h1>
          <ReportProblem
            kind={summary.kind}
            message={summary.message}
            what="sweep summary"
          />
        </>
      )}
    </div>
  );
}

function SweepBody({
  sort,
  sweep,
  summary,
}: {
  sort: RankingSort;
  sweep: SweepData;
  summary: SweepSummary;
}) {
  const rows = rankingRows(summary, sweep.reports);
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex min-w-60 flex-1 flex-col gap-2">
          <h1 className="font-mono text-2xl font-medium tracking-tight">
            {sweep.id}
          </h1>
          <p className="text-muted-foreground text-sm">
            {sweep.date === undefined ? "Date unknown" : formatDate(sweep.date)}
            {summary.sweepFile.length > 0 ? ` · ${summary.sweepFile}` : ""}
            {summary.tests.length > 0 ? ` · ${summary.tests.join(", ")}` : ""}
            {summary.tags.length > 0
              ? ` · tags ${summary.tags.join(", ")}`
              : ""}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <p className="text-muted-foreground text-xs">Judge check</p>
          <JudgeCheckBadge summary={summary} />
        </div>
      </div>

      <JudgeCheckMisses
        misses={summary.judgeCheckMisses}
        passed={summary.judgeCheckPassed}
      />

      <Card size="sm">
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Setups" value={summary.ranking.length} />
          <Stat label="Repeats" value={summary.repeats ?? "—"} />
          <Stat
            label="Time, estimated · actual"
            value={`${formatHours(summary.estimate.hours)} · ${formatHours(summary.actual.hours)}`}
          />
          <Stat
            label="Cost, estimated · actual"
            value={`${formatUsd(summary.estimate.costUsd)} · ${formatUsd(summary.actual.costUsd)}`}
          />
        </CardContent>
      </Card>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">Ranking</h2>
          <p className="text-muted-foreground text-sm">
            {sort.key === "rank"
              ? "Sorted in the runner's order. Click a heading to sort by it."
              : "Sorted by a column. Click # to go back to the runner's order."}
          </p>
        </div>
        <RankingLegend />
        <RankingTable rows={rows} sort={sort} sweepId={sweep.id} />
      </section>
    </>
  );
}

function RankingLegend() {
  return (
    <details className="bg-card rounded-lg border text-sm" open>
      <summary className="px-4 py-3 font-medium">How the ranking works</summary>
      <div className="text-muted-foreground flex flex-col gap-2 border-t px-4 py-3">
        <ol className="flex list-decimal flex-col gap-1 pl-5">
          <li>
            Setups with every item graded rank before incomplete ones. A rate
            over part of the items is not one to rank by.
          </li>
          <li>
            In each of those groups, setups that pass every hard check come
            first. The rest name what failed.
          </li>
          <li>
            Then the lowest counted-failure rate: the counted failures per
            graded item.
          </li>
          <li>
            Then the highest rubric mean. Means within 0.05 tie. A tie goes to
            the lower spread, then the faster median first word.
          </li>
        </ol>
        <p>
          Spread is how far the rubric mean moves across repeats. It is empty
          with one repeat. Cost and p90 show how a setup ran and do not set the
          rank. The median first word and the swap growth feed the hard checks
          Fast enough and Fits in memory. The p90 does only when the sweep sets
          a p90 limit.
        </p>
        <p>
          To compare two setups side by side, pick A and B in the last columns
          and press Compare.
        </p>
      </div>
    </details>
  );
}

function JudgeCheckMisses({
  misses,
  passed,
}: {
  misses: JudgeCheckMiss[];
  passed: boolean;
}) {
  if (passed) {
    return null;
  }
  return (
    <Alert variant="destructive">
      <AlertTitle>The judge check did not pass</AlertTitle>
      <AlertDescription>
        {misses.length === 0 ? (
          "The summary lists no misses."
        ) : (
          <ul className="flex flex-col gap-1">
            {misses.map((miss) => (
              <li key={`${miss.itemId}-${miss.check}`}>
                <span className="font-mono">{miss.itemId}</span> ·{" "}
                {miss.kind === "false-alarm" ? "false alarm" : "missed"} ·{" "}
                {checkLabel(miss.check)}
                {miss.detail.length > 0 ? `. ${miss.detail}` : ""}
              </li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

const sortableColumns: { key: RankingSortKey; label: string }[] = [
  { key: "hard", label: "Hard checks" },
  { key: "counted", label: "Counted failures" },
  { key: "rubric", label: "Rubric mean" },
  { key: "spread", label: "Spread" },
  { key: "median", label: "First word, median" },
  { key: "p90", label: "First word, p90" },
  { key: "swap", label: "Swap growth" },
  { key: "cost", label: "Cost" },
  { key: "graded", label: "Graded" },
];

const ariaSort = { asc: "ascending", desc: "descending" } as const;
const arrow = { asc: "↑", desc: "↓" } as const;

function RankingTable({
  rows,
  sort,
  sweepId,
}: {
  rows: RankingRow[];
  sort: RankingSort;
  sweepId: string;
}) {
  if (rows.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No setups in the ranking</EmptyTitle>
          <EmptyDescription>
            The summary for this sweep has an empty ranking.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const sorted = sortRankingRows(rows, sort);
  const comparable = rows.filter((row) => row.state === "ok");
  return (
    <form
      action={`${sweepHref(sweepId)}/compare`}
      className="flex flex-col gap-4"
      method="get"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <SortHead
              column={{ key: "rank", label: "#" }}
              sort={sort}
              sweepId={sweepId}
            />
            <TableHead className="text-muted-foreground whitespace-normal">
              Setup
            </TableHead>
            {sortableColumns.map((column) => (
              <SortHead
                column={column}
                key={column.key}
                sort={sort}
                sweepId={sweepId}
              />
            ))}
            <TableHead className="text-muted-foreground whitespace-normal">
              Compare
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => (
            <RankingTableRow
              defaultA={comparable[0]?.entry.setupId}
              defaultB={comparable[1]?.entry.setupId}
              key={row.entry.setupId}
              row={row}
              sweepId={sweepId}
            />
          ))}
        </TableBody>
      </Table>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={comparable.length < 2} type="submit">
          Compare setups
        </Button>
        <span className="text-muted-foreground text-sm">
          {comparable.length < 2
            ? "Comparing needs two setups with a readable report."
            : "Pick A and B in the last column."}
        </span>
      </div>
    </form>
  );
}

function SortHead({
  column,
  sort,
  sweepId,
}: {
  column: { key: RankingSortKey; label: string };
  sort: RankingSort;
  sweepId: string;
}) {
  const active = sort.key === column.key;
  return (
    <TableHead
      aria-sort={active ? ariaSort[sort.dir] : undefined}
      className={
        column.key === "rank"
          ? "text-muted-foreground whitespace-nowrap"
          : "text-muted-foreground whitespace-normal"
      }
    >
      <Link
        className="hover:text-foreground underline-offset-4 hover:underline"
        href={rankingSortHref(sweepId, nextRankingSort(sort, column.key))}
      >
        {column.label}
        {active ? ` ${arrow[sort.dir]}` : ""}
      </Link>
    </TableHead>
  );
}

function HardCell({ row }: { row: RankingRow }) {
  if (row.entry.passedHard) {
    return (
      <Badge className="text-pass" variant="secondary">
        Passed
      </Badge>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Badge variant="destructive">Failed</Badge>
      <ul className="text-muted-foreground flex flex-col gap-0.5 text-xs">
        {row.hardFailures.map((failure) => (
          <li key={failure.id}>
            {checkLabel(failure.id)}
            {failure.count > 1 ? ` (${failure.count})` : ""}
            {failure.detail.length > 0 ? `: ${failure.detail}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RankingTableRow({
  defaultA,
  defaultB,
  row,
  sweepId,
}: {
  defaultA?: string;
  defaultB?: string;
  row: RankingRow;
  sweepId: string;
}) {
  const { entry } = row;
  const { setupId } = entry;
  return (
    <TableRow>
      <TableCell className="text-muted-foreground font-mono">
        {row.rank}
      </TableCell>
      <TableCell>
        <SetupCell row={row} sweepId={sweepId} />
      </TableCell>
      <TableCell className="whitespace-normal">
        <HardCell row={row} />
      </TableCell>
      <TableCell className="font-mono">
        {formatRate(entry.countedRate)}
      </TableCell>
      <TableCell className="font-mono">
        {formatScore(entry.rubricMean)}
      </TableCell>
      <TableCell className="font-mono">{formatSpread(entry.spread)}</TableCell>
      <TableCell className="font-mono">
        {formatMs(entry.firstWordMedianMs)}
      </TableCell>
      <TableCell className="font-mono">{formatMs(row.p90Ms)}</TableCell>
      <TableCell className="font-mono">
        {formatMegabytes(row.swapGrowthMB)}
      </TableCell>
      <TableCell className="font-mono">{formatUsd(row.costUsd)}</TableCell>
      <TableCell>
        {entry.incomplete ? (
          <Badge className="text-warn" variant="outline">
            Incomplete
          </Badge>
        ) : (
          "All"
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-3">
          {(["a", "b"] as const).map((side) => (
            <label className="flex items-center gap-1 text-xs" key={side}>
              <input
                className="accent-primary size-4"
                defaultChecked={
                  (side === "a" ? defaultA : defaultB) === setupId
                }
                disabled={row.state !== "ok"}
                name={side}
                type="radio"
                value={setupId}
              />
              {side.toUpperCase()}
            </label>
          ))}
        </div>
      </TableCell>
    </TableRow>
  );
}

const stateNote: Record<string, string> = {
  invalid: "Could not read the report",
  missing: "No report file",
  unsupported: "Unsupported report",
};

function SetupCell({ row, sweepId }: { row: RankingRow; sweepId: string }) {
  const note = stateNote[row.state];
  return (
    <div className="flex flex-col">
      {row.state === "missing" ? (
        <span className="font-mono">{row.label}</span>
      ) : (
        <Link
          className="font-mono underline-offset-4 hover:underline"
          href={setupHref(sweepId, row.entry.setupId)}
        >
          {row.label}
        </Link>
      )}
      <span className="text-muted-foreground font-mono text-xs">
        {row.entry.setupId}
        {note === undefined ? "" : ` · ${note}`}
      </span>
    </div>
  );
}
