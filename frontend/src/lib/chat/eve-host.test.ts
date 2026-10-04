import assert from "node:assert/strict";
import test from "node:test";

import {
  agentHealthDecision,
  eveStartupGraceMs,
  sameAgentHealth,
  withChatAuthorization,
} from "./eve-host.ts";

const downMessage = "Sage could not start the Chat agent.";

test("agentHealthDecision is ready when the sidecar is ready and health is ok", () => {
  assert.deepEqual(
    agentHealthDecision({
      downMessage,
      healthOk: true,
      nowMs: 0,
      sidecar: "ready",
      startedAtMs: 0,
    }),
    { kind: "ready" }
  );
});

test("agentHealthDecision is ready in dev, where Sage owns no port", () => {
  assert.deepEqual(
    agentHealthDecision({
      downMessage,
      healthOk: true,
      nowMs: 0,
      sidecar: null,
      startedAtMs: 0,
    }),
    { kind: "ready" }
  );
});

test("agentHealthDecision stays down when the sidecar is busy, though health is ok", () => {
  const busy = "Port 2001 is already in use, so Chat cannot start.";
  assert.deepEqual(
    agentHealthDecision({
      downMessage: busy,
      healthOk: true,
      nowMs: 0,
      sidecar: "port_busy",
      startedAtMs: 0,
    }),
    { kind: "down", message: busy }
  );
});

test("agentHealthDecision stays down for every status but ready", () => {
  for (const sidecar of ["down", "missing_build", "missing_node"] as const) {
    assert.deepEqual(
      agentHealthDecision({
        downMessage,
        healthOk: true,
        nowMs: 0,
        sidecar,
        startedAtMs: 0,
      }),
      { kind: "down", message: downMessage }
    );
  }
});

test("agentHealthDecision stays checking while the packaged server starts", () => {
  assert.deepEqual(
    agentHealthDecision({
      downMessage,
      healthOk: false,
      nowMs: 1000,
      sidecar: "ready",
      startedAtMs: 0,
    }),
    { kind: "checking" }
  );
});

test("agentHealthDecision shows down after the startup grace", () => {
  assert.deepEqual(
    agentHealthDecision({
      downMessage,
      healthOk: false,
      nowMs: eveStartupGraceMs,
      sidecar: "ready",
      startedAtMs: 0,
    }),
    { kind: "down", message: downMessage }
  );
});

test("agentHealthDecision shows down immediately when Sage owns no port", () => {
  assert.deepEqual(
    agentHealthDecision({
      downMessage:
        "The Chat agent isn't running. Start it with npm --prefix agent run dev.",
      healthOk: false,
      nowMs: 100,
      sidecar: null,
      startedAtMs: 0,
    }),
    {
      kind: "down",
      message:
        "The Chat agent isn't running. Start it with npm --prefix agent run dev.",
    }
  );
});

test("withChatAuthorization adds the bearer token", () => {
  const headers = { "x-sage-think": "1" };
  assert.deepEqual(withChatAuthorization(headers, null), headers);
  assert.deepEqual(withChatAuthorization(headers, ""), headers);
  assert.deepEqual(withChatAuthorization(headers, "abc"), {
    authorization: "Bearer abc",
    "x-sage-think": "1",
  });
});

test("sameAgentHealth compares kind and down message", () => {
  assert.equal(
    sameAgentHealth({ kind: "checking" }, { kind: "checking" }),
    true
  );
  assert.equal(sameAgentHealth({ kind: "ready" }, { kind: "checking" }), false);
  assert.equal(
    sameAgentHealth(
      { kind: "down", message: "a" },
      { kind: "down", message: "a" }
    ),
    true
  );
  assert.equal(
    sameAgentHealth(
      { kind: "down", message: "a" },
      { kind: "down", message: "b" }
    ),
    false
  );
});
