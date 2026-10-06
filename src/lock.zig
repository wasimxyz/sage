const std = @import("std");
const native_sdk = @import("native_sdk");
const journal = @import("journal.zig");
const touchid = @import("touchid.zig");
const vault_mod = @import("vault.zig");

const password_hash_key = "lock.password_hash";
const touch_id_key = "lock.touch_id";
const failed_attempts_key = "lock.failed_attempts";
const retry_after_key = "lock.retry_after_ms";
const idle_timeout_key = "lock.idle_timeout_ms";

/// Whether FileVault encrypts this Mac's disk. Without it, the Mac login
/// password is the only thing between a stolen disk and the journal key.
pub const FileVault = enum {
    on,
    off,
    unknown,

    fn name(self: FileVault) []const u8 {
        return switch (self) {
            .on => "on",
            .off => "off",
            .unknown => "unknown",
        };
    }
};

/// Status fields that come from the vault and the Mac, not the lock rows.
pub const StatusExtra = struct {
    recovery_key_set: bool = false,
    recovery_key_rotate: bool = false,
    file_vault: FileVault = .unknown,
};

/// What it takes to prove the owner is here before a change that weakens
/// protection: nothing after an unlock with the recovery key, the password
/// when one is set, otherwise a fresh system prompt.
pub const Proof = enum { none, password, prompt };

pub const default_idle_timeout_ms: i64 = 300_000;
const idle_timeout_options = [_]i64{ 0, 60_000, 300_000, 900_000, 1_800_000 };

/// Wrong guesses allowed before every further guess has to wait.
const free_attempts = 5;
/// The wait imposed once the free guesses are used. Deliberately fixed, not
/// growing: a person who mistypes their own password waits the same five
/// seconds every time, and someone guessing by hand gets one guess every five
/// seconds.
const retry_wait_ms = 5_000;

const delete_password_slot_sql = "DELETE FROM app_setting WHERE key IN (?1, ?2, ?3);";
const upsert_sql = "INSERT INTO app_setting (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value;";

/// The optional app lock. State comes from the `app_setting` table (an
/// Argon2id hash in PHC form, salt included, and a Touch ID flag); the
/// `unlocked` flag is in-memory only and never persists, so quitting Sage
/// locks it again. The password itself is never stored.
pub const Lock = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    db: *native_sdk.RelationalStore,
    unlocked: bool = true,
    password_set: bool = false,
    touch_id_enabled: bool = false,
    idle_timeout_ms: i64 = default_idle_timeout_ms,
    password_hash: []u8 = &.{},
    /// True after an unlock with the recovery key. The owner just proved they
    /// hold the key that opens everything, and may have forgotten the
    /// password, so changing or removing it, making a new recovery key, and
    /// removing encryption ask for no further proof. Ends when the session
    /// locks or the lock turns off.
    recovered: bool = false,
    /// Wrong guesses since the last successful unlock. Stored in
    /// `app_setting`, so quitting Sage does not hand back the free guesses.
    failed_attempts: u32 = 0,
    /// Wall-clock milliseconds before which a password guess is refused; zero
    /// means no wait. Stored next to the count.
    retry_after_ms: i64 = 0,
    /// Test seam: the wall clock to read instead of the real one.
    clock_ms: ?i64 = null,

    pub fn init(allocator: std.mem.Allocator, io: std.Io, db: *native_sdk.RelationalStore) !Lock {
        var lock: Lock = .{ .allocator = allocator, .io = io, .db = db };
        errdefer lock.deinit();
        try lock.load();
        // The lock engages at launch only when the user turned it on.
        lock.unlocked = !lock.enabled();
        return lock;
    }

    pub fn deinit(self: *Lock) void {
        if (self.password_hash.len > 0) self.allocator.free(self.password_hash);
    }

    pub fn enabled(self: *const Lock) bool {
        return self.password_set or self.touch_id_enabled;
    }

    /// Lock an active session without changing the configured lock methods.
    pub fn lockSession(self: *Lock) bool {
        if (!self.enabled() or !self.unlocked) return false;
        self.unlocked = false;
        self.recovered = false;
        return true;
    }

    /// Open the lock after the recovery key unwrapped the data key. The key
    /// that was just typed counts as proof until the session locks.
    pub fn unlockRecovered(self: *Lock) void {
        self.unlocked = true;
        self.recovered = true;
        self.clearFailures();
    }

    /// What a change that weakens protection costs right now. One rule for
    /// every handler, so none of them can disagree about a recovered session.
    pub fn proofRequired(self: *const Lock) Proof {
        if (self.recovered) return .none;
        return if (self.password_set) .password else .prompt;
    }

    /// Persist one of the supported inactivity periods.
    pub fn setIdleTimeout(self: *Lock, timeout_ms: i64) !void {
        if (!isIdleTimeoutAllowed(timeout_ms)) return error.InvalidIdleTimeout;
        var value_buf: [24]u8 = undefined;
        const value = try std.fmt.bufPrint(&value_buf, "{d}", .{timeout_ms});
        try self.upsert(idle_timeout_key, value);
        self.idle_timeout_ms = timeout_ms;
    }

    pub fn status(self: *const Lock, touch: touchid.Availability, encrypted: bool, securing: bool, scrubbing: bool, extra: StatusExtra, output: []u8) ![]const u8 {
        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"enabled\":");
        try writer.writeAll(boolStr(self.enabled()));
        try writer.writeAll(",\"encrypted\":");
        try writer.writeAll(boolStr(encrypted));
        try writer.writeAll(",\"recoveryKeySet\":");
        try writer.writeAll(boolStr(extra.recovery_key_set));
        try writer.writeAll(",\"recoveryKeyRotate\":");
        try writer.writeAll(boolStr(extra.recovery_key_rotate));
        try writer.writeAll(",\"recoveredSession\":");
        try writer.writeAll(boolStr(self.recovered));
        try writer.writeAll(",\"fileVault\":\"");
        try writer.writeAll(extra.file_vault.name());
        try writer.writeAll("\"");
        try writer.writeAll(",\"passwordSet\":");
        try writer.writeAll(boolStr(self.password_set));
        try writer.writeAll(",\"touchIdEnabled\":");
        try writer.writeAll(boolStr(self.touch_id_enabled));
        try writer.writeAll(",\"touchIdAvailable\":");
        try writer.writeAll(boolStr(touch.prompt));
        try writer.writeAll(",\"touchIdBiometrics\":");
        try writer.writeAll(boolStr(touch.biometrics));
        try writer.writeAll(",\"touchIdHardware\":");
        try writer.writeAll(boolStr(touch.hardware or touch.biometrics));
        try writer.writeAll(",\"unlocked\":");
        try writer.writeAll(boolStr(self.unlocked));
        try writer.writeAll(",\"securing\":");
        try writer.writeAll(boolStr(securing));
        try writer.writeAll(",\"scrubbing\":");
        try writer.writeAll(boolStr(scrubbing));
        try writer.writeAll(",\"idleTimeoutMs\":");
        try writer.print("{d}", .{self.idle_timeout_ms});
        // The wait is enforced here, not in the page, so the page reads how
        // much of it is left instead of counting from five again after a
        // reload.
        try writer.writeAll(",\"waitRemainingMs\":");
        try writer.print("{d}", .{self.waitRemainingMs()});
        try writer.writeAll("}");
        return writer.buffered();
    }

    pub fn unlockPassword(self: *Lock, payload: []const u8, output: []u8) ![]const u8 {
        var password_buf: [1024]u8 = undefined;
        var used: usize = 0;
        defer @memset(&password_buf, 0);
        const password = journal.jsonString(payload, "password", &password_buf, &used) orelse return error.InvalidRequest;
        if (password.len == 0) return error.InvalidRequest;
        try self.verifyPassword(password);
        self.unlocked = true;
        return okJson(output);
    }

    /// Verify a password against the stored hash. The unlock handlers use this
    /// so they can unwrap the data key before the lock flips to unlocked.
    ///
    /// Wrong guesses are counted. Once `free_attempts` have failed, every
    /// further guess waits `retry_wait_ms`; a guess inside that window fails
    /// with `error.TooManyAttempts` without running the hash at all. The count
    /// and the wait both survive a relaunch.
    pub fn verifyPassword(self: *Lock, password: []const u8) !void {
        if (!self.password_set) return error.NoPasswordSet;
        if (self.waitRemainingMs() > 0) return error.TooManyAttempts;
        self.verify(password) catch |err| switch (err) {
            error.PasswordVerificationFailed => {
                self.recordFailure();
                return error.WrongPassword;
            },
            else => return err,
        };
        self.clearFailures();
    }

    /// Touch ID succeeded on the LocalAuthentication side; the loop thread
    /// calls this when it completes the prompt job.
    pub fn unlockTouchId(self: *Lock) void {
        if (!self.touch_id_enabled) return;
        self.unlocked = true;
        // The owner's finger is on the reader, so the guess streak ends.
        self.clearFailures();
    }

    /// Set the first password or change an existing one. Changing requires
    /// the current password: the lock exists to stop someone sitting down at
    /// an unlocked Mac, and they must not be able to rotate it away.
    ///
    /// When encryption is on, the data key is re-wrapped with the new
    /// password in the same transaction as the hash update, so the two never
    /// point at different passwords. No journal entry is rewritten. The same
    /// transaction marks the file rebuild owed, because the previous wrap can
    /// still sit in free pages or the write-ahead log until the file is
    /// rebuilt.
    pub fn setPassword(self: *Lock, payload: []const u8, vault: ?*vault_mod.Vault, output: []u8) ![]const u8 {
        return self.setPasswordChecked(payload, vault, self.recovered, output);
    }

    /// Set or change the password when the caller already has proof that the
    /// owner is here: a system prompt that just succeeded. The current
    /// password is not asked for. After an unlock with the recovery key,
    /// `setPassword` takes this path by itself.
    pub fn setPasswordTrusted(self: *Lock, payload: []const u8, vault: ?*vault_mod.Vault, output: []u8) ![]const u8 {
        return self.setPasswordChecked(payload, vault, true, output);
    }

    fn setPasswordChecked(self: *Lock, payload: []const u8, vault: ?*vault_mod.Vault, trusted: bool, output: []u8) ![]const u8 {
        if (!self.unlocked) return error.Locked;
        var buf: [2048]u8 = undefined;
        var used: usize = 0;
        defer @memset(&buf, 0);
        const next = journal.jsonString(payload, "next", &buf, &used) orelse return error.InvalidRequest;
        // The password wraps the journal key, so the minimum lives with the
        // wrapping code in `vault.zig`.
        if (next.len < vault_mod.min_password_len) return error.PasswordTooShort;
        const current = journal.jsonString(payload, "current", &buf, &used);
        if (!trusted and !self.password_set) {
            // A first password on an encrypted journal adds a way to open the
            // file offline, so it costs a fresh system prompt. The handler
            // shows it and calls `setPasswordTrusted` when it succeeds.
            if (vault) |v| {
                if (v.enabled) return error.TouchIdConfirmationRequired;
            }
        }
        if (self.password_set and !trusted) {
            const existing = current orelse return error.CurrentPasswordRequired;
            // Already unlocked, so this uses raw `verify` and skips the guess
            // wait. A locked caller has to go through `verifyPassword`.
            self.verify(existing) catch |err| switch (err) {
                error.PasswordVerificationFailed => return error.WrongPassword,
                else => return err,
            };
        }
        // ~50-100 ms on the loop thread at OWASP interactive parameters;
        // acceptable for a settings action and a lock screen.
        var hash_buf: [256]u8 = undefined;
        const phc = try std.crypto.pwhash.argon2.strHash(next, .{
            .allocator = self.allocator,
            .params = .owasp_2id,
            .mode = .argon2id,
        }, &hash_buf, self.io);

        if (vault) |v| {
            if (v.enabled) {
                var data_key = v.dataKey() orelse return error.Locked;
                defer std.crypto.secureZero(u8, &data_key);
                var bundle = try v.wrapWithPassword(next, &data_key);
                defer bundle.deinit(self.allocator);
                const outcome = self.db.exec(&.{
                    .{ .sql = upsert_sql, .params = &.{ .{ .text = password_hash_key }, .{ .text = phc } } },
                    .{ .sql = upsert_sql, .params = &.{ .{ .text = vault_mod.kdf_key }, .{ .text = bundle.kdf_json } } },
                    .{ .sql = upsert_sql, .params = &.{ .{ .text = vault_mod.wrapped_key_key }, .{ .text = bundle.wrapped_key } } },
                    // The old wrap is still readable in the file until the
                    // rebuild, so it is owed from the same transaction.
                    .{ .sql = upsert_sql, .params = &.{ .{ .text = vault_mod.scrub_pending_key }, .{ .text = "true" } } },
                });
                if (outcome != .ok) return error.SqliteWriteFailed;
                v.applyBundle(&bundle);
                v.markScrubPending();
                try self.replaceHash(phc);
                self.password_set = true;
                return okJson(output);
            }
        }

        try self.upsert(password_hash_key, phc);
        try self.replaceHash(phc);
        self.password_set = true;
        return okJson(output);
    }

    /// Everything that has to hold before the password can go, with nothing
    /// written: Touch ID stays as a way in, the owner proves they are here
    /// (the current password, or the recovery key just used), and an encrypted
    /// journal has a recovery slot or a new one coming. The handler calls this
    /// before it touches the Keychain, so a refused request has no side
    /// effects.
    pub fn checkRemovePassword(
        self: *const Lock,
        payload: []const u8,
        vault: *const vault_mod.Vault,
        has_new_recovery_key: bool,
    ) !void {
        try self.checkRemoveState();
        if (self.proofRequired() != .none) {
            var password_buf: [1024]u8 = undefined;
            var used: usize = 0;
            defer @memset(&password_buf, 0);
            const password = journal.jsonString(payload, "password", &password_buf, &used) orelse return error.CurrentPasswordRequired;
            // Already unlocked, so this uses raw `verify` and skips the guess
            // wait. A locked caller has to go through `verifyPassword`.
            self.verify(password) catch |err| switch (err) {
                error.PasswordVerificationFailed => return error.WrongPassword,
                else => return err,
            };
        }
        if (vault.enabled and !has_new_recovery_key and !vault.hasRecoverySlot()) return error.RecoveryKeyRequired;
    }

    fn checkRemoveState(self: *const Lock) !void {
        if (!self.unlocked) return error.Locked;
        if (!self.password_set) return error.NoPasswordSet;
        // Without the password, Touch ID is the everyday way in.
        if (!self.touch_id_enabled) return error.LastUnlockMethod;
    }

    /// Remove the password and keep Touch ID as the only way in. The recovery
    /// key is what lets an encrypted journal survive that, so `recovery` holds
    /// a fresh slot to commit in the same transaction, or the vault already
    /// has one. The same transaction deletes the password slot and marks the
    /// file rebuild owed, because the old wrap can still sit in free pages or
    /// the write-ahead log.
    pub fn removePassword(
        self: *Lock,
        payload: []const u8,
        vault: *vault_mod.Vault,
        recovery: ?*vault_mod.Vault.WrapBundle,
        output: []u8,
    ) ![]const u8 {
        try self.checkRemovePassword(payload, vault, recovery != null);
        return self.commitRemovePassword(vault, recovery, output);
    }

    /// The writes of `removePassword`, for a caller that has already run
    /// `checkRemovePassword` and has more to do between the two, like storing
    /// the Keychain copy that replaces the password.
    pub fn commitRemovePassword(
        self: *Lock,
        vault: *vault_mod.Vault,
        recovery: ?*vault_mod.Vault.WrapBundle,
        output: []u8,
    ) ![]const u8 {
        try self.checkRemoveState();
        if (vault.enabled) {
            if (recovery == null and !vault.hasRecoverySlot()) return error.RecoveryKeyRequired;
            const outcome = if (recovery) |bundle| self.db.exec(&.{
                .{ .sql = delete_password_slot_sql, .params = &.{ .{ .text = password_hash_key }, .{ .text = vault_mod.kdf_key }, .{ .text = vault_mod.wrapped_key_key } } },
                .{ .sql = upsert_sql, .params = &.{ .{ .text = vault_mod.recovery_kdf_key }, .{ .text = bundle.kdf_json } } },
                .{ .sql = upsert_sql, .params = &.{ .{ .text = vault_mod.recovery_wrapped_key_key }, .{ .text = bundle.wrapped_key } } },
                .{ .sql = upsert_sql, .params = &.{ .{ .text = vault_mod.recovery_rotate_key }, .{ .text = "false" } } },
                .{ .sql = upsert_sql, .params = &.{ .{ .text = vault_mod.scrub_pending_key }, .{ .text = "true" } } },
            }) else self.db.exec(&.{
                .{ .sql = delete_password_slot_sql, .params = &.{ .{ .text = password_hash_key }, .{ .text = vault_mod.kdf_key }, .{ .text = vault_mod.wrapped_key_key } } },
                .{ .sql = upsert_sql, .params = &.{ .{ .text = vault_mod.scrub_pending_key }, .{ .text = "true" } } },
            });
            if (outcome != .ok) return error.SqliteWriteFailed;
            if (recovery) |bundle| vault.applyRecoveryBundle(bundle);
            vault.dropPasswordSlot();
            vault.markScrubPending();
        } else {
            const outcome = self.db.exec(&.{.{
                .sql = "DELETE FROM app_setting WHERE key = ?1;",
                .params = &.{.{ .text = password_hash_key }},
            }});
            if (outcome != .ok) return error.SqliteWriteFailed;
        }
        if (self.password_hash.len > 0) {
            self.allocator.free(self.password_hash);
            self.password_hash = &.{};
        }
        self.password_set = false;
        return okJson(output);
    }

    /// Turn the lock off. With a password set, that password is the proof.
    /// With Touch ID as the only method, the handler shows a fresh system
    /// prompt and calls `completeDisable` when it succeeds.
    pub fn disable(self: *Lock, payload: []const u8, encrypted: bool, output: []u8) ![]const u8 {
        if (!self.unlocked) return error.Locked;
        // Encryption needs the password to unwrap the data key; removing the
        // lock first would strand ciphertext. The user removes encryption
        // first, which decrypts the rows.
        if (encrypted) return error.EncryptionEnabled;
        if (self.password_set) {
            var password_buf: [1024]u8 = undefined;
            var used: usize = 0;
            defer @memset(&password_buf, 0);
            const password = journal.jsonString(payload, "password", &password_buf, &used) orelse return error.CurrentPasswordRequired;
            // Already unlocked, so this uses raw `verify` and skips the guess
            // wait. A locked caller has to go through `verifyPassword`.
            self.verify(password) catch |err| switch (err) {
                error.PasswordVerificationFailed => return error.WrongPassword,
                else => return err,
            };
        } else if (self.touch_id_enabled) {
            // Touch ID is the only method, so turning the lock off costs proof
            // that the person at the keyboard is the owner.
            return error.TouchIdConfirmationRequired;
        }
        try self.completeDisable(encrypted);
        return okJson(output);
    }

    /// Finish turning the lock off. The prompt completion calls this too, and
    /// the rules are checked again because the lock can move between the
    /// request and the reply: encryption may have been turned on, which would
    /// strand the data key.
    pub fn completeDisable(self: *Lock, encrypted: bool) !void {
        if (!self.unlocked) return error.Locked;
        if (encrypted) return error.EncryptionEnabled;
        try self.deleteLockRows();
        self.clearState();
    }

    /// Turn Touch ID off once the proof is in. `setTouchId` wraps this for the
    /// password path; the prompt completion calls it directly, and re-checks
    /// the last-method rule there.
    pub fn clearTouchId(self: *Lock, encrypted: bool) !void {
        if (!self.unlocked) return error.Locked;
        // Encryption still needs at least one unlock method. Turning Touch ID
        // off when no password is set would leave ciphertext with no way back.
        if (encrypted and !self.password_set) return error.LastUnlockMethod;
        try self.upsert(touch_id_key, "false");
        self.touch_id_enabled = false;
        // With no password either, the lock is off, and a recovered session
        // has nothing left to vouch for.
        if (!self.enabled()) self.recovered = false;
    }

    /// Turn Touch ID on, or turn it off with proof: the Sage password when one
    /// is set, otherwise a fresh system prompt the handler runs and finishes
    /// through `clearTouchId`. The reply carries `TouchIdConfirmationRequired`
    /// when the prompt is owed; nothing is written in that case.
    pub fn setTouchId(self: *Lock, payload: []const u8, encrypted: bool, output: []u8) ![]const u8 {
        if (!self.unlocked) return error.Locked;
        const enable = journal.jsonBool(payload, "enabled") orelse return error.InvalidRequest;
        if (enable) {
            try self.upsert(touch_id_key, "true");
            self.touch_id_enabled = true;
            return okJson(output);
        }
        if (encrypted and !self.password_set) return error.LastUnlockMethod;
        if (!self.password_set) return error.TouchIdConfirmationRequired;
        var password_buf: [1024]u8 = undefined;
        var used: usize = 0;
        defer @memset(&password_buf, 0);
        const password = journal.jsonString(payload, "password", &password_buf, &used) orelse return error.CurrentPasswordRequired;
        // Already unlocked, so this uses raw `verify` and skips the guess
        // wait. A locked caller has to go through `verifyPassword`.
        self.verify(password) catch |err| switch (err) {
            error.PasswordVerificationFailed => return error.WrongPassword,
            else => return err,
        };
        try self.clearTouchId(encrypted);
        return okJson(output);
    }

    /// Forget the lock: the rows are already gone.
    fn clearState(self: *Lock) void {
        if (self.password_hash.len > 0) {
            self.allocator.free(self.password_hash);
            self.password_hash = &.{};
        }
        self.password_set = false;
        self.touch_id_enabled = false;
        self.recovered = false;
        self.failed_attempts = 0;
        self.retry_after_ms = 0;
    }

    /// Refuse a guess that lands inside the wait. The recovery key shares the
    /// password's count and wait, so a guesser cannot switch between them to
    /// get more tries.
    pub fn requireNoWait(self: *const Lock) !void {
        if (self.waitRemainingMs() > 0) return error.TooManyAttempts;
    }

    /// How long a guess has to wait right now, in milliseconds.
    fn waitRemainingMs(self: *const Lock) i64 {
        if (self.failed_attempts < free_attempts) return 0;
        const remaining = self.retry_after_ms - self.wallMs();
        return if (remaining > 0) remaining else 0;
    }

    /// Count a wrong guess, and start the wait once the free guesses are used.
    /// A failed write only weakens the wait after the next launch; this guess
    /// is still refused now.
    pub fn recordFailure(self: *Lock) void {
        if (self.failed_attempts < std.math.maxInt(u32)) self.failed_attempts += 1;
        if (self.failed_attempts >= free_attempts) self.retry_after_ms = self.wallMs() + retry_wait_ms;
        self.saveThrottle() catch {};
    }

    /// End the streak: the password checked out, or Touch ID did.
    pub fn clearFailures(self: *Lock) void {
        if (self.failed_attempts == 0 and self.retry_after_ms == 0) return;
        self.failed_attempts = 0;
        self.retry_after_ms = 0;
        self.saveThrottle() catch {};
    }

    fn saveThrottle(self: *Lock) !void {
        var count_buf: [16]u8 = undefined;
        var wait_buf: [24]u8 = undefined;
        const count = try std.fmt.bufPrint(&count_buf, "{d}", .{self.failed_attempts});
        const wait = try std.fmt.bufPrint(&wait_buf, "{d}", .{self.retry_after_ms});
        const outcome = self.db.exec(&.{
            .{ .sql = upsert_sql, .params = &.{ .{ .text = failed_attempts_key }, .{ .text = count } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = retry_after_key }, .{ .text = wait } } },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    fn wallMs(self: *const Lock) i64 {
        if (self.clock_ms) |fixed| return fixed;
        return std.Io.Clock.Timestamp.now(self.io, .real).raw.toMilliseconds();
    }

    fn verify(self: *const Lock, password: []const u8) !void {
        try std.crypto.pwhash.argon2.strVerify(self.password_hash, password, .{ .allocator = self.allocator }, self.io);
    }

    fn replaceHash(self: *Lock, phc: []const u8) !void {
        const copy = try self.allocator.dupe(u8, phc);
        if (self.password_hash.len > 0) self.allocator.free(self.password_hash);
        self.password_hash = copy;
    }

    fn load(self: *Lock) !void {
        var rows = journal.KvRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT key, value FROM app_setting WHERE key IN (?1, ?2, ?3, ?4, ?5);",
            &.{
                .{ .text = password_hash_key },
                .{ .text = touch_id_key },
                .{ .text = failed_attempts_key },
                .{ .text = retry_after_key },
                .{ .text = idle_timeout_key },
            },
            &rows,
            journal.KvRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        for (rows.rows.items) |row| {
            if (std.mem.eql(u8, row.key, password_hash_key) and row.value.len > 0) {
                try self.replaceHash(row.value);
                self.password_set = true;
            } else if (std.mem.eql(u8, row.key, touch_id_key)) {
                self.touch_id_enabled = std.mem.eql(u8, row.value, "true");
            } else if (std.mem.eql(u8, row.key, failed_attempts_key)) {
                // A row that is not a number reads as no guesses, the same as
                // a database that never recorded one.
                self.failed_attempts = std.fmt.parseInt(u32, row.value, 10) catch 0;
            } else if (std.mem.eql(u8, row.key, retry_after_key)) {
                self.retry_after_ms = std.fmt.parseInt(i64, row.value, 10) catch 0;
            } else if (std.mem.eql(u8, row.key, idle_timeout_key)) {
                const timeout_ms = std.fmt.parseInt(i64, row.value, 10) catch continue;
                if (isIdleTimeoutAllowed(timeout_ms)) self.idle_timeout_ms = timeout_ms;
            }
        }
        // A stored wait is honored, but never for longer than one wait: a
        // clock that moved backwards must not lock the owner out, and a wait
        // that already passed is over.
        const now = self.wallMs();
        if (self.failed_attempts < free_attempts or self.retry_after_ms <= now) {
            self.retry_after_ms = 0;
        } else if (self.retry_after_ms > now + retry_wait_ms) {
            self.retry_after_ms = now + retry_wait_ms;
        }
    }

    fn upsert(self: *Lock, key: []const u8, value: []const u8) !void {
        const outcome = self.db.exec(&.{.{
            .sql = upsert_sql,
            .params = &.{ .{ .text = key }, .{ .text = value } },
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    fn deleteLockRows(self: *Lock) !void {
        const outcome = self.db.exec(&.{.{
            .sql = "DELETE FROM app_setting WHERE key IN (?1, ?2, ?3, ?4);",
            .params = &.{
                .{ .text = password_hash_key },
                .{ .text = touch_id_key },
                .{ .text = failed_attempts_key },
                .{ .text = retry_after_key },
            },
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
    }
};

pub fn idleShouldLock(timeout_ms: i64, last_activity_ms: i64, now_ms: i64) bool {
    if (timeout_ms <= 0 or now_ms < last_activity_ms) return false;
    return now_ms - last_activity_ms >= timeout_ms;
}

fn isIdleTimeoutAllowed(timeout_ms: i64) bool {
    for (idle_timeout_options) |option| {
        if (option == timeout_ms) return true;
    }
    return false;
}

fn boolStr(value: bool) []const u8 {
    return if (value) "true" else "false";
}

fn okJson(output: []u8) ![]const u8 {
    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"ok\":true}");
    return writer.buffered();
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

fn testLock(db: *native_sdk.RelationalStore) !Lock {
    return Lock.init(std.testing.allocator, std.testing.io, db);
}

/// The wall clock, as the lock reads it, so a test can start the seam there.
fn testClockMs() i64 {
    return std.Io.Clock.Timestamp.now(std.testing.io, .real).raw.toMilliseconds();
}

/// Fail `free_attempts` guesses, which is what arms the wait.
fn exhaustFreeAttempts(lock: *Lock, output: []u8) !void {
    var guess: u32 = 0;
    while (guess < free_attempts) : (guess += 1) {
        try std.testing.expectError(error.WrongPassword, lock.unlockPassword("{\"password\":\"wrong\"}", output));
    }
}

test "lock starts unlocked and disabled with no rows" {
    var db = try testDb();
    defer db.deinit();
    var lock = try testLock(&db);
    defer lock.deinit();
    try std.testing.expect(lock.unlocked);
    try std.testing.expect(!lock.enabled());
    try std.testing.expectEqual(default_idle_timeout_ms, lock.idle_timeout_ms);

    var output: [512]u8 = undefined;
    const json = try lock.status(.{ .prompt = false, .biometrics = false }, false, false, false, .{}, &output);
    try std.testing.expectEqualStrings("{\"enabled\":false,\"encrypted\":false,\"recoveryKeySet\":false,\"recoveryKeyRotate\":false,\"recoveredSession\":false,\"fileVault\":\"unknown\",\"passwordSet\":false,\"touchIdEnabled\":false,\"touchIdAvailable\":false,\"touchIdBiometrics\":false,\"touchIdHardware\":false,\"unlocked\":true,\"securing\":false,\"scrubbing\":false,\"idleTimeoutMs\":300000,\"waitRemainingMs\":0}", json);
}

test "lockSession only changes an enabled unlocked session" {
    var db = try testDb();
    defer db.deinit();
    var lock = try testLock(&db);
    defer lock.deinit();

    try std.testing.expect(!lock.lockSession());
    try std.testing.expect(lock.unlocked);

    var output: [256]u8 = undefined;
    _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    _ = try lock.setTouchId("{\"enabled\":true}", false, &output);
    try std.testing.expect(lock.lockSession());
    try std.testing.expect(!lock.unlocked);
    try std.testing.expect(!lock.lockSession());

    lock.unlockTouchId();
    try std.testing.expect(lock.unlocked);
    try std.testing.expect(lock.lockSession());
    try std.testing.expect(!lock.unlocked);
    try std.testing.expect(!lock.lockSession());
}

test "idleShouldLock honors Never and the exact timeout boundary" {
    try std.testing.expect(!idleShouldLock(0, 1_000, 100_000));
    try std.testing.expect(!idleShouldLock(300_000, 1_000, 300_999));
    try std.testing.expect(idleShouldLock(300_000, 1_000, 301_000));
    try std.testing.expect(!idleShouldLock(300_000, 1_000, 999));
}

test "setIdleTimeout only accepts and persists supported values" {
    var db = try testDb();
    defer db.deinit();
    var lock = try testLock(&db);
    defer lock.deinit();

    for (idle_timeout_options) |timeout_ms| {
        try lock.setIdleTimeout(timeout_ms);
        try std.testing.expectEqual(timeout_ms, lock.idle_timeout_ms);
    }
    try std.testing.expectError(error.InvalidIdleTimeout, lock.setIdleTimeout(120_000));
    try std.testing.expectEqual(@as(i64, 1_800_000), lock.idle_timeout_ms);

    var reloaded = try testLock(&db);
    defer reloaded.deinit();
    try std.testing.expectEqual(@as(i64, 1_800_000), reloaded.idle_timeout_ms);
}

test "setPassword engages the lock on the next launch" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    {
        var lock = try testLock(&db);
        defer lock.deinit();
        _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
        try std.testing.expect(lock.password_set);
        try std.testing.expect(lock.unlocked);
    }
    // A fresh process reads the rows and starts locked.
    var lock = try testLock(&db);
    defer lock.deinit();
    try std.testing.expect(!lock.unlocked);
    try std.testing.expect(lock.enabled());
    try std.testing.expect(lock.password_set);
}

test "unlockPassword accepts the right password and rejects a wrong one" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    {
        var lock = try testLock(&db);
        defer lock.deinit();
        _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    }
    var lock = try testLock(&db);
    defer lock.deinit();
    try std.testing.expectError(error.WrongPassword, lock.unlockPassword("{\"password\":\"wrong\"}", &output));
    try std.testing.expect(!lock.unlocked);
    _ = try lock.unlockPassword("{\"password\":\"correct horse\"}", &output);
    try std.testing.expect(lock.unlocked);
}

test "management commands refuse while locked" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    {
        var lock = try testLock(&db);
        defer lock.deinit();
        _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    }
    var lock = try testLock(&db);
    defer lock.deinit();
    try std.testing.expectError(error.Locked, lock.setPassword("{\"next\":\"another one\"}", null, &output));
    try std.testing.expectError(error.Locked, lock.disable("{}", false, &output));
    try std.testing.expectError(error.Locked, lock.setTouchId("{\"enabled\":true}", false, &output));
}

test "changing the password requires the current password" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    {
        var lock = try testLock(&db);
        defer lock.deinit();
        _ = try lock.setPassword("{\"next\":\"first pass\"}", null, &output);
        try std.testing.expectError(error.CurrentPasswordRequired, lock.setPassword("{\"next\":\"second pass\"}", null, &output));
        try std.testing.expectError(error.WrongPassword, lock.setPassword("{\"current\":\"nope\",\"next\":\"second pass\"}", null, &output));
        _ = try lock.setPassword("{\"current\":\"first pass\",\"next\":\"second pass\"}", null, &output);
    }
    var lock = try testLock(&db);
    defer lock.deinit();
    _ = try lock.unlockPassword("{\"password\":\"second pass\"}", &output);
    try std.testing.expect(lock.unlocked);
}

test "short passwords are refused" {
    var db = try testDb();
    defer db.deinit();
    var lock = try testLock(&db);
    defer lock.deinit();
    var output: [256]u8 = undefined;
    // A four-digit PIN, and one character short of the minimum.
    try std.testing.expectError(error.PasswordTooShort, lock.setPassword("{\"next\":\"1234\"}", null, &output));
    try std.testing.expectError(error.PasswordTooShort, lock.setPassword("{\"next\":\"1234567\"}", null, &output));
    try std.testing.expect(!lock.password_set);
    _ = try lock.setPassword("{\"next\":\"12345678\"}", null, &output);
    try std.testing.expect(lock.password_set);
}

test "a password set before the minimum was raised still unlocks" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    // The rows an older Sage left behind: a hash of "1234", written without
    // going through `setPassword`.
    var hash_buf: [256]u8 = undefined;
    const phc = try std.crypto.pwhash.argon2.strHash("1234", .{
        .allocator = std.testing.allocator,
        .params = .owasp_2id,
        .mode = .argon2id,
    }, &hash_buf, std.testing.io);
    const written = db.exec(&.{.{
        .sql = upsert_sql,
        .params = &.{ .{ .text = password_hash_key }, .{ .text = phc } },
    }});
    try std.testing.expect(written == .ok);

    // Raising the minimum refuses new short passwords; it does not strand the
    // people who already have one.
    var lock = try testLock(&db);
    defer lock.deinit();
    try std.testing.expect(!lock.unlocked);
    _ = try lock.unlockPassword("{\"password\":\"1234\"}", &output);
    try std.testing.expect(lock.unlocked);
    try std.testing.expectError(error.PasswordTooShort, lock.setPassword("{\"current\":\"1234\",\"next\":\"1234\"}", null, &output));
}

test "five wrong guesses start a five second wait" {
    var db = try testDb();
    defer db.deinit();
    var output: [512]u8 = undefined;
    {
        var lock = try testLock(&db);
        defer lock.deinit();
        _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    }
    // A fresh process starts locked.
    var lock = try testLock(&db);
    defer lock.deinit();
    const start = testClockMs();
    lock.clock_ms = start;

    // The first five guesses each run the hash and answer immediately.
    try exhaustFreeAttempts(&lock, &output);

    // The sixth guess waits, and the right password is no exception.
    try std.testing.expectError(error.TooManyAttempts, lock.unlockPassword("{\"password\":\"correct horse\"}", &output));
    try std.testing.expect(!lock.unlocked);
    // The page reads the wait from the status, so it can keep the button
    // disabled after a reload instead of counting from five again. The clock
    // is the seam, so the leftover is exactly one wait.
    const status = try lock.status(.{ .prompt = false, .biometrics = false }, false, false, false, .{}, &output);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"waitRemainingMs\":5000") != null);
    lock.clock_ms = start + retry_wait_ms - 1;
    try std.testing.expectError(error.TooManyAttempts, lock.unlockPassword("{\"password\":\"correct horse\"}", &output));
    lock.clock_ms = start + retry_wait_ms;
    _ = try lock.unlockPassword("{\"password\":\"correct horse\"}", &output);
    try std.testing.expect(lock.unlocked);
}

test "the wait survives a relaunch and repeats for every later guess" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    {
        var lock = try testLock(&db);
        defer lock.deinit();
        _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
        lock.clock_ms = testClockMs();
        try exhaustFreeAttempts(&lock, &output);
    }
    // Quitting Sage is not a way around the wait: the count and the deadline
    // are rows in the database.
    var lock = try testLock(&db);
    defer lock.deinit();
    try std.testing.expectEqual(@as(u32, free_attempts), lock.failed_attempts);
    try std.testing.expect(lock.waitRemainingMs() > 0);
    try std.testing.expectError(error.TooManyAttempts, lock.unlockPassword("{\"password\":\"correct horse\"}", &output));

    // Once the wait is over one guess is allowed, and a wrong one starts the
    // next wait instead of growing it.
    lock.clock_ms = lock.retry_after_ms;
    try std.testing.expectError(error.WrongPassword, lock.unlockPassword("{\"password\":\"wrong\"}", &output));
    try std.testing.expectEqual(@as(i64, retry_wait_ms), lock.waitRemainingMs());
    lock.clock_ms = lock.retry_after_ms;
    _ = try lock.unlockPassword("{\"password\":\"correct horse\"}", &output);
    try std.testing.expect(lock.unlocked);

    // The right password ends the streak, so the next wrong guess is free
    // again.
    try std.testing.expectEqual(@as(u32, 0), lock.failed_attempts);
    try std.testing.expectError(error.WrongPassword, lock.unlockPassword("{\"password\":\"wrong\"}", &output));
}

test "a stored wait is never longer than one wait" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    {
        var lock = try testLock(&db);
        defer lock.deinit();
        _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
        lock.clock_ms = testClockMs();
        try exhaustFreeAttempts(&lock, &output);
    }
    // A clock that jumped backwards leaves a deadline an hour away; the next
    // launch shortens it rather than locking the owner out.
    var wait_buf: [24]u8 = undefined;
    const far = try std.fmt.bufPrint(&wait_buf, "{d}", .{testClockMs() + 3_600_000});
    const written = db.exec(&.{.{
        .sql = upsert_sql,
        .params = &.{ .{ .text = retry_after_key }, .{ .text = far } },
    }});
    try std.testing.expect(written == .ok);

    var lock = try testLock(&db);
    defer lock.deinit();
    try std.testing.expect(lock.retry_after_ms <= lock.wallMs() + retry_wait_ms);
    try std.testing.expect(lock.waitRemainingMs() > 0);
    try std.testing.expectError(error.TooManyAttempts, lock.unlockPassword("{\"password\":\"correct horse\"}", &output));
}

test "disable removes the lock after verifying the password" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    {
        var lock = try testLock(&db);
        defer lock.deinit();
        _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
        try std.testing.expectError(error.CurrentPasswordRequired, lock.disable("{}", false, &output));
        try std.testing.expectError(error.WrongPassword, lock.disable("{\"password\":\"wrong\"}", false, &output));
        _ = try lock.disable("{\"password\":\"correct horse\"}", false, &output);
        try std.testing.expect(!lock.enabled());
    }
    var lock = try testLock(&db);
    defer lock.deinit();
    try std.testing.expect(lock.unlocked);
    try std.testing.expect(!lock.enabled());
}

test "touch id alone engages the lock and unlockTouchId opens it" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    {
        var lock = try testLock(&db);
        defer lock.deinit();
        _ = try lock.setTouchId("{\"enabled\":true}", false, &output);
        try std.testing.expect(lock.enabled());
    }
    var lock = try testLock(&db);
    defer lock.deinit();
    try std.testing.expect(!lock.unlocked);
    try std.testing.expect(lock.touch_id_enabled);
    try std.testing.expectError(error.NoPasswordSet, lock.unlockPassword("{\"password\":\"anything\"}", &output));
    lock.unlockTouchId();
    try std.testing.expect(lock.unlocked);
}

test "unlockTouchId does nothing when touch id is off" {
    var db = try testDb();
    defer db.deinit();
    var lock = try testLock(&db);
    defer lock.deinit();
    lock.unlocked = false;
    lock.unlockTouchId();
    try std.testing.expect(!lock.unlocked);
}

test "turning off touch id is refused when it is the last method and encryption is on" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    _ = try lock.setTouchId("{\"enabled\":true}", false, &output);
    // Turning it off would leave the data key with no owner.
    try std.testing.expectError(error.LastUnlockMethod, lock.setTouchId("{\"enabled\":false}", true, &output));
    try std.testing.expect(lock.touch_id_enabled);
    // The prompt completion checks the same rule, for a lock that gained
    // encryption while the sheet was up.
    try std.testing.expectError(error.LastUnlockMethod, lock.clearTouchId(true));
    try std.testing.expect(lock.touch_id_enabled);
}

test "turning off touch id with a password set requires that password" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    _ = try lock.setTouchId("{\"enabled\":true}", false, &output);

    try std.testing.expectError(error.CurrentPasswordRequired, lock.setTouchId("{\"enabled\":false}", true, &output));
    try std.testing.expectError(error.WrongPassword, lock.setTouchId("{\"enabled\":false,\"password\":\"wrong\"}", true, &output));
    // A refused proof leaves Touch ID exactly as it was.
    try std.testing.expect(lock.touch_id_enabled);

    _ = try lock.setTouchId("{\"enabled\":false,\"password\":\"correct horse\"}", true, &output);
    try std.testing.expect(!lock.touch_id_enabled);
    try std.testing.expect(lock.password_set);
    try std.testing.expect(lock.enabled());

    // The row is gone, so a fresh process reads Touch ID as off.
    var reloaded = try testLock(&db);
    defer reloaded.deinit();
    try std.testing.expect(!reloaded.touch_id_enabled);
}

test "turning off touch id with no password owes a fresh prompt" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    _ = try lock.setTouchId("{\"enabled\":true}", false, &output);

    // No password to check and no sheet to show from here: nothing is written
    // until the handler completes the prompt.
    try std.testing.expectError(error.TouchIdConfirmationRequired, lock.setTouchId("{\"enabled\":false}", false, &output));
    try std.testing.expect(lock.touch_id_enabled);

    try lock.clearTouchId(false);
    try std.testing.expect(!lock.touch_id_enabled);
    try std.testing.expect(!lock.enabled());
}

test "turning the lock off with no password owes a fresh prompt" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    _ = try lock.setTouchId("{\"enabled\":true}", false, &output);

    try std.testing.expectError(error.TouchIdConfirmationRequired, lock.disable("{}", false, &output));
    try std.testing.expect(lock.enabled());

    // Encryption turned on while the sheet was up: the unlock method has to
    // stay.
    try std.testing.expectError(error.EncryptionEnabled, lock.completeDisable(true));
    try std.testing.expect(lock.touch_id_enabled);

    try lock.completeDisable(false);
    try std.testing.expect(!lock.enabled());
    var reloaded = try testLock(&db);
    defer reloaded.deinit();
    try std.testing.expect(!reloaded.enabled());
}

test "disable refuses while encryption is on" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    try std.testing.expectError(error.EncryptionEnabled, lock.disable("{\"password\":\"correct horse\"}", true, &output));
    _ = try lock.disable("{\"password\":\"correct horse\"}", false, &output);
    try std.testing.expect(!lock.enabled());
}

test "changing the password re-wraps the data key" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var data_key: [vault_mod.data_key_len]u8 = undefined;
    {
        var lock = try testLock(&db);
        defer lock.deinit();
        var vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        _ = try lock.setPassword("{\"next\":\"first pass\"}", null, &output);
        try vault.enable("first pass");
        data_key = vault.dataKey().?;
        _ = try lock.setPassword("{\"current\":\"first pass\",\"next\":\"second pass\"}", &vault, &output);
        // Same data key, now wrapped under the new password.
        try std.testing.expectEqualSlices(u8, &data_key, &vault.dataKey().?);
    }
    // A fresh process: the old password fails both checks; the new one opens both.
    var lock = try testLock(&db);
    defer lock.deinit();
    var vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    try std.testing.expectError(error.WrongPassword, lock.unlockPassword("{\"password\":\"first pass\"}", &output));
    try std.testing.expectError(error.KeyUnwrapFailed, vault.unlockWithPassword("first pass"));
    _ = try lock.unlockPassword("{\"password\":\"second pass\"}", &output);
    try vault.unlockWithPassword("second pass");
    try std.testing.expectEqualSlices(u8, &data_key, &vault.dataKey().?);
}

/// A file-backed lock, vault, and store, so the rebuild can be checked against
/// the real `app.db` and `app.db-wal` bytes.
const FileRig = struct {
    lock: Lock,
    vault: vault_mod.Vault,
    store: journal.Store,

    /// Initializes in place: the lock and the vault borrow the store's
    /// database, so the rig must not move afterwards.
    fn init(self: *FileRig, data_dir: []const u8) !void {
        const open_result = try native_sdk.RelationalStore.openMigrated(std.testing.allocator, data_dir, &journal.migrations);
        var db = switch (open_result.outcome) {
            .ok => open_result.database.?,
            else => return error.SqliteMigrationFailed,
        };
        try journal.insertFixtureEntries(&db);
        self.store = journal.Store.init(std.testing.allocator, db);
        self.vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &self.store.db);
        self.store.vault = &self.vault;
        self.lock = try Lock.init(std.testing.allocator, std.testing.io, &self.store.db);
    }

    fn deinit(self: *FileRig) void {
        self.lock.deinit();
        self.vault.deinit();
        self.store.deinit();
    }
};

test "a password change leaves the old wrap in the file until the rebuild" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = ".keep", .data = "" });
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const keep_len = try tmp.dir.realPathFile(io, ".keep", &path_buf);
    const data_dir = std.fs.path.dirname(path_buf[0..keep_len]) orelse return error.NoDir;

    var rig: FileRig = undefined;
    try rig.init(data_dir);
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    // First password, then encryption on, then a rebuild, so the file holds
    // exactly the live wrap before the change.
    _ = try rig.lock.setPassword("{\"next\":\"first pass\"}", null, &output);
    try rig.vault.enable("first pass");
    try rig.store.setRowsEncrypted(true);
    try rig.vault.setRewritePending(false);
    try rig.store.scrubStorage();
    try rig.vault.setScrubPending(false);

    const old_wrap = try std.testing.allocator.dupe(u8, rig.vault.wrapped_key);
    defer std.testing.allocator.free(old_wrap);
    try std.testing.expect(try journal.dbFilesContain(tmp.dir, old_wrap));

    // The change commits the new wrap and marks the rebuild owed, but the old
    // wrap is still readable in the file until that rebuild runs.
    _ = try rig.lock.setPassword("{\"current\":\"first pass\",\"next\":\"second pass\"}", &rig.vault, &output);
    try std.testing.expect(rig.vault.scrub_pending);
    try std.testing.expect(try journal.dbFilesContain(tmp.dir, old_wrap));

    try rig.store.scrubStorage();
    try rig.vault.setScrubPending(false);
    try std.testing.expect(!try journal.dbFilesContain(tmp.dir, old_wrap));

    // The new password unwraps the journal key; the old one does not.
    const data_key = rig.vault.dataKey().?;
    try rig.vault.unlockWithPassword("second pass");
    try std.testing.expectEqualSlices(u8, &data_key, &rig.vault.dataKey().?);
    try std.testing.expectError(error.KeyUnwrapFailed, rig.vault.unlockWithPassword("first pass"));

    // A saved page still opens after the rebuild.
    const loaded = try rig.store.get("{\"id\":1,\"offset\":0}", &output);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "Morning walk") != null);
}

const test_recovery_key: [vault_mod.recovery_key_len]u8 = "7K2M9QXD3FHT8VWZ4BNC6PRG".*;

test "status reports the recovery key and FileVault" {
    var db = try testDb();
    defer db.deinit();
    var lock = try testLock(&db);
    defer lock.deinit();
    var output: [512]u8 = undefined;
    lock.recovered = true;
    const json = try lock.status(.{ .prompt = true, .biometrics = true }, true, false, false, .{
        .recovery_key_set = true,
        .recovery_key_rotate = true,
        .file_vault = .off,
    }, &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"recoveryKeySet\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"recoveryKeyRotate\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"recoveredSession\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"fileVault\":\"off\"") != null);
}

test "status tells a Touch ID sensor that is unusable right now from no sensor" {
    var db = try testDb();
    defer db.deinit();
    var lock = try testLock(&db);
    defer lock.deinit();
    var output: [512]u8 = undefined;

    // A sensor the Mac cannot reach at the moment, such as a closed lid over an
    // external display: no biometrics now, but the Mac has the hardware.
    const unusable = try lock.status(.{ .prompt = true, .biometrics = false, .hardware = true }, false, false, false, .{}, &output);
    try std.testing.expect(std.mem.indexOf(u8, unusable, "\"touchIdBiometrics\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, unusable, "\"touchIdHardware\":true") != null);

    // No sensor, or no finger enrolled: neither.
    const none = try lock.status(.{ .prompt = true, .biometrics = false }, false, false, false, .{}, &output);
    try std.testing.expect(std.mem.indexOf(u8, none, "\"touchIdBiometrics\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, none, "\"touchIdHardware\":false") != null);

    // Working biometrics always means the hardware is there.
    const working = try lock.status(.{ .prompt = true, .biometrics = true }, false, false, false, .{}, &output);
    try std.testing.expect(std.mem.indexOf(u8, working, "\"touchIdHardware\":true") != null);
}

test "a first password on an encrypted journal owes a fresh prompt" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    var vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    _ = try lock.setTouchId("{\"enabled\":true}", false, &output);
    try vault.enableWithRecovery(&test_recovery_key);

    // Nothing is written while the prompt is owed.
    try std.testing.expectError(error.TouchIdConfirmationRequired, lock.setPassword("{\"next\":\"correct horse\"}", &vault, &output));
    try std.testing.expect(!lock.password_set);
    try std.testing.expect(!vault.hasPasswordSlot());

    // A short password is refused before any prompt would show.
    try std.testing.expectError(error.PasswordTooShort, lock.setPassword("{\"next\":\"short\"}", &vault, &output));

    // Once the prompt succeeds, the password gets a slot of its own and the
    // recovery slot stays.
    _ = try lock.setPasswordTrusted("{\"next\":\"correct horse\"}", &vault, &output);
    try std.testing.expect(lock.password_set);
    try std.testing.expect(vault.hasPasswordSlot() and vault.hasRecoverySlot());
    const data_key = vault.dataKey().?;
    vault.lockMemory();
    try vault.unlockWithPassword("correct horse");
    try std.testing.expectEqualSlices(u8, &data_key, &vault.dataKey().?);
    vault.lockMemory();
    try vault.unlockWithRecovery("7K2M9QXD3FHT8VWZ4BNC6PRG");
    try std.testing.expectEqualSlices(u8, &data_key, &vault.dataKey().?);
}

test "a trusted session can change the password without the current one" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    var vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    _ = try lock.setPassword("{\"next\":\"forgotten pass\"}", null, &output);
    try vault.enable("forgotten pass");
    try std.testing.expectError(error.CurrentPasswordRequired, lock.setPassword("{\"next\":\"new password\"}", &vault, &output));
    _ = try lock.setPasswordTrusted("{\"next\":\"new password\"}", &vault, &output);
    _ = try lock.unlockPassword("{\"password\":\"new password\"}", &output);
    try std.testing.expectError(error.WrongPassword, lock.unlockPassword("{\"password\":\"forgotten pass\"}", &output));
    vault.lockMemory();
    try vault.unlockWithPassword("new password");
}

test "removing the password needs it, Touch ID, and a way back in" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    var vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();

    try std.testing.expectError(error.NoPasswordSet, lock.removePassword("{}", &vault, null, &output));
    _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    try vault.enable("correct horse");

    // Touch ID is what stands in for the password.
    try std.testing.expectError(error.LastUnlockMethod, lock.removePassword("{\"password\":\"correct horse\"}", &vault, null, &output));
    _ = try lock.setTouchId("{\"enabled\":true}", true, &output);

    try std.testing.expectError(error.CurrentPasswordRequired, lock.removePassword("{}", &vault, null, &output));
    try std.testing.expectError(error.WrongPassword, lock.removePassword("{\"password\":\"wrong\"}", &vault, null, &output));
    // Encrypted with no recovery slot and no new one: refused, nothing changes.
    try std.testing.expectError(error.RecoveryKeyRequired, lock.removePassword("{\"password\":\"correct horse\"}", &vault, null, &output));
    try std.testing.expect(lock.password_set and vault.hasPasswordSlot());

    const data_key = vault.dataKey().?;
    var bundle = try vault.wrapWithRecoveryKey(&test_recovery_key, &data_key);
    defer bundle.deinit(std.testing.allocator);
    _ = try lock.removePassword("{\"password\":\"correct horse\"}", &vault, &bundle, &output);
    try std.testing.expect(!lock.password_set);
    try std.testing.expect(lock.touch_id_enabled);
    try std.testing.expect(!vault.hasPasswordSlot());
    try std.testing.expect(vault.hasRecoverySlot());
    try std.testing.expect(vault.scrub_pending);
    try std.testing.expectError(error.NoPasswordSet, lock.unlockPassword("{\"password\":\"correct horse\"}", &output));

    // A fresh process sees the same: no hash, no password slot, the lock still
    // engaged by Touch ID, and the recovery key opens the vault.
    var relaunched_lock = try testLock(&db);
    defer relaunched_lock.deinit();
    var relaunched_vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &db);
    defer relaunched_vault.deinit();
    try std.testing.expect(relaunched_vault.enabled);
    try std.testing.expect(!relaunched_lock.password_set);
    try std.testing.expect(!relaunched_lock.unlocked);
    try relaunched_vault.unlockWithRecovery("7K2M9QXD3FHT8VWZ4BNC6PRG");
    try std.testing.expectEqualSlices(u8, &data_key, &relaunched_vault.dataKey().?);
}

test "removing the password with a recovery slot already saved needs no new key" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    var vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    _ = try lock.setTouchId("{\"enabled\":true}", false, &output);
    try vault.enable("correct horse");
    const data_key = vault.dataKey().?;
    var bundle = try vault.wrapWithRecoveryKey(&test_recovery_key, &data_key);
    defer bundle.deinit(std.testing.allocator);
    vault.applyRecoveryBundle(&bundle);

    // After an unlock with the recovery key the owner may have forgotten the
    // password, so the trusted path skips it.
    lock.recovered = true;
    _ = try lock.removePassword("{}", &vault, null, &output);
    try std.testing.expect(!lock.password_set and !vault.hasPasswordSlot() and vault.hasRecoverySlot());
}

test "removing the password with encryption off leaves Touch ID as the lock" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    {
        var lock = try testLock(&db);
        defer lock.deinit();
        var vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &db);
        defer vault.deinit();
        _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
        _ = try lock.setTouchId("{\"enabled\":true}", false, &output);
        _ = try lock.removePassword("{\"password\":\"correct horse\"}", &vault, null, &output);
        try std.testing.expect(!lock.password_set and lock.touch_id_enabled and lock.enabled());
    }
    var lock = try testLock(&db);
    defer lock.deinit();
    try std.testing.expect(!lock.password_set);
    try std.testing.expect(lock.touch_id_enabled);
    try std.testing.expect(!lock.unlocked);
}

test "the recovery key shares the password's wrong-guess wait" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    _ = try lock.setTouchId("{\"enabled\":true}", false, &output);
    lock.clock_ms = testClockMs();
    try lock.requireNoWait();
    var guess: u32 = 0;
    while (guess < free_attempts) : (guess += 1) lock.recordFailure();
    try std.testing.expectError(error.TooManyAttempts, lock.requireNoWait());
    lock.clearFailures();
    try lock.requireNoWait();
}

test "removing the password drops the old wrap from the file after the rebuild" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = ".keep", .data = "" });
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const keep_len = try tmp.dir.realPathFile(io, ".keep", &path_buf);
    const data_dir = std.fs.path.dirname(path_buf[0..keep_len]) orelse return error.NoDir;

    var rig: FileRig = undefined;
    try rig.init(data_dir);
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.lock.setPassword("{\"next\":\"first pass\"}", null, &output);
    _ = try rig.lock.setTouchId("{\"enabled\":true}", false, &output);
    try rig.vault.enable("first pass");
    try rig.store.setRowsEncrypted(true);
    try rig.vault.setRewritePending(false);
    try rig.store.scrubStorage();
    try rig.vault.setScrubPending(false);

    const old_wrap = try std.testing.allocator.dupe(u8, rig.vault.wrapped_key);
    defer std.testing.allocator.free(old_wrap);
    try std.testing.expect(try journal.dbFilesContain(tmp.dir, old_wrap));

    const data_key = rig.vault.dataKey().?;
    var bundle = try rig.vault.wrapWithRecoveryKey(&test_recovery_key, &data_key);
    defer bundle.deinit(std.testing.allocator);
    _ = try rig.lock.removePassword("{\"password\":\"first pass\"}", &rig.vault, &bundle, &output);
    try std.testing.expect(rig.vault.scrub_pending);

    try rig.store.scrubStorage();
    try rig.vault.setScrubPending(false);
    try std.testing.expect(!try journal.dbFilesContain(tmp.dir, old_wrap));

    // The journal still opens with the data key.
    const loaded = try rig.store.get("{\"id\":1,\"offset\":0}", &output);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "Morning walk") != null);
}

test "an unlock with the recovery key lasts until the session locks" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    _ = try lock.setTouchId("{\"enabled\":true}", false, &output);
    try std.testing.expectEqual(Proof.password, lock.proofRequired());

    lock.unlockRecovered();
    try std.testing.expect(lock.unlocked and lock.recovered);
    try std.testing.expectEqual(Proof.none, lock.proofRequired());

    try std.testing.expect(lock.lockSession());
    try std.testing.expect(!lock.recovered);
    try std.testing.expectEqual(Proof.password, lock.proofRequired());
}

test "proof falls back to a system prompt when no password is set" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    _ = try lock.setTouchId("{\"enabled\":true}", false, &output);
    try std.testing.expectEqual(Proof.prompt, lock.proofRequired());
    lock.recovered = true;
    try std.testing.expectEqual(Proof.none, lock.proofRequired());
}

test "turning the lock off ends a recovered session" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    lock.recovered = true;
    _ = try lock.disable("{\"password\":\"correct horse\"}", false, &output);
    try std.testing.expect(!lock.enabled());
    try std.testing.expect(!lock.recovered);

    // A lock set up later starts with no free pass: the next change needs the
    // password it just set.
    _ = try lock.setPassword("{\"next\":\"another horse\"}", null, &output);
    try std.testing.expectError(error.CurrentPasswordRequired, lock.setPassword("{\"next\":\"third horse\"}", null, &output));
}

test "turning off the last method ends a recovered session" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    _ = try lock.setTouchId("{\"enabled\":true}", false, &output);
    lock.recovered = true;
    try lock.clearTouchId(false);
    try std.testing.expect(!lock.enabled());
    try std.testing.expect(!lock.recovered);
}

test "a refused password removal writes nothing" {
    var db = try testDb();
    defer db.deinit();
    var output: [256]u8 = undefined;
    var lock = try testLock(&db);
    defer lock.deinit();
    var vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &db);
    defer vault.deinit();
    _ = try lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    _ = try lock.setTouchId("{\"enabled\":true}", false, &output);
    try vault.enable("correct horse");

    // The checks are what the handler runs before it touches the Keychain.
    try std.testing.expectError(error.WrongPassword, lock.checkRemovePassword("{\"password\":\"wrong\"}", &vault, true));
    try std.testing.expectError(error.CurrentPasswordRequired, lock.checkRemovePassword("{}", &vault, true));
    try std.testing.expectError(error.RecoveryKeyRequired, lock.checkRemovePassword("{\"password\":\"correct horse\"}", &vault, false));
    try lock.checkRemovePassword("{\"password\":\"correct horse\"}", &vault, true);
    try std.testing.expect(lock.password_set and vault.hasPasswordSlot());

    lock.recovered = true;
    try lock.checkRemovePassword("{}", &vault, true);
}
