import { contextLabel, contextTurns } from "@/lib/reports/calibration.ts";
import { jsonPreview } from "@/lib/reports/item-view.ts";

/** What the sample knew about an item: the fact sheet, the conversation so far, a journal excerpt. It can hold anything, so each kind of value has its own way to read. */
export function CalibrationContext({
  context,
}: {
  context: Record<string, unknown>;
}) {
  const entries = Object.entries(context);
  if (entries.length === 0) {
    return null;
  }
  return (
    <details className="rounded-md border">
      <summary className="px-3 py-2 text-sm font-medium">
        Context ({entries.map(([key]) => contextLabel(key)).join(", ")})
      </summary>
      <div className="flex flex-col gap-4 border-t px-3 py-3 text-sm">
        {entries.map(([key, value]) => (
          <div className="flex flex-col gap-1" key={key}>
            <p className="text-muted-foreground text-xs">{contextLabel(key)}</p>
            <ContextValue value={value} />
          </div>
        ))}
      </div>
    </details>
  );
}

function ContextValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <p className="whitespace-pre-wrap">{value}</p>;
  }
  const turns = contextTurns(value);
  if (turns !== undefined) {
    return (
      <ul className="flex flex-col gap-2">
        {turns.map((turn, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the messages repeat roles, and the list never reorders
          <li className="flex flex-col" key={`${turn.role}-${index}`}>
            <span className="text-muted-foreground text-xs">
              {turn.role === "user" ? "Person" : "Sage"}
            </span>
            <span className="whitespace-pre-wrap">{turn.text}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  ) {
    return (
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {value.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the strings can repeat, and the list never reorders
          <li key={`${index}-${entry}`}>{entry}</li>
        ))}
      </ul>
    );
  }
  return (
    <pre className="bg-muted max-h-64 overflow-auto rounded-md p-2 font-mono text-xs break-words whitespace-pre-wrap">
      {jsonPreview(value)}
    </pre>
  );
}
