const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TAGS_TIMEOUT_MS = 10_000;

type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal }
) => Promise<Response>;

/** Sage's Chat only talks to Ollama on this Mac. Rewrites a stale `/v1` suffix. */
export function localOllamaBaseURL(raw: string | undefined): string {
  const value = raw ?? "http://localhost:11434/api";
  let hostname: string;
  try {
    ({ hostname } = new URL(value));
  } catch {
    throw new Error("OLLAMA_BASE_URL must point at Ollama on this Mac.");
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("OLLAMA_BASE_URL must point at Ollama on this Mac.");
  }
  return value.replace(/\/v1\/?$/, "/api");
}

function isRemote(entry: Record<string, unknown>): boolean {
  return ["remote_host", "remote_model"].some((key) => {
    const value = entry[key];
    return typeof value === "string" && value.length > 0;
  });
}

function entries(tags: unknown): Record<string, unknown>[] {
  if (tags === null || typeof tags !== "object") {
    return [];
  }
  const { models } = tags as { models?: unknown };
  if (!Array.isArray(models)) {
    return [];
  }
  return models.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object"
  );
}

function namesOf(entry: Record<string, unknown>): string[] {
  return [entry.name, entry.model].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

/** Names `/api/tags` lists for models that run on this Mac, as `src/ollama.zig` does. */
export function localModelNames(tags: unknown): Set<string> {
  const names = new Set<string>();
  for (const entry of entries(tags)) {
    if (isRemote(entry)) {
      continue;
    }
    for (const name of namesOf(entry)) {
      names.add(name);
    }
  }
  return names;
}

function remoteModelNames(tags: unknown): Set<string> {
  const names = new Set<string>();
  for (const entry of entries(tags)) {
    if (isRemote(entry)) {
      for (const name of namesOf(entry)) {
        names.add(name);
      }
    }
  }
  return names;
}

function listed(names: Set<string>, modelId: string): boolean {
  return (
    names.has(modelId) || (!modelId.includes(":") && names.has(`${modelId}:latest`))
  );
}

/**
 * Throws unless `modelId` is a pulled model that runs on this Mac. A model
 * Ollama marks as cloud-hosted would send journal text off the machine, and an
 * unreachable `/api/tags` fails closed.
 */
export async function assertLocalModel(
  baseURL: string,
  modelId: string,
  fetchFn: FetchLike = fetch
): Promise<void> {
  let tags: unknown;
  try {
    const response = await fetchFn(`${baseURL.replace(/\/$/, "")}/tags`, {
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error("tags request failed");
    }
    tags = await response.json();
  } catch {
    throw new Error("Ollama is not running.");
  }
  if (listed(remoteModelNames(tags), modelId)) {
    throw new Error(
      `${modelId} runs in the cloud. Pick a model on this Mac.`
    );
  }
  if (!listed(localModelNames(tags), modelId)) {
    throw new Error(`${modelId} is not pulled. Pick a model on this Mac.`);
  }
}
