import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CompareView } from "@/components/compare-view";
import { loadSweep } from "@/lib/load-reports";
import { parseCompareQuery } from "@/lib/reports/compare.ts";
import { decodeParam } from "@/lib/reports/sweep-view.ts";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `Compare setups · ${decodeParam(id)} · Sage evals` };
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  const sweep = await loadSweep(decodeParam(id));
  if (sweep === null) {
    notFound();
  }
  return <CompareView query={parseCompareQuery(search)} sweep={sweep} />;
}
