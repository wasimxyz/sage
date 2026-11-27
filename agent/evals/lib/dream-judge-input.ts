/**
 * What the Dream-source judge is shown: the person's fact sheet and one source
 * next to everything Dream wrote from it.
 *
 * The text lives here, apart from `dream-accuracy.ts`, so the grader can hash
 * it. `dreamSourceLayout()` is what the layout writes for fixed made-up input,
 * and the rubric hash covers it. Changing a heading or a template below then
 * changes the hash, and with it the Dream grade cache.
 */
import { castLine, timelineLine } from "./judge-context.ts";
import type { CastMember, DreamItemKind, TimelineEvent } from "./schema.ts";

export type DreamSourceKind = "entry" | "chat";

/** One thing Dream wrote. `text` is what the judge and the report show. */
export interface DreamWritten {
  itemKind: DreamItemKind;
  text: string;
}

export interface DreamSource {
  sourceId: string;
  sourceKind: DreamSourceKind;
  /** The entry or the chat transcript, as the judge reads it. */
  sourceText: string;
  written: DreamWritten[];
}

/**
 * The person's fact sheet, without the journal. Dream saw one source, so the
 * judge checks each claim against that source and uses the fact sheet only to
 * read it right. The text depends only on the person, so every call about
 * one person starts the same way and the gateway can cache it.
 */
export function formatFactSheet(person: {
  id: string;
  personCase: {
    about: string;
    cast: readonly CastMember[];
    timeline: readonly TimelineEvent[];
  };
}): string {
  const { about, cast, timeline } = person.personCase;
  const lines = [
    `# Fact sheet for ${person.id}`,
    "",
    `About the author: ${about}`,
    "",
    "Who is who to the author:",
    ...(cast.length === 0 ? ["- (nobody listed)"] : cast.map(castLine)),
    "",
    "What happened, and how big it was to the author:",
    ...(timeline.length === 0
      ? ["- (nothing listed)"]
      : timeline.map(timelineLine)),
  ];
  return `${lines.join("\n")}\n`;
}

/** The source, then everything Dream wrote from it, each item under its kind. */
export function formatSourceForJudge(source: DreamSource): string {
  const label =
    source.sourceKind === "entry"
      ? "Source (a journal entry)"
      : "Source (a chat between User and Sage)";
  const written = source.written
    .map((item) => `[${item.itemKind}]\n${item.text}`)
    .join("\n\n");
  return `${label}:\n${source.sourceText}\n\nWhat the app wrote from this source:\n${written}`;
}

const LAYOUT_PROBE_PERSON: Parameters<typeof formatFactSheet>[0] = {
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

const LAYOUT_PROBE_EMPTY_PERSON: Parameters<typeof formatFactSheet>[0] = {
  id: "layout-probe-empty",
  personCase: { about: "", cast: [], timeline: [] },
};

/** One of each source kind, written to by every kind of item. */
const LAYOUT_PROBE_SOURCES: DreamSource[] = [
  {
    sourceId: "2000-01-01-first",
    sourceKind: "entry",
    sourceText: '2000-01-01, "First"\n\nFirst body.',
    written: [
      { itemKind: "summary", text: "Summary text." },
      { itemKind: "profile", text: "Profile text." },
      { itemKind: "fact", text: "Subject: Fact text." },
      { itemKind: "event", text: "2000-01-01: Event text." },
    ],
  },
  {
    sourceId: "chat-1",
    sourceKind: "chat",
    sourceText: "User: Hello.\n\nSage: Hi.",
    written: [
      { itemKind: "chat-summary", text: "Chat summary text." },
      { itemKind: "chat-title", text: "Chat title text" },
    ],
  },
];

/**
 * What the fact sheet and the source layout write for fixed made-up input:
 * one person that uses every part of the fact sheet, one with nothing in it,
 * and an entry and a chat with every kind of written item. The rubric hash
 * covers this text.
 */
export function dreamSourceLayout(): string {
  return [
    formatFactSheet(LAYOUT_PROBE_PERSON),
    formatFactSheet(LAYOUT_PROBE_EMPTY_PERSON),
    ...LAYOUT_PROBE_SOURCES.map(formatSourceForJudge),
  ].join("\n----\n");
}
