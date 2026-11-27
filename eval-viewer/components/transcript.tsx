import { CheckRowList } from "@/components/check-list";
import { Badge } from "@/components/ui/badge";
import { formatMs } from "@/lib/reports/format.ts";
import {
  failuresFirst,
  jsonPreview,
  toolCallSummary,
  turnCheckRows,
} from "@/lib/reports/item-view.ts";
import type { ReportTurn, ToolCallView } from "@/lib/reports/sweep-types.ts";

/** How long a reply took: the first word, the time in tools, and the whole turn. */
function timingLine(turn: ReportTurn): string {
  const parts: string[] = [];
  if (turn.firstVisibleMs !== null) {
    parts.push(`first word ${formatMs(turn.firstVisibleMs)}`);
  }
  if (turn.toolMs !== null && turn.toolMs > 0) {
    parts.push(`tools ${formatMs(turn.toolMs)}`);
  }
  if (turn.totalMs !== null) {
    parts.push(`total ${formatMs(turn.totalMs)}`);
  }
  return parts.join(" · ");
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const text = jsonPreview(value);
  if (text.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-xs">{label}</p>
      <pre className="bg-muted max-h-64 overflow-auto rounded-md p-2 font-mono text-xs break-words whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}

/** The tool calls of one turn, folded away until you open them. */
export function ToolCalls({ calls }: { calls: ToolCallView[] }) {
  if (calls.length === 0) {
    return null;
  }
  return (
    <details className="rounded-md border">
      <summary className="text-muted-foreground px-3 py-2 text-xs">
        {toolCallSummary(calls)}
      </summary>
      <div className="flex flex-col gap-3 border-t px-3 py-3">
        {calls.map((call, index) => (
          <div
            className="flex flex-col gap-2 border-b border-dashed pb-3 last:border-b-0 last:pb-0"
            // biome-ignore lint/suspicious/noArrayIndexKey: a turn can call the same tool twice, and the list never reorders
            key={`${call.name}-${index}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-medium">{call.name}</span>
              {call.status === "completed" ? null : (
                <Badge variant="destructive">{call.status}</Badge>
              )}
            </div>
            <JsonBlock label="Input" value={call.input} />
            <JsonBlock label="Output" value={call.output} />
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * One message of an item. With `checks`, the turn's own checks and rubric
 * scores follow it, failures first.
 */
export function TurnBlock({
  checks = false,
  exchange,
  turn,
}: {
  checks?: boolean;
  exchange: number;
  turn: ReportTurn;
}) {
  const isPerson = turn.role === "user";
  const timing = isPerson ? "" : timingLine(turn);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        {isPerson ? "Person" : "Sage"}
        {!isPerson && turn.expect !== undefined
          ? ` · graded as ${turn.expect}`
          : ""}
        {timing.length > 0 ? ` · ${timing}` : ""}
        {turn.helpSeen.length > 0
          ? ` · help seen: ${turn.helpSeen.join(", ")}`
          : ""}
      </p>
      <p
        className={
          isPerson
            ? "bg-muted w-fit max-w-prose rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
            : "text-sm whitespace-pre-wrap"
        }
      >
        {turn.text.length > 0 ? turn.text : "(no text)"}
      </p>
      {turn.error === undefined ? null : (
        <p className="text-fail text-sm">Error: {turn.error}</p>
      )}
      <ToolCalls calls={turn.toolCalls} />
      {turn.journalErrors.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {turn.journalErrors.map((error, index) => (
            <li
              className="border-fail flex flex-col gap-1 border-l-2 pl-3 text-sm"
              // biome-ignore lint/suspicious/noArrayIndexKey: a reply can make the same kind of error twice, and the list never reorders
              key={`${error.kind}-${index}`}
            >
              <span className="font-medium">
                Wrong about the journal: {error.kind}
              </span>
              {error.evidence.length > 0 ? (
                <span className="text-muted-foreground italic">
                  {error.evidence}
                </span>
              ) : null}
              {error.truth.length > 0 ? (
                <span className="text-muted-foreground">
                  The journal says: {error.truth}
                </span>
              ) : null}
              {error.reason.length > 0 ? (
                <span className="text-muted-foreground">{error.reason}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {checks ? (
        <div className="text-sm">
          <CheckRowList rows={failuresFirst(turnCheckRows(turn, exchange))} />
        </div>
      ) : null}
    </div>
  );
}
