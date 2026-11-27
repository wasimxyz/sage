// Command line for the runner:
//
//   run.ts [--sweep <name>] [--resume <sweep id>] [--compare <sweep id>] [--dry-run] [--yes] [eve filters]
//
// `make eval` passes `ARGS` straight through, so the eve filters here are the
// ones people use: `--tag`, `--exclude-tag`, and a few switches. The runner
// owns the target URL, the concurrency, and the output files.

export const URL_MESSAGE =
  "make eval controls the target URL; do not pass --url in ARGS.";

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export interface CliOptions {
  /** The finished sweep that `head-to-head` and `calibration` read. Set by `--compare`. */
  compare?: string;
  dryRun: boolean;
  /** Arguments for every `eve eval` process, such as `--tag example`. */
  eveFilters: string[];
  help: boolean;
  /** The run to go on with. Set by `--resume`. */
  resume?: string;
  sweep: string;
  yes: boolean;
}

/** Eve options that take a value. */
const valueOptions = new Set(["--exclude-tag", "--tag", "--timeout"]);
/** Eve options that take none. */
const switchOptions = new Set(["--skip-report", "--strict", "--verbose"]);
/** Eve options the runner sets itself. */
const ownedOptions = new Set([
  "--json",
  "--junit",
  "--list",
  "--max-concurrency",
]);

export const USAGE = `Usage: make eval [SWEEP=<name>] [ARGS='...']

Options (in ARGS):
  --sweep <name>   Sweep file in agent/evals/content/sweeps (default: default)
  --resume <id>    Go on with a sweep that stopped, under the same id. It skips
                   the steps that finished, and refuses when the sweep file
                   changed. The id is a folder name in agent/evals/.runs/.
  --compare <id>   For the head-to-head sweep: the finished sweep whose top
                   setups the judge compares. For the calibration sweep: the
                   sweep whose sample is used.
  --dry-run        Plan, build the Chat prompt overlays, check them, start the
                   grade target, and print the estimate. Runs no models.
  --yes            Skip the question after the estimate
  --tag <tag>      Run only evals with this tag (repeatable)
  --exclude-tag <tag>
  --timeout <ms>   Per-eval timeout
  --strict, --verbose, --skip-report
                   Passed to eve eval`;

function optionName(arg: string): string {
  const equals = arg.indexOf("=");
  return equals === -1 ? arg : arg.slice(0, equals);
}

/** Hands out the arguments one at a time, and reads an option's value. */
class ArgReader {
  private index = 0;
  private readonly argv: readonly string[];

  constructor(argv: readonly string[]) {
    this.argv = argv;
  }

  next(): string | undefined {
    const arg = this.argv[this.index];
    this.index += 1;
    return arg;
  }

  /** The value after an option, which must not look like another option. */
  value(name: string): string {
    const next = this.argv[this.index];
    if (next === undefined || next.startsWith("--")) {
      throw new CliError(`${name} needs a value.`);
    }
    this.index += 1;
    return next;
  }
}

const sweepIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** A sweep id names a folder and files, so it holds no path characters. */
function sweepIdValue(name: string, value: string): string {
  if (!sweepIdPattern.test(value)) {
    throw new CliError(
      `${name} needs a sweep id such as 2026-11-10T031500Z-screen.`
    );
  }
  return value;
}

function applyArg(options: CliOptions, arg: string, reader: ArgReader): void {
  const name = optionName(arg);
  const takeValue = (): string =>
    arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : reader.value(name);
  if (name === "--sweep") {
    options.sweep = takeValue();
  } else if (name === "--resume") {
    options.resume = sweepIdValue(name, takeValue());
  } else if (name === "--compare") {
    options.compare = sweepIdValue(name, takeValue());
  } else if (valueOptions.has(name)) {
    options.eveFilters.push(name, takeValue());
  } else if (switchOptions.has(name)) {
    options.eveFilters.push(name);
  } else if (name === "--dry-run") {
    options.dryRun = true;
  } else if (name === "--yes" || arg === "-y") {
    options.yes = true;
  } else if (name === "--help" || arg === "-h") {
    options.help = true;
  } else if (ownedOptions.has(name)) {
    throw new CliError(`${name} is set by the runner. Remove it from ARGS.`);
  } else if (arg.startsWith("-")) {
    throw new CliError(`Unknown option ${arg}.\n\n${USAGE}`);
  } else {
    throw new CliError(
      `Unexpected argument "${arg}". The sweep file's tests say which evals run; use --sweep to pick a file.\n\n${USAGE}`
    );
  }
}

export function parseCli(argv: readonly string[]): CliOptions {
  // The URL check comes first, so no other option can hide it.
  for (const arg of argv) {
    if (arg === "--url" || arg.startsWith("--url=")) {
      throw new CliError(URL_MESSAGE);
    }
  }
  const options: CliOptions = {
    dryRun: false,
    eveFilters: [],
    help: false,
    sweep: "default",
    yes: false,
  };
  const reader = new ArgReader(argv);
  for (let arg = reader.next(); arg !== undefined; arg = reader.next()) {
    applyArg(options, arg, reader);
  }
  if (options.resume !== undefined && options.compare !== undefined) {
    throw new CliError(
      "--resume goes on with a sweep that stopped, and --compare names a sweep to read. Use one of them."
    );
  }
  return options;
}
