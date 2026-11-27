// Only the user runs evals. A sweep spends money, takes a night, and loads every
// local model, so an agent never starts one. Claude Code sets `CLAUDECODE` in
// the shells it opens for an agent, and `run.ts` checks it before anything
// else, `--dry-run` and `--help` included. There is no flag that turns this
// off. To run a sweep, use your own terminal.

/** What the runner prints, and the exit code it ends with, when an agent starts it. */
export const AGENT_REFUSAL = "make eval is run by you, not by an agent.";
export const AGENT_REFUSAL_EXIT_CODE = 2;

/**
 * The message to print when the environment says an agent is running this, or
 * undefined when it is not. Any value counts, an empty one too, so a variable
 * that is merely set is enough.
 */
export function agentRefusal(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  return env.CLAUDECODE === undefined ? undefined : AGENT_REFUSAL;
}
