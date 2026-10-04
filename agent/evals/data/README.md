# Eval fixtures

Each case is a folder of Markdown journal entries plus a `case.yaml` answer key.

```text
evals/data/timelines/my-timeline/
├── case.yaml
├── 01-first-day.md
└── 02-later.md
```

Entry files are seeded in filename order. Frontmatter needs `date` (`YYYY-MM-DD`) and `title`, and the body is the journal text.

## The answer key

`case.yaml` holds only the grading references:

- `facts`: claims that should be true after the last entry, each with a `subject` and a `reference`. An optional `stale` value is the earlier wording that a current-state query should rank below, not a claim that the old fact was deleted.
- `events`: dated things that happened, each with a `reference` and the 1-based `entry` it came from. The eval checks that search returns the event and that its `sourceId` is that entry’s journal id.
- `summaries`: a `reference` summary for one `entry`
- `retrieval`: a `query` and the entry it should rank first, in `expectEntry`. Add a pair of similar entries when you want to check that search can tell them apart.
- `chat`: a `question` and the `reference` answer it should be grounded in. Set `expectTool: true` only when the question is about entry content, because current-state questions may be answered from recalled facts with no tool call.

Each key feeds one eval file: `facts` and `events` go to extraction, `summaries` to summaries, `retrieval` to retrieval, and `chat` to chat. [Eval suite](../../../docs/agent/evals.md) explains what each eval checks.

Write each reference as one short claim, the way Dream’s extractor writes a fact or an event. Facts about the author use `subject: user`, which matches profile facts.

## The cases

`evals/data/timelines/sam-example/` is the format template. It is tagged `example`, so you can run it alone with `make eval ARGS='--tag example'`.

The other cases are:

- Timelines: `parent-relationship`, `breakup-reconciliation`, `career-burnout`
- Standalone groups: `grief-after-loss`, `financial-stress`, `getting-engaged`, `losing-a-pet`, `imposter-syndrome`, `milestone-birthday`
- Pairs of similar entries: `running`, `portugal-trip`
