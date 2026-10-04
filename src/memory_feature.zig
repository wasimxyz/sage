const std = @import("std");

const marker_name = ".memory-feature-mode";
const temp_marker_name = ".memory-feature-mode.tmp";

pub const State = enum {
    unknown,
    enabled,
    disabled,
    disabling,
    enabling,
};

pub fn read(io: std.Io, allocator: std.mem.Allocator, data_dir: []const u8) !State {
    if (data_dir.len == 0) return .unknown;

    var dir = std.Io.Dir.openDirAbsolute(io, data_dir, .{}) catch |err| switch (err) {
        error.FileNotFound => return .unknown,
        else => return err,
    };
    defer dir.close(io);

    const marker = dir.readFileAlloc(io, marker_name, allocator, .limited(32)) catch |err| switch (err) {
        error.FileNotFound => return .unknown,
        else => return err,
    };
    defer allocator.free(marker);
    return parse(marker);
}

/// Replace the mode marker atomically so a crash cannot turn a completed
/// transition into an unknown state and repeat its destructive cleanup.
pub fn write(io: std.Io, data_dir: []const u8, state: State) !void {
    if (data_dir.len == 0) return error.DataDirectoryUnavailable;
    if (state == .unknown) return error.InvalidFeatureState;

    var dir = try std.Io.Dir.openDirAbsolute(io, data_dir, .{});
    defer dir.close(io);

    dir.deleteFile(io, temp_marker_name) catch |err| switch (err) {
        error.FileNotFound => {},
        else => return err,
    };
    errdefer dir.deleteFile(io, temp_marker_name) catch {};

    try dir.writeFile(io, .{
        .sub_path = temp_marker_name,
        .data = stateName(state),
        .flags = .{ .exclusive = true },
    });
    try dir.rename(temp_marker_name, dir, marker_name, io);
}

pub fn parse(marker: []const u8) State {
    const normalized = std.mem.trim(u8, marker, " \t\r\n");
    if (std.mem.eql(u8, normalized, "enabled")) return .enabled;
    if (std.mem.eql(u8, normalized, "disabled")) return .disabled;
    if (std.mem.eql(u8, normalized, "disabling")) return .disabling;
    if (std.mem.eql(u8, normalized, "enabling")) return .enabling;
    return .unknown;
}

fn stateName(state: State) []const u8 {
    return switch (state) {
        .unknown => unreachable,
        .enabled => "enabled\n",
        .disabled => "disabled\n",
        .disabling => "disabling\n",
        .enabling => "enabling\n",
    };
}

pub fn needsDisableReset(previous: State, enabled: bool) bool {
    if (enabled) return previous == .disabling;
    return previous != .disabled;
}

pub fn needsEnableRefresh(previous: State, enabled: bool) bool {
    return enabled and (previous == .disabled or previous == .enabling);
}

test "memory feature transition reset is only required on a mode change" {
    try std.testing.expect(needsDisableReset(.unknown, false));
    try std.testing.expect(needsDisableReset(.enabled, false));
    try std.testing.expect(needsDisableReset(.disabling, false));
    try std.testing.expect(!needsDisableReset(.disabled, false));
    try std.testing.expect(!needsDisableReset(.unknown, true));
    try std.testing.expect(needsDisableReset(.disabling, true));

    try std.testing.expect(needsEnableRefresh(.disabled, true));
    try std.testing.expect(needsEnableRefresh(.enabling, true));
    try std.testing.expect(!needsEnableRefresh(.enabled, true));
    try std.testing.expect(!needsEnableRefresh(.unknown, true));
    try std.testing.expect(!needsEnableRefresh(.disabled, false));
}

test "memory feature marker parses only known states" {
    try std.testing.expectEqual(State.enabled, parse("enabled\n"));
    try std.testing.expectEqual(State.disabled, parse("disabled\n"));
    try std.testing.expectEqual(State.disabling, parse("disabling\n"));
    try std.testing.expectEqual(State.enabling, parse("enabling\n"));
    try std.testing.expectEqual(State.unknown, parse("true"));
    try std.testing.expectEqual(State.unknown, parse(""));
}

test "memory feature marker persists complete states through atomic replacement" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = ".keep", .data = "" });
    const keep_len = try tmp.dir.realPathFile(std.testing.io, ".keep", &path_buf);
    const data_dir = std.fs.path.dirname(path_buf[0..keep_len]) orelse return error.InvalidPath;

    try std.testing.expectEqual(State.unknown, try read(std.testing.io, std.testing.allocator, data_dir));
    try write(std.testing.io, data_dir, .disabling);
    try std.testing.expectEqual(State.disabling, try read(std.testing.io, std.testing.allocator, data_dir));
    try write(std.testing.io, data_dir, .disabled);
    try std.testing.expectEqual(State.disabled, try read(std.testing.io, std.testing.allocator, data_dir));
    try write(std.testing.io, data_dir, .enabling);
    try std.testing.expectEqual(State.enabling, try read(std.testing.io, std.testing.allocator, data_dir));
    try write(std.testing.io, data_dir, .enabled);
    try std.testing.expectEqual(State.enabled, try read(std.testing.io, std.testing.allocator, data_dir));

    var dir = try std.Io.Dir.openDirAbsolute(std.testing.io, data_dir, .{});
    defer dir.close(std.testing.io);
    try std.testing.expectError(error.FileNotFound, dir.statFile(std.testing.io, temp_marker_name, .{}));
}
