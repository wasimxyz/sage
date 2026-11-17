# Eval fixtures

Each case is one made-up person. A person is a folder of Markdown journal entries plus a `case.yaml` that holds their answer key. Each person is seeded into their own throwaway journal.

```text
evals/data/people/sam-example/
├── case.yaml
├── 2026-04-12-first-half-marathon.md
├── 2026-05-22-shin-splints.md
└── 2026-06-15-told-sam.md
```

## Entries

Every `*.md` file at the top of a person’s folder is one entry. Frontmatter needs `date` (`YYYY-MM-DD`) and `title`, and the body is the journal text.

- Name files `<date>-<slug>.md`. Entries are numbered from 1 in filename order, and they are seeded in that order.
- The file name without `.md` is the entry’s stem, such as `2026-06-15-told-sam`. A stem can’t be only digits.
- Every entry is dated on or before `2026-11-15`, the day the runner pins in `SAGE_TODAY`.
- Write in plain first person, in the person’s own voice. Vary the length. Keep it mundane.
- Other files and folders are not entries. `chats/` is where earlier chats with Sage will go.

Add filler entries to make a journal feel lived in, but keep them clear of the topics and dates that a `retrieval` or `when` check depends on. A filler about running would break `Am I currently running?`. A filler dated in April would crowd the `April` check.

## case.yaml

[The schema](../lib/schema.ts) lists every field and rejects an unknown one. The fields are:

- `id`: the folder name
- `tags`: labels for eve filters. The Sam example is tagged `example`, so `make eval ARGS='--tag example'` runs it alone.
- `about`: who the person is, for the judge and the simulated user. Sage never sees it.
- `cast`: the fact sheet, described below
- `timeline`: what happened, when, and how big it was to the author (`big`, `medium`, or `small`)
- `facts`, `events`, `summaries`, `retrieval`, `chat`: the answer key, described below
- `openers`, `conversations`: tests where the person sends a message. They arrive in later changes. The schema accepts them now, and no person has one yet.

### The answer key

The answer key holds only the grading references:

- `facts`: claims that should be true after the last entry, each with a `subject` and a `reference`. An optional `stale` value is the earlier wording that a current-state query should rank below, not a claim that the old fact was deleted.
- `events`: dated things that happened, each with a `reference` and the `entry` it came from. The eval checks that search returns the event and that its `sourceId` is that entry’s journal id.
- `summaries`: a `reference` summary for one `entry`
- `retrieval`: a `query` and the entry it should rank first, in `expectEntry`. Add a pair of similar entries when you want to check that search can tell them apart. An optional `when`, such as `June`, limits the search to that time, read as of `SAGE_TODAY`. Pair it with similar entries on different dates to check that the date picks the right one.
- `chat`: a `question` and the `reference` answer it should be grounded in. Set `expectTool: true` only when the question is about entry content, because current-state questions may be answered from recalled facts with no tool call. Set `expectWhen: true` when the question names a time, to check that the agent passed it to `search_journal` as `when`.

Every `entry`, `expectEntry`, and `needs` takes a stem or a 1-based number. Use the stem. A number moves when you add an earlier entry.

Write each reference as one short claim, the way Dream’s extractor writes a fact or an event. Facts about the author use `subject: user`, which matches profile facts. [Eval suite](../../../docs/agent/evals.md) explains what each eval checks.

### The fact sheet

`cast` and `timeline` say what is true. The judge reads them to tell a right answer from a wrong one.

- `cast` lists everyone who matters: `name`, `relation` to the author, `pronouns`, and whether they are `alive`. Use `note` for anything a reader could get wrong, such as `'Lost Mia' means the friendship ended`.
- `timeline` lists the events that shaped the journal, each with a `date`, what happened, and a `weight`.

Leave the author’s own gender and family shape out unless the entries state them.

## Empty journals

A folder with only `case.yaml` is an empty journal. `new-user` is one. The loader marks it `empty`, and a ref to an entry fails there because no entry exists.

## Checking a person

`validatePerson(person, today)` in [dataset.ts](../lib/dataset.ts) returns a list of problems, one line each. An empty list means the person is sound. It reports:

- an entry dated after `today`
- an `entry`, `expectEntry`, or `needs` ref that matches no entry
- a `retrieval` item whose `when` phrase, read as of `today`, does not cover the expected entry

The `when` phrase is read by the same code that `search_journal` uses. `chat` items only set `expectWhen`, so they have no phrase to check.

`npm --prefix agent run test:evals` runs it on every person with `today` set to `2026-11-15`.

## Seeding a person by hand

`make seed-dev SEED=agent/evals/data/people/sam-example` resets the dev app and fills its journal with that person’s entries. Only the top-level `*.md` files count. It moves the dates so the newest is in the last 7 days, and it does not run Dream. It refuses a person with no entries. [Scripts](../../../scripts/README.md#seeding-the-dev-app) has the steps.

## The people

- `sam-example`: the format template, tagged `example`. It holds the April and May running pair of look-alike entries and both stale facts.
- `new-user`: a first-time user with an empty journal
- `grief`: grief after a loss and losing a pet, with the Biscuit stale fact
- `family`: a parent, a breakup and reconciliation, and imposter syndrome, with the Dad and Theo stale facts
- `work`: career burnout and a milestone birthday, with the `June` `when` check. The birthday is the newest entry.
- `engaged`: getting engaged, a Portugal trip, and financial stress. It holds the June and August Portugal pair and the money stale fact.
