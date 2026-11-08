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
            <th className="text-muted-foreground px-2 pb-2 text-left text-xs font-medium">
              <span className="block">dream ↓</span>
              <span>chat →</span>
            </th>
            {chatModels.map((chat) => (
              <th
                className="text-muted-foreground px-2 text-center font-mono text-xs font-medium"
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
              <th className="pr-2 text-right font-mono text-xs font-medium">
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
      className="bg-card text-card-foreground ring-foreground/10 hover:bg-muted flex h-16 w-28 flex-col items-center justify-center rounded-lg border ring-1"
      href={`/runs/${run.id}`}
    >
      <PassRate className="text-lg" rate={rate} />
      <span className="text-muted-foreground text-[11px]">
        {run.passed}/{run.total}
      </span>
    </Link>
  );
}

function EmptyCell() {
  return (
    <div className="text-muted-foreground flex h-16 w-28 items-center justify-center rounded-lg border border-dashed text-xs">
      —
    </div>
  );
}
