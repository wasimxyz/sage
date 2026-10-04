import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readPage(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

// The `script-src` directive of the page rule in frontend/index.html.
function scriptSrcDirective(): string {
  const html = readPage("frontend/index.html");
  const policy = html.match(
    /content="([^"]*default-src[^"]*)"\s*http-equiv="Content-Security-Policy"/
  )?.[1];
  assert.ok(policy, "frontend/index.html must keep its Content-Security-Policy.");
  return (
    policy
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("script-src")) ?? ""
  );
}

test("the page must not allow inline script", () => {
  const directive = scriptSrcDirective();

  assert.match(
    directive,
    /'self'/,
    "desired: script-src keeps 'self' so the bundled app still loads."
  );
  assert.doesNotMatch(
    directive,
    /unsafe-inline/,
    "desired: drop 'unsafe-inline'. Today a script that ever reaches the page runs."
  );
});

test("the dispose shim ships as a file the page loads, not as inline script", () => {
  const html = readPage("frontend/index.html");
  const inlineTags = html.match(/<script(?![^>]*\ssrc=)[^>]*>/g) ?? [];

  assert.deepEqual(
    inlineTags,
    [],
    "desired: every script on the page comes from a file, so script-src needs no inline allowance."
  );

  const main = readPage("frontend/src/main.tsx");
  assert.match(
    main,
    /^import "\.\/dispose-shim";/,
    "desired: main.tsx imports the shim first, so Symbol.dispose exists before eve's client reads it at load."
  );

  const shim = readPage("frontend/src/dispose-shim.ts");
  assert.match(
    shim,
    /Symbol\.for\("Symbol\.dispose"\)/,
    "desired: the shim defines Symbol.dispose, which WKWebView still lacks."
  );
  assert.match(
    shim,
    /Symbol\.for\("Symbol\.asyncDispose"\)/,
    "desired: the shim defines Symbol.asyncDispose too."
  );
});
