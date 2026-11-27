// Entry point for `make eval`. The work is in runner.ts.
//
//   node --experimental-strip-types agent/scripts/eval/run.ts [--sweep <name>] [--dry-run] [--yes] [eve filters]
//
// Only the user runs evals. An agent shell has CLAUDECODE set, and the run
// stops here with exit code 2, before the command line is read, so --dry-run
// and --help are refused too. There is no flag to turn this off.
//
// The command line is read before anything else loads, so a bad option
// (including --url) stops here with exit code 2.

import { AGENT_REFUSAL_EXIT_CODE, agentRefusal } from "./agent-guard.ts";

const refusal = agentRefusal(process.env);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(AGENT_REFUSAL_EXIT_CODE);
}

const { CliError, parseCli } = await import("./cli.ts");

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
