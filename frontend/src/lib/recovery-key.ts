// Mirrors `normalizeRecoveryKey` in `src/vault.zig`. A recovery key is 24
// characters of Crockford base32 (digits and capitals without I, L, O, U),
// shown in six groups of four. Sage generates and formats it; the page only
// shows it, checks what the person types back, and sends it on.

export const recoveryKeyLength = 24;
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const separators = new Set(["-", " ", "\t", "\r", "\n"]);

/**
 * The key as Sage compares it: capitals, no dashes or spaces, with O read as
 * 0 and I or L as 1. Null when the text is not shaped like a key.
 */
export function normalizeRecoveryKey(input: string): string | null {
  let normalized = "";
  for (const raw of input) {
    if (!separators.has(raw)) {
      let char = raw.toUpperCase();
      if (char === "O") {
        char = "0";
      } else if (char === "I" || char === "L") {
        char = "1";
      }
      if (
        char.length !== 1 ||
        !alphabet.includes(char) ||
        normalized.length === recoveryKeyLength
      ) {
        return null;
      }
      normalized += char;
    }
  }
  return normalized.length === recoveryKeyLength ? normalized : null;
}

/** True when what was typed is the key that was shown. */
export function recoveryKeysMatch(shown: string, typed: string): boolean {
  const expected = normalizeRecoveryKey(shown);
  return expected !== null && expected === normalizeRecoveryKey(typed);
}
