import Link from "next/link";

import { PassRate } from "@/components/pass-rate";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { passRate } from "@/lib/reports/format.ts";
import { dreamChatKey } from "@/lib/reports/matrix.ts";
import type { RunSummary } from "@/lib/reports/types.ts";

export function ModelMatrix({
  chatModels,
  dreamModels,
  lookup,
}: {
  chatModels: string[];
  dreamModels: string[];
  lookup: Map<string, RunSummary>;
}) {
  if (chatModels.length === 0 || dreamModels.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No runs for this embedding</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-2">
        <thead>
          <tr>
            <th className="px-2 pb-2 text-left font-medium text-muted-foreground text-xs">
              <span className="block">dream ↓</span>
              <span>chat →</span>
            </th>
            {chatModels.map((chat) => (
              <th
                className="px-2 text-center font-medium font-mono text-muted-foreground text-xs"
                key={chat}
              >
                {chat}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dreamModels.map((dream) => (
            <tr key={dream}>
              <th className="pr-2 text-right font-medium font-mono text-xs">
                {dream}
              </th>
              {chatModels.map((chat) => {
                const run = lookup.get(dreamChatKey(dream, chat));
                if (run === undefined) {
                  return (
                    <td key={chat}>
                      <EmptyCell />
                    </td>
                  );
                }
                return (
                  <td key={chat}>
                    <MatrixCell run={run} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatrixCell({ run }: { run: RunSummary }) {
  const rate = passRate(run.passed, run.total);
  return (
    <Link
      className="flex h-16 w-28 flex-col items-center justify-center rounded-lg border bg-card text-card-foreground ring-1 ring-foreground/10 hover:bg-muted"
      href={`/runs/${run.id}`}
    >
      <PassRate className="text-lg" rate={rate} />
      <span className="text-[11px] text-muted-foreground">
        {run.passed}/{run.total}
      </span>
    </Link>
  );
}

function EmptyCell() {
  return (
    <div className="flex h-16 w-28 items-center justify-center rounded-lg border border-dashed text-muted-foreground text-xs">
      —
    </div>
  );
}
