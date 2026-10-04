"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

export default function EvalRunError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-medium text-lg">Could not load this eval run</h2>
      <p className="text-muted-foreground text-sm">{error.message}</p>
      <Button className="w-fit" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
