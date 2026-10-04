import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function sourceFilesIn(relativeDir: string): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const entry of readdirSync(join(repoRoot, relativeDir), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!(entry.isFile() && /\.(ts|tsx)$/.test(entry.name))) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    files.push({ path, text: readFileSync(path, "utf8") });
  }
  return files;
}

test("journal.export writes only to the folder the user picked", () => {
  const main = read("src/main.zig");
  const exportModule = read("src/export.zig");

  assert.match(
    main,
    /\.\{ \.name = "journal\.exportDialog", \.context = self, \.invoke_fn = handleExportDialog \}/,
    "desired: register journal.exportDialog, the command that runs the folder picker."
  );
  assert.match(
    main,
    /const result = try services\.showOpenDialog\(\.\{[\s\S]*?allow_directories = true/,
    "desired: the picker opens in Zig, on the loop thread, so the chosen folder can be remembered there."
  );
  assert.match(
    main,
    /self\.export_picked\.remember\(picked\)/,
    "desired: remember the folder the picker returned."
  );
  assert.match(
    main,
    /export_mod\.exportData\(self\.io, &self\.store, invocation\.request\.payload, &self\.export_picked, output\)/,
    "desired: journal.export hands exportData the remembered folder, not just the payload."
  );
  assert.match(
    exportModule,
    /if \(!picked\.take\(dest_dir\)\) return error\.DestinationNotPicked;/,
    "desired: exportData refuses any destDir the picker did not return, and spends the pick."
  );
});

test("the web view asks for the folder instead of supplying one", () => {
  const manifest = JSON.parse(read("app.json")) as {
    bridge: { commands: { name: string }[] };
  };
  const commandNames = manifest.bridge.commands.map((command) => command.name);
  assert.ok(
    commandNames.includes("journal.exportDialog"),
    "desired: app.json lists journal.exportDialog, or the web view cannot open the picker."
  );
  assert.ok(
    commandNames.includes("journal.export"),
    "desired: journal.export stays listed; it writes inside the folder the picker returned."
  );

  const bridge = read("frontend/src/bridge.ts");
  const picker = bridge.match(
    /export async function openExportDirectoryDialog\([\s\S]*?\n\}/
  );
  assert.ok(picker, "openExportDirectoryDialog stays a top-level function");
  assert.match(
    picker[0],
    /invoke\("journal\.exportDialog", \{\}\)/,
    "desired: the picker is the Sage command that remembers the folder."
  );
  assert.doesNotMatch(
    picker[0],
    /native-sdk\.dialog\.openFile/,
    "desired: stop reading the destination from the builtin dialog, whose answer Zig never sees."
  );
});

test("no frontend code opens a directory picker on its own", () => {
  for (const file of sourceFilesIn("frontend/src")) {
    assert.doesNotMatch(
      file.text,
      /allowDirectories:\s*true/,
      `desired: ${file.path} must not collect a directory path in the web view. Export destinations come from journal.exportDialog.`
    );
  }
});
