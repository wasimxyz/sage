import { useSyncExternalStore } from "react";

import { type DeleteKind, hiddenIds, subscribe } from "@/lib/pending-deletes";

/** The ids of rows waiting out their undo window. Lists leave these out. */
export function useHiddenIds(kind: DeleteKind): ReadonlySet<number> {
  return useSyncExternalStore(subscribe, () => hiddenIds(kind));
}
