// Puts Sage's agent-server token on eve's workflow routes.
//
// eve mounts the Workflow SDK's routes under /.well-known/workflow/ on the same
// port as Chat: the job runner (v1/flow) and the webhook routes. They are
// framework-owned, so the Chat channel's auth never sees them. Nitro's server
// directory is off and a custom channel cannot wrap a framework route, so the
// check lives here, in front of Nitro. `workflow-guard-preload.ts` installs it
// with `--import`, before the server starts listening.
//
// The runner posts each job back to its own flow route over loopback HTTP, so
// the same module adds the bearer to those calls. It does so only for the port
// the runner posts to, so no other loopback fetch carries the token. The token
// comes from expectedChatToken(): the spawn pipe in a packaged app,
// agent-server.json in dev and eval.

import { extractBearerToken } from "eve/channels/auth";
import http from "node:http";
import type { Duplex } from "node:stream";
import {
  bearerMatches,
  createBearerFetch,
  type FetchLike,
  parseLoopbackUrl,
  type ReadToken,
} from "./bearer.ts";
import { expectedChatToken } from "./sage.ts";

type Env = Record<string, string | undefined>;

const workflowPrefix = "/.well-known/workflow";
const installedKey = Symbol.for("sage.workflowGuard.installed");
const unauthorizedBody =
  '{"code":"unauthorized","error":"Authorization is required for this route.","ok":false}';
const unauthorizedHeaders = {
  "cache-control": "no-store",
  connection: "close",
  "content-length": String(Buffer.byteLength(unauthorizedBody)),
  "content-type": "application/json",
  "www-authenticate": "Bearer",
};

// True for any path that could reach a workflow route. The check decodes
// percent escapes, folds case and slashes, and resolves dot segments, so a
// spelling the router might accept is still caught. A path it cannot decode is
// treated as a workflow path: a false positive only costs a 401.
export function isWorkflowPath(rawUrl: string): boolean {
  const raw = rawUrl.split(/[?#]/, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return true;
  }
  const folded = decoded.toLowerCase().replaceAll("\\", "/");
  let resolved: string;
  try {
    resolved = new URL(folded.replace(/\/{2,}/g, "/"), "http://sage.invalid")
      .pathname;
  } catch {
    return true;
  }
  return (
    resolved.startsWith(workflowPrefix) || folded.includes(workflowPrefix)
  );
}

export function tokenAdmits(
  authorization: string | null | undefined,
  expectedToken: string | null
): boolean {
  if (expectedToken === null || expectedToken.length === 0) {
    return false;
  }
  const presented = extractBearerToken(authorization ?? null);
  return presented !== null && bearerMatches(expectedToken, presented);
}

export function workflowRouteAllowed(
  rawUrl: string,
  authorization: string | null | undefined,
  expectedToken: string | null
): boolean {
  return !isWorkflowPath(rawUrl) || tokenAdmits(authorization, expectedToken);
}

function effectivePort(url: URL): number {
  if (url.port !== "") {
    return Number(url.port);
  }
  return url.protocol === "https:" ? 443 : 80;
}

// The port the runner posts to. @workflow/world-local reads
// WORKFLOW_LOCAL_BASE_URL first and PORT second. A packaged Sage sets PORT, and
// `eve dev` sets both before it starts the runner. With neither set, the runner
// probes for its port and no call is signed.
function runnerPort(env: Env): number | null {
  const base = env.WORKFLOW_LOCAL_BASE_URL?.trim();
  if (base !== undefined && base !== "") {
    try {
      return effectivePort(new URL(base));
    } catch {
      return null;
    }
  }
  const port = Number.parseInt(env.PORT?.trim() ?? "", 10);
  return Number.isInteger(port) && port > 0 ? port : null;
}

// Loopback URLs on the runner's own port that point at a workflow route.
function isRunnerUrl(url: URL, env: Env): boolean {
  if (!isWorkflowPath(url.pathname)) {
    return false;
  }
  const port = runnerPort(env);
  return port !== null && effectivePort(url) === port;
}

export function isWorkflowUrl(
  rawUrl: string,
  env: Env = process.env
): boolean {
  const url = parseLoopbackUrl(rawUrl);
  return url !== null && isRunnerUrl(url, env);
}

export function createWorkflowAuthFetch(
  inner: FetchLike,
  readToken: ReadToken = expectedChatToken,
  env: Env = process.env
): FetchLike {
  return createBearerFetch(inner, (url) => isRunnerUrl(url, env), readToken);
}

function deny(response: http.ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(401, unauthorizedHeaders);
  response.end(unauthorizedBody);
}

// Upgrade and CONNECT requests hand the server a raw socket, not a response.
function denySocket(socket: Duplex): void {
  if (socket.destroyed || !socket.writable) {
    socket.destroy();
    return;
  }
  const head = Object.entries(unauthorizedHeaders).map(
    ([name, value]) => `${name}: ${value}`
  );
  const lines = ["HTTP/1.1 401 Unauthorized", ...head];
  socket.end(`${lines.join("\r\n")}\r\n\r\n${unauthorizedBody}`, () => {
    socket.destroy();
  });
}

type Emit = (event: string | symbol, ...args: unknown[]) => boolean;

// Events that carry (request, response), and events that carry (request,
// socket, head). Node emits `request` unless the request sent `Expect` or asks
// for an upgrade, so each of these is a way past a guard on `request` alone.
const responseEvents = new Set<string | symbol>([
  "request",
  "checkContinue",
  "checkExpectation",
]);
const socketEvents = new Set<string | symbol>(["upgrade", "connect"]);

// Wraps the request events on every http.Server, so the check holds however
// srvx creates the server and whether or not it is already listening. The
// request waits unread until the token check finishes.
function guardServers(readToken: ReadToken): void {
  const original = http.Server.prototype.emit as Emit;
  http.Server.prototype.emit = function emit(
    this: http.Server,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    const onSocket = socketEvents.has(event);
    if (!(onSocket || responseEvents.has(event))) {
      return original.call(this, event, ...args);
    }
    const request = args[0] as http.IncomingMessage;
    if (!isWorkflowPath(request.url ?? "")) {
      return original.call(this, event, ...args);
    }
    const refuse = (): void => {
      if (onSocket) {
        denySocket(args[1] as Duplex);
        return;
      }
      request.resume();
      deny(args[1] as http.ServerResponse);
    };
    readToken().then(
      (expected) => {
        if (tokenAdmits(request.headers.authorization, expected)) {
          original.call(this, event, ...args);
          return;
        }
        refuse();
      },
      refuse
    );
    return true;
  } as typeof http.Server.prototype.emit;
}

// The runner can send jobs over node:http instead of fetch. That path never
// reaches the fetch wrapper, so every job would hit the guard unsigned.
function assertFetchTransport(env: Env): void {
  const flag = env.WORKFLOW_NODE_HTTP?.toLowerCase();
  if (flag === "1" || flag === "true") {
    throw new Error(
      "Sage cannot guard eve's workflow routes while WORKFLOW_NODE_HTTP is on. Unset it and start the agent again."
    );
  }
}

export function installWorkflowGuard(
  readToken: ReadToken = expectedChatToken
): void {
  const marked = globalThis as Record<symbol, unknown>;
  if (marked[installedKey] === true) {
    return;
  }
  assertFetchTransport(process.env);
  marked[installedKey] = true;
  guardServers(readToken);
  globalThis.fetch = createWorkflowAuthFetch(globalThis.fetch, readToken);
}
