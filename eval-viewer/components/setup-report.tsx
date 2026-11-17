import Link from "next/link";

import { CheckList } from "@/components/check-list";
import { Stat } from "@/components/stat";
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
  formatMegabytes,
  formatMs,
  formatRate,
  formatScore,
  formatSpread,
  formatTime,
  formatUsd,
} from "@/lib/reports/format.ts";
import {
  dimensionKeys,
  type ReportItem,
  type ReportTurn,
  type SetupReport,
} from "@/lib/reports/sweep-types.ts";
import {
  compareHref,
  dimensionLabel,
  dreamHref,
  failedCheckCount,
  itemHref,
  setupLabel,
  sweepHref,
} from "@/lib/reports/sweep-view.ts";

export function SetupReportView({ report }: { report: SetupReport }) {
  const { summary } = report;
  const failedHard = summary.hardFailures.length > 0;
  return (
    <div className="flex flex-col gap-8">
      <Link
        className="text-muted-foreground w-fit text-sm underline-offset-4 hover:underline"
        href={sweepHref(report.sweepId)}
      >
        ← Back to sweep {report.sweepId}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex min-w-60 flex-1 flex-col gap-2">
          <h1 className="font-mono text-2xl font-medium tracking-tight">
            {setupLabel(report.setup)}
          </h1>
          <p className="text-muted-foreground font-mono text-sm">
            {report.setupId} · {report.sweepId}
            {report.gitCommit.length > 0 ? ` · ${report.gitCommit}` : ""}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <p className="text-muted-foreground text-xs">Hard checks</p>
          {failedHard ? (
            <Badge variant="destructive">Failed</Badge>
          ) : (
            <Badge className="text-pass" variant="secondary">
              Passed
            </Badge>
          )}
        </div>
      </div>

      <nav
        aria-label="Pages for this setup"
        className="flex flex-wrap gap-4 text-sm"
      >
        <Link
          className="underline-offset-4 hover:underline"
          href={compareHref(report.sweepId, report.setupId, "")}
        >
          Compare with another setup →
        </Link>
        {report.items.some((item) => item.dream !== undefined) ? (
          <Link
            className="underline-offset-4 hover:underline"
            href={dreamHref(report.sweepId, report.setupId)}
          >
            Dream accuracy →
          </Link>
        ) : null}
      </nav>

      <Notices report={report} />

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-medium">Setup</h2>
        <Card size="sm">
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {dimensionKeys.map((key) => (
              <Stat
                key={key}
                label={dimensionLabel[key]}
                value={report.setup[key]}
              />
            ))}
            <Stat
              label="Chat prompt sha"
              value={report.promptShas.chat || "—"}
            />
            <Stat
              label="Dream prompt sha"
              value={report.promptShas.dream ?? "built in"}
            />
            <Stat label="Judge" value={report.judgeModel || "—"} />
            <Stat
              label="People"
              value={report.people.length > 0 ? report.people.join(", ") : "—"}
            />
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-medium">Summary</h2>
        <Card size="sm">
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Counted failures"
              value={`${summary.countedFailures} · ${formatRate(summary.countedRate)}`}
            />
            <Stat label="Rubric mean" value={formatScore(summary.rubricMean)} />
            <Stat
              label="Rubric spread"
              value={formatSpread(summary.rubricSpread)}
            />
            <Stat label="Cost" value={formatUsd(summary.costUsd)} />
            <Stat
              label="First word, median"
              value={formatMs(summary.firstWordMedianMs)}
            />
            <Stat
              label="First word, p90"
              value={formatMs(summary.firstWordP90Ms)}
            />
            <Stat
              label="Swap growth"
              value={formatMegabytes(summary.swapGrowthMB)}
            />
            <Stat
              label="Model size"
              value={formatMegabytes(summary.modelSizeMB)}
            />
            <Stat label="Graded" value={summary.graded} />
            <Stat label="Not graded" value={summary.notGraded} />
            <Stat label="Skipped" value={summary.skipped} />
            <Stat
              label="Swap before"
              value={formatMegabytes(summary.swapBaselineMB)}
            />
            <Stat
              label="Searches · reads · tool calls"
              value={`${summary.toolUse.searches} · ${summary.toolUse.reads} · ${summary.toolUse.toolCalls}`}
            />
            <Stat
              label="Time in tools"
              value={formatMs(summary.toolUse.toolMs)}
            />
            <Stat
              label="Assistant turns counted"
              value={summary.toolUse.turns}
            />
            <Stat
              label="Simulated user, flagged after a crisis"
              value={`${summary.simulatedUser.flagged} of ${summary.simulatedUser.crisisConversations} · ${formatRate(summary.simulatedUser.rate)}`}
            />
          </CardContent>
        </Card>
      </section>

      <CountedChecks report={report} />
      <SoftChecks report={report} />
      <Items items={report.items} report={report} />
    </div>
  );
}

function Notices({ report }: { report: SetupReport }) {
  const { summary } = report;
  return (
    <>
      {summary.hardFailures.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>This setup failed a hard check</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">
              {summary.hardFailures.map((failure) => (
                <li key={failure.id}>
                  {checkLabel(failure.id)}
                  {failure.count > 1 ? ` (${failure.count})` : ""}
                  {failure.detail.length > 0 ? `: ${failure.detail}` : ""}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {summary.notGraded > 0 ? (
        <Alert>
          <AlertTitle>Incomplete</AlertTitle>
          <AlertDescription>
            {summary.notGraded}{" "}
            {summary.notGraded === 1 ? "item was" : "items were"} not graded
            because of a judge error or the spending cap.
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

function CountedChecks({ report }: { report: SetupReport }) {
  const rows = report.summary.countedByCheck;
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-medium">Counted checks</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-muted-foreground">Check</TableHead>
            <TableHead className="text-muted-foreground">Failures</TableHead>
            <TableHead className="text-muted-foreground">Graded</TableHead>
            <TableHead className="text-muted-foreground">Rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{checkLabel(row.id)}</TableCell>
              <TableCell className="font-mono">{row.failures}</TableCell>
              <TableCell className="font-mono">{row.graded}</TableCell>
              <TableCell className="font-mono">
                {formatRate(row.rate)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

/** Slips and search metrics: counted and shown, never ranked on. */
function SoftChecks({ report }: { report: SetupReport }) {
  const rows = report.summary.softByCheck;
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-medium">Slips and search</h2>
        <p className="text-muted-foreground text-sm">
          These are shown and never ranked on.
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-muted-foreground">Check</TableHead>
            <TableHead className="text-muted-foreground">Failures</TableHead>
            <TableHead className="text-muted-foreground">Graded</TableHead>
            <TableHead className="text-muted-foreground">Rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{checkLabel(row.id)}</TableCell>
              <TableCell className="font-mono">{row.failures}</TableCell>
              <TableCell className="font-mono">{row.graded}</TableCell>
              <TableCell className="font-mono">
                {formatRate(row.rate)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function Items({
  items,
  report,
}: {
  items: ReportItem[];
  report: SetupReport;
}) {
  const failing = items.filter((item) => failedCheckCount(item) > 0).length;
  return (
    <section className="flex scroll-mt-8 flex-col gap-4" id="items">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-medium">Items</h2>
        <p className="text-muted-foreground text-sm">
          {items.length} {items.length === 1 ? "item" : "items"} · {failing}{" "}
          with a failed check. Open a row for its checks.
        </p>
      </div>
      {items.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No items</EmptyTitle>
            <EmptyDescription>This report holds no items.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <ItemRow
              item={item}
              key={`${item.itemId}#${item.repeat}`}
              report={report}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ItemRow({ item, report }: { item: ReportItem; report: SetupReport }) {
  const failed = failedCheckCount(item);
  return (
    <details className="bg-card rounded-lg border">
      <summary className="grid w-full list-none grid-cols-1 gap-2 px-4 py-3 text-left text-sm md:grid-cols-[1fr_7rem_7rem_8rem] md:items-center [&::-webkit-details-marker]:hidden">
        <span className="font-mono font-medium break-all">{item.itemId}</span>
        <Badge variant="outline">{item.kind}</Badge>
        <StatusBadge status={item.status} />
        <span className="text-muted-foreground md:text-right">
          {failed > 0 ? `${failed} failed` : "no failures"}
          {item.repeat > 1 ? ` · repeat ${item.repeat}` : ""}
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t px-4 py-3 text-sm">
        <Link
          className="text-muted-foreground w-fit underline-offset-4 hover:underline"
          href={itemHref(report.sweepId, report.setupId, item)}
        >
          Read in full →
        </Link>
        {item.note === undefined ? null : (
          <p className="text-muted-foreground">{item.note}</p>
        )}
        {item.ended === undefined ? null : (
          <p className="text-muted-foreground">Ended: {item.ended}</p>
        )}
        <CheckList checks={item.checks} rubric={item.rubric} />
        {item.turns.map((turn) => (
          <Turn key={turn.position} turn={turn} />
        ))}
      </div>
    </details>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "graded") {
    return (
      <Badge className="text-pass" variant="secondary">
        graded
      </Badge>
    );
  }
  if (status === "not-graded") {
    return (
      <Badge className="text-warn" variant="outline">
        not graded
      </Badge>
    );
  }
  return <Badge variant="outline">{status}</Badge>;
}

function Turn({ turn }: { turn: ReportTurn }) {
  const who = turn.role === "user" ? "Person" : "Sage";
  return (
    <div className="flex flex-col gap-2 border-t border-dashed pt-3">
      <p className="text-muted-foreground text-xs">
        {who} · turn {turn.position}
        {turn.firstVisibleMs === null
          ? ""
          : ` · first word ${formatTime(turn.firstVisibleMs / 1000)}`}
        {turn.helpSeen.length > 0
          ? ` · help seen: ${turn.helpSeen.join(", ")}`
          : ""}
      </p>
      <p className="whitespace-pre-wrap">{turn.text}</p>
      {turn.error === undefined ? null : (
        <p className="text-fail">Error: {turn.error}</p>
      )}
      <CheckList checks={turn.checks} rubric={turn.rubric} />
    </div>
  );
}
