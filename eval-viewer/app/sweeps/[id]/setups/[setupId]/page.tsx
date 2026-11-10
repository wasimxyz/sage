import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ReportProblem } from "@/components/report-problem";
import { SetupReportView } from "@/components/setup-report";
import { loadSetupReport } from "@/lib/load-reports";
import { decodeParam, sweepHref } from "@/lib/reports/sweep-view.ts";

interface Params {
  id: string;
  setupId: string;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { id, setupId } = await params;
  return { title: `${decodeParam(setupId)} · ${decodeParam(id)} · Sage evals` };
}

export default async function Page({ params }: { params: Promise<Params> }) {
  const { id, setupId } = await params;
  const data = await loadSetupReport(decodeParam(id), decodeParam(setupId));
  if (data === null) {
    notFound();
  }
  if (data.outcome.kind !== "ok") {
    return (
      <div className="flex flex-col gap-8">
        <Link
          className="text-muted-foreground w-fit text-sm underline-offset-4 hover:underline"
          href={sweepHref(data.sweepId)}
        >
          ← Back to sweep {data.sweepId}
        </Link>
        <h1 className="font-mono text-2xl font-medium tracking-tight">
          {data.setupId}
        </h1>
        <ReportProblem
          kind={data.outcome.kind}
          message={data.outcome.message}
          what="setup report"
        />
      </div>
    );
  }
  return <SetupReportView report={data.outcome.value} />;
}
