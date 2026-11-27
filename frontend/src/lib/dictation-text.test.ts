import assert from "node:assert/strict";
import test from "node:test";

import { joinPhrase, tidyParagraphs } from "./dictation-text.ts";

test("a phrase at the start takes no space", () => {
  assert.equal(joinPhrase("", "hello there"), "hello there");
});

test("a phrase after a word takes a space in front", () => {
  assert.equal(joinPhrase("Okay", "so it is Sunday"), " so it is Sunday");
  assert.equal(joinPhrase("end.", "Next"), " Next");
});

test("a phrase after a space or a line break takes none", () => {
  assert.equal(joinPhrase("Okay ", "so"), "so");
  assert.equal(joinPhrase("Okay\n", "so"), "so");
  assert.equal(joinPhrase("\t", "so"), "so");
});

test("a phrase after an opening bracket or quote takes none", () => {
  assert.equal(joinPhrase("(", "aside"), "aside");
  assert.equal(joinPhrase("said “", "yes"), "yes");
});

test("a phrase that starts with closing punctuation sticks to the word", () => {
  assert.equal(joinPhrase("Okay", ", then"), ", then");
  assert.equal(joinPhrase("Okay", "."), ".");
  assert.equal(joinPhrase("Okay", "…and so on"), "…and so on");
  assert.equal(joinPhrase("Okay", ")"), ")");
});

test("a phrase that starts with a quote takes a space", () => {
  assert.equal(joinPhrase("said", '"hello"'), ' "hello"');
});

test("extra spaces and line breaks inside a phrase collapse", () => {
  assert.equal(joinPhrase("", "  one \n two   three "), "one two three");
});

test("a phrase with no words gives nothing", () => {
  assert.equal(joinPhrase("Okay", ""), "");
  assert.equal(joinPhrase("Okay", "   "), "");
});

test("a phrase before a word takes a space after it", () => {
  assert.equal(joinPhrase("one ", "two", "three"), "two ");
  assert.equal(joinPhrase("one", "two", "three"), " two ");
});

test("a phrase before a space, punctuation, or the end takes none after it", () => {
  assert.equal(joinPhrase("one", "two", ""), " two");
  assert.equal(joinPhrase("one", "two", " three"), " two");
  assert.equal(joinPhrase("one", "two", "\nthree"), " two");
  assert.equal(joinPhrase("one", "two", ". Three"), " two");
});

test("one phrase after another reads as one sentence", () => {
  let text = "";
  for (const phrase of ["So it's", "Sunday evening", "and I finally"]) {
    text += joinPhrase(text, phrase);
  }
  assert.equal(text, "So it's Sunday evening and I finally");
});

test("tidyParagraphs splits on blank lines", () => {
  assert.deepEqual(tidyParagraphs("One.\n\nTwo.\n\n\nThree."), [
    "One.",
    "Two.",
    "Three.",
  ]);
});

test("tidyParagraphs joins wrapped lines inside a paragraph", () => {
  assert.deepEqual(tidyParagraphs("One\ntwo\r\nthree.\n\nFour."), [
    "One two three.",
    "Four.",
  ]);
});

test("tidyParagraphs treats a blank line with spaces as a break", () => {
  assert.deepEqual(tidyParagraphs("One.\n   \nTwo."), ["One.", "Two."]);
});

test("tidyParagraphs trims and drops empty paragraphs", () => {
  assert.deepEqual(tidyParagraphs("\n\n  One.  \n\n\n\n"), ["One."]);
  assert.deepEqual(tidyParagraphs("   "), []);
  assert.deepEqual(tidyParagraphs(""), []);
});

test("tidyParagraphs keeps the words as they are", () => {
  assert.deepEqual(tidyParagraphs("I said *no* to $1,284 — twice."), [
    "I said *no* to $1,284 — twice.",
  ]);
});
