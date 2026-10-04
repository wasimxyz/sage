export function memoryEnabledFrom(value: unknown): boolean {
  if (value === null || typeof value !== "object" || !("memory" in value)) {
    return false;
  }
  return typeof value.memory === "boolean" && value.memory;
}
