//! First-launch setup state. Every value lives in the `app_setting` table
//! under an `onboarding.` key, next to the lock and vault rows, so setup needs
//! no migration. The page asks for changes through bridge commands, and the
//! core checks each one: it is the only place that writes these rows.

const std = @import("std");
const native_sdk = @import("native_sdk");
const journal = @import("journal.zig");
const ollama = @import("ollama.zig");

const relational = native_sdk.relational_store;

const state_key = "onboarding.state";
const step_key = "onboarding.step";
const method_key = "onboarding.method";
const encrypt_key = "onboarding.encrypt";
const downloads_key = "onboarding.downloads";
const reminders_shown_key = "onboarding.reminders_shown";
const reminder_last_at_key = "onboarding.reminder_last_at";
const reminders_off_key = "onboarding.reminders_off";

const upsert_sql = "INSERT INTO app_setting (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value;";

/// Sage asks at most this many times.
pub const max_reminders: u8 = 3;
/// The queue holds the two models setup needs, with room for a retry.
const max_downloads = 8;
const empty_downloads = "[]";

/// Where setup stands. A missing row means Sage has not decided yet.
pub const State = enum {
    active,
    done,
    skipped,

    pub fn parse(text: []const u8) ?State {
        return std.meta.stringToEnum(State, text);
    }
};

/// The screen setup was on, so a restart or a refresh opens it again.
pub const Step = enum {
    welcome,
    local_ai,
    protect,
    import,
    all_set,

    pub fn parse(text: []const u8) ?Step {
        return std.meta.stringToEnum(Step, text);
    }
};

/// How the person chose to unlock Sage on the Protect screen.
pub const Method = enum {
    touch_id,
    password,

    pub fn parse(text: []const u8) ?Method {
        return std.meta.stringToEnum(Method, text);
    }
};

pub const Onboarding = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    db: *native_sdk.RelationalStore,
    state: ?State = null,
    step: Step = .welcome,
    method: ?Method = null,
    /// The Encrypt my journal choice from the Protect screen.
    encrypt: bool = false,
    /// Model names still to download, as the JSON array the page saved. Empty
    /// text reads as `[]`.
    downloads: []u8 = &.{},
    reminders_shown: u8 = 0,
    /// Wall-clock milliseconds when the last reminder showed; zero means none.
    reminder_last_at_ms: i64 = 0,
    reminders_off: bool = false,
    /// Memory only. A refresh reloads the page but not this process, so these
    /// keep "not on the launch that ran setup" and "once per launch" true
    /// across a refresh.
    ran_setup_this_launch: bool = false,
    reminder_shown_this_launch: bool = false,
    /// Test seam: the wall clock to read instead of the real one.
    clock_ms: ?i64 = null,

    pub fn init(allocator: std.mem.Allocator, io: std.Io, db: *native_sdk.RelationalStore) !Onboarding {
        var onboarding: Onboarding = .{ .allocator = allocator, .io = io, .db = db };
        errdefer onboarding.deinit();
        try onboarding.load();
        return onboarding;
    }

    pub fn deinit(self: *Onboarding) void {
        if (self.downloads.len > 0) self.allocator.free(self.downloads);
        self.downloads = &.{};
    }

    fn wallMs(self: *const Onboarding) i64 {
        if (self.clock_ms) |fixed| return fixed;
        return std.Io.Clock.Timestamp.now(self.io, .real).raw.toMilliseconds();
    }

    fn load(self: *Onboarding) !void {
        var rows = journal.KvRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT key, value FROM app_setting WHERE key LIKE 'onboarding.%';",
            &.{},
            &rows,
            journal.KvRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        for (rows.rows.items) |row| {
            if (std.mem.eql(u8, row.key, state_key)) {
                self.state = State.parse(row.value);
            } else if (std.mem.eql(u8, row.key, step_key)) {
                self.step = Step.parse(row.value) orelse .welcome;
            } else if (std.mem.eql(u8, row.key, method_key)) {
                self.method = Method.parse(row.value);
            } else if (std.mem.eql(u8, row.key, encrypt_key)) {
                self.encrypt = std.mem.eql(u8, row.value, "true");
            } else if (std.mem.eql(u8, row.key, downloads_key)) {
                // A row that is not a list of model names reads as an empty
                // queue, the same as a database that never saved one.
                const canonical = canonicalDownloads(self.allocator, row.value) catch continue;
                try self.replaceDownloads(canonical);
            } else if (std.mem.eql(u8, row.key, reminders_shown_key)) {
                const count = std.fmt.parseInt(u8, row.value, 10) catch 0;
                self.reminders_shown = @min(count, max_reminders);
            } else if (std.mem.eql(u8, row.key, reminder_last_at_key)) {
                self.reminder_last_at_ms = std.fmt.parseInt(i64, row.value, 10) catch 0;
            } else if (std.mem.eql(u8, row.key, reminders_off_key)) {
                self.reminders_off = std.mem.eql(u8, row.value, "true");
            }
        }
    }

    /// Takes ownership of `owned`, which must come from `self.allocator`.
    fn replaceDownloads(self: *Onboarding, owned: []u8) !void {
        if (self.downloads.len > 0) self.allocator.free(self.downloads);
        self.downloads = owned;
    }

    /// Existing users never see setup: with no state row and some content of
    /// their own, Sage decides for them. Anything else is left for the page.
    pub fn settleExisting(self: *Onboarding, has_content: bool) !void {
        if (self.state != null or !has_content) return;
        try self.upsert(state_key, "done");
        self.state = .done;
    }

    /// Everything the page needs at launch, as JSON.
    pub fn writeStatus(self: *const Onboarding, output: []u8) ![]const u8 {
        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"state\":");
        if (self.state) |state| {
            try writer.print("\"{t}\"", .{state});
        } else {
            try writer.writeAll("null");
        }
        try writer.print(",\"step\":\"{t}\"", .{self.step});
        try writer.writeAll(",\"method\":");
        if (self.method) |method| {
            try writer.print("\"{t}\"", .{method});
        } else {
            try writer.writeAll("null");
        }
        try writer.print(",\"encrypt\":{}", .{self.encrypt});
        try writer.print(",\"downloads\":{s}", .{if (self.downloads.len == 0) empty_downloads else self.downloads});
        try writer.print(",\"remindersShown\":{d}", .{self.reminders_shown});
        try writer.print(",\"reminderLastAtMs\":{d}", .{self.reminder_last_at_ms});
        try writer.print(",\"remindersOff\":{}", .{self.reminders_off});
        try writer.print(",\"ranSetupThisLaunch\":{}", .{self.ran_setup_this_launch});
        try writer.print(",\"reminderShownThisLaunch\":{}", .{self.reminder_shown_this_launch});
        try writer.writeByte('}');
        return writer.buffered();
    }

    /// A partial update from the page: `state`, `step`, `method`, `encrypt`,
    /// and `downloads`, in any mix. Every value is checked before anything is
    /// written, and the rows go in one transaction, so a refused request
    /// changes nothing.
    pub fn save(self: *Onboarding, payload: []const u8, output: []u8) ![]const u8 {
        var parsed = std.json.parseFromSlice(std.json.Value, self.allocator, payload, .{}) catch return error.InvalidRequest;
        defer parsed.deinit();
        if (parsed.value != .object) return error.InvalidRequest;
        const fields = parsed.value.object;

        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const scratch = arena.allocator();

        var statements: std.ArrayList(relational.Statement) = .empty;
        var next_state: ?State = null;
        var next_step: ?Step = null;
        var next_method: ?Method = null;
        var next_encrypt: ?bool = null;
        var next_downloads: ?[]u8 = null;
        errdefer if (next_downloads) |owned| self.allocator.free(owned);

        if (fields.get("state")) |value| {
            if (value != .string) return error.InvalidRequest;
            const state = State.parse(value.string) orelse return error.InvalidRequest;
            if (!stateMayChange(self.state, state)) return error.InvalidRequest;
            next_state = state;
            try statements.append(scratch, .{ .sql = upsert_sql, .params = try params(scratch, state_key, @tagName(state)) });
        }
        if (fields.get("step")) |value| {
            if (value != .string) return error.InvalidRequest;
            const step = Step.parse(value.string) orelse return error.InvalidRequest;
            next_step = step;
            try statements.append(scratch, .{ .sql = upsert_sql, .params = try params(scratch, step_key, @tagName(step)) });
        }
        if (fields.get("method")) |value| {
            if (value != .string) return error.InvalidRequest;
            const method = Method.parse(value.string) orelse return error.InvalidRequest;
            next_method = method;
            try statements.append(scratch, .{ .sql = upsert_sql, .params = try params(scratch, method_key, @tagName(method)) });
        }
        if (fields.get("encrypt")) |value| {
            if (value != .bool) return error.InvalidRequest;
            next_encrypt = value.bool;
            try statements.append(scratch, .{ .sql = upsert_sql, .params = try params(scratch, encrypt_key, if (value.bool) "true" else "false") });
        }
        if (fields.get("downloads")) |value| {
            if (value != .array) return error.InvalidRequest;
            const owned = try downloadsFromValue(self.allocator, value.array.items);
            next_downloads = owned;
            try statements.append(scratch, .{ .sql = upsert_sql, .params = try params(scratch, downloads_key, owned) });
        }
        if (statements.items.len == 0) return error.InvalidRequest;

        const outcome = self.db.exec(statements.items);
        if (outcome != .ok) return error.SqliteWriteFailed;

        if (next_state) |state| {
            // Finishing or skipping setup is what makes this the launch that
            // ran it, so no reminder shows on top of the first Home.
            if (state != .active) self.ran_setup_this_launch = true;
            self.state = state;
        }
        if (next_step) |step| self.step = step;
        if (next_method) |method| self.method = method;
        if (next_encrypt) |encrypt| self.encrypt = encrypt;
        if (next_downloads) |owned| {
            next_downloads = null;
            try self.replaceDownloads(owned);
        }
        return okJson(output);
    }

    /// Count a reminder at the moment its dialog opens, so quitting with the
    /// dialog up still counts. Once per launch, even if the page reloads, and
    /// never past the limit.
    pub fn markReminderShown(self: *Onboarding, output: []u8) ![]const u8 {
        if (self.reminder_shown_this_launch) return error.ReminderAlreadyShown;
        if (self.reminders_off or self.reminders_shown >= max_reminders) return error.RemindersOff;
        const shown = self.reminders_shown + 1;
        const now = self.wallMs();
        var shown_buf: [8]u8 = undefined;
        var at_buf: [24]u8 = undefined;
        const shown_text = try std.fmt.bufPrint(&shown_buf, "{d}", .{shown});
        const at_text = try std.fmt.bufPrint(&at_buf, "{d}", .{now});
        const statements = [_]relational.Statement{
            .{ .sql = upsert_sql, .params = &.{ .{ .text = reminders_shown_key }, .{ .text = shown_text } } },
            .{ .sql = upsert_sql, .params = &.{ .{ .text = reminder_last_at_key }, .{ .text = at_text } } },
        };
        if (self.db.exec(&statements) != .ok) return error.SqliteWriteFailed;
        self.reminders_shown = shown;
        self.reminder_last_at_ms = now;
        self.reminder_shown_this_launch = true;
        return okJson(output);
    }

    /// Don't ask again.
    pub fn turnRemindersOff(self: *Onboarding, output: []u8) ![]const u8 {
        try self.upsert(reminders_off_key, "true");
        self.reminders_off = true;
        return okJson(output);
    }

    fn upsert(self: *Onboarding, key: []const u8, value: []const u8) !void {
        const outcome = self.db.exec(&.{.{
            .sql = upsert_sql,
            .params = &.{ .{ .text = key }, .{ .text = value } },
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
    }
};

/// Setup starts, then ends once. Done and skipped never go back: the reminder
/// flow runs on its own and leaves the state alone.
fn stateMayChange(current: ?State, next: State) bool {
    const from = current orelse return true;
    return switch (from) {
        .active => true,
        .done, .skipped => from == next,
    };
}

fn params(arena: std.mem.Allocator, key: []const u8, value: []const u8) ![]const relational.Value {
    const list = try arena.alloc(relational.Value, 2);
    list[0] = .{ .text = key };
    list[1] = .{ .text = value };
    return list;
}

/// The page's list of model names as the JSON text Sage stores. Refuses names
/// Ollama would not accept and lists longer than the queue ever gets.
fn downloadsFromValue(allocator: std.mem.Allocator, items: []const std.json.Value) ![]u8 {
    if (items.len > max_downloads) return error.InvalidRequest;
    var body = std.Io.Writer.Allocating.init(allocator);
    errdefer body.deinit();
    try body.writer.writeByte('[');
    for (items, 0..) |item, index| {
        if (item != .string or !ollama.validModelName(item.string)) return error.InvalidRequest;
        if (index > 0) try body.writer.writeByte(',');
        try journal.writeJsonStringStreaming(&body.writer, item.string);
    }
    try body.writer.writeByte(']');
    return body.toOwnedSlice();
}

fn canonicalDownloads(allocator: std.mem.Allocator, text: []const u8) ![]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, text, .{}) catch return error.InvalidRequest;
    defer parsed.deinit();
    if (parsed.value != .array) return error.InvalidRequest;
    return downloadsFromValue(allocator, parsed.value.array.items);
}

fn okJson(output: []u8) ![]const u8 {
    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"ok\":true}");
    return writer.buffered();
}

// --- tests ---

fn testDb() !native_sdk.RelationalStore {
    const open_result = try native_sdk.RelationalStore.openMemoryMigrated(std.testing.allocator, &journal.migrations);
    return switch (open_result.outcome) {
        .ok => open_result.database.?,
        else => error.SqliteMigrationFailed,
    };
}

fn expectContains(haystack: []const u8, needle: []const u8) !void {
    if (std.mem.indexOf(u8, haystack, needle) == null) {
        std.debug.print("missing {s} in {s}\n", .{ needle, haystack });
        return error.TestExpectedContains;
    }
}

test "a fresh database has no setup state" {
    var db = try testDb();
    defer db.deinit();
    var onboarding = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer onboarding.deinit();
    try std.testing.expect(onboarding.state == null);
    var output: [1024]u8 = undefined;
    const json = try onboarding.writeStatus(&output);
    try expectContains(json, "\"state\":null");
    try expectContains(json, "\"step\":\"welcome\"");
    try expectContains(json, "\"downloads\":[]");
    try expectContains(json, "\"remindersShown\":0");
}

test "saved setup rows survive a relaunch" {
    var db = try testDb();
    defer db.deinit();
    {
        var onboarding = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
        defer onboarding.deinit();
        var output: [64]u8 = undefined;
        _ = try onboarding.save(
            "{\"state\":\"active\",\"step\":\"protect\",\"method\":\"password\",\"encrypt\":true,\"downloads\":[\"nomic-embed-text\",\"qwen3.5:9b\"]}",
            &output,
        );
        _ = try onboarding.markReminderShown(&output);
        _ = try onboarding.turnRemindersOff(&output);
    }
    var reloaded = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer reloaded.deinit();
    try std.testing.expectEqual(State.active, reloaded.state.?);
    try std.testing.expectEqual(Step.protect, reloaded.step);
    try std.testing.expectEqual(Method.password, reloaded.method.?);
    try std.testing.expect(reloaded.encrypt);
    try std.testing.expectEqualStrings("[\"nomic-embed-text\",\"qwen3.5:9b\"]", reloaded.downloads);
    try std.testing.expectEqual(@as(u8, 1), reloaded.reminders_shown);
    try std.testing.expect(reloaded.reminder_last_at_ms > 0);
    try std.testing.expect(reloaded.reminders_off);
    // The per-launch flags are memory only: a new process starts clear.
    try std.testing.expect(!reloaded.ran_setup_this_launch);
    try std.testing.expect(!reloaded.reminder_shown_this_launch);
}

test "an existing user with entries or chats settles to done" {
    var db = try testDb();
    defer db.deinit();
    var onboarding = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer onboarding.deinit();
    try onboarding.settleExisting(true);
    try std.testing.expectEqual(State.done, onboarding.state.?);
    // Written, not just remembered.
    var reloaded = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer reloaded.deinit();
    try std.testing.expectEqual(State.done, reloaded.state.?);
    // Settling is not running setup, so a reminder may still show.
    try std.testing.expect(!onboarding.ran_setup_this_launch);
}

test "a new user with nothing saved is left for setup" {
    var db = try testDb();
    defer db.deinit();
    var onboarding = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer onboarding.deinit();
    try onboarding.settleExisting(false);
    try std.testing.expect(onboarding.state == null);
}

test "settling never overrides an active or skipped setup" {
    var db = try testDb();
    defer db.deinit();
    var onboarding = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer onboarding.deinit();
    var output: [64]u8 = undefined;
    _ = try onboarding.save("{\"state\":\"active\"}", &output);
    // Importing during setup adds entries; the person is still in setup.
    try onboarding.settleExisting(true);
    try std.testing.expectEqual(State.active, onboarding.state.?);
}

test "finishing or skipping setup marks this launch as the one that ran it" {
    var db = try testDb();
    defer db.deinit();
    var onboarding = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer onboarding.deinit();
    var output: [64]u8 = undefined;
    _ = try onboarding.save("{\"state\":\"active\",\"step\":\"welcome\"}", &output);
    try std.testing.expect(!onboarding.ran_setup_this_launch);
    _ = try onboarding.save("{\"state\":\"skipped\"}", &output);
    try std.testing.expect(onboarding.ran_setup_this_launch);
}

test "done and skipped never go back to active" {
    var db = try testDb();
    defer db.deinit();
    var onboarding = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer onboarding.deinit();
    var output: [64]u8 = undefined;
    _ = try onboarding.save("{\"state\":\"skipped\"}", &output);
    try std.testing.expectError(error.InvalidRequest, onboarding.save("{\"state\":\"active\"}", &output));
    try std.testing.expectError(error.InvalidRequest, onboarding.save("{\"state\":\"done\"}", &output));
    try std.testing.expectEqual(State.skipped, onboarding.state.?);
    // Saying the same thing again is fine.
    _ = try onboarding.save("{\"state\":\"skipped\"}", &output);
}

test "save refuses bad values and writes nothing" {
    var db = try testDb();
    defer db.deinit();
    var onboarding = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer onboarding.deinit();
    var output: [64]u8 = undefined;
    try std.testing.expectError(error.InvalidRequest, onboarding.save("not json", &output));
    try std.testing.expectError(error.InvalidRequest, onboarding.save("[]", &output));
    try std.testing.expectError(error.InvalidRequest, onboarding.save("{}", &output));
    try std.testing.expectError(error.InvalidRequest, onboarding.save("{\"step\":\"nowhere\"}", &output));
    try std.testing.expectError(error.InvalidRequest, onboarding.save("{\"method\":\"fingerprint\"}", &output));
    try std.testing.expectError(error.InvalidRequest, onboarding.save("{\"encrypt\":\"yes\"}", &output));
    try std.testing.expectError(error.InvalidRequest, onboarding.save("{\"downloads\":\"qwen3.5:9b\"}", &output));
    try std.testing.expectError(error.InvalidRequest, onboarding.save("{\"downloads\":[\"has space\"]}", &output));
    try std.testing.expectError(error.InvalidRequest, onboarding.save("{\"downloads\":[1]}", &output));
    // One good field next to a bad one is still refused as a whole.
    try std.testing.expectError(error.InvalidRequest, onboarding.save("{\"step\":\"protect\",\"state\":\"bogus\"}", &output));
    try std.testing.expectEqual(Step.welcome, onboarding.step);
    var reloaded = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer reloaded.deinit();
    try std.testing.expect(reloaded.state == null);
    try std.testing.expectEqual(Step.welcome, reloaded.step);
}

test "the download queue is capped" {
    var db = try testDb();
    defer db.deinit();
    var onboarding = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer onboarding.deinit();
    var output: [64]u8 = undefined;
    try std.testing.expectError(
        error.InvalidRequest,
        onboarding.save("{\"downloads\":[\"a\",\"b\",\"c\",\"d\",\"e\",\"f\",\"g\",\"h\",\"i\"]}", &output),
    );
    _ = try onboarding.save("{\"downloads\":[]}", &output);
    try std.testing.expectEqualStrings("[]", onboarding.downloads);
}

test "a damaged download row reads as an empty queue" {
    var db = try testDb();
    defer db.deinit();
    try std.testing.expectEqual(
        relational.Outcome.ok,
        db.exec(&.{.{
            .sql = upsert_sql,
            .params = &.{ .{ .text = downloads_key }, .{ .text = "{not a list" } },
        }}),
    );
    var onboarding = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer onboarding.deinit();
    var output: [256]u8 = undefined;
    try expectContains(try onboarding.writeStatus(&output), "\"downloads\":[]");
}

test "a reminder counts when it shows, once per launch, and stops at three" {
    var db = try testDb();
    defer db.deinit();
    var output: [64]u8 = undefined;
    var shown: u8 = 0;
    while (shown < max_reminders) : (shown += 1) {
        // Each iteration is a new launch.
        var onboarding = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
        defer onboarding.deinit();
        onboarding.clock_ms = 1_000 + @as(i64, shown) * 1_000;
        _ = try onboarding.markReminderShown(&output);
        try std.testing.expectEqual(shown + 1, onboarding.reminders_shown);
        try std.testing.expectEqual(1_000 + @as(i64, shown) * 1_000, onboarding.reminder_last_at_ms);
        // A page refresh in the same launch cannot count it twice.
        try std.testing.expectError(error.ReminderAlreadyShown, onboarding.markReminderShown(&output));
        try std.testing.expectEqual(shown + 1, onboarding.reminders_shown);
    }
    var fourth = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer fourth.deinit();
    try std.testing.expectEqual(max_reminders, fourth.reminders_shown);
    try std.testing.expectError(error.RemindersOff, fourth.markReminderShown(&output));
    try std.testing.expectEqual(max_reminders, fourth.reminders_shown);
}

test "Don't ask again stops reminders for good" {
    var db = try testDb();
    defer db.deinit();
    var output: [64]u8 = undefined;
    {
        var onboarding = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
        defer onboarding.deinit();
        _ = try onboarding.turnRemindersOff(&output);
    }
    var next = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer next.deinit();
    try std.testing.expect(next.reminders_off);
    try std.testing.expectError(error.RemindersOff, next.markReminderShown(&output));
    try std.testing.expectEqual(@as(u8, 0), next.reminders_shown);
}

test "a stored count past the limit is cut to three" {
    var db = try testDb();
    defer db.deinit();
    try std.testing.expectEqual(
        relational.Outcome.ok,
        db.exec(&.{.{
            .sql = upsert_sql,
            .params = &.{ .{ .text = reminders_shown_key }, .{ .text = "9" } },
        }}),
    );
    var onboarding = try Onboarding.init(std.testing.allocator, std.testing.io, &db);
    defer onboarding.deinit();
    try std.testing.expectEqual(max_reminders, onboarding.reminders_shown);
}
