import assert from "node:assert/strict";
import test from "node:test";

import {
  chatModel,
  chatModels,
  embedModel,
  judgeModelId,
  ollamaBaseURL,
} from "./models.ts";

test("chatModels splits a comma list and strips the ollama prefix", () => {
  const previous = process.env.SAGE_CHAT_MODELS;
  process.env.SAGE_CHAT_MODELS = "qwen3:8b, ollama/llama3.2";
  try {
    assert.deepEqual(chatModels(), ["qwen3:8b", "llama3.2"]);
  } finally {
    restoreEnv("SAGE_CHAT_MODELS", previous);
  }
});

test("chatModel prefers SAGE_CHAT_MODEL over a sweep list", () => {
  const previousCurrent = process.env.SAGE_CHAT_MODEL;
  const previousList = process.env.SAGE_CHAT_MODELS;
  process.env.SAGE_CHAT_MODEL = "ollama/qwen3:14b";
  process.env.SAGE_CHAT_MODELS = "llama3.2,qwen3:8b";
  try {
    assert.equal(chatModel(), "qwen3:14b");
  } finally {
    restoreEnv("SAGE_CHAT_MODEL", previousCurrent);
    restoreEnv("SAGE_CHAT_MODELS", previousList);
  }
});

test("chatModel takes the first SAGE_CHAT_MODELS entry when the current model is unset", () => {
  const previousCurrent = process.env.SAGE_CHAT_MODEL;
  const previousList = process.env.SAGE_CHAT_MODELS;
  const previousOllama = process.env.OLLAMA_MODEL;
  delete process.env.SAGE_CHAT_MODEL;
  process.env.SAGE_CHAT_MODELS = "llama3.2, qwen3:8b";
  delete process.env.OLLAMA_MODEL;
  try {
    assert.equal(chatModel(), "llama3.2");
  } finally {
    restoreEnv("SAGE_CHAT_MODEL", previousCurrent);
    restoreEnv("SAGE_CHAT_MODELS", previousList);
    restoreEnv("OLLAMA_MODEL", previousOllama);
  }
});

test("chatModel falls back to OLLAMA_MODEL when the Sage chat vars are unset", () => {
  const previousCurrent = process.env.SAGE_CHAT_MODEL;
  const previousList = process.env.SAGE_CHAT_MODELS;
  const previousOllama = process.env.OLLAMA_MODEL;
  delete process.env.SAGE_CHAT_MODEL;
  delete process.env.SAGE_CHAT_MODELS;
  process.env.OLLAMA_MODEL = "ollama/llama3.2";
  try {
    assert.equal(chatModel(), "llama3.2");
  } finally {
    restoreEnv("SAGE_CHAT_MODEL", previousCurrent);
    restoreEnv("SAGE_CHAT_MODELS", previousList);
    restoreEnv("OLLAMA_MODEL", previousOllama);
  }
});

test("chatModel ignores an empty SAGE_CHAT_MODEL after stripping ollama/", () => {
  const previousCurrent = process.env.SAGE_CHAT_MODEL;
  const previousList = process.env.SAGE_CHAT_MODELS;
  const previousOllama = process.env.OLLAMA_MODEL;
  process.env.SAGE_CHAT_MODEL = "ollama/";
  process.env.SAGE_CHAT_MODELS = "llama3.2,qwen3:8b";
  delete process.env.OLLAMA_MODEL;
  try {
    assert.equal(chatModel(), "llama3.2");
  } finally {
    restoreEnv("SAGE_CHAT_MODEL", previousCurrent);
    restoreEnv("SAGE_CHAT_MODELS", previousList);
    restoreEnv("OLLAMA_MODEL", previousOllama);
  }
});

test("chatModels drops empty names after stripping ollama/", () => {
  const previous = process.env.SAGE_CHAT_MODELS;
  process.env.SAGE_CHAT_MODELS = "ollama/, llama3.2, ollama/";
  try {
    assert.deepEqual(chatModels(), ["llama3.2"]);
  } finally {
    restoreEnv("SAGE_CHAT_MODELS", previous);
  }
});

test("ollamaBaseURL rewrites a /v1 host to the native /api prefix", () => {
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://localhost:11434/v1";
  try {
    assert.equal(ollamaBaseURL(), "http://localhost:11434/api");
  } finally {
    restoreEnv("OLLAMA_BASE_URL", previous);
  }
});

test("chatModels defaults to qwen3.5:9b", () => {
  const previousChat = process.env.SAGE_CHAT_MODELS;
  const previousOllama = process.env.OLLAMA_MODEL;
  delete process.env.SAGE_CHAT_MODELS;
  delete process.env.OLLAMA_MODEL;
  try {
    assert.deepEqual(chatModels(), ["qwen3.5:9b"]);
  } finally {
    restoreEnv("SAGE_CHAT_MODELS", previousChat);
    restoreEnv("OLLAMA_MODEL", previousOllama);
  }
});

test("chatModel defaults to qwen3.5:9b", () => {
  const previousCurrent = process.env.SAGE_CHAT_MODEL;
  const previousChat = process.env.SAGE_CHAT_MODELS;
  const previousOllama = process.env.OLLAMA_MODEL;
  delete process.env.SAGE_CHAT_MODEL;
  delete process.env.SAGE_CHAT_MODELS;
  delete process.env.OLLAMA_MODEL;
  try {
    assert.equal(chatModel(), "qwen3.5:9b");
  } finally {
    restoreEnv("SAGE_CHAT_MODEL", previousCurrent);
    restoreEnv("SAGE_CHAT_MODELS", previousChat);
    restoreEnv("OLLAMA_MODEL", previousOllama);
  }
});

test("judgeModelId defaults to qwen3.5:9b", () => {
  const previous = process.env.SAGE_JUDGE_MODEL;
  delete process.env.SAGE_JUDGE_MODEL;
  try {
    assert.equal(judgeModelId(), "qwen3.5:9b");
  } finally {
    restoreEnv("SAGE_JUDGE_MODEL", previous);
  }
});

test("embedModel defaults to nomic-embed-text", () => {
  const previous = process.env.SAGE_EMBED_MODEL;
  delete process.env.SAGE_EMBED_MODEL;
  try {
    assert.equal(embedModel(), "nomic-embed-text");
  } finally {
    restoreEnv("SAGE_EMBED_MODEL", previous);
  }
});

test("embedModel strips the ollama prefix", () => {
  const previous = process.env.SAGE_EMBED_MODEL;
  process.env.SAGE_EMBED_MODEL = "ollama/nomic-embed-text:latest";
  try {
    assert.equal(embedModel(), "nomic-embed-text:latest");
  } finally {
    restoreEnv("SAGE_EMBED_MODEL", previous);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
