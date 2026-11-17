/**
 * Conversations: a simulated user plays the person for several turns.
 *
 * `chat/conversations.eval.ts` makes one eval for each conversation and repeat
 * of the person this pass is about. A conversation marked `alsoEmpty` runs a
 * second time on the empty journal, the way an opener does (see `openers.ts`):
 * the empty journal is one person's Sage, `new-user`, so those runs belong to
 * `new-user`'s pass. It sends its own conversations on its own (empty) journal,
 * and the `alsoEmpty` conversations of everyone else on the empty journal, with
 * `journal: "empty"` on their transcript rows.
 *
 * The sweep's `tags` pick the conversations by the same rule as openers: a
 * conversation runs when its own tags or its person's tags share a tag with the
 * sweep, and a sweep with no tags runs every conversation.
 *
 * Item ids are `<person>/conversation/<conversation id>`. A run on the empty
 * journal is `<person>/conversation/<conversation id>.empty`, so its rows stay
 * apart from the run on the person's own journal.
 *
 * A conversation takes as long as it takes: 30 minutes, or 2 hours when it can
 * run to more than 12 person messages (`conversationTimeoutMs`).
 */
import { defineEval } from "eve/evals";

import { conversationTimeoutMs, runConversation } from "./conversation-run.ts";
import { type LoadedPerson, loadPeople } from "./dataset.ts";
import {
  EMPTY_JOURNAL_PERSON,
  EMPTY_KEY_SUFFIX,
  itemMatchesTags,
  withoutExcluded,
} from "./openers.ts";
import type { EvalDefinition, PersonPass } from "./pass.ts";
import { itemMetadata, makeItem } from "./record.ts";
import { type Conversation, itemIdFor, type Journal } from "./schema.ts";
import { type SimulatedUser, sharedSimulatedUser } from "./simulated-user.ts";
import { appendTranscript } from "./transcripts.ts";

/** The id key of a conversation's run: its id, with `.empty` on the empty journal. */
export function conversationKey(
  conversationId: string,
  journal: Journal
): string {
  return journal === "empty"
    ? `${conversationId}${EMPTY_KEY_SUFFIX}`
    : conversationId;
}

/** The conversation id and journal an id key stands for. */
export function splitConversationKey(key: string): {
  conversationId: string;
  journal: Journal;
} {
  return key.endsWith(EMPTY_KEY_SUFFIX)
    ? {
        conversationId: key.slice(0, -EMPTY_KEY_SUFFIX.length),
        journal: "empty",
      }
    : { conversationId: key, journal: "own" };
}

/** One conversation to run, and where. */
export interface ConversationItemRun {
  conversation: Conversation;
  /** The person's own journal, or the empty one. */
  journal: Journal;
  /** The person who wrote the conversation. */
  owner: Pick<LoadedPerson, "id" | "personCase">;
}

/** The conversations of a person that the sweep's tags pick. */
export function matchingConversations(
  person: Pick<LoadedPerson, "personCase">,
  sweepTags: readonly string[]
): Conversation[] {
  return person.personCase.conversations.filter((conversation) =>
    itemMatchesTags(person.personCase.tags, conversation.tags, sweepTags)
  );
}

/** The conversations of a person that also run on the empty journal and that the tags pick. */
export function alsoEmptyConversations(
  person: Pick<LoadedPerson, "personCase">,
  sweepTags: readonly string[]
): Conversation[] {
  return matchingConversations(person, sweepTags).filter(
    (conversation) => conversation.alsoEmpty
  );
}

/**
 * Everything one pass runs. The host's own conversations run on its own
 * journal. When the host is the empty-journal person, the `alsoEmpty`
 * conversations of `others` follow, in the order the people are given. A
 * person with entries never runs another person's conversations.
 */
export function conversationRuns(
  host: Pick<LoadedPerson, "empty" | "id" | "personCase">,
  others: readonly Pick<LoadedPerson, "id" | "personCase">[],
  sweepTags: readonly string[]
): ConversationItemRun[] {
  const runs: ConversationItemRun[] = matchingConversations(
    host,
    sweepTags
  ).map((conversation) => ({ conversation, journal: "own", owner: host }));
  if (host.id !== EMPTY_JOURNAL_PERSON || !host.empty) {
    return runs;
  }
  for (const owner of others) {
    if (owner.id === host.id) {
      continue;
    }
    for (const conversation of alsoEmptyConversations(owner, sweepTags)) {
      runs.push({ conversation, journal: "empty", owner });
    }
  }
  return runs;
}

/**
 * True when some person in `people` has an `alsoEmpty` conversation that the
 * tags pick, so the sweep needs the empty-journal person's Sage.
 */
export function needsEmptyJournalForConversations(
  people: readonly Pick<LoadedPerson, "empty" | "id" | "personCase">[],
  sweepTags: readonly string[]
): boolean {
  return people.some(
    (person) =>
      person.id !== EMPTY_JOURNAL_PERSON &&
      alsoEmptyConversations(person, sweepTags).length > 0
  );
}

/** The tags of a conversation's evals: its person's, its own, and the pass names. */
export function conversationTags(run: ConversationItemRun): string[] {
  return [
    ...new Set([
      ...run.owner.personCase.tags,
      ...run.conversation.tags,
      "chat",
      "conversations",
    ]),
  ];
}

export interface ConversationEvalDeps {
  /** Loads every person. Defaults to `loadPeople` from `dataset.ts`. */
  loadPeople?: () => Promise<LoadedPerson[]>;
  /** The simulated user. Defaults to the one the pass's environment describes. */
  simulator?: SimulatedUser;
}

/** The evals of one pass: one for each conversation to run and each repeat. */
export async function conversationEvals(
  { pass, person }: PersonPass,
  deps: ConversationEvalDeps = {}
): Promise<EvalDefinition[]> {
  const others =
    person.id === EMPTY_JOURNAL_PERSON && person.empty
      ? withoutExcluded(
          await (deps.loadPeople ?? loadPeople)(),
          pass.sweep.excludeTags
        )
      : [];
  const runs = conversationRuns(person, others, pass.sweep.tags);
  return runs.flatMap((run) =>
    Array.from({ length: pass.repeats }, (_, offset) => {
      const repeat = offset + 1;
      const item = makeItem(
        {
          itemId: itemIdFor(
            run.owner.id,
            "conversation",
            conversationKey(run.conversation.id, run.journal)
          ),
          kind: "conversation",
          person: run.owner.id,
        },
        pass.setupId,
        repeat
      );
      const where = run.journal === "empty" ? " (empty journal)" : "";
      const again = pass.repeats > 1 ? ` (repeat ${repeat})` : "";
      return defineEval({
        description: `${run.owner.id}: conversation ${run.conversation.id}${where}${again}`,
        metadata: itemMetadata(item),
        tags: conversationTags(run),
        async test(t) {
          appendTranscript(
            await runConversation(
              t,
              item,
              {
                about: run.owner.personCase.about,
                conversation: run.conversation,
                journal: run.journal,
              },
              pass.setup,
              deps.simulator ?? sharedSimulatedUser()
            )
          );
        },
        timeoutMs: conversationTimeoutMs(run.conversation.maxTurns),
      });
    })
  );
}
