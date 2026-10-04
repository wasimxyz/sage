const commandFilePattern = /^command-(\d+)\.txt$/;

export function parseBridgeJson(
  raw: string | null
): Record<string, unknown> | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function nextAutomationSequence(fileNames: string[]): number {
  let highest = 0;
  for (const name of fileNames) {
    const match = commandFilePattern.exec(name);
    if (match === null) {
      continue;
    }
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > highest) {
      highest = value;
    }
  }
  return highest + 1;
}

export function matchingBridgeResponse(
  id: string,
  raw: string | null
): Record<string, unknown> | null {
  const parsed = parseBridgeJson(firstJsonObject(raw));
  if (parsed === null || parsed.id !== id) {
    return null;
  }
  return parsed;
}

export function firstJsonObject(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  return text.slice(start, end + 1);
}

export function resultRecord(
  response: Record<string, unknown>
): Record<string, unknown> {
  let result: unknown = response.result;
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      return response;
    }
  }
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return response;
}

export function resultNumber(
  response: Record<string, unknown>,
  key: string
): number {
  const value = resultRecord(response)[key];
  return typeof value === "number" ? value : 0;
}

export function resultBoolean(
  response: Record<string, unknown>,
  key: string
): boolean {
  return resultRecord(response)[key] === true;
}

export function errorMessage(response: Record<string, unknown>): string | null {
  const { error } = response;
  if (error !== null && typeof error === "object" && "message" in error) {
    const { message } = error as { message: unknown };
    if (typeof message === "string") {
      return message;
    }
  }
  const result = resultRecord(response);
  if (typeof result.message === "string") {
    return result.message;
  }
  return null;
}

export function isMatchingId(response: Record<string, unknown>): boolean {
  return typeof response.id === "string";
}

export function dreamPollState(
  running: boolean,
  done: number,
  total: number,
  sawRunning: boolean
): "wait" | "done" {
  if (running) {
    return "wait";
  }
  if (sawRunning) {
    return "done";
  }
  if (total > 0 && done >= total) {
    return "done";
  }
  return "wait";
}

export function isDreamStartReady(response: Record<string, unknown>): boolean {
  if (response.ok === false) {
    return true;
  }
  return typeof resultRecord(response).total === "number";
}

export function requireOk(
  response: Record<string, unknown>,
  command: string
): void {
  if (response.ok === false) {
    throw new Error(errorMessage(response) ?? `${command} failed.`);
  }
}

export function utf8Chunks(text: string, maxBytes: number): string[] {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length === 0) {
    return [""];
  }
  const chunks: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + maxBytes, bytes.length);
    // biome-ignore lint/suspicious/noBitwiseOperators: UTF-8 continuation bytes are 0b10xxxxxx.
    while (end > offset && (bytes[end] & 0xc0) === 0x80) {
      end -= 1;
    }
    chunks.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return chunks;
}
