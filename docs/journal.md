# The journal

This page explains the sidebar and the Journal tab, and how entries are written, saved, imported, exported, and searched. The screen code is `frontend/src/components/editor.tsx` and `frontend/src/components/journal-provider.tsx`. Storage is the journal section of `src/journal.zig`.

The window has two columns: the sidebar and the main pane. The sidebar has two tabs, Chat and Journal. A switch of two icon buttons at the right end of the title bar row, beside the traffic lights and the sidebar button, picks one. Sage opens on the Chat tab, with a new chat.

Each tab has its own rows at the top, then its list under a gray label, newest first. Dream and Settings sit at the bottom on both tabs. Settings swaps the sidebar for its own menu with Back, and the switch hides there. ⌘B hides the whole sidebar. The code is `frontend/src/components/app-sidebar.tsx`, `frontend/src/lib/sidebar-tab.ts`, and `frontend/src/components/list-row.tsx`.

Each tab keeps what was last open in it until Sage locks or quits. Journal comes back to the same entry. Chat comes back to the same chat, or to Memories if Memories was the last screen open in it. [The Chat frontend](agent/frontend.md#the-chat-tab) covers the Chat tab.

## The Journal tab

The Journal tab’s rows are New entry, Search, and Import. Import opens the same picker and preview as File > Import. Under them, a gray Entries label heads the list, which shows each entry’s title and date, as [How dates read](#how-dates-read) explains. Click a row to open the entry in the main pane, and right-click it for Delete. With no entries, the list says “No entries yet.”

Journal always holds an entry. The first visit shows a blank new entry, which saves only once you type in it. New entry and ⌘N start another. Deleting the open entry shows a blank new entry in its place.

The address bar follows the tab. `#/journal` is a new entry, and `#/journal/<id>` is a saved one. A new entry’s first save turns `#/journal` into `#/journal/<id>` without adding a history entry, as a new chat does.

## What an entry holds

Each entry is one row in `journal_entry`:

- `id`: the entry id. Chat tool output, the model’s own history, and memories name entries by it (`entry-12`), so Sage never gives an id to a second entry. `entry_id_counter` holds the highest id given out, and a new entry takes the next one. Deleting an entry, or all of them, does not lower it.
- `entry_date`: the calendar date of the entry, as `YYYY-MM-DD`
- `title` and `body`: the text you wrote, encrypted when encryption is on
- `body_format`: `markdown` for entries the editor saves, or `plain` for older entries
- `word_count`: the length of the body, readable even with encryption on
- `updated_at`: when the entry last changed, which tells embeddings and Dream the entry needs work

## Writing and saving

The editor is TipTap with Markdown support. Sage saves one second after you stop typing, through `journal.save`, and stores the body as Markdown. Older `plain` entries open as plain text.

There is no Underline button, and ⌘U and ⇧⌘U do nothing. Text underlined in an older entry stays underlined, and Sage saves it as `++text++`. Text you type after it is not underlined, and pasted underline is dropped. Plus signs with a space after them, as in `C++ and C++`, stay plain text. The rules live in `frontend/src/lib/legacy-underline.ts`.

Cmd+S saves at once and shows a message that Sage saves your entry automatically.

## Dictating

⌘D, or the mic button in the entry header, turns on dictation. Your words appear in the entry as you speak, grey at first and then as normal text, and Esc or ⌘D stops it. They land at the cursor, or at the end of the body when the title has focus. After you stop, a **Tidy** button cleans up what you just said, and the selection menu has a **Tidy** button for any plain paragraphs you select. Dictated words are saved like typed ones. [Dictation](dictation.md) has the details.

Opening an entry is not an edit. Each entry opens with an empty undo history, so ⌘Z cannot undo the opening or bring back the text of the entry you had open before. A new entry starts the same way, and the title box is read-only while an entry loads. The reset lives in `frontend/src/lib/editor-history.ts`.

If an entry fails to open, Sage shows an error, and the editor still holds the entry you had open. Sage does not save what you type there, because it would land in the wrong entry. It tells you so instead. Open another entry, then this one again.

⌘N starts a new entry in the Journal tab and a new chat in the Chat tab, which holds Chat and Memories. It does nothing in Settings, while a memory is open for editing, or while a dialog, popover, or menu is open. The rules live in `frontend/src/lib/new-shortcut.ts`.

A body over 1 MiB is refused. Long bodies travel to the core in 32 KiB chunks, as [Architecture](architecture.md#the-bridge) explains.

After you stop typing for 30 seconds, Sage embeds the entry through `embeddings.generate`. When Sage loads your entries, it also embeds any entry saved since its last embedding. If Ollama is down, Sage tries that pass again every 15 seconds.

Saving also marks the entry for the next [Dream](dream.md), which refreshes its summary.

## How dates read

The Entries and Conversations lists in the sidebar show recent days as Today, Yesterday, 3 days ago, or 1 week ago. The 1 week ago label covers 7 to 13 days back. An older day shows a short date, such as Nov 8, and adds the year when it is not this year, such as Nov 8, 2025. A day after today shows the same short date. The labels turn over at midnight. `formatSidebarDate` in `frontend/src/lib/format-date.ts` holds the rules.

The editor shows the full date under the title, such as Friday, October 2, 2026, followed by when you last edited the entry. An open chat shows the day it last changed in lighter text next to its title, in the same full form. The code is `frontend/src/lib/format-date.ts`. Memories show the weekday and a short month in their Updated dates, such as Updated Friday, Oct 2, from `frontend/src/lib/format-relative-age.ts`.

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

⌘K, or the Search row in the sidebar, opens the search dialog. From the Journal tab, the dialog opens on its own Journal results, and All is one click away. Those results come from `journal.search`, which matches the query against titles and bodies, newest first and capped at 25. Choosing a hit opens that entry in the Journal tab.

Search runs once you stop typing for 300 ms. The last results stay up until the new ones arrive, so the list does not blank out while you type.

With encryption on, SQL cannot match text inside ciphertext. Sage decrypts each entry in memory and matches there instead, as [Encryption at rest](security/encryption.md#searching-encrypted-entries) explains.

Chat finds entries a different way: it ranks entry summaries by meaning, and it can limit the search to a time such as “last week” or “in March”. [The eve app](agent/eve-app.md#tools) covers that tool.

## Deleting entries

Delete an entry from its row (right-click, or press ⌘⌫ with the row focused) or from the ⋯ menu in the editor. The entry leaves the list at once, and a toast with its title offers Undo for 5 seconds. Undo brings the entry back with the text you had typed. If the entry cannot save, Sage keeps it and says so.

Deleting the open entry shows a blank new entry, and Undo opens the entry again.

Sage deletes the entry when the toast closes. It also tries when you close the window. Until then, search and the list leave it out. Starting Dream or an export finishes the delete first. A locked Sage cannot delete anything, so if it locks or quits during the wait, it saves the delete and runs it after the next unlock. Until then the entry stays in your journal.

`journal.delete` removes one entry, its embeddings and summary, and every memory Dream wrote from it. Settings > Data can delete every entry at once, as [Chat storage](agent/storage.md#deleting-data) explains.

## Bridge commands

While Sage is locked, every command below answers “Sage is locked.”

- `journal.list`: each entry’s id, date, title, word count, and format, newest first
- `journal.get`: one entry, read in slices
- `journal.save`: creates or updates one entry, sent in chunks
- `journal.delete`: removes one entry
- `journal.search`: text search over titles and bodies
- `journal.tidy`: cleans up spoken or selected text with the summary model and answers with the new text, as [Dictation](dictation.md#tidy) explains
- `journal.importDialog` and `journal.readFile`: pick Markdown files and read them
- `journal.exportDialog` and `journal.export`: pick a folder and write the export
- `embeddings.status`: whether Ollama is running and the embedding model is pulled
- `embeddings.pending` and `embeddings.generate`: list entries and chats that need embedding, and embed one entry, or the next messages of one chat with `{ "chatId" }`
