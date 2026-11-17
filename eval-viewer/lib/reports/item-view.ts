import { type CheckTier, checkLabel, checkTier } from "./check-info.ts";
import type {
  CheckResult,
  ReportItem,
  ReportTurn,
  RubricResult,
} from "./sweep-types.ts";

/** One check or rubric score of an item, flat, with where it was recorded. */
export interface CheckRow {
  evidence: string;
  /** The 1-based exchange the check belongs to. Null for an item-wide check. */
  exchange: number | null;
  id: string;
  label: string;
  /** A rubric score, 1 to 5. Null for a check and for N/A. */
  level: number | null;
  /** `pass`, `fail`, `skipped`, `not-graded`, `scored` (rubric), or `n/a` (rubric). */
  outcome: string;
  reason: string;
  tier: CheckTier;
}

/**
 * The 1-based exchange of each turn. An exchange is the person's message and
 * Sage's reply, so it opens at each user turn. A reply with no message before
 * it belongs to exchange 1.
 */
export function exchangeNumbers(turns: readonly ReportTurn[]): number[] {
  let exchange = 0;
  return turns.map((turn) => {
    if (turn.role === "user" || exchange === 0) {
      exchange += 1;
    }
    return exchange;
  });
}

/** The turns of each exchange, in order. */
export function groupExchanges(
  turns: readonly ReportTurn[]
): { exchange: number; turns: ReportTurn[] }[] {
  const numbers = exchangeNumbers(turns);
  const groups: { exchange: number; turns: ReportTurn[] }[] = [];
  turns.forEach((turn, index) => {
    const exchange = numbers[index] ?? 1;
    const last = groups.at(-1);
    if (last !== undefined && last.exchange === exchange) {
      last.turns.push(turn);
    } else {
      groups.push({ exchange, turns: [turn] });
    }
  });
  return groups;
}

/** How many exchanges the item holds. */
export function exchangeCount(turns: readonly ReportTurn[]): number {
  return exchangeNumbers(turns).at(-1) ?? 0;
}

export function checkRowOf(
  check: CheckResult,
  exchange: number | null
): CheckRow {
  return {
    evidence: check.evidence,
    exchange,
    id: check.id,
    label: checkLabel(check.id),
    level: null,
    outcome: check.outcome,
    reason: check.reason,
    tier: checkTier(check.id),
  };
}

export function rubricRowOf(
  rubric: RubricResult,
  exchange: number | null
): CheckRow {
  return {
    evidence: rubric.evidence,
    exchange,
    id: rubric.id,
    label: checkLabel(rubric.id),
    level: rubric.level,
    outcome: rubric.level === null ? "n/a" : "scored",
    reason: rubric.reason,
    tier: "rubric",
  };
}

/** The checks and rubric scores of one turn. */
export function turnCheckRows(
  turn: ReportTurn,
  exchange: number | null
): CheckRow[] {
  return [
    ...turn.checks.map((check) => checkRowOf(check, exchange)),
    ...turn.rubric.map((rubric) => rubricRowOf(rubric, exchange)),
  ];
}

/** Every check and rubric score of an item: the item's own first, then each turn's in order. */
export function itemCheckRows(item: ReportItem): CheckRow[] {
  const exchanges = exchangeNumbers(item.turns);
  return [
    ...item.checks.map((check) => checkRowOf(check, null)),
    ...item.rubric.map((rubric) => rubricRowOf(rubric, null)),
    ...item.turns.flatMap((turn, index) =>
      turnCheckRows(turn, exchanges[index] ?? null)
    ),
  ];
}

const outcomeOrder: Record<string, number> = {
  fail: 0,
  "not-graded": 1,
};

/** Failures first, then checks that were not graded, then the rest. The order within each stays. */
export function failuresFirst(rows: readonly CheckRow[]): CheckRow[] {
  return rows
    .map((row, index) => ({ index, row }))
    .sort(
      (a, b) =>
        (outcomeOrder[a.row.outcome] ?? 2) -
          (outcomeOrder[b.row.outcome] ?? 2) || a.index - b.index
    )
    .map(({ row }) => row);
}

/** Rows to show at once, and the passed and skipped checks to fold away. Rubric scores are always shown. */
export function splitShown(rows: readonly CheckRow[]): {
  folded: CheckRow[];
  shown: CheckRow[];
} {
  const folded: CheckRow[] = [];
  const shown: CheckRow[] = [];
  for (const row of rows) {
    if (row.outcome === "pass" || row.outcome === "skipped") {
      folded.push(row);
    } else {
      shown.push(row);
    }
  }
  return { folded, shown };
}

export function failedRows(rows: readonly CheckRow[]): CheckRow[] {
  return rows.filter((row) => row.outcome === "fail");
}

/** A name for where a row was recorded, such as "Whole item" or "Exchange 2". */
export function scopeLabel(row: Pick<CheckRow, "exchange">): string {
  return row.exchange === null ? "Whole item" : `Exchange ${row.exchange}`;
}

/** Two items of different setups are the same item when the id and the repeat match. */
export function itemKey(item: Pick<ReportItem, "itemId" | "repeat">): string {
  return `${item.itemId}#${item.repeat}`;
}

/** The text after `person/kind/`, so `engaged/opener/rent-panic` reads `rent-panic`. */
export function itemShortId(itemId: string): string {
  const parts = itemId.split("/");
  return parts.length === 3 ? (parts[2] ?? itemId) : itemId;
}

/**
 * What an item expects of the reply. The item says it when the report does,
 * and otherwise the first turn that has its own kind does.
 */
export function itemExpect(
  item: Pick<ReportItem, "expect" | "turns">
): string | undefined {
  return (
    item.expect ?? item.turns.find((turn) => turn.expect !== undefined)?.expect
  );
}

/** The first message of the person, for the head of a comparison. */
export function firstUserMessage(item: ReportItem): string | undefined {
  return item.turns.find((turn) => turn.role === "user")?.text;
}

/** The loop, decline, and flag marks that belong to one exchange. */
export function marksForExchange(
  item: ReportItem,
  exchange: number
): {
  decline: ReportItem["declineMarks"];
  flags: ReportItem["simulatedUserFlags"];
  loop: ReportItem["loopMarks"];
} {
  return {
    decline: item.declineMarks.filter((mark) => mark.turn === exchange),
    flags: item.simulatedUserFlags.filter((mark) => mark.turn === exchange),
    loop: item.loopMarks.filter((mark) => mark.turn === exchange),
  };
}

/** True when the reply graded `crisis-handled` for real, so the exchange followed a crisis message. */
export function isCrisisExchange(item: ReportItem, exchange: number): boolean {
  const exchanges = exchangeNumbers(item.turns);
  return item.turns.some(
    (turn, index) =>
      exchanges[index] === exchange &&
      turn.checks.some(
        (check) =>
          check.id === "crisis-handled" &&
          (check.outcome === "pass" || check.outcome === "fail")
      )
  );
}

export interface ItemCounts {
  /** Replies that brought back what the person had said no to. */
  broughtBack: number;
  exchanges: number;
  failed: number;
  /** Simulated-user slips after a crisis turn. */
  flags: number;
  /** Replies that fed a worry loop. */
  loopFed: number;
  /** Exchanges where the person returned to the same worry. */
  loopReturns: number;
  notGraded: number;
}

/** What to say about an item at a glance. */
export function itemCounts(item: ReportItem): ItemCounts {
  const rows = itemCheckRows(item);
  return {
    broughtBack: item.declineMarks.filter((mark) => mark.bringsItBack === true)
      .length,
    exchanges: exchangeCount(item.turns),
    failed: rows.filter((row) => row.outcome === "fail").length,
    flags: item.simulatedUserFlags.length,
    loopFed: item.loopMarks.filter((mark) => mark.feedsLoop === true).length,
    loopReturns: item.loopMarks.filter((mark) => mark.returnsToWorry).length,
    notGraded: rows.filter((row) => row.outcome === "not-graded").length,
  };
}

/** A tool call as one line: its name and how it ended. */
export function toolCallSummary(
  calls: readonly { name: string; status: string }[]
): string {
  if (calls.length === 0) {
    return "no tool calls";
  }
  return `${calls.length} ${calls.length === 1 ? "tool call" : "tool calls"}: ${calls
    .map((call) =>
      call.status === "completed" ? call.name : `${call.name} (${call.status})`
    )
    .join(", ")}`;
}

const maxJsonLength = 2000;

/** Pretty JSON for a tool call input or output, cut at a length so one giant result does not swamp the page. */
export function jsonPreview(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > maxJsonLength
    ? `${text.slice(0, maxJsonLength)}\n… ${text.length - maxJsonLength} more characters`
    : text;
}
