import Link from "next/link";
import { ReportProblem } from "@/components/report-problem";
import { Stat } from "@/components/stat";
import { JudgeCheckBadge } from "@/components/sweeps-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
  type RankingRow,
  rankingRows,
  setupHref,
} from "@/lib/reports/sweep-view.ts";

export function SweepReport({ sweep }: { sweep: SweepData }) {
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
        <SweepBody summary={summary.value} sweep={sweep} />
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
  sweep,
  summary,
}: {
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
            Setups that pass every hard check come first. Then the fewest
            counted failures, then the best rubric mean.
          </p>
        </div>
        <RankingTable rows={rows} sweepId={sweep.id} />
      </section>
    </>
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

function RankingTable({
  rows,
  sweepId,
}: {
  rows: RankingRow[];
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
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-muted-foreground">#</TableHead>
          <TableHead className="text-muted-foreground">Setup</TableHead>
          <TableHead className="text-muted-foreground">Hard checks</TableHead>
          <TableHead className="text-muted-foreground">
            Counted failures
          </TableHead>
          <TableHead className="text-muted-foreground">Rubric</TableHead>
          <TableHead className="text-muted-foreground">Spread</TableHead>
          <TableHead className="text-muted-foreground">
            First word, median
          </TableHead>
          <TableHead className="text-muted-foreground">
            First word, p90
          </TableHead>
          <TableHead className="text-muted-foreground">Graded</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <RankingTableRow
            key={row.entry.setupId}
            row={row}
            sweepId={sweepId}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function RankingTableRow({
  row,
  sweepId,
}: {
  row: RankingRow;
  sweepId: string;
}) {
  const { entry } = row;
  return (
    <TableRow>
      <TableCell className="text-muted-foreground font-mono">
        {row.rank}
      </TableCell>
      <TableCell>
        <SetupCell row={row} sweepId={sweepId} />
      </TableCell>
      <TableCell>
        {entry.passedHard ? (
          <Badge className="text-pass" variant="secondary">
            Passed
          </Badge>
        ) : (
          <div className="flex flex-col gap-1">
            <Badge variant="destructive">Failed</Badge>
            <span className="text-muted-foreground text-xs">
              {entry.hardFailed.map(checkLabel).join(", ")}
            </span>
          </div>
        )}
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
      <TableCell>
        {entry.incomplete ? (
          <Badge className="text-warn" variant="outline">
            Incomplete
          </Badge>
        ) : (
          "All"
        )}
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
