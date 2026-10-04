const STORAGE_KEY = "sage-chat-prefs:v1";
const OLLAMA_MODEL_PREFIX = "ollama/";

export const CONTEXT_LENGTHS = [
  4096, 8192, 16_384, 32_768, 49_152, 65_536, 73_728, 98_304, 131_072, 262_144,
] as const;

export type ContextLength = (typeof CONTEXT_LENGTHS)[number];

export const DEFAULT_CONTEXT_LENGTH: ContextLength = 32_768;
export const DEFAULT_CHAT_MODEL = "qwen3.5:9b";

export interface ChatModelPrefs {
  contextLength: ContextLength;
  model: string;
  thinking: boolean;
}

/** eve reports `ollama/<name>` on `step.started`; Ollama wants the name alone. */
export function normalizeChatModelId(modelId: string): string {
  if (modelId.startsWith(OLLAMA_MODEL_PREFIX)) {
    return modelId.slice(OLLAMA_MODEL_PREFIX.length);
  }
  return modelId;
}

export function formatContextLength(tokens: number): string {
  return `${Math.round(tokens / 1024)}K`;
}

export function normalizeContextLength(value: unknown): ContextLength {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CONTEXT_LENGTH;
  }
  let closest: ContextLength = CONTEXT_LENGTHS[0];
  let closestDistance = Math.abs(parsed - closest);
  for (const candidate of CONTEXT_LENGTHS) {
    const distance = Math.abs(parsed - candidate);
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return closest;
}

const defaultPrefs: ChatModelPrefs = {
  contextLength: DEFAULT_CONTEXT_LENGTH,
  model: "",
  thinking: true,
};

export function loadChatModelPrefs(): ChatModelPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return defaultPrefs;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isChatModelPrefs(parsed)) {
      return defaultPrefs;
    }
    return {
      contextLength: normalizeContextLength(parsed.contextLength),
      model: normalizeChatModelId(parsed.model),
      thinking: parsed.thinking,
    };
  } catch {
    return defaultPrefs;
  }
}

export function saveChatModelPrefs(prefs: ChatModelPrefs): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        contextLength: normalizeContextLength(prefs.contextLength),
        model: normalizeChatModelId(prefs.model),
        thinking: prefs.thinking,
      })
    );
  } catch {
    // Private mode, a full quota, or a disabled store should not break chat.
  }
}

export function lastModelIdFromEvents(
  events: readonly unknown[]
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || event.type !== "step.started") {
      continue;
    }
    if (!isRecord(event.data)) {
      continue;
    }
    const { modelId } = event.data;
    if (typeof modelId === "string" && modelId.length > 0) {
      return normalizeChatModelId(modelId);
    }
  }
  return null;
}

export function prefsFromConversation(
  conversation: {
    contextLength: number | null;
    events: readonly unknown[];
    model: string;
    thinking: boolean | null;
  },
  fallback: ChatModelPrefs
): ChatModelPrefs {
  const stored = normalizeChatModelId(conversation.model);
  const model =
    stored.length > 0
      ? stored
      : (lastModelIdFromEvents(conversation.events) ?? fallback.model);
  return {
    // Missing means the row predates the column. Use the historical 32K
    // window, not the last new-chat pick, so the locked row cannot drift.
    contextLength:
      conversation.contextLength === null
        ? DEFAULT_CONTEXT_LENGTH
        : normalizeContextLength(conversation.contextLength),
    model: normalizeChatModelId(model),
    thinking:
      conversation.thinking === null
        ? fallback.thinking
        : conversation.thinking,
  };
}

function isChatModelPrefs(value: unknown): value is ChatModelPrefs {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.model !== "string" ||
    typeof record.thinking !== "boolean"
  ) {
    return false;
  }
  if (
    record.contextLength !== undefined &&
    typeof record.contextLength !== "number"
  ) {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
