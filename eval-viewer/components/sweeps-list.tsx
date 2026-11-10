import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { checkLabel } from "@/lib/reports/check-info.ts";
import { formatDate, formatRate, formatScore } from "@/lib/reports/format.ts";
import type { SweepListItem, SweepSummary } from "@/lib/reports/sweep-types.ts";
import { sweepHref } from "@/lib/reports/sweep-view.ts";

export function SweepsList({ sweeps }: { sweeps: SweepListItem[] }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-medium">Sweeps</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-muted-foreground">Sweep</TableHead>
            <TableHead className="text-muted-foreground">Date</TableHead>
            <TableHead className="text-muted-foreground">Setups</TableHead>
            <TableHead className="text-muted-foreground">Top setup</TableHead>
            <TableHead className="text-muted-foreground">Judge check</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sweeps.map((sweep) => (
            <SweepRow key={sweep.id} sweep={sweep} />
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function SweepRow({ sweep }: { sweep: SweepListItem }) {
  const { outcome } = sweep;
  return (
    <TableRow className="relative">
      <TableCell className="font-mono">
        <Link
          className="after:absolute after:inset-0"
          href={sweepHref(sweep.id)}
        >
          {sweep.id}
        </Link>
      </TableCell>
      <TableCell>
        {sweep.date === undefined ? "—" : formatDate(sweep.date)}
      </TableCell>
      {outcome.kind === "ok" ? (
        <OkCells summary={outcome.value} sweep={sweep} />
      ) : (
        <TableCell colSpan={3}>
          <Badge variant="destructive">
            {outcome.kind === "unsupported"
              ? "Unsupported report"
              : "Could not read"}
          </Badge>{" "}
          <span className="text-muted-foreground">{outcome.message}</span>
        </TableCell>
      )}
    </TableRow>
  );
}

function OkCells({
  summary,
  sweep,
}: {
  summary: SweepSummary;
  sweep: SweepListItem;
}) {
  return (
    <>
      <TableCell>{summary.ranking.length}</TableCell>
      <TableCell>
        <TopSetup top={sweep.top} />
      </TableCell>
      <TableCell>
        <JudgeCheckBadge summary={summary} />
      </TableCell>
    </>
  );
}

function TopSetup({ top }: { top: SweepListItem["top"] }) {
  if (top === undefined) {
    return <span className="text-muted-foreground">No setups ranked</span>;
  }
  const { entry } = top;
  return (
    <div className="flex flex-col">
      <span className="font-mono">{top.label}</span>
      <span className="text-muted-foreground text-xs">
        {formatRate(entry.countedRate)} counted failures · rubric{" "}
        {formatScore(entry.rubricMean)}
        {entry.passedHard
          ? ""
          : ` · failed ${entry.hardFailed.map(checkLabel).join(", ")}`}
      </span>
    </div>
  );
}

export function JudgeCheckBadge({ summary }: { summary: SweepSummary }) {
  if (summary.judgeCheckPassed) {
    return (
      <Badge className="text-pass" variant="secondary">
        Passed
      </Badge>
    );
  }
  const misses = summary.judgeCheckMisses.length;
  return (
    <Badge variant="destructive">
      {misses === 0
        ? "Failed"
        : `Failed · ${misses} ${misses === 1 ? "miss" : "misses"}`}
    </Badge>
  );
}
