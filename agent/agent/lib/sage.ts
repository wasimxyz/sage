import { readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readSpawnSecrets } from "@sage/world-encrypted-local/spawn";

interface Discovery {
  socket: string;
  token: string;
}

const appIds = ["com.wasimxyz.sage-dev", "com.wasimxyz.sage"] as const;
const unreachableMessage =
  "Sage's journal server is not reachable. Keep the Sage window open and try again.";
const notRunningMessage =
  "Sage is not running. Open the Sage app, then try again.";

function bodyBuffer(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === null || body === undefined) {
    return undefined;
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  throw new Error(unreachableMessage);
}

function requestHeaders(
  init: RequestInit,
  token: string,
  body: Buffer | undefined
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {
    authorization: `Bearer ${token}`,
  };
  if (init.headers !== undefined) {
    new Headers(init.headers).forEach((value, key) => {
      if (key.toLowerCase() !== "authorization") {
        headers[key] = value;
      }
    });
  }
  if (body !== undefined) {
    headers["content-length"] = body.length;
  }
  return headers;
}

function responseFrom(res: http.IncomingMessage, chunks: Buffer[]): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    }
  }
  return new Response(Buffer.concat(chunks), {
    headers,
    status: res.statusCode ?? 0,
  });
}

function requestOnSocket(
  discovery: Discovery,
  pathname: string,
  init: RequestInit = {}
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const body = bodyBuffer(init.body);
    const req = http.request(
      {
        headers: requestHeaders(init, discovery.token, body),
        method: init.method ?? "GET",
        path: pathname,
        socketPath: discovery.socket,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve(responseFrom(res, chunks));
        });
      }
    );
    const { signal } = init;
    const onAbort = () => {
      req.destroy();
      reject(new Error(unreachableMessage));
    };
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    req.on("error", () => {
      reject(new Error(unreachableMessage));
    });
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function readDiscoveryFile(file: string): Promise<Discovery | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "socket" in parsed &&
      "token" in parsed &&
      typeof parsed.socket === "string" &&
      parsed.socket.length > 0 &&
      typeof parsed.token === "string"
    ) {
      return { socket: parsed.socket, token: parsed.token };
    }
  } catch {
    // A missing file means this copy of Sage is not advertising a server.
  }
  return null;
}

async function sageIsReachable(discovery: Discovery): Promise<boolean> {
  try {
    const response = await requestOnSocket(discovery, "/health", {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      return false;
    }
    const text = (await response.text()).trim();
    return text === '{"ok":true}';
  } catch {
    return false;
  }
}

function discoveryCandidates(): string[] {
  const override = process.env.SAGE_DISCOVERY_FILE;
  if (override !== undefined && override.length > 0) {
    return [override];
  }
  const home = os.homedir();
  return appIds.map((appId) =>
    path.join(
      home,
      "Library",
      "Application Support",
      appId,
      "agent-server.json"
    )
  );
}

async function loadDiscovery(): Promise<Discovery> {
  const socket = process.env.SAGE_AGENT_SOCKET;
  if (socket !== undefined && socket.length > 0) {
    const secrets = readSpawnSecrets();
    if (secrets === undefined) {
      throw new Error(notRunningMessage);
    }
    const discovery = { socket, token: secrets.token };
    if (await sageIsReachable(discovery)) {
      return discovery;
    }
    throw new Error(unreachableMessage);
  }

  let sawFile = false;
  for (const file of discoveryCandidates()) {
    // biome-ignore lint/performance/noAwaitInLoops: candidates are tried in order and the first reachable one wins.
    const discovery = await readDiscoveryFile(file);
    if (discovery === null) {
      continue;
    }
    sawFile = true;
    if (await sageIsReachable(discovery)) {
      return discovery;
    }
  }
  throw new Error(sawFile ? unreachableMessage : notRunningMessage);
}

// Token for the Chat port. Packaged Chat reads the spawn pipe, which the
// world package caches after the first read. Dev and eval re-read
// agent-server.json on every check: Sage rewrites that file on each launch,
// and a missing file must be tried again on the next request.
export async function expectedChatToken(): Promise<string | null> {
  const socket = process.env.SAGE_AGENT_SOCKET;
  if (socket !== undefined && socket.length > 0) {
    const secrets = readSpawnSecrets();
    if (secrets === undefined || secrets.token.length === 0) {
      return null;
    }
    return secrets.token;
  }

  for (const file of discoveryCandidates()) {
    // biome-ignore lint/performance/noAwaitInLoops: candidates are tried in order and the first token wins.
    const discovery = await readDiscoveryFile(file);
    if (discovery !== null && discovery.token.length > 0) {
      return discovery.token;
    }
  }
  return null;
}

export async function sageFetch(
  pathname: string,
  init: RequestInit = {}
): Promise<Response> {
  const discovery = await loadDiscovery();
  try {
    return await requestOnSocket(discovery, pathname, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(unreachableMessage, { cause: error });
  }
}

export async function sageChatReady(): Promise<boolean> {
  try {
    const response = await sageFetch("/features", {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function readSageJson(response: Response): Promise<unknown> {
  if (response.status === 409) {
    throw new Error(
      "The journal is locked. Ask the user to unlock Sage, then try again."
    );
  }
  if (response.status === 404) {
    throw new Error("No journal entry has that id.");
  }
  if (!response.ok) {
    throw new Error(`Sage returned HTTP ${response.status}.`);
  }
  return await response.json();
}
