import Link from "next/link";

import { PassRateBadge } from "@/components/pass-rate";
import { formatClockTime, passRate } from "@/lib/reports/format.ts";
import { groupRunsByDate } from "@/lib/reports/matrix.ts";
import type { RunSummary } from "@/lib/reports/types.ts";

export function RecentRuns({ runs }: { runs: RunSummary[] }) {
  const groups = groupRunsByDate(runs);
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-medium">Recent runs</h2>
      {groups.map((group) => (
        <div className="flex flex-col gap-2" key={group.key}>
          <h3 className="text-muted-foreground text-sm">{group.label}</h3>
          <div className="overflow-x-auto">
            <table className="w-full caption-bottom text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-muted-foreground h-10 px-2 text-left font-medium">
                    Started
                  </th>
                  <th className="text-muted-foreground h-10 px-2 text-left font-medium">
                    Dream
                  </th>
                  <th className="text-muted-foreground h-10 px-2 text-left font-medium">
                    Chat
                  </th>
                  <th className="text-muted-foreground h-10 px-2 text-left font-medium">
                    Embedding
                  </th>
                  <th className="text-muted-foreground h-10 px-2 text-left font-medium">
                    Tests
                  </th>
                  <th className="text-muted-foreground h-10 px-2 text-left font-medium">
                    Pass rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {group.runs.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

function RunRow({ run }: { run: RunSummary }) {
  const rate = passRate(run.passed, run.total);
  return (
    <tr className="hover:bg-muted/50 relative border-b">
      <td className="p-2">
        <Link className="after:absolute after:inset-0" href={`/runs/${run.id}`}>
          {formatClockTime(run.startedAt)}
        </Link>
      </td>
      <td className="p-2 font-mono">{run.dreamModel}</td>
      <td className="p-2 font-mono">{run.chatModel}</td>
      <td className="p-2 font-mono">{run.embedModel}</td>
      <td className="p-2">{run.total}</td>
      <td className="p-2">
        <PassRateBadge rate={rate} />
      </td>
    </tr>
  );
}
