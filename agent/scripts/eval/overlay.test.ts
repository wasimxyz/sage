import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  availablePrompts,
  buildOverlay,
  buildTargetRoot,
  infoProblems,
  liveToolNames,
  overlayRoot,
  promptPath,
  readPrompt,
  sha12,
  TARGET_ROOT_NAME,
  verifyRoot,
} from "./overlay.ts";
import { fakeEve, tempDir } from "./test-fixtures.ts";

const pattern1 = /No Chat prompt file .*Prompts here: baseline, companion-v1/u;
const pattern2 = /nope\.md/u;
const pattern3 = /mockModel/u;
const pattern4 = /from "eve\/evals"/u;
const pattern5 = /does not depend on eve/u;
const pattern6 = /not \/roots\/baseline/u;
const pattern7 = /missing the search_journal tool/u;
const pattern8 =
  /is not ready:[\s\S]*not "ready"[\s\S]*1 error[\s\S]*missing the search_journal tool/u;
const pattern9 = /eve info failed/u;
const pattern10 = /did not print JSON/u;

const liveInstructions = "You are Sage. The live prompt.\n";
const companion = "You are Sage, a companion. The new prompt.\n";

/** A small stand-in for agent/ with the files an overlay copies. */
function fakeAgentDir(t: test.TestContext): string {
  const dir = tempDir(t);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      dependencies: { eve: "^0.80.1" },
      imports: { "#*": "./agent/*" },
      name: "sage-agent",
    })
  );
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  mkdirSync(join(dir, "agent", "lib"), { recursive: true });
  mkdirSync(join(dir, "agent", "tools"), { recursive: true });
  mkdirSync(join(dir, "evals", "prompts"), { recursive: true });
  writeFileSync(join(dir, "agent", "agent.ts"), "export default {};\n");
  writeFileSync(join(dir, "agent", "instructions.md"), liveInstructions);
  writeFileSync(join(dir, "agent", "lib", "x.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, "agent", "tools", "search_journal.ts"), "");
  writeFileSync(join(dir, "agent", "tools", "get_chat.ts"), "");
  writeFileSync(join(dir, "evals", "prompts", "companion-v1.md"), companion);
  return dir;
}

function treeHash(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        hash.update(path);
        hash.update(readFileSync(path));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

test("the baseline overlay copies the live instructions", (t) => {
  const agentDir = fakeAgentDir(t);
  const overlay = buildOverlay(agentDir, "baseline");
  assert.equal(overlay.root, overlayRoot(agentDir, "baseline"));
  assert.equal(overlay.prompt, "baseline");
  assert.equal(overlay.promptSha, sha12(liveInstructions));
  assert.equal(
    readFileSync(join(overlay.root, "agent", "instructions.md"), "utf8"),
    liveInstructions
  );
  assert.equal(
    readFileSync(join(overlay.root, "agent", "lib", "x.ts"), "utf8"),
    "export const x = 1;\n"
  );
  assert.equal(
    JSON.parse(readFileSync(join(overlay.root, "package.json"), "utf8")).name,
    "sage-agent",
    "the overlay keeps the app's name"
  );
  assert.ok(existsSync(join(overlay.root, "tsconfig.json")));
});

test("a prompt overlay swaps instructions.md and nothing else", (t) => {
  const agentDir = fakeAgentDir(t);
  const overlay = buildOverlay(agentDir, "companion-v1");
  assert.equal(
    readFileSync(join(overlay.root, "agent", "instructions.md"), "utf8"),
    companion
  );
  assert.equal(overlay.promptSha, sha12(companion));
  assert.equal(
    readFileSync(join(overlay.root, "agent", "agent.ts"), "utf8"),
    readFileSync(join(agentDir, "agent", "agent.ts"), "utf8")
  );
});

test("building an overlay never touches agent/agent/", (t) => {
  const agentDir = fakeAgentDir(t);
  const before = treeHash(join(agentDir, "agent"));
  buildOverlay(agentDir, "companion-v1");
  buildOverlay(agentDir, "baseline");
  buildTargetRoot(agentDir);
  assert.equal(treeHash(join(agentDir, "agent")), before);
  assert.equal(
    readFileSync(join(agentDir, "agent", "instructions.md"), "utf8"),
    liveInstructions
  );
});

test("rebuilding keeps the .eve build cache and drops files the app no longer has", (t) => {
  const agentDir = fakeAgentDir(t);
  const first = buildOverlay(agentDir, "baseline");
  mkdirSync(join(first.root, ".eve", "compile"), { recursive: true });
  writeFileSync(join(first.root, ".eve", "compile", "cache"), "cached");
  writeFileSync(join(first.root, "agent", "old.ts"), "stale");
  buildOverlay(agentDir, "baseline");
  assert.equal(
    readFileSync(join(first.root, ".eve", "compile", "cache"), "utf8"),
    "cached"
  );
  assert.equal(existsSync(join(first.root, "agent", "old.ts")), false);
});

test("a prompt with no file names the ones there are", (t) => {
  const agentDir = fakeAgentDir(t);
  assert.deepEqual(availablePrompts(agentDir), ["baseline", "companion-v1"]);
  assert.throws(() => buildOverlay(agentDir, "nope"), pattern1);
  assert.throws(() => readPrompt(agentDir, "nope"), pattern2);
  assert.equal(
    promptPath(agentDir, "baseline"),
    join(agentDir, "agent", "instructions.md")
  );
});

test("the stub target is an eve app named sage-agent with a mock model", (t) => {
  const agentDir = fakeAgentDir(t);
  const root = buildTargetRoot(agentDir);
  assert.equal(root, overlayRoot(agentDir, TARGET_ROOT_NAME));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "sage-agent");
  assert.equal(
    manifest.dependencies.eve,
    "^0.80.1",
    "eve is declared, so eve finds the project"
  );
  const agent = readFileSync(join(root, "agent", "agent.ts"), "utf8");
  assert.match(agent, pattern3);
  assert.match(agent, pattern4);
  assert.ok(existsSync(join(root, "agent", "instructions.md")));
});

test("the stub target needs eve in agent/package.json", (t) => {
  const agentDir = fakeAgentDir(t);
  writeFileSync(
    join(agentDir, "package.json"),
    JSON.stringify({ name: "sage-agent" })
  );
  assert.throws(() => buildTargetRoot(agentDir), pattern5);
});

test("liveToolNames lists the tools the live agent has", (t) => {
  assert.deepEqual(liveToolNames(fakeAgentDir(t)), [
    "get_chat",
    "search_journal",
  ]);
});

test("infoProblems checks status, errors, the app root, and the tools", () => {
  const good = {
    appRoot: "/roots/baseline",
    diagnostics: { errors: 0, warnings: 0 },
    status: "ready",
    tools: ["get_chat", "search_journal"],
  };
  const expect = { root: "/roots/baseline", tools: ["search_journal"] };
  assert.deepEqual(infoProblems(good, expect), []);
  assert.equal(infoProblems({ ...good, status: "error" }, expect).length, 1);
  assert.equal(
    infoProblems({ ...good, diagnostics: { errors: 2 } }, expect).length,
    1
  );
  assert.match(
    infoProblems({ ...good, appRoot: "/elsewhere" }, expect)[0] ?? "",
    pattern6
  );
  assert.match(
    infoProblems({ ...good, tools: ["get_chat"] }, expect)[0] ?? "",
    pattern7
  );
  assert.equal(infoProblems(null, expect).length >= 2, true);
  assert.deepEqual(
    infoProblems(good, { root: "/roots/baseline", tools: null }),
    []
  );
});

test("verifyRoot runs eve info in the root and accepts a ready app", async (t) => {
  const agentDir = fakeAgentDir(t);
  const root = join(agentDir, "root");
  mkdirSync(root, { recursive: true });
  fakeEve(
    agentDir,
    `console.log(JSON.stringify({ appRoot: process.cwd(), diagnostics: { errors: 0 }, status: "ready", tools: ["search_journal"], argv: args }));`
  );
  const { info } = await verifyRoot(agentDir, root, ["search_journal"]);
  assert.deepEqual((info as { argv: string[] }).argv, ["info", "--json"]);
});

test("verifyRoot throws every problem eve info shows", async (t) => {
  const agentDir = fakeAgentDir(t);
  const root = join(agentDir, "root");
  mkdirSync(root, { recursive: true });
  fakeEve(
    agentDir,
    `console.log(JSON.stringify({ appRoot: process.cwd(), diagnostics: { errors: 1 }, status: "error", tools: [] }));`
  );
  await assert.rejects(
    verifyRoot(agentDir, root, ["search_journal"]),
    pattern8
  );
  fakeEve(agentDir, "console.error('No eve project'); process.exit(1);");
  await assert.rejects(verifyRoot(agentDir, root, null), pattern9);
  fakeEve(agentDir, "console.log('not json');");
  await assert.rejects(verifyRoot(agentDir, root, null), pattern10);
});
