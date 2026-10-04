# The app lock

This page explains how the optional lock works: where the password lives, how Touch ID fits in, when Sage locks by itself, and what Sage refuses while locked. The code is `src/lock.zig` and `src/session_lock.zig`.

The lock is off by default. Settings > Security shows “Lock is on” or “Lock is off”, depending on whether a password or Touch ID is set. Once the lock is on, Sage asks for your password or Touch ID at every launch, and once Touch ID is on, the password is optional.

With encryption off, the lock only keeps people out of the running app. Anyone with a copy of `app.db` can still read it, as [Encryption at rest](encryption.md) explains.

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

- The Mac sleeps, the display sleeps, or the screen saver starts.
- You choose **Sage > Lock**. If the lock is off, Sage asks you to turn it on in Settings > Security.
- You stop using Sage for the idle time set in Settings > Security: Never, 1, 5, 15, or 30 minutes. The default is 5 minutes.

Idle time counts from the last keyboard, mouse, scroll, or gesture input Sage receives. Time spent in another app counts as idle.

## Touch ID

Touch ID uses Apple’s LocalAuthentication framework, the same system prompt other Mac apps use. The `lock.touch_id` row in `app_setting` records whether you turned it on. With encryption on, Touch ID also needs the data key, which lives in the Keychain, as [The Touch ID Keychain mirror](keychain.md) explains.

Turning Touch ID off weakens the lock, so it needs proof. With a password set, the proof is the password. With Touch ID as the only way in, it is a fresh system prompt that names the action, separate from the unlock you finished.

A wrong password or a cancelled prompt changes nothing. The check runs in the Zig handlers in `src/main.zig`, so Settings is not the only gate. Setting a first password on an encrypted journal that has none also needs a fresh prompt, because it adds a way to open the file without the Keychain.

## What a locked Sage refuses

While locked, these commands answer “Sage is locked.” and return nothing:

- Every journal, embeddings, Dream, and memory command
- Every Ollama command, the hardware info, and the Chat agent status
- The Chat token command, `chat.agentToken`
- Changing the password, turning the lock off, turning Touch ID on or off, and turning encryption on or off

While encryption is on, you cannot turn the lock off or remove the last way to unlock. Encryption needs a password or Touch ID to open the data key, so clearing both would strand your entries. Settings explains this when you click Turn off, and the backend refuses with `EncryptionEnabled` or `LastUnlockMethod`.

## Chat and the lock

A packaged Sage does not start its Chat server while the lock is on, with or without encryption. The lock screen never loads Chat, and unlocking with the password or Touch ID starts the server. With encryption on, unlocking is also when the world key reaches the server, as [The eve app](../agent/eve-app.md#how-chat-starts-in-a-packaged-app) explains.

A session lock stops packaged Chat and clears the world key from the Node.js process, and unlocking starts Chat again. In `make dev`, Sage cannot stop the separate `eve dev` process, but Sage’s agent server refuses its requests while locked.
