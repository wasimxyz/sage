//! Apple's on-device speech engine (SpeechAnalyzer with SpeechTranscriber,
//! macOS 26 and later) behind `dictation.Backend`.
//!
//! The engine is Swift, in `src/speech/SageSpeech.swift`, built as
//! `libSageSpeech.dylib` for macOS 26. It is loaded here with `std.DynLib` and
//! never linked, because Sage itself runs on macOS 11 and later. On an older
//! Mac the loader refuses the library and dictation is unavailable.
//!
//! Where the library lives follows where the executable sits, the same rule the
//! bundled Ollama uses (`ollama_server.zig`):
//! - A Sage inside an app bundle loads `Contents/Frameworks/libSageSpeech.dylib`
//!   and never reads `SAGE_SPEECH_LIB_PATH`.
//! - Every other launch (`make dev`) loads the absolute path in
//!   `SAGE_SPEECH_LIB_PATH`.
const std = @import("std");
const builtin = @import("builtin");
const dictation = @import("dictation.zig");

pub const dev_library_env = "SAGE_SPEECH_LIB_PATH";
/// Relative to the app's `Contents` folder. Packaging copies the library here.
pub const bundled_rel_path = "Frameworks/libSageSpeech.dylib";
/// Must match `abiVersion` in SageSpeech.swift.
const abi_version: i32 = 2;
/// The first macOS with SpeechAnalyzer.
const minimum_macos_major: u32 = 26;

/// `<Contents>/Frameworks/libSageSpeech.dylib` for a binary inside an app
/// bundle. Unpackaged binaries get null.
pub fn bundledLibraryPath(exe_path: []const u8, buffer: []u8) ?[]u8 {
    const macos_dir = std.fs.path.dirname(exe_path) orelse return null;
    if (!std.mem.eql(u8, std.fs.path.basename(macos_dir), "MacOS")) return null;
    const contents_dir = std.fs.path.dirname(macos_dir) orelse return null;
    return std.fmt.bufPrint(buffer, "{s}/{s}", .{ contents_dir, bundled_rel_path }) catch null;
}

/// The library to load. A bundled app ignores the environment variable. Any
/// other launch takes an absolute path from it, or has no library.
pub fn libraryPath(exe_path: []const u8, dev_env_value: ?[]const u8, buffer: []u8) ?[]const u8 {
    if (bundledLibraryPath(exe_path, buffer)) |path| return path;
    const value = dev_env_value orelse return null;
    if (value.len == 0 or !std.fs.path.isAbsolute(value)) return null;
    return value;
}

/// Whether a macOS product version such as "15.4" is older than 26.
pub fn osTooOld(version: []const u8) bool {
    const dot = std.mem.indexOfScalar(u8, version, '.') orelse version.len;
    const major = std.fmt.parseInt(u32, version[0..dot], 10) catch return false;
    return major < minimum_macos_major;
}

// --- The library -------------------------------------------------------------

const ResultFn = *const fn (context: ?*anyopaque, kind: i32, text: ?[*]const u8, len: i32) callconv(.c) void;

const Api = struct {
    lib: std.DynLib,
    abi_version: *const fn () callconv(.c) i32,
    status: *const fn (state: *i32, fraction: *f64, message: [*]u8, capacity: i32) callconv(.c) i32,
    install: *const fn () callconv(.c) i32,
    begin: *const fn (callback: ResultFn, context: ?*anyopaque) callconv(.c) ?*anyopaque,
    feed: *const fn (handle: *anyopaque, samples: [*]const i16, count: i32) callconv(.c) void,
    finish: *const fn (handle: *anyopaque) callconv(.c) void,
    cancel: *const fn (handle: *anyopaque) callconv(.c) void,
    free: *const fn (handle: *anyopaque) callconv(.c) void,
};

const LoadState = union(enum) {
    unloaded,
    loaded: Api,
    unavailable: dictation.Unavailable,
};

var configured_io: ?std.Io = null;
var dev_path_buffer: [std.Io.Dir.max_path_bytes]u8 = undefined;
var dev_path_len: usize = 0;
var load_lock: std.atomic.Mutex = .unlocked;
var load_state: LoadState = .unloaded;

/// Say where to look for the library. Call once before anything else, on the
/// loop thread. `dev_path` is `SAGE_SPEECH_LIB_PATH`.
pub fn configure(io: std.Io, dev_path: ?[]const u8) void {
    configured_io = io;
    dev_path_len = 0;
    if (dev_path) |value| {
        if (value.len <= dev_path_buffer.len) {
            @memcpy(dev_path_buffer[0..value.len], value);
            dev_path_len = value.len;
        }
    }
}

const LoadResult = union(enum) {
    api: *const Api,
    unavailable: dictation.Unavailable,
};

/// Load the library once, waiting for another thread that is loading it. Safe
/// from any thread, but not for the loop thread: use `peek` there.
fn load() LoadResult {
    while (!load_lock.tryLock()) std.Thread.yield() catch {};
    defer load_lock.unlock();
    switch (load_state) {
        .loaded => return .{ .api = &load_state.loaded },
        .unavailable => |reason| return .{ .unavailable = reason },
        .unloaded => {},
    }
    load_state = loadLibrary();
    return switch (load_state) {
        .loaded => .{ .api = &load_state.loaded },
        .unavailable => |reason| .{ .unavailable = reason },
        .unloaded => unreachable,
    };
}

const PeekResult = union(enum) {
    api: *const Api,
    unavailable: dictation.Unavailable,
    /// Nobody has loaded the library yet, or a thread is loading it now.
    loading,
};

/// What `load` found, without loading anything or waiting for a thread that is.
/// The loop thread uses this, so it never waits on the speech engine.
fn peek() PeekResult {
    if (!load_lock.tryLock()) return .loading;
    defer load_lock.unlock();
    return switch (load_state) {
        .loaded => .{ .api = &load_state.loaded },
        .unavailable => |reason| .{ .unavailable = reason },
        .unloaded => .loading,
    };
}

fn loadLibrary() LoadState {
    if (comptime builtin.os.tag != .macos) return .{ .unavailable = .unsupported_os };
    const io = configured_io orelse return .{ .unavailable = .engine_missing };
    var exe_buffer: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const exe_len = std.process.executablePath(io, &exe_buffer) catch return .{ .unavailable = .engine_missing };
    var path_buffer: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dev_value: ?[]const u8 = if (dev_path_len > 0) dev_path_buffer[0..dev_path_len] else null;
    const path = libraryPath(exe_buffer[0..exe_len], dev_value, &path_buffer) orelse
        return .{ .unavailable = .engine_missing };

    // A file that is there but will not load is a library built for a newer
    // macOS than this one. A missing file is a Sage without its speech engine.
    std.Io.Dir.cwd().access(io, path, .{}) catch return .{ .unavailable = .engine_missing };
    var lib = std.DynLib.open(path) catch {
        var version_buffer: [32]u8 = undefined;
        if (macosVersion(&version_buffer)) |version| {
            if (osTooOld(version)) return .{ .unavailable = .unsupported_os };
        }
        return .{ .unavailable = .engine_missing };
    };
    const api = lookupApi(&lib) orelse {
        lib.close();
        return .{ .unavailable = .engine_missing };
    };
    if (api.abi_version() != abi_version) {
        lib.close();
        return .{ .unavailable = .engine_missing };
    }
    return .{ .loaded = api };
}

fn lookupApi(lib: *std.DynLib) ?Api {
    return .{
        .lib = lib.*,
        .abi_version = lib.lookup(@FieldType(Api, "abi_version"), "sage_speech_abi_version") orelse return null,
        .status = lib.lookup(@FieldType(Api, "status"), "sage_speech_status") orelse return null,
        .install = lib.lookup(@FieldType(Api, "install"), "sage_speech_install") orelse return null,
        .begin = lib.lookup(@FieldType(Api, "begin"), "sage_speech_begin") orelse return null,
        .feed = lib.lookup(@FieldType(Api, "feed"), "sage_speech_feed") orelse return null,
        .finish = lib.lookup(@FieldType(Api, "finish"), "sage_speech_finish") orelse return null,
        .cancel = lib.lookup(@FieldType(Api, "cancel"), "sage_speech_cancel") orelse return null,
        .free = lib.lookup(@FieldType(Api, "free"), "sage_speech_free") orelse return null,
    };
}

fn macosVersion(buffer: []u8) ?[]const u8 {
    if (comptime builtin.os.tag != .macos) return null;
    var size: usize = buffer.len;
    if (std.c.sysctlbyname("kern.osproductversion", buffer.ptr, &size, null, 0) != 0) return null;
    if (size == 0) return null;
    const len = if (buffer[size - 1] == 0) size - 1 else size;
    return std.mem.trim(u8, buffer[0..len], " \t\r\n");
}

// --- The backend -------------------------------------------------------------

/// The Apple engine as a `dictation.Backend`.
pub fn backend() dictation.Backend {
    return .{
        .status_fn = statusFn,
        .download_fn = downloadFn,
        .create_fn = createFn,
        .prime_fn = primeFn,
    };
}

/// Load the library and start asking the OS about the model, on another
/// thread. The loop thread never does either, so until this thread is done the
/// model reads as `checking`.
fn primeFn(context: ?*anyopaque) void {
    _ = context;
    const thread = std.Thread.spawn(.{}, primeMain, .{}) catch return;
    thread.detach();
}

fn primeMain() void {
    switch (load()) {
        // The first call starts the library's own check in the background.
        .api => |api| _ = readStatus(api),
        .unavailable => {},
    }
}

/// Answers at once, from what the library has cached. It never loads the
/// library and never waits for macOS, because the loop thread calls it.
fn statusFn(context: ?*anyopaque) dictation.EngineStatus {
    _ = context;
    const api = switch (peek()) {
        .api => |api| api,
        .unavailable => |reason| return .{ .unavailable = reason },
        .loading => return .{ .model = .checking },
    };
    return readStatus(api);
}

fn readStatus(api: *const Api) dictation.EngineStatus {
    var state: i32 = 0;
    var fraction: f64 = -1;
    var message: [192]u8 = undefined;
    const message_len = api.status(&state, &fraction, &message, message.len);
    return statusFromLibrary(state, fraction, message[0..@intCast(@min(@max(message_len, 0), message.len))]);
}

/// The library's model state as `dictation.EngineStatus`. The states are the
/// ones `sage_speech_status` documents in SageSpeech.swift.
fn statusFromLibrary(state: i32, fraction: f64, message: []const u8) dictation.EngineStatus {
    var status: dictation.EngineStatus = .{};
    switch (state) {
        // macOS has not said yet.
        0 => status.model = .checking,
        1 => status.model = .installed,
        3 => {
            status.model = .downloading;
            if (fraction >= 0) status.fraction = @floatCast(fraction);
        },
        4 => {
            status.model = .failed;
            if (message.len > 0) status.setMessage(message);
        },
        // This Mac has no speech model for English.
        5 => status.unavailable = .no_english,
        else => status.model = .missing,
    }
    return status;
}

fn downloadFn(context: ?*anyopaque) bool {
    _ = context;
    const api = switch (peek()) {
        .api => |api| api,
        // Nothing to download until the library is loaded and macOS has answered.
        .unavailable, .loading => return false,
    };
    return api.install() == 1;
}

fn createFn(context: ?*anyopaque, events: dictation.Events) anyerror!dictation.Engine {
    _ = context;
    const api = switch (load()) {
        .api => |api| api,
        .unavailable => return error.DictationUnavailable,
    };
    const engine = try std.heap.page_allocator.create(AppleEngine);
    engine.* = .{ .api = api, .events = events };
    return .{ .context = engine, .vtable = &AppleEngine.vtable };
}

/// One Swift session. The library reports from its own threads through
/// `report`, which only queues text.
const AppleEngine = struct {
    api: *const Api,
    events: dictation.Events,
    handle: ?*anyopaque = null,

    const vtable: dictation.Engine.VTable = .{
        .begin = begin,
        .feed = feed,
        .finish = finish,
        .cancel = cancel,
        .deinit = deinit,
    };

    fn from(context: *anyopaque) *AppleEngine {
        return @ptrCast(@alignCast(context));
    }

    fn begin(context: *anyopaque) anyerror!void {
        const self = from(context);
        self.handle = self.api.begin(report, self) orelse return error.EngineFailed;
    }

    fn feed(context: *anyopaque, samples: []const i16) void {
        const self = from(context);
        const handle = self.handle orelse return;
        if (samples.len == 0) return;
        self.api.feed(handle, samples.ptr, @intCast(samples.len));
    }

    fn finish(context: *anyopaque) void {
        const self = from(context);
        if (self.handle) |handle| self.api.finish(handle);
    }

    fn cancel(context: *anyopaque) void {
        const self = from(context);
        if (self.handle) |handle| self.api.cancel(handle);
    }

    /// `free` waits out any report in flight, so nothing calls `report` after
    /// this returns.
    fn deinit(context: *anyopaque) void {
        const self = from(context);
        if (self.handle) |handle| self.api.free(handle);
        std.heap.page_allocator.destroy(self);
    }
};

/// Kinds: 1 grey tail, 2 final, 3 ended, 4 failed. Runs on a Swift thread.
/// The text is valid only during the call and is copied by the queue.
fn report(context: ?*anyopaque, kind: i32, text: ?[*]const u8, len: i32) callconv(.c) void {
    const self: *AppleEngine = @ptrCast(@alignCast(context orelse return));
    const slice: []const u8 = if (text) |pointer| pointer[0..@intCast(@max(len, 0))] else "";
    switch (kind) {
        1 => self.events.volatileTail(slice),
        2 => self.events.final(slice),
        3 => self.events.ended(),
        4 => self.events.failed(),
        else => {},
    }
}

test "a bundled app loads its own library and ignores the environment" {
    var buffer: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path = libraryPath("/Applications/Sage.app/Contents/MacOS/Sage", "/tmp/elsewhere/libSageSpeech.dylib", &buffer).?;
    try std.testing.expectEqualStrings("/Applications/Sage.app/Contents/Frameworks/libSageSpeech.dylib", path);
}

test "any other launch takes the path from the environment" {
    var buffer: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path = libraryPath("/Users/me/sage/zig-out/bin/Sage", "/Users/me/sage/zig-out/lib/libSageSpeech.dylib", &buffer).?;
    try std.testing.expectEqualStrings("/Users/me/sage/zig-out/lib/libSageSpeech.dylib", path);
    try std.testing.expect(libraryPath("/Users/me/sage/zig-out/bin/Sage", null, &buffer) == null);
    try std.testing.expect(libraryPath("/Users/me/sage/zig-out/bin/Sage", "", &buffer) == null);
    try std.testing.expect(libraryPath("/Users/me/sage/zig-out/bin/Sage", "relative/libSageSpeech.dylib", &buffer) == null);
}

test "only an executable directly in MacOS counts as bundled" {
    var buffer: [std.Io.Dir.max_path_bytes]u8 = undefined;
    try std.testing.expect(bundledLibraryPath("/Users/me/MacOS-tools/Sage", &buffer) == null);
    try std.testing.expect(bundledLibraryPath("Sage", &buffer) == null);
}

test "macOS versions before 26 are too old" {
    try std.testing.expect(osTooOld("15.4"));
    try std.testing.expect(osTooOld("14"));
    try std.testing.expect(!osTooOld("26.0"));
    try std.testing.expect(!osTooOld("27.2"));
    try std.testing.expect(!osTooOld("beta"));
}

test "without a library the engine is missing" {
    const saved = load_state;
    defer load_state = saved;
    load_state = .unloaded;
    configure(std.testing.io, "/nonexistent/libSageSpeech.dylib");
    defer configure(std.testing.io, null);
    // The priming thread does this load in the app.
    _ = load();
    const status = statusFn(null);
    try std.testing.expect(status.unavailable != null);
    try std.testing.expectEqual(dictation.Unavailable.engine_missing, status.unavailable.?);
}

test "status never loads the library or waits for it" {
    const saved = load_state;
    defer load_state = saved;
    load_state = .unloaded;
    configure(std.testing.io, "/nonexistent/libSageSpeech.dylib");
    defer configure(std.testing.io, null);

    // Nothing has loaded the library yet, so the answer is "checking". Asking
    // does not load it.
    var status = statusFn(null);
    try std.testing.expectEqual(@as(?dictation.Unavailable, null), status.unavailable);
    try std.testing.expectEqual(dictation.ModelState.checking, status.model);
    try std.testing.expect(load_state == .unloaded);

    // A thread that is loading holds the lock. The answer is still immediate.
    try std.testing.expect(load_lock.tryLock());
    status = statusFn(null);
    load_lock.unlock();
    try std.testing.expectEqual(dictation.ModelState.checking, status.model);
    try std.testing.expect(!downloadFn(null));
}

test "the library's model states map to the engine status" {
    // macOS has not answered yet.
    try std.testing.expectEqual(dictation.ModelState.checking, statusFromLibrary(0, -1, "").model);
    try std.testing.expectEqual(dictation.ModelState.installed, statusFromLibrary(1, -1, "").model);
    try std.testing.expectEqual(dictation.ModelState.missing, statusFromLibrary(2, -1, "").model);
    try std.testing.expectEqual(dictation.ModelState.missing, statusFromLibrary(42, -1, "").model);

    const downloading = statusFromLibrary(3, 0.4, "");
    try std.testing.expectEqual(dictation.ModelState.downloading, downloading.model);
    try std.testing.expectApproxEqAbs(@as(f32, 0.4), downloading.fraction.?, 0.001);

    const failed = statusFromLibrary(4, -1, "It did not download.");
    try std.testing.expectEqual(dictation.ModelState.failed, failed.model);
    try std.testing.expectEqualStrings("It did not download.", failed.message().?);

    // A Mac with no English model can't dictate, and says why.
    const no_english = statusFromLibrary(5, -1, "");
    try std.testing.expectEqual(dictation.Unavailable.no_english, no_english.unavailable.?);
}

// --- Live test ---------------------------------------------------------------

const LiveCapture = struct {
    started: bool = false,
    stopped_reason: ?[]u8 = null,
    text_events: usize = 0,
    finals: std.ArrayList(u8) = .empty,
    last_seq: i64 = 0,
    seq_ok: bool = true,

    fn deinit(self: *LiveCapture) void {
        if (self.stopped_reason) |reason| std.testing.allocator.free(reason);
        self.finals.deinit(std.testing.allocator);
    }

    fn emit(context: ?*anyopaque, name: []const u8, payload: []const u8) void {
        const self: *LiveCapture = @ptrCast(@alignCast(context.?));
        var parsed = std.json.parseFromSlice(std.json.Value, std.testing.allocator, payload, .{}) catch return;
        defer parsed.deinit();
        if (std.mem.eql(u8, name, "dictation:started")) self.started = true;
        if (std.mem.eql(u8, name, "dictation:stopped")) {
            self.stopped_reason = std.testing.allocator.dupe(u8, parsed.value.object.get("reason").?.string) catch return;
        }
        if (std.mem.eql(u8, name, "dictation:text")) {
            self.text_events += 1;
            const seq = parsed.value.object.get("seq").?.integer;
            if (seq != self.last_seq + 1) self.seq_ok = false;
            self.last_seq = seq;
            const final = parsed.value.object.get("final").?.string;
            if (final.len > 0) {
                if (self.finals.items.len > 0) self.finals.append(std.testing.allocator, ' ') catch return;
                self.finals.appendSlice(std.testing.allocator, final) catch return;
            }
        }
    }
};

fn liveMicrophone() @import("microphone.zig").Status {
    return .granted;
}

// Runs only when `SAGE_SPEECH_LIB_PATH` names a built library and
// `SAGE_SPEECH_TEST_WAV` names a 16 kHz mono 16-bit WAV file. It feeds the
// file through a fake microphone and the whole controller path, with the real
// Apple engine. Use it after a macOS update to check that dictation still
// works. `SAGE_SPEECH_TEST_SECONDS` limits how much of the file is read.
test "live: the Apple engine turns a WAV into text through the controller" {
    const native_sdk = @import("native_sdk");
    const lib_path = std.testing.environ.getPosix(dev_library_env) orelse return error.SkipZigTest;
    const wav_path = std.testing.environ.getPosix("SAGE_SPEECH_TEST_WAV") orelse return error.SkipZigTest;
    const seconds: usize = if (std.testing.environ.getPosix("SAGE_SPEECH_TEST_SECONDS")) |text|
        std.fmt.parseInt(usize, text, 10) catch 20
    else
        20;

    const io = std.testing.io;
    const allocator = std.testing.allocator;
    const wav = try std.Io.Dir.cwd().readFileAlloc(io, wav_path, allocator, .limited(256 * 1024 * 1024));
    defer allocator.free(wav);
    // Find the data chunk. The format must be 16 kHz mono 16-bit.
    var at: usize = 12;
    var pcm: []const u8 = &.{};
    while (at + 8 <= wav.len) {
        const size = std.mem.readInt(u32, wav[at + 4 ..][0..4], .little);
        if (std.mem.eql(u8, wav[at..][0..4], "fmt ")) {
            try std.testing.expectEqual(@as(u16, 1), std.mem.readInt(u16, wav[at + 10 ..][0..2], .little));
            try std.testing.expectEqual(@as(u32, 16_000), std.mem.readInt(u32, wav[at + 12 ..][0..4], .little));
            try std.testing.expectEqual(@as(u16, 16), std.mem.readInt(u16, wav[at + 22 ..][0..2], .little));
        }
        if (std.mem.eql(u8, wav[at..][0..4], "data")) {
            pcm = wav[at + 8 ..][0..@min(size, wav.len - at - 8)];
            break;
        }
        at += 8 + size + (size & 1);
    }
    try std.testing.expect(pcm.len > 0);
    pcm = pcm[0..@min(pcm.len, seconds * 16_000 * 2)];

    const saved = load_state;
    defer load_state = saved;
    load_state = .unloaded;
    configure(io, lib_path);
    defer configure(io, null);

    // The loop thread never loads the library or waits for macOS, so load it as
    // the priming thread does and wait for the first answer.
    _ = load();
    var status = statusFn(null);
    var asked: usize = 0;
    while (status.model == .checking and asked < 500) : (asked += 1) {
        std.Io.sleep(io, .fromMilliseconds(10), .awake) catch {};
        status = statusFn(null);
    }
    try std.testing.expectEqual(@as(?dictation.Unavailable, null), status.unavailable);
    try std.testing.expectEqual(dictation.ModelState.installed, status.model);

    const platform = try native_sdk.NullPlatform.createWithOptions(.{}, .system, .{});
    defer platform.destroy();
    var capture: LiveCapture = .{};
    defer capture.deinit();
    var controller: dictation.Controller = .{};
    controller.setBackend(backend());
    const host: dictation.Host = .{
        .io = io,
        .services = platform.platform().services,
        .context = &capture,
        .emit_fn = LiveCapture.emit,
        .microphone_status_fn = liveMicrophone,
    };

    const session = try controller.start(host);
    // Feed 20 ms at a time, five times faster than a person talks.
    var fed: usize = 0;
    while (fed < pcm.len) {
        const chunk = @min(640, pcm.len - fed);
        _ = platform.pushAudioCapture(.microphone, 0, pcm[fed..][0..chunk]);
        fed += chunk;
        controller.drain(host);
        std.Io.sleep(io, .fromMilliseconds(4), .awake) catch {};
    }
    controller.stop(host, session, false);
    var waited: i64 = 0;
    while (capture.stopped_reason == null and waited < 20_000) : (waited += 10) {
        controller.drain(host);
        std.Io.sleep(io, .fromMilliseconds(10), .awake) catch {};
    }

    try std.testing.expect(capture.started);
    try std.testing.expect(capture.stopped_reason != null);
    try std.testing.expectEqualStrings("user", capture.stopped_reason.?);
    try std.testing.expect(capture.text_events > 0);
    try std.testing.expect(capture.seq_ok);
    // Only sizes and the like are printed. The text is the person's own voice.
    std.debug.print("live dictation: {d} text events, {d} bytes of final text\n", .{ capture.text_events, capture.finals.items.len });
    try std.testing.expect(capture.finals.items.len > 20);
    try std.testing.expect(controller.waitIdle(io, 5000));
}
