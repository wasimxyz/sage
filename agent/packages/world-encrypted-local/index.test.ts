import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorld } from "./index.ts";
import { decodeWorldKey, WORLD_KEY_ENV } from "./key.ts";
import { parseSpawnSecrets, readSpawnSecrets } from "./spawn.js";

const worldKeyPattern = /world key/;
const spawnTokenPattern = /spawn token/;

test("decodeWorldKey treats missing and empty values as plaintext", () => {
  assert.equal(decodeWorldKey(undefined), undefined);
  assert.equal(decodeWorldKey(""), undefined);
});

test("decodeWorldKey accepts 32-byte hex", () => {
  const hex = "00".repeat(32);
  const key = decodeWorldKey(hex);
  assert.ok(key);
  assert.equal(key.length, 32);
  assert.equal(key[0], 0);
  assert.equal(key[31], 0);
});

test("decodeWorldKey rejects a present but invalid value", () => {
  assert.throws(() => decodeWorldKey("short"), {
    message: new RegExp(WORLD_KEY_ENV),
  });
  assert.throws(() => decodeWorldKey("zz".repeat(32)), {
    message: new RegExp(WORLD_KEY_ENV),
  });
  assert.throws(() => decodeWorldKey("00".repeat(31)), {
    message: new RegExp(WORLD_KEY_ENV),
  });
});

test("createWorld encrypts when the key is set and passes through when it is not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-world-"));
  const cwd = process.cwd();
  const previous = process.env[WORLD_KEY_ENV];
  const previousSocket = process.env.SAGE_AGENT_SOCKET;
  process.chdir(dir);
  try {
    delete process.env[WORLD_KEY_ENV];
    delete process.env.SAGE_AGENT_SOCKET;
    const plain = createWorld();
    assert.equal(await plain.getEncryptionKeyForRun(), undefined);

    const hex = "ab".repeat(32);
    process.env[WORLD_KEY_ENV] = hex;
    const encrypted = createWorld();
    const key = await encrypted.getEncryptionKeyForRun();
    assert.ok(key);
    assert.equal(key.length, 32);
    assert.equal(key[0], 0xab);
    assert.equal(typeof encrypted.specVersion, "number");
    assert.equal(typeof encrypted.createQueueHandler, "function");
  } finally {
    process.chdir(cwd);
    if (previous === undefined) {
      delete process.env[WORLD_KEY_ENV];
    } else {
      process.env[WORLD_KEY_ENV] = previous;
    }
    if (previousSocket === undefined) {
      delete process.env.SAGE_AGENT_SOCKET;
    } else {
      process.env.SAGE_AGENT_SOCKET = previousSocket;
    }
  }
});

test("parseSpawnSecrets reads a token and a world key", () => {
  const token = "ab".repeat(32);
  const key = "cd".repeat(32);
  const parsed = parseSpawnSecrets(`${token}\n${key}\n`);
  assert.equal(parsed.token, token);
  assert.equal(parsed.worldKeyHex, key);
});

test("parseSpawnSecrets allows an empty world key line", () => {
  const token = "ab".repeat(32);
  const parsed = parseSpawnSecrets(`${token}\n\n`);
  assert.equal(parsed.token, token);
  assert.equal(parsed.worldKeyHex, "");
});

test("parseSpawnSecrets rejects a short token", () => {
  assert.throws(() => parseSpawnSecrets("short\n\n"), {
    message: spawnTokenPattern,
  });
});

test("parseSpawnSecrets rejects a malformed world key", () => {
  const token = "ab".repeat(32);
  assert.throws(() => parseSpawnSecrets(`${token}\nzz\n`), {
    message: worldKeyPattern,
  });
});

test("readSpawnSecrets is a no-op without SAGE_AGENT_SOCKET", () => {
  const previous = process.env.SAGE_AGENT_SOCKET;
  delete process.env.SAGE_AGENT_SOCKET;
  try {
    assert.equal(readSpawnSecrets(), undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.SAGE_AGENT_SOCKET;
    } else {
      process.env.SAGE_AGENT_SOCKET = previous;
    }
  }
});
