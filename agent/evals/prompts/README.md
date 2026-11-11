# Chat prompts for evals

This folder holds the Chat system prompts that a sweep can compare. A sweep names them in its `prompts` list.

`baseline` is not a file. It means the live `agent/agent/instructions.md`, so every comparison starts from what Sage ships today.

Every other name is a Markdown file here, such as `companion-v1.md`. A file replaces `instructions.md` whole for that sweep, so it must carry the tool and grounding rules itself. Sage still adds today's date, memory guidance, and the author's own instructions at session start, so a prompt file leaves those out.

Nothing here ships. Sage never reads this folder, and `agent/agent/` does not know it exists. To ship a prompt, copy it into `agent/agent/instructions.md` in a reviewed change of its own.

## The prompts

- `companion-v1.md`: a draft that listens first, offers the kind of help that fits, and handles a crisis in general wording. It is written for small local models and waits for your review.
