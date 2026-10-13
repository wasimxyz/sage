import { onTitlebarPointerDown } from "@/components/app-titlebar";
import { Skeleton } from "@/components/ui/skeleton";
import { readingColumnClass } from "@/lib/page-column";
import { cn } from "@/lib/utils";

/** Same bands as the editor, so the page does not move when the entry loads. */
export function EditorSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="h-(--titlebar-height) shrink-0"
        data-slot="window-drag"
        onPointerDown={onTitlebarPointerDown}
      />
      <div className={cn(readingColumnClass, "flex flex-col gap-2 pb-2")}>
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className={cn(readingColumnClass, "flex flex-1 flex-col py-3")}>
        <Skeleton className="min-h-48 flex-1" />
      </div>
    </div>
  );
}
