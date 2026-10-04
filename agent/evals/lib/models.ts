const defaultChatModel = "qwen3.5:9b";

export function chatModel(): string {
  const current = normalizeModel(process.env.SAGE_CHAT_MODEL);
  if (current !== undefined) {
    return current;
  }
  return chatModels()[0];
}

export function chatModels(): string[] {
  const raw =
    process.env.SAGE_CHAT_MODELS ?? process.env.OLLAMA_MODEL ?? defaultChatModel;
  const models = splitModelList(raw);
  return models.length > 0 ? models : [defaultChatModel];
}

export function ollamaBaseURL(): string {
  const raw = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/api";
  return raw.replace(/\/v1\/?$/, "/api");
}

export function judgeModelId(): string {
  const value = process.env.SAGE_JUDGE_MODEL;
  if (value !== undefined && value.length > 0) {
    return value;
  }
  return defaultChatModel;
}

export function embedModel(): string {
  const current = normalizeModel(process.env.SAGE_EMBED_MODEL);
  if (current !== undefined) {
    return current;
  }
  return "nomic-embed-text";
}

function splitModelList(raw: string): string[] {
  const models: string[] = [];
  for (const item of raw.split(",")) {
    const model = normalizeModel(item);
    if (model !== undefined) {
      models.push(model);
    }
  }
  return models;
}

function normalizeModel(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const model = stripOllamaPrefix(value.trim());
  return model.length > 0 ? model : undefined;
}

function stripOllamaPrefix(model: string): string {
  return model.startsWith("ollama/") ? model.slice("ollama/".length) : model;
}
