// Chat prompt overlays.
//
// The runner never edits `agent/agent/`, and shipped code never reads a prompt
// setting. To compare Chat prompts, it builds one app root per prompt under
// `agent/.eval-roots/<prompt>/`: a copy of `agent/package.json`,
// `tsconfig.json`, and `agent/agent/`, with `instructions.md` swapped for the
// prompt file. Node still finds `agent/node_modules` by walking up. `baseline`
// copies the live `instructions.md`, so every prompt runs under the same
// conditions.
//
// `_target` is a stub eve app named `sage-agent` with a mock model. The
// person and grade passes never send a message, but `eve eval --url` insists
// on a target that answers as `sage-agent`.

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { BASELINE_PROMPT } from "../../evals/lib/schema.ts";
import { withoutSecrets } from "./env.ts";
import { eveBin } from "./eve.ts";
import { captureCommand } from "./proc.ts";

export const TARGET_ROOT_NAME = "_target";

const textFiles = ["package.json", "tsconfig.json"] as const;

export function overlayRootsDir(agentDir: string): string {
  return join(agentDir, ".eval-roots");
}

export function overlayRoot(agentDir: string, name: string): string {
  return join(overlayRootsDir(agentDir), name);
}

export function promptsDir(agentDir: string): string {
  return join(agentDir, "evals", "prompts");
}

export function liveInstructionsPath(agentDir: string): string {
  return join(agentDir, "agent", "instructions.md");
}

/** The prompts the repo has, by name. `baseline` is always available. */
export function availablePrompts(agentDir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(promptsDir(agentDir))
      .filter((name) => name.endsWith(".md") && !name.startsWith("."))
      .map((name) => name.slice(0, -".md".length));
  } catch {
    // No prompts folder yet.
  }
  return [
    BASELINE_PROMPT,
    ...names.filter((n) => n !== BASELINE_PROMPT),
  ].sort();
}

/** The path of the file that holds a prompt's text. `baseline` is the live instructions. */
export function promptPath(agentDir: string, prompt: string): string {
  return prompt === BASELINE_PROMPT
    ? liveInstructionsPath(agentDir)
    : join(promptsDir(agentDir), `${prompt}.md`);
}

export function readPrompt(agentDir: string, prompt: string): string {
  const path = promptPath(agentDir, prompt);
  if (!existsSync(path)) {
    throw new Error(
      `No Chat prompt file ${path}. Prompts here: ${availablePrompts(agentDir).join(", ")}.`
    );
  }
  return readFileSync(path, "utf8");
}

/** A short fingerprint of text, for reports. */
export function sha12(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export interface Overlay {
  prompt: string;
  promptSha: string;
  root: string;
}

/**
 * Builds or refreshes `agent/.eval-roots/<prompt>/`. The `.eve` build cache
 * inside it is kept, so later people and later runs reuse the build.
 */
export function buildOverlay(agentDir: string, prompt: string): Overlay {
  const text = readPrompt(agentDir, prompt);
  const root = overlayRoot(agentDir, prompt);
  mkdirSync(root, { recursive: true });
  for (const file of textFiles) {
    const source = join(agentDir, file);
    if (existsSync(source)) {
      cpSync(source, join(root, file));
    }
  }
  const copy = join(root, "agent");
  rmSync(copy, { force: true, recursive: true });
  cpSync(join(agentDir, "agent"), copy, { recursive: true });
  writeFileSync(join(copy, "instructions.md"), text, "utf8");
  return { prompt, promptSha: sha12(text), root };
}

const targetAgent = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// The person and grade passes never send a message. This model answers
// nothing a pass would use.
export default defineAgent({
  defaultTools: false,
  model: mockModel("This target does not answer."),
});
`;

/** Builds or refreshes the stub `sage-agent` app that the person and grade passes target. */
export function buildTargetRoot(agentDir: string): string {
  const root = overlayRoot(agentDir, TARGET_ROOT_NAME);
  const live = JSON.parse(
    readFileSync(join(agentDir, "package.json"), "utf8")
  ) as { dependencies?: Record<string, string>; name?: string };
  const eveRange = live.dependencies?.eve;
  if (eveRange === undefined) {
    throw new Error("agent/package.json does not depend on eve.");
  }
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        dependencies: { eve: eveRange },
        name: live.name ?? "sage-agent",
        private: true,
        type: "module",
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writeFileSync(join(root, "agent", "agent.ts"), targetAgent, "utf8");
  writeFileSync(
    join(root, "agent", "instructions.md"),
    "This stub target never talks.\n",
    "utf8"
  );
  return root;
}

interface InfoShape {
  appRoot?: unknown;
  diagnostics?: { errors?: unknown };
  status?: unknown;
  tools?: unknown;
}

/** What is wrong with an `eve info --json` reading of an overlay. Empty when nothing is. */
export function infoProblems(
  info: unknown,
  expect: { root: string; tools: readonly string[] | null }
): string[] {
  const problems: string[] = [];
  const shape: InfoShape =
    info !== null && typeof info === "object" ? (info as InfoShape) : {};
  if (shape.status !== "ready") {
    problems.push(
      `eve reports status ${JSON.stringify(shape.status)}, not "ready".`
    );
  }
  if (
    typeof shape.diagnostics?.errors === "number" &&
    shape.diagnostics.errors > 0
  ) {
    problems.push(`eve reports ${shape.diagnostics.errors} error(s).`);
  }
  if (typeof shape.appRoot !== "string") {
    problems.push("eve did not report an app root.");
  } else if (!sameDirectory(shape.appRoot, expect.root)) {
    problems.push(`eve loaded ${shape.appRoot}, not ${expect.root}.`);
  }
  if (expect.tools !== null) {
    const tools = Array.isArray(shape.tools) ? shape.tools : [];
    for (const tool of expect.tools) {
      if (!tools.includes(tool)) {
        problems.push(`The overlay is missing the ${tool} tool.`);
      }
    }
  }
  return problems;
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

/** Runs `eve info --json` in the root and checks it. Throws with every problem. */
export async function verifyRoot(
  agentDir: string,
  root: string,
  tools: readonly string[] | null
): Promise<{ info: unknown }> {
  const result = await captureCommand(eveBin(agentDir), ["info", "--json"], {
    cwd: root,
    env: { ...withoutSecrets(), EVE_TELEMETRY_DISABLED: "1" },
  });
  if (result.code !== 0) {
    throw new Error(
      `eve info failed in ${root} (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
  let info: unknown;
  try {
    info = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`eve info in ${root} did not print JSON.`, {
      cause: error,
    });
  }
  const problems = infoProblems(info, { root, tools });
  if (problems.length > 0) {
    throw new Error(
      `The root ${root} is not ready:\n  ${problems.join("\n  ")}`
    );
  }
  return { info };
}

/** The tools the live agent has, which each overlay must keep. */
export function liveToolNames(agentDir: string): string[] {
  try {
    return readdirSync(join(agentDir, "agent", "tools"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.slice(0, -".ts".length))
      .sort();
  } catch {
    return [];
  }
}
