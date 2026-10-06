import { useCallback } from "react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { idleTimeoutOptions } from "@/lib/idle-timeout";

const selectItems = idleTimeoutOptions.map(({ label, value }) => ({
  label,
  value: String(value),
}));

/**
 * The inactivity choices for the lock: Never, 1, 5, 15, and 30 minutes. Both
 * Settings > Security and setup use it, so the two cannot offer different
 * lists.
 */
export function IdleTimeoutSelect({
  disabled,
  id,
  label,
  onChange,
  value,
}: {
  disabled?: boolean;
  id?: string;
  /** The accessible name when no visible label points at the field. */
  label?: string;
  onChange: (idleTimeoutMs: number) => void;
  value: number;
}) {
  const handleValueChange = useCallback(
    (next: string | null) => {
      if (next !== null) {
        onChange(Number(next));
      }
    },
    [onChange]
  );

  return (
    <Select
      disabled={disabled}
      items={selectItems}
      onValueChange={handleValueChange}
      value={String(value)}
    >
      <SelectTrigger aria-label={label} className="bg-card" id={id} size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {idleTimeoutOptions.map((option) => (
            <SelectItem key={option.value} value={String(option.value)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
