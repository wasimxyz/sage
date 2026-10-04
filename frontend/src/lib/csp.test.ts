import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

const cspContent = /content="([^"]+)"\s+http-equiv="Content-Security-Policy"/;
const whitespace = /\s+/;

function contentSecurityPolicy(): string {
  const match = cspContent.exec(html);
  assert.ok(match, "index.html is missing its content security policy");
  return match[1] ?? "";
}

function sources(directive: string): string[] {
  const policy = contentSecurityPolicy()
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directive} `));
  assert.ok(policy, `the policy is missing ${directive}`);
  return policy.split(whitespace).slice(1);
}

test("connect-src does not mention canirun", () => {
  for (const source of sources("connect-src")) {
    assert.ok(
      !source.toLowerCase().includes("canirun"),
      `${source} lets the page reach canirun`
    );
  }
});

test("connect-src reaches only this app and the local servers", () => {
  const allowed = ["'self'", "ws://127.0.0.1", "http://127.0.0.1", "zero://"];

  for (const source of sources("connect-src")) {
    assert.ok(
      allowed.some((prefix) => source.startsWith(prefix)),
      `${source} is not a local source`
    );
  }
});

test("the policy keeps the rest of the page local", () => {
  assert.deepEqual(sources("default-src"), ["'self'"]);
  assert.deepEqual(sources("img-src"), ["'self'", "data:"]);
});
