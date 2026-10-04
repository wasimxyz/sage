import { Skeleton } from "@/components/ui/skeleton";

export function EditorSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3 px-6 py-4">
      <Skeleton className="size-7" />
      <Skeleton className="h-9 w-2/3" />
      <Skeleton className="h-4 w-40" />
      <Skeleton className="min-h-48 flex-1" />
    </div>
  );
}
