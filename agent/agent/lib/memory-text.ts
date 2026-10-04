export function lastUserText(input: unknown): string {
  if (typeof input === "string") {
    return input.trim();
  }
  if (!Array.isArray(input)) {
    return "";
  }
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const text = messageText(input[index]);
    if (text.length > 0) {
      return text;
    }
  }
  return "";
}

function messageText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === null || typeof value !== "object") {
    return "";
  }
  const record = value as { content?: unknown; role?: unknown };
  if (record.role !== undefined && record.role !== "user") {
    return "";
  }
  const { content } = record;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (
      part !== null &&
      typeof part === "object" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      parts.push(part.text);
    }
  }
  return parts.join("").trim();
}
