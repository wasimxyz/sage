# Calibration

This folder holds the replies you grade by hand, and your grades. They show where the judge agrees with you. To run the whole thing, see [Calibrating the judge](../../../docs/agent/evals.md#calibrating-the-judge).

```sh
npm --prefix agent run calibration-sample -- <sweep id>
make eval-viewer-dev
make eval SWEEP=calibration
```

The first command writes `sample-<sweep id>.json` here. The second starts the viewer, where you grade the replies at `/calibration`. The third has the judge grade the same replies and writes the agreement to `agent/evals/reports/<run id>.calibration.json`.

## The sample

`sample-<sweep id>.json` holds `sampleId` (the sweep id) and `items`. Each item is one reply from one setup of the sweep:

```json
{
  "id": "a1a1a1a1a1:engaged/opener/rent-panic:r1:t1",
  "setupId": "a1a1a1a1a1",
  "itemId": "engaged/opener/rent-panic",
  "person": "engaged",
  "kind": "opener",
  "expect": "venting",
  "message": "Checked my bank account four times today.",
  "reply": "That sounds stressful. What is the gap, roughly?",
  "context": {
    "factSheet": "# Fact sheet for engaged ...",
    "priorTurns": [{ "role": "user", "text": "..." }],
    "toolCalls": []
  },
  "checks": ["no-severe-unsupported", "journal-right"],
  "rubric": ["understanding", "warmth"]
}
```

- `id` is the setup, the item, the repeat, and the exchange (`r1:t1`). `turn` and `repeat` are in the item too, and so is `journal` (`own` or `empty`).
- `kind` is `opener`, `chat` (a fact question), or `conversation`. A conversation gives one item for each Sage reply, and `expect` is the kind of message that reply answers, so it is `crisis` from the crisis turn on.
- `context` is what you need to read the reply. `priorTurns` is there only for a conversation, and `toolCalls` holds what Sage searched and found. All of it is optional.
- `checks` and `rubric` list what applies to this reply. They are the ones the code would ask the judge about, so grade those and no others. A rubric item that is N/A (right kind of help on a crisis, say) is not listed.

The same sweep, size, and seed make the same sample.

## Your grades

`grades.jsonl` has one line for each reply you graded:

```json
{"sampleId":"2026-11-10T031500Z-screen","id":"a1a1a1a1a1:engaged/opener/rent-panic:r1:t1","grader":"human","checks":{"no-severe-unsupported":true,"journal-right":false},"rubric":{"understanding":4,"warmth":null},"note":"It got the due date wrong.","gradedAt":"2026-11-16T10:00:00.000Z"}
```

- A check is `true` when the reply passes it, `false` when it fails it, and `null` when it does not apply. This is how the judge's `pass` reads too.
- A rubric item is 1 to 5, or `null`.
- A check or rubric item you did not answer has no key. The comparison leaves it out.
- A later line for the same `sampleId` and `id` replaces an earlier one.
- A line that is not valid JSON, or names a check or rubric item that does not exist, stops the run and names the line.

The viewer writes this file. You can also write a line by hand.

## What the agreement shows

For each rubric item: exact agreement, agreement within one point, quadratic-weighted kappa, and the judge's mean score minus yours. For each check: hits (you and the judge both failed it), misses (you failed it, the judge passed it), and false alarms (you passed it, the judge failed it).

Conversation-wide checks and scores are not in the sample: `drops-after-no`, `stops-feeding-loop`, and the conversation rubric. The sample is one reply at a time.

To try another judge, change `judge.model` in `agent/evals/sweeps/calibration.yaml`, and run the sweep again with the same grades.
