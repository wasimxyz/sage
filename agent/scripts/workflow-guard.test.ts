import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createWorkflowAuthFetch,
  isWorkflowPath,
  isWorkflowUrl,
  workflowRouteAllowed,
} from "../agent/lib/workflow-guard.ts";

const token = "sage-token";
const flow = "/.well-known/workflow/v1/flow";

test("isWorkflowPath covers the flow and webhook routes", () => {
  assert.equal(isWorkflowPath(flow), true);
  assert.equal(isWorkflowPath(`${flow}?__health`), true);
  assert.equal(isWorkflowPath(`${flow}/`), true);
  assert.equal(isWorkflowPath("/.well-known/workflow/v1/webhook/abc"), true);
  assert.equal(isWorkflowPath("/.well-known/workflow"), true);
});

test("isWorkflowPath catches spellings the router might accept", () => {
  assert.equal(isWorkflowPath("//.well-known/workflow/v1/flow"), true);
  assert.equal(isWorkflowPath("/.WELL-KNOWN/Workflow/v1/flow"), true);
  assert.equal(isWorkflowPath("/%2e%77ell-known/workflow/v1/flow"), true);
  assert.equal(isWorkflowPath("/.well-known/./workflow/v1/flow"), true);
  assert.equal(isWorkflowPath("/a/../.well-known/workflow/v1/flow"), true);
  assert.equal(isWorkflowPath("/.well-known%2fworkflow/v1/flow"), true);
  assert.equal(isWorkflowPath("/.well-known\\workflow/v1/flow"), true);
  assert.equal(isWorkflowPath("/%E0%A4%A"), true);
});

test("isWorkflowPath leaves Chat and unrelated paths alone", () => {
  assert.equal(isWorkflowPath("/eve/v1/health"), false);
  assert.equal(isWorkflowPath("/eve/v1/session"), false);
  assert.equal(isWorkflowPath("/"), false);
  assert.equal(isWorkflowPath("/.well-known/ucp"), false);
  assert.equal(isWorkflowPath("/eve/v1/info?x=/.well-known/workflow"), false);
});

test("workflowRouteAllowed needs the right bearer on workflow routes", () => {
  assert.equal(workflowRouteAllowed(flow, `Bearer ${token}`, token), true);
  assert.equal(workflowRouteAllowed(flow, `bearer ${token}`, token), true);
  assert.equal(workflowRouteAllowed(flow, undefined, token), false);
  assert.equal(workflowRouteAllowed(flow, null, token), false);
  assert.equal(workflowRouteAllowed(flow, "", token), false);
  assert.equal(workflowRouteAllowed(flow, "Bearer", token), false);
  assert.equal(workflowRouteAllowed(flow, "Bearer wrong", token), false);
  assert.equal(workflowRouteAllowed(flow, token, token), false);
  assert.equal(workflowRouteAllowed(flow, `Basic ${token}`, token), false);
  assert.equal(workflowRouteAllowed(flow, `Bearer ${token}x`, token), false);
});

test("workflowRouteAllowed refuses when Sage has no token yet", () => {
  assert.equal(workflowRouteAllowed(flow, `Bearer ${token}`, null), false);
  assert.equal(workflowRouteAllowed(flow, "Bearer ", ""), false);
  assert.equal(workflowRouteAllowed(flow, "Bearer ", null), false);
});

test("workflowRouteAllowed does not touch other routes", () => {
  assert.equal(workflowRouteAllowed("/eve/v1/health", undefined, null), true);
  assert.equal(workflowRouteAllowed("/eve/v1/session", undefined, token), true);
});

const runnerEnv = { PORT: "2001" };

test("isWorkflowUrl covers the runner's loopback calls only", () => {
  assert.equal(isWorkflowUrl(`http://127.0.0.1:2001${flow}`, runnerEnv), true);
  assert.equal(
    isWorkflowUrl(`http://localhost:2001${flow}?__health`, runnerEnv),
    true
  );
  assert.equal(isWorkflowUrl(`http://[::1]:2001${flow}`, runnerEnv), true);
  assert.equal(isWorkflowUrl(`https://example.com${flow}`, runnerEnv), false);
  assert.equal(
    isWorkflowUrl("http://127.0.0.1:2001/eve/v1/info", runnerEnv),
    false
  );
  assert.equal(
    isWorkflowUrl("http://127.0.0.1:11434/api/chat", runnerEnv),
    false
  );
  assert.equal(isWorkflowUrl("not a url", runnerEnv), false);
});

test("isWorkflowUrl signs only the port the runner posts to", () => {
  assert.equal(isWorkflowUrl(`http://127.0.0.1:2002${flow}`, runnerEnv), false);
  assert.equal(isWorkflowUrl(`http://127.0.0.1${flow}`, runnerEnv), false);
  // world-local reads WORKFLOW_LOCAL_BASE_URL before PORT.
  const both = { PORT: "2001", WORKFLOW_LOCAL_BASE_URL: "http://localhost:3333" };
  assert.equal(isWorkflowUrl(`http://127.0.0.1:3333${flow}`, both), true);
  assert.equal(isWorkflowUrl(`http://127.0.0.1:2001${flow}`, both), false);
  const bare = { WORKFLOW_LOCAL_BASE_URL: "http://localhost" };
  assert.equal(isWorkflowUrl(`http://localhost${flow}`, bare), true);
});

test("isWorkflowUrl signs nothing while the runner's port is unknown", () => {
  assert.equal(isWorkflowUrl(`http://127.0.0.1:2001${flow}`, {}), false);
  assert.equal(
    isWorkflowUrl(`http://127.0.0.1:2001${flow}`, { PORT: "" }),
    false
  );
  assert.equal(
    isWorkflowUrl(`http://127.0.0.1:2001${flow}`, { PORT: "abc" }),
    false
  );
  assert.equal(
    isWorkflowUrl(`http://127.0.0.1:2001${flow}`, {
      WORKFLOW_LOCAL_BASE_URL: "not a url",
    }),
    false
  );
});

test("the fetch wrapper adds the bearer to the runner's calls", async () => {
  const seen: Headers[] = [];
  const wrapped = createWorkflowAuthFetch(
    async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return await new Response("{}");
    },
    async () => token,
    runnerEnv
  );
  await wrapped(`http://127.0.0.1:2001${flow}`, {
    headers: { "x-vqs-queue-name": "q" },
    method: "POST",
  });
  assert.equal(seen[0]?.get("authorization"), `Bearer ${token}`);
  assert.equal(seen[0]?.get("x-vqs-queue-name"), "q");
});

test("the fetch wrapper leaves other URLs and a missing token alone", async () => {
  const seen: Array<string | null> = [];
  const inner = async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization"));
    return await new Response("{}");
  };
  await createWorkflowAuthFetch(inner, async () => token, runnerEnv)(
    "http://127.0.0.1:11434/api/chat",
    { headers: { authorization: "Bearer ollama" } }
  );
  await createWorkflowAuthFetch(inner, async () => null, runnerEnv)(
    `http://127.0.0.1:2001${flow}`
  );
  await createWorkflowAuthFetch(inner, async () => token, runnerEnv)(
    `http://127.0.0.1:9999${flow}`
  );
  assert.deepEqual(seen, ["Bearer ollama", null, null]);
});

// A real Node process with the preload loaded in front of a stub server, as
// eve's server sits behind it. The stub answers 200 to everything, so a 401
// can only come from the guard.
const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = join(here, "..");
const preload = join(agentRoot, "agent", "lib", "workflow-guard-preload.ts");

const stubServer = `
import http from "node:http";
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ reached: req.url }));
});
server.on("upgrade", (req, socket) => {
  socket.end("HTTP/1.1 101 Switching Protocols\\r\\nConnection: close\\r\\n\\r\\nupgrade " + req.url);
});
server.on("checkContinue", (req, res) => {
  res.end(JSON.stringify({ reached: req.url, via: "checkContinue" }));
});
server.listen(0, "127.0.0.1", () => {
  console.log("port " + server.address().port);
});
`;

interface GuardedOptions {
  cwd?: string;
  discovery: string | null;
  preload?: string;
  source?: string;
}

interface Guarded {
  base: string;
  output: () => string;
}

async function withGuardedServer(
  options: GuardedOptions,
  run: (guarded: Guarded) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sage-guard-"));
  const discoveryFile = join(dir, "agent-server.json");
  const stubFile = join(dir, "stub.mjs");
  writeFileSync(stubFile, options.source ?? stubServer);
  if (options.discovery !== null) {
    writeFileSync(discoveryFile, options.discovery);
  }
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      options.preload ?? preload,
      stubFile,
    ],
    {
      cwd: options.cwd,
      env: {
        HOME: dir,
        PATH: process.env.PATH ?? "",
        SAGE_DISCOVERY_FILE: discoveryFile,
      },
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
  let output = "";
  try {
    const port = await new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("server exited")));
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /port (\d+)/.exec(output);
        if (match?.[1] !== undefined) {
          resolve(match[1]);
        }
      });
    });
    await run({ base: `http://127.0.0.1:${port}`, output: () => output });
  } finally {
    child.kill();
    rmSync(dir, { force: true, recursive: true });
  }
}

// Writes raw bytes, so a test controls the request target and the headers
// that choose which server event Node emits.
function rawRequest(base: string, lines: string[]): Promise<string> {
  const port = Number(new URL(base).port);
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let received = "";
    socket.setEncoding("utf8");
    socket.setTimeout(3000, () => {
      socket.destroy(new Error("timed out"));
    });
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      resolve(received);
    });
  });
}

const discoveryJson = JSON.stringify({ socket: "/unused.sock", token });
const withToken = { discovery: discoveryJson };

test("the preload answers 401 on workflow routes without the token", async () => {
  await withGuardedServer(withToken, async ({ base }) => {
    for (const path of [
      `${flow}?__health`,
      flow,
      "/.well-known/workflow/v1/webhook/abc",
      "//.well-known/workflow/v1/flow",
      "/.WELL-KNOWN/workflow/v1/flow",
      "/%2e%77ell-known/workflow/v1/flow",
    ]) {
      for (const method of ["GET", "HEAD", "POST"]) {
        const bare = await fetch(`${base}${path}`, { method });
        assert.equal(bare.status, 401, `${method} ${path}`);
        assert.equal(bare.headers.get("www-authenticate"), "Bearer");
        const wrong = await fetch(`${base}${path}`, {
          headers: { authorization: "Bearer wrong" },
          method,
        });
        assert.equal(wrong.status, 401, `${method} ${path} wrong token`);
      }
    }
  });
});

test("the preload lets the right token through and leaves other routes public", async () => {
  await withGuardedServer(withToken, async ({ base }) => {
    const allowed = await fetch(`${base}${flow}`, {
      body: '{"a":1}',
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { reached: flow });
    const health = await fetch(`${base}/eve/v1/health`);
    assert.equal(health.status, 200);
  });
});

test("the preload refuses workflow routes while Sage has written no token", async () => {
  await withGuardedServer({ discovery: null }, async ({ base }) => {
    const response = await fetch(`${base}${flow}`, {
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
    });
    assert.equal(response.status, 401);
    const health = await fetch(`${base}/eve/v1/health`);
    assert.equal(health.status, 200);
    const upgrade = await rawRequest(base, [
      `GET ${flow} HTTP/1.1`,
      "Host: sage.test",
      `Authorization: Bearer ${token}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
    ]);
    assert.match(upgrade, /^HTTP\/1\.1 401 /);
  });
});

test("the preload guards upgrade requests", async () => {
  await withGuardedServer(withToken, async ({ base }) => {
    const upgrade = (path: string, extra: string[] = []) =>
      rawRequest(base, [
        `GET ${path} HTTP/1.1`,
        "Host: sage.test",
        "Connection: Upgrade",
        "Upgrade: websocket",
        ...extra,
      ]);
    const bare = await upgrade(flow);
    assert.match(bare, /^HTTP\/1\.1 401 /);
    assert.match(bare, /www-authenticate: Bearer/);
    assert.doesNotMatch(bare, /101/);
    assert.match(
      await upgrade(flow, ["Authorization: Bearer wrong"]),
      /^HTTP\/1\.1 401 /
    );
    assert.match(
      await upgrade("//.WELL-KNOWN/workflow/v1/flow"),
      /^HTTP\/1\.1 401 /
    );
    const allowed = await upgrade(flow, [`Authorization: Bearer ${token}`]);
    assert.match(allowed, /^HTTP\/1\.1 101 /);
    assert.match(allowed, new RegExp(`upgrade ${flow}`));
    assert.match(await upgrade("/eve/v1/stream"), /^HTTP\/1\.1 101 /);
  });
});

test("the preload guards absolute-form targets and Expect requests", async () => {
  await withGuardedServer(withToken, async ({ base }) => {
    const absolute = (extra: string[] = []) =>
      rawRequest(base, [
        `GET http://sage.test${flow} HTTP/1.1`,
        "Host: sage.test",
        "Connection: close",
        ...extra,
      ]);
    assert.match(await absolute(), /^HTTP\/1\.1 401 /);
    assert.match(
      await absolute([`Authorization: Bearer ${token}`]),
      /^HTTP\/1\.1 200 /
    );
    const expect = (extra: string[] = []) =>
      rawRequest(base, [
        `POST ${flow} HTTP/1.1`,
        "Host: sage.test",
        "Expect: 100-continue",
        "Content-Length: 0",
        "Connection: close",
        ...extra,
      ]);
    const refused = await expect();
    assert.match(refused, /^HTTP\/1\.1 401 /);
    assert.doesNotMatch(refused, /checkContinue/);
    const admitted = await expect([`Authorization: Bearer ${token}`]);
    assert.match(admitted, /checkContinue/);
  });
});

// Inside the preloaded process, global fetch is the wrapper. Port A is the
// runner's own (PORT, as eve and Sage's launcher set it) and port B is some
// other loopback server. Both are guarded, so a 200 means the bearer was
// added and a 401 means it was not.
const fetchProbe = `
import http from "node:http";
const listen = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => res.end("{}"));
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
const own = await listen();
const other = await listen();
process.env.PORT = String(own);
const path = "/.well-known/workflow/v1/flow";
const call = async (port) =>
  (await fetch("http://127.0.0.1:" + port + path, { method: "POST" })).status;
console.log("result " + JSON.stringify({ other: await call(other), own: await call(own) }));
console.log("port " + own);
`;

test("the installed fetch signs the runner's port and no other", async () => {
  await withGuardedServer(
    { discovery: discoveryJson, source: fetchProbe },
    ({ output }) => {
      assert.match(output(), /result {"other":401,"own":200}/);
      return Promise.resolve();
    }
  );
});

test("the preload refuses to start with the node:http job transport on", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--import", preload, "--eval", "0"],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", WORKFLOW_NODE_HTTP: "1" },
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKFLOW_NODE_HTTP/);
});

// The packaged app starts Node in ~/Library/Application Support/<id>/eve/,
// where `agent` and `node_modules` are symlinks into the bundle. Node must
// load the TypeScript preload and its imports through that layout.
test("the preload loads through the app's symlinked agent directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "sage-layout-"));
  try {
    const bundle = join(root, "Resources", "agent");
    mkdirSync(join(bundle, "agent"), { recursive: true });
    cpSync(join(agentRoot, "agent", "lib"), join(bundle, "agent", "lib"), {
      recursive: true,
    });
    symlinkSync(join(agentRoot, "node_modules"), join(bundle, "node_modules"));
    copyFileSync(join(agentRoot, "package.json"), join(bundle, "package.json"));
    const cwd = join(root, "eve");
    mkdirSync(cwd);
    symlinkSync(join(bundle, "agent"), join(cwd, "agent"));
    symlinkSync(join(bundle, "node_modules"), join(cwd, "node_modules"));
    copyFileSync(join(bundle, "package.json"), join(cwd, "package.json"));
    await withGuardedServer(
      {
        cwd,
        discovery: discoveryJson,
        preload: join(cwd, "agent", "lib", "workflow-guard-preload.ts"),
      },
      async ({ base }) => {
        assert.equal((await fetch(`${base}${flow}`)).status, 401);
        const allowed = await fetch(`${base}${flow}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(allowed.status, 200);
        assert.equal((await fetch(`${base}/eve/v1/health`)).status, 200);
      }
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
