import Link from "next/link";

import { CheckRowList } from "@/components/check-list";
import { Stat } from "@/components/stat";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  type DreamPersonGroup,
  type DreamSourceRow,
  dreamGroups,
  dreamKindLabel,
  filterDreamGroups,
  highlightClaims,
  writtenWithClaims,
} from "@/lib/reports/dream-view.ts";
import { failuresFirst, itemCheckRows } from "@/lib/reports/item-view.ts";
import type {
  SetupReport,
  UnsupportedClaim,
} from "@/lib/reports/sweep-types.ts";
import { dreamHref, setupHref, setupLabel } from "@/lib/reports/sweep-view.ts";

export function DreamAccuracy({
  claimsOnly,
  person,
  report,
}: {
  claimsOnly: boolean;
  person?: string;
  report: SetupReport;
}) {
  const all = dreamGroups(report);
  const groups = filterDreamGroups(all, person, claimsOnly);
  const total = all.reduce((sum, group) => sum + group.sources.length, 0);
  const withClaims = all.reduce((sum, group) => sum + group.withClaims, 0);
  const severe = all.reduce((sum, group) => sum + group.severe, 0);
  const other = all.reduce((sum, group) => sum + group.other, 0);
  return (
    <div className="flex flex-col gap-8">
      <Link
        className="text-muted-foreground w-fit text-sm underline-offset-4 hover:underline"
        href={setupHref(report.sweepId, report.setupId)}
      >
        ← Back to setup {setupLabel(report.setup)}
      </Link>

      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium tracking-tight">Dream accuracy</h1>
        <p className="text-muted-foreground font-mono text-sm">
          {setupLabel(report.setup)} · Dream prompt {report.setup.dreamPrompt} ·
          summary {report.setup.summaryModel} · memory {report.setup.memory}
        </p>
      </div>

      {total === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No Dream sources in this report</EmptyTitle>
            <EmptyDescription>
              Dream accuracy runs in the person pass. This setup's report holds
              no source with what Dream wrote.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Card size="sm">
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Sources" value={total} />
              <Stat label="With unsupported claims" value={withClaims} />
              <Stat label="Severe claims" value={severe} />
              <Stat label="Other claims" value={other} />
            </CardContent>
          </Card>

          <Filters
            claimsOnly={claimsOnly}
            groups={all}
            person={person}
            report={report}
          />

          {groups.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>Nothing matches</EmptyTitle>
                <EmptyDescription>
                  No person in this report matches the filter.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            groups.map((group) => (
              <PersonSection
                claimsOnly={claimsOnly}
                group={group}
                key={group.person}
              />
            ))
          )}
        </>
      )}
    </div>
  );
}

function Filters({
  claimsOnly,
  groups,
  person,
  report,
}: {
  claimsOnly: boolean;
  groups: DreamPersonGroup[];
  person?: string;
  report: SetupReport;
}) {
  const { setupId, sweepId } = report;
  return (
    <nav
      aria-label="Filters"
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <FilterLink
        active={person === undefined}
        href={dreamHref(sweepId, setupId, undefined, claimsOnly)}
      >
        All people
      </FilterLink>
      {groups.map((group) => (
        <FilterLink
          active={person === group.person}
          href={dreamHref(sweepId, setupId, group.person, claimsOnly)}
          key={group.person}
        >
          {group.person}
          {group.withClaims > 0 ? ` · ${group.withClaims}` : ""}
        </FilterLink>
      ))}
      <span className="text-muted-foreground px-1">|</span>
      <FilterLink
        active={claimsOnly}
        href={dreamHref(sweepId, setupId, person, !claimsOnly)}
      >
        Only sources with claims
      </FilterLink>
    </nav>
  );
}

function FilterLink({
  active,
  children,
  href,
}: {
  active: boolean;
  children: React.ReactNode;
  href: string;
}) {
  return (
    <Link aria-current={active ? "true" : undefined} href={href}>
      <Badge variant={active ? "default" : "outline"}>{children}</Badge>
    </Link>
  );
}

function PersonSection({
  claimsOnly,
  group,
}: {
  claimsOnly: boolean;
  group: DreamPersonGroup;
}) {
  return (
    <section
      className="flex scroll-mt-8 flex-col gap-3"
      id={`person-${group.person}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-base font-medium">{group.person}</h2>
        <p className="text-muted-foreground text-sm">
          {group.sources.length}{" "}
          {group.sources.length === 1 ? "source" : "sources"} ·{" "}
          {group.withClaims} with claims · {group.severe} severe · {group.other}{" "}
          other
        </p>
      </div>
      {group.sources.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {claimsOnly
            ? "No source of this person has an unsupported claim."
            : "No sources."}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {group.sources.map((row) => (
            <SourceBlock key={row.item.itemId} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

function SourceBlock({ row }: { row: DreamSourceRow }) {
  const { source } = row;
  const claimCount = source.unsupportedClaims.length;
  const view = writtenWithClaims(source);
  const checks = failuresFirst(itemCheckRows(row.item));
  return (
    <details className="bg-card rounded-lg border" open={claimCount > 0}>
      <summary className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
        <span className="font-mono font-medium">{source.sourceId}</span>
        <Badge variant="outline">{source.sourceKind}</Badge>
        {row.notGraded ? (
          <Badge className="text-warn" variant="outline">
            not graded
          </Badge>
        ) : null}
        {row.severe > 0 ? (
          <Badge variant="destructive">{row.severe} severe</Badge>
        ) : null}
        {row.other > 0 ? (
          <Badge className="text-warn" variant="outline">
            {row.other} other
          </Badge>
        ) : null}
        {claimCount === 0 && !row.notGraded ? (
          <span className="text-muted-foreground">no unsupported claims</span>
        ) : null}
      </summary>
      <div className="flex flex-col gap-4 border-t px-4 py-4 text-sm">
        {row.notGraded ? (
          <p className="text-muted-foreground">
            The judge could not grade this source, so the claims below, if any,
            are not a verdict.
          </p>
        ) : null}
        <div className="grid gap-6 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-muted-foreground text-xs font-medium uppercase">
              Source
            </h3>
            <p className="whitespace-pre-wrap">{source.sourceText}</p>
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <h3 className="text-muted-foreground text-xs font-medium uppercase">
              What Dream wrote
            </h3>
            {view.items.length === 0 ? (
              <p className="text-muted-foreground">Dream wrote nothing here.</p>
            ) : (
              view.items.map((entry, index) => (
                <WrittenItem
                  claims={entry.claims}
                  // biome-ignore lint/suspicious/noArrayIndexKey: Dream can write the same kind twice, and the list never reorders
                  key={`${entry.written.itemKind}-${index}`}
                  kind={entry.written.itemKind}
                  text={entry.written.text}
                />
              ))
            )}
          </div>
        </div>
        {view.strays.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-muted-foreground text-xs font-medium uppercase">
              Claims about text Dream did not write
            </h3>
            <ClaimList
              claims={view.strays}
              unplaced={view.strays.map((entry) => entry.number)}
            />
          </div>
        ) : null}
        {checks.length > 0 ? (
          <details>
            <summary className="text-muted-foreground text-xs">
              {checks.length} {checks.length === 1 ? "check" : "checks"}
            </summary>
            <div className="pt-3">
              <CheckRowList rows={checks} />
            </div>
          </details>
        ) : null}
      </div>
    </details>
  );
}

function WrittenItem({
  claims,
  kind,
  text,
}: {
  claims: { claim: UnsupportedClaim; number: number }[];
  kind: string;
  text: string;
}) {
  const { segments, unplaced } = highlightClaims(
    text,
    claims.map((entry) => ({ number: entry.number, quote: entry.claim.quote }))
  );
  const severity = new Map(
    claims.map((entry) => [entry.number, entry.claim.severity])
  );
  return (
    <div
      className={
        claims.length > 0
          ? "border-fail flex flex-col gap-2 border-l-2 pl-3"
          : "flex flex-col gap-2 pl-3"
      }
    >
      <Badge className="w-fit" variant="outline">
        {dreamKindLabel(kind)}
      </Badge>
      <p className="whitespace-pre-wrap">
        {segments.map((segment) =>
          segment.claim === undefined ? (
            <span key={`at-${segment.start}`}>{segment.text}</span>
          ) : (
            <mark
              className={
                severity.get(segment.claim) === "severe"
                  ? "bg-destructive/20 text-foreground rounded-sm px-0.5"
                  : "bg-warn/25 text-foreground rounded-sm px-0.5"
              }
              key={`at-${segment.start}`}
            >
              {segment.text}
              <sup className="pl-0.5 font-mono text-[0.65rem]">
                {segment.claim}
              </sup>
            </mark>
          )
        )}
      </p>
      {claims.length > 0 ? (
        <ClaimList claims={claims} unplaced={unplaced} />
      ) : null}
    </div>
  );
}

function ClaimList({
  claims,
  unplaced,
}: {
  claims: { claim: UnsupportedClaim; number: number }[];
  unplaced: number[];
}) {
  return (
    <ul className="flex flex-col gap-2">
      {claims.map(({ claim, number }) => (
        <li className="flex flex-col gap-1" key={`${number}-${claim.quote}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground font-mono text-xs">
              {number}
            </span>
            {claim.severity === "severe" ? (
              <Badge variant="destructive">severe</Badge>
            ) : (
              <Badge className="text-warn" variant="outline">
                other
              </Badge>
            )}
            {unplaced.includes(number) ? (
              <span className="text-muted-foreground text-xs">
                the quote is not in the text above
              </span>
            ) : null}
          </div>
          {claim.reason.length > 0 ? (
            <p className="text-muted-foreground">{claim.reason}</p>
          ) : null}
          {claim.quote.length > 0 ? (
            <blockquote className="text-muted-foreground border-l-2 pl-3 italic">
              {claim.quote}
            </blockquote>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
