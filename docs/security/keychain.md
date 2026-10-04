# The Touch ID Keychain mirror

This page explains how Touch ID opens the journal’s data key without your password. Sage keeps a copy of the key in the macOS Keychain and asks for Touch ID before it reads it. What protects that copy today depends on how Sage is signed, and the code is `src/keychain.zig`.

## Why the mirror exists

Password unlock derives the wrapping key from what you type, and Touch ID has no password to derive from. So Sage stores a copy of the 32-byte data key in the Keychain when you turn on Touch ID with encryption on, or turn on encryption with Touch ID on.

With no password at all, this copy is the only everyday way in. The recovery key is the backup, as [Recovery](recovery.md) explains.

## The Keychain item

The item is a generic password. Its service is Sage’s app id (`com.wasimxyz.sage`, or `com.wasimxyz.sage-dev` in development), and its account is `journal-data-key`. Sage first tries to create it with two settings:

- **User presence**: macOS itself asks for Touch ID or your Mac login password before it releases the key.
- **This device only**: the item never syncs to other devices and cannot be read while the Mac is locked.

The read reuses the Touch ID prompt you answered. Sage passes that prompt’s context with the Keychain request, so macOS does not ask twice.

## Unsigned builds

macOS refuses access-controlled Keychain items from ad hoc signed builds, and both development and packaged builds are ad hoc signed. When that happens, Sage falls back to a plain item in the file-based login keychain. That item has weaker guarantees:

- **No Touch ID check from macOS**: the item has no user-presence setting, so Sage’s own Touch ID prompt is the only Touch ID check.
- **Not tied to this device**: the file-based keychain accepts the this-device-only setting but does not store it, and on macOS 26 the item reads back without it.

Apple’s Technical Note TN3137 describes a file-based keychain as a file you can copy to another Mac and unlock with its password. On macOS 26.4 and later, that can also need a protected entropy file.

The login keychain is encrypted with your Mac login password, and a copy of `app.db` alone still holds no readable entries. Someone who has both your Mac login password and the login keychain file can read the data key. The stronger setup turns on by itself once Sage ships signed with a developer identity.

FileVault matters here too. With encryption on, Touch ID on, no password, and FileVault off, Settings > Security warns that your Mac password is the only thing protecting the journal key.

## When the key is stored and deleted

- **Stored** when you turn on Touch ID with encryption on, or turn on encryption with Touch ID on
- **Stored again** after an unlock with the recovery key, and before the password is removed. If the write fails after a recovery unlock, the journal still opens, and Sage warns that Touch ID will not work next time.
- **Deleted** when you turn off Touch ID or turn off encryption
- **Left alone** when you change your password, because the data key does not change

If the read fails, Touch ID unlock answers “Could not read the journal key. Use your password.” With no password set, it answers “Could not read the journal key. Use your recovery key.” Turning Touch ID off and on again stores a fresh copy.

## How the code talks to the Keychain

The Native SDK has no Keychain API, so `src/keychain.zig` calls Security.framework directly. It loads the framework at runtime and calls it through the Objective-C runtime in `src/objc.zig`. The web view cannot reach any of this, and only the bridge handlers in `src/main.zig` call it.
