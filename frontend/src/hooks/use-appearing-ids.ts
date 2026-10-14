import { useEffect, useState } from "react";

// A list that gains this many rows or fewer animates them in.
const animateUpTo = 2;
const none: ReadonlySet<number> = new Set();

/**
 * Which row ids to animate in. A new entry or a restored chat animates. A
 * first load, an import, or a refresh adds many rows at once, and those show
 * quietly: animating a thousand rows is noise and costs frames.
 */
export function useAppearingIds(ids: readonly number[]): ReadonlySet<number> {
  const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set(ids));
  const added = ids.filter((id) => !seen.has(id));

  useEffect(() => {
    setSeen((current) =>
      ids.every((id) => current.has(id)) ? current : new Set(ids)
    );
  }, [ids]);

  return added.length > 0 && added.length <= animateUpTo
    ? new Set(added)
    : none;
}
