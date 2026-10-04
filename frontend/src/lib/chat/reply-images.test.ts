import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";

import { replyRehypePlugins } from "./reply-images.ts";

// A static render also emits a preload link for an image address, so every
// case checks that the address never reaches the page at all.
function renderReply(markdown: string): string {
  return renderToStaticMarkup(
    createElement(Streamdown, { rehypePlugins: replyRehypePlugins }, markdown)
  );
}

test("a markdown picture with a website address is gone", () => {
  const html = renderReply(
    "Look ![pic](https://pictures.example/pic.png) here."
  );
  assert.ok(!html.includes("pictures.example"), html);
  assert.ok(!html.includes("<img"), html);
});

test("a raw img tag is gone", () => {
  const html = renderReply(
    'Before <img src="https://pictures.example/raw.png"> after.'
  );
  assert.ok(!html.includes("pictures.example"), html);
  assert.ok(!html.includes("<img"), html);
});

test("a source srcset address is gone", () => {
  const html = renderReply(
    'Before <picture><source srcset="https://pictures.example/set.png"></picture> after.'
  );
  assert.ok(!html.includes("pictures.example"), html);
  assert.ok(!html.includes("<source"), html);
});

test("a picture stored inside the message is gone", () => {
  const html = renderReply(
    "Look ![pic](data:image/png;base64,iVBORw0KGgo=) here."
  );
  assert.ok(!html.includes("data:image"), html);
  assert.ok(!html.includes("<img"), html);
});

test("a blob address is gone", () => {
  const html = renderReply("Look ![pic](blob:https://sage.test/abc) here.");
  assert.ok(!html.includes("blob:"), html);
  assert.ok(!html.includes("<img"), html);
});

test("a sentence and a link stay", () => {
  const html = renderReply(
    "Hello there. See [the docs](https://example.com/docs)."
  );
  assert.ok(html.includes("Hello there"), html);
  assert.ok(html.includes('data-streamdown="link"'), html);
  assert.ok(html.includes(">the docs<"), html);
});

test("a script tag still does not arrive", () => {
  const html = renderReply("Before <script>alert(1)</script> after.");
  assert.ok(!html.includes("<script"), html);
  assert.ok(!html.includes("alert(1)"), html);
});

test("MessageResponse passes the helper plugin list to Streamdown", () => {
  const source = readFileSync(
    new URL("../../components/ai-elements/message.tsx", import.meta.url),
    "utf8"
  );
  assert.ok(source.includes('from "@/lib/chat/reply-images"'), source);
  const start = source.indexOf("export const MessageResponse = memo(");
  const end = source.indexOf("MessageResponse.displayName", start);
  assert.ok(start >= 0, source);
  assert.ok(end > start, source);
  // Other components in this file also spread props. Check only the Chat reply
  // component, or a caller can still turn pictures back on.
  const body = source.slice(start, end);
  const propsSpread = body.indexOf("{...props}");
  const componentSpread = body.indexOf("...components");
  const rehypePlugins = body.indexOf("rehypePlugins={replyRehypePlugins}");
  const hiddenImage = body.indexOf("img: NoReplyImage");
  assert.ok(propsSpread >= 0, body);
  assert.ok(componentSpread >= 0, body);
  assert.ok(rehypePlugins > propsSpread, body);
  assert.ok(hiddenImage > componentSpread, body);
});
