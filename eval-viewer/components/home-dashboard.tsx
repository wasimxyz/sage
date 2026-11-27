import { EmbedFilter } from "@/components/embed-filter";
import { ModelMatrix } from "@/components/model-matrix";
import { RecentRuns } from "@/components/recent-runs";
import { SweepsList } from "@/components/sweeps-list";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { passRate } from "@/lib/reports/format.ts";
import {
  filterByEmbed,
  latestByDreamChat,
  resolveEmbedModel,
  uniqueInOrder,
} from "@/lib/reports/matrix.ts";
import type { SweepListItem } from "@/lib/reports/sweep-types.ts";
import type { RunSummary } from "@/lib/reports/types.ts";

export function HomeDashboard({
  embed,
  runs,
  sweeps,
}: {
  embed?: string;
  runs: RunSummary[];
  sweeps: SweepListItem[];
}) {
  if (runs.length === 0 && sweeps.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No eval reports yet</EmptyTitle>
          <EmptyDescription>
            Upload files with make eval-upload, or set BLOB_READ_WRITE_TOKEN so
            this app can read sage-evals/ from Vercel Blob. Without a token it
            looks in agent/evals/reports.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Overview</h1>
        <p className="text-muted-foreground text-sm">
          {overviewLine(runs, sweeps.length)}
        </p>
      </div>

      {sweeps.length > 0 ? <SweepsList sweeps={sweeps} /> : null}
      {runs.length > 0 ? <RunsOverview embed={embed} runs={runs} /> : null}
    </div>
  );
}

function overviewLine(runs: RunSummary[], sweepCount: number): string {
  const parts: string[] = [];
  if (sweepCount > 0) {
    parts.push(`${sweepCount} ${sweepCount === 1 ? "sweep" : "sweeps"}`);
  }
  if (runs.length > 0) {
    const totalTests = runs.reduce((sum, run) => sum + run.total, 0);
    const totalPassed = runs.reduce((sum, run) => sum + run.passed, 0);
    const totalFailed = runs.reduce((sum, run) => sum + run.failed, 0);
    parts.push(
      `${runs.length} ${runs.length === 1 ? "run" : "runs"}`,
      `${totalTests} ${totalTests === 1 ? "test" : "tests"}`,
      `${passRate(totalPassed, totalTests)}% overall pass rate`,
      `${totalFailed} failed ${totalFailed === 1 ? "test" : "tests"}`
    );
  }
  return parts.join(" · ");
}

function RunsOverview({ embed, runs }: { embed?: string; runs: RunSummary[] }) {
  const embedModel = resolveEmbedModel(runs, embed);
  const embedOptions = uniqueInOrder(runs.map((run) => run.embedModel));
  const visible = filterByEmbed(runs, embedModel);
  const lookup = latestByDreamChat(visible);
  const dreamModels = uniqueInOrder(visible.map((run) => run.dreamModel));
  const chatModels = uniqueInOrder(visible.map((run) => run.chatModel));

  return (
    <>
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-medium">Results by model</h2>
          {embedOptions.length > 0 ? (
            <EmbedFilter options={embedOptions} value={embedModel} />
          ) : null}
        </div>
        <ModelMatrix
          chatModels={chatModels}
          dreamModels={dreamModels}
          lookup={lookup}
        />
      </section>

      <RecentRuns runs={runs} />
    </>
  );
}
