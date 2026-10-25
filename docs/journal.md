# The journal

This page explains how entries are written, saved, imported, exported, and searched, and what the Home screen shows. The screen code is `frontend/src/components/editor.tsx` and `frontend/src/components/journal-provider.tsx`. Storage is the journal section of `src/journal.zig`.

Journal and Chat share one layout: a list on the left, and a panel that opens beside it when you choose a row. The panel can go full screen, and you can drag the divider to resize it. The code is `frontend/src/components/split-view.tsx` and `frontend/src/components/list-row.tsx`. [The Chat frontend](agent/frontend.md#the-chat-panel) covers the Chat side.

## What an entry holds

Each entry is one row in `journal_entry`:

- `entry_date`: the calendar date of the entry, as `YYYY-MM-DD`
- `title` and `body`: the text you wrote, encrypted when encryption is on
- `body_format`: `markdown` for entries the editor saves, or `plain` for older entries
- `word_count`: the length of the body, readable even with encryption on
- `updated_at`: when the entry last changed, which tells embeddings and Dream the entry needs work

## Writing and saving

The editor is TipTap with Markdown support. Sage saves one second after you stop typing, through `journal.save`, and stores the body as Markdown. Older `plain` entries open as plain text.

There is no Underline button, and ⌘U and ⇧⌘U do nothing. Text underlined in an older entry stays underlined, and Sage saves it as `++text++`. Text you type after it is not underlined, and pasted underline is dropped. Plus signs with a space after them, as in `C++ and C++`, stay plain text. The rules live in `frontend/src/lib/legacy-underline.ts`.

Cmd+S saves at once and shows a message that Sage saves your entry automatically.

Opening an entry is not an edit. Each entry opens with an empty undo history, so ⌘Z cannot undo the opening or bring back the text of the entry you had open before. A new entry starts the same way, and the title box is read-only while an entry loads. The reset lives in `frontend/src/lib/editor-history.ts`.

If an entry fails to open, Sage shows an error, and the editor still holds the entry you had open. Sage does not save what you type there, because it would land in the wrong entry. It tells you so instead. Open another entry, then this one again.

⌘N starts a new entry from Home, Journal, or Memories. It starts a chat while Chat is open. It does nothing in Settings, while a memory is open for editing, or while a dialog, popover, or menu is open. The shortcut lives in `frontend/src/hooks/use-new-shortcut.ts`.

A body over 1 MiB is refused. Long bodies travel to the core in 32 KiB chunks, as [Architecture](architecture.md#the-bridge) explains.

After you stop typing for 30 seconds, Sage embeds the entry through `embeddings.generate`. When Sage loads your entries, it also embeds any entry saved since its last embedding. If Ollama is down, Sage tries that pass again every 15 seconds.

Saving also marks the entry for the next [Dream](dream.md), which refreshes its summary.

## How dates read

The entry list and the Chat list show recent days as Today, Yesterday, 3 days ago, or 1 week ago. A day two weeks back or earlier shows its weekday, such as Friday, Oct 2, and adds the year when it is not this year. Relative labels never show a weekday.

The editor shows the full date under the title, such as Friday, October 2, 2026, followed by when you last edited the entry. An open chat shows the day it last changed in lighter text next to its title, in the same full form. Memories use the same weekday in their Updated dates. The code is `frontend/src/lib/format-date.ts`. Home labels its rows its own way, as [The Home screen](#the-home-screen) explains.

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

Search runs once you stop typing for 300 ms. The last results stay up until the new ones arrive, so the list does not blank out while you type.

With encryption on, SQL cannot match text inside ciphertext. Sage decrypts each entry in memory and matches there instead, as [Encryption at rest](security/encryption.md#searching-encrypted-entries) explains.

Chat finds entries a different way: it ranks entry summaries by meaning. [The eve app](agent/eve-app.md#tools) covers that tool.

## The Home screen

Sage opens on Home. Home shows a band of clouds, a row of squares for the month, and your recent entries and chats. The screen code is `frontend/src/components/home-screen.tsx`, and the date logic is `frontend/src/lib/home.ts`.

Home has no command of its own for entries and chats. It reads the lists Sage loads at unlock. When Dream finishes, the chat list reloads, so new chat titles show up on Home.

### The band

The band holds today's date, a greeting, and two buttons: **New entry** and **New chat**. The greeting reads “Good morning.” from 5 AM to noon, “Good afternoon.” from noon to 5 PM, and “Good evening.” the rest of the day.

A line under the greeting reads A month ago today, you wrote “Title.” when you wrote an entry on the same day of last month. A **Reread** link opens it. With several entries on that day, Sage picks the newest. The line uses the saved title alone, and no model writes it. Home hides the line when there is no such entry, and when last month has no such day, as with March 31.

The clouds come from the Sage website. `frontend/src/components/clouds.tsx` draws them on a canvas and lets them drift slowly, at about 12 frames a second. They hold still when Reduce motion is on, and they stop drawing while the window is hidden or the band is scrolled out of view. `frontend/src/index.css` sets the dot colors for light and dark. The lock screen draws the same clouds behind its card.

### The month row

The row has one small square for each day of the month. A day with an entry is filled blue, today has an outline, and days still to come are empty outlines. Choosing a filled day opens its newest entry. Each square has a label, such as “October 19, entry written”. Home shows no streaks, counts, or scores.

### Entries and chats

Entries and chats appear together, newest first, under Today, This week, and Last week. A group with nothing in it is hidden. Each row shows an icon for its type and a title. It never shows text from the entry or the chat. The right side shows the time for Today, the weekday for This week, and a short date such as “Sat, Oct 17” for Last week. A chat belongs to the local day it last changed. Choosing a row, a day square, or Reread opens that entry or chat full screen, and the back arrow returns to the list beside it.

A week starts on the first day of the week in System Settings > General > Language & Region. Sage reads it through `system.calendar`, and the week starts on Sunday if that fails.

With no entries and no chats, the lists give way to “Your entries and chats will show up here.”

## Deleting entries

Delete an entry from its row (right-click, or press ⌘⌫ with the row focused) or from the ⋯ menu in the editor. The entry leaves the list at once, and a toast with its title offers Undo for 5 seconds. Undo brings the entry back with the text you had typed. If the entry cannot save, Sage keeps it and says so.

Sage deletes the entry when the toast closes. It also tries when you close the window. Until then, Home, search, and the list leave it out. Starting Dream or an export finishes the delete first. A locked Sage cannot delete anything, so if it locks or quits during the wait, it saves the delete and runs it after the next unlock. Until then the entry stays in your journal.

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
- `system.calendar`: the first day of the week on this Mac, for Home
- `embeddings.status`: whether Ollama is running and the embedding model is pulled
- `embeddings.pending` and `embeddings.generate`: list entries that need embedding, and embed one
