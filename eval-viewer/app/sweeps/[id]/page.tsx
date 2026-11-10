import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SweepReport } from "@/components/sweep-report";
import { loadSweep } from "@/lib/load-reports";
import { decodeParam } from "@/lib/reports/sweep-view.ts";

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
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sweep = await loadSweep(decodeParam(id));
  if (sweep === null) {
    notFound();
  }
  return <SweepReport sweep={sweep} />;
}
