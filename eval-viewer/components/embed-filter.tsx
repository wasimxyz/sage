"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function EmbedFilter({
  options,
  value,
}: {
  options: string[];
  value: string;
}) {
  const router = useRouter();
  const items = options.map((option) => ({
    label: option,
    value: option,
  }));
  const onValueChange = useCallback(
    (next: string | null) => {
      if (typeof next !== "string") {
        return;
      }
      router.push(`/?embed=${encodeURIComponent(next)}`);
    },
    [router]
  );

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-sm">Embeddings</span>
      <Select items={items} onValueChange={onValueChange} value={value}>
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
