export interface SpawnSecrets {
  token: string;
  worldKeyHex: string;
}

export function parseSpawnSecrets(text: string): SpawnSecrets;
export function readSpawnSecrets(): SpawnSecrets | undefined;
