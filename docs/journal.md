# The journal

This page explains how entries are written, saved, imported, exported, and searched, and what the Home screen shows. The screen code is `frontend/src/components/editor.tsx` and `frontend/src/components/journal-provider.tsx`. Storage is the journal section of `src/journal.zig`.

## What an entry holds

Each entry is one row in `journal_entry`:

- `entry_date`: the calendar date of the entry, as `YYYY-MM-DD`
- `title` and `body`: the text you wrote, encrypted when encryption is on
- `body_format`: `markdown` for entries the editor saves, or `plain` for older entries
- `word_count`: the length of the body, readable even with encryption on
- `updated_at`: when the entry last changed, which tells embeddings and Dream the entry needs work

## Writing and saving

The editor is TipTap with Markdown support. Sage saves one second after you stop typing, through `journal.save`, and stores the body as Markdown. Older `plain` entries open as plain text.

A body over 1 MiB is refused. Long bodies travel to the core in 32 KiB chunks, as [Architecture](architecture.md#the-bridge) explains.

After you stop typing for 30 seconds, Sage embeds the entry through `embeddings.generate`. When Sage loads your entries, it also embeds any entry saved since its last embedding. If Ollama is down, Sage tries that pass again every 15 seconds.

Saving also marks the entry for the next [Dream](dream.md), which refreshes its summary.

## Importing Markdown

File > Import opens a file picker through `journal.importDialog`. You can pick several `.md`, `.markdown`, or `.txt` files of up to 1 MiB each. Sage reads only the files you picked, through `journal.readFile`, and shows a preview before it saves anything.

For each file, Sage takes the title and date from the first place that has one:

- **Title**: the `title` in frontmatter, then the first `#` heading, then the file name
- **Date**: the `date` in frontmatter, then a `date:` line in the body, then the date the file was created

After you confirm, Sage saves the entries and embeds them. The Import step of [First-launch setup](onboarding.md#step-3-import) opens the same picker and preview.

## Exporting

File > Export and Settings > Data > Export data write a `sage-export-YYYYMMDD` folder inside a folder you pick. `journal/` holds one Markdown file per entry, and `conversations/` holds the chats, as [Chat storage](agent/storage.md#exporting-conversations) explains. The files are plaintext, even when encryption is on.

The folder picker runs in the core through `journal.exportDialog`, and `journal.export` writes only to the folder it returned. The web view never names the destination, and each export needs a new pick.

## Searching entries

⌘K opens the search dialog. Its Journal tab calls `journal.search`, which matches the query against titles and bodies. Results are newest first and capped at 25.

With encryption on, SQL cannot match text inside ciphertext. Sage decrypts each entry in memory and matches there instead, as [Encryption at rest](security/encryption.md#searching-encrypted-entries) explains.

Chat finds entries a different way: it ranks entry summaries by meaning. [The eve app](agent/eve-app.md#tools) covers that tool.

## The Home screen

Sage opens on Home. Home shows the latest entry, plus entries and conversations from the last 14 days, through `home.feed`. The Continue writing card uses the same date and last-edited line as the editor. Snippets on Home are plain text.

Home and the Chat list reload when Dream finishes.

## Deleting entries

`journal.delete` removes one entry, its embeddings and summary, and every memory Dream wrote from it. Settings > Data can delete every entry at once, as [Chat storage](agent/storage.md#deleting-data) explains.

## Bridge commands

While Sage is locked, every command below answers “Sage is locked.”

- `journal.list`: each entry’s id, date, title, word count, and format, newest first
- `journal.get`: one entry, read in slices
- `journal.save`: creates or updates one entry, sent in chunks
- `journal.delete`: removes one entry
- `journal.search`: text search over titles and bodies
- `journal.importDialog` and `journal.readFile`: pick Markdown files and read them
- `journal.exportDialog` and `journal.export`: pick a folder and write the export
- `home.feed`: the entries and conversations for the Home screen
- `embeddings.status`: whether Ollama is running and the embedding model is pulled
- `embeddings.pending` and `embeddings.generate`: list entries that need embedding, and embed one
