import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RunReport } from "@/components/run-report";
import { loadReport } from "@/lib/load-reports";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `${id} · Sage evals` };
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ category?: string }>;
}) {
  const { id } = await params;
  const { category } = await searchParams;
  const report = await loadReport(id);
  if (report === null) {
    notFound();
  }
  return <RunReport category={category} report={report} />;
}
