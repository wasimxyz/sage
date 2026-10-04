import { join } from "node:path";
import { createWorld as createLocalWorld } from "@workflow/world-local";
import { decodeWorldKey, WORLD_KEY_ENV } from "./key.ts";
import { readSpawnSecrets } from "./spawn.js";

export { decodeWorldKey, WORLD_KEY_ENV };
export { parseSpawnSecrets, readSpawnSecrets } from "./spawn.js";

const WORLD_DATA_DIR = join(".eve", ".workflow-data");

function worldKeyHex(): string | undefined {
  const spawn = readSpawnSecrets();
  if (spawn !== undefined) {
    return spawn.worldKeyHex.length > 0 ? spawn.worldKeyHex : undefined;
  }
  return process.env[WORLD_KEY_ENV];
}

export function createWorld() {
  const inner = createLocalWorld({
    dataDir: join(process.cwd(), WORLD_DATA_DIR),
  });
  const encryptionKey = decodeWorldKey(worldKeyHex());
  return {
    ...inner,
    getEncryptionKeyForRun: async () => encryptionKey,
  };
}

export default createWorld;
