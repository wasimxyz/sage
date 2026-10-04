import Link from "next/link";
import { CategoryCard } from "@/components/category-card";
import { ChatScoresList } from "@/components/chat-scores-list";
import { DurationHistograms } from "@/components/duration-histograms";
import { FailuresList, parseFailureFilter } from "@/components/failures-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { infraFailureCount } from "@/lib/reports/assemble.ts";
import { formatClock, formatDuration, passRate } from "@/lib/reports/format.ts";
import type { EvalReport } from "@/lib/reports/types.ts";

export function RunReport({
  category,
  report,
}: {
  category?: string;
  report: EvalReport;
}) {
  const rate = passRate(report.run.passed, report.run.total);
  const infra = infraFailureCount(report.failures);
  const quality = report.failures.length - infra;
  const endedAt = report.run.endedAt ?? report.run.startedAt;
  const filter = parseFailureFilter(category);

  return (
    <div className="flex flex-col gap-8">
      <Link
        className="w-fit text-muted-foreground text-sm underline-offset-4 hover:underline"
        href="/"
      >
        ← Back to overview
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex min-w-60 flex-1 flex-col gap-2">
          <h1 className="font-medium text-2xl tracking-tight">
            eve eval report
          </h1>
          <p className="font-mono text-muted-foreground text-sm">
            <span className="text-foreground">{report.models.chatModel}</span>{" "}
            chat ·{" "}
            <span className="text-foreground">{report.models.dreamModel}</span>{" "}
            dream ·{" "}
            <span className="text-foreground">{report.models.embedModel}</span>{" "}
            embeddings
          </p>
          <p className="text-muted-foreground text-sm">
            {formatClock(report.run.startedAt)} → {formatClock(endedAt)} ·{" "}
            {formatDuration(report.run.suiteSeconds)} suite time ·{" "}
            {report.run.platform}
          </p>
        </div>
        <div className="text-right">
          <p className="font-medium text-4xl tracking-tight">{rate}%</p>
          <p className="font-mono text-muted-foreground text-sm">
            {report.run.passed} / {report.run.total} passed
          </p>
        </div>
      </div>

      {report.failures.length > 0 ? (
        <Alert>
          <AlertTitle>What actually went wrong</AlertTitle>
          <AlertDescription>
            {infra} of {report.failures.length} failures never produced an
            answer for the judge to grade: the chat model returned an error or
            timed out.
            {quality > 0
              ? ` ${quality} failure${quality === 1 ? "" : "s"} reflect a quality miss.`
              : " No quality misses were recorded."}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertTitle>All hard checks passed</AlertTitle>
          <AlertDescription>
            Every non-skipped eval finished its gates. Chat factuality scores
            are tracked data on each Chat row. They do not fail the run.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {report.categories.map((item) => (
          <CategoryCard
            category={item}
            href={
              item.failed > 0
                ? `/runs/${report.id}?category=${item.id}#failures`
                : undefined
            }
            key={item.id}
          />
        ))}
      </div>

      <section className="flex scroll-mt-8 flex-col gap-4" id="chat-scores">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium text-base">Chat scores</h2>
          <p className="text-muted-foreground text-sm">
            Factuality on every Chat turn, including passes
          </p>
        </div>
        <ChatScoresList scores={report.chatScores} />
      </section>

      <section className="flex scroll-mt-8 flex-col gap-4" id="failures">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium text-base">Failures</h2>
          <p className="text-muted-foreground text-sm">
            Open a row for the assertion trail
          </p>
        </div>
        <FailuresList
          categories={report.categories}
          failures={report.failures}
          filter={filter}
          runId={report.id}
        />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium text-base">Passed</h2>
          <p className="text-muted-foreground text-sm">
            How long passed evals took. Chat scores are in the list above.
          </p>
        </div>
        <DurationHistograms report={report} />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium text-base">Journal fixture</h2>
          <p className="text-muted-foreground text-sm">
            Scenarios chat and retrieval questions are grounded in
          </p>
        </div>
        <Card>
          <CardContent className="flex flex-col gap-3">
            <FixtureTable report={report} />
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium text-base">Session log</h2>
          <p className="text-muted-foreground text-sm">
            {report.run.app} on {report.run.platform}
          </p>
        </div>
        <Card>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <LogField
              label="App session"
              value={`${formatClock(report.run.startedAt)} – ${formatClock(endedAt)}`}
            />
            <LogField
              label="Wall clock"
              value={
                report.run.sessionSeconds === undefined
                  ? "—"
                  : formatDuration(report.run.sessionSeconds)
              }
            />
            <LogField
              label="Suite time"
              value={formatDuration(report.run.suiteSeconds)}
            />
            <LogField label="Platform" value={report.run.platform} />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function FixtureTable({ report }: { report: EvalReport }) {
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full caption-bottom text-sm">
          <thead>
            <tr className="border-b">
              <th className="h-10 px-2 text-left font-medium text-muted-foreground">
                Scenario
              </th>
              <th className="h-10 px-2 text-left font-medium text-muted-foreground">
                Type
              </th>
              <th className="h-10 px-2 text-left font-medium text-muted-foreground">
                Entries
              </th>
              <th className="h-10 px-2 text-left font-medium text-muted-foreground">
                Matched to a failing prompt
              </th>
            </tr>
          </thead>
          <tbody>
            {report.scenarios.map((scenario) => (
              <tr className="border-b" key={scenario.id}>
                <td className="p-2 font-medium font-mono">{scenario.id}</td>
                <td className="p-2">
                  <Badge variant="outline">{scenario.kind}</Badge>
                </td>
                <td className="p-2">{scenario.entries}</td>
                <td className="p-2 text-muted-foreground">
                  {scenario.matchedPrompts.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      {scenario.matchedPrompts.map((prompt) => (
                        <span key={prompt}>“{prompt}”</span>
                      ))}
                    </div>
                  ) : (
                    <span className="italic">
                      no failing prompt matched this theme
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.unmatchedPrompts.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {report.unmatchedPrompts.length} failing prompt
          {report.unmatchedPrompts.length === 1 ? "" : "s"} did not map to a
          known scenario: {report.unmatchedPrompts.join(", ")}.
        </p>
      ) : null}
    </>
  );
}

function LogField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="font-mono text-sm">{value}</p>
    </div>
  );
}
