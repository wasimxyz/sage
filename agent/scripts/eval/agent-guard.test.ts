import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_REFUSAL,
  AGENT_REFUSAL_EXIT_CODE,
  agentRefusal,
} from "./agent-guard.ts";

test("an environment with CLAUDECODE set is refused with the one message", () => {
  assert.equal(AGENT_REFUSAL, "make eval is run by you, not by an agent.");
  assert.equal(agentRefusal({ CLAUDECODE: "1" }), AGENT_REFUSAL);
  assert.equal(AGENT_REFUSAL_EXIT_CODE, 2);
});

test("any value counts, an empty one and a zero too, so setting the variable to nothing is no way around it", () => {
  for (const value of ["", "0", "false", "no"]) {
    assert.equal(agentRefusal({ CLAUDECODE: value }), AGENT_REFUSAL, value);
  }
});

test("an environment without CLAUDECODE is not refused, whatever else it holds", () => {
  assert.equal(agentRefusal({}), undefined);
  assert.equal(
    agentRefusal({ CLAUDE_CODE: "1", HOME: "/Users/someone", PATH: "/bin" }),
    undefined
  );
  assert.equal(agentRefusal({ CLAUDECODE: undefined }), undefined);
});
