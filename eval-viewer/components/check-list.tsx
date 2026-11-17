import { Badge } from "@/components/ui/badge";
import { tierLabel } from "@/lib/reports/check-info.ts";
import {
  type CheckRow,
  checkRowOf,
  rubricRowOf,
  scopeLabel,
} from "@/lib/reports/item-view.ts";
import type { CheckResult, RubricResult } from "@/lib/reports/sweep-types.ts";

type Tone = "fail" | "muted" | "pass" | "warn";

const outcomeTone: Record<string, Tone> = {
  fail: "fail",
  "not-graded": "warn",
  pass: "pass",
  skipped: "muted",
};

function rowOutcome(row: CheckRow): { text: string; tone: Tone } {
  if (row.tier === "rubric") {
    if (row.level === null) {
      return { text: "N/A", tone: "muted" };
    }
    let tone: Tone = "fail";
    if (row.level >= 4) {
      tone = "pass";
    } else if (row.level === 3) {
      tone = "warn";
    }
    return { text: `${row.level} of 5`, tone };
  }
  return {
    text: row.outcome,
    tone: Object.hasOwn(outcomeTone, row.outcome)
      ? (outcomeTone[row.outcome] ?? "muted")
      : "muted",
  };
}

/** Each check with its tier, outcome, reason, and the quoted evidence. */
export function CheckList({
  checks,
  rubric,
}: {
  checks: CheckResult[];
  rubric: RubricResult[];
}) {
  return (
    <CheckRowList
      rows={[
        ...checks.map((check) => checkRowOf(check, null)),
        ...rubric.map((score) => rubricRowOf(score, null)),
      ]}
    />
  );
}

/** The same list, from flat rows. `showScope` names the exchange each row belongs to. */
export function CheckRowList({
  rows,
  showScope = false,
}: {
  rows: CheckRow[];
  showScope?: boolean;
}) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <li
          className="flex flex-col gap-1 border-b border-dashed pb-2 last:border-b-0 last:pb-0"
          // The same check can repeat in one exchange (Dream supported, once for each item Dream wrote), and the list never reorders.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the only identity a repeated check has
          key={`${row.tier}-${row.id}-${row.exchange ?? "item"}-${index}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{tierLabel[row.tier]}</Badge>
            <span className="font-medium">{row.label}</span>
            <OutcomeBadge {...rowOutcome(row)} />
            {showScope ? (
              <span className="text-muted-foreground text-xs">
                {scopeLabel(row)}
              </span>
            ) : null}
          </div>
          {row.reason.length > 0 ? (
            <p className="text-muted-foreground">{row.reason}</p>
          ) : null}
          {row.evidence.length > 0 ? (
            <blockquote className="text-muted-foreground border-l-2 pl-3 italic">
              {row.evidence}
            </blockquote>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function OutcomeBadge({ text, tone }: { text: string; tone: Tone }) {
  if (tone === "fail") {
    return <Badge variant="destructive">{text}</Badge>;
  }
  if (tone === "pass") {
    return (
      <Badge className="text-pass" variant="secondary">
        {text}
      </Badge>
    );
  }
  if (tone === "warn") {
    return (
      <Badge className="text-warn" variant="outline">
        {text}
      </Badge>
    );
  }
  return <Badge variant="outline">{text}</Badge>;
}
