export const WORLD_KEY_ENV = "SAGE_EVE_WORLD_KEY";
const WORLD_KEY_HEX_LENGTH = 64;

export function decodeWorldKey(value: string | undefined): Uint8Array | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (value.length !== WORLD_KEY_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      `${WORLD_KEY_ENV} must be ${WORLD_KEY_HEX_LENGTH} hex characters (32-byte AES-256 key)`,
    );
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}
