import assert from "node:assert/strict";
import test from "node:test";

import { MarkdownManager } from "@tiptap/markdown";
import { keydownHandler } from "@tiptap/pm/keymap";
import { getSchema } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import { LegacyUnderline } from "./legacy-underline.ts";

// ProseMirror reads the platform once, so Mod is Meta on a Mac and Ctrl
// elsewhere.
const onMac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
const mod = onMac ? { metaKey: true } : { ctrlKey: true };
const plain = {
  altKey: false,
  ctrlKey: false,
  keyCode: 85,
  metaKey: false,
  shiftKey: false,
};

function handlesKey(event: Record<string, unknown>) {
  const bindings = LegacyUnderline.config.addKeyboardShortcuts?.call(
    undefined as never
  );
  const handler = keydownHandler(
    Object.fromEntries(
      Object.entries(bindings ?? {}).map(([key, run]) => [
        key,
        () => run({ editor: undefined as never }),
      ])
    )
  );
  return handler({} as never, event as never);
}

test("⌘U is swallowed", () => {
  assert.equal(handlesKey({ ...plain, ...mod, key: "u" }), true);
});

test("⇧⌘U is swallowed", () => {
  assert.equal(
    handlesKey({ ...plain, ...mod, key: "U", shiftKey: true }),
    true
  );
});

test("⌘U with Caps Lock on is swallowed", () => {
  assert.equal(handlesKey({ ...plain, ...mod, key: "U" }), true);
});

test("U alone and another command key are not", () => {
  assert.equal(handlesKey({ ...plain, key: "u" }), false);
  assert.equal(handlesKey({ ...plain, ...mod, key: "b", keyCode: 66 }), false);
});

// The editor's list, without the Markdown extension and the React parts.
function editorExtensions() {
  const kit = StarterKit.configure({ underline: false });
  const extensions =
    kit.config.addExtensions?.call({ options: kit.options } as never) ?? [];
  return [...extensions, LegacyUnderline];
}

function markdown() {
  return new MarkdownManager({ extensions: editorExtensions() });
}

function spans(source: string) {
  const doc = markdown().parse(source);
  return (doc.content?.[0]?.content ?? []).map((node) => [
    node.text,
    (node.marks ?? []).map((mark) => mark.type).join("+"),
  ]);
}

function resave(source: string) {
  const manager = markdown();
  return manager.serialize(manager.parse(source));
}

test("text underlined in an older entry opens underlined", () => {
  assert.deepEqual(spans("Some ++underlined++ words"), [
    ["Some ", ""],
    ["underlined", "underline"],
    [" words", ""],
  ]);
});

test("an older entry saves its underline as it was", () => {
  assert.equal(
    resave("Some ++underlined++ words"),
    "Some ++underlined++ words"
  );
  assert.equal(resave("++two words++"), "++two words++");
  assert.equal(resave("x **++bold++** y"), "x **++bold++** y");
});

test("typed plus signs with a space after them stay plain text", () => {
  assert.deepEqual(spans("I write C++ and C++ daily."), [
    ["I write C++ and C++ daily.", ""],
  ]);
  assert.deepEqual(spans("i++ then j++"), [["i++ then j++", ""]]);
});

test("typed plus signs are saved as they were typed", () => {
  assert.equal(
    resave("I write C++ and C++ daily."),
    "I write C++ and C++ daily."
  );
  assert.equal(resave("i++ then j++"), "i++ then j++");
});

const underlinedDoc = {
  content: [
    {
      content: [{ marks: [{ type: "underline" }], text: "ab", type: "text" }],
      type: "paragraph",
    },
  ],
  type: "doc",
};

test("text typed at the end of underlined text is not underlined", () => {
  const doc = getSchema(editorExtensions()).nodeFromJSON(underlinedDoc);
  // Inside "ab" the next letter is underlined too, like any edit in the span.
  assert.deepEqual(
    doc
      .resolve(2)
      .marks()
      .map((mark) => mark.type.name),
    ["underline"]
  );
  assert.deepEqual(doc.resolve(3).marks(), []);
});

test("pasted underline is not parsed", () => {
  const { marks } = getSchema(editorExtensions());
  assert.deepEqual(marks.underline.spec.parseDOM, []);
});
