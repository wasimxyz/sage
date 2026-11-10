import assert from "node:assert/strict";
import test from "node:test";

import { classifyReportFile } from "./file-names.ts";

test("classifyReportFile sends legacy run files to the run id", () => {
  const id = "qwen3_8b__nomic-embed-text__20260916T011701Z";
  assert.deepEqual(classifyReportFile(`${id}.xml`), { id, kind: "run" });
  assert.deepEqual(classifyReportFile(`sage-evals/${id}.sage.log`), {
    id,
    kind: "run",
  });
  assert.deepEqual(classifyReportFile(`/tmp/reports/${id}.manifest.json`), {
    id,
    kind: "run",
  });
});

test("classifyReportFile reads a setup report name", () => {
  assert.deepEqual(
    classifyReportFile("2026-11-09-screen__3f9a1c7b2e.report.json"),
    { kind: "setup", setupId: "3f9a1c7b2e", sweepId: "2026-11-09-screen" }
  );
  assert.deepEqual(
    classifyReportFile("sage-evals/2026-11-09-screen__3f9a1c7b2e.report.json"),
    { kind: "setup", setupId: "3f9a1c7b2e", sweepId: "2026-11-09-screen" }
  );
});

test("classifyReportFile splits on the last separator", () => {
  assert.deepEqual(classifyReportFile("nightly__a__0123456789.report.json"), {
    kind: "setup",
    setupId: "0123456789",
    sweepId: "nightly__a",
  });
});

test("classifyReportFile reads a sweep summary name", () => {
  assert.deepEqual(classifyReportFile("2026-11-09-screen.sweep.json"), {
    kind: "sweep",
    sweepId: "2026-11-09-screen",
  });
});

test("classifyReportFile skips names it cannot place", () => {
  assert.equal(classifyReportFile("2026-11-09-screen.report.json"), undefined);
  assert.equal(
    classifyReportFile("2026-11-09-screen__nothex.report.json"),
    undefined
  );
  assert.equal(classifyReportFile("__3f9a1c7b2e.report.json"), undefined);
  assert.equal(classifyReportFile(".sweep.json"), undefined);
  assert.equal(classifyReportFile("notes.txt"), undefined);
});
