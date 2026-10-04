import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatTime } from "@/lib/reports/format.ts";
import type { EvalReport } from "@/lib/reports/types.ts";

export function DurationHistograms({ report }: { report: EvalReport }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {report.categories.map((category) => {
        const values = report.passedDurations[category.id] ?? [];
        return (
          <Card key={category.id} size="sm">
            <CardHeader>
              <CardTitle>{category.label}</CardTitle>
              <CardDescription>
                {values.length === 0
                  ? "no passed runs"
                  : `${values.length} passed · ${formatTime(Math.min(...values))}–${formatTime(Math.max(...values))}`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Histogram values={values} />
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function Histogram({ values }: { values: number[] }) {
  if (values.length === 0) {
    return <div className="h-14 rounded-md bg-muted" />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const bins = 14;
  const width = 240;
  const height = 52;
  const counts = Array.from({ length: bins }, () => 0);
  const span = max - min || 1;
  for (const value of values) {
    let index = Math.floor(((value - min) / span) * bins);
    if (index >= bins) {
      index = bins - 1;
    }
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const maxCount = Math.max(...counts);
  const barWidth = width / bins;
  return (
    <svg
      className="h-14 w-full"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${height}`}
    >
      <title>Passed eval durations</title>
      {counts.map((count, index) => {
        const barHeight =
          maxCount === 0 ? 0 : (count / maxCount) * (height - 4);
        const binStart = min + (index / bins) * span;
        return (
          <rect
            className="fill-primary/75"
            height={barHeight.toFixed(1)}
            key={binStart}
            rx="1"
            width={(barWidth - 2).toFixed(1)}
            x={(index * barWidth + 1).toFixed(1)}
            y={(height - barHeight).toFixed(1)}
          />
        );
      })}
    </svg>
  );
}
