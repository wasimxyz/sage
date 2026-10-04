// Loaded ahead of `eve dev` by the `dev` script in agent/package.json, so the
// terminal sends Sage's agent-server token on Chat requests.
//
// eve builds its own Authorization header for a local server: the linked Vercel
// OIDC bearer, or nothing when that token is missing. Sage writes the token it
// expects to agent-server.json when the app starts, which is after eve starts
// the terminal. A header frozen at startup would be missing or stale, so this
// hook re-reads the file on each request instead. Health stays public.

import {
  createBearerFetch,
  type FetchLike,
  parseLoopbackUrl,
  type ReadToken,
} from "../agent/lib/bearer.ts";
import { expectedChatToken } from "../agent/lib/sage.ts";

const routePrefix = "/eve/v1/";
const healthRoute = "/eve/v1/health";

function isChatPath(pathname: string): boolean {
  return pathname.startsWith(routePrefix) && pathname !== healthRoute;
}

// Ollama runs on loopback too, at 127.0.0.1:11434/api/…, so the path decides.
export function isSageChatUrl(rawUrl: string): boolean {
  const url = parseLoopbackUrl(rawUrl);
  return url !== null && isChatPath(url.pathname);
}

export function createSageAuthFetch(
  inner: FetchLike,
  readToken: ReadToken = expectedChatToken
): FetchLike {
  return createBearerFetch(inner, (url) => isChatPath(url.pathname), readToken);
}

// The hook loads in the forked server process as well as the terminal. The path
// check above is what keeps it off that process's calls, including Ollama.
globalThis.fetch = createSageAuthFetch(globalThis.fetch);
