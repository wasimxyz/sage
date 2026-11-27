import assert from "node:assert/strict";
import test from "node:test";

import { CliError, parseCli, URL_MESSAGE } from "./cli.ts";

const pattern1 = /set by the runner/u;
const pattern2 = /Unknown option/u;
const pattern3 = /Unexpected argument/u;
const pattern4 = /needs a value/u;

test("no arguments gives the default sweep", () => {
  assert.deepEqual(parseCli([]), {
    dryRun: false,
    eveFilters: [],
    help: false,
    sweep: "default",
    yes: false,
  });
});

test("--sweep, --dry-run, and --yes", () => {
  const options = parseCli(["--sweep", "smoke", "--dry-run", "--yes"]);
  assert.equal(options.sweep, "smoke");
  assert.equal(options.dryRun, true);
  assert.equal(options.yes, true);
  assert.equal(parseCli(["--sweep=screen"]).sweep, "screen");
  assert.equal(parseCli(["-y"]).yes, true);
  assert.equal(parseCli(["--help"]).help, true);
});

test("eve filters pass through in order", () => {
  const options = parseCli([
    "--tag",
    "example",
    "--exclude-tag=slow",
    "--strict",
    "--timeout",
    "60000",
  ]);
  assert.deepEqual(options.eveFilters, [
    "--tag",
    "example",
    "--exclude-tag",
    "slow",
    "--strict",
    "--timeout",
    "60000",
  ]);
});

test("--url is refused with the old message and exit code 2", () => {
  for (const argv of [["--url", "x"], ["--url=x"], ["--yes", "--url", "x"]]) {
    assert.throws(
      () => parseCli(argv),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === 2 &&
        error.message === URL_MESSAGE
    );
  }
  assert.equal(
    URL_MESSAGE,
    "make eval controls the target URL; do not pass --url in ARGS."
  );
});

test("options the runner owns, unknown options, and stray words are refused", () => {
  for (const argv of [
    ["--junit", "x.xml"],
    ["--list"],
    ["--json"],
    ["--max-concurrency", "4"],
  ]) {
    assert.throws(() => parseCli(argv), pattern1);
  }
  assert.throws(() => parseCli(["--bogus"]), pattern2);
  assert.throws(() => parseCli(["extraction"]), pattern3);
  assert.throws(() => parseCli(["--tag"]), pattern4);
  assert.throws(() => parseCli(["--tag", "--strict"]), pattern4);
});
