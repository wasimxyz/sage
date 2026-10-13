export type ModelsLoad =
  | { kind: "loading" }
  | { kind: "down" }
  | { kind: "empty" }
  | { kind: "ready"; names: string[] };

/**
 * True when two model checks say the same thing. The chat provider checks
 * Ollama every few seconds. Keeping the old value when nothing changed stops
 * every screen that reads Chat from re-rendering on each check.
 */
export function sameModelsLoad(a: ModelsLoad, b: ModelsLoad): boolean {
  if (a.kind !== "ready" || b.kind !== "ready") {
    return a.kind === b.kind;
  }
  return (
    a.names.length === b.names.length &&
    a.names.every((name, index) => name === b.names[index])
  );
}
