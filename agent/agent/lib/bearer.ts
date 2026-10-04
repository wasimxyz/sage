// Bearer-token helpers shared by the Chat channel, the workflow guard, and the
// `eve dev` hook. Nothing here reads Sage's token. Callers pass a reader.

import { createHash, timingSafeEqual } from "node:crypto";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type ReadToken = () => Promise<string | null>;

const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function bearerMatches(expected: string, presented: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const presentedDigest = createHash("sha256").update(presented).digest();
  return timingSafeEqual(expectedDigest, presentedDigest);
}

// The URL when it is http(s) on a loopback host, otherwise null.
export function parseLoopbackUrl(rawUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  return loopbackHosts.has(url.hostname) ? url : null;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

// Keeps every header the caller set, apart from the bearer.
function withBearer(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  token: string
): [RequestInfo | URL, RequestInit | undefined] {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined
  );
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  headers.set("authorization", `Bearer ${token}`);
  if (input instanceof Request) {
    return [new Request(input, { ...init, headers }), undefined];
  }
  return [input, { ...init, headers }];
}

// Wraps a fetch so loopback calls that `shouldSign` accepts carry Sage's token.
// With no token yet the call goes out unchanged and the server answers 401.
export function createBearerFetch(
  inner: FetchLike,
  shouldSign: (url: URL) => boolean,
  readToken: ReadToken
): FetchLike {
  return async (input, init) => {
    const url = parseLoopbackUrl(requestUrl(input));
    if (url === null || !shouldSign(url)) {
      return await inner(input, init);
    }
    const token = await readToken();
    if (token === null || token.length === 0) {
      return await inner(input, init);
    }
    const [nextInput, nextInit] = withBearer(input, init, token);
    return await inner(nextInput, nextInit);
  };
}
