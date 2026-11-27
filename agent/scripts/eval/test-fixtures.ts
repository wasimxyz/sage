// Helpers for the runner's unit tests: made-up people, temp folders, and a
// fake `eve` command. Not a test file itself.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type test from "node:test";

import { dreamSourceFiles, seedSourceFiles } from "../../evals/lib/cache.ts";
import { parsePersonCase } from "../../evals/lib/schema.ts";
import type { LoadedChat, LoadedEntry, LoadedPerson } from "./people.ts";

export function tempDir(
  t: test.TestContext,
  prefix = "sage-eval-test-"
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}

interface PersonOptions {
  chat?: unknown[];
  /** Past chats with Sage. */
  chats?: LoadedChat[];
  conversations?: unknown[];
  entries?: number;
  events?: unknown[];
  facts?: unknown[];
  openers?: unknown[];
  retrieval?: unknown[];
  summaries?: unknown[];
  tags?: string[];
}

function entryOf(index: number): LoadedEntry {
  const stem = `2026-06-${String(index).padStart(2, "0")}-entry-${index}`;
  return {
    body: `Entry number ${index}.`,
    date: `2026-06-${String(index).padStart(2, "0")}`,
    fileName: `${stem}.md`,
    index,
    stem,
    title: `Entry ${index}`,
    wordCount: 3,
  };
}

/** A made-up person with the given items. */
/** Writes each source and seeding file the Dream cache key reads, so a fake repo can be hashed. */
export function writeCacheKeyFiles(repo: string): void {
  for (const rel of [...dreamSourceFiles, ...seedSourceFiles]) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), rel);
  }
}

export function makePerson(
  id: string,
  options: PersonOptions = {}
): LoadedPerson {
  const entries = Array.from({ length: options.entries ?? 3 }, (_, i) =>
    entryOf(i + 1)
  );
  return {
    chats: options.chats ?? [],
    dir: `/data/people/${id}`,
    empty: entries.length === 0,
    entries,
    id,
    personCase: parsePersonCase({
      about: "A made-up person.",
      chat: options.chat ?? [],
      conversations: options.conversations ?? [],
      events: options.events ?? [],
      facts: options.facts ?? [],
      id,
      openers: options.openers ?? [],
      retrieval: options.retrieval ?? [],
      summaries: options.summaries ?? [],
      tags: options.tags ?? [],
    }),
  };
}

export function opener(
  id: string,
  tags: string[] = []
): Record<string, unknown> {
  return { expect: "venting", id, message: `Message for ${id}.`, tags };
}

export function conversation(
  id: string,
  maxTurns = 6,
  tags: string[] = []
): Record<string, unknown> {
  return {
    expect: "venting",
    id,
    maxTurns,
    opening: "Hello.",
    persona: {
      openness: "open",
      situation: "A hard week.",
      style: "terse",
      wants: "vent",
    },
    tags,
  };
}

/**
 * Writes a stand-in for `agent/node_modules/.bin/eve` in `agentDir`: a Node
 * script that runs `body`, which sees `args` (an array) and `process.env`.
 */
export function fakeEve(agentDir: string, body: string): string {
  const bin = join(agentDir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "eve");
  writeFileSync(
    path,
    `#!/usr/bin/env node\nconst args = process.argv.slice(2);\n${body}\n`
  );
  chmodSync(path, 0o755);
  return path;
}
