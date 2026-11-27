// Entry point for `make eval`. The work is in runner.ts.
//
//   node --experimental-strip-types agent/scripts/eval/run.ts [--sweep <name>] [--dry-run] [--yes] [eve filters]
//
// The command line is read before anything else loads, so a bad option
// (including --url) stops here with exit code 2.

import { CliError, parseCli } from "./cli.ts";

try {
  parseCli(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(error.exitCode);
  }
  throw error;
}

const { main } = await import("./runner.ts");
process.exitCode = await main();
