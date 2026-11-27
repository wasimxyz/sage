//! Keeps the display from going to sleep on its own while the microphone is on.
//!
//! Display sleep locks Sage, by design, and a lock ends dictation. On a Mac whose
//! display sleeps after a couple of minutes, a long spoken entry would be cut off
//! in the middle of a sentence, because speaking does not count as input. So
//! while dictation is listening, Sage holds a power assertion that stops the
//! display sleeping from idleness. It is released when the session ends, on a
//! lock, and on quit. A lid that closes, a real system sleep, and the screen
//! saver are not stopped by it, and still end dictation.
//!
//! The call is `IOPMAssertionCreateWithName` with
//! `kIOPMAssertionTypePreventUserIdleDisplaySleep`. IOKit and CoreFoundation are
//! opened at run time with `std.DynLib`, the way `microphone.zig` opens
//! AVFoundation, so the executable links neither. The loop thread is the only
//! caller. The assertion belongs to the process, so macOS drops it if Sage dies.
const std = @import("std");
const builtin = @import("builtin");

/// What the power assertion is called in `pmset -g assertions`.
pub const reason_text: [:0]const u8 = "Sage is dictating";
/// The value of `kIOPMAssertionTypePreventUserIdleDisplaySleep`.
const assertion_type: [:0]const u8 = "PreventUserIdleDisplaySleep";
/// `kIOPMAssertionLevelOn`.
const level_on: u32 = 255;
/// `kIOReturnSuccess`.
const io_success: i32 = 0;
/// `kCFStringEncodingUTF8`.
const utf8_encoding: u32 = 0x08000100;

/// Where assertions come from. Tests supply a fake.
pub const Api = struct {
    /// Creates the assertion and returns its id, or null when macOS refuses.
    create: *const fn () ?u32,
    /// Releases an assertion that `create` returned.
    release: *const fn (id: u32) void,
};

/// One assertion that is held or not. `set` is safe to call again with the same
/// value.
pub const Hold = struct {
    api: Api,
    id: ?u32 = null,

    pub fn held(self: *const Hold) bool {
        return self.id != null;
    }

    pub fn set(self: *Hold, on: bool) void {
        if (on) {
            if (self.id != null) return;
            // A refusal leaves nothing held. The next call tries again.
            self.id = self.api.create();
        } else if (self.id) |id| {
            self.api.release(id);
            self.id = null;
        }
    }
};

// --- The system --------------------------------------------------------------

const CreateFn = *const fn (kind: ?*anyopaque, level: u32, name: ?*anyopaque, id: *u32) callconv(.c) i32;
const ReleaseFn = *const fn (id: u32) callconv(.c) i32;
const MakeStringFn = *const fn (allocator: ?*anyopaque, text: [*:0]const u8, encoding: u32) callconv(.c) ?*anyopaque;

const System = struct {
    io_kit: std.DynLib,
    core_foundation: std.DynLib,
    create: CreateFn,
    release: ReleaseFn,
    /// Kept for the life of the process: two small strings, made once.
    kind: *anyopaque,
    name: *anyopaque,
};

var system: ?System = null;
var system_failed = false;

fn loadSystem() ?*const System {
    if (builtin.os.tag != .macos) return null;
    if (system != null) return &system.?;
    if (system_failed) return null;
    system = openSystem();
    if (system == null) {
        system_failed = true;
        return null;
    }
    return &system.?;
}

fn openSystem() ?System {
    var io_kit = std.DynLib.open("/System/Library/Frameworks/IOKit.framework/IOKit") catch return null;
    var core_foundation = std.DynLib.open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation") catch {
        io_kit.close();
        return null;
    };
    const found = lookupSystem(&io_kit, &core_foundation);
    if (found == null) {
        core_foundation.close();
        io_kit.close();
    }
    return found;
}

fn lookupSystem(io_kit: *std.DynLib, core_foundation: *std.DynLib) ?System {
    const create = io_kit.lookup(CreateFn, "IOPMAssertionCreateWithName") orelse return null;
    const release = io_kit.lookup(ReleaseFn, "IOPMAssertionRelease") orelse return null;
    const make = core_foundation.lookup(MakeStringFn, "CFStringCreateWithCString") orelse return null;
    const kind = make(null, assertion_type.ptr, utf8_encoding) orelse return null;
    const name = make(null, reason_text.ptr, utf8_encoding) orelse return null;
    return .{
        .io_kit = io_kit.*,
        .core_foundation = core_foundation.*,
        .create = create,
        .release = release,
        .kind = kind,
        .name = name,
    };
}

fn systemCreate() ?u32 {
    const api = loadSystem() orelse return null;
    var id: u32 = 0;
    if (api.create(api.kind, level_on, api.name, &id) != io_success) return null;
    return id;
}

fn systemRelease(id: u32) void {
    const api = loadSystem() orelse return;
    _ = api.release(id);
}

const system_api: Api = .{ .create = systemCreate, .release = systemRelease };

/// A test build never asks macOS for a real assertion, because a test that
/// starts dictation would hold the developer's display awake.
var test_ids: u32 = 0;

fn testCreate() ?u32 {
    test_ids += 1;
    return test_ids;
}

fn testRelease(id: u32) void {
    _ = id;
}

const test_api: Api = .{ .create = testCreate, .release = testRelease };

// --- The app's hold ----------------------------------------------------------

var app_hold: Hold = .{ .api = if (builtin.is_test) test_api else system_api };

/// Keep the display awake (true) or let it sleep again (false). Loop thread only.
pub fn set(on: bool) void {
    app_hold.set(on);
}

/// Whether the app holds the display awake right now.
pub fn held() bool {
    return app_hold.held();
}

// --- Tests -------------------------------------------------------------------

var fake_created: u32 = 0;
var fake_released: u32 = 0;
var fake_last_released: u32 = 0;
var fake_refuse: bool = false;

fn fakeCreate() ?u32 {
    if (fake_refuse) return null;
    fake_created += 1;
    return 40 + fake_created;
}

fn fakeRelease(id: u32) void {
    fake_released += 1;
    fake_last_released = id;
}

fn resetFake() void {
    fake_created = 0;
    fake_released = 0;
    fake_last_released = 0;
    fake_refuse = false;
}

test "the hold takes one assertion and gives it back" {
    resetFake();
    var hold: Hold = .{ .api = .{ .create = fakeCreate, .release = fakeRelease } };
    try std.testing.expect(!hold.held());

    hold.set(true);
    try std.testing.expect(hold.held());
    try std.testing.expectEqual(@as(u32, 1), fake_created);

    // Asking again takes no second assertion.
    hold.set(true);
    try std.testing.expectEqual(@as(u32, 1), fake_created);

    hold.set(false);
    try std.testing.expect(!hold.held());
    try std.testing.expectEqual(@as(u32, 1), fake_released);
    try std.testing.expectEqual(@as(u32, 41), fake_last_released);

    // Letting go twice releases once.
    hold.set(false);
    try std.testing.expectEqual(@as(u32, 1), fake_released);
}

test "a refused assertion holds nothing and is tried again" {
    resetFake();
    var hold: Hold = .{ .api = .{ .create = fakeCreate, .release = fakeRelease } };
    fake_refuse = true;
    hold.set(true);
    try std.testing.expect(!hold.held());
    // Nothing was taken, so there is nothing to give back.
    hold.set(false);
    try std.testing.expectEqual(@as(u32, 0), fake_released);

    fake_refuse = false;
    hold.set(true);
    try std.testing.expect(hold.held());
    hold.set(false);
    try std.testing.expectEqual(@as(u32, 1), fake_released);
}

test "a test build never asks macOS for an assertion" {
    try std.testing.expect(app_hold.api.create == test_api.create);
    set(true);
    try std.testing.expect(held());
    set(false);
    try std.testing.expect(!held());
}

// Runs only when `SAGE_DISPLAY_AWAKE_LIVE` is set. It takes the real assertion
// and asks `pmset -g assertions` whether macOS lists it, then gives it back and
// asks again. Use it after a macOS update to check the call still works.
test "live: macOS lists the assertion while it is held" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;
    if (std.testing.environ.getPosix("SAGE_DISPLAY_AWAKE_LIVE") == null) return error.SkipZigTest;

    var hold: Hold = .{ .api = system_api };
    hold.set(true);
    try std.testing.expect(hold.held());
    try std.testing.expect(try pmsetLists(reason_text));
    hold.set(false);
    try std.testing.expect(!hold.held());
    try std.testing.expect(!(try pmsetLists(reason_text)));
}

fn pmsetLists(needle: []const u8) !bool {
    const allocator = std.testing.allocator;
    const result = try std.process.run(allocator, std.testing.io, .{
        .argv = &.{ "/usr/bin/pmset", "-g", "assertions" },
    });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    return std.mem.indexOf(u8, result.stdout, needle) != null;
}
