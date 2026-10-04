import assert from "node:assert/strict";
import test from "node:test";

import { createSageAuthFetch, isSageChatUrl } from "./dev-auth-hook.ts";

interface Call {
  init: RequestInit | undefined;
  input: RequestInfo | URL;
}

const sageToken = "sage-token";
const vercelBearer = "Bearer vercel-oidc";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

function recordingFetch(): { calls: Call[]; fetch: FetchLike } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ init, input });
    return await new Response("{}", { status: 200 });
  };
  return { calls, fetch };
}

function authorizedFetch(inner: FetchLike, token: string | null): FetchLike {
  return createSageAuthFetch(inner, async () => token);
}

function authorizationOf(call: Call): string | null {
  if (call.input instanceof Request) {
    return call.input.headers.get("authorization");
  }
  return new Headers(call.init?.headers).get("authorization");
}

function headersOf(call: Call): Headers {
  if (call.input instanceof Request) {
    return call.input.headers;
  }
  return new Headers(call.init?.headers);
}

test("isSageChatUrl covers eve's Chat routes on loopback", () => {
  assert.equal(isSageChatUrl("http://127.0.0.1:2000/eve/v1/info"), true);
  assert.equal(isSageChatUrl("http://127.0.0.1:2000/eve/v1/sessions"), true);
  assert.equal(
    isSageChatUrl("http://[::1]:2000/eve/v1/sessions/abc/events"),
    true
  );
  assert.equal(isSageChatUrl("http://localhost:2000/eve/v1/info"), true);
});

test("isSageChatUrl leaves health, Ollama, and other hosts alone", () => {
  assert.equal(isSageChatUrl("http://127.0.0.1:2000/eve/v1/health"), false);
  assert.equal(isSageChatUrl("http://127.0.0.1:11434/api/chat"), false);
  assert.equal(isSageChatUrl("http://127.0.0.1:11434/api/tags"), false);
  assert.equal(isSageChatUrl("http://localhost:2000/health"), false);
  assert.equal(isSageChatUrl("https://example.com/eve/v1/info"), false);
  assert.equal(isSageChatUrl("http://192.168.1.10:2000/eve/v1/info"), false);
  assert.equal(isSageChatUrl("/eve/v1/info"), false);
  assert.equal(isSageChatUrl("file:///eve/v1/info"), false);
  assert.equal(isSageChatUrl(""), false);
});

test("adds the Sage bearer to info, session, and stream requests", async () => {
  const { calls, fetch } = recordingFetch();
  const hooked = authorizedFetch(fetch, sageToken);

  await hooked("http://127.0.0.1:2000/eve/v1/info");
  await hooked("http://127.0.0.1:2000/eve/v1/sessions", { method: "POST" });
  await hooked("http://127.0.0.1:2000/eve/v1/sessions/abc/events");
  await hooked(new URL("http://127.0.0.1:2000/eve/v1/info"));

  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(authorizationOf(call), `Bearer ${sageToken}`);
  }
  assert.equal(calls[1]?.init?.method, "POST");
});

test("replaces the bearer eve built and keeps its other headers", async () => {
  const { calls, fetch } = recordingFetch();
  const hooked = authorizedFetch(fetch, sageToken);

  await hooked("http://127.0.0.1:2000/eve/v1/info", {
    headers: {
      authorization: vercelBearer,
      "x-sage-model": "qwen3.5:9b",
    },
  });

  const headers = headersOf(calls[0] as Call);
  assert.equal(headers.get("authorization"), `Bearer ${sageToken}`);
  assert.equal(headers.get("x-sage-model"), "qwen3.5:9b");
});

test("replaces the bearer on a Request and keeps its body", async () => {
  const { calls, fetch } = recordingFetch();
  const hooked = authorizedFetch(fetch, sageToken);
  const request = new Request("http://127.0.0.1:2000/eve/v1/sessions", {
    body: JSON.stringify({ message: "hi" }),
    headers: {
      authorization: vercelBearer,
      "content-type": "application/json",
    },
    method: "POST",
  });

  await hooked(request);

  const call = calls[0] as Call;
  assert.ok(call.input instanceof Request);
  assert.equal(call.init, undefined);
  assert.equal(call.input.method, "POST");
  assert.equal(call.input.headers.get("authorization"), `Bearer ${sageToken}`);
  assert.equal(call.input.headers.get("content-type"), "application/json");
  assert.equal(await call.input.text(), JSON.stringify({ message: "hi" }));
});

test("leaves health, Ollama, and other hosts on the header eve built", async () => {
  const { calls, fetch } = recordingFetch();
  const reads = { value: 0 };
  const hooked = createSageAuthFetch(fetch, async () => {
    reads.value += 1;
    return sageToken;
  });
  const urls = [
    "http://127.0.0.1:2000/eve/v1/health",
    "http://127.0.0.1:11434/api/chat",
    "http://127.0.0.1:11434/api/tags",
    "https://example.com/eve/v1/info",
  ];

  for (const url of urls) {
    await hooked(url, { headers: { authorization: vercelBearer } });
  }

  assert.equal(reads.value, 0);
  for (const call of calls) {
    assert.equal(authorizationOf(call), vercelBearer);
  }
});

test("sends what eve built when the token file is missing", async () => {
  const { calls, fetch } = recordingFetch();
  const hooked = authorizedFetch(fetch, null);

  await hooked("http://127.0.0.1:2000/eve/v1/info", {
    headers: { authorization: vercelBearer },
  });
  await hooked("http://127.0.0.1:2000/eve/v1/sessions");

  assert.equal(authorizationOf(calls[0] as Call), vercelBearer);
  assert.equal(authorizationOf(calls[1] as Call), null);
});

test("re-reads the token file on each request", async () => {
  const { calls, fetch } = recordingFetch();
  const tokens = [null, sageToken];
  const hooked = createSageAuthFetch(fetch, async () => tokens.shift() ?? null);

  await hooked("http://127.0.0.1:2000/eve/v1/info");
  await hooked("http://127.0.0.1:2000/eve/v1/info");

  assert.equal(authorizationOf(calls[0] as Call), null);
  assert.equal(authorizationOf(calls[1] as Call), `Bearer ${sageToken}`);
});
