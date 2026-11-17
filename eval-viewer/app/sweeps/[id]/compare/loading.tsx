import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-8">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-10" />
      <Skeleton className="h-48" />
      <Skeleton className="h-64" />
    </div>
  );
}
