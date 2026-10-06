# First-launch setup

This page explains when Sage shows setup, what each screen does, which rows it saves, how a restart picks setup up again, and when Sage reminds you to protect your journal. The screens are in `frontend/src/components/setup/`, the rows and their checks are `src/onboarding.zig`, and the decisions that pick a screen are `frontend/src/lib/onboarding.ts`.

Setup fills the whole window, with no sidebar. It helps you install Ollama and download the models Sage needs, turn on a lock and encryption, and import entries you already have. Every step can be skipped.

## When setup shows

Sage reads the `onboarding.state` row once per launch, after any unlock:

1. If the row is `done` or `skipped`, Sage opens Home.
2. If the row is `active`, setup was left half done, so it opens at the saved step.
3. If the row is missing and the journal has an entry or a chat, Sage writes `done` and opens Home. This keeps existing users out of setup.
4. If the row is missing and the journal has neither, Sage shows setup and writes `active`.

A new journal is empty. Earlier versions put three sample entries in every new journal, which would have made rule 4 impossible. Migration 17 deletes the samples that nobody edited, with their embeddings, summaries, memories, and Dream state. It finds them by id and by the epoch `updated_at` that migration 4 gave them, so it works on encrypted journals too. An entry you edited stays.

The core makes the decision in `onboarding.status`. If the row cannot be read, Sage opens Home instead of trapping you outside it.

## The steps

The header on every screen except All set shows the Sage logo, “Step N of 3” when there is a step number, and **Skip setup**. Skip setup writes `onboarding.state = skipped` and opens Home. Model downloads that already started keep running.

### Welcome

Welcome explains Write, Chat, and Dream, and has **Get started**. It has no step number.

### Step 1: Local AI

The screen depends on `ollama.setupStatus`, which returns `{ installed, running, embedModel, summaryModel }`:

- `running` means `/api/tags` answers.
- `installed` means Sage finds the Ollama app through LaunchServices by its bundle id, finds `/Applications/Ollama.app`, or finds an `ollama` file in the usual command line folders. A packaged app has no shell `PATH`, so Sage checks those folders directly. The check never launches anything.
- The two names are the models Sage looks for: `nomic-embed-text` or `SAGE_EMBED_MODEL`, and `qwen3.5:9b` or `SAGE_SUMMARY_MODEL`.

Then Sage picks a screen:

- **Ollama is running**: the downloads screen. If Ollama already has both models, Sage skips the step and goes to Protect. Back from Protect then skips it too.
- **Installed but not running**: Sage calls `ollama.start`. If it works, the downloads screen shows. If it fails, the “not running” screen shows the reason and a **Start Ollama** button.
- **Not installed**: the Install Ollama screen has a **Download Ollama** button that opens `https://ollama.com/download` in your browser. Sage checks every 4 seconds and moves on by itself. When Ollama becomes installed but not running, Sage calls `ollama.start` once.

The “not running” and Install screens have **Skip this step**, which goes to Protect. Chat and Dream do not work until you finish in Settings > Models.

### The downloads screen

The screen shows the chip and memory from `system.hardware` and one row per model. A row shows Ready, a progress bar with Cancel, Waiting, or the reason a download failed with a **Download** button to try again. Sage skips a model Ollama already has.

Downloads follow the rules in [Models](models.md#downloading-and-deleting): one at a time, through `ollama.pull`, `ollama.pulls`, and `ollama.pullCancel`. Setup downloads the embedding model first.

The queue lives in `ModelDownloadsProvider`, above both setup and Home, so downloads keep going after setup ends or is skipped. The provider saves the queued names in `onboarding.downloads`:

- A restart, a refresh, or an unlock picks the queue up again until each model is ready or you cancel it.
- The provider starts a model only while Ollama runs. With Ollama closed, the queue waits and looks again every 4 seconds.
- A cancelled or failed model leaves the queue, and the queue moves on. **Continue** stays on.

Settings > Models uses the same provider, so a download started there and one started here never collide.

### Step 2: Protect your journal

Protect offers a lock and encryption. **Touch ID** is picked by default and **Encrypt my journal** is on by default. A Mac without a fingerprint sensor hides the Touch ID choice and picks Password. **Set up later** goes to Import.

If the lock is already on, Sage skips the choice and offers only encryption. If the lock and encryption are both on, or you chose a lock and no encryption earlier, Sage skips the step.

Protect only calls the commands Settings > Security uses: `lock.setTouchId`, `lock.setPassword`, `lock.setIdleTimeout`, `encryption.newRecoveryKey`, `encryption.enable`, and `encryption.saveRecoveryKey`. It sets no password, wraps no key, and writes no Keychain item itself.

| Choice | What happens |
| --- | --- |
| Touch ID, no encryption | **Use Touch ID** turns Touch ID on. Import is next. |
| Touch ID with encryption | **Use Touch ID** turns it on, then asks for a recovery key. The key request owes a fresh Touch ID prompt, so macOS asks once. |
| Password, no encryption | Sage sets the password. Import is next. |
| Password with encryption | Sage sets the password, then asks for a recovery key with it. |

Both lock screens have **Lock Sage after I'm away for**. It uses the idle times Settings offers, 5 minutes by default, and saves through `lock.setIdleTimeout`.

With encryption on, two more screens follow:

- **Save your recovery key** shows the key once, in groups, with **Copy key**. Only the core generates the key, and the screen only shows it. Sage clears the clipboard when you continue.
- **Type your recovery key** checks what you typed against the key the core made. Capital letters, dashes, and spaces do not matter. A key that does not match shows an error and stays on the screen.

Encryption turns on only at the second screen, after you type the key back. With Touch ID, `encryption.enable` gets the recovery key. With a password, it gets the password, and `encryption.saveRecoveryKey` then stores the key. Leaving earlier never leaves an encrypted journal with no recovery key. If encryption has to rewrite rows or rebuild the file, the existing “Securing your journal” screen shows until it finishes.

### Step 3: Import

A banner names what is on, such as “Lock and encryption are on.” It is hidden when nothing is. **Choose files…** opens the picker through `journal.importDialog`, reads files through `journal.readFile`, and shows the same preview as File > Import, as [The journal](journal.md#importing-markdown) explains. **Skip** and a finished import both go to All set.

### All set

All set writes `onboarding.state = done`. Its rows show the real state: whether the lock and encryption are on, and each model as ready or as a live progress bar. A tip names the idle time you chose. **Write your first entry** opens a new entry in the editor, and **Go to Home** opens Home.

## Testing setup

To see setup as a new user does, quit the dev app and run `make reset-dev`, then `make dev`. The script deletes the dev journal, its Keychain item, and the web view’s local storage, and leaves the packaged app and Ollama alone. [Scripts](../scripts/README.md#resetting-the-dev-app) lists every path it deletes.

Ollama keeps its models, so if Ollama is running and has both, the Local AI step goes straight to Protect.

## Resuming setup

Sage saves the screen you are on in `onboarding.step`, and your Protect choices in `onboarding.method` and `onboarding.encrypt`. A refresh, a restart, or a lock opens setup at that step again.

Sage never saves a recovery key, a password, or the sub-screen you were on. After a lock or a refresh on the key screens, Sage works out the screen from the real lock state, asks for your password or a fresh Touch ID prompt again, and makes a new key. The old key is gone. If the lock is on and encryption is off, that is the encryption screen.

## The rows

All rows live in `app_setting`, so setup adds no table and no migration. Only the core writes them. The page asks through bridge commands, and the core checks each value.

| Row | Value |
| --- | --- |
| `onboarding.state` | `active`, `done`, or `skipped`. `active` moves to `done` or `skipped` once, and neither goes back |
| `onboarding.step` | `welcome`, `local_ai`, `protect`, `import`, or `all_set` |
| `onboarding.method` | `touch_id` or `password` |
| `onboarding.encrypt` | `true` or `false` |
| `onboarding.downloads` | A JSON list of up to 8 model names still to download |
| `onboarding.reminders_shown` | A number from 0 to 3 |
| `onboarding.reminder_last_at` | When the last reminder showed, in milliseconds since the epoch |
| `onboarding.reminders_off` | `true` after **Don't ask again** |

The core also keeps two flags in memory, so a window refresh cannot reset them: whether setup ended in this launch, and whether a reminder already showed.

## Reminders

If encryption is still off after setup, Sage reminds you up to 3 times on later launches. `reminderDue` in `frontend/src/lib/onboarding.ts` is the schedule, and `ProtectReminder` shows the dialog.

A reminder shows only when all of these are true:

- `onboarding.state` is `done` or `skipped`
- Encryption is off
- `onboarding.reminders_off` is not set, and fewer than 3 reminders have shown
- This is not the launch that ran setup, and no reminder has shown in this launch
- Enough time has passed: any later launch for the 1st, at least 3 days after the 1st for the 2nd, and at least 7 days after the 2nd for the 3rd

If the last reminder's time is in the future, the clock moved back, and Sage counts that as enough time.

The dialog shows on Home after Home loads, and never over the editor or Chat. Sage calls `onboarding.reminderShown` when the dialog appears, so quitting with it open still counts. The core refuses a second call in the same launch and a fourth call ever.

- **1st and 2nd reminder**: “Protect your journal”, with **Not now**, **Set up now**, and a line that says how many more times Sage will ask
- **3rd reminder**: “Last reminder: protect your journal”, with **Don't ask again** and **Set up now**. **Don't ask again** calls `onboarding.remindersOff`

**Set up now** opens the Protect screens on their own, with Cancel in the header and no step count. It leaves the setup rows alone. If a lock already exists, Sage skips the unlock choice, asks for your password or a fresh Touch ID prompt, and goes straight to encryption. Finishing returns to Home.

## Bridge commands

While Sage is locked, every command below answers “Sage is locked.”

- `onboarding.status`: the rows above, plus the two launch flags. Settles an existing user to `done`
- `onboarding.save`: a partial update of `state`, `step`, `method`, `encrypt`, and `downloads`. The core refuses a bad value and writes nothing
- `onboarding.reminderShown`: counts a reminder and saves the time
- `onboarding.remindersOff`: stops reminders
- `ollama.setupStatus`: whether Ollama is installed and running, and the two model names
