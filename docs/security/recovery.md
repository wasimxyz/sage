# Recovery

This page lists what can go wrong with the lock and encryption, what you see in each case, and how to get back in. Read it before you rely on encryption with real entries.

## The recovery key

A recovery key is 24 letters and numbers that Sage generates and shows once. You can make one in Settings > Security. You must make one to encrypt with Touch ID alone, or to remove your password from an encrypted journal.

Save it somewhere safe, such as a password manager or a sheet of paper. Sage asks you to type it back before it counts.

The key opens a second wrapped copy of the data key, as [Encryption at rest](encryption.md#the-key-slots) explains. **Make a new recovery key** replaces it, and the old one stops working. Sage does not store the key itself, so it cannot show it to you again.

## You forget your password

With a recovery key, choose **Use recovery key** on the lock screen. Sage unlocks, then asks you to make a new recovery key, since the one you typed is no longer secret. In that session you can set a new password without the old one.

Without a recovery key, your entries cannot be recovered. The data key is wrapped with a key made from your password, and Sage has no other copy. Settings warns about this when you turn encryption on, and offers to make a recovery key afterward.

## You lose the recovery key

If your password or Touch ID still works, unlock and choose **Make a new recovery key**. Do this as soon as you notice the key is lost.

If you have no password, or forgot it, and Touch ID cannot read the Keychain copy, the journal cannot be opened.

## The stored key material is damaged

If the `enc.kdf` or `enc.wrapped_key` rows are damaged, your correct password still passes the password check, but opening the data key fails. Sage stays locked.

The recovery key is stored in separate rows, so **Use recovery key** may still open the journal. If both slots are damaged, the only fix is editing the database file by hand. Sage has no reset flow for this case: [wasimxyz/sage#55](https://github.com/wasimxyz/sage/issues/55) proposed one and was closed as not planned.

## Touch ID cannot read the key

If the Keychain copy is missing or unreadable, Touch ID unlock answers “Could not read the journal key. Use your password.” Your password still unlocks everything. Turning Touch ID off and on again stores a fresh copy.

With no password set, the answer is “Could not read the journal key. Use your recovery key.” A new Mac set up without your old Keychain ends up here too. Choose **Use recovery key**, and Sage puts the data key back in the Keychain and asks you to make a new recovery key.

If Sage cannot store that copy, the journal still opens and Sage warns you. Touch ID will not work next time, so unlock with the recovery key again to retry.

## Sage quits before you save the new recovery key

Sage sets `enc.recovery_rotate` when you unlock with the recovery key. If you quit before you save a new one, the old key still works. Sage asks again on each unlock until you save a new key.

## You open the journal in an older Sage

A journal encrypted with Touch ID alone has only a recovery slot. Versions of Sage from before recovery keys look for the password slot, find none, and treat the journal as unencrypted. They show ciphertext as text and save new entries unencrypted.

Open an encrypted journal only in this version or newer. If it already happened, quit the older version, open the journal here, and check your latest entries.

## Sage quits while turning encryption on

Sage sets `enc.rewrite_pending` before it walks the rows. If it quits during that walk, some fields may be encrypted and others still plaintext, and reads handle that mix. The next launch waits for unlock, encrypts the rest, and rebuilds the file, so you do not need to turn encryption on again.

## Sage quits while turning encryption off

Sage sets `enc.disable_pending` and `enc.rewrite_pending` before it decrypts rows. After the next unlock, Sage finishes decrypting and removes the setup rows.

A field that looks like ciphertext but fails its authentication tag keeps encryption on and keeps the key. Sage reports the failure without throwing the key away.

## Encryption is on but a field is plaintext

At launch, with encryption on and no disable pending, Sage scans the protected fields. If it finds plaintext, or an older vault has not finished its ciphertext check, Sage sets `enc.rewrite_pending`.

After unlock, the rewrite checks each prefixed field and encrypts any plaintext, even plaintext that starts with `sage:v1:`. Journal commands, export, and Chat wait until the rewrite and the file rebuild finish.

## Old plaintext in the file

Overwriting a row does not erase its old bytes by itself, so Sage rebuilds the file after each rewrite. If that rebuild is unfinished, the next launch retries it. [Encryption at rest](encryption.md#scrubbing-old-bytes) explains the rebuild and the copies Sage cannot reach.
