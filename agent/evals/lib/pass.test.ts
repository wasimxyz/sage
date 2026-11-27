import assert from "node:assert/strict";
import test from "node:test";

import { defineEval } from "eve/evals";

import type { LoadedPerson } from "./dataset.ts";
import { failEval, guardedEvals, personEvals, tagsFor } from "./pass.ts";
import { parsePersonCase } from "./schema.ts";

const noPersonForThisPattern =
  /No person for this pass\. Run make eval so the runner sets SAGE_EVAL_PERSON/u;
const couldNotReadThePattern = /Could not read the sweep file/u;

const couldNotLoadThePattern = /Could not load the summaries evals/u;
const nobodyHasNoCasePattern = /nobody has no case\.yaml/u;

const person: LoadedPerson = {
  chats: [],
  dir: "/nowhere",
  empty: true,
  entries: [],
  id: "sam-example",
  personCase: parsePersonCase({
    about: "A format template.",
    id: "sam-example",
    tags: ["example", "relationship"],
  }),
};

function oneEval(description: string) {
  return defineEval({ description, test: () => undefined });
}

function asList<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

test("personEvals gives a skipped placeholder when no person is set", async () => {
  let loaded = false;
  const result = await personEvals("extraction", () => [oneEval("x")], {
    env: {},
    loadPerson: () => {
      loaded = true;
      return Promise.resolve(person);
    },
  });
  assert.equal(loaded, false);
  assert.match(asList(result)[0].description ?? "", noPersonForThisPattern);
});

test("personEvals builds the evals for the person the pass is about", async () => {
  const seen: string[] = [];
  const result = await personEvals(
    "extraction",
    ({ person: loaded, pass }) => {
      seen.push(loaded.id, pass.setup.chatModel);
      return [oneEval("a"), oneEval("b")];
    },
    {
      env: { SAGE_EVAL_PERSON: "sam-example" },
      loadPerson: (id) => {
        assert.equal(id, "sam-example");
        return Promise.resolve(person);
      },
    }
  );
  assert.equal(asList(result).length, 2);
  assert.equal(seen[0], "sam-example");
});

test("personEvals gives a placeholder when the person has no items of the kind", async () => {
  const result = await personEvals("retrieval", () => [], {
    env: { SAGE_EVAL_PERSON: "sam-example" },
    loadPerson: () => Promise.resolve(person),
  });
  assert.equal(
    asList(result)[0].description,
    "sam-example has no retrieval items."
  );
});

test("a person that cannot be loaded becomes an eval that throws, not a throw at import", async () => {
  const result = await personEvals("summaries", () => [oneEval("x")], {
    env: { SAGE_EVAL_PERSON: "nobody" },
    loadPerson: () => Promise.reject(new Error("nobody has no case.yaml")),
  });
  const [only] = asList(result);
  assert.match(only.description ?? "", couldNotLoadThePattern);
  assert.match(only.description ?? "", nobodyHasNoCasePattern);
  assert.throws(() => only.test({} as never), nobodyHasNoCasePattern);
});

test("a sweep that cannot be read also becomes an eval that throws", async () => {
  const result = await personEvals("extraction", () => [oneEval("x")], {
    env: {
      SAGE_EVAL_PERSON: "sam-example",
      SAGE_EVAL_SWEEP_FILE: "/definitely/not/here.json",
    },
    loadPerson: () => Promise.resolve(person),
  });
  assert.match(asList(result)[0].description ?? "", couldNotReadThePattern);
});

test("guardedEvals passes a list through and marks an empty one", async () => {
  const list = await guardedEvals(
    "x",
    () => Promise.resolve([oneEval("a")]),
    "none"
  );
  assert.equal(asList(list).length, 1);
  const empty = await guardedEvals("x", () => Promise.resolve([]), "none here");
  assert.equal(asList(empty)[0].description, "none here");
});

test("failEval carries the error message in its description", () => {
  const failing = failEval("Could not load", new Error("bad"));
  assert.equal(failing.description, "Could not load: bad");
});

test("tagsFor lists the person's tags and the pass once", () => {
  assert.deepEqual(tagsFor(person, "chat"), [
    "example",
    "relationship",
    "chat",
  ]);
  assert.deepEqual(tagsFor(person, "example"), ["example", "relationship"]);
});
