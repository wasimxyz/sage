import { EmbedFilter } from "@/components/embed-filter";
import { ModelMatrix } from "@/components/model-matrix";
import { RecentRuns } from "@/components/recent-runs";
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
import type { RunSummary } from "@/lib/reports/types.ts";

export function HomeDashboard({
  embed,
  runs,
}: {
  embed?: string;
  runs: RunSummary[];
}) {
  if (runs.length === 0) {
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

  const embedModel = resolveEmbedModel(runs, embed);
  const embedOptions = uniqueInOrder(runs.map((run) => run.embedModel));
  const visible = filterByEmbed(runs, embedModel);
  const lookup = latestByDreamChat(visible);
  const dreamModels = uniqueInOrder(visible.map((run) => run.dreamModel));
  const chatModels = uniqueInOrder(visible.map((run) => run.chatModel));
  const totalTests = runs.reduce((sum, run) => sum + run.total, 0);
  const totalPassed = runs.reduce((sum, run) => sum + run.passed, 0);
  const totalFailed = runs.reduce((sum, run) => sum + run.failed, 0);
  const overall = passRate(totalPassed, totalTests);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-medium text-2xl tracking-tight">Overview</h1>
        <p className="text-muted-foreground text-sm">
          {runs.length} {runs.length === 1 ? "run" : "runs"} · {totalTests}{" "}
          {totalTests === 1 ? "test" : "tests"} · {overall}% overall pass rate ·{" "}
          {totalFailed} failed {totalFailed === 1 ? "test" : "tests"}
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium text-base">Results by model</h2>
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
    </div>
  );
}
