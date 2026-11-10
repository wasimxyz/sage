import { HomeDashboard } from "@/components/home-dashboard";
import { loadRunSummaries, loadSweepList } from "@/lib/load-reports";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ embed?: string }>;
}) {
  const { embed } = await searchParams;
  const [runs, sweeps] = await Promise.all([
    loadRunSummaries(),
    loadSweepList(),
  ]);
  return <HomeDashboard embed={embed} runs={runs} sweeps={sweeps} />;
}
