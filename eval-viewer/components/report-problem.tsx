import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function ReportProblem({
  kind,
  message,
  what,
}: {
  kind: "invalid" | "unsupported";
  message: string;
  what: string;
}) {
  return (
    <Alert variant="destructive">
      <AlertTitle>
        {kind === "unsupported"
          ? `Unsupported ${what}`
          : `Could not read this ${what}`}
      </AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
