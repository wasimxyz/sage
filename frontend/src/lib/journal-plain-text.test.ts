import assert from "node:assert/strict";
import test from "node:test";

import { oneLinePlainText, stripMarkdown } from "./journal-plain-text.ts";

test("stripMarkdown removes marks, headings, links, and code", () => {
  assert.equal(
    stripMarkdown("This is **bold** and *italic*."),
    "This is bold and italic."
  );
  assert.equal(
    stripMarkdown("# Hello\n\nA [link](https://example.com)."),
    "Hello\n\nA link."
  );
  assert.equal(stripMarkdown("Use `code` here."), "Use code here.");
});

test("stripMarkdown leaves plain sentences alone", () => {
  assert.equal(stripMarkdown("Hello from TipTap"), "Hello from TipTap");
});

test("oneLinePlainText strips markdown and collapses whitespace", () => {
  assert.equal(
    oneLinePlainText("# Hello\n\nThis is **bold** text."),
    "Hello This is bold text."
  );
});
