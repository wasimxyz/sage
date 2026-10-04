import { Badge } from "@/components/ui/badge";
import { passRateTone } from "@/lib/reports/format.ts";
import { cn } from "@/lib/utils";

const toneText = {
  fail: "text-fail",
  pass: "text-pass",
  warn: "text-warn",
} as const;

export function PassRate({
  className,
  rate,
}: {
  className?: string;
  rate: number;
}) {
  return (
    <span
      className={cn(
        "font-medium font-mono",
        toneText[passRateTone(rate)],
        className
      )}
    >
      {rate}%
    </span>
  );
}

export function PassRateBadge({ rate }: { rate: number }) {
  return (
    <Badge className={toneText[passRateTone(rate)]} variant="secondary">
      {rate}%
    </Badge>
  );
}
