# The app lock

This page explains how the optional lock works: where the password lives, how Touch ID fits in, when Sage locks by itself, and what Sage refuses while locked. The code is `src/lock.zig` and `src/session_lock.zig`.

The lock is off by default. Settings > Security shows “Lock is on” or “Lock is off”, depending on whether a password or Touch ID is set. Once the lock is on, Sage asks for your password or Touch ID at every launch, and once Touch ID is on, the password is optional.

With encryption off, the lock only keeps people out of the running app. Anyone with a copy of `app.db` can still read it, as [Encryption at rest](encryption.md) explains. If you skip setup and encryption stays off, Sage reminds you up to 3 times on later launches, as [First-launch setup](../onboarding.md#reminders) explains.

## The password hash

Sage never stores your password. It stores an Argon2id hash in the `app_setting` table under `lock.password_hash`. Argon2id is slow on purpose, so guessing passwords is expensive, and the stored string carries its own salt and settings.

The hash only checks a typed password. It never encrypts anything, and [Encryption at rest](encryption.md#why-the-lock-hash-does-not-wrap-the-key) explains why that matters.

Passwords must be at least 8 characters. The password also protects the journal key, so a four-digit PIN would leave a copied `app.db` open to a short offline guess. An older password shorter than 8 characters still unlocks, and only setting a new short one is refused.

Changing the password needs the current one, so a person at your unlocked Mac cannot change it to lock you out.

## Wrong guesses

The first five wrong guesses get an answer straight away. From the sixth on, each guess waits five seconds, and a guess during that wait is refused without checking it. The wait stays at five seconds, so a person who mistypes their own password can try again soon.

The count and the wait live in `app_setting`, so quitting Sage does not clear them. On the next launch, a stored wait longer than five seconds is cut to five, so a clock that moved backwards cannot stretch it. The lock screen reads the time left from the status, so reloading the window keeps Unlock off for the seconds that remain.

A correct password, a right recovery key, or a completed Touch ID prompt resets the count. The recovery key shares this count and this wait, so switching between the password and the recovery key gives no extra tries. Text that is not shaped like a recovery key counts as a typo, not a guess.

## Removing the password

With Touch ID on, **Remove password** in Settings > Security leaves Touch ID as the only way in. It needs your current password, and Sage refuses it when Touch ID is off, because no way in would be left. Sage deletes the password hash and keeps the Touch ID flag.

With encryption on, Sage first makes a new recovery key, as [Encryption at rest](encryption.md#removing-your-password) explains. Right after an unlock with the recovery key, Sage does not ask for the current password, as [Encryption at rest](encryption.md#unlocking-with-the-recovery-key) explains.

## When Sage locks

Whether Sage is unlocked lives only in memory, so quitting Sage always locks it.

A running Sage also locks when any of these happen:

- The Mac sleeps, the display sleeps, or the screen saver starts. With the lock off, these still stop dictation.
- You choose **Sage > Lock**. If the lock is off, Sage asks you to turn it on in Settings > Security.
- You stop using Sage for the idle time set in Settings > Security: Never, 1, 5, 15, or 30 minutes. The default is 5 minutes.

Idle time counts from the last keyboard, mouse, scroll, or gesture input Sage receives. Time spent in another app counts as idle. Idle time does not run while the microphone is on, as [Dictation and the lock](#dictation-and-the-lock) explains.

## Touch ID

Touch ID uses Apple’s LocalAuthentication framework, the same system prompt other Mac apps use. `lock.status` reports two things: `touchIdBiometrics` is true when Touch ID works right now, and `touchIdHardware` is true when the Mac has a sensor with a finger enrolled, even if macOS can’t use it at the moment, as with a closed lid over an external display. The prompt falls back to the Mac login password in that case, so a Touch ID lock still opens. The `lock.touch_id` row in `app_setting` records whether you turned it on. With encryption on, Touch ID also needs the data key, which lives in the Keychain, as [The Touch ID Keychain mirror](keychain.md) explains.

Turning Touch ID off weakens the lock, so it needs proof. With a password set, the proof is the password. With Touch ID as the only way in, it is a fresh system prompt that names the action, separate from the unlock you finished.

A wrong password or a cancelled prompt changes nothing. The check runs in the Zig handlers in `src/main.zig`, so Settings is not the only gate. Setting a first password on an encrypted journal that has none also needs a fresh prompt, because it adds a way to open the file without the Keychain.

## What a locked Sage refuses

While locked, these commands answer “Sage is locked.” and return nothing:

- Every journal, embeddings, Dream, and memory command, including `journal.tidy`
- Every dictation command except `dictation.stop`, which always answers
- Every Ollama command, the hardware info, the first day of the week, and the Chat agent status
- The Chat token command, `chat.agentToken`
- Changing the password, turning the lock off, turning Touch ID on or off, and turning encryption on or off

While encryption is on, you cannot turn the lock off or remove the last way to unlock. Encryption needs a password or Touch ID to open the data key, so clearing both would strand your entries. Settings explains this when you click Turn off, and the backend refuses with `EncryptionEnabled` or `LastUnlockMethod`.

## Local AI and the lock

Sage starts its Ollama server at launch, before you unlock, and the lock does not stop it. The server listens on `127.0.0.1` only, so other computers cannot reach it. Any program on this Mac can reach it while Sage runs, because the server does not check the lock. The Ollama commands in Sage still refuse while the lock is on, as the list above says.

When the lock turns on, Sage stops a running Dream and asks the server to unload every model it has loaded, so no model keeps the last prompt in memory. A Dream or search request that was already running finishes and then unloads its model. Unlocking clears this, so the next request loads its model as usual. A download keeps running while the lock is on.

A Tidy request that finishes after the lock turns on answers “Sage is locked.” and Sage drops the cleaned text.

Sage restarts a crashed server from its status checks, and those checks run only while Sage is unlocked. A server that crashes while the lock is on stays down until you unlock.

## Chat and the lock

A packaged Sage does not start its Chat server while the lock is on, with or without encryption. The lock screen never loads Chat, and unlocking with the password or Touch ID starts the server. With encryption on, unlocking is also when the world key reaches the server, as [The eve app](../agent/eve-app.md#how-chat-starts-in-a-packaged-app) explains.

A session lock stops packaged Chat and clears the world key from the Node.js process, and unlocking starts Chat again. In `make dev`, Sage cannot stop the separate `eve dev` process, but Sage’s agent server refuses its requests while locked.

## Dictation and the lock

Dictation ends whenever Sage locks, with the reason `locked`. That covers the lock turning on, the idle lock, **Sage > Lock**, the Mac or display sleeping, and the screen saver starting. Sleep, the display, and the screen saver end it even when the lock is off, because they run the same code. **Sage > Lock** with the lock off ends dictation first and then asks you to turn the lock on. The core sends `dictation:stopped` before `lock:changed`, drops any words it had not sent, and sends no dictation events while Sage is locked. `dictation.stop` still answers while locked, so a stop that arrives late does no harm.

The idle clock waits while the microphone is really on. That starts when capture starts, not when you press the mic. The first time you dictate, macOS shows a permission prompt and waits for an answer, perhaps forever. Until you answer it, Sage can still idle-lock, and the lock then ends the session. The idle check runs every 15 seconds, and each pass while the mic is on counts as activity. When the session ends, the full idle time counts again from that moment.

Display sleep locks Sage too, and speaking is not input, so it would cut off a long entry mid-sentence. While the mic is on, Sage also asks macOS not to sleep the display from idleness, with a power assertion named “Sage is dictating” (`src/display_awake.zig`). Sage lets go of it when the session ends, when Sage locks, and when Sage quits. A closing lid, a real system sleep, and the screen saver are not stopped by it, so they still lock Sage and stop dictation.

This has a cost. A mic left on keeps Sage unlocked and writing whatever it hears into the entry or the message box, and it keeps the display awake. If you start dictating and walk away, neither the idle lock nor the display sleep fires. Sleep with the lid closed and the screen saver follow your Mac’s own settings, and they still lock Sage and stop dictation. Press ⌘D or Esc before you leave your desk.
