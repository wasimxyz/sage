const std = @import("std");
const builtin = @import("builtin");
const journal = @import("journal.zig");

pub const max_file_bytes: usize = 1024 * 1024;

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

pub fn readFile(
    io: std.Io,
    allocator: std.mem.Allocator,
    payload: []const u8,
    picked_paths: []const u8,
    output: []u8,
) ![]const u8 {
    var string_buf: [65536]u8 = undefined;
    var used: usize = 0;
    const path = journal.jsonString(payload, "path", &string_buf, &used) orelse return error.InvalidRequest;
    const offset: usize = @intCast(journal.jsonI64(payload, "offset") orelse 0);

    if (!std.fs.path.isAbsolute(path)) return error.InvalidPath;
    if (!isPickedPath(picked_paths, path)) return error.FileNotPicked;
    if (!hasAllowedExtension(path)) return error.InvalidExtension;

    var file = std.Io.Dir.cwd().openFile(io, path, .{}) catch |err| switch (err) {
        error.FileNotFound => return error.FileNotFound,
        else => return err,
    };
    defer file.close(io);

    const stat = try file.stat(io);
    if (stat.size > max_file_bytes) return error.FileTooLarge;

    const created_ns = createdNanoseconds(file, stat.mtime);
    var created_buf: [10]u8 = undefined;
    var modified_buf: [10]u8 = undefined;
    const created = formatLocalDate(created_ns, &created_buf);
    const modified = formatLocalDate(stat.mtime.nanoseconds, &modified_buf);

    var read_buffer: [4096]u8 = undefined;
    var reader = file.reader(io, &read_buffer);
    const body = try reader.interface.allocRemaining(allocator, .limited(max_file_bytes));
    defer allocator.free(body);
    if (!std.unicode.utf8ValidateSlice(body)) return error.InvalidUtf8;

    const chunk = journal.utf8Chunk(body, offset, journal.chunk_bytes);
    const done = offset + chunk.len >= body.len;
    const name = std.fs.path.basename(path);

    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"name\":");
    try journal.writeJsonString(&writer, name);
    try writer.writeAll(",\"created\":");
    try journal.writeJsonString(&writer, created);
    try writer.writeAll(",\"modified\":");
    try journal.writeJsonString(&writer, modified);
    try writer.writeAll(",\"chunk\":");
    try journal.writeJsonString(&writer, chunk);
    try writer.writeAll(",\"done\":");
    try writer.writeAll(if (done) "true" else "false");
    try writer.writeByte('}');
    return writer.buffered();
}

/// Serializes the platform dialog's newline-separated paths into the array
/// shape the frontend expects. Requiring an exact count also rejects paths
/// containing newlines, which the platform representation cannot distinguish.
pub fn writeDialogPaths(paths: []const u8, expected_count: usize, output: []u8) ![]const u8 {
    if (paths.len == 0 or expected_count == 0) return error.InvalidPath;

    var writer = std.Io.Writer.fixed(output);
    try writer.writeByte('[');
    var count: usize = 0;
    var iterator = std.mem.splitScalar(u8, paths, '\n');
    while (iterator.next()) |path| {
        if (path.len == 0 or !std.fs.path.isAbsolute(path)) return error.InvalidPath;
        if (count > 0) try writer.writeByte(',');
        try journal.writeJsonString(&writer, path);
        count += 1;
    }
    if (count != expected_count) return error.InvalidPath;
    try writer.writeByte(']');
    return writer.buffered();
}

fn isPickedPath(picked_paths: []const u8, path: []const u8) bool {
    var iterator = std.mem.splitScalar(u8, picked_paths, '\n');
    while (iterator.next()) |picked| {
        if (std.mem.eql(u8, picked, path)) return true;
    }
    return false;
}

fn hasAllowedExtension(path: []const u8) bool {
    const ext = std.fs.path.extension(path);
    return std.ascii.eqlIgnoreCase(ext, ".md") or
        std.ascii.eqlIgnoreCase(ext, ".markdown") or
        std.ascii.eqlIgnoreCase(ext, ".txt");
}

fn createdNanoseconds(file: std.Io.File, mtime: std.Io.Timestamp) i128 {
    if (builtin.os.tag == .macos) {
        var st: std.c.Stat = undefined;
        if (std.c.fstat(file.handle, &st) == 0) {
            const birth = st.birthtime();
            if (birth.sec > 0) {
                return @as(i128, birth.sec) * std.time.ns_per_s + birth.nsec;
            }
        }
    }
    return mtime.nanoseconds;
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

fn absolutePayload(path: []const u8, offset: usize, buf: []u8) ![]const u8 {
    var writer = std.Io.Writer.fixed(buf);
    try writer.writeAll("{\"path\":");
    try journal.writeJsonString(&writer, path);
    try writer.writeAll(",\"offset\":");
    try writer.print("{d}", .{offset});
    try writer.writeByte('}');
    return writer.buffered();
}

test "readFile returns name created and body" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "note.md", .data = "# Hello\n\nBody text" });

    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path_len = try tmp.dir.realPathFile(std.testing.io, "note.md", &path_buf);
    const path = path_buf[0..path_len];

    var payload_buf: [std.Io.Dir.max_path_bytes + 64]u8 = undefined;
    const payload = try absolutePayload(path, 0, &payload_buf);

    var output: [8192]u8 = undefined;
    const json = try readFile(std.testing.io, std.testing.allocator, payload, path, &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"note.md\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"created\":\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"done\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Hello") != null);
}

test "writeDialogPaths returns the selected absolute paths as JSON" {
    var output: [256]u8 = undefined;
    const json = try writeDialogPaths("/tmp/one.md\n/tmp/two.txt", 2, &output);
    try std.testing.expectEqualStrings("[\"/tmp/one.md\",\"/tmp/two.txt\"]", json);
}

test "readFile refuses absolute paths absent from picker result" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "note.md", .data = "Private note" });

    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path_len = try tmp.dir.realPathFile(std.testing.io, "note.md", &path_buf);
    var payload_buf: [std.Io.Dir.max_path_bytes + 64]u8 = undefined;
    const payload = try absolutePayload(path_buf[0..path_len], 0, &payload_buf);

    var output: [256]u8 = undefined;
    try std.testing.expectError(
        error.FileNotPicked,
        readFile(std.testing.io, std.testing.allocator, payload, "", &output),
    );
}

test "readFile reports a missing file" {
    var payload_buf: [256]u8 = undefined;
    const payload = try absolutePayload("/tmp/sage-missing-import-file.md", 0, &payload_buf);
    var output: [256]u8 = undefined;
    try std.testing.expectError(
        error.FileNotFound,
        readFile(std.testing.io, std.testing.allocator, payload, "/tmp/sage-missing-import-file.md", &output),
    );
}
