/**
 * The stable part of a judge prompt: one person's fact sheet and full journal.
 *
 * The grader puts this text right after the rubric and before anything that
 * changes from call to call (the transcript, the reply). Every call about the
 * same person then starts with the same long prefix, which the AI Gateway can
 * cache. So the text must depend only on the person and the pinned date, in a
 * fixed order, and never on the item being graded.
 */
import type { CastMember, TimelineEvent } from "./schema.ts";

/** The parts of a loaded person this needs. `LoadedPerson` fits. */
export interface JournalContextSource {
  entries: readonly {
    body: string;
    date: string;
    index: number;
    stem: string;
    title: string;
  }[];
  id: string;
  personCase: {
    about: string;
    cast: readonly CastMember[];
    timeline: readonly TimelineEvent[];
  };
}

function castLine(member: CastMember): string {
  const facts = [member.relation];
  if (member.pronouns !== undefined) {
    facts.push(member.pronouns);
  }
  if (member.alive !== undefined) {
    facts.push(member.alive ? "alive" : "died");
  }
  const note = member.note === undefined ? "" : ` Note: ${member.note}`;
  return `- ${member.name}: ${facts.join(", ")}.${note}`;
}

function timelineLine(event: TimelineEvent): string {
  return `- ${event.date} (${event.weight}): ${event.what}`;
}

/**
 * The fact sheet and the whole journal as plain text. `today` is the pinned
 * date the run reads as "today", so the judge can tell what is recent.
 */
export function formatJournalContext(
  person: JournalContextSource,
  options: { today?: string } = {}
): string {
  const { about, cast, timeline } = person.personCase;
  const lines: string[] = [`# Fact sheet for ${person.id}`, ""];
  if (options.today !== undefined) {
    lines.push(`Today is ${options.today} in this journal.`, "");
  }
  lines.push(`About the author: ${about}`, "");
  lines.push("Who is who to the author:");
  lines.push(
    ...(cast.length === 0 ? ["- (nobody listed)"] : cast.map(castLine))
  );
  lines.push("", "What happened, and how big it was to the author:");
  lines.push(
    ...(timeline.length === 0
      ? ["- (nothing listed)"]
      : timeline.map(timelineLine))
  );
  lines.push("", "# Journal", "");
  if (person.entries.length === 0) {
    lines.push("The journal is empty.");
  }
  for (const entry of person.entries) {
    lines.push(
      `## Entry ${entry.index}: ${entry.date}, "${entry.title}" (${entry.stem})`,
      "",
      entry.body.trim(),
      ""
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const LAYOUT_PROBE_FULL: JournalContextSource = {
  entries: [
    {
      body: "First body.\n",
      date: "2000-01-01",
      index: 1,
      stem: "2000-01-01-first",
      title: "First",
    },
    {
      body: "Second body.",
      date: "2000-01-02",
      index: 2,
      stem: "2000-01-02-second",
      title: "Second",
    },
  ],
  id: "layout-probe",
  personCase: {
    about: "About text.",
    cast: [
      { alive: true, name: "Alive", pronouns: "they/them", relation: "friend" },
      { alive: false, name: "Gone", note: "A note.", relation: "pet" },
      { name: "Plain", relation: "colleague" },
    ],
    timeline: [{ date: "2000-01-01", weight: "big", what: "Something." }],
  },
};

const LAYOUT_PROBE_EMPTY: JournalContextSource = {
  entries: [],
  id: "layout-probe-empty",
  personCase: { about: "", cast: [], timeline: [] },
};

/**
 * What `formatJournalContext` writes for two fixed made-up people: one that
 * uses every part of the layout, and one with nothing in it. The rubric hash
 * covers this text, so changing a heading or a template in the function above
 * changes the hash without anyone having to remember to list it.
 */
export function journalContextLayout(): string {
  return [
    formatJournalContext(LAYOUT_PROBE_FULL, { today: "2000-01-03" }),
    formatJournalContext(LAYOUT_PROBE_EMPTY),
  ].join("\n----\n");
}
