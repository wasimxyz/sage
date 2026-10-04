import { extractReasoningMiddleware, wrapLanguageModel } from "ai";
import { defineAgent, defineDynamic } from "eve";
import { createOllama } from "ollama-ai-provider-v2";
import { assertLocalModel, localOllamaBaseURL } from "./lib/local-models";

const fallbackModel = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
const contextWindow = Number(process.env.OLLAMA_CONTEXT_WINDOW ?? "32768");
// The Chat model picker tops out at the 262_144 entry in
// frontend/src/lib/chat/model-prefs.ts. The header is the untrusted side, so
// the agent never allocates a larger num_ctx than the picker can offer.
const MAX_CONTEXT_LENGTH = 262144;
const extractThinkTags = extractReasoningMiddleware({ tagName: "think" });

// Chat only talks to Ollama on this Mac. A non-loopback URL stops the agent.
const baseURL = localOllamaBaseURL(process.env.OLLAMA_BASE_URL);

const ollama = createOllama({ baseURL });

type SessionAuthCtx = {
  session: { auth: { current?: { attributes?: Record<string, unknown> } | null } };
};

function modelIdFromContext(ctx: SessionAuthCtx): string {
  const value = ctx.session.auth.current?.attributes?.model;
  if (typeof value !== "string" || value.length === 0) {
    return fallbackModel;
  }
  return value.startsWith("ollama/") ? value.slice("ollama/".length) : value;
}

function thinkingFromContext(ctx: SessionAuthCtx): boolean {
  const value = ctx.session.auth.current?.attributes?.think;
  return value !== "0" && value !== "false";
}

function contextLengthFromContext(ctx: SessionAuthCtx): number {
  const value = ctx.session.auth.current?.attributes?.contextLength;
  if (typeof value !== "string" || value.length === 0) {
    return contextWindow;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return contextWindow;
  }
  return Math.min(Math.trunc(parsed), MAX_CONTEXT_LENGTH);
}

function ollamaChatModel(modelId: string) {
  return wrapLanguageModel({
    model: ollama(modelId),
    middleware: extractThinkTags,
  });
}

export default defineAgent({
  // Local models have small context windows: skip eve's default tools and
  // keep only the authored journal tools and memory search.
  defaultTools: false,
  experimental: {
    workflow: {
      world: "@sage/world-encrypted-local",
    },
  },
  build: {
    externalDependencies: [
      "@sage/world-encrypted-local",
      "@sage/world-encrypted-local/spawn",
      "@workflow/world-local",
    ],
  },
  model: defineDynamic({
    events: {
      "step.started": async (_event, ctx) => {
        const tokens = contextLengthFromContext(ctx);
        const modelId = modelIdFromContext(ctx);
        // The header is the untrusted side: refuse a cloud or unpulled model
        // before any prompt leaves the agent.
        await assertLocalModel(baseURL, modelId);
        return {
          model: ollamaChatModel(modelId),
          modelContextWindowTokens: tokens,
          modelOptions: {
            providerOptions: {
              ollama: {
                think: thinkingFromContext(ctx),
                options: { num_ctx: tokens },
              },
            },
          },
        };
      },
    },
  }),
});
