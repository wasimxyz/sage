const std = @import("std");
const native_sdk = @import("native_sdk");
const journal = @import("journal.zig");

/// Field-level encryption for journal data at rest (#48). A random 32-byte
/// data key encrypts `journal_entry.title`/`body`,
/// `entry_embedding.chunk_text`, `entry_summary.summary`,
/// `chat_conversation.title`, chat embedding/summary text, semantic facts,
/// fact and event origin_text, episodic events, Chat instructions from
/// Settings, and each `chat_event.event` with AES-256-GCM; the data key
/// itself is wrapped by a key derived from the user's password through a
/// second Argon2id run with its own salt.
/// The #47 hash in `lock.password_hash` is verification-only and never
/// wraps anything: it is stored in this same database, so it must not be
/// able to open the data key.
///
/// The data key has up to two wrapped copies, called slots. The password slot
/// is wrapped by a key from the password. The recovery slot is wrapped by a
/// key from a random recovery key that Sage generates and shows once, so a
/// journal can be encrypted with Touch ID alone and still have a way back in
/// when the Keychain copy is lost. A journal needs at least one slot.
///
/// Only the KDF settings and the wrapped keys are stored, in the
/// `app_setting` table. The data key lives here in RAM while unlocked and is
/// zeroed on the way out. Ciphertext is stored as base64 text with a
/// `sage:v1:` prefix so STRICT TEXT columns accept it and plain rows (the
/// seed entries, or rows written before encryption was on) stay readable: a
/// field without the prefix is returned as-is.
pub const field_prefix = "sage:v1:";

/// Associated data per protected field, so a ciphertext cannot be moved to
/// another column and still open.
pub const aad_entry_title = "journal_entry:title";
pub const aad_entry_body = "journal_entry:body";
pub const aad_chunk_text = "entry_embedding:chunk_text";
pub const aad_entry_summary = "entry_summary:summary";
pub const aad_chat_title = "chat_conversation:title";
pub const aad_agent_user = "agent_instruction:user";
const aad_wrapped_key = "app_setting:enc.wrapped_key";
/// A different label from the password slot, so a password wrap pasted into
/// the recovery rows fails to open.
const aad_recovery_wrapped_key = "app_setting:enc.recovery_wrapped_key";

/// Labels for Dream tables. Per-row so a ciphertext cannot be moved.
pub fn aadChatChunk(buf: []u8, conversation_id: i64, chunk_index: i64) []u8 {
    return std.fmt.bufPrint(buf, "chat_embedding:{d}:{d}", .{ conversation_id, chunk_index }) catch unreachable;
}

pub fn aadChatSummary(buf: []u8, conversation_id: i64) []u8 {
    return std.fmt.bufPrint(buf, "chat_summary:{d}", .{conversation_id}) catch unreachable;
}

pub fn aadSemanticSubject(buf: []u8, id: i64) []u8 {
    return std.fmt.bufPrint(buf, "semantic_fact:subject:{d}", .{id}) catch unreachable;
}

pub fn aadSemanticFact(buf: []u8, id: i64) []u8 {
    return std.fmt.bufPrint(buf, "semantic_fact:fact:{d}", .{id}) catch unreachable;
}

pub fn aadSemanticOrigin(buf: []u8, id: i64) []u8 {
    return std.fmt.bufPrint(buf, "semantic_fact:origin:{d}", .{id}) catch unreachable;
}

pub fn aadEpisodicEvent(buf: []u8, id: i64) []u8 {
    return std.fmt.bufPrint(buf, "episodic_event:{d}", .{id}) catch unreachable;
}

pub fn aadEpisodicOrigin(buf: []u8, id: i64) []u8 {
    return std.fmt.bufPrint(buf, "episodic_event:origin:{d}", .{id}) catch unreachable;
}

const enabled_key = "enc.enabled";
const rewrite_pending_key = "enc.rewrite_pending";
const disable_pending_key = "enc.disable_pending";
const ciphertext_checked_key = "enc.ciphertext_checked";
/// Row names are public so lock.zig can re-wrap the data key in the same
/// transaction as a password change.
pub const scrub_pending_key = "enc.scrub_pending";
pub const kdf_key = "enc.kdf";
pub const wrapped_key_key = "enc.wrapped_key";
pub const recovery_kdf_key = "enc.recovery_kdf";
pub const recovery_wrapped_key_key = "enc.recovery_wrapped_key";
/// Set after an unlock with the recovery key, until a new recovery key is
/// saved: the one just typed is no longer a secret.
pub const recovery_rotate_key = "enc.recovery_rotate";

const Aes256Gcm = std.crypto.aead.aes_gcm.Aes256Gcm;
pub const data_key_len = Aes256Gcm.key_length;
const nonce_len = Aes256Gcm.nonce_length;
const tag_len = Aes256Gcm.tag_length;
const salt_len = 16;
const wrapped_len = nonce_len + data_key_len + tag_len;

/// The shortest password Sage accepts. The password is what stands between a
/// copied `app.db` and the data key, and Argon2id only buys about 50 ms per
/// guess, so a four-character PIN is minutes of work offline. The lock
/// enforces the same floor, and Settings shows it.
pub const min_password_len = 8;

/// A recovery key is 120 random bits written as 24 characters of Crockford
/// base32 (digits and capitals without I, L, O, U), shown in six groups of
/// four. Crockford drops the letters people misread, and `normalizeRecoveryKey`
/// folds I, L, and O onto 1 and 0, so a key read off paper still opens.
pub const recovery_key_len = 24;
pub const recovery_key_display_len = recovery_key_len + 5;
const recovery_alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Fill `out` with a fresh recovery key from the system's secure random
/// source, in its normalized form (no dashes).
pub fn generateRecoveryKey(io: std.Io, out: *[recovery_key_len]u8) !void {
    var bytes: [recovery_key_len * 5 / 8]u8 = undefined;
    defer std.crypto.secureZero(u8, &bytes);
    try std.Io.randomSecure(io, &bytes);
    var bit_index: usize = 0;
    for (out) |*char| {
        var value: u8 = 0;
        for (0..5) |_| {
            const byte = bytes[bit_index / 8];
            const bit = (byte >> @intCast(7 - bit_index % 8)) & 1;
            value = (value << 1) | bit;
            bit_index += 1;
        }
        char.* = recovery_alphabet[value];
    }
}

/// The form people see and copy: `7K2M-9QXD-...`, six groups of four.
pub fn formatRecoveryKey(key: *const [recovery_key_len]u8, out: *[recovery_key_display_len]u8) void {
    var at: usize = 0;
    for (key, 0..) |char, index| {
        if (index > 0 and index % 4 == 0) {
            out[at] = '-';
            at += 1;
        }
        out[at] = char;
        at += 1;
    }
}

/// Turn what someone typed into the normalized key. Case, dashes, and spaces
/// do not matter, and O, I, and L read as 0, 1, and 1. Returns false when the
/// text is not a well-formed key, so the caller can tell a typo in length or
/// letters from a wrong key and not count it as a guess.
pub fn normalizeRecoveryKey(input: []const u8, out: *[recovery_key_len]u8) bool {
    var count: usize = 0;
    for (input) |raw| {
        if (raw == '-' or raw == ' ' or raw == '\t' or raw == '\r' or raw == '\n') continue;
        var char = std.ascii.toUpper(raw);
        switch (char) {
            'O' => char = '0',
            'I', 'L' => char = '1',
            else => {},
        }
        if (std.mem.indexOfScalar(u8, recovery_alphabet, char) == null) return false;
        if (count == recovery_key_len) return false;
        out[count] = char;
        count += 1;
    }
    return count == recovery_key_len;
}

const upsert_sql = "INSERT INTO app_setting (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value;";

pub const Vault = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    db: *native_sdk.RelationalStore,
    enabled: bool = false,
    /// True until the row walk finishes. Survives a crash so a later launch
    /// can resume after unlock instead of vacuuming a mixed database.
    rewrite_pending: bool = false,
    /// True while a requested disable still needs to decrypt rows and remove
    /// the setup rows. This takes precedence over `rewrite_pending`.
    disable_pending: bool = false,
    /// True once a full row walk has authenticated every prefixed field.
    /// Older vaults get one such pass before data commands can run.
    ciphertext_checked: bool = false,
    /// True until `scrubStorage` finishes. A successful rebuild persists
    /// false so later launches do not vacuum the whole file again.
    scrub_pending: bool = false,
    key: ?[data_key_len]u8 = null,
    /// True after an unlock with the recovery key, until a new one is saved.
    recovery_rotate: bool = false,
    kdf_json: []u8 = &.{},
    wrapped_key: []u8 = &.{},
    recovery_kdf_json: []u8 = &.{},
    recovery_wrapped_key: []u8 = &.{},

    pub fn init(allocator: std.mem.Allocator, io: std.Io, db: *native_sdk.RelationalStore) !Vault {
        var vault: Vault = .{ .allocator = allocator, .io = io, .db = db };
        errdefer vault.deinit();
        try vault.load();
        return vault;
    }

    pub fn deinit(self: *Vault) void {
        self.zeroKey();
        if (self.kdf_json.len > 0) self.allocator.free(self.kdf_json);
        if (self.wrapped_key.len > 0) self.allocator.free(self.wrapped_key);
        if (self.recovery_kdf_json.len > 0) self.allocator.free(self.recovery_kdf_json);
        if (self.recovery_wrapped_key.len > 0) self.allocator.free(self.recovery_wrapped_key);
    }

    /// The password slot is complete: both rows are present.
    pub fn hasPasswordSlot(self: *const Vault) bool {
        return self.kdf_json.len > 0 and self.wrapped_key.len > 0;
    }

    /// The recovery slot is complete: both rows are present.
    pub fn hasRecoverySlot(self: *const Vault) bool {
        return self.recovery_kdf_json.len > 0 and self.recovery_wrapped_key.len > 0;
    }

    fn zeroKey(self: *Vault) void {
        if (self.key) |*key| {
            std.crypto.secureZero(u8, key);
            self.key = null;
        }
    }

    /// Forget the in-memory key without changing the encryption settings or
    /// wrapped key. A later unlock can unwrap it again.
    pub fn lockMemory(self: *Vault) void {
        self.zeroKey();
    }

    /// The data key, while unlocked. Exposed so the Touch ID path can mirror
    /// it into the macOS Keychain.
    pub fn dataKey(self: *const Vault) ?[data_key_len]u8 {
        return self.key;
    }

    /// Install a data key read back from the Keychain.
    pub fn setKey(self: *Vault, key: [data_key_len]u8) void {
        self.key = key;
    }

    /// Turn encryption on: generate the data key, wrap it with the password,
    /// and store the KDF settings and wrapped key. The caller has already
    /// verified the password against the lock. Existing rows are rewritten by
    /// the store afterwards (`Store.setRowsEncrypted`).
    pub fn enable(self: *Vault, password: []const u8) !void {
        if (self.enabled) return error.AlreadyEnabled;
        // The lock refuses short passwords too; this keeps the wrapping code
        // safe on its own.
        if (password.len < min_password_len) return error.PasswordTooShort;
        var data_key: [data_key_len]u8 = undefined;
        try std.Io.randomSecure(self.io, &data_key);
        defer std.crypto.secureZero(u8, &data_key);

        var bundle = try self.wrapWithPassword(password, &data_key);
        defer bundle.deinit(self.allocator);

        const outcome = self.db.exec(&.{
            .{ .sql = upsert_sql, .params = &.{ .{ .text = kdf_key }, .{ .text = bundle.kdf_json } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = wrapped_key_key }, .{ .text = bundle.wrapped_key } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = enabled_key }, .{ .text = "true" } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = rewrite_pending_key }, .{ .text = "true" } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = ciphertext_checked_key }, .{ .text = "false" } } },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;

        const kdf_copy = try self.allocator.dupe(u8, bundle.kdf_json);
        errdefer self.allocator.free(kdf_copy);
        const wrapped_copy = try self.allocator.dupe(u8, bundle.wrapped_key);
        self.kdf_json = kdf_copy;
        self.wrapped_key = wrapped_copy;
        self.enabled = true;
        self.rewrite_pending = true;
        self.ciphertext_checked = false;
        self.key = data_key;
    }

    /// Turn encryption on with no password: generate the data key and wrap it
    /// with the recovery key only. Touch ID is the everyday way in, through the
    /// Keychain copy, so the caller stores that copy and rolls this back if it
    /// cannot. `recovery_key` is the normalized key from `generateRecoveryKey`.
    /// Existing rows are rewritten by the store afterwards, as with `enable`.
    pub fn enableWithRecovery(self: *Vault, recovery_key: *const [recovery_key_len]u8) !void {
        if (self.enabled) return error.AlreadyEnabled;
        var data_key: [data_key_len]u8 = undefined;
        try std.Io.randomSecure(self.io, &data_key);
        defer std.crypto.secureZero(u8, &data_key);

        var bundle = try self.wrapWithRecoveryKey(recovery_key, &data_key);
        defer bundle.deinit(self.allocator);

        const outcome = self.db.exec(&.{
            .{ .sql = upsert_sql, .params = &.{ .{ .text = recovery_kdf_key }, .{ .text = bundle.kdf_json } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = recovery_wrapped_key_key }, .{ .text = bundle.wrapped_key } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = enabled_key }, .{ .text = "true" } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = rewrite_pending_key }, .{ .text = "true" } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = ciphertext_checked_key }, .{ .text = "false" } } },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;

        self.applyRecoveryBundle(&bundle);
        self.enabled = true;
        self.rewrite_pending = true;
        self.ciphertext_checked = false;
        self.key = data_key;
    }

    /// Unwrap the data key with the password. The lock has already verified
    /// the same password, so a failure here means the stored key material is
    /// inconsistent, not that the password is wrong.
    pub fn unlockWithPassword(self: *Vault, password: []const u8) !void {
        if (!self.enabled) return error.EncryptionNotEnabled;
        var data_key: [data_key_len]u8 = undefined;
        defer std.crypto.secureZero(u8, &data_key);
        try self.unwrapWithSecret(self.kdf_json, self.wrapped_key, password, aad_wrapped_key, &data_key);
        self.key = data_key;
    }

    /// Unwrap the data key with what someone typed as their recovery key.
    /// `error.InvalidRecoveryKey` means the text is not shaped like a key, so
    /// the caller does not count it as a guess; `error.WrongRecoveryKey` means
    /// a well-formed key that does not open the vault.
    pub fn unlockWithRecovery(self: *Vault, typed: []const u8) !void {
        if (!self.enabled) return error.EncryptionNotEnabled;
        if (!self.hasRecoverySlot()) return error.RecoveryKeyUnavailable;
        var recovery_key: [recovery_key_len]u8 = undefined;
        defer std.crypto.secureZero(u8, &recovery_key);
        if (!normalizeRecoveryKey(typed, &recovery_key)) return error.InvalidRecoveryKey;
        var data_key: [data_key_len]u8 = undefined;
        defer std.crypto.secureZero(u8, &data_key);
        self.unwrapWithSecret(self.recovery_kdf_json, self.recovery_wrapped_key, &recovery_key, aad_recovery_wrapped_key, &data_key) catch |err| switch (err) {
            error.KeyUnwrapFailed => return error.WrongRecoveryKey,
            else => return err,
        };
        self.key = data_key;
    }

    /// Open one slot. A failure here means the stored key material is
    /// inconsistent or the secret is wrong; the callers say which.
    fn unwrapWithSecret(
        self: *const Vault,
        kdf_json: []const u8,
        wrapped: []const u8,
        secret: []const u8,
        aad: []const u8,
        out: *[data_key_len]u8,
    ) !void {
        const settings = try parseKdf(kdf_json);

        var wrapping_key: [data_key_len]u8 = undefined;
        defer std.crypto.secureZero(u8, &wrapping_key);
        try std.crypto.pwhash.argon2.kdf(
            self.allocator,
            &wrapping_key,
            secret,
            &settings.salt,
            settings.params,
            .argon2id,
            self.io,
        );

        if (std.base64.standard.Decoder.calcSizeForSlice(wrapped) catch null != wrapped_len)
            return error.CorruptKeyMaterial;
        var blob: [wrapped_len]u8 = undefined;
        std.base64.standard.Decoder.decode(&blob, wrapped) catch return error.CorruptKeyMaterial;
        const nonce: [nonce_len]u8 = blob[0..nonce_len].*;
        const tag: [tag_len]u8 = blob[nonce_len + data_key_len ..][0..tag_len].*;

        Aes256Gcm.decrypt(out, blob[nonce_len..][0..data_key_len], tag, aad, nonce, wrapping_key) catch
            return error.KeyUnwrapFailed;
    }

    /// Turn encryption off: drop the stored key material and the in-memory
    /// key. The store decrypts the rows first (`Store.setRowsEncrypted`).
    pub fn disable(self: *Vault) !void {
        if (!self.enabled) return error.EncryptionNotEnabled;
        const outcome = self.db.exec(&.{.{
            .sql = "DELETE FROM app_setting WHERE key IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
            .params = &.{
                .{ .text = enabled_key },
                .{ .text = kdf_key },
                .{ .text = wrapped_key_key },
                .{ .text = recovery_kdf_key },
                .{ .text = recovery_wrapped_key_key },
                .{ .text = recovery_rotate_key },
                .{ .text = rewrite_pending_key },
                .{ .text = disable_pending_key },
                .{ .text = ciphertext_checked_key },
                .{ .text = scrub_pending_key },
            },
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
        self.dropPasswordSlot();
        self.dropRecoverySlot();
        self.recovery_rotate = false;
        self.enabled = false;
        self.rewrite_pending = false;
        self.disable_pending = false;
        self.ciphertext_checked = false;
        self.scrub_pending = false;
        self.zeroKey();
    }

    /// Persist both flags before the caller starts decrypting rows. A crash
    /// during the walk must resume as a disable, not fall through to encrypt.
    pub fn beginDisable(self: *Vault) !void {
        if (!self.enabled) return error.EncryptionNotEnabled;
        const outcome = self.db.exec(&.{
            .{ .sql = upsert_sql, .params = &.{ .{ .text = rewrite_pending_key }, .{ .text = "true" } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = disable_pending_key }, .{ .text = "true" } } },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;
        self.rewrite_pending = true;
        self.disable_pending = true;
    }

    pub fn setRewritePending(self: *Vault, on: bool) !void {
        try upsertFlag(self.db, rewrite_pending_key, on);
        self.rewrite_pending = on;
    }

    pub fn setCiphertextChecked(self: *Vault, on: bool) !void {
        try upsertFlag(self.db, ciphertext_checked_key, on);
        self.ciphertext_checked = on;
    }

    pub fn setScrubPending(self: *Vault, on: bool) !void {
        try upsertFlag(self.db, scrub_pending_key, on);
        self.scrub_pending = on;
    }

    /// Mirror a scrub flag that is already committed to disk, without a second
    /// write. The password change writes `enc.scrub_pending` in the same
    /// transaction as the new wrap, then calls this.
    pub fn markScrubPending(self: *Vault) void {
        self.scrub_pending = true;
    }

    pub fn setRecoveryRotate(self: *Vault, on: bool) !void {
        try upsertFlag(self.db, recovery_rotate_key, on);
        self.recovery_rotate = on;
    }

    /// Replace the recovery slot with a new recovery key's wrap. One
    /// transaction commits the rows, clears the rotate flag, and marks the file
    /// rebuild owed, because the old wrap can still sit in free pages or the
    /// write-ahead log and the old key is no longer a secret.
    pub fn saveRecoverySlot(self: *Vault, bundle: *WrapBundle) !void {
        if (!self.enabled) return error.EncryptionNotEnabled;
        const outcome = self.db.exec(&.{
            .{ .sql = upsert_sql, .params = &.{ .{ .text = recovery_kdf_key }, .{ .text = bundle.kdf_json } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = recovery_wrapped_key_key }, .{ .text = bundle.wrapped_key } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = recovery_rotate_key }, .{ .text = "false" } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = scrub_pending_key }, .{ .text = "true" } } },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;
        self.applyRecoveryBundle(bundle);
        self.markScrubPending();
    }

    /// Forget the password slot in memory. The caller has already deleted its
    /// rows in the same transaction that removes the password.
    pub fn dropPasswordSlot(self: *Vault) void {
        if (self.kdf_json.len > 0) {
            self.allocator.free(self.kdf_json);
            self.kdf_json = &.{};
        }
        if (self.wrapped_key.len > 0) {
            self.allocator.free(self.wrapped_key);
            self.wrapped_key = &.{};
        }
    }

    fn dropRecoverySlot(self: *Vault) void {
        if (self.recovery_kdf_json.len > 0) {
            self.allocator.free(self.recovery_kdf_json);
            self.recovery_kdf_json = &.{};
        }
        if (self.recovery_wrapped_key.len > 0) {
            self.allocator.free(self.recovery_wrapped_key);
            self.recovery_wrapped_key = &.{};
        }
    }

    pub const WrapBundle = struct {
        kdf_json: []u8,
        wrapped_key: []u8,

        pub fn deinit(self: *WrapBundle, allocator: std.mem.Allocator) void {
            if (self.kdf_json.len > 0) allocator.free(self.kdf_json);
            if (self.wrapped_key.len > 0) allocator.free(self.wrapped_key);
        }
    };

    /// Derive a fresh wrapping key from `password` (new random salt) and wrap
    /// `data_key` with it. Returned slices are owned by the caller.
    pub fn wrapWithPassword(self: *const Vault, password: []const u8, data_key: *const [data_key_len]u8) !WrapBundle {
        return self.wrapWithSecret(password, aad_wrapped_key, data_key);
    }

    /// The same for the recovery slot, under its own label.
    pub fn wrapWithRecoveryKey(self: *const Vault, recovery_key: *const [recovery_key_len]u8, data_key: *const [data_key_len]u8) !WrapBundle {
        return self.wrapWithSecret(recovery_key, aad_recovery_wrapped_key, data_key);
    }

    fn wrapWithSecret(self: *const Vault, secret: []const u8, aad: []const u8, data_key: *const [data_key_len]u8) !WrapBundle {
        const params = std.crypto.pwhash.argon2.Params.owasp_2id;
        var salt: [salt_len]u8 = undefined;
        try std.Io.randomSecure(self.io, &salt);

        var wrapping_key: [data_key_len]u8 = undefined;
        defer std.crypto.secureZero(u8, &wrapping_key);
        try std.crypto.pwhash.argon2.kdf(
            self.allocator,
            &wrapping_key,
            secret,
            &salt,
            params,
            .argon2id,
            self.io,
        );

        var blob: [wrapped_len]u8 = undefined;
        try std.Io.randomSecure(self.io, blob[0..nonce_len]);
        var tag: [tag_len]u8 = undefined;
        Aes256Gcm.encrypt(blob[nonce_len..][0..data_key_len], &tag, data_key, aad, blob[0..nonce_len].*, wrapping_key);
        blob[nonce_len + data_key_len ..][0..tag_len].* = tag;

        const wrapped_key = try self.allocator.alloc(u8, std.base64.standard.Encoder.calcSize(wrapped_len));
        errdefer self.allocator.free(wrapped_key);
        _ = std.base64.standard.Encoder.encode(wrapped_key, &blob);

        var salt_buf: [std.base64.standard.Encoder.calcSize(salt_len)]u8 = undefined;
        const salt_b64 = std.base64.standard.Encoder.encode(&salt_buf, &salt);
        const kdf_json = try std.fmt.allocPrint(
            self.allocator,
            "{{\"m\":{d},\"t\":{d},\"p\":{d},\"salt\":\"{s}\"}}",
            .{ params.m, params.t, params.p, salt_b64 },
        );
        return .{ .kdf_json = kdf_json, .wrapped_key = wrapped_key };
    }

    /// Take ownership of a fresh bundle after a password change. The caller
    /// has already committed it to the database in the same transaction as
    /// the new password hash.
    pub fn applyBundle(self: *Vault, bundle: *WrapBundle) void {
        if (self.kdf_json.len > 0) self.allocator.free(self.kdf_json);
        if (self.wrapped_key.len > 0) self.allocator.free(self.wrapped_key);
        self.kdf_json = bundle.kdf_json;
        self.wrapped_key = bundle.wrapped_key;
        bundle.kdf_json = &.{};
        bundle.wrapped_key = &.{};
    }

    /// The same for the recovery slot, after the caller committed it.
    pub fn applyRecoveryBundle(self: *Vault, bundle: *WrapBundle) void {
        self.dropRecoverySlot();
        self.recovery_kdf_json = bundle.kdf_json;
        self.recovery_wrapped_key = bundle.wrapped_key;
        bundle.kdf_json = &.{};
        bundle.wrapped_key = &.{};
        self.recovery_rotate = false;
    }

    /// Encrypt one field for storage. Returns an owned slice: the prefixed
    /// base64 ciphertext when encryption is on, a copy of the plaintext when
    /// off. Fails with error.Locked when encryption is on but the data key is
    /// not in memory.
    pub fn encryptField(self: *const Vault, allocator: std.mem.Allocator, aad: []const u8, plaintext: []const u8) ![]u8 {
        if (!self.enabled) return allocator.dupe(u8, plaintext);
        const key = self.key orelse return error.Locked;

        const blob = try allocator.alloc(u8, nonce_len + plaintext.len + tag_len);
        defer allocator.free(blob);
        try std.Io.randomSecure(self.io, blob[0..nonce_len]);
        var tag: [tag_len]u8 = undefined;
        Aes256Gcm.encrypt(blob[nonce_len..][0..plaintext.len], &tag, plaintext, aad, blob[0..nonce_len].*, key);
        blob[nonce_len + plaintext.len ..][0..tag_len].* = tag;

        const out = try allocator.alloc(u8, field_prefix.len + std.base64.standard.Encoder.calcSize(blob.len));
        @memcpy(out[0..field_prefix.len], field_prefix);
        _ = std.base64.standard.Encoder.encode(out[field_prefix.len..], blob);
        return out;
    }

    /// Decrypt one stored field. Fields without the prefix are returned as-is
    /// (seed rows, or rows written before encryption was on). Fails with
    /// error.Locked when the field is encrypted but the data key is not in
    /// memory.
    pub fn decryptField(self: *const Vault, allocator: std.mem.Allocator, aad: []const u8, stored: []const u8) ![]u8 {
        if (!self.enabled) return allocator.dupe(u8, stored);
        if (!isEncryptedField(stored)) return allocator.dupe(u8, stored);
        const key = self.key orelse return error.Locked;

        const encoded = stored[field_prefix.len..];
        const blob_len = std.base64.standard.Decoder.calcSizeForSlice(encoded) catch return error.CorruptField;
        if (blob_len < nonce_len + tag_len) return error.CorruptField;
        const blob = try allocator.alloc(u8, blob_len);
        defer allocator.free(blob);
        std.base64.standard.Decoder.decode(blob, encoded) catch return error.CorruptField;

        const nonce: [nonce_len]u8 = blob[0..nonce_len].*;
        const tag: [tag_len]u8 = blob[blob_len - tag_len ..][0..tag_len].*;
        const ciphertext = blob[nonce_len .. blob_len - tag_len];
        const plaintext = try allocator.alloc(u8, ciphertext.len);
        errdefer allocator.free(plaintext);
        Aes256Gcm.decrypt(plaintext, ciphertext, tag, aad, nonce, key) catch return error.CorruptField;
        return plaintext;
    }

    pub fn isEncryptedField(stored: []const u8) bool {
        return std.mem.startsWith(u8, stored, field_prefix);
    }

    /// Check the encoded envelope without authenticating it. Callers use this
    /// only to distinguish a plaintext prefix collision from a ciphertext;
    /// `decryptField` still verifies the GCM tag.
    pub fn hasCiphertextEnvelope(allocator: std.mem.Allocator, stored: []const u8) !bool {
        if (!isEncryptedField(stored)) return false;
        const encoded = stored[field_prefix.len..];
        const blob_len = std.base64.standard.Decoder.calcSizeForSlice(encoded) catch return false;
        if (blob_len < nonce_len + tag_len) return false;
        const blob = try allocator.alloc(u8, blob_len);
        defer allocator.free(blob);
        std.base64.standard.Decoder.decode(blob, encoded) catch return false;
        return true;
    }

    fn load(self: *Vault) !void {
        var rows = journal.KvRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT key, value FROM app_setting WHERE key IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
            &.{
                .{ .text = enabled_key },
                .{ .text = kdf_key },
                .{ .text = wrapped_key_key },
                .{ .text = recovery_kdf_key },
                .{ .text = recovery_wrapped_key_key },
                .{ .text = recovery_rotate_key },
                .{ .text = rewrite_pending_key },
                .{ .text = disable_pending_key },
                .{ .text = ciphertext_checked_key },
                .{ .text = scrub_pending_key },
            },
            &rows,
            journal.KvRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        var saw_scrub = false;
        for (rows.rows.items) |row| {
            if (std.mem.eql(u8, row.key, enabled_key)) {
                self.enabled = std.mem.eql(u8, row.value, "true");
            } else if (std.mem.eql(u8, row.key, kdf_key) and row.value.len > 0) {
                self.kdf_json = try self.allocator.dupe(u8, row.value);
            } else if (std.mem.eql(u8, row.key, wrapped_key_key) and row.value.len > 0) {
                self.wrapped_key = try self.allocator.dupe(u8, row.value);
            } else if (std.mem.eql(u8, row.key, recovery_kdf_key) and row.value.len > 0) {
                self.recovery_kdf_json = try self.allocator.dupe(u8, row.value);
            } else if (std.mem.eql(u8, row.key, recovery_wrapped_key_key) and row.value.len > 0) {
                self.recovery_wrapped_key = try self.allocator.dupe(u8, row.value);
            } else if (std.mem.eql(u8, row.key, recovery_rotate_key)) {
                self.recovery_rotate = std.mem.eql(u8, row.value, "true");
            } else if (std.mem.eql(u8, row.key, rewrite_pending_key)) {
                self.rewrite_pending = std.mem.eql(u8, row.value, "true");
            } else if (std.mem.eql(u8, row.key, disable_pending_key)) {
                self.disable_pending = std.mem.eql(u8, row.value, "true");
            } else if (std.mem.eql(u8, row.key, ciphertext_checked_key)) {
                self.ciphertext_checked = std.mem.eql(u8, row.value, "true");
            } else if (std.mem.eql(u8, row.key, scrub_pending_key)) {
                saw_scrub = true;
                self.scrub_pending = std.mem.eql(u8, row.value, "true");
            }
        }
        // Each slot's two rows are written together, and a journal needs at
        // least one complete slot. Treat anything less as off.
        if (!self.hasPasswordSlot() and !self.hasRecoverySlot()) {
            self.enabled = false;
        }
        // Databases from before these flags have no scrub row. One rebuild is
        // still owed; the first successful scrub persists false.
        if (self.enabled and !saw_scrub) {
            self.scrub_pending = true;
        }
    }
};

fn upsertFlag(db: *native_sdk.RelationalStore, key: []const u8, on: bool) !void {
    const outcome = db.exec(&.{.{
        .sql = upsert_sql,
        .params = &.{ .{ .text = key }, .{ .text = if (on) "true" else "false" } },
    }});
    if (outcome != .ok) return error.SqliteWriteFailed;
}

const KdfSettings = struct {
    params: std.crypto.pwhash.argon2.Params,
    salt: [salt_len]u8,
};

fn parseKdf(json: []const u8) !KdfSettings {
    const m = journal.jsonI64(json, "m") orelse return error.CorruptKeyMaterial;
    const t = journal.jsonI64(json, "t") orelse return error.CorruptKeyMaterial;
    const p = journal.jsonI64(json, "p") orelse return error.CorruptKeyMaterial;
    if (m <= 0 or t <= 0 or p <= 0) return error.CorruptKeyMaterial;
    var salt_buf: [64]u8 = undefined;
    var used: usize = 0;
    const salt_b64 = journal.jsonString(json, "salt", &salt_buf, &used) orelse return error.CorruptKeyMaterial;
    var salt: [salt_len]u8 = undefined;
    if (std.base64.standard.Decoder.calcSizeForSlice(salt_b64) catch null != salt_len)
        return error.CorruptKeyMaterial;
    std.base64.standard.Decoder.decode(&salt, salt_b64) catch return error.CorruptKeyMaterial;
    // The JSON is app-written, but a hand-edited database must fail with an
    // error here, not trap on an out-of-range cast.
    return .{
        .params = .{
            .t = std.math.cast(u32, t) orelse return error.CorruptKeyMaterial,
            .m = std.math.cast(u32, m) orelse return error.CorruptKeyMaterial,
            .p = std.math.cast(u24, p) orelse return error.CorruptKeyMaterial,
        },
        .salt = salt,
    };
}

fn testDb() !native_sdk.RelationalStore {
    const open_result = try native_sdk.RelationalStore.openMemoryMigrated(std.testing.allocator, &journal.migrations);
    var db = switch (open_result.outcome) {
        .ok => open_result.database.?,
        else => return error.SqliteMigrationFailed,
    };
    try journal.insertFixtureEntries(&db);
    return db;
}

test "enable then unlock round-trips the data key" {
    var db = try testDb();
    defer db.deinit();
    var first_key: [data_key_len]u8 = undefined;
    {
        var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        try std.testing.expect(!vault.enabled);
        try vault.enable("correct horse");
        try std.testing.expect(vault.enabled);
        try std.testing.expect(vault.dataKey() != null);
        first_key = vault.dataKey().?;
    }
    // A fresh process reads the rows and has no key until unlock.
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expect(vault.enabled);
    try std.testing.expect(vault.dataKey() == null);
    try vault.unlockWithPassword("correct horse");
    try std.testing.expectEqualSlices(u8, &first_key, &vault.dataKey().?);
}

test "lockMemory keeps encryption enabled and unlock restores the key" {
    var db = try testDb();
    defer db.deinit();
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try vault.enable("correct horse");
    const original_key = vault.dataKey().?;

    vault.lockMemory();
    try std.testing.expect(vault.enabled);
    try std.testing.expect(vault.dataKey() == null);

    try vault.unlockWithPassword("correct horse");
    try std.testing.expectEqualSlices(u8, &original_key, &vault.dataKey().?);
}

test "enable refuses a password shorter than the minimum" {
    var db = try testDb();
    defer db.deinit();
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expectError(error.PasswordTooShort, vault.enable("1234567"));
    try std.testing.expect(!vault.enabled);
    try std.testing.expect(vault.dataKey() == null);
}

test "the wrong password cannot unwrap the data key" {
    var db = try testDb();
    defer db.deinit();
    {
        var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        try vault.enable("correct horse");
    }
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expectError(error.KeyUnwrapFailed, vault.unlockWithPassword("wrong"));
    try std.testing.expect(vault.dataKey() == null);
}

test "field encryption round-trips and carries the prefix" {
    var db = try testDb();
    defer db.deinit();
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try vault.enable("correct horse");

    const stored = try vault.encryptField(std.testing.allocator, aad_entry_body, "hello fog");
    defer std.testing.allocator.free(stored);
    try std.testing.expect(Vault.isEncryptedField(stored));
    try std.testing.expect(std.mem.indexOf(u8, stored, "hello fog") == null);

    const opened = try vault.decryptField(std.testing.allocator, aad_entry_body, stored);
    defer std.testing.allocator.free(opened);
    try std.testing.expectEqualStrings("hello fog", opened);
}

test "the same plaintext encrypts differently twice" {
    var db = try testDb();
    defer db.deinit();
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try vault.enable("correct horse");

    const first = try vault.encryptField(std.testing.allocator, aad_entry_title, "same words");
    defer std.testing.allocator.free(first);
    const second = try vault.encryptField(std.testing.allocator, aad_entry_title, "same words");
    defer std.testing.allocator.free(second);
    try std.testing.expect(!std.mem.eql(u8, first, second));
}

test "a tampered ciphertext and a wrong context fail to open" {
    var db = try testDb();
    defer db.deinit();
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try vault.enable("correct horse");

    const stored = try vault.encryptField(std.testing.allocator, aad_entry_body, "secret words");
    defer std.testing.allocator.free(stored);

    // Flip one character inside the base64 body; authentication must fail.
    var tampered = try std.testing.allocator.dupe(u8, stored);
    defer std.testing.allocator.free(tampered);
    const at = field_prefix.len + 4;
    tampered[at] = if (tampered[at] == 'A') 'B' else 'A';
    try std.testing.expectError(error.CorruptField, vault.decryptField(std.testing.allocator, aad_entry_body, tampered));

    // The same ciphertext under another field's associated data must fail.
    try std.testing.expectError(error.CorruptField, vault.decryptField(std.testing.allocator, aad_entry_title, stored));
}

test "fields without the prefix pass through" {
    var db = try testDb();
    defer db.deinit();
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();

    // Encryption off: encrypt is a plain copy.
    const plain = try vault.encryptField(std.testing.allocator, aad_entry_body, "seed words");
    defer std.testing.allocator.free(plain);
    try std.testing.expectEqualStrings("seed words", plain);

    // Encryption on: a stored plaintext field still reads back as-is.
    try vault.enable("correct horse");
    const opened = try vault.decryptField(std.testing.allocator, aad_entry_body, "seed words");
    defer std.testing.allocator.free(opened);
    try std.testing.expectEqualStrings("seed words", opened);
}

test "encrypted fields refuse to open without the key" {
    var db = try testDb();
    defer db.deinit();
    var stored: []u8 = &.{};
    {
        var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        try vault.enable("correct horse");
        stored = try vault.encryptField(std.testing.allocator, aad_entry_body, "locked words");
    }
    defer std.testing.allocator.free(stored);

    // Fresh process: encryption is on, but no unlock has happened.
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expectError(error.Locked, vault.decryptField(std.testing.allocator, aad_entry_body, stored));
    try std.testing.expectError(error.Locked, vault.encryptField(std.testing.allocator, aad_entry_body, "more words"));
}

test "disable drops the key material and the in-memory key" {
    var db = try testDb();
    defer db.deinit();
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try vault.enable("correct horse");
    try vault.beginDisable();
    try std.testing.expect(vault.rewrite_pending);
    try std.testing.expect(vault.disable_pending);
    try vault.setScrubPending(true);
    try vault.disable();
    try std.testing.expect(!vault.enabled);
    try std.testing.expect(!vault.rewrite_pending);
    try std.testing.expect(!vault.disable_pending);
    try std.testing.expect(!vault.scrub_pending);
    try std.testing.expect(vault.dataKey() == null);

    var fresh = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer fresh.deinit();
    try std.testing.expect(!fresh.enabled);
    try std.testing.expect(!fresh.rewrite_pending);
    try std.testing.expect(!fresh.disable_pending);
    try std.testing.expect(!fresh.ciphertext_checked);
    try std.testing.expect(!fresh.scrub_pending);
}

test "enable marks the row rewrite unfinished until it is cleared" {
    var db = try testDb();
    defer db.deinit();
    {
        var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        try vault.enable("correct horse");
        try std.testing.expect(vault.rewrite_pending);
        try std.testing.expect(!vault.ciphertext_checked);
        try vault.setCiphertextChecked(true);
        try vault.setRewritePending(false);
        try vault.setScrubPending(false);
    }
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expect(vault.enabled);
    try std.testing.expect(!vault.rewrite_pending);
    try std.testing.expect(vault.ciphertext_checked);
    try std.testing.expect(!vault.scrub_pending);
}

test "an older encrypted database treats a missing scrub flag as pending" {
    var db = try testDb();
    defer db.deinit();
    {
        var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        try vault.enable("correct horse");
        try vault.setRewritePending(false);
    }
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expect(vault.enabled);
    try std.testing.expect(!vault.rewrite_pending);
    try std.testing.expect(!vault.ciphertext_checked);
    try std.testing.expect(vault.scrub_pending);
}

test "a partial key state reads as disabled" {
    var db = try testDb();
    defer db.deinit();
    const outcome = db.exec(&.{.{
        .sql = upsert_sql,
        .params = &.{ .{ .text = enabled_key }, .{ .text = "true" } },
    }});
    try std.testing.expect(outcome == .ok);
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expect(!vault.enabled);
}

test "out-of-range kdf settings fail with an error instead of trapping" {
    var db = try testDb();
    defer db.deinit();
    {
        var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        try vault.enable("correct horse");
    }
    // A hand-edited database carries a memory cost far past u32.
    const outcome = db.exec(&.{.{
        .sql = upsert_sql,
        .params = &.{ .{ .text = kdf_key }, .{ .text = "{\"m\":1099511627776,\"t\":2,\"p\":1,\"salt\":\"AAAAAAAAAAAAAAAAAAAAAA==\"}" } },
    }});
    try std.testing.expect(outcome == .ok);
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expectError(error.CorruptKeyMaterial, vault.unlockWithPassword("correct horse"));
}

const test_recovery_key: [recovery_key_len]u8 = "7K2M9QXD3FHT8VWZ4BNC6PRG".*;

test "recovery-only enable round-trips the data key and has no password slot" {
    var db = try testDb();
    defer db.deinit();
    var first_key: [data_key_len]u8 = undefined;
    {
        var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        try vault.enableWithRecovery(&test_recovery_key);
        try std.testing.expect(vault.enabled);
        try std.testing.expect(vault.hasRecoverySlot());
        try std.testing.expect(!vault.hasPasswordSlot());
        first_key = vault.dataKey().?;
    }
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expect(vault.enabled);
    try std.testing.expect(vault.hasRecoverySlot());
    try std.testing.expect(!vault.hasPasswordSlot());
    try std.testing.expect(vault.dataKey() == null);
    try vault.unlockWithRecovery("7k2m-9qxd-3fht-8vwz-4bnc-6prg");
    try std.testing.expectEqualSlices(u8, &first_key, &vault.dataKey().?);
    // There is no password to unwrap with.
    vault.lockMemory();
    try std.testing.expectError(error.CorruptKeyMaterial, vault.unlockWithPassword("correct horse"));
}

test "a wrong or malformed recovery key does not open the vault" {
    var db = try testDb();
    defer db.deinit();
    {
        var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        try vault.enableWithRecovery(&test_recovery_key);
    }
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expectError(error.WrongRecoveryKey, vault.unlockWithRecovery("7K2M-9QXD-3FHT-8VWZ-4BNC-6PRH"));
    // Too short, and a letter outside the alphabet: not shaped like a key, so
    // the caller does not count them as guesses.
    try std.testing.expectError(error.InvalidRecoveryKey, vault.unlockWithRecovery("7K2M-9QXD"));
    try std.testing.expectError(error.InvalidRecoveryKey, vault.unlockWithRecovery("7K2M-9QXD-3FHT-8VWZ-4BNC-6PRU"));
    try std.testing.expect(vault.dataKey() == null);
}

test "a password wrap pasted into the recovery rows fails to open" {
    var db = try testDb();
    defer db.deinit();
    // A password that is also a well-formed recovery key, so only the label
    // separates the two slots.
    const secret = "7K2M9QXD3FHT8VWZ4BNC6PRG";
    {
        var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        try vault.enable(secret);
        const outcome = db.exec(&.{
            .{ .sql = upsert_sql, .params = &.{ .{ .text = recovery_kdf_key }, .{ .text = vault.kdf_json } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = recovery_wrapped_key_key }, .{ .text = vault.wrapped_key } } },
        });
        try std.testing.expect(outcome == .ok);
    }
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expect(vault.hasRecoverySlot());
    try std.testing.expectError(error.WrongRecoveryKey, vault.unlockWithRecovery(secret));
    try vault.unlockWithPassword(secret);
}

test "both slots open the same data key" {
    var db = try testDb();
    defer db.deinit();
    var original: [data_key_len]u8 = undefined;
    {
        var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        try vault.enable("correct horse");
        original = vault.dataKey().?;
        var bundle = try vault.wrapWithRecoveryKey(&test_recovery_key, &original);
        defer bundle.deinit(std.testing.allocator);
        const outcome = db.exec(&.{
            .{ .sql = upsert_sql, .params = &.{ .{ .text = recovery_kdf_key }, .{ .text = bundle.kdf_json } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = recovery_wrapped_key_key }, .{ .text = bundle.wrapped_key } } },
        });
        try std.testing.expect(outcome == .ok);
        vault.applyRecoveryBundle(&bundle);
        try std.testing.expect(vault.hasPasswordSlot() and vault.hasRecoverySlot());
    }
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try vault.unlockWithPassword("correct horse");
    try std.testing.expectEqualSlices(u8, &original, &vault.dataKey().?);
    vault.lockMemory();
    try vault.unlockWithRecovery("7K2M9QXD3FHT8VWZ4BNC6PRG");
    try std.testing.expectEqualSlices(u8, &original, &vault.dataKey().?);
}

test "dropping the password slot leaves a recovery-only vault" {
    var db = try testDb();
    defer db.deinit();
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try vault.enable("correct horse");
    const data_key = vault.dataKey().?;
    var bundle = try vault.wrapWithRecoveryKey(&test_recovery_key, &data_key);
    defer bundle.deinit(std.testing.allocator);
    vault.applyRecoveryBundle(&bundle);
    vault.dropPasswordSlot();
    try std.testing.expect(!vault.hasPasswordSlot());
    try std.testing.expect(vault.hasRecoverySlot());
}

test "a partial recovery slot reads as disabled" {
    var db = try testDb();
    defer db.deinit();
    const outcome = db.exec(&.{
        .{ .sql = upsert_sql, .params = &.{ .{ .text = enabled_key }, .{ .text = "true" } } },
        .{ .sql = upsert_sql, .params = &.{ .{ .text = recovery_kdf_key }, .{ .text = "{}" } } },
    });
    try std.testing.expect(outcome == .ok);
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expect(!vault.enabled);
}

test "disable removes the recovery slot and the rotate flag" {
    var db = try testDb();
    defer db.deinit();
    {
        var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        try vault.enableWithRecovery(&test_recovery_key);
        try vault.setRecoveryRotate(true);
        try vault.beginDisable();
        try vault.disable();
        try std.testing.expect(!vault.enabled);
        try std.testing.expect(!vault.hasRecoverySlot());
        try std.testing.expect(!vault.recovery_rotate);
    }
    var fresh = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer fresh.deinit();
    try std.testing.expect(!fresh.enabled);
    try std.testing.expect(!fresh.hasRecoverySlot());
    try std.testing.expect(!fresh.recovery_rotate);
}

test "the rotate flag persists until a new recovery slot replaces it" {
    var db = try testDb();
    defer db.deinit();
    {
        var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        try vault.enableWithRecovery(&test_recovery_key);
        try vault.setRecoveryRotate(true);
    }
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expect(vault.recovery_rotate);
    try vault.unlockWithRecovery("7K2M9QXD3FHT8VWZ4BNC6PRG");
    const data_key = vault.dataKey().?;
    var bundle = try vault.wrapWithRecoveryKey(&test_recovery_key, &data_key);
    defer bundle.deinit(std.testing.allocator);
    vault.applyRecoveryBundle(&bundle);
    try std.testing.expect(!vault.recovery_rotate);
}

test "generated recovery keys are well formed and differ" {
    var first: [recovery_key_len]u8 = undefined;
    var second: [recovery_key_len]u8 = undefined;
    try generateRecoveryKey(std.testing.io, &first);
    try generateRecoveryKey(std.testing.io, &second);
    try std.testing.expect(!std.mem.eql(u8, &first, &second));
    for (first) |char| try std.testing.expect(std.mem.indexOfScalar(u8, recovery_alphabet, char) != null);

    var shown: [recovery_key_display_len]u8 = undefined;
    formatRecoveryKey(&first, &shown);
    for (shown, 0..) |char, index| {
        if (index % 5 == 4) {
            try std.testing.expectEqual(@as(u8, '-'), char);
        } else {
            try std.testing.expect(std.mem.indexOfScalar(u8, recovery_alphabet, char) != null);
        }
    }
    var round_trip: [recovery_key_len]u8 = undefined;
    try std.testing.expect(normalizeRecoveryKey(&shown, &round_trip));
    try std.testing.expectEqualSlices(u8, &first, &round_trip);
}

test "recovery key input forgives case, spacing, and look-alike letters" {
    var out: [recovery_key_len]u8 = undefined;
    try std.testing.expect(normalizeRecoveryKey(" 7k2m 9qxd-3fht-8vwz-4bnc-6prg\n", &out));
    try std.testing.expectEqualSlices(u8, &test_recovery_key, &out);

    // O reads as 0 and I or L as 1.
    try std.testing.expect(normalizeRecoveryKey("OIL0-0000-0000-0000-0000-0000", &out));
    try std.testing.expectEqualStrings("011000000000000000000000", &out);

    try std.testing.expect(!normalizeRecoveryKey("7K2M-9QXD-3FHT-8VWZ-4BNC-6PR", &out));
    try std.testing.expect(!normalizeRecoveryKey("7K2M-9QXD-3FHT-8VWZ-4BNC-6PRGG", &out));
    try std.testing.expect(!normalizeRecoveryKey("7K2M-9QXD-3FHT-8VWZ-4BNC-6PRU", &out));
    try std.testing.expect(!normalizeRecoveryKey("", &out));
}

test "saving a recovery slot clears the stored rotate flag and owes a rebuild" {
    var db = try testDb();
    defer db.deinit();
    const new_key: [recovery_key_len]u8 = "ABCDEFGH1JKMNPQRSTVWXYZ0".*;
    {
        var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        try vault.enableWithRecovery(&test_recovery_key);
        try vault.setRecoveryRotate(true);
        try vault.setScrubPending(false);
        const data_key = vault.dataKey().?;
        var bundle = try vault.wrapWithRecoveryKey(&new_key, &data_key);
        defer bundle.deinit(std.testing.allocator);
        try vault.saveRecoverySlot(&bundle);
        try std.testing.expect(!vault.recovery_rotate);
        try std.testing.expect(vault.scrub_pending);
    }
    // What reached the file, not just the in-memory copy.
    var vault = try Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expect(!vault.recovery_rotate);
    try std.testing.expect(vault.scrub_pending);
    try std.testing.expectError(error.WrongRecoveryKey, vault.unlockWithRecovery("7K2M-9QXD-3FHT-8VWZ-4BNC-6PRG"));
    try vault.unlockWithRecovery("ABCDEFGH1JKMNPQRSTVWXYZ0");
}
