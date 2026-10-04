const std = @import("std");
const journal = @import("journal.zig");

const max_file_name_bytes: usize = 255;
const untitled = "untitled";
const export_folder_prefix = "sage-export-";

/// The folder the export picker returned. `journal.export` writes to this
/// folder and nothing else, and only for one export: a second export has to
/// pick again. The web view never holds this state, so a script in it cannot
/// name a destination.
pub const PickedFolder = struct {
    path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined,
    len: usize = 0,

    pub fn remember(self: *PickedFolder, path: []const u8) !void {
        if (path.len == 0 or path.len > self.path_buf.len) return error.InvalidPath;
        if (!std.fs.path.isAbsolute(path)) return error.InvalidPath;
        @memcpy(self.path_buf[0..path.len], path);
        self.len = path.len;
    }

    pub fn forget(self: *PickedFolder) void {
        self.len = 0;
    }

    /// True when `dest_dir` is the picked folder, and consumes the pick.
    /// A refused folder leaves the pick in place, so a wrong path cannot
    /// cancel the export the user is setting up.
    pub fn take(self: *PickedFolder, dest_dir: []const u8) bool {
        if (self.len == 0 or !std.mem.eql(u8, self.path_buf[0..self.len], dest_dir)) return false;
        self.forget();
        return true;
    }
};

/// The first folder in an `OpenDialogResult.paths` list, which the platform
/// joins with newlines. Null when the list holds no path.
pub fn firstPath(paths: []const u8) ?[]const u8 {
    const end = std.mem.indexOfScalar(u8, paths, '\n') orelse paths.len;
    if (end == 0) return null;
    return paths[0..end];
}

const Tm = extern struct {
    tm_sec: c_int,
    tm_min: c_int,
    tm_hour: c_int,
    tm_mday: c_int,
    tm_mon: c_int,
    tm_year: c_int,
    tm_wday: c_int,
    tm_yday: c_int,
    tm_isdst: c_int,
    tm_gmtoff: c_long,
    tm_zone: ?[*:0]const u8,
};

extern "c" fn localtime_r(timer: *const std.c.time_t, result: *Tm) ?*Tm;

pub fn exportData(
    io: std.Io,
    store: *journal.Store,
    payload: []const u8,
    picked: *PickedFolder,
    output: []u8,
) ![]const u8 {
    var string_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    var used: usize = 0;
    const dest_dir = journal.jsonString(payload, "destDir", &string_buf, &used) orelse return error.InvalidRequest;
    if (dest_dir.len == 0 or !std.fs.path.isAbsolute(dest_dir)) return error.InvalidPath;
    // Only the folder the user picked in the export dialog is writable, and
    // only once. A script in the web view names paths freely; this is what
    // keeps that name from choosing the destination.
    if (!picked.take(dest_dir)) return error.DestinationNotPicked;

    var date_buf: [10]u8 = undefined;
    var folder_buf: [64]u8 = undefined;
    const folder = exportFolderName(todayLocalDate(io, &date_buf), &folder_buf);
    const export_dir = try std.fs.path.join(store.allocator, &.{ dest_dir, folder });
    defer store.allocator.free(export_dir);
    try std.Io.Dir.cwd().createDirPath(io, export_dir);

    const entries = try store.listExportMeta();
    defer store.freeExportMeta(entries);
    const entry_names = try assignFileNames(store.allocator, entries);
    defer freeStrings(store.allocator, entry_names);
    const conversations = try store.listChatExportMeta();
    defer store.freeChatExportMeta(conversations);

    const journal_path = try std.fs.path.join(store.allocator, &.{ export_dir, "journal" });
    defer store.allocator.free(journal_path);
    const conversations_path = try std.fs.path.join(store.allocator, &.{ export_dir, "conversations" });
    defer store.allocator.free(conversations_path);
    try std.Io.Dir.cwd().createDirPath(io, journal_path);
    try std.Io.Dir.cwd().createDirPath(io, conversations_path);

    var export_root = try std.Io.Dir.cwd().openDir(io, export_dir, .{});
    defer export_root.close(io);
    var journal_dir = try export_root.openDir(io, "journal", .{});
    defer journal_dir.close(io);
    var conversations_dir = try export_root.openDir(io, "conversations", .{});
    defer conversations_dir.close(io);

    for (entries, entry_names) |entry, name| {
        const loaded = try store.loadBody(entry.id);
        defer {
            store.allocator.free(loaded.body);
            store.allocator.free(loaded.format);
        }
        const markdown = try renderMarkdown(store.allocator, entry.title, entry.date, loaded.body);
        defer store.allocator.free(markdown);
        try journal_dir.writeFile(io, .{ .sub_path = name, .data = markdown });
    }

    for (conversations) |conversation| {
        const stem = try allocConversationStem(store.allocator, conversation);
        defer store.allocator.free(stem);
        const markdown_name = try std.fmt.allocPrint(store.allocator, "{s}.md", .{stem});
        defer store.allocator.free(markdown_name);
        const json_name = try std.fmt.allocPrint(store.allocator, "{s}.json", .{stem});
        defer store.allocator.free(json_name);

        // Stream both files so a long chat never sits in memory whole. Only
        // one page of events is live at a time.
        var transcript_file = try conversations_dir.createFile(io, markdown_name, .{});
        defer transcript_file.close(io);
        var transcript_buf: [8192]u8 = undefined;
        var transcript_writer = transcript_file.writer(io, &transcript_buf);
        const transcript = &transcript_writer.interface;
        try writeConversationMarkdownHeader(transcript, conversation);

        var archive_file = try conversations_dir.createFile(io, json_name, .{});
        defer archive_file.close(io);
        var archive_buf: [8192]u8 = undefined;
        var archive_writer = archive_file.writer(io, &archive_buf);
        const archive = &archive_writer.interface;
        try writeConversationJsonHeader(archive, conversation);

        var first_event = true;
        var first_message = true;
        var offset: i64 = 0;
        while (true) {
            var page = try store.chatExportEventPage(conversation.id, offset);
            const next_seq = page.next_seq;
            const done = page.done;
            {
                defer page.deinit(store.allocator);
                for (page.events) |event| {
                    if (!first_event) try archive.writeByte(',');
                    try archive.writeAll(event);
                    first_event = false;
                    try appendTranscriptMessage(store.allocator, transcript, event, &first_message);
                }
            }
            if (done) break;
            offset = next_seq;
        }
        try archive.writeAll("]}\n");
        try transcript.flush();
        try archive.flush();
    }

    var writer = std.Io.Writer.fixed(output);
    try writer.print("{{\"entries\":{d},\"conversations\":{d}}}", .{ entries.len, conversations.len });
    return writer.buffered();
}

fn allocConversationStem(allocator: std.mem.Allocator, conversation: journal.ChatExportMeta) ![]u8 {
    var title_buf: [max_file_name_bytes]u8 = undefined;
    var date_buf: [32]u8 = undefined;
    const title_slug = kebabCase(conversation.title, &title_buf);
    const date = conversationDate(conversation.created_at, &date_buf);
    var suffix_buf: [80]u8 = undefined;
    const suffix = try std.fmt.bufPrint(&suffix_buf, "-{s}-{d}", .{ date, conversation.id });
    // Leave enough room for either extension, with the longer .json name
    // determining the shared stem length.
    const max_stem = max_file_name_bytes - ".json".len;
    const max_title = if (suffix.len < max_stem) max_stem - suffix.len else 0;
    const take = @min(title_slug.len, max_title);
    return std.fmt.allocPrint(allocator, "{s}{s}", .{ title_slug[0..take], suffix });
}

fn conversationDate(created_at: []const u8, buf: []u8) []const u8 {
    if (created_at.len >= 10 and isDatePrefix(created_at[0..10])) return created_at[0..10];
    return kebabCase(created_at, buf);
}

fn isDatePrefix(value: []const u8) bool {
    if (value.len != 10) return false;
    for (value, 0..) |byte, index| {
        if (index == 4 or index == 7) {
            if (byte != '-') return false;
        } else if (!std.ascii.isDigit(byte)) {
            return false;
        }
    }
    return true;
}

fn writeConversationJsonHeader(writer: *std.Io.Writer, conversation: journal.ChatExportMeta) !void {
    try writer.writeAll("{\"id\":");
    try writer.print("{d}", .{conversation.id});
    try writer.writeAll(",\"title\":");
    try journal.writeJsonString(writer, conversation.title);
    try writer.writeAll(",\"eveSessionId\":");
    if (conversation.eve_session_id) |session_id| {
        try journal.writeJsonString(writer, session_id);
    } else {
        try writer.writeAll("null");
    }
    try writer.writeAll(",\"streamIndex\":");
    try writer.print("{d}", .{conversation.stream_index});
    try writer.writeAll(",\"model\":");
    try journal.writeJsonString(writer, conversation.model);
    try writer.writeAll(",\"thinking\":");
    if (conversation.thinking) |thinking| {
        try writer.writeAll(if (thinking) "true" else "false");
    } else {
        try writer.writeAll("null");
    }
    try writer.writeAll(",\"contextLength\":");
    if (conversation.context_length) |context_length| {
        try writer.print("{d}", .{context_length});
    } else {
        try writer.writeAll("null");
    }
    try writer.writeAll(",\"createdAt\":");
    try journal.writeJsonString(writer, conversation.created_at);
    try writer.writeAll(",\"updatedAt\":");
    try journal.writeJsonString(writer, conversation.updated_at);
    try writer.writeAll(",\"events\":[");
}

fn writeConversationMarkdownHeader(writer: *std.Io.Writer, conversation: journal.ChatExportMeta) !void {
    var flat_buf: [4096]u8 = undefined;
    const title = flattenTitle(conversation.title, &flat_buf);
    try writer.writeAll("---\ntitle: ");
    try journal.writeJsonString(writer, title);
    try writer.writeAll("\ncreatedAt: ");
    try journal.writeJsonString(writer, conversation.created_at);
    try writer.writeAll("\nupdatedAt: ");
    try journal.writeJsonString(writer, conversation.updated_at);
    try writer.writeAll("\n---\n\n");
}

fn appendTranscriptMessage(
    allocator: std.mem.Allocator,
    writer: *std.Io.Writer,
    raw_event: []const u8,
    first_message: *bool,
) !void {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, raw_event, .{ .allocate = .alloc_always }) catch return;
    defer parsed.deinit();
    if (parsed.value != .object) return;
    const event = parsed.value.object;
    const type_value = event.get("type") orelse return;
    if (type_value != .string) return;
    const role = if (std.mem.eql(u8, type_value.string, "message.received"))
        "User"
    else if (std.mem.eql(u8, type_value.string, "message.completed"))
        "Assistant"
    else
        return;
    const data_value = event.get("data") orelse return;
    if (data_value != .object) return;
    const message_value = data_value.object.get("message") orelse return;
    if (message_value != .string or std.mem.trim(u8, message_value.string, " \t\r\n").len == 0) return;

    if (!first_message.*) try writer.writeAll("\n\n");
    try writer.print("**{s}:**\n\n", .{role});
    try writer.writeAll(message_value.string);
    first_message.* = false;
}

fn assignFileNames(allocator: std.mem.Allocator, meta: []const journal.Store.ExportMeta) ![][]u8 {
    const names = try allocator.alloc([]u8, meta.len);
    var names_init: usize = 0;
    errdefer {
        for (names[0..names_init]) |name| allocator.free(name);
        allocator.free(names);
    }

    var counts = std.StringHashMap(usize).init(allocator);
    defer counts.deinit();

    const stems = try allocator.alloc([]u8, meta.len);
    var stems_init: usize = 0;
    defer {
        for (stems[0..stems_init]) |stem| allocator.free(stem);
        allocator.free(stems);
    }

    for (meta, 0..) |entry, index| {
        stems[index] = try allocStem(allocator, entry.title, entry.date);
        stems_init += 1;
        const gop = try counts.getOrPut(stems[index]);
        if (gop.found_existing) {
            gop.value_ptr.* += 1;
        } else {
            gop.value_ptr.* = 1;
        }
    }

    for (meta, stems, 0..) |entry, stem, index| {
        const duplicate = (counts.get(stem) orelse 1) > 1;
        names[index] = try allocFileName(allocator, entry.title, entry.date, if (duplicate) entry.id else null);
        names_init += 1;
    }
    return names;
}

fn allocStem(allocator: std.mem.Allocator, title: []const u8, date: []const u8) ![]u8 {
    var title_buf: [max_file_name_bytes]u8 = undefined;
    var date_buf: [max_file_name_bytes]u8 = undefined;
    const title_slug = kebabCase(title, &title_buf);
    const date_slug = kebabCase(date, &date_buf);
    return std.fmt.allocPrint(allocator, "{s}-{s}", .{ title_slug, date_slug });
}

fn allocFileName(allocator: std.mem.Allocator, title: []const u8, date: []const u8, id: ?i64) ![]u8 {
    var title_buf: [max_file_name_bytes]u8 = undefined;
    var date_buf: [32]u8 = undefined;
    const title_slug = kebabCase(title, &title_buf);
    const date_slug = kebabCase(date, &date_buf);
    var suffix_buf: [80]u8 = undefined;
    const suffix = if (id) |entry_id|
        try std.fmt.bufPrint(&suffix_buf, "-{s}-{d}.md", .{ date_slug, entry_id })
    else
        try std.fmt.bufPrint(&suffix_buf, "-{s}.md", .{date_slug});
    const max_title = if (suffix.len < max_file_name_bytes) max_file_name_bytes - suffix.len else 0;
    var take = @min(title_slug.len, max_title);
    if (take < title_slug.len) {
        while (take > 0 and (title_slug[take] & 0xC0) == 0x80) take -= 1;
    }
    const name = try allocator.alloc(u8, take + suffix.len);
    @memcpy(name[0..take], title_slug[0..take]);
    @memcpy(name[take..], suffix);
    return name;
}

fn kebabCase(input: []const u8, buf: []u8) []const u8 {
    var at: usize = 0;
    var pending_hyphen = false;
    for (input) |byte| {
        if (std.ascii.isAlphanumeric(byte)) {
            if (pending_hyphen and at > 0) {
                if (at >= buf.len) break;
                buf[at] = '-';
                at += 1;
            }
            if (at >= buf.len) break;
            buf[at] = std.ascii.toLower(byte);
            at += 1;
            pending_hyphen = false;
        } else if (at > 0) {
            pending_hyphen = true;
        }
    }
    if (at == 0) {
        const n = @min(untitled.len, buf.len);
        @memcpy(buf[0..n], untitled[0..n]);
        return buf[0..n];
    }
    return buf[0..at];
}

fn renderMarkdown(allocator: std.mem.Allocator, title: []const u8, date: []const u8, body: []const u8) ![]u8 {
    var title_buf: [4096]u8 = undefined;
    var yaml_buf: [4100]u8 = undefined;
    const flat = flattenTitle(title, &title_buf);
    const quoted = wrapYamlTitle(flat, &yaml_buf);
    return std.fmt.allocPrint(allocator, "---\ntitle: {s}\ndate: {s}\n---\n\n{s}", .{ quoted, date, body });
}

fn flattenTitle(title: []const u8, buf: []u8) []const u8 {
    var at: usize = 0;
    var last_space = true;
    for (title) |byte| {
        const space = byte == '\n' or byte == '\r' or byte == ' ' or byte == '\t';
        if (space) {
            if (last_space or at == 0) continue;
            if (at >= buf.len) break;
            buf[at] = ' ';
            at += 1;
            last_space = true;
            continue;
        }
        if (at >= buf.len) break;
        buf[at] = byte;
        at += 1;
        last_space = false;
    }
    if (at > 0 and buf[at - 1] == ' ') at -= 1;
    return buf[0..at];
}

fn looksQuoted(value: []const u8, mark: u8) bool {
    return value.len >= 2 and value[0] == mark and value[value.len - 1] == mark;
}

fn wrapYamlTitle(title: []const u8, buf: []u8) []const u8 {
    if (looksQuoted(title, '"') and title.len + 2 <= buf.len) {
        buf[0] = '\'';
        @memcpy(buf[1 .. 1 + title.len], title);
        buf[1 + title.len] = '\'';
        return buf[0 .. title.len + 2];
    }
    if (looksQuoted(title, '\'') and title.len + 2 <= buf.len) {
        buf[0] = '"';
        @memcpy(buf[1 .. 1 + title.len], title);
        buf[1 + title.len] = '"';
        return buf[0 .. title.len + 2];
    }
    return title;
}

/// `date` is `yyyy-MM-dd`; the folder name drops the hyphens.
fn exportFolderName(date: []const u8, buf: []u8) []const u8 {
    if (buf.len < export_folder_prefix.len) return buf[0..0];
    @memcpy(buf[0..export_folder_prefix.len], export_folder_prefix);
    var at: usize = export_folder_prefix.len;
    for (date) |byte| {
        if (byte == '-') continue;
        if (at >= buf.len) return buf[0..0];
        buf[at] = byte;
        at += 1;
    }
    return buf[0..at];
}

fn todayLocalDate(io: std.Io, buf: *[10]u8) []const u8 {
    const now = std.Io.Clock.real.now(io);
    return formatLocalDate(now.nanoseconds, buf);
}

fn formatLocalDate(nanoseconds: i128, buf: *[10]u8) []const u8 {
    const secs_i: i64 = @intCast(@divTrunc(nanoseconds, std.time.ns_per_s));
    if (secs_i < 0) return formatUtcDate(0, buf);
    var timer: std.c.time_t = @intCast(secs_i);
    var tm: Tm = undefined;
    if (localtime_r(&timer, &tm) != null) {
        const year: u16 = @intCast(tm.tm_year + 1900);
        const month: u8 = @intCast(tm.tm_mon + 1);
        const day: u8 = @intCast(tm.tm_mday);
        return std.fmt.bufPrint(buf, "{d:0>4}-{d:0>2}-{d:0>2}", .{ year, month, day }) catch "1970-01-01";
    }
    return formatUtcDate(@intCast(secs_i), buf);
}

fn formatUtcDate(secs: u64, buf: *[10]u8) []const u8 {
    const epoch = std.time.epoch.EpochSeconds{ .secs = secs };
    const year_day = epoch.getEpochDay().calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    return std.fmt.bufPrint(buf, "{d:0>4}-{d:0>2}-{d:0>2}", .{
        year_day.year,
        month_day.month.numeric(),
        month_day.day_index + 1,
    }) catch "1970-01-01";
}

fn freeStrings(allocator: std.mem.Allocator, items: [][]u8) void {
    for (items) |item| allocator.free(item);
    allocator.free(items);
}

fn destPayload(dest_dir: []const u8, buf: []u8) ![]const u8 {
    var writer = std.Io.Writer.fixed(buf);
    try writer.writeAll("{\"destDir\":");
    try journal.writeJsonString(&writer, dest_dir);
    try writer.writeByte('}');
    return writer.buffered();
}

fn tmpDestDir(tmp: *std.testing.TmpDir, buf: []u8) ![]const u8 {
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = ".keep", .data = "" });
    const keep_len = try tmp.dir.realPathFile(std.testing.io, ".keep", buf);
    return std.fs.path.dirname(buf[0..keep_len]) orelse return error.InvalidPath;
}

fn pickedFolder(dest_dir: []const u8) !PickedFolder {
    var picked: PickedFolder = .{};
    try picked.remember(dest_dir);
    return picked;
}

fn testExportRelPath(file: []const u8, buf: []u8) []const u8 {
    var date_buf: [10]u8 = undefined;
    var folder_buf: [64]u8 = undefined;
    const folder = exportFolderName(todayLocalDate(std.testing.io, &date_buf), &folder_buf);
    return std.fmt.bufPrint(buf, "{s}/journal/{s}", .{ folder, file }) catch unreachable;
}

fn testConversationRelPath(file: []const u8, buf: []u8) []const u8 {
    var date_buf: [10]u8 = undefined;
    var folder_buf: [64]u8 = undefined;
    const folder = exportFolderName(todayLocalDate(std.testing.io, &date_buf), &folder_buf);
    return std.fmt.bufPrint(buf, "{s}/conversations/{s}", .{ folder, file }) catch unreachable;
}

fn saveTestConversation(store: *journal.Store, title: []const u8, events: []const u8) !i64 {
    var payload_buf: [64 * 1024]u8 = undefined;
    var writer = std.Io.Writer.fixed(&payload_buf);
    try writer.writeAll("{\"id\":null,\"title\":");
    try journal.writeJsonString(&writer, title);
    try writer.writeAll(",\"eveSessionId\":\"eve-session-export\",\"streamIndex\":4,\"model\":\"llama3.2\",\"thinking\":true,\"contextLength\":16384,\"baseSeq\":0,\"offset\":0,\"chunk\":");
    try journal.writeJsonString(&writer, events);
    try writer.writeAll(",\"done\":true}");

    var output: [256]u8 = undefined;
    const response = try store.chatSave(writer.buffered(), &output);
    var parsed = try std.json.parseFromSlice(std.json.Value, store.allocator, response, .{ .allocate = .alloc_always });
    defer parsed.deinit();
    const id_value = parsed.value.object.get("id") orelse return error.TestUnexpectedResult;
    return switch (id_value) {
        .integer => |id| id,
        else => error.TestUnexpectedResult,
    };
}

fn testConversationEvents(allocator: std.mem.Allocator) ![]u8 {
    var writer = std.Io.Writer.Allocating.init(allocator);
    defer writer.deinit();
    try writer.writer.writeByte('[');
    for (0..40) |index| {
        if (index > 0) try writer.writer.writeByte(',');
        if (index == 1) {
            try writer.writer.writeAll("{\"type\":\"message.received\",\"data\":{\"message\":\"Question from the user\"}}");
        } else if (index == 39) {
            try writer.writer.writeAll("{\"type\":\"message.completed\",\"data\":{\"message\":\"Answer from Sage\"}}");
        } else if (index == 0) {
            try writer.writer.writeAll("{\"type\":\"session.started\",\"data\":{\"private\":\"preserve this event\"}}");
        } else {
            try writer.writer.print("{{\"type\":\"tool.result\",\"data\":{{\"index\":{d},\"value\":\"omit from transcript\"}}}}", .{index});
        }
    }
    try writer.writer.writeByte(']');
    return allocator.dupe(u8, writer.written());
}

test "kebabCase lowercases and hyphenates" {
    var buf: [64]u8 = undefined;
    try std.testing.expectEqualStrings("morning-walk", kebabCase("Morning walk", &buf));
    try std.testing.expectEqualStrings("2026-08-28", kebabCase("2026-08-28", &buf));
    try std.testing.expectEqualStrings("untitled", kebabCase("", &buf));
    try std.testing.expectEqualStrings("untitled", kebabCase("   ", &buf));
    try std.testing.expectEqualStrings("untitled", kebabCase("日本語", &buf));
    try std.testing.expectEqualStrings("hello-world", kebabCase("Hello---World", &buf));
}

test "firstPath takes the first folder the dialog returned" {
    try std.testing.expectEqualStrings("/Users/me/Notes", firstPath("/Users/me/Notes").?);
    try std.testing.expectEqualStrings("/Users/me/Notes", firstPath("/Users/me/Notes\n/Users/me/Other").?);
    try std.testing.expectEqual(@as(?[]const u8, null), firstPath(""));
}

test "PickedFolder remembers only an absolute folder" {
    var picked: PickedFolder = .{};
    try std.testing.expectError(error.InvalidPath, picked.remember(""));
    try std.testing.expectError(error.InvalidPath, picked.remember("Notes"));
    try picked.remember("/Users/me/Notes");
    try std.testing.expectEqualStrings("/Users/me/Notes", picked.path_buf[0..picked.len]);
    picked.forget();
    try std.testing.expectEqual(@as(usize, 0), picked.len);
}

test "renderMarkdown writes YAML front matter then the body" {
    const markdown = try renderMarkdown(std.testing.allocator, "Morning walk", "2026-08-28", "The fog sat low.");
    defer std.testing.allocator.free(markdown);
    try std.testing.expectEqualStrings(
        "---\ntitle: Morning walk\ndate: 2026-08-28\n---\n\nThe fog sat low.",
        markdown,
    );
}

test "wrapYamlTitle quotes titles that look quoted" {
    var buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("'\"Hello\"'", wrapYamlTitle("\"Hello\"", &buf));
    try std.testing.expectEqualStrings("\"'Hello'\"", wrapYamlTitle("'Hello'", &buf));
    try std.testing.expectEqualStrings("Hello", wrapYamlTitle("Hello", &buf));
}

test "renderMarkdown flattens newlines in the title" {
    const markdown = try renderMarkdown(std.testing.allocator, "Line\nbreak", "2026-08-28", "Body");
    defer std.testing.allocator.free(markdown);
    try std.testing.expectEqualStrings(
        "---\ntitle: Line break\ndate: 2026-08-28\n---\n\nBody",
        markdown,
    );
}

test "exportFolderName uses the export date" {
    var buf: [64]u8 = undefined;
    try std.testing.expectEqualStrings(
        "sage-export-20260910",
        exportFolderName("2026-09-10", &buf),
    );
}

test "allocFileName truncates a long title slug to 255 bytes" {
    const title = "a" ** 400;
    const name = try allocFileName(std.testing.allocator, title, "2026-09-08", null);
    defer std.testing.allocator.free(name);
    try std.testing.expectEqual(@as(usize, 255), name.len);
    try std.testing.expect(std.mem.endsWith(u8, name, "-2026-09-08.md"));
}

test "exportData writes kebab-named markdown under the dated folder" {
    var store = try testStore();
    defer store.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dest_dir = try tmpDestDir(&tmp, &path_buf);
    var payload_buf: [std.Io.Dir.max_path_bytes + 64]u8 = undefined;
    const payload = try destPayload(dest_dir, &payload_buf);

    var output: [64]u8 = undefined;
    var picked = try pickedFolder(dest_dir);
    const json = try exportData(std.testing.io, &store, payload, &picked, &output);
    try std.testing.expectEqualStrings("{\"entries\":3,\"conversations\":0}", json);
    // A fresh pick backs a repeat export; the files are rewritten in place.
    var repicked = try pickedFolder(dest_dir);
    const again = try exportData(std.testing.io, &store, payload, &repicked, &output);
    try std.testing.expectEqualStrings("{\"entries\":3,\"conversations\":0}", again);

    var rel_buf: [128]u8 = undefined;
    const morning = try tmp.dir.readFileAlloc(
        std.testing.io,
        testExportRelPath("morning-walk-2026-08-28.md", &rel_buf),
        std.testing.allocator,
        .limited(4096),
    );
    defer std.testing.allocator.free(morning);
    try std.testing.expect(std.mem.startsWith(u8, morning, "---\ntitle: Morning walk\ndate: 2026-08-28\n---\n\n"));
    try std.testing.expect(std.mem.indexOf(u8, morning, "The fog sat low") != null);

    const sage = try tmp.dir.readFileAlloc(
        std.testing.io,
        testExportRelPath("on-building-sage-2026-08-29.md", &rel_buf),
        std.testing.allocator,
        .limited(4096),
    );
    defer std.testing.allocator.free(sage);
    try std.testing.expect(std.mem.indexOf(u8, sage, "title: On building Sage") != null);
}

test "exportData writes transcripts and complete conversation event archives" {
    var store = try testStore();
    defer store.deinit();
    const events = try testConversationEvents(store.allocator);
    defer store.allocator.free(events);
    _ = try saveTestConversation(&store, "Chat export", events);
    _ = try saveTestConversation(&store, "Chat export", events);

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dest_dir = try tmpDestDir(&tmp, &path_buf);
    var payload_buf: [std.Io.Dir.max_path_bytes + 64]u8 = undefined;
    const payload = try destPayload(dest_dir, &payload_buf);

    var output: [128]u8 = undefined;
    var picked = try pickedFolder(dest_dir);
    const response = try exportData(std.testing.io, &store, payload, &picked, &output);
    try std.testing.expectEqualStrings("{\"entries\":3,\"conversations\":2}", response);

    const meta = try store.listChatExportMeta();
    defer store.freeChatExportMeta(meta);
    try std.testing.expectEqual(@as(usize, 2), meta.len);
    const first_stem = try allocConversationStem(store.allocator, meta[0]);
    defer store.allocator.free(first_stem);
    const second_stem = try allocConversationStem(store.allocator, meta[1]);
    defer store.allocator.free(second_stem);
    try std.testing.expect(!std.mem.eql(u8, first_stem, second_stem));

    const markdown_name = try std.fmt.allocPrint(store.allocator, "{s}.md", .{first_stem});
    defer store.allocator.free(markdown_name);
    var rel_buf: [512]u8 = undefined;
    const markdown = try tmp.dir.readFileAlloc(
        std.testing.io,
        testConversationRelPath(markdown_name, &rel_buf),
        store.allocator,
        .limited(8192),
    );
    defer store.allocator.free(markdown);
    try std.testing.expect(std.mem.indexOf(u8, markdown, "title: \"Chat export\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, markdown, "**User:**") != null);
    try std.testing.expect(std.mem.indexOf(u8, markdown, "Question from the user") != null);
    try std.testing.expect(std.mem.indexOf(u8, markdown, "**Assistant:**") != null);
    try std.testing.expect(std.mem.indexOf(u8, markdown, "Answer from Sage") != null);
    try std.testing.expect(std.mem.indexOf(u8, markdown, "omit from transcript") == null);
    try std.testing.expect(std.mem.indexOf(u8, markdown, "preserve this event") == null);

    const json_name = try std.fmt.allocPrint(store.allocator, "{s}.json", .{first_stem});
    defer store.allocator.free(json_name);
    const archive = try tmp.dir.readFileAlloc(
        std.testing.io,
        testConversationRelPath(json_name, &rel_buf),
        store.allocator,
        .limited(1024 * 1024),
    );
    defer store.allocator.free(archive);
    var parsed = try std.json.parseFromSlice(std.json.Value, store.allocator, archive, .{ .allocate = .alloc_always });
    defer parsed.deinit();
    const record = parsed.value.object;
    try std.testing.expectEqualStrings("Chat export", record.get("title").?.string);
    try std.testing.expectEqualStrings("eve-session-export", record.get("eveSessionId").?.string);
    try std.testing.expectEqualStrings("llama3.2", record.get("model").?.string);
    try std.testing.expectEqual(true, record.get("thinking").?.bool);
    try std.testing.expectEqual(@as(i64, 16384), record.get("contextLength").?.integer);
    try std.testing.expect(record.get("createdAt").?.string.len > 0);
    try std.testing.expect(record.get("updatedAt").?.string.len > 0);
    const archived_events = record.get("events").?.array.items;
    try std.testing.expectEqual(@as(usize, 40), archived_events.len);
    try std.testing.expectEqualStrings("tool.result", archived_events[20].object.get("type").?.string);
    try std.testing.expectEqualStrings(
        "preserve this event",
        archived_events[0].object.get("data").?.object.get("private").?.string,
    );

    const second_json_name = try std.fmt.allocPrint(store.allocator, "{s}.json", .{second_stem});
    defer store.allocator.free(second_json_name);
    const second_archive = try tmp.dir.readFileAlloc(
        std.testing.io,
        testConversationRelPath(second_json_name, &rel_buf),
        store.allocator,
        .limited(1024 * 1024),
    );
    defer store.allocator.free(second_archive);
    try std.testing.expect(std.mem.indexOf(u8, second_archive, "\"id\":2") != null);
}

test "exportData writes an empty archive for a conversation with no events" {
    var store = try testStore();
    defer store.deinit();
    _ = try saveTestConversation(&store, "Empty chat", "[]");

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dest_dir = try tmpDestDir(&tmp, &path_buf);
    var payload_buf: [std.Io.Dir.max_path_bytes + 64]u8 = undefined;
    const payload = try destPayload(dest_dir, &payload_buf);

    var output: [128]u8 = undefined;
    var picked = try pickedFolder(dest_dir);
    const response = try exportData(std.testing.io, &store, payload, &picked, &output);
    try std.testing.expectEqualStrings("{\"entries\":3,\"conversations\":1}", response);

    const meta = try store.listChatExportMeta();
    defer store.freeChatExportMeta(meta);
    const stem = try allocConversationStem(store.allocator, meta[0]);
    defer store.allocator.free(stem);
    const json_name = try std.fmt.allocPrint(store.allocator, "{s}.json", .{stem});
    defer store.allocator.free(json_name);
    var rel_buf: [512]u8 = undefined;
    const archive = try tmp.dir.readFileAlloc(
        std.testing.io,
        testConversationRelPath(json_name, &rel_buf),
        store.allocator,
        .limited(8192),
    );
    defer store.allocator.free(archive);
    var parsed = try std.json.parseFromSlice(std.json.Value, store.allocator, archive, .{ .allocate = .alloc_always });
    defer parsed.deinit();
    try std.testing.expectEqual(@as(usize, 0), parsed.value.object.get("events").?.array.items.len);
}

test "exportData appends id to every file that shares a stem" {
    var store = try testStore();
    defer store.deinit();
    var save_out: [256]u8 = undefined;
    _ = try store.save(
        "{\"id\":null,\"title\":\"Note\",\"date\":\"2026-09-08\",\"wordCount\":1,\"format\":\"markdown\",\"offset\":0,\"chunk\":\"First\",\"done\":true}",
        &save_out,
    );
    _ = try store.save(
        "{\"id\":null,\"title\":\"Note\",\"date\":\"2026-09-08\",\"wordCount\":1,\"format\":\"markdown\",\"offset\":0,\"chunk\":\"Second\",\"done\":true}",
        &save_out,
    );

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dest_dir = try tmpDestDir(&tmp, &path_buf);
    var payload_buf: [std.Io.Dir.max_path_bytes + 64]u8 = undefined;
    const payload = try destPayload(dest_dir, &payload_buf);

    var output: [64]u8 = undefined;
    var picked = try pickedFolder(dest_dir);
    const json = try exportData(std.testing.io, &store, payload, &picked, &output);
    try std.testing.expectEqualStrings("{\"entries\":5,\"conversations\":0}", json);

    var rel_buf: [128]u8 = undefined;
    const first = try tmp.dir.readFileAlloc(
        std.testing.io,
        testExportRelPath("note-2026-09-08-4.md", &rel_buf),
        std.testing.allocator,
        .limited(4096),
    );
    defer std.testing.allocator.free(first);
    try std.testing.expect(std.mem.indexOf(u8, first, "First") != null);

    const second = try tmp.dir.readFileAlloc(
        std.testing.io,
        testExportRelPath("note-2026-09-08-5.md", &rel_buf),
        std.testing.allocator,
        .limited(4096),
    );
    defer std.testing.allocator.free(second);
    try std.testing.expect(std.mem.indexOf(u8, second, "Second") != null);
}

test "exportData writes plaintext while encryption is on" {
    const vault_mod = @import("vault.zig");
    var store = try testStore();
    defer store.deinit();
    var vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &store.db);
    defer vault.deinit();
    store.vault = &vault;
    try vault.enable("correct horse");
    try store.setRowsEncrypted(true);

    var save_out: [256]u8 = undefined;
    _ = try store.save(
        "{\"id\":null,\"title\":\"Secret page\",\"date\":\"2026-09-06\",\"wordCount\":2,\"format\":\"markdown\",\"offset\":0,\"chunk\":\"Words nobody should read.\",\"done\":true}",
        &save_out,
    );

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dest_dir = try tmpDestDir(&tmp, &path_buf);
    var payload_buf: [std.Io.Dir.max_path_bytes + 64]u8 = undefined;
    const payload = try destPayload(dest_dir, &payload_buf);

    var output: [64]u8 = undefined;
    var picked = try pickedFolder(dest_dir);
    const json = try exportData(std.testing.io, &store, payload, &picked, &output);
    try std.testing.expectEqualStrings("{\"entries\":4,\"conversations\":0}", json);

    var rel_buf: [128]u8 = undefined;
    const secret = try tmp.dir.readFileAlloc(
        std.testing.io,
        testExportRelPath("secret-page-2026-09-06.md", &rel_buf),
        std.testing.allocator,
        .limited(4096),
    );
    defer std.testing.allocator.free(secret);
    try std.testing.expect(std.mem.indexOf(u8, secret, "title: Secret page") != null);
    try std.testing.expect(std.mem.indexOf(u8, secret, "Words nobody should read.") != null);
    try std.testing.expect(std.mem.indexOf(u8, secret, vault_mod.field_prefix) == null);

    const morning = try tmp.dir.readFileAlloc(
        std.testing.io,
        testExportRelPath("morning-walk-2026-08-28.md", &rel_buf),
        std.testing.allocator,
        .limited(4096),
    );
    defer std.testing.allocator.free(morning);
    try std.testing.expect(std.mem.indexOf(u8, morning, "title: Morning walk") != null);
    try std.testing.expect(std.mem.indexOf(u8, morning, "The fog sat low") != null);
}

test "exportData rejects a relative destDir" {
    var store = try testStore();
    defer store.deinit();
    var output: [64]u8 = undefined;
    var picked: PickedFolder = .{};
    try std.testing.expectError(
        error.InvalidPath,
        exportData(std.testing.io, &store, "{\"destDir\":\"relative/path\"}", &picked, &output),
    );
}

test "exportData refuses a folder the export picker did not return" {
    var store = try testStore();
    defer store.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var other_tmp = std.testing.tmpDir(.{});
    defer other_tmp.cleanup();

    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dest_dir = try tmpDestDir(&tmp, &path_buf);
    var other_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const other_dir = try tmpDestDir(&other_tmp, &other_buf);
    var payload_buf: [std.Io.Dir.max_path_bytes + 64]u8 = undefined;
    const payload = try destPayload(dest_dir, &payload_buf);

    var output: [64]u8 = undefined;

    // A script can name any folder. With no pick, that name is all it has.
    var unpicked: PickedFolder = .{};
    try std.testing.expectError(
        error.DestinationNotPicked,
        exportData(std.testing.io, &store, payload, &unpicked, &output),
    );

    // A pick for one folder does not authorize a different one, and the
    // refusal leaves the pick in place for the export it belongs to.
    var picked = try pickedFolder(other_dir);
    try std.testing.expectError(
        error.DestinationNotPicked,
        exportData(std.testing.io, &store, payload, &picked, &output),
    );
    try std.testing.expectEqualStrings(other_dir, picked.path_buf[0..picked.len]);

    // The picked folder itself still works.
    var matching = try pickedFolder(dest_dir);
    const json = try exportData(std.testing.io, &store, payload, &matching, &output);
    try std.testing.expectEqualStrings("{\"entries\":3,\"conversations\":0}", json);
}

test "exportData spends a pick on one export" {
    var store = try testStore();
    defer store.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dest_dir = try tmpDestDir(&tmp, &path_buf);
    var payload_buf: [std.Io.Dir.max_path_bytes + 64]u8 = undefined;
    const payload = try destPayload(dest_dir, &payload_buf);

    var output: [64]u8 = undefined;
    var picked = try pickedFolder(dest_dir);
    _ = try exportData(std.testing.io, &store, payload, &picked, &output);
    try std.testing.expectEqual(@as(usize, 0), picked.len);
    try std.testing.expectError(
        error.DestinationNotPicked,
        exportData(std.testing.io, &store, payload, &picked, &output),
    );
}

test "exportData leaves unrelated files in the dated folder" {
    var store = try testStore();
    defer store.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var rel_buf: [128]u8 = undefined;
    const keep_path = testExportRelPath("keep-me.txt", &rel_buf);
    try tmp.dir.createDirPath(std.testing.io, std.fs.path.dirname(keep_path).?);
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = keep_path, .data = "stay" });

    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dest_dir = try tmpDestDir(&tmp, &path_buf);
    var payload_buf: [std.Io.Dir.max_path_bytes + 64]u8 = undefined;
    const payload = try destPayload(dest_dir, &payload_buf);

    var output: [64]u8 = undefined;
    var picked = try pickedFolder(dest_dir);
    _ = try exportData(std.testing.io, &store, payload, &picked, &output);

    const kept = try tmp.dir.readFileAlloc(
        std.testing.io,
        testExportRelPath("keep-me.txt", &rel_buf),
        std.testing.allocator,
        .limited(64),
    );
    defer std.testing.allocator.free(kept);
    try std.testing.expectEqualStrings("stay", kept);
}

fn testStore() !journal.Store {
    const native_sdk = @import("native_sdk");
    const open_result = try native_sdk.RelationalStore.openMemoryMigrated(std.testing.allocator, &journal.migrations);
    const db = switch (open_result.outcome) {
        .ok => open_result.database.?,
        else => return error.SqliteMigrationFailed,
    };
    return journal.Store.init(std.testing.allocator, db);
}
