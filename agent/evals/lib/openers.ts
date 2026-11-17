/**
 * Openers: one message from the person and one reply from Sage.
 *
 * `chat/openers.eval.ts` makes one eval for each opener and repeat of the
 * person this pass is about. An opener marked `alsoEmpty` runs a second time
 * on the empty journal. The empty journal is one person's Sage, `new-user`, so
 * those runs belong to `new-user`'s pass: it sends its own openers on its own
 * (empty) journal, and the `alsoEmpty` openers of everyone else on the empty
 * journal, with `journal: "empty"` on their transcript rows.
 *
 * The sweep's `tags` pick the openers. An opener runs when its own tags or its
 * person's tags share a tag with the sweep, and a sweep with no tags runs every
 * opener. The runner counts openers with the same rule (`itemMatchesTags`).
 *
 * Item ids are `<person>/opener/<opener id>`. An `alsoEmpty` run on the empty
 * journal is `<person>/opener/<opener id>.empty`, so its rows stay apart from
 * the run on the person's own journal.
 */
import { defineEval } from "eve/evals";

import { runOpener } from "./chat-turn.ts";
import { type LoadedPerson, loadPeople } from "./dataset.ts";
import type { EvalDefinition, PersonPass } from "./pass.ts";
import { itemMetadata, makeItem } from "./record.ts";
import { itemIdFor, type Journal, type Opener } from "./schema.ts";
import { appendTranscript } from "./transcripts.ts";

/** The person whose Sage has an empty journal. Openers marked `alsoEmpty` run against it. */
export const EMPTY_JOURNAL_PERSON = "new-user";

/** Added to an opener's id for its run on the empty journal. */
export const EMPTY_KEY_SUFFIX = ".empty";

/**
 * True when an item matches the sweep's tags: its own tags or its person's
 * tags share one with the sweep, or the sweep has none.
 */
export function itemMatchesTags(
  personTags: readonly string[],
  itemTags: readonly string[],
  sweepTags: readonly string[]
): boolean {
  if (sweepTags.length === 0) {
    return true;
  }
  const shares = (tags: readonly string[]) =>
    tags.some((tag) => sweepTags.includes(tag));
  return shares(personTags) || shares(itemTags);
}

/**
 * True when a sweep leaves the person out: their `tags` hold one of the sweep's
 * `excludeTags`. A person left out sends nothing, and the empty-journal person
 * does not send their `alsoEmpty` items either.
 */
export function personExcluded(
  person: Pick<LoadedPerson, "personCase">,
  excludeTags: readonly string[]
): boolean {
  return person.personCase.tags.some((tag) => excludeTags.includes(tag));
}

/** The people the sweep leaves in. */
export function withoutExcluded<T extends Pick<LoadedPerson, "personCase">>(
  people: readonly T[],
  excludeTags: readonly string[]
): T[] {
  return people.filter((person) => !personExcluded(person, excludeTags));
}

/** The id key of an opener's run: the opener's id, with `.empty` on the empty journal. */
export function openerKey(openerId: string, journal: Journal): string {
  return journal === "empty" ? `${openerId}${EMPTY_KEY_SUFFIX}` : openerId;
}

/** The opener id and journal an id key stands for. */
export function splitOpenerKey(key: string): {
  journal: Journal;
  openerId: string;
} {
  return key.endsWith(EMPTY_KEY_SUFFIX)
    ? { journal: "empty", openerId: key.slice(0, -EMPTY_KEY_SUFFIX.length) }
    : { journal: "own", openerId: key };
}

/** One opener to send, and where. */
export interface OpenerRun {
  /** The person's own journal, or the empty one. */
  journal: Journal;
  opener: Opener;
  /** The person who wrote the opener. */
  owner: Pick<LoadedPerson, "id" | "personCase">;
}

/** The openers of a person that the sweep's tags pick. */
export function matchingOpeners(
  person: Pick<LoadedPerson, "personCase">,
  sweepTags: readonly string[]
): Opener[] {
  return person.personCase.openers.filter((opener) =>
    itemMatchesTags(person.personCase.tags, opener.tags, sweepTags)
  );
}

/** The openers of a person that also run on the empty journal and that the tags pick. */
export function alsoEmptyOpeners(
  person: Pick<LoadedPerson, "personCase">,
  sweepTags: readonly string[]
): Opener[] {
  return matchingOpeners(person, sweepTags).filter(
    (opener) => opener.alsoEmpty
  );
}

/**
 * Everything one pass sends. The host's own openers run on its own journal.
 * When the host is the empty-journal person, the `alsoEmpty` openers of
 * `others` follow, in the order the people are given. A person with entries
 * never runs another person's openers.
 */
export function openerRuns(
  host: Pick<LoadedPerson, "empty" | "id" | "personCase">,
  others: readonly Pick<LoadedPerson, "id" | "personCase">[],
  sweepTags: readonly string[]
): OpenerRun[] {
  const runs: OpenerRun[] = matchingOpeners(host, sweepTags).map((opener) => ({
    journal: "own",
    opener,
    owner: host,
  }));
  if (host.id !== EMPTY_JOURNAL_PERSON || !host.empty) {
    return runs;
  }
  for (const owner of others) {
    if (owner.id === host.id) {
      continue;
    }
    for (const opener of alsoEmptyOpeners(owner, sweepTags)) {
      runs.push({ journal: "empty", opener, owner });
    }
  }
  return runs;
}

/**
 * True when some person in `people` has an `alsoEmpty` opener that the tags
 * pick, so the sweep needs the empty-journal person's Sage.
 */
export function needsEmptyJournal(
  people: readonly Pick<LoadedPerson, "empty" | "id" | "personCase">[],
  sweepTags: readonly string[]
): boolean {
  return people.some(
    (person) =>
      person.id !== EMPTY_JOURNAL_PERSON &&
      alsoEmptyOpeners(person, sweepTags).length > 0
  );
}

export interface OpenerEvalDeps {
  /** Loads every person. Defaults to `loadPeople` from `dataset.ts`. */
  loadPeople?: () => Promise<LoadedPerson[]>;
}

/** The tags of an opener's evals: its person's, its own, and the pass names. */
export function openerTags(run: OpenerRun): string[] {
  return [
    ...new Set([
      ...run.owner.personCase.tags,
      ...run.opener.tags,
      "chat",
      "openers",
    ]),
  ];
}

/** The evals of one pass: one for each opener to send and each repeat. */
export async function openerEvals(
  { pass, person }: PersonPass,
  deps: OpenerEvalDeps = {}
): Promise<EvalDefinition[]> {
  const others =
    person.id === EMPTY_JOURNAL_PERSON && person.empty
      ? withoutExcluded(
          await (deps.loadPeople ?? loadPeople)(),
          pass.sweep.excludeTags
        )
      : [];
  const runs = openerRuns(person, others, pass.sweep.tags);
  return runs.flatMap((run) =>
    Array.from({ length: pass.repeats }, (_, offset) => {
      const repeat = offset + 1;
      const item = makeItem(
        {
          itemId: itemIdFor(
            run.owner.id,
            "opener",
            openerKey(run.opener.id, run.journal)
          ),
          kind: "opener",
          person: run.owner.id,
        },
        pass.setupId,
        repeat
      );
      const where = run.journal === "empty" ? " (empty journal)" : "";
      const again = pass.repeats > 1 ? ` (repeat ${repeat})` : "";
      return defineEval({
        description: `${run.owner.id}: opener ${run.opener.id}${where}${again}`,
        metadata: itemMetadata(item),
        tags: openerTags(run),
        async test(t) {
          appendTranscript(
            await runOpener(t, item, run.opener, pass.setup, run.journal)
          );
        },
      });
    })
  );
}
