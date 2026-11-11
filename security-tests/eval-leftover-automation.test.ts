// make eval must not leave an automation-enabled binary at zig-out/bin/Sage.
// The runner builds with `-Dautomation=true` under its own install prefixes
// (zig-out/eval-mem1 and zig-out/eval-mem0) and deletes them on the way out.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  installPrefix,
  nativeBuildArgs,
  removeBuilds,
  sageBinary,
} from "../agent/scripts/eval/sage.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf8");

test("the automation build goes under its own install prefix", () => {
  const root = "/work/sage";
  for (const memory of ["on", "off"] as const) {
    const prefix = installPrefix(root, memory);
    assert.ok(prefix.startsWith(join(root, "zig-out", "eval-mem")));
    assert.notEqual(prefix, join(root, "zig-out"));
    const args = nativeBuildArgs(prefix, memory);
    assert.ok(args.includes(`-Dinstall-prefix=${prefix}`));
    assert.ok(args.includes("-Dautomation=true"));
    assert.ok(args.includes(`-Dmemory=${memory === "on" ? "true" : "false"}`));
    assert.equal(sageBinary(root, memory), join(prefix, "bin", "Sage"));
  }
  assert.notEqual(installPrefix(root, "on"), installPrefix(root, "off"));
});

test("removeBuilds deletes both automation installs and leaves zig-out/bin/Sage", () => {
  const root = mkdtempSync(join(tmpdir(), "sage-eval-leftover-"));
  const shipped = join(root, "zig-out", "bin", "Sage");
  mkdirSync(dirname(shipped), { recursive: true });
  writeFileSync(shipped, "the make build binary\n");
  for (const memory of ["on", "off"] as const) {
    const binary = sageBinary(root, memory);
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(binary, "an automation build\n");
  }
  removeBuilds(root);
  assert.equal(existsSync(installPrefix(root, "on")), false);
  assert.equal(existsSync(installPrefix(root, "off")), false);
  assert.equal(readFileSync(shipped, "utf8"), "the make build binary\n");
  // Safe to call twice.
  removeBuilds(root);
});

test("the runner deletes the installs on the way out", () => {
  const runner = read("agent/scripts/eval/runner.ts");
  assert.ok(
    /process\.on\("exit",[\s\S]{0,200}removeBuilds\(root\)/u.test(runner),
    "the exit handler deletes the automation installs"
  );
  assert.ok(
    /finally \{[\s\S]{0,300}removeBuilds\(root\)/u.test(runner),
    "the end of the run deletes the automation installs"
  );
});

test("no code refers to the shipped binary's path", () => {
  for (const file of ["sage.ts", "runner.ts", "unit.ts", "dream.ts"]) {
    // Comments may name it, to say what the runner leaves alone.
    const source = read(`agent/scripts/eval/${file}`)
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
      .join("\n");
    assert.ok(!source.includes("zig-out/bin"), `${file} names zig-out/bin`);
    assert.ok(
      !source.includes('"zig-out", "bin"'),
      `${file} joins zig-out and bin`
    );
  }
});

test("build.zig accepts -Dinstall-prefix, so the runner can redirect its install", () => {
  assert.ok(read("build.zig").includes('"install-prefix"'));
});

test("the Makefile never builds with automation", () => {
  assert.ok(!read("Makefile").includes("-Dautomation"));
});
