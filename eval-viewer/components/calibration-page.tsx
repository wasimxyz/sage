import Link from "next/link";

import { GradingForm } from "@/components/grading-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  draftFromGrade,
  type GradeDraft,
  gradesBySample,
} from "@/lib/reports/calibration.ts";
import {
  calibrationLocation,
  listSampleFiles,
  readGrades,
  readSample,
} from "@/lib/reports/calibration-store.ts";

export function CalibrationPage({ sample }: { sample?: string }) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium tracking-tight">Grade by hand</h1>
        <p className="text-muted-foreground text-sm">
          Grade a sample of replies yourself. The judge check and the agreement
          check compare the judge with these grades. Each answer saves as you
          go, to agent/evals/content/calibration/grades.jsonl.
        </p>
      </div>
      {process.env.NODE_ENV === "development" ? (
        <Grading sample={sample} />
      ) : (
        <Alert>
          <AlertTitle>Grading saves only under make eval-viewer-dev</AlertTitle>
          <AlertDescription>
            This copy of the viewer was built to read reports. Stop it, then run
            make eval-viewer-dev from your checkout and open this page again.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

async function Grading({ sample }: { sample?: string }) {
  const { dir } = calibrationLocation(process.env, process.cwd());
  const files = await listSampleFiles(dir);
  if (files.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No calibration sample yet</EmptyTitle>
          <EmptyDescription>
            Write one with calibration-sample.ts in agent/scripts/eval. It saves
            sample-*.json in agent/evals/content/calibration.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const file =
    sample === undefined ? files[0] : files.find((name) => name === sample);
  if (file === undefined) {
    return (
      <Alert variant="destructive">
        <AlertTitle>No such sample</AlertTitle>
        <AlertDescription>
          The calibration folder has no file named {sample}.
        </AlertDescription>
      </Alert>
    );
  }
  const [parsed, grades] = await Promise.all([
    readSample(dir, file),
    readGrades(dir),
  ]);
  if (parsed.kind !== "ok") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not read {file}</AlertTitle>
        <AlertDescription>{parsed.message}</AlertDescription>
      </Alert>
    );
  }
  const saved = gradesBySample(grades, parsed.value.sampleId);
  const initial: Record<string, GradeDraft> = {};
  for (const item of parsed.value.items) {
    const grade = saved.get(item.id);
    if (grade !== undefined) {
      initial[item.id] = draftFromGrade(grade);
    }
  }
  return (
    <>
      {files.length > 1 ? (
        <nav
          aria-label="Samples"
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          {files.map((name) => (
            <Link
              aria-current={name === file ? "true" : undefined}
              href={`/calibration?sample=${encodeURIComponent(name)}`}
              key={name}
            >
              <Badge variant={name === file ? "default" : "outline"}>
                {name}
              </Badge>
            </Link>
          ))}
        </nav>
      ) : (
        <p className="text-muted-foreground font-mono text-xs">{file}</p>
      )}
      <GradingForm
        initial={initial}
        key={`${file}-${parsed.value.sampleId}`}
        sample={parsed.value}
        sampleFile={file}
      />
    </>
  );
}
