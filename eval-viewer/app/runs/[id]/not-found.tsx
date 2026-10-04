import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

export default function NotFound() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>No report for this run</EmptyTitle>
        <EmptyDescription>
          The XML for this run id is not in Vercel Blob or the local reports
          folder.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button nativeButton={false} render={<Link href="/" />}>
          Back to overview
        </Button>
      </EmptyContent>
    </Empty>
  );
}
