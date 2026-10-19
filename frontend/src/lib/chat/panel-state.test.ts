import assert from "node:assert/strict";
import test from "node:test";

import { initialPanel, type PanelState, panelReducer } from "./panel-state.ts";

const open: PanelState = { expanded: false, open: true };
const full: PanelState = { expanded: true, open: true };
const closed: PanelState = { expanded: false, open: false };

test("the first visit opens the panel, not full screen", () => {
  assert.deepEqual(initialPanel, open);
});

test("closing the panel ends full screen", () => {
  assert.deepEqual(panelReducer(full, { type: "close" }), closed);
  assert.deepEqual(panelReducer(open, { type: "close" }), closed);
});

test("full screen needs an open panel", () => {
  assert.deepEqual(
    panelReducer(open, { expanded: true, type: "expand" }),
    full
  );
  assert.deepEqual(
    panelReducer(closed, { expanded: true, type: "expand" }),
    closed
  );
  assert.deepEqual(
    panelReducer(full, { expanded: false, type: "expand" }),
    open
  );
});

test("opening the panel leaves full screen as it was", () => {
  assert.deepEqual(panelReducer(closed, { type: "open" }), open);
  assert.equal(panelReducer(full, { type: "open" }), full);
});

test("an action that changes nothing returns the same state", () => {
  assert.equal(panelReducer(open, { type: "open" }), open);
  assert.equal(panelReducer(closed, { type: "close" }), closed);
  assert.equal(panelReducer(open, { expanded: false, type: "expand" }), open);
});
