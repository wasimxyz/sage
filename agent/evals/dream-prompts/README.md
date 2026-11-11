# Dream prompts

This folder holds variants of the four prompts Dream sends to the summary model. A sweep compares them with the `dreamPrompts` list in its file.

Each subfolder is one variant. It can hold any of these files:

- `summary.md`: the entry summary prompt
- `chat-summary.md`: the chat summary prompt
- `chat-title.md`: the chat title prompt
- `extract.md`: the prompt that extracts profile sentences, facts, and events

A file that is missing keeps the built-in prompt. `baseline` is not a folder. It means all four built-in prompts.

Only builds made for automation read a variant. The runner points `SAGE_EVAL_DREAM_PROMPTS` at the folder, and Sage reads it once at startup. A packaged build never looks at the variable.

Each variant needs its own Dream run for every person, so `sweeps/dream.yaml` compares them. The resolved prompt text is part of the Dream cache key, so a changed file runs Dream again.
