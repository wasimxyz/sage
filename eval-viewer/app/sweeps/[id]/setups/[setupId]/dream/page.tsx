import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DreamAccuracy } from "@/components/dream-accuracy";
import { ReportProblem } from "@/components/report-problem";
import { loadSetupReport } from "@/lib/load-reports";
import { decodeParam, sweepHref } from "@/lib/reports/sweep-view.ts";

interface Params {
  id: string;
  setupId: string;
}

interface Search {
  claims?: string | string[];
  person?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  return text === undefined || text.length === 0 ? undefined : text;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { id, setupId } = await params;
  return {
    title: `Dream accuracy · ${decodeParam(setupId)} · ${decodeParam(id)} · Sage evals`,
  };
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const [{ id, setupId }, search] = await Promise.all([params, searchParams]);
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
        <ReportProblem
          kind={data.outcome.kind}
          message={data.outcome.message}
          what="setup report"
        />
      </div>
    );
  }
  return (
    <DreamAccuracy
      claimsOnly={first(search.claims) === "1"}
      person={first(search.person)}
      report={data.outcome.value}
    />
  );
}
