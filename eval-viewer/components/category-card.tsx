import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatTime, passRate } from "@/lib/reports/format.ts";
import type { CategorySummary } from "@/lib/reports/types.ts";
import { cn } from "@/lib/utils";

export function CategoryCard({
  category,
  href,
}: {
  category: CategorySummary;
  href?: string;
}) {
  const card =
    category.failed > 0 ? (
      <FailedCategoryCard category={category} />
    ) : (
      <PassedCategoryCard category={category} />
    );
  if (href === undefined) {
    return card;
  }
  return (
    <Link className="block hover:opacity-90" href={href}>
      {card}
    </Link>
  );
}

function PassedCategoryCard({ category }: { category: CategorySummary }) {
  return (
    <CategoryCardFrame barClassName="bg-pass" category={category} tone="pass" />
  );
}

function FailedCategoryCard({ category }: { category: CategorySummary }) {
  return (
    <CategoryCardFrame barClassName="bg-fail" category={category} tone="fail" />
  );
}

function CategoryCardFrame({
  barClassName,
  category,
  tone,
}: {
  barClassName: string;
  category: CategorySummary;
  tone: "fail" | "pass";
}) {
  const rate = passRate(category.passed, category.total);
  const frameClassName =
    tone === "fail" ? "border-t-2 border-t-fail" : "border-t-2 border-t-pass";
  return (
    <Card className={frameClassName} size="sm">
      <CardHeader>
        <CardTitle>{category.label}</CardTitle>
        <CardDescription>
          {category.failed > 0
            ? `${rate}% passed · ${category.failed} failed`
            : `${rate}% passed`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="font-medium font-mono text-xl">
          {category.passed}/{category.total}
        </p>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full", barClassName)}
            style={{ width: `${rate}%` }}
          />
        </div>
        <p className="font-mono text-muted-foreground text-xs">
          avg {formatTime(category.avg)} · max {formatTime(category.max)}
        </p>
      </CardContent>
    </Card>
  );
}
