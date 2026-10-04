import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLocalModel,
  localModelNames,
  localOllamaBaseURL,
} from "../agent/lib/local-models.ts";

const onThisMacPattern = /on this Mac/;
const cloudModelMessagePattern =
  /gpt-oss:120b-cloud runs in the cloud\. Pick a model on this Mac\./;
const runsInTheCloudPattern = /runs in the cloud/;
const notPulledMessagePattern =
  /qwen3:8b is not pulled\. Pick a model on this Mac\./;
const ollamaIsNotRunningPattern = /Ollama is not running\./;

const tags = {
  models: [
    { model: "qwen3.5:9b", name: "qwen3.5:9b" },
    { model: "nomic-embed-text:latest", name: "nomic-embed-text:latest" },
    {
      model: "gpt-oss:120b-cloud",
      name: "gpt-oss:120b-cloud",
      remote_host: "https://ollama.com:443",
      remote_model: "gpt-oss:120b",
    },
    { name: "only-remote-model", remote_model: "upstream" },
  ],
};

function tagsFetch(body: unknown, ok = true) {
  return () =>
    Promise.resolve({ json: () => Promise.resolve(body), ok } as Response);
}

test("localOllamaBaseURL accepts loopback hosts", () => {
  assert.equal(localOllamaBaseURL(undefined), "http://localhost:11434/api");
  assert.equal(
    localOllamaBaseURL("http://127.0.0.1:11434/api"),
    "http://127.0.0.1:11434/api"
  );
  assert.equal(
    localOllamaBaseURL("http://[::1]:11434/api"),
    "http://[::1]:11434/api"
  );
});

test("localOllamaBaseURL rewrites a leftover /v1 suffix", () => {
  assert.equal(
    localOllamaBaseURL("http://localhost:11434/v1"),
    "http://localhost:11434/api"
  );
});

test("localOllamaBaseURL rejects remote and malformed URLs", () => {
  for (const url of [
    "https://ollama.com/api",
    "http://192.168.1.5:11434/api",
    "http://localhost.evil.example/api",
    "not a url",
  ]) {
    assert.throws(() => localOllamaBaseURL(url), onThisMacPattern);
  }
});

test("localModelNames leaves out models Ollama marks as remote", () => {
  assert.deepEqual([...localModelNames(tags)].sort(), [
    "nomic-embed-text:latest",
    "qwen3.5:9b",
  ]);
  assert.equal(localModelNames("garbage").size, 0);
  assert.equal(localModelNames({ models: "x" }).size, 0);
});

test("assertLocalModel accepts a pulled local model", async () => {
  await assertLocalModel(
    "http://localhost:11434/api",
    "qwen3.5:9b",
    tagsFetch(tags)
  );
});

test("assertLocalModel matches a bare name to its :latest tag", async () => {
  await assertLocalModel(
    "http://localhost:11434/api",
    "nomic-embed-text",
    tagsFetch(tags)
  );
});

test("assertLocalModel refuses a cloud model", async () => {
  await assert.rejects(
    assertLocalModel(
      "http://localhost:11434/api",
      "gpt-oss:120b-cloud",
      tagsFetch(tags)
    ),
    cloudModelMessagePattern
  );
  await assert.rejects(
    assertLocalModel(
      "http://localhost:11434/api",
      "only-remote-model",
      tagsFetch(tags)
    ),
    runsInTheCloudPattern
  );
});

test("assertLocalModel refuses a model that is not pulled", async () => {
  await assert.rejects(
    assertLocalModel("http://localhost:11434/api", "qwen3:8b", tagsFetch(tags)),
    notPulledMessagePattern
  );
});

test("assertLocalModel fails closed when /api/tags is unreachable", async () => {
  await assert.rejects(
    assertLocalModel("http://localhost:11434/api", "qwen3.5:9b", () =>
      Promise.reject(new Error("ECONNREFUSED"))
    ),
    ollamaIsNotRunningPattern
  );
  await assert.rejects(
    assertLocalModel(
      "http://localhost:11434/api",
      "qwen3.5:9b",
      tagsFetch({}, false)
    ),
    ollamaIsNotRunningPattern
  );
});
