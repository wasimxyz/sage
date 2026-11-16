import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ItemReader } from "@/components/item-reader";
import { ReportProblem } from "@/components/report-problem";
import { loadSetupReport } from "@/lib/load-reports";
import { itemKey, itemShortId } from "@/lib/reports/item-view.ts";
import { decodeParam, sweepHref } from "@/lib/reports/sweep-view.ts";

interface Params {
  id: string;
  setupId: string;
}

interface Search {
  id?: string | string[];
  repeat?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The repeat is 1 when the address leaves it out or gives nonsense. */
function repeatOf(value: string | undefined): number {
  const repeat = Number.parseInt(value ?? "1", 10);
  return Number.isInteger(repeat) && repeat >= 1 ? repeat : 1;
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Search>;
}): Promise<Metadata> {
  const itemId = first((await searchParams).id);
  return {
    title: `${itemId === undefined ? "Item" : itemShortId(itemId)} · Sage evals`,
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
  const itemId = first(search.id);
  const data = await loadSetupReport(decodeParam(id), decodeParam(setupId));
  if (data === null || itemId === undefined) {
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
  const report = data.outcome.value;
  const key = itemKey({ itemId, repeat: repeatOf(first(search.repeat)) });
  const index = report.items.findIndex(
    (candidate) => itemKey(candidate) === key
  );
  const item = report.items[index];
  if (item === undefined) {
    notFound();
  }
  return (
    <ItemReader
      item={item}
      next={report.items[index + 1]}
      previous={index > 0 ? report.items[index - 1] : undefined}
      report={report}
    />
  );
}
