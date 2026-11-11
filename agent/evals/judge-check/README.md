# Judge check

The judge check proves that the judge catches what it should before a sweep spends hours on local generation. It holds a small set of items with the verdicts we expect. The judge grades each item. The check passes only when every verdict matches its label.

A miss or a false alarm fails the check:

- A **miss** is a planted failure the judge lets through.
- A **false alarm** is a clean item the judge flags.

The runner runs the check first in every sweep and stops the sweep on a failure. It costs well under $1.

## Dream items

The Dream half lives in `dream/*.yaml`. Each item is a journal entry, what Dream wrote from it, and the verdicts we expect.

- `planted.yaml`: Dream output written to fail one check each
- `clean.yaml`: tricky entries that a good summary handles

Each file holds a list under `items`:

```yaml
items:
  - id: lost-mia-death            # lowercase, dashes, unique across files
    why: "Turns 'Lost Mia' into a death."   # one line: what is planted, or what is tricky
    truth:                        # optional: facts the judge gets as the fact sheet
      - "Mia is alive. 'Lost Mia' means the friendship ended."
    source:                       # the entry Dream saw
      date: 2026-09-03
      title: Lost Mia
      body: |-
        Lost Mia today. ...
    written:                      # what Dream wrote; give at least one
      summary: "..."
      profile: ["..."]
      facts:
        - { subject: Mia, fact: "..." }
      events:
        - { date: 2026-09-03, event: "..." }   # date is optional
    expect:
      severe: true                # a severe unsupported claim is there
      other: false                # another unsupported claim is there
```

`expect` holds the label. `severe` means death, suicide, self-harm, abuse, or violence that the entry does not support. `other` means any other unsupported claim.

The judge must reach the same two answers. Write each planted item with one wrong claim, so the labels are clear. Leave `other` as `false` when the only wrong claim is severe. A clean item has both set to `false`.

`lib/judge-check.ts` parses these files and rejects unknown keys.

## How an item is graded

The judge sees the item the way it sees a real Dream source: the entry, then everything Dream wrote from it, with the `truth` lines as the fact sheet. It returns each unsupported claim with a severity.

The check records `hard:judge-check` for each item. It passes when:

- the judge found a severe claim exactly when `severe` is `true`, and
- the judge found another claim exactly when `other` is `true`.

A claim the judge calls severe does not count as `other`.

If the judge cannot answer, the item is recorded as not graded. The runner reads that as a judge it could not check, and stops.

## Adding an item

1. Write the entry. Keep it short and make it tricky on purpose.
2. Write what Dream might write. For a planted failure, change one thing.
3. Set `expect`, and write the `why` line.
4. Run the judge check on its own. Every item must pass.
