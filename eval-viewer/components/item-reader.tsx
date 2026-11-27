import Link from "next/link";

import { CheckRowList } from "@/components/check-list";
import { Stat } from "@/components/stat";
import { TurnBlock } from "@/components/transcript";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatUsd } from "@/lib/reports/format.ts";
import {
  checkRowOf,
  failuresFirst,
  groupExchanges,
  isCrisisExchange,
  itemCounts,
  itemExpect,
  itemShortId,
  marksForExchange,
  rubricRowOf,
} from "@/lib/reports/item-view.ts";
import type { ReportItem, SetupReport } from "@/lib/reports/sweep-types.ts";
import {
  dreamHref,
  itemHref,
  setupHref,
  setupLabel,
} from "@/lib/reports/sweep-view.ts";

const endedNote: Record<string, string> = {
  done: "The person ended the chat.",
  error: "The conversation stopped on an error.",
  "max-turns": "The conversation reached its turn limit.",
  "simulator-error":
    "The simulated user failed, so the conversation stopped. That is not Sage's failure.",
};

export function ItemReader({
  item,
  next,
  previous,
  report,
}: {
  item: ReportItem;
  next?: ReportItem;
  previous?: ReportItem;
  report: SetupReport;
}) {
  const counts = itemCounts(item);
  const setupPage = setupHref(report.sweepId, report.setupId);
  const itemRows = failuresFirst([
    ...item.checks.map((check) => checkRowOf(check, null)),
    ...item.rubric.map((score) => rubricRowOf(score, null)),
  ]);
  return (
    <div className="flex flex-col gap-8">
      <Link
        className="text-muted-foreground w-fit text-sm underline-offset-4 hover:underline"
        href={`${setupPage}#items`}
      >
        ← Back to setup {setupLabel(report.setup)}
      </Link>

      <div className="flex flex-col gap-2">
        <h1 className="font-mono text-2xl font-medium tracking-tight break-all">
          {item.itemId}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{item.kind}</Badge>
          {itemExpect(item) === undefined ? null : (
            <Badge variant="outline">expects {itemExpect(item)}</Badge>
          )}
          <Badge variant="outline">{item.journal} journal</Badge>
          {item.repeat > 1 ? (
            <Badge variant="outline">repeat {item.repeat}</Badge>
          ) : null}
          {item.status === "graded" ? null : (
            <Badge className="text-warn" variant="outline">
              {item.status}
            </Badge>
          )}
          <span className="text-muted-foreground font-mono text-xs">
            {report.setupId} · {formatUsd(item.costUsd)}
          </span>
        </div>
        {item.dream === undefined ? null : (
          <Link
            className="text-muted-foreground w-fit text-sm underline-offset-4 hover:underline"
            href={dreamHref(report.sweepId, report.setupId, item.person)}
          >
            See what Dream wrote for {item.person} →
          </Link>
        )}
      </div>

      <Notices item={item} />

      <Card size="sm">
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Exchanges" value={counts.exchanges} />
          <Stat label="Failed checks" value={counts.failed} />
          <Stat label="Not graded" value={counts.notGraded} />
          <Stat
            label="Returns to a worry · fed it"
            value={`${counts.loopReturns} · ${counts.loopFed}`}
          />
          <Stat
            label="Replies that brought back a no"
            value={counts.broughtBack}
          />
          <Stat label="Simulated-user flags" value={counts.flags} />
        </CardContent>
      </Card>

      {itemRows.length > 0 ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-base font-medium">
            {item.turns.length > 1 ? "Whole conversation" : "Item checks"}
          </h2>
          <div className="text-sm">
            <CheckRowList rows={itemRows} />
          </div>
        </section>
      ) : null}

      <Transcript item={item} />

      <nav className="flex flex-wrap justify-between gap-4 text-sm">
        <NeighborLink item={previous} label="← Previous item" report={report} />
        <NeighborLink item={next} label="Next item →" report={report} />
      </nav>
    </div>
  );
}

function Notices({ item }: { item: ReportItem }) {
  const ended = item.ended === undefined ? undefined : endedNote[item.ended];
  const trouble = item.ended === "simulator-error" || item.ended === "error";
  return (
    <>
      {item.status === "not-graded" ? (
        <Alert>
          <AlertTitle>Not graded</AlertTitle>
          <AlertDescription>
            The judge could not grade this item, or the spending cap stopped it.
            That is not a failure.
          </AlertDescription>
        </Alert>
      ) : null}
      {item.note === undefined ? null : (
        <p className="text-muted-foreground text-sm">{item.note}</p>
      )}
      {ended === undefined ? null : (
        <p
          className={
            trouble ? "text-warn text-sm" : "text-muted-foreground text-sm"
          }
        >
          {ended}
        </p>
      )}
    </>
  );
}

function NeighborLink({
  item,
  label,
  report,
}: {
  item?: ReportItem;
  label: string;
  report: SetupReport;
}) {
  if (item === undefined) {
    return <span />;
  }
  return (
    <Link
      className="underline-offset-4 hover:underline"
      href={itemHref(report.sweepId, report.setupId, item)}
    >
      {label}{" "}
      <span className="text-muted-foreground font-mono">
        {itemShortId(item.itemId)}
      </span>
    </Link>
  );
}

function Transcript({ item }: { item: ReportItem }) {
  const groups = groupExchanges(item.turns);
  if (groups.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        This item holds no messages. Its checks are above.
      </p>
    );
  }
  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-base font-medium">Transcript</h2>
      {groups.map((group) => (
        <ExchangeBlock
          exchange={group.exchange}
          item={item}
          key={group.exchange}
          turns={group.turns}
        />
      ))}
    </section>
  );
}

function ExchangeBlock({
  exchange,
  item,
  turns,
}: {
  exchange: number;
  item: ReportItem;
  turns: ReportItem["turns"];
}) {
  const marks = marksForExchange(item, exchange);
  const crisis = isCrisisExchange(item, exchange);
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Exchange {exchange}</h3>
        {crisis ? <Badge variant="outline">Crisis turn</Badge> : null}
        {marks.loop.map((mark) =>
          mark.returnsToWorry ? (
            <Badge key={`loop-${mark.turn}-${mark.reason}`} variant="outline">
              Returns to the worry
            </Badge>
          ) : null
        )}
        {marks.loop.map((mark) => {
          if (mark.feedsLoop === null) {
            return null;
          }
          return mark.feedsLoop ? (
            <Badge
              key={`fed-${mark.turn}-${mark.reason}`}
              variant="destructive"
            >
              Reply fed the loop
            </Badge>
          ) : (
            <Badge
              className="text-pass"
              key={`fed-${mark.turn}-${mark.reason}`}
              variant="secondary"
            >
              Reply turned the loop
            </Badge>
          );
        })}
        {marks.decline.map((mark) =>
          mark.afterNo ? (
            <Badge key={`no-${mark.turn}-${mark.reason}`} variant="outline">
              After a no
            </Badge>
          ) : null
        )}
        {marks.decline.map((mark) => {
          if (mark.bringsItBack === null) {
            return null;
          }
          return mark.bringsItBack ? (
            <Badge
              key={`back-${mark.turn}-${mark.reason}`}
              variant="destructive"
            >
              Brought it back
            </Badge>
          ) : (
            <Badge
              className="text-pass"
              key={`back-${mark.turn}-${mark.reason}`}
              variant="secondary"
            >
              Let it go
            </Badge>
          );
        })}
        {marks.flags.map((mark) => (
          <Badge key={`flag-${mark.turn}-${mark.flag}`} variant="destructive">
            Simulated user: {mark.flag}
          </Badge>
        ))}
      </div>

      {turns.map((turn) => (
        <TurnBlock checks exchange={exchange} key={turn.position} turn={turn} />
      ))}

      <MarkNotes marks={marks} />
    </div>
  );
}

/** The judge's reason and quote for each mark of an exchange. */
function MarkNotes({ marks }: { marks: ReturnType<typeof marksForExchange> }) {
  const notes = [
    ...marks.loop.map((mark) => ({
      evidence: mark.evidence,
      key: `loop-${mark.reason}`,
      reason: mark.reason,
      title: "Worry loop",
    })),
    ...marks.decline.map((mark) => ({
      evidence: mark.evidence,
      key: `decline-${mark.reason}`,
      reason: mark.reason,
      title: "After a no",
    })),
    ...marks.flags.map((mark) => ({
      evidence: mark.evidence,
      key: `flag-${mark.flag}-${mark.reason}`,
      reason: mark.reason,
      title: `Simulated user: ${mark.flag}`,
    })),
  ];
  if (notes.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-2 border-t border-dashed pt-3 text-sm">
      {notes.map((note) => (
        <li className="flex flex-col gap-1" key={note.key}>
          <span className="font-medium">{note.title}</span>
          {note.reason.length > 0 ? (
            <span className="text-muted-foreground">{note.reason}</span>
          ) : null}
          {note.evidence.length > 0 ? (
            <blockquote className="text-muted-foreground border-l-2 pl-3 italic">
              {note.evidence}
            </blockquote>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
