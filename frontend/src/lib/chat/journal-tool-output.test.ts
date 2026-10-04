import assert from "node:assert/strict";
import test from "node:test";

import {
  journalBodyContent,
  journalEntryOutput,
  journalEntryPreview,
  journalSearchHits,
  journalSearchQuery,
} from "./journal-tool-output.ts";

test("journal search output accepts empty and populated result lists", () => {
  assert.deepEqual(journalSearchHits([]), []);
  assert.deepEqual(
    journalSearchHits([
      {
        date: "2026-03-03",
        id: 17,
        score: 0.84,
        snippet: "A week of the same routine.",
        title: "Sunday reset",
      },
    ]),
    [
      {
        date: "2026-03-03",
        id: 17,
        snippet: "A week of the same routine.",
        title: "Sunday reset",
      },
    ]
  );
  assert.equal(journalSearchHits({ entries: [] }), null);
  assert.equal(journalSearchHits([{ id: 0, title: "Bad" }]), null);
});

test("journal search query is read only from a string input field", () => {
  assert.equal(journalSearchQuery({ query: "feeling stuck" }), "feeling stuck");
  assert.equal(journalSearchQuery({ query: 4 }), null);
  assert.equal(journalSearchQuery(null), null);
});

test("journal entry output validates the supported body formats", () => {
  const entry = {
    body: "The rain stopped before morning.",
    bodyFormat: "plain",
    date: "2026-03-03",
    id: 17,
    title: "Sunday reset",
  };
  assert.deepEqual(journalEntryOutput(entry), entry);
  assert.equal(journalEntryOutput({ ...entry, bodyFormat: "html" }), null);
  assert.equal(journalEntryOutput({ ...entry, id: -1 }), null);
});

test("plain and Markdown entry bodies keep their display format", () => {
  const plain = journalEntryOutput({
    body: "Use * literally.\nKeep the paragraph.",
    bodyFormat: "plain",
    date: "2026-03-03",
    id: 17,
    title: "Sunday reset",
  });
  const markdown = journalEntryOutput({
    body: "**A little progress**\n\n- One small thing",
    bodyFormat: "markdown",
    date: "2026-03-03",
    id: 17,
    title: "Sunday reset",
  });

  assert.ok(plain);
  assert.ok(markdown);
  assert.deepEqual(journalBodyContent(plain), {
    kind: "plain",
    text: "Use * literally.\nKeep the paragraph.",
  });
  assert.deepEqual(journalBodyContent(markdown), {
    kind: "markdown",
    text: "**A little progress**\n\n- One small thing",
  });
});

test("TipTap entry bodies serialize to readable Markdown", () => {
  const entry = journalEntryOutput({
    body: JSON.stringify({
      content: [
        {
          content: [
            {
              marks: [{ type: "bold" }],
              text: "One small thing",
              type: "text",
            },
          ],
          type: "paragraph",
        },
      ],
      type: "doc",
    }),
    bodyFormat: "tiptap",
    date: "2026-03-03",
    id: 17,
    title: "Sunday reset",
  });

  assert.ok(entry);
  assert.deepEqual(journalBodyContent(entry), {
    kind: "markdown",
    text: "**One small thing**",
  });
  assert.deepEqual(journalBodyContent({ ...entry, body: "" }), {
    kind: "markdown",
    text: "",
  });
  assert.equal(journalBodyContent({ ...entry, body: "not json" }), null);
});

test("journal entry preview strips markdown and joins lines", () => {
  assert.equal(
    journalEntryPreview({
      kind: "markdown",
      text: "# Monday\n\nWent for a **long** walk.",
    }),
    "Monday Went for a long walk."
  );
  assert.equal(
    journalEntryPreview({ kind: "plain", text: "Line one\n\n  line   two" }),
    "Line one line two"
  );
});

test("journal entry preview keeps a short entry whole", () => {
  assert.equal(
    journalEntryPreview({ kind: "plain", text: "abcde" }, 5),
    "abcde"
  );
  assert.equal(journalEntryPreview({ kind: "plain", text: "" }), "");
  assert.equal(journalEntryPreview({ kind: "markdown", text: "  \n " }), "");
});

test("journal entry preview cuts a long entry with an ellipsis", () => {
  assert.equal(
    journalEntryPreview({ kind: "plain", text: "abcdefghij" }, 5),
    "abcde…"
  );
  assert.equal(
    journalEntryPreview({ kind: "plain", text: "ab cd efgh" }, 3),
    "ab…"
  );
  const long = journalEntryPreview({ kind: "plain", text: "x".repeat(1000) });
  assert.equal(long, `${"x".repeat(300)}…`);
});

test("journal entry preview does not split an emoji", () => {
  // The cut falls between the two halves of the emoji, so it backs off one.
  assert.equal(
    journalEntryPreview({ kind: "plain", text: "ab😀cd" }, 3),
    "ab…"
  );
  assert.equal(
    journalEntryPreview({ kind: "plain", text: "ab😀cd" }, 4),
    "ab😀…"
  );
});
