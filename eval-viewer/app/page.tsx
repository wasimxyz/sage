import { HomeDashboard } from "@/components/home-dashboard";
import { loadRunSummaries } from "@/lib/load-reports";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ embed?: string }>;
}) {
  const { embed } = await searchParams;
  const runs = await loadRunSummaries();
  return <HomeDashboard embed={embed} runs={runs} />;
}
