import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SweepReport } from "@/components/sweep-report";
import { loadSweep } from "@/lib/load-reports";
import { decodeParam, parseRankingSort } from "@/lib/reports/sweep-view.ts";

interface Search {
  dir?: string | string[];
  sort?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `${decodeParam(id)} · Sage evals` };
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  const sweep = await loadSweep(decodeParam(id));
  if (sweep === null) {
    notFound();
  }
  return (
    <SweepReport
      sort={parseRankingSort(first(search.sort), first(search.dir))}
      sweep={sweep}
    />
  );
}
