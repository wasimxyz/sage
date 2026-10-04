import assert from "node:assert/strict";
import test from "node:test";

import {
  dreamPollState,
  firstJsonObject,
  isDreamStartReady,
  matchingBridgeResponse,
  nextAutomationSequence,
  parseBridgeJson,
  requireOk,
  resultNumber,
  resultRecord,
  utf8Chunks,
} from "./bridge.ts";

const alreadyDreamingPattern = /already dreaming/;

test("parseBridgeJson reads a journal.save envelope", () => {
  const parsed = parseBridgeJson(
    '{"id":"save-sam-example-1-0","ok":true,"result":{"id":1}}'
  );
  assert.ok(parsed);
  assert.equal(parsed.ok, true);
  assert.equal(resultNumber(parsed, "id"), 1);
  assert.equal(isDreamStartReady(parsed), false);
});

test("parseBridgeJson reads a dream.start envelope with total", () => {
  const parsed = parseBridgeJson(
    '{"id":"eval-dream-start","ok":true,"result":{"ok":true,"total":4}}'
  );
  assert.ok(parsed);
  assert.equal(isDreamStartReady(parsed), true);
  assert.equal(resultNumber(parsed, "total"), 4);
});

test("dreamPollState treats a 0/0 reset after work as finished", () => {
  assert.equal(dreamPollState(true, 29, 30, true), "wait");
  assert.equal(dreamPollState(false, 0, 0, true), "done");
  assert.equal(dreamPollState(false, 30, 30, false), "done");
  assert.equal(dreamPollState(false, 0, 0, false), "wait");
});

test("a leftover save response is not a finished dream.start", () => {
  const leftover = parseBridgeJson(
    '{"id":"eval-dream-start","ok":true,"result":{"id":4}}'
  );
  assert.ok(leftover);
  assert.equal(isDreamStartReady(leftover), false);
  assert.equal(resultNumber(leftover, "total"), 0);
});

test("resultRecord parses a string result body", () => {
  const parsed = resultRecord({
    id: "eval-dream-start",
    ok: true,
    result: '{"ok":true,"total":4}',
  });
  assert.equal(parsed.total, 4);
  assert.equal(
    isDreamStartReady({
      id: "eval-dream-start",
      ok: true,
      result: '{"ok":true,"total":4}',
    }),
    true
  );
});

test("nextAutomationSequence picks the next command file number", () => {
  assert.equal(nextAutomationSequence([]), 1);
  assert.equal(
    nextAutomationSequence(["snapshot.txt", "command-1.txt", "command-7.txt"]),
    8
  );
});

test("matchingBridgeResponse ignores a leftover models list", () => {
  const leftover =
    '{"id":"56","ok":true,"result":{"models":["qwen3:8b","llama3.2:latest"]}}';
  const save =
    'delivered bridge -> /tmp/sage-eval\n{"id":"save-breakup-reconciliation-4-0","ok":true,"result":{"id":4}}\n';
  assert.equal(
    matchingBridgeResponse("save-breakup-reconciliation-4-0", leftover),
    null
  );
  const matched = matchingBridgeResponse(
    "save-breakup-reconciliation-4-0",
    save
  );
  assert.ok(matched);
  assert.equal(resultNumber(matched, "id"), 4);
});

test("firstJsonObject skips CLI delivery text", () => {
  const raw = firstJsonObject(
    'delivered bridge -> /tmp/sage-eval\n{"id":"eval-wipe","ok":true,"result":{"ok":true}}\n'
  );
  const parsed = parseBridgeJson(raw);
  assert.ok(parsed);
  assert.equal(parsed.id, "eval-wipe");
});

test("requireOk throws the handler error message", () => {
  assert.throws(
    () =>
      requireOk(
        {
          error: {
            code: "handler_failed",
            message: "Sage is already dreaming.",
          },
          id: "eval-dream-start",
          ok: false,
        },
        "dream.start"
      ),
    alreadyDreamingPattern
  );
});

test("utf8Chunks splits on byte length without breaking a code point", () => {
  assert.deepEqual(utf8Chunks("", 4), [""]);
  assert.deepEqual(utf8Chunks("abcd", 2), ["ab", "cd"]);
  const chunks = utf8Chunks("éé", 2);
  assert.equal(chunks.join(""), "éé");
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 2));
});
