import Link from "next/link";

import { CheckRowList } from "@/components/check-list";
import { ReportProblem } from "@/components/report-problem";
import { TurnBlock } from "@/components/transcript";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type ComparedItem,
  type CompareQuery,
  compareLabels,
  filterCompared,
  filterOptions,
  filterParams,
  missingCounts,
  pairItems,
  summaryRows,
} from "@/lib/reports/compare.ts";
import {
  exchangeCount,
  exchangeNumbers,
  failuresFirst,
  firstUserMessage,
  itemCheckRows,
  itemShortId,
  splitShown,
} from "@/lib/reports/item-view.ts";
import type {
  ReportItem,
  SetupReport,
  SweepData,
  SweepSummary,
} from "@/lib/reports/sweep-types.ts";
import {
  compareHref,
  failedCheckCount,
  itemHref,
  setupHref,
  setupLabel,
  sweepHref,
} from "@/lib/reports/sweep-view.ts";

export function CompareView({
  query,
  sweep,
}: {
  query: CompareQuery;
  sweep: SweepData;
}) {
  const { summary } = sweep;
  return (
    <div className="flex flex-col gap-8">
      <Link
        className="text-muted-foreground w-fit text-sm underline-offset-4 hover:underline"
        href={sweepHref(sweep.id)}
      >
        ← Back to sweep {sweep.id}
      </Link>
      <h1 className="text-2xl font-medium tracking-tight">Compare setups</h1>
      {summary.kind === "ok" ? (
        <CompareBody query={query} summary={summary.value} sweep={sweep} />
      ) : (
        <ReportProblem
          kind={summary.kind}
          message={summary.message}
          what="sweep summary"
        />
      )}
    </div>
  );
}

interface SetupChoice {
  label: string;
  report: SetupReport;
}

/** The setups that have a readable report, in the runner's ranking order. */
function setupChoices(summary: SweepSummary, sweep: SweepData): SetupChoice[] {
  const ranked = summary.ranking.map((entry) => entry.setupId);
  const seen = new Set(ranked);
  const ids = [
    ...ranked,
    ...[...sweep.reports.keys()].filter((id) => !seen.has(id)),
  ];
  return ids.flatMap((id) => {
    const outcome = sweep.reports.get(id);
    return outcome?.kind === "ok"
      ? [{ label: setupLabel(outcome.value.setup), report: outcome.value }]
      : [];
  });
}

function CompareBody({
  query,
  summary,
  sweep,
}: {
  query: CompareQuery;
  summary: SweepSummary;
  sweep: SweepData;
}) {
  const choices = setupChoices(summary, sweep);
  const a = choices.find((choice) => choice.report.setupId === query.a)?.report;
  const b = choices.find((choice) => choice.report.setupId === query.b)?.report;
  return (
    <>
      <SetupPicker choices={choices} query={query} sweepId={sweep.id} />
      {a === undefined || b === undefined ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Pick two setups</EmptyTitle>
            <EmptyDescription>
              {choices.length < 2
                ? "This sweep has fewer than two setups with a readable report."
                : "Choose a setup for A and one for B, then press Compare."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Comparison a={a} b={b} query={query} sweepId={sweep.id} />
      )}
    </>
  );
}

function SetupPicker({
  choices,
  query,
  sweepId,
}: {
  choices: SetupChoice[];
  query: CompareQuery;
  sweepId: string;
}) {
  const filters = filterParams(query);
  return (
    <form
      action={`${sweepHref(sweepId)}/compare`}
      className="flex flex-wrap items-end gap-4"
      method="get"
    >
      {Object.entries(filters).map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} />
      ))}
      {(["a", "b"] as const).map((side) => (
        <div className="flex min-w-60 flex-1 flex-col gap-1" key={side}>
          <label
            className="text-muted-foreground text-xs"
            htmlFor={`setup-${side}`}
          >
            Setup {side.toUpperCase()}
          </label>
          <NativeSelect
            defaultValue={query[side] ?? ""}
            id={`setup-${side}`}
            name={side}
          >
            <option value="">Choose a setup</option>
            {choices.map((choice) => (
              <option key={choice.report.setupId} value={choice.report.setupId}>
                {choice.label} ({choice.report.setupId})
              </option>
            ))}
          </NativeSelect>
        </div>
      ))}
      <Button type="submit">Compare</Button>
    </form>
  );
}

function Comparison({
  a,
  b,
  query,
  sweepId,
}: {
  a: SetupReport;
  b: SetupReport;
  query: CompareQuery;
  sweepId: string;
}) {
  const labels = compareLabels(a, b);
  const pairs = pairItems(a, b);
  const shown = filterCompared(pairs, query);
  const options = filterOptions(pairs);
  const missing = missingCounts(pairs);
  return (
    <>
      <SummaryTable
        a={a}
        aLabel={labels.a}
        b={b}
        bLabel={labels.b}
        sweepId={sweepId}
      />

      {a.setupId === b.setupId ? (
        <Alert>
          <AlertTitle>Both sides are the same setup</AlertTitle>
          <AlertDescription>Pick a different setup for B.</AlertDescription>
        </Alert>
      ) : null}
      {missing.a + missing.b > 0 ? (
        <p className="text-muted-foreground text-sm">
          {missing.a > 0
            ? `${missing.a} ${missing.a === 1 ? "item is" : "items are"} only in B. `
            : ""}
          {missing.b > 0
            ? `${missing.b} ${missing.b === 1 ? "item is" : "items are"} only in A.`
            : ""}
        </p>
      ) : null}

      <Filters
        a={a.setupId}
        b={b.setupId}
        options={options}
        query={query}
        sweepId={sweepId}
      />

      <p className="text-muted-foreground text-sm">
        {shown.length} of {pairs.length} {pairs.length === 1 ? "item" : "items"}
      </p>
      {shown.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No items match</EmptyTitle>
            <EmptyDescription>
              Change the filters above to see more items.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          {shown.map((pair) => (
            <ComparedItemBlock
              a={a}
              aLabel={labels.a}
              b={b}
              bLabel={labels.b}
              key={pair.key}
              pair={pair}
            />
          ))}
        </div>
      )}
    </>
  );
}

function SummaryTable({
  a,
  aLabel,
  b,
  bLabel,
  sweepId,
}: {
  a: SetupReport;
  aLabel: string;
  b: SetupReport;
  bLabel: string;
  sweepId: string;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-muted-foreground" />
          <TableHead>
            <SetupHeading
              label={aLabel}
              letter="A"
              setupId={a.setupId}
              sweepId={sweepId}
            />
          </TableHead>
          <TableHead>
            <SetupHeading
              label={bLabel}
              letter="B"
              setupId={b.setupId}
              sweepId={sweepId}
            />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {summaryRows(a, b).map((row) => (
          <TableRow key={row.label}>
            <TableCell className="text-muted-foreground">{row.label}</TableCell>
            <TableCell className="font-mono whitespace-normal">
              {row.a}
            </TableCell>
            <TableCell className="font-mono whitespace-normal">
              {row.b}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SetupHeading({
  label,
  letter,
  setupId,
  sweepId,
}: {
  label: string;
  letter: string;
  setupId: string;
  sweepId: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-2">
        <Badge variant="outline">{letter}</Badge>
        <Link
          className="font-mono font-medium underline-offset-4 hover:underline"
          href={setupHref(sweepId, setupId)}
        >
          {label}
        </Link>
      </span>
      <span className="text-muted-foreground font-mono text-xs font-normal">
        {setupId}
      </span>
    </div>
  );
}

function Filters({
  a,
  b,
  options,
  query,
  sweepId,
}: {
  a: string;
  b: string;
  options: ReturnType<typeof filterOptions>;
  query: CompareQuery;
  sweepId: string;
}) {
  const filtered = Object.keys(filterParams(query)).length > 0;
  return (
    <form
      action={`${sweepHref(sweepId)}/compare`}
      className="flex flex-wrap items-end gap-4"
      method="get"
    >
      <input name="a" type="hidden" value={a} />
      <input name="b" type="hidden" value={b} />
      <FilterSelect
        label="Person"
        name="person"
        options={options.people}
        value={query.person}
      />
      <FilterSelect
        label="Kind"
        name="kind"
        options={options.kinds}
        value={query.kind}
      />
      <FilterSelect
        label="Expect"
        name="expect"
        options={options.expects}
        value={query.expect}
      />
      <label className="flex h-8 items-center gap-2 text-sm">
        <input
          className="accent-primary size-4"
          defaultChecked={query.failing}
          name="failing"
          type="checkbox"
          value="1"
        />
        Failing only
      </label>
      <Button type="submit" variant="secondary">
        Apply
      </Button>
      {filtered ? (
        <Link
          className="text-muted-foreground flex h-8 items-center text-sm underline-offset-4 hover:underline"
          href={compareHref(sweepId, a, b)}
        >
          Clear filters
        </Link>
      ) : null}
      {options.expects.length === 0 ? (
        <p className="text-muted-foreground w-full text-xs">
          These reports do not record what each item expects, so the Expect
          filter has no values.
        </p>
      ) : null}
    </form>
  );
}

function FilterSelect({
  label,
  name,
  options,
  value,
}: {
  label: string;
  name: string;
  options: string[];
  value?: string;
}) {
  return (
    <div className="flex min-w-36 flex-col gap-1">
      <label
        className="text-muted-foreground text-xs"
        htmlFor={`filter-${name}`}
      >
        {label}
      </label>
      <NativeSelect
        defaultValue={value ?? ""}
        disabled={options.length === 0}
        id={`filter-${name}`}
        name={name}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function ComparedItemBlock({
  a,
  aLabel,
  b,
  bLabel,
  pair,
}: {
  a: SetupReport;
  aLabel: string;
  b: SetupReport;
  bLabel: string;
  pair: ComparedItem;
}) {
  const message = firstUserMessage(pair.a ?? pair.b ?? emptyItem(pair));
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-sm font-medium break-all">
          {pair.person} / {itemShortId(pair.itemId)}
        </h2>
        <Badge variant="outline">{pair.kind}</Badge>
        {pair.expect === undefined ? null : (
          <Badge variant="outline">expects {pair.expect}</Badge>
        )}
        {pair.repeat > 1 ? (
          <Badge variant="outline">repeat {pair.repeat}</Badge>
        ) : null}
      </div>
      {message === undefined ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">Person</p>
          <p className="bg-muted w-fit max-w-prose rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">
            {message}
          </p>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <ItemSide item={pair.a} label={aLabel} letter="A" report={a} />
        <ItemSide item={pair.b} label={bLabel} letter="B" report={b} />
      </div>
    </section>
  );
}

/** A stand-in with no turns, for a pair that has neither side. It cannot happen, but the types allow it. */
function emptyItem(pair: ComparedItem): ReportItem {
  return {
    checks: [],
    costUsd: 0,
    declineMarks: [],
    itemId: pair.itemId,
    journal: "own",
    kind: pair.kind,
    loopMarks: [],
    person: pair.person,
    repeat: pair.repeat,
    rubric: [],
    simulatedUserFlags: [],
    status: "graded",
    turns: [],
  };
}

function ItemSide({
  item,
  label,
  letter,
  report,
}: {
  item?: ReportItem;
  label: string;
  letter: string;
  report: SetupReport;
}) {
  if (item === undefined) {
    return (
      <div className="text-muted-foreground flex min-w-0 flex-col gap-2 rounded-md border border-dashed p-3 text-sm">
        <SideHeading label={label} letter={letter} />
        This setup has no such item.
      </div>
    );
  }
  const failed = failedCheckCount(item);
  const { folded, shown } = splitShown(failuresFirst(itemCheckRows(item)));
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SideHeading label={label} letter={letter} />
        <div className="flex flex-wrap items-center gap-2">
          {item.status === "graded" ? null : (
            <Badge className="text-warn" variant="outline">
              {item.status}
            </Badge>
          )}
          {failed > 0 ? (
            <Badge variant="destructive">{failed} failed</Badge>
          ) : (
            <Badge className="text-pass" variant="secondary">
              no failures
            </Badge>
          )}
          <Link
            className="text-muted-foreground underline-offset-4 hover:underline"
            href={itemHref(report.sweepId, report.setupId, item)}
          >
            Read in full →
          </Link>
        </div>
      </div>
      <Replies item={item} />
      <CheckRowList rows={shown} showScope />
      {folded.length > 0 ? (
        <details>
          <summary className="text-muted-foreground text-xs">
            {folded.length} passed or skipped{" "}
            {folded.length === 1 ? "check" : "checks"}
          </summary>
          <div className="pt-3">
            <CheckRowList rows={folded} showScope />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function SideHeading({ label, letter }: { label: string; letter: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Badge variant="outline">{letter}</Badge>
      <span className="truncate font-mono text-xs">{label}</span>
    </span>
  );
}

/** One reply for an opener, or the whole conversation, folded, for anything longer. */
function Replies({ item }: { item: ReportItem }) {
  if (item.turns.length === 0) {
    return null;
  }
  const exchanges = exchangeNumbers(item.turns);
  if (exchangeCount(item.turns) <= 1) {
    const replies = item.turns.filter((turn) => turn.role !== "user");
    return (
      <div className="flex flex-col gap-3">
        {replies.map((turn) => (
          <div className="flex flex-col gap-2" key={turn.position}>
            <TurnBlock exchange={1} turn={turn} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <details className="rounded-md border">
      <summary className="text-muted-foreground px-3 py-2 text-xs">
        Conversation · {exchangeCount(item.turns)} exchanges
      </summary>
      <div className="flex flex-col gap-4 border-t px-3 py-3">
        {item.turns.map((turn, index) => (
          <TurnBlock
            exchange={exchanges[index] ?? 1}
            key={turn.position}
            turn={turn}
          />
        ))}
      </div>
    </details>
  );
}
