import type { Metadata } from "next";

import { CalibrationPage } from "@/components/calibration-page";

export const metadata: Metadata = { title: "Grade by hand · Sage evals" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ sample?: string | string[] }>;
}) {
  const { sample } = await searchParams;
  return (
    <CalibrationPage sample={Array.isArray(sample) ? sample[0] : sample} />
  );
}
