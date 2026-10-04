"use client";

import type { CSSProperties, ElementType } from "react";
import { memo } from "react";

import { cn } from "@/lib/utils";

export interface ShimmerProps {
  as?: ElementType;
  children: string;
  className?: string;
}

const shimmerStyle = {
  backgroundImage:
    "linear-gradient(90deg, transparent calc(50% - 20px), var(--color-background), transparent calc(50% + 20px)), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
} as CSSProperties;

const ShimmerComponent = ({
  as: Component = "span",
  children,
  className,
}: ShimmerProps) => (
  <Component
    className={cn(
      "relative inline-block bg-[length:250%_100%] bg-clip-text text-transparent [animation:conversation-shimmer_2s_linear_infinite]",
      className
    )}
    style={shimmerStyle}
  >
    {children}
  </Component>
);

export const Shimmer = memo(ShimmerComponent);
