import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The Zig tests derive keys with the cheapest Argon2id settings so they stay
// fast. Only a test build may pick those. A Zig test runs only in a test
// build, so it can't check the other branch, and these tests read the source.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "src");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const zigFiles = readdirSync(srcDir)
  .filter((name) => name.endsWith(".zig"))
  .map((name) => ({ name, text: readFileSync(join(srcDir, name), "utf8") }));

function filesNaming(pattern: RegExp): string[] {
  return zigFiles.flatMap(({ name, text }) =>
    (text.match(pattern) ?? []).map(() => name)
  );
}

test("Sage ships with OWASP's Argon2id settings", () => {
  assert.match(
    read("src/vault.zig"),
    /pub const shipping_kdf_params: std\.crypto\.pwhash\.argon2\.Params = \.owasp_2id;/,
    "src/vault.zig no longer sets shipping_kdf_params to OWASP's settings."
  );
  assert.deepEqual(
    filesNaming(/\bowasp_2id\b/g),
    ["vault.zig"],
    "Only shipping_kdf_params in src/vault.zig names owasp_2id. Use that constant instead."
  );
});

test("only a test build picks the test settings", () => {
  assert.match(
    read("src/vault.zig"),
    /pub const kdf_params: std\.crypto\.pwhash\.argon2\.Params = if \(builtin\.is_test\) test_kdf_params else shipping_kdf_params;/,
    "kdf_params must be test_kdf_params only when builtin.is_test, and shipping_kdf_params otherwise."
  );
  assert.deepEqual(
    filesNaming(/\btest_kdf_params\b/g),
    ["vault.zig", "vault.zig"],
    "test_kdf_params appears outside its declaration and the kdf_params choice, so code may reach it without builtin.is_test."
  );
});

test("new slot wraps and the lock's password hash use kdf_params", () => {
  assert.match(
    read("src/vault.zig"),
    /return self\.wrapWithSecretParams\(secret, aad, data_key, kdf_params\);/,
    "wrapWithSecret no longer wraps new slots with kdf_params."
  );
  assert.match(
    read("src/lock.zig"),
    /strHash\(next, \.\{\s*\.allocator = self\.allocator,\s*\.params = vault_mod\.kdf_params,/,
    "setPassword no longer hashes the password with vault_mod.kdf_params."
  );
});
