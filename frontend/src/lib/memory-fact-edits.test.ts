import assert from "node:assert/strict";
import test from "node:test";

import {
  appendDraft,
  draftsFromRecords,
  factEditsCanSave,
  insertDraftAfter,
  planFactEdits,
  removeDraft,
} from "./memory-fact-edits.ts";

test("draftsFromRecords keeps ids and text", () => {
  const drafts = draftsFromRecords([
    { fact: "Lives nearby", id: 1 },
    { fact: "Brought soup", id: 2 },
  ]);
  assert.deepEqual(
    drafts.map((draft) => ({ fact: draft.text, id: draft.id })),
    [
      { fact: "Lives nearby", id: 1 },
      { fact: "Brought soup", id: 2 },
    ]
  );
});

test("draftsFromRecords starts with one empty line when there are no rows", () => {
  const drafts = draftsFromRecords([]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.id, undefined);
  assert.equal(drafts[0]?.text, "");
});

test("insertDraftAfter puts an empty line under the current one", () => {
  const start = draftsFromRecords([{ fact: "Lives nearby", id: 1 }]);
  const inserted = insertDraftAfter(start, 0);
  assert.equal(inserted.drafts.length, 2);
  assert.equal(inserted.drafts[0]?.text, "Lives nearby");
  assert.equal(inserted.drafts[1]?.text, "");
  assert.equal(inserted.drafts[1]?.key, inserted.key);
});

test("appendDraft adds an empty line at the end", () => {
  const start = draftsFromRecords([
    { fact: "One", id: 1 },
    { fact: "Two", id: 2 },
  ]);
  const appended = appendDraft(start);
  assert.equal(appended.drafts.length, 3);
  assert.equal(appended.drafts[2]?.text, "");
  assert.equal(appended.drafts[2]?.key, appended.key);
});

test("removeDraft on the last line clears it instead of dropping the editor", () => {
  const start = draftsFromRecords([{ fact: "Lives nearby", id: 1 }]);
  const removed = removeDraft(start, start[0]?.key ?? "");
  assert.equal(removed.drafts.length, 1);
  assert.equal(removed.drafts[0]?.id, 1);
  assert.equal(removed.drafts[0]?.text, "");
  assert.equal(removed.focusKey, start[0]?.key);
});

test("removeDraft drops a middle line and focuses the one above", () => {
  const start = draftsFromRecords([
    { fact: "One", id: 1 },
    { fact: "Two", id: 2 },
    { fact: "Three", id: 3 },
  ]);
  const [, middle] = start;
  assert.ok(middle);
  const removed = removeDraft(start, middle.key);
  assert.deepEqual(
    removed.drafts.map((draft) => draft.id),
    [1, 3]
  );
  assert.equal(removed.focusKey, start[0]?.key);
});

test("planFactEdits skips unchanged sentences", () => {
  const original = [{ fact: "Lives nearby", id: 1, subject: "Maya" }];
  const drafts = draftsFromRecords(original);
  assert.deepEqual(planFactEdits(original, drafts, "Maya"), {
    deletes: [],
    saves: [],
  });
  assert.equal(factEditsCanSave(original, drafts), false);
});

test("planFactEdits updates a changed sentence and keeps its subject", () => {
  const original = [{ fact: "Lives nearby", id: 1, subject: "Maya" }];
  const [first] = draftsFromRecords(original);
  assert.ok(first);
  const plan = planFactEdits(
    original,
    [{ ...first, text: " Lives across town " }],
    "Maya"
  );
  assert.deepEqual(plan, {
    deletes: [],
    saves: [{ fact: "Lives across town", id: 1, subject: "Maya" }],
  });
});

test("planFactEdits creates a new sentence under the subject", () => {
  const original = [{ fact: "Lives nearby", id: 1, subject: "Maya" }];
  const drafts = [
    ...draftsFromRecords(original),
    { key: "new", text: " Brought soup " },
  ];
  const plan = planFactEdits(original, drafts, "Maya");
  assert.deepEqual(plan.saves, [{ fact: "Brought soup", subject: "Maya" }]);
  assert.deepEqual(plan.deletes, []);
});

test("planFactEdits deletes a cleared or missing row", () => {
  const original = [
    { fact: "Lives nearby", id: 1 },
    { fact: "Brought soup", id: 2 },
  ];
  const drafts = draftsFromRecords(original);
  const [first] = drafts;
  assert.ok(first);
  const cleared = planFactEdits(original, [{ ...first, text: "   " }]);
  assert.deepEqual(cleared.deletes, [1, 2]);
  const dropped = planFactEdits(original, [first]);
  assert.deepEqual(dropped.deletes, [2]);
});

test("factEditsCanSave is false when every line is blank", () => {
  const original = [{ fact: "Lives nearby", id: 1 }];
  const [first] = draftsFromRecords(original);
  assert.ok(first);
  assert.equal(factEditsCanSave(original, [{ ...first, text: "  " }]), false);
});

test("factEditsCanSave is true after a new sentence", () => {
  const original = [{ fact: "Lives nearby", id: 1 }];
  const drafts = [
    ...draftsFromRecords(original),
    { key: "new", text: "Brought soup" },
  ];
  assert.equal(factEditsCanSave(original, drafts), true);
});

test("an extra empty line does not count as a change", () => {
  const original = [{ fact: "Lives nearby", id: 1 }];
  const drafts = [...draftsFromRecords(original), { key: "new", text: "  " }];
  assert.deepEqual(planFactEdits(original, drafts), { deletes: [], saves: [] });
  assert.equal(factEditsCanSave(original, drafts), false);
});
