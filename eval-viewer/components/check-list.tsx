import { Badge } from "@/components/ui/badge";
import {
  type CheckTier,
  checkLabel,
  checkTier,
  tierLabel,
} from "@/lib/reports/check-info.ts";
import type { CheckResult, RubricResult } from "@/lib/reports/sweep-types.ts";

interface Row {
  evidence: string;
  key: string;
  label: string;
  outcome: { text: string; tone: OutcomeTone };
  reason: string;
  tier: CheckTier;
}

type OutcomeTone = "fail" | "muted" | "pass" | "warn";

const outcomeTone: Record<string, OutcomeTone> = {
  fail: "fail",
  "not-graded": "warn",
  pass: "pass",
  skipped: "muted",
};

/** An item can hold the same check many times (Dream supported, once for each item Dream wrote), so the position is part of the key. */
function checkRow(check: CheckResult, position: number): Row {
  return {
    evidence: check.evidence,
    key: `check-${check.id}-${position}`,
    label: checkLabel(check.id),
    outcome: {
      text: check.outcome,
      tone: outcomeTone[check.outcome] ?? "muted",
    },
    reason: check.reason,
    tier: checkTier(check.id),
  };
}

function rubricRow(rubric: RubricResult): Row {
  return {
    evidence: rubric.evidence,
    key: `rubric-${rubric.id}`,
    label: checkLabel(rubric.id),
    outcome:
      rubric.level === null
        ? { text: "N/A", tone: "muted" }
        : { text: `${rubric.level} of 5`, tone: "pass" },
    reason: rubric.reason,
    tier: "rubric",
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
  const rows = [...checks.map(checkRow), ...rubric.map(rubricRow)];
  if (rows.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li
          className="flex flex-col gap-1 border-b border-dashed pb-2 last:border-b-0 last:pb-0"
          key={row.key}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{tierLabel[row.tier]}</Badge>
            <span className="font-medium">{row.label}</span>
            <OutcomeBadge text={row.outcome.text} tone={row.outcome.tone} />
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

function OutcomeBadge({ text, tone }: { text: string; tone: OutcomeTone }) {
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
