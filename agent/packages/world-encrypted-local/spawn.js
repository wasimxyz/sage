// JavaScript on purpose. Packaged Chat tools import this file from
// node_modules, and Node will not strip TypeScript there.
import { readFileSync } from "node:fs";

const hexPattern = /^[0-9a-fA-F]+$/;

const TOKEN_HEX_LENGTH = 64;
const WORLD_KEY_HEX_LENGTH = 64;

/** @typedef {{ token: string, worldKeyHex: string }} SpawnSecrets */

const CACHE = Symbol.for("sage.spawnSecrets");

/**
 * @param {string} text
 * @returns {SpawnSecrets}
 */
export function parseSpawnSecrets(text) {
  const normalized = text.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  const token = lines[0] ?? "";
  const worldKeyHex = lines[1] ?? "";
  if (token.length !== TOKEN_HEX_LENGTH || !hexPattern.test(token)) {
    throw new Error("Sage spawn token is missing or invalid.");
  }
  if (worldKeyHex.length === 0) {
    return { token, worldKeyHex: "" };
  }
  if (
    worldKeyHex.length !== WORLD_KEY_HEX_LENGTH ||
    !hexPattern.test(worldKeyHex)
  ) {
    throw new Error("Sage spawn world key is invalid.");
  }
  return { token, worldKeyHex };
}

/** @returns {SpawnSecrets | undefined} */
export function readSpawnSecrets() {
  const socket = process.env.SAGE_AGENT_SOCKET;
  if (socket === undefined || socket.length === 0) {
    return;
  }
  const existing = globalThis[CACHE];
  if (existing !== undefined) {
    return existing;
  }
  const value = parseSpawnSecrets(readFileSync(0, "utf8"));
  globalThis[CACHE] = value;
  return value;
}
