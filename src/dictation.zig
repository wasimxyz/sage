//! Voice dictation. The Native SDK captures the microphone, an engine turns
//! the audio into text, and this file moves the text to the web view.
//!
//! Threads:
//! - The audio sink (`captureSink`) runs on the capture thread and, for the
//!   `started` event, on the loop thread. It takes no lock, allocates nothing,
//!   and never wakes the loop. It only writes the ring and a few atomics.
//! - One worker thread per session drains the ring into the engine every
//!   `worker_interval_ms`, watches for a silent microphone, and ends the
//!   session when the engine has settled.
//! - The engine reports text from its own threads. `pushResult` queues it under
//!   a short spin lock and wakes the loop.
//! - The loop thread starts and stops sessions, and `drain` turns queued text
//!   into window events. Anything queued for a session that is no longer
//!   current is dropped there.
//!
//! Audio is never written to a file, never logged, and never sent to the web
//! view, and nothing here logs text. In this file it lives in the ring, which
//! `Session.destroy` zeroes, and in the worker's scratch buffer, which is zeroed
//! when the worker ends. The Apple engine queues its own copies in
//! `SageSpeech.swift`, which zeroes the ones it made once it is done with them.
//! Two things are out of Sage's reach and are not zeroed: the Native SDK's own
//! capture buffers, and what the speech engine keeps inside itself.
const std = @import("std");
const native_sdk = @import("native_sdk");
const journal = @import("journal.zig");
const microphone = @import("microphone.zig");

pub const sample_rate: u32 = 16_000;
/// The ring holds about 60 s of audio, enough to ride out a slow engine start.
pub const ring_seconds: usize = 60;
pub const ring_samples: usize = sample_rate * ring_seconds;
/// The SDK delivers at most this many samples per push (3840 bytes of mono).
const max_push_samples: usize = native_sdk.platform.max_audio_capture_pcm_bytes / 2;

/// Window event detail is capped at 8 KiB. A final is cut into slices of at
/// most this many raw bytes, and the grey tail is clipped to its last
/// `max_volatile_bytes`. Both are JSON-escaped on the way out, so the worst
/// event is about 6.5 KiB.
pub const max_event_bytes: usize = 8192;
pub const max_final_slice_bytes: usize = 2048;
pub const max_volatile_bytes: usize = 1024;
const ellipsis = "…";

/// How often the worker drains the ring.
const worker_interval_ms: i64 = 20;
/// No new samples for this long after `started` ends the session.
pub const no_samples_ms: i64 = 2000;
/// How long Stop waits for the engine to settle what it already heard.
pub const settle_timeout_ms: i64 = 8000;
/// A drain of the ring never feeds more than this many samples at once.
const worker_chunk_samples: usize = sample_rate / 10;

// --- Reasons -----------------------------------------------------------------

/// Why a session ended, as the web view sees it in `dictation:stopped`.
pub const StopReason = enum {
    user,
    discarded,
    locked,
    quit,
    denied,
    no_input,
    input_lost,
    engine_failed,

    pub fn name(self: StopReason) []const u8 {
        return @tagName(self);
    }

    /// Text for the failure reasons. The others are the user's own doing.
    pub fn message(self: StopReason) ?[]const u8 {
        return switch (self) {
            .user, .discarded, .locked, .quit => null,
            .denied => "Sage can't use the microphone. Allow access in System Settings.",
            .no_input => "Sage can't find a working microphone.",
            .input_lost => "The microphone stopped sending sound, so dictation stopped.",
            .engine_failed => "Dictation stopped because the speech engine failed.",
        };
    }
};

/// Why the worker or the engine ended a session. The loop thread turns
/// `capture_failed` into `denied` or `no_input` by asking macOS.
const EndedReason = enum { user, capture_failed, input_lost, engine_failed };

pub const Unavailable = enum {
    unsupported_os,
    engine_missing,
    /// This Mac has no speech model for English.
    no_english,

    pub fn name(self: Unavailable) []const u8 {
        return @tagName(self);
    }
};

/// `checking` means the engine has not heard from macOS yet. It answers a
/// status call at once, so the loop thread never waits for the speech service.
pub const ModelState = enum { checking, installed, missing, downloading, failed };

pub const EngineStatus = struct {
    /// Set when this Mac can't dictate at all, so the mic is hidden.
    unavailable: ?Unavailable = null,
    model: ModelState = .missing,
    /// 0 to 1 while downloading.
    fraction: ?f32 = null,
    message_buffer: [192]u8 = undefined,
    message_len: u8 = 0,

    pub fn message(self: *const EngineStatus) ?[]const u8 {
        if (self.message_len == 0) return null;
        return self.message_buffer[0..self.message_len];
    }

    pub fn setMessage(self: *EngineStatus, text: []const u8) void {
        const len = @min(text.len, self.message_buffer.len);
        @memcpy(self.message_buffer[0..len], text[0..len]);
        self.message_len = @intCast(len);
    }
};

// --- Engine ------------------------------------------------------------------

/// What an engine reports. Every function is safe to call from any thread and
/// never waits on the loop thread.
pub const Events = struct {
    context: *anyopaque,
    /// Text that settled. Appended by the caller.
    final_fn: *const fn (context: *anyopaque, text: []const u8) void,
    /// The whole tail that is not final yet. It replaces the previous tail.
    volatile_fn: *const fn (context: *anyopaque, text: []const u8) void,
    /// The input finished and everything settled.
    ended_fn: *const fn (context: *anyopaque) void,
    /// The engine stopped and will report nothing more.
    failed_fn: *const fn (context: *anyopaque) void,

    pub fn final(self: Events, text: []const u8) void {
        self.final_fn(self.context, text);
    }
    pub fn volatileTail(self: Events, text: []const u8) void {
        self.volatile_fn(self.context, text);
    }
    pub fn ended(self: Events) void {
        self.ended_fn(self.context);
    }
    pub fn failed(self: Events) void {
        self.failed_fn(self.context);
    }
};

/// One speech engine session. The worker thread is the only caller of every
/// function here. `deinit` must not return while a report is still running.
pub const Engine = struct {
    context: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        begin: *const fn (context: *anyopaque) anyerror!void,
        feed: *const fn (context: *anyopaque, samples: []const i16) void,
        finish: *const fn (context: *anyopaque) void,
        cancel: *const fn (context: *anyopaque) void,
        deinit: *const fn (context: *anyopaque) void,
    };

    fn begin(self: Engine) !void {
        return self.vtable.begin(self.context);
    }
    fn feed(self: Engine, samples: []const i16) void {
        self.vtable.feed(self.context, samples);
    }
    fn finish(self: Engine) void {
        self.vtable.finish(self.context);
    }
    fn cancel(self: Engine) void {
        self.vtable.cancel(self.context);
    }
    fn deinit(self: Engine) void {
        self.vtable.deinit(self.context);
    }
};

/// A family of engines: what this Mac can do, the model download, and a new
/// session. The Apple engine is `speech_apple.zig`; tests use `FakeBackend`.
pub const Backend = struct {
    context: ?*anyopaque = null,
    status_fn: *const fn (context: ?*anyopaque) EngineStatus,
    /// Start the model download. False when there is nothing to start.
    download_fn: *const fn (context: ?*anyopaque) bool,
    create_fn: *const fn (context: ?*anyopaque, events: Events) anyerror!Engine,
    /// Warm the status answer in the background. Optional.
    prime_fn: ?*const fn (context: ?*anyopaque) void = null,
};

// --- The audio ring ----------------------------------------------------------

/// A single-producer, single-consumer ring of 16-bit samples. The producer is
/// the capture thread and the consumer is the worker. Neither takes a lock.
pub const Ring = struct {
    storage: []i16,
    /// Samples ever written. Only the producer stores it.
    head: std.atomic.Value(u64) = .init(0),
    /// Samples ever read. Only the consumer stores it.
    tail: std.atomic.Value(u64) = .init(0),
    overflowed: std.atomic.Value(bool) = .init(false),

    pub fn init(storage: []i16) Ring {
        return .{ .storage = storage };
    }

    pub fn len(self: *const Ring) usize {
        const head = self.head.load(.acquire);
        const tail = self.tail.load(.acquire);
        return @intCast(head - tail);
    }

    /// Producer side. Writes every sample or none. A chunk that does not fit
    /// marks the ring as overflowed and returns false.
    pub fn push(self: *Ring, samples: []const i16) bool {
        const capacity = self.storage.len;
        const head = self.head.load(.monotonic);
        const tail = self.tail.load(.acquire);
        const used: usize = @intCast(head - tail);
        if (samples.len > capacity - used) {
            self.overflowed.store(true, .release);
            return false;
        }
        const start: usize = @intCast(head % capacity);
        const first = @min(samples.len, capacity - start);
        @memcpy(self.storage[start..][0..first], samples[0..first]);
        if (first < samples.len) {
            @memcpy(self.storage[0 .. samples.len - first], samples[first..]);
        }
        self.head.store(head + samples.len, .release);
        return true;
    }

    /// Consumer side. Copies up to `out.len` samples and returns how many.
    pub fn pop(self: *Ring, out: []i16) usize {
        const capacity = self.storage.len;
        const tail = self.tail.load(.monotonic);
        const head = self.head.load(.acquire);
        const available: usize = @intCast(head - tail);
        const count = @min(available, out.len);
        if (count == 0) return 0;
        const start: usize = @intCast(tail % capacity);
        const first = @min(count, capacity - start);
        @memcpy(out[0..first], self.storage[start..][0..first]);
        if (first < count) {
            @memcpy(out[first..count], self.storage[0 .. count - first]);
        }
        self.tail.store(tail + count, .release);
        return count;
    }

    /// Zero the audio and start over. Call it only when neither side is
    /// running.
    pub fn clear(self: *Ring) void {
        std.crypto.secureZero(i16, self.storage);
        self.head.store(0, .release);
        self.tail.store(0, .release);
        self.overflowed.store(false, .release);
    }
};

// --- Text helpers ------------------------------------------------------------

/// Copy `raw` with control characters and bytes that are not valid UTF-8 turned
/// into spaces, then trim spaces from both ends. The result is safe to put in
/// a JSON string at one byte per byte (only `"` and `\` grow) and to cut at a
/// UTF-8 boundary.
pub fn cleanText(allocator: std.mem.Allocator, raw: []const u8) ![]u8 {
    var out = try allocator.alloc(u8, raw.len);
    errdefer allocator.free(out);
    var at: usize = 0;
    var write: usize = 0;
    while (at < raw.len) {
        const byte = raw[at];
        if (byte < 0x20 or byte == 0x7f) {
            out[write] = ' ';
            write += 1;
            at += 1;
            continue;
        }
        if (byte < 0x80) {
            out[write] = byte;
            write += 1;
            at += 1;
            continue;
        }
        const seq_len = std.unicode.utf8ByteSequenceLength(byte) catch {
            out[write] = ' ';
            write += 1;
            at += 1;
            continue;
        };
        if (at + seq_len <= raw.len and std.unicode.utf8ValidateSlice(raw[at..][0..seq_len])) {
            @memcpy(out[write..][0..seq_len], raw[at..][0..seq_len]);
            write += seq_len;
            at += seq_len;
        } else {
            out[write] = ' ';
            write += 1;
            at += 1;
        }
    }
    const trimmed = std.mem.trim(u8, out[0..write], " ");
    const result = try allocator.dupe(u8, trimmed);
    allocator.free(out);
    return result;
}

/// The grey tail as the web view gets it: the whole tail, or its last
/// `max_volatile_bytes` with a leading ellipsis, cut at a UTF-8 boundary.
fn clipVolatile(buffer: *[max_volatile_bytes + ellipsis.len]u8, tail: []const u8) []const u8 {
    if (tail.len <= max_volatile_bytes) return tail;
    var start = tail.len - max_volatile_bytes;
    while (start < tail.len and (tail[start] & 0xC0) == 0x80) start += 1;
    @memcpy(buffer[0..ellipsis.len], ellipsis);
    const rest = tail[start..];
    @memcpy(buffer[ellipsis.len..][0..rest.len], rest);
    return buffer[0 .. ellipsis.len + rest.len];
}

// --- Event JSON --------------------------------------------------------------

pub fn writeStartedEvent(buffer: []u8, session: u64) ![]const u8 {
    var writer = std.Io.Writer.fixed(buffer);
    try writer.print("{{\"session\":{d}}}", .{session});
    return writer.buffered();
}

pub fn writeTextEvent(buffer: []u8, session: u64, seq: u64, final: []const u8, grey: []const u8) ![]const u8 {
    var writer = std.Io.Writer.fixed(buffer);
    try writer.print("{{\"session\":{d},\"seq\":{d},\"final\":", .{ session, seq });
    try journal.writeJsonStringStreaming(&writer, final);
    try writer.writeAll(",\"volatile\":");
    try journal.writeJsonStringStreaming(&writer, grey);
    try writer.writeByte('}');
    return writer.buffered();
}

pub fn writeStoppedEvent(buffer: []u8, session: u64, reason: StopReason) ![]const u8 {
    var writer = std.Io.Writer.fixed(buffer);
    try writer.print("{{\"session\":{d},\"reason\":\"{s}\",\"message\":", .{ session, reason.name() });
    if (reason.message()) |text| {
        try journal.writeJsonStringStreaming(&writer, text);
    } else {
        try writer.writeAll("null");
    }
    try writer.writeByte('}');
    return writer.buffered();
}

// --- Host --------------------------------------------------------------------

/// What the controller needs from the app. Tests replace `emit_fn`.
pub const Host = struct {
    io: std.Io,
    services: ?native_sdk.platform.PlatformServices = null,
    context: ?*anyopaque = null,
    /// Send a window event to the web view.
    emit_fn: ?*const fn (context: ?*anyopaque, name: []const u8, payload: []const u8) void = null,
    /// A session ended. The app restarts its idle clock here.
    session_ended_fn: ?*const fn (context: ?*anyopaque) void = null,
    /// The microphone is really on (true), or the session that had it ended
    /// (false). The app keeps the display awake while it is on.
    listening_fn: ?*const fn (context: ?*anyopaque, on: bool) void = null,
    microphone_status_fn: *const fn () microphone.Status = microphone.status,

    fn emit(self: Host, name: []const u8, payload: []const u8) void {
        const emit_fn = self.emit_fn orelse return;
        emit_fn(self.context, name, payload);
    }

    fn sessionEnded(self: Host) void {
        const ended_fn = self.session_ended_fn orelse return;
        ended_fn(self.context);
    }

    fn setListening(self: Host, on: bool) void {
        const listening_fn = self.listening_fn orelse return;
        listening_fn(self.context, on);
    }
};

// --- Sessions ----------------------------------------------------------------

/// The results queue is touched by engine threads that Zig did not start, so it
/// uses a spin lock instead of `std.Io.Mutex`, which wants an `Io` and may park
/// the thread. The sections it guards are a few copies long.
const SpinLock = struct {
    locked: std.atomic.Value(bool) = .init(false),

    fn lock(self: *SpinLock) void {
        var spins: u32 = 0;
        while (self.locked.cmpxchgWeak(false, true, .acquire, .monotonic) != null) {
            spins += 1;
            if (spins < 64) {
                std.atomic.spinLoopHint();
            } else {
                std.Thread.yield() catch {};
            }
        }
    }

    fn unlock(self: *SpinLock) void {
        self.locked.store(false, .release);
    }
};

const ResultKind = enum { started, final, volatile_tail, ended };

const Result = struct {
    session: u64,
    kind: ResultKind,
    /// Allocated from `page_allocator`. Freed by whoever takes the result.
    text: []u8 = &.{},
    reason: EndedReason = .user,
};

const StopMode = enum(u8) { running, finish, cancel };
const EngineState = enum(u8) { running, ended, failed };

const Session = struct {
    id: u64,
    controller: *Controller,
    io: std.Io,
    services: native_sdk.platform.PlatformServices,
    ring: Ring,
    watchdog_ms: i64,
    settle_ms: i64 = settle_timeout_ms,
    engine: Engine = undefined,
    /// The loop thread and the worker each hold one.
    refs: std.atomic.Value(u32) = .init(2),
    stop_mode: std.atomic.Value(StopMode) = .init(.running),
    capture_started: std.atomic.Value(bool) = .init(false),
    capture_failed: std.atomic.Value(bool) = .init(false),
    engine_state: std.atomic.Value(EngineState) = .init(.running),

    // Loop thread only.
    finishing: bool = false,
    capture_stopped: bool = false,
    started_sent: bool = false,
    seq: u64 = 0,
    last_tail: [max_volatile_bytes + ellipsis.len]u8 = undefined,
    last_tail_len: usize = 0,

    fn release(self: *Session) void {
        if (self.refs.fetchSub(1, .acq_rel) == 1) self.destroy();
    }

    /// The last holder frees the audio, zeroed first.
    fn destroy(self: *Session) void {
        const controller = self.controller;
        const storage = self.ring.storage;
        self.ring.clear();
        std.heap.page_allocator.free(storage);
        std.heap.page_allocator.destroy(self);
        _ = controller.live_sessions.fetchSub(1, .release);
    }

    fn eventsSink(self: *Session) Events {
        return .{
            .context = self,
            .final_fn = engineFinal,
            .volatile_fn = engineVolatile,
            .ended_fn = engineEnded,
            .failed_fn = engineFailed,
        };
    }
};

fn sessionOf(context: *anyopaque) *Session {
    return @ptrCast(@alignCast(context));
}

fn engineFinal(context: *anyopaque, text: []const u8) void {
    const session = sessionOf(context);
    session.controller.pushResult(session, .final, text, .user);
}

fn engineVolatile(context: *anyopaque, text: []const u8) void {
    const session = sessionOf(context);
    session.controller.pushResult(session, .volatile_tail, text, .user);
}

fn engineEnded(context: *anyopaque) void {
    const session = sessionOf(context);
    session.engine_state.store(.ended, .release);
}

fn engineFailed(context: *anyopaque) void {
    const session = sessionOf(context);
    // Set the state first, so the worker stops feeding a dead engine.
    session.engine_state.store(.failed, .release);
    session.controller.pushResult(session, .ended, "", .engine_failed);
}

/// The SDK audio sink. It runs on the capture thread, and for the `started`
/// event on the loop thread inside `audioCaptureStart`. No lock, no
/// allocation, no wake: it writes the ring and sets flags the worker polls.
fn captureSink(context: ?*anyopaque, generation: u64, event: native_sdk.platform.AudioCaptureEvent) native_sdk.platform.AudioCapturePushResult {
    const session = sessionOf(context orelse return .closed);
    if (generation != session.id) return .closed;
    if (session.stop_mode.load(.acquire) == .cancel) return .closed;
    switch (event.kind) {
        .started => {
            session.capture_started.store(true, .release);
            return .accepted;
        },
        .failed => {
            session.capture_failed.store(true, .release);
            return .closed;
        },
        .data => {
            // Mono 16-bit. The bytes may not be aligned for i16, so copy.
            var samples: [max_push_samples]i16 = undefined;
            const count: usize = @min(@as(usize, event.frames), max_push_samples);
            if (event.pcm_s16le.len < count * 2) return .dropped_oversized;
            @memcpy(std.mem.sliceAsBytes(samples[0..count]), event.pcm_s16le[0 .. count * 2]);
            if (!session.ring.push(samples[0..count])) return .dropped_full;
            return .accepted;
        },
    }
}

pub const StartError = error{
    DictationBusy,
    DictationUnavailable,
    SpeechModelChecking,
    SpeechModelMissing,
    MicrophoneDenied,
    OutOfMemory,
};

pub const Controller = struct {
    backend: ?Backend = null,
    /// How long a started microphone may send nothing. Tests shorten it.
    watchdog_ms: i64 = no_samples_ms,
    /// How long Stop waits for the engine to settle. Tests shorten it.
    settle_ms: i64 = settle_timeout_ms,
    /// Samples in a session's ring. Tests shrink it.
    ring_len: usize = ring_samples,

    // Loop thread only.
    next_id: u64 = 0,
    current: ?*Session = null,

    results_lock: SpinLock = .{},
    results: std.ArrayList(Result) = .empty,
    /// Sessions that still own memory. Tests wait for this to reach zero.
    live_sessions: std.atomic.Value(u32) = .init(0),

    pub fn setBackend(self: *Controller, backend: Backend) void {
        self.backend = backend;
        if (backend.prime_fn) |prime| prime(backend.context);
    }

    /// Whether a session is running or settling, even if the microphone has
    /// not started yet.
    pub fn active(self: *const Controller) bool {
        return self.current != null;
    }

    /// Whether the microphone is really on: capture has started and the session
    /// has not ended. Auto-lock waits, and the display stays awake, only while
    /// it is. A session that is still waiting for the person to answer the
    /// macOS microphone prompt is not listening, and holds neither.
    pub fn listening(self: *const Controller) bool {
        const session = self.current orelse return false;
        return session.started_sent;
    }

    pub fn currentId(self: *const Controller) ?u64 {
        const session = self.current orelse return null;
        return session.id;
    }

    // --- Status ---

    pub fn engineStatus(self: *Controller) EngineStatus {
        const backend = self.backend orelse return .{ .unavailable = .engine_missing };
        return backend.status_fn(backend.context);
    }

    /// `{ available, reason, microphone, model: { state, fraction, message }, session }`
    pub fn writeStatus(self: *Controller, host: Host, writer: *std.Io.Writer) !void {
        const status = self.engineStatus();
        try writer.print("{{\"available\":{},\"reason\":", .{status.unavailable == null});
        if (status.unavailable) |reason| {
            try writer.print("\"{s}\"", .{reason.name()});
        } else {
            try writer.writeAll("null");
        }
        try writer.print(",\"microphone\":\"{s}\",\"model\":{{\"state\":\"{s}\",\"fraction\":", .{
            host.microphone_status_fn().name(),
            @tagName(status.model),
        });
        if (status.model == .downloading) {
            if (status.fraction) |fraction| {
                try writer.print("{d:.3}", .{std.math.clamp(fraction, 0, 1)});
            } else {
                try writer.writeAll("null");
            }
        } else {
            try writer.writeAll("null");
        }
        try writer.writeAll(",\"message\":");
        if (status.message()) |text| {
            try journal.writeJsonStringStreaming(writer, text);
        } else {
            try writer.writeAll("null");
        }
        try writer.writeAll("},\"session\":");
        if (self.currentId()) |id| {
            try writer.print("{d}", .{id});
        } else {
            try writer.writeAll("null");
        }
        try writer.writeByte('}');
    }

    /// Start the model download. False when there is nothing to start.
    pub fn downloadModel(self: *Controller) error{DictationUnavailable}!bool {
        const backend = self.backend orelse return error.DictationUnavailable;
        const status = backend.status_fn(backend.context);
        if (status.unavailable != null) return error.DictationUnavailable;
        // Nothing to download until macOS has said what is installed.
        if (status.model == .checking) return false;
        return backend.download_fn(backend.context);
    }

    // --- Start and stop ---

    /// Start capturing and transcribing. The caller has already refused a
    /// locked or securing app. Returns the session id.
    pub fn start(self: *Controller, host: Host) StartError!u64 {
        if (self.current != null) return error.DictationBusy;
        const backend = self.backend orelse return error.DictationUnavailable;
        const status = backend.status_fn(backend.context);
        if (status.unavailable != null) return error.DictationUnavailable;
        if (status.model == .checking) return error.SpeechModelChecking;
        if (status.model != .installed) return error.SpeechModelMissing;
        switch (host.microphone_status_fn()) {
            .denied, .restricted => return error.MicrophoneDenied,
            .granted, .undetermined => {},
        }
        const services = host.services orelse return error.DictationUnavailable;

        const allocator = std.heap.page_allocator;
        const storage = try allocator.alloc(i16, self.ring_len);
        const session = allocator.create(Session) catch {
            allocator.free(storage);
            return error.OutOfMemory;
        };
        self.next_id += 1;
        session.* = .{
            .id = self.next_id,
            .controller = self,
            .io = host.io,
            .services = services,
            .ring = Ring.init(storage),
            .watchdog_ms = self.watchdog_ms,
            .settle_ms = self.settle_ms,
        };
        _ = self.live_sessions.fetchAdd(1, .acq_rel);
        // From here `destroy` frees the audio and the session together. No
        // worker exists yet, so a failure below destroys it directly.
        session.engine = backend.create_fn(backend.context, session.eventsSink()) catch |err| {
            session.destroy();
            return switch (err) {
                error.OutOfMemory => error.OutOfMemory,
                else => error.DictationUnavailable,
            };
        };

        const sink: native_sdk.platform.AudioCaptureSink = .{
            .context = session,
            .generation = session.id,
            .push_fn = captureSink,
        };
        services.audioCaptureStart(.microphone, .{ .sample_rate = sample_rate, .channels = 1 }, sink) catch {
            session.engine.deinit();
            session.destroy();
            return error.DictationUnavailable;
        };
        const thread = std.Thread.spawn(.{}, workerMain, .{session}) catch {
            services.audioCaptureStop(.microphone) catch {};
            session.engine.deinit();
            session.destroy();
            return error.OutOfMemory;
        };
        thread.detach();
        self.current = session;
        return session.id;
    }

    /// Stop the running session. `discard` cancels at once and sends no more
    /// text. Otherwise the engine settles what it already heard, and
    /// `dictation:stopped` follows the last text. An unknown or ended session
    /// is a no-op.
    pub fn stop(self: *Controller, host: Host, session_id: u64, discard: bool) void {
        const session = self.current orelse return;
        if (session.id != session_id) return;
        if (discard) {
            self.cancelCurrent(host, .discarded);
            return;
        }
        if (session.finishing) return;
        session.finishing = true;
        stopCapture(session);
        session.stop_mode.store(.finish, .release);
    }

    /// Cancel whatever is running: the Mac locked or slept, or Sage quit.
    pub fn cancelAll(self: *Controller, host: Host, reason: StopReason) void {
        self.cancelCurrent(host, reason);
    }

    fn cancelCurrent(self: *Controller, host: Host, reason: StopReason) void {
        const session = self.current orelse return;
        stopCapture(session);
        session.stop_mode.store(.cancel, .release);
        self.finishSession(host, session, reason);
    }

    /// Emit `dictation:stopped` and let go of the session. Whatever it queued
    /// afterwards fails the id check in `drain`.
    fn finishSession(self: *Controller, host: Host, session: *Session, reason: StopReason) void {
        var buffer: [512]u8 = undefined;
        if (writeStoppedEvent(&buffer, session.id, reason)) |payload| {
            host.emit("dictation:stopped", payload);
        } else |_| {}
        self.current = null;
        const was_listening = session.started_sent;
        session.release();
        if (was_listening) host.setListening(false);
        host.sessionEnded();
    }

    // --- Results ---

    fn pushResult(self: *Controller, session: *Session, kind: ResultKind, text: []const u8, reason: EndedReason) void {
        const allocator = std.heap.page_allocator;
        const owned: []u8 = if (text.len == 0) &.{} else allocator.dupe(u8, text) catch return;
        {
            self.results_lock.lock();
            defer self.results_lock.unlock();
            // Only the newest grey tail matters, so it replaces a queued one.
            if (kind == .volatile_tail and self.results.items.len > 0) {
                const last = &self.results.items[self.results.items.len - 1];
                if (last.kind == .volatile_tail and last.session == session.id) {
                    if (last.text.len > 0) allocator.free(last.text);
                    last.text = owned;
                    session.services.wake() catch {};
                    return;
                }
            }
            self.results.append(allocator, .{
                .session = session.id,
                .kind = kind,
                .text = owned,
                .reason = reason,
            }) catch {
                if (owned.len > 0) allocator.free(owned);
                return;
            };
        }
        session.services.wake() catch {};
    }

    fn takeResults(self: *Controller) []Result {
        self.results_lock.lock();
        defer self.results_lock.unlock();
        if (self.results.items.len == 0) return &.{};
        const taken = std.heap.page_allocator.dupe(Result, self.results.items) catch {
            // Out of memory: drop the queue rather than grow it forever.
            for (self.results.items) |item| if (item.text.len > 0) std.heap.page_allocator.free(item.text);
            self.results.clearRetainingCapacity();
            return &.{};
        };
        self.results.clearRetainingCapacity();
        return taken;
    }

    /// Turn queued results into window events. Runs on the loop thread, on
    /// `.effects_wake`.
    pub fn drain(self: *Controller, host: Host) void {
        const items = self.takeResults();
        defer if (items.len > 0) std.heap.page_allocator.free(items);
        if (items.len == 0) return;

        var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena.deinit();
        var batch: Batch = .{};

        for (items) |item| {
            defer if (item.text.len > 0) std.heap.page_allocator.free(item.text);
            const session = self.current orelse continue;
            if (item.session != session.id) continue;
            switch (item.kind) {
                .started => {
                    if (session.started_sent) continue;
                    session.started_sent = true;
                    host.setListening(true);
                    var buffer: [64]u8 = undefined;
                    if (writeStartedEvent(&buffer, session.id)) |payload| {
                        host.emit("dictation:started", payload);
                    } else |_| {}
                },
                .final => batch.addFinal(arena.allocator(), item.text),
                .volatile_tail => batch.setTail(arena.allocator(), item.text),
                .ended => {
                    batch.flush(session, host);
                    batch = .{};
                    stopCapture(session);
                    session.stop_mode.store(.cancel, .release);
                    const reason: StopReason = switch (item.reason) {
                        .user => .user,
                        .input_lost => .input_lost,
                        .engine_failed => .engine_failed,
                        .capture_failed => switch (host.microphone_status_fn()) {
                            .denied, .restricted => .denied,
                            else => .no_input,
                        },
                    };
                    self.finishSession(host, session, reason);
                },
            }
        }
        if (self.current) |session| batch.flush(session, host);
    }

    /// Wait until every session has freed its memory. For tests.
    pub fn waitIdle(self: *Controller, io: std.Io, timeout_ms: i64) bool {
        var waited: i64 = 0;
        while (waited < timeout_ms) : (waited += 5) {
            if (self.live_sessions.load(.acquire) == 0) return true;
            std.Io.sleep(io, .fromMilliseconds(5), .awake) catch {};
        }
        return self.live_sessions.load(.acquire) == 0;
    }
};

/// The text of one drain: finals joined in order, and the newest grey tail.
const Batch = struct {
    finals: std.ArrayList(u8) = .empty,
    tail: []const u8 = "",
    tail_dirty: bool = false,

    fn addFinal(self: *Batch, allocator: std.mem.Allocator, raw: []const u8) void {
        const text = cleanText(allocator, raw) catch return;
        if (text.len > 0) {
            if (self.finals.items.len > 0) self.finals.append(allocator, ' ') catch return;
            self.finals.appendSlice(allocator, text) catch return;
        }
        // A final settles the tail it came from.
        self.tail = "";
        self.tail_dirty = true;
    }

    fn setTail(self: *Batch, allocator: std.mem.Allocator, raw: []const u8) void {
        self.tail = cleanText(allocator, raw) catch return;
        self.tail_dirty = true;
    }

    /// Emit one or more `dictation:text` events. A phrase moves from grey to
    /// final inside one event, so grey words never vanish before their text
    /// appears. A long final is cut into slices at UTF-8 boundaries, and only
    /// the last slice carries the grey tail.
    fn flush(self: *Batch, session: *Session, host: Host) void {
        var clip_buffer: [max_volatile_bytes + ellipsis.len]u8 = undefined;
        const grey = clipVolatile(&clip_buffer, self.tail);
        const final = self.finals.items;
        if (final.len == 0) {
            if (!self.tail_dirty) return;
            // Nothing settled and the grey text is the same: stay quiet.
            if (std.mem.eql(u8, grey, session.last_tail[0..session.last_tail_len])) return;
        }

        var offset: usize = 0;
        while (true) {
            const slice = journal.utf8Chunk(final, offset, max_final_slice_bytes);
            // A cut that finds no boundary would never advance; send the rest.
            const stuck = slice.len == 0 and offset < final.len;
            const piece = if (stuck) final[offset..] else slice;
            offset += piece.len;
            const last = offset >= final.len;
            session.seq += 1;
            var buffer: [max_event_bytes]u8 = undefined;
            if (writeTextEvent(&buffer, session.id, session.seq, piece, if (last) grey else "")) |payload| {
                host.emit("dictation:text", payload);
            } else |_| {
                session.seq -= 1;
            }
            if (last) break;
        }
        @memcpy(session.last_tail[0..grey.len], grey);
        session.last_tail_len = grey.len;
    }
};

/// Stop the microphone and make sure nothing enters the sink afterwards. The
/// platform's stop waits for the capture thread, so the ring has no producer
/// once this returns.
fn stopCapture(session: *Session) void {
    if (session.capture_stopped) return;
    session.capture_stopped = true;
    session.services.audioCaptureStop(.microphone) catch {};
}

// --- The worker --------------------------------------------------------------

fn nowMs(io: std.Io) i64 {
    return std.Io.Clock.Timestamp.now(io, .awake).raw.toMilliseconds();
}

fn pauseMs(io: std.Io, ms: i64) void {
    std.Io.sleep(io, .fromMilliseconds(ms), .awake) catch {};
}

fn workerMain(session: *Session) void {
    // The engine is deinitialized before the session can be freed, because its
    // reports point into the session.
    defer {
        session.engine.deinit();
        session.release();
    }
    runWorker(session);
}

fn runWorker(session: *Session) void {
    const controller = session.controller;
    const io = session.io;
    const ring = &session.ring;
    var scratch: [worker_chunk_samples]i16 = undefined;
    defer std.crypto.secureZero(i16, &scratch);

    session.engine.begin() catch {
        controller.pushResult(session, .ended, "", .engine_failed);
        return;
    };

    var started_reported = false;
    var last_head: u64 = 0;
    var last_progress_ms: i64 = 0;
    while (true) {
        const mode = session.stop_mode.load(.acquire);
        if (mode == .cancel) {
            session.engine.cancel();
            return;
        }
        const engine_state = session.engine_state.load(.acquire);
        if (engine_state == .failed) return;
        if (engine_state == .ended) {
            // The engine finished without being asked to.
            controller.pushResult(session, .ended, "", .engine_failed);
            return;
        }
        if (!started_reported and session.capture_started.load(.acquire)) {
            started_reported = true;
            last_head = ring.head.load(.acquire);
            last_progress_ms = nowMs(io);
            controller.pushResult(session, .started, "", .user);
        }
        if (session.capture_failed.load(.acquire)) {
            session.engine.cancel();
            controller.pushResult(session, .ended, "", .capture_failed);
            return;
        }
        if (ring.overflowed.load(.acquire)) {
            // The engine stopped taking audio, so the ring filled. Stop before
            // text arrives late. The Apple engine never blocks `feed`: it
            // queues the audio and reports its own backlog (SageSpeech.swift).
            session.engine.cancel();
            controller.pushResult(session, .ended, "", .engine_failed);
            return;
        }

        const count = ring.pop(&scratch);
        if (count > 0) session.engine.feed(scratch[0..count]);

        if (started_reported and mode == .running) {
            const head = ring.head.load(.acquire);
            const now = nowMs(io);
            if (head != last_head) {
                last_head = head;
                last_progress_ms = now;
            } else if (now - last_progress_ms >= session.watchdog_ms) {
                // The SDK never reports a device change or a wake, so a
                // microphone that stopped talking is caught here.
                session.engine.cancel();
                controller.pushResult(session, .ended, "", .input_lost);
                return;
            }
        }

        if (mode == .finish and count == 0) {
            // The capture is stopped and the ring is empty: settle the tail.
            settle(session);
            return;
        }
        if (count == 0) pauseMs(io, worker_interval_ms);
    }
}

/// The user pressed Stop. Let the engine finish what it already heard.
fn settle(session: *Session) void {
    const io = session.io;
    session.engine.finish();
    var waited: i64 = 0;
    while (session.engine_state.load(.acquire) == .running and waited < session.settle_ms) {
        if (session.stop_mode.load(.acquire) == .cancel) {
            session.engine.cancel();
            return;
        }
        pauseMs(io, 5);
        waited += 5;
    }
    switch (session.engine_state.load(.acquire)) {
        .failed => return,
        .running => {
            // The engine never settled, so words it was holding are lost. End
            // as a failure, so the person is told, not as a Stop that went well.
            session.engine.cancel();
            session.controller.pushResult(session, .ended, "", .engine_failed);
            return;
        },
        .ended => {},
    }
    session.controller.pushResult(session, .ended, "", .user);
}

// --- Test engine -------------------------------------------------------------

/// An engine that answers from a script, for tests. A step fires when the
/// worker has fed at least `at_samples` samples.
pub const FakeEngine = struct {
    events: Events = undefined,
    script: []const Step = &.{},
    /// Delivered as a final when the input finishes.
    finish_final: []const u8 = "",
    fail_on_begin: bool = false,
    /// `finish` reports nothing, as an engine that has stalled would.
    stall_on_finish: bool = false,
    /// `feed` waits until this is cleared, as an engine that has stalled would.
    block_feed: std.atomic.Value(bool) = .init(false),
    /// Samples fed so far. The worker writes it and tests read it.
    fed: std.atomic.Value(usize) = .init(0),
    began: std.atomic.Value(bool) = .init(false),
    finished: std.atomic.Value(bool) = .init(false),
    cancelled: std.atomic.Value(bool) = .init(false),
    deinited: std.atomic.Value(bool) = .init(false),
    next_step: usize = 0,

    pub const Step = struct {
        at_samples: usize,
        kind: enum { volatile_tail, final, failed },
        text: []const u8 = "",
    };

    pub fn engine(self: *FakeEngine) Engine {
        return .{ .context = self, .vtable = &vtable };
    }

    const vtable: Engine.VTable = .{
        .begin = begin,
        .feed = feed,
        .finish = finish,
        .cancel = cancel,
        .deinit = deinit,
    };

    fn from(context: *anyopaque) *FakeEngine {
        return @ptrCast(@alignCast(context));
    }

    fn begin(context: *anyopaque) anyerror!void {
        const self = from(context);
        self.began.store(true, .release);
        if (self.fail_on_begin) return error.EngineFailed;
    }

    fn feed(context: *anyopaque, samples: []const i16) void {
        const self = from(context);
        while (self.block_feed.load(.acquire)) std.Thread.yield() catch {};
        const total = self.fed.fetchAdd(samples.len, .acq_rel) + samples.len;
        while (self.next_step < self.script.len and self.script[self.next_step].at_samples <= total) {
            const step = self.script[self.next_step];
            self.next_step += 1;
            switch (step.kind) {
                .volatile_tail => self.events.volatileTail(step.text),
                .final => self.events.final(step.text),
                .failed => self.events.failed(),
            }
        }
    }

    fn finish(context: *anyopaque) void {
        const self = from(context);
        self.finished.store(true, .release);
        if (self.stall_on_finish) return;
        if (self.finish_final.len > 0) self.events.final(self.finish_final);
        self.events.ended();
    }

    fn cancel(context: *anyopaque) void {
        from(context).cancelled.store(true, .release);
    }

    fn deinit(context: *anyopaque) void {
        from(context).deinited.store(true, .release);
    }
};

/// A backend that hands out one `FakeEngine`.
pub const FakeBackend = struct {
    status: EngineStatus = .{ .model = .installed },
    engine: *FakeEngine,
    created: std.atomic.Value(u32) = .init(0),
    downloads: std.atomic.Value(u32) = .init(0),

    pub fn backend(self: *FakeBackend) Backend {
        return .{
            .context = self,
            .status_fn = statusFn,
            .download_fn = downloadFn,
            .create_fn = createFn,
        };
    }

    fn from(context: ?*anyopaque) *FakeBackend {
        return @ptrCast(@alignCast(context.?));
    }

    fn statusFn(context: ?*anyopaque) EngineStatus {
        return from(context).status;
    }

    fn downloadFn(context: ?*anyopaque) bool {
        const self = from(context);
        _ = self.downloads.fetchAdd(1, .acq_rel);
        return self.status.model == .missing;
    }

    fn createFn(context: ?*anyopaque, events: Events) anyerror!Engine {
        const self = from(context);
        _ = self.created.fetchAdd(1, .acq_rel);
        self.engine.events = events;
        return self.engine.engine();
    }
};

// --- Tests -------------------------------------------------------------------

const testing = std.testing;

/// Window events and session ends, captured on the loop thread.
const Capture = struct {
    names: std.ArrayList([]u8) = .empty,
    payloads: std.ArrayList([]u8) = .empty,
    sessions_ended: usize = 0,
    /// Each time the microphone came on (true) or the session ended (false).
    holds: std.ArrayList(bool) = .empty,

    fn deinit(self: *Capture) void {
        for (self.names.items) |item| testing.allocator.free(item);
        for (self.payloads.items) |item| testing.allocator.free(item);
        self.names.deinit(testing.allocator);
        self.payloads.deinit(testing.allocator);
        self.holds.deinit(testing.allocator);
    }

    fn emit(context: ?*anyopaque, name: []const u8, payload: []const u8) void {
        const self: *Capture = @ptrCast(@alignCast(context.?));
        self.names.append(testing.allocator, testing.allocator.dupe(u8, name) catch @panic("oom")) catch @panic("oom");
        self.payloads.append(testing.allocator, testing.allocator.dupe(u8, payload) catch @panic("oom")) catch @panic("oom");
    }

    fn ended(context: ?*anyopaque) void {
        const self: *Capture = @ptrCast(@alignCast(context.?));
        self.sessions_ended += 1;
    }

    fn listening(context: ?*anyopaque, on: bool) void {
        const self: *Capture = @ptrCast(@alignCast(context.?));
        self.holds.append(testing.allocator, on) catch @panic("oom");
    }

    fn count(self: *const Capture, name: []const u8) usize {
        var total: usize = 0;
        for (self.names.items) |item| {
            if (std.mem.eql(u8, item, name)) total += 1;
        }
        return total;
    }

    fn last(self: *const Capture) []const u8 {
        return self.names.items[self.names.items.len - 1];
    }
};

var test_microphone: microphone.Status = .granted;

fn testMicrophone() microphone.Status {
    return test_microphone;
}

/// A null platform, a fake engine, and a host that captures events.
const Rig = struct {
    platform: *native_sdk.NullPlatform,
    controller: Controller = .{},
    capture: Capture = .{},
    engine: FakeEngine = .{},
    backend: FakeBackend = undefined,

    fn init(self: *Rig) !void {
        test_microphone = .granted;
        self.* = .{
            .platform = try native_sdk.NullPlatform.createWithOptions(.{}, .system, .{}),
        };
        self.backend = .{ .engine = &self.engine };
        self.controller.setBackend(self.backend.backend());
    }

    fn deinit(self: *Rig) void {
        // A worker holds the controller until its session is freed.
        self.controller.cancelAll(self.host(), .quit);
        _ = self.controller.waitIdle(testing.io, 5000);
        self.capture.deinit();
        self.platform.destroy();
    }

    fn host(self: *Rig) Host {
        return .{
            .io = testing.io,
            .services = self.platform.platform().services,
            .context = &self.capture,
            .emit_fn = Capture.emit,
            .session_ended_fn = Capture.ended,
            .listening_fn = Capture.listening,
            .microphone_status_fn = testMicrophone,
        };
    }

    /// Push `count` samples of a quiet tone, in chunks the SDK could send.
    fn pushSamples(self: *Rig, count: usize) !void {
        var samples: [1600]i16 = undefined;
        for (&samples, 0..) |*sample, index| sample.* = @intCast((index % 64) * 8);
        var left = count;
        while (left > 0) {
            const chunk = @min(left, samples.len);
            const result = self.platform.pushAudioCapture(.microphone, 0, std.mem.sliceAsBytes(samples[0..chunk]));
            try testing.expectEqual(native_sdk.platform.AudioCapturePushResult.accepted, result);
            left -= chunk;
        }
    }

    /// Drain on the "loop thread" until `done` says so or three seconds pass.
    fn pumpUntil(self: *Rig, comptime done: fn (*Rig) bool) !void {
        var waited: i64 = 0;
        while (waited < 3000) : (waited += 5) {
            self.controller.drain(self.host());
            if (done(self)) return;
            std.Io.sleep(testing.io, .fromMilliseconds(5), .awake) catch {};
        }
        return error.TimedOut;
    }

    fn stopped(self: *Rig) bool {
        return self.capture.count("dictation:stopped") > 0;
    }

    fn payloadAt(self: *Rig, name: []const u8, nth: usize) ?[]const u8 {
        var seen: usize = 0;
        for (self.capture.names.items, self.capture.payloads.items) |item, payload| {
            if (!std.mem.eql(u8, item, name)) continue;
            if (seen == nth) return payload;
            seen += 1;
        }
        return null;
    }
};

const JsonView = std.json.Parsed(std.json.Value);

fn parseEvent(payload: []const u8) !JsonView {
    return std.json.parseFromSlice(std.json.Value, testing.allocator, payload, .{});
}

fn expectStopped(rig: *Rig, nth: usize, session: u64, reason: []const u8) !void {
    const payload = rig.payloadAt("dictation:stopped", nth) orelse return error.MissingEvent;
    var parsed = try parseEvent(payload);
    defer parsed.deinit();
    try testing.expectEqual(@as(i64, @intCast(session)), parsed.value.object.get("session").?.integer);
    try testing.expectEqualStrings(reason, parsed.value.object.get("reason").?.string);
}

test "the ring wraps, reports full, and clears" {
    var storage: [8]i16 = undefined;
    var ring = Ring.init(&storage);
    var out: [8]i16 = undefined;

    try testing.expect(ring.push(&.{ 1, 2, 3, 4, 5, 6 }));
    try testing.expectEqual(@as(usize, 6), ring.len());
    try testing.expectEqual(@as(usize, 4), ring.pop(out[0..4]));
    try testing.expectEqualSlices(i16, &.{ 1, 2, 3, 4 }, out[0..4]);

    // Four samples fit in front of the wrap and two behind it.
    try testing.expect(ring.push(&.{ 7, 8, 9, 10, 11, 12 }));
    try testing.expectEqual(@as(usize, 8), ring.len());
    // A full ring takes nothing more, and says so.
    try testing.expect(!ring.push(&.{99}));
    try testing.expect(ring.overflowed.load(.acquire));
    try testing.expectEqual(@as(usize, 8), ring.pop(&out));
    try testing.expectEqualSlices(i16, &.{ 5, 6, 7, 8, 9, 10, 11, 12 }, out[0..8]);
    try testing.expectEqual(@as(usize, 0), ring.pop(&out));

    try testing.expect(ring.push(&.{ 21, 22, 23 }));
    ring.clear();
    try testing.expectEqual(@as(usize, 0), ring.len());
    try testing.expect(!ring.overflowed.load(.acquire));
    for (storage) |sample| try testing.expectEqual(@as(i16, 0), sample);
    try testing.expectEqual(@as(usize, 0), ring.pop(&out));
}

test "a chunk that does not fit is dropped whole" {
    var storage: [4]i16 = undefined;
    var ring = Ring.init(&storage);
    try testing.expect(ring.push(&.{ 1, 2, 3 }));
    try testing.expect(!ring.push(&.{ 4, 5 }));
    var out: [4]i16 = undefined;
    try testing.expectEqual(@as(usize, 3), ring.pop(&out));
    try testing.expectEqualSlices(i16, &.{ 1, 2, 3 }, out[0..3]);
}

test "the ring is about a minute of audio" {
    try testing.expectEqual(@as(usize, 960_000), ring_samples);
}

test "cleanText trims, and replaces control characters and bad UTF-8" {
    const cleaned = try cleanText(testing.allocator, "  hello\nworld\t\x01 caf\xc3\xa9 \xff\xfe end  ");
    defer testing.allocator.free(cleaned);
    try testing.expectEqualStrings("hello world   café    end", cleaned);

    const truncated = try cleanText(testing.allocator, "ok \xe2\x82");
    defer testing.allocator.free(truncated);
    try testing.expectEqualStrings("ok", truncated);
}

test "the worst-case text event stays under 8 KiB" {
    // Every byte of the final and the tail needs escaping, which doubles it.
    var final: [max_final_slice_bytes]u8 = undefined;
    @memset(&final, '"');
    var grey: [max_volatile_bytes + ellipsis.len]u8 = undefined;
    @memset(&grey, '\\');
    var buffer: [max_event_bytes]u8 = undefined;
    const payload = try writeTextEvent(&buffer, 18_446_744_073_709_551_615, 18_446_744_073_709_551_615, &final, &grey);
    try testing.expect(payload.len < 7 * 1024);
}

test "a long final splits into events on UTF-8 boundaries" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    var session: Session = undefined;
    session = .{ .id = 4, .controller = &rig.controller, .io = testing.io, .services = rig.platform.platform().services, .ring = undefined, .watchdog_ms = 0 };

    // 3000 two-byte letters is 6000 bytes: three slices, none cut inside a letter.
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const text = try arena.allocator().alloc(u8, 6000);
    for (0..3000) |index| @memcpy(text[index * 2 ..][0..2], "é");
    var batch: Batch = .{};
    batch.addFinal(arena.allocator(), text);
    batch.setTail(arena.allocator(), "grey words");
    batch.flush(&session, rig.host());

    try testing.expectEqual(@as(usize, 3), rig.capture.count("dictation:text"));
    var joined: std.ArrayList(u8) = .empty;
    defer joined.deinit(testing.allocator);
    for (0..3) |index| {
        const payload = rig.payloadAt("dictation:text", index).?;
        try testing.expect(payload.len < max_event_bytes);
        var parsed = try parseEvent(payload);
        defer parsed.deinit();
        try testing.expectEqual(@as(i64, @intCast(index + 1)), parsed.value.object.get("seq").?.integer);
        const piece = parsed.value.object.get("final").?.string;
        try testing.expect(piece.len <= max_final_slice_bytes);
        try testing.expect(std.unicode.utf8ValidateSlice(piece));
        try joined.appendSlice(testing.allocator, piece);
        // Only the last slice carries the grey tail.
        const grey = parsed.value.object.get("volatile").?.string;
        try testing.expectEqualStrings(if (index == 2) "grey words" else "", grey);
    }
    try testing.expectEqualStrings(text, joined.items);
}

test "the grey tail is clipped to its last kilobyte with an ellipsis" {
    var buffer: [max_volatile_bytes + ellipsis.len]u8 = undefined;
    try testing.expectEqualStrings("short", clipVolatile(&buffer, "short"));

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const long = try arena.allocator().alloc(u8, 3000);
    for (0..1500) |index| @memcpy(long[index * 2 ..][0..2], "é");
    const clipped = clipVolatile(&buffer, long);
    try testing.expect(std.mem.startsWith(u8, clipped, ellipsis));
    try testing.expect(clipped.len <= ellipsis.len + max_volatile_bytes);
    try testing.expect(std.unicode.utf8ValidateSlice(clipped));
    try testing.expect(std.mem.endsWith(u8, long, clipped[ellipsis.len..]));
}

test "a fake session runs from captured audio to window events" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.engine.script = &.{
        .{ .at_samples = 1600, .kind = .volatile_tail, .text = " hello wor" },
        .{ .at_samples = 3200, .kind = .volatile_tail, .text = " hello world" },
        .{ .at_samples = 4800, .kind = .final, .text = " hello world" },
        .{ .at_samples = 6400, .kind = .volatile_tail, .text = " and then" },
    };
    rig.engine.finish_final = " and then we left";

    const session = try rig.controller.start(rig.host());
    try testing.expectEqual(@as(u64, 1), session);
    try testing.expect(rig.controller.active());
    try testing.expectEqual(@as(?u64, 1), rig.controller.currentId());

    const Started = struct {
        fn done(r: *Rig) bool {
            return r.capture.count("dictation:started") > 0;
        }
    };
    try rig.pumpUntil(Started.done);
    try testing.expect(rig.platform.pendingWakeCount() > 0);

    try rig.pushSamples(6400);
    const Settled = struct {
        fn done(r: *Rig) bool {
            for (r.capture.payloads.items) |payload| {
                if (std.mem.indexOf(u8, payload, "\"volatile\":\"and then\"") != null) return true;
            }
            return false;
        }
    };
    try rig.pumpUntil(Settled.done);
    try testing.expectEqual(@as(usize, 6400), rig.engine.fed.load(.acquire));

    rig.controller.stop(rig.host(), session, false);
    // Stop closes the microphone at once and settles the rest.
    try testing.expectEqual(@as(usize, 1), rig.platform.audio_captures[0].stop_count);
    try rig.pumpUntil(Rig.stopped);
    try testing.expect(rig.engine.finished.load(.acquire));

    try testing.expectEqualStrings("dictation:stopped", rig.capture.last());
    try expectStopped(&rig, 0, session, "user");
    try testing.expectEqual(@as(usize, 1), rig.capture.sessions_ended);
    try testing.expect(!rig.controller.active());

    // seq counts up from 1 with no gap, and the finals read in order.
    var seq: i64 = 0;
    var finals: std.ArrayList(u8) = .empty;
    defer finals.deinit(testing.allocator);
    var index: usize = 0;
    while (rig.payloadAt("dictation:text", index)) |payload| : (index += 1) {
        var parsed = try parseEvent(payload);
        defer parsed.deinit();
        seq += 1;
        try testing.expectEqual(seq, parsed.value.object.get("seq").?.integer);
        try testing.expectEqual(@as(i64, 1), parsed.value.object.get("session").?.integer);
        const final = parsed.value.object.get("final").?.string;
        if (final.len > 0) {
            if (finals.items.len > 0) try finals.append(testing.allocator, ' ');
            try finals.appendSlice(testing.allocator, final);
        }
    }
    // Results that land in one drain share an event, so the count varies.
    try testing.expect(seq >= 2);
    try testing.expectEqualStrings("hello world and then we left", finals.items);
    // A final and its grey words never overlap: after "hello world" settles, the
    // tail is empty or newer text.
    try testing.expectEqualStrings("dictation:started", rig.capture.names.items[0]);

    try testing.expect(rig.controller.waitIdle(testing.io, 3000));
    try testing.expect(rig.engine.deinited.load(.acquire));
}

test "a phrase moves from grey to final inside one event" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    // The grey phrase and its final land in one drain: one event, no gap.
    rig.engine.script = &.{
        .{ .at_samples = 800, .kind = .volatile_tail, .text = "good morning" },
        .{ .at_samples = 800, .kind = .final, .text = "good morning" },
    };
    const session = try rig.controller.start(rig.host());
    const Started = struct {
        fn done(r: *Rig) bool {
            return r.capture.count("dictation:started") > 0;
        }
    };
    try rig.pumpUntil(Started.done);
    try rig.pushSamples(800);
    const Fed = struct {
        fn done(r: *Rig) bool {
            return r.engine.fed.load(.acquire) >= 800;
        }
    };
    try rig.pumpUntil(Fed.done);
    // Both results are queued by now. Drain once more and read what came out.
    rig.controller.drain(rig.host());
    var grey_only: usize = 0;
    var with_final: usize = 0;
    var index: usize = 0;
    while (rig.payloadAt("dictation:text", index)) |payload| : (index += 1) {
        var parsed = try parseEvent(payload);
        defer parsed.deinit();
        const final = parsed.value.object.get("final").?.string;
        const grey = parsed.value.object.get("volatile").?.string;
        if (final.len > 0) {
            with_final += 1;
            try testing.expectEqualStrings("good morning", final);
            try testing.expectEqualStrings("", grey);
        } else if (grey.len > 0) {
            grey_only += 1;
        }
    }
    try testing.expectEqual(@as(usize, 1), with_final);
    rig.controller.stop(rig.host(), session, true);
}

test "a discarded session sends no more text" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.engine.script = &.{.{ .at_samples = 1600, .kind = .final, .text = "never shown" }};
    const session = try rig.controller.start(rig.host());

    // Stopping a session that is not the current one does nothing.
    rig.controller.stop(rig.host(), session + 1, true);
    try testing.expect(rig.controller.active());

    try rig.pushSamples(1600);
    rig.controller.stop(rig.host(), session, true);
    try testing.expect(!rig.controller.active());
    try testing.expectEqual(@as(usize, 1), rig.platform.audio_captures[0].stop_count);
    try expectStopped(&rig, 0, session, "discarded");

    // Whatever the worker queued before it noticed is dropped by the id check.
    try testing.expect(rig.controller.waitIdle(testing.io, 3000));
    rig.controller.drain(rig.host());
    try testing.expectEqual(@as(usize, 0), rig.capture.count("dictation:text"));
    try testing.expectEqual(@as(usize, 1), rig.capture.count("dictation:stopped"));
    try testing.expect(rig.engine.cancelled.load(.acquire));
    try testing.expectEqual(@as(usize, 1), rig.capture.sessions_ended);

    // A stop for an ended session is a no-op too.
    rig.controller.stop(rig.host(), session, false);
    try testing.expectEqual(@as(usize, 1), rig.capture.count("dictation:stopped"));
}

test "locking drops text that was already queued" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.engine.script = &.{
        .{ .at_samples = 1600, .kind = .volatile_tail, .text = "secret grey" },
        .{ .at_samples = 1600, .kind = .final, .text = "secret final" },
    };
    const session = try rig.controller.start(rig.host());
    try rig.pushSamples(1600);
    // Wait for the engine to have heard it, so results sit in the queue.
    var waited: i64 = 0;
    while (rig.engine.fed.load(.acquire) < 1600 and waited < 3000) : (waited += 5) {
        std.Io.sleep(testing.io, .fromMilliseconds(5), .awake) catch {};
    }
    try testing.expectEqual(@as(usize, 1600), rig.engine.fed.load(.acquire));

    rig.controller.cancelAll(rig.host(), .locked);
    try testing.expect(!rig.controller.active());
    try expectStopped(&rig, 0, session, "locked");
    rig.controller.drain(rig.host());
    try testing.expect(rig.controller.waitIdle(testing.io, 3000));
    rig.controller.drain(rig.host());

    try testing.expectEqual(@as(usize, 1), rig.capture.names.items.len);
    try testing.expectEqualStrings("dictation:stopped", rig.capture.names.items[0]);
    // Locked and quit carry no message.
    try testing.expect(std.mem.indexOf(u8, rig.capture.payloads.items[0], "\"message\":null") != null);
}

test "cancelAll with nothing running does nothing" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.controller.cancelAll(rig.host(), .locked);
    rig.controller.cancelAll(rig.host(), .quit);
    try testing.expectEqual(@as(usize, 0), rig.capture.names.items.len);
    try testing.expectEqual(@as(usize, 0), rig.capture.sessions_ended);
}

test "text from an old session never reaches a new one" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    const first = try rig.controller.start(rig.host());
    // Queue a result by hand for the session that is about to end.
    const old = rig.controller.current.?;
    rig.controller.pushResult(old, .final, "from the old session", .user);
    rig.controller.stop(rig.host(), first, true);
    // The old worker uses `rig.engine` until it lets go of the session, so wait
    // for it before the engine is replaced.
    try testing.expect(rig.controller.waitIdle(testing.io, 3000));

    rig.engine = .{};
    const second = try rig.controller.start(rig.host());
    try testing.expectEqual(first + 1, second);
    rig.controller.drain(rig.host());
    try testing.expectEqual(@as(usize, 0), rig.capture.count("dictation:text"));
    rig.controller.stop(rig.host(), second, true);
}

test "starting is refused when it cannot work" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();

    // No engine library.
    var bare: Controller = .{};
    try testing.expectError(error.DictationUnavailable, bare.start(rig.host()));

    // A Mac that can't dictate.
    rig.backend.status = .{ .unavailable = .unsupported_os };
    try testing.expectError(error.DictationUnavailable, rig.controller.start(rig.host()));

    // The model is not there yet, is downloading, or failed.
    rig.backend.status = .{ .model = .missing };
    try testing.expectError(error.SpeechModelMissing, rig.controller.start(rig.host()));
    rig.backend.status = .{ .model = .downloading, .fraction = 0.5 };
    try testing.expectError(error.SpeechModelMissing, rig.controller.start(rig.host()));
    rig.backend.status = .{ .model = .failed };
    try testing.expectError(error.SpeechModelMissing, rig.controller.start(rig.host()));

    // The microphone is denied or restricted. Undetermined goes ahead and asks.
    rig.backend.status = .{ .model = .installed };
    test_microphone = .denied;
    try testing.expectError(error.MicrophoneDenied, rig.controller.start(rig.host()));
    test_microphone = .restricted;
    try testing.expectError(error.MicrophoneDenied, rig.controller.start(rig.host()));
    test_microphone = .undetermined;
    const session = try rig.controller.start(rig.host());

    // One at a time.
    try testing.expectError(error.DictationBusy, rig.controller.start(rig.host()));
    try testing.expectEqual(@as(u32, 1), rig.backend.created.load(.acquire));
    rig.controller.stop(rig.host(), session, true);
}

test "a host without capture can't start" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.platform.microphone_capture = false;
    rig.platform.system_audio_capture = false;
    try testing.expectError(error.DictationUnavailable, rig.controller.start(rig.host()));
    try testing.expect(!rig.controller.active());
    try testing.expect(rig.controller.waitIdle(testing.io, 1000));
    // The engine that was made for it is let go.
    try testing.expect(rig.engine.deinited.load(.acquire));
}

test "a microphone that goes quiet ends the session as input_lost" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.controller.watchdog_ms = 150;
    const session = try rig.controller.start(rig.host());
    try rig.pushSamples(1600);
    try rig.pumpUntil(Rig.stopped);
    try expectStopped(&rig, 0, session, "input_lost");
    const payload = rig.payloadAt("dictation:stopped", 0).?;
    try testing.expect(std.mem.indexOf(u8, payload, "\"message\":\"The microphone stopped sending sound") != null);
    try testing.expect(!rig.controller.active());
    try testing.expect(rig.controller.waitIdle(testing.io, 3000));
    try testing.expect(rig.engine.cancelled.load(.acquire));
    // The capture is closed, so the sink takes nothing more.
    try testing.expectEqual(@as(usize, 1), rig.platform.audio_captures[0].stop_count);
}

test "the watchdog leaves a steady microphone alone" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.controller.watchdog_ms = 200;
    const session = try rig.controller.start(rig.host());
    var round: usize = 0;
    while (round < 12) : (round += 1) {
        try rig.pushSamples(320);
        rig.controller.drain(rig.host());
        std.Io.sleep(testing.io, .fromMilliseconds(40), .awake) catch {};
    }
    try testing.expect(rig.controller.active());
    try testing.expectEqual(@as(usize, 0), rig.capture.count("dictation:stopped"));
    rig.controller.stop(rig.host(), session, true);
}

test "a failed capture is denied or no_input, whichever macOS says" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();

    // The person said no in the permission sheet.
    test_microphone = .undetermined;
    const first = try rig.controller.start(rig.host());
    test_microphone = .denied;
    _ = rig.platform.failAudioCapture(.microphone);
    try rig.pumpUntil(Rig.stopped);
    try expectStopped(&rig, 0, first, "denied");
    try testing.expect(std.mem.indexOf(u8, rig.payloadAt("dictation:stopped", 0).?, "System Settings") != null);
    try testing.expect(rig.controller.waitIdle(testing.io, 3000));

    // Access is fine, so the device or the engine failed.
    rig.engine = .{};
    test_microphone = .granted;
    const second = try rig.controller.start(rig.host());
    _ = rig.platform.failAudioCapture(.microphone);
    const Twice = struct {
        fn done(r: *Rig) bool {
            return r.capture.count("dictation:stopped") > 1;
        }
    };
    try rig.pumpUntil(Twice.done);
    try expectStopped(&rig, 1, second, "no_input");
    try testing.expectEqual(@as(usize, 2), rig.capture.sessions_ended);
}

test "an engine failure ends the session as engine_failed" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.engine.script = &.{.{ .at_samples = 800, .kind = .failed }};
    const session = try rig.controller.start(rig.host());
    try rig.pushSamples(800);
    try rig.pumpUntil(Rig.stopped);
    try expectStopped(&rig, 0, session, "engine_failed");
    try testing.expect(!rig.controller.active());
    try testing.expectEqual(@as(usize, 1), rig.platform.audio_captures[0].stop_count);

    // An engine that fails to begin ends the same way.
    try testing.expect(rig.controller.waitIdle(testing.io, 3000));
    rig.engine = .{ .fail_on_begin = true };
    const second = try rig.controller.start(rig.host());
    const Twice = struct {
        fn done(r: *Rig) bool {
            return r.capture.count("dictation:stopped") > 1;
        }
    };
    try rig.pumpUntil(Twice.done);
    try expectStopped(&rig, 1, second, "engine_failed");
}

test "an engine that stops taking audio overflows the ring and ends the session" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    // A ring of three chunks, and an engine whose `feed` blocks. The worker can
    // move one chunk into the engine and then waits, so six chunks always
    // overflow the ring.
    rig.controller.ring_len = 4800;
    rig.engine.block_feed.store(true, .release);
    defer rig.engine.block_feed.store(false, .release);
    const session = try rig.controller.start(rig.host());

    var samples: [1600]i16 = undefined;
    @memset(&samples, 7);
    var dropped: usize = 0;
    for (0..6) |_| {
        const result = rig.platform.pushAudioCapture(.microphone, 0, std.mem.sliceAsBytes(&samples));
        if (result == .dropped_full) dropped += 1;
    }
    try testing.expect(dropped >= 2);

    // The worker notices once the engine takes its audio again.
    rig.engine.block_feed.store(false, .release);
    try rig.pumpUntil(Rig.stopped);
    try expectStopped(&rig, 0, session, "engine_failed");
    try testing.expect(std.mem.indexOf(u8, rig.payloadAt("dictation:stopped", 0).?, "\"message\":\"Dictation stopped because the speech engine failed.") != null);
    try testing.expect(rig.engine.cancelled.load(.acquire));
    try testing.expect(!rig.controller.active());
}

test "a Stop that the engine never settles ends as engine_failed, not as a quiet stop" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.controller.settle_ms = 100;
    rig.engine.stall_on_finish = true;
    const session = try rig.controller.start(rig.host());
    try rig.pushSamples(1600);
    rig.controller.stop(rig.host(), session, false);
    try rig.pumpUntil(Rig.stopped);
    try testing.expect(rig.engine.finished.load(.acquire));
    try testing.expect(rig.engine.cancelled.load(.acquire));
    try expectStopped(&rig, 0, session, "engine_failed");
    try testing.expect(std.mem.indexOf(u8, rig.payloadAt("dictation:stopped", 0).?, "\"message\":\"Dictation stopped") != null);
    try testing.expectEqual(@as(usize, 1), rig.capture.sessions_ended);
}

test "a session stays quiet until the capture really starts" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    // Stop before any audio: the session still ends cleanly with `user`.
    const session = try rig.controller.start(rig.host());
    rig.controller.stop(rig.host(), session, false);
    try rig.pumpUntil(Rig.stopped);
    try expectStopped(&rig, 0, session, "user");
    try testing.expect(rig.engine.finished.load(.acquire));
}

test "status reports the engine, the microphone, and the running session" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    var buffer: [512]u8 = undefined;

    var writer = std.Io.Writer.fixed(&buffer);
    try rig.controller.writeStatus(rig.host(), &writer);
    try testing.expectEqualStrings(
        "{\"available\":true,\"reason\":null,\"microphone\":\"granted\",\"model\":{\"state\":\"installed\",\"fraction\":null,\"message\":null},\"session\":null}",
        writer.buffered(),
    );

    rig.backend.status = .{ .model = .downloading, .fraction = 0.25 };
    test_microphone = .undetermined;
    writer = std.Io.Writer.fixed(&buffer);
    try rig.controller.writeStatus(rig.host(), &writer);
    try testing.expectEqualStrings(
        "{\"available\":true,\"reason\":null,\"microphone\":\"undetermined\",\"model\":{\"state\":\"downloading\",\"fraction\":0.250,\"message\":null},\"session\":null}",
        writer.buffered(),
    );

    rig.backend.status = .{ .model = .failed };
    rig.backend.status.setMessage("The speech model did not download.");
    writer = std.Io.Writer.fixed(&buffer);
    try rig.controller.writeStatus(rig.host(), &writer);
    try testing.expect(std.mem.indexOf(u8, writer.buffered(), "\"model\":{\"state\":\"failed\",\"fraction\":null,\"message\":\"The speech model did not download.\"}") != null);

    rig.backend.status = .{ .unavailable = .unsupported_os };
    writer = std.Io.Writer.fixed(&buffer);
    try rig.controller.writeStatus(rig.host(), &writer);
    try testing.expect(std.mem.startsWith(u8, writer.buffered(), "{\"available\":false,\"reason\":\"unsupported_os\","));

    // A Mac with no engine library reports engine_missing.
    var bare: Controller = .{};
    writer = std.Io.Writer.fixed(&buffer);
    try bare.writeStatus(rig.host(), &writer);
    try testing.expect(std.mem.startsWith(u8, writer.buffered(), "{\"available\":false,\"reason\":\"engine_missing\","));

    rig.backend.status = .{ .model = .installed };
    test_microphone = .granted;
    const session = try rig.controller.start(rig.host());
    writer = std.Io.Writer.fixed(&buffer);
    try rig.controller.writeStatus(rig.host(), &writer);
    try testing.expect(std.mem.endsWith(u8, writer.buffered(), "\"session\":1}"));
    rig.controller.stop(rig.host(), session, true);
}

test "the status says when macOS has not answered about the speech model" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    var buffer: [512]u8 = undefined;

    rig.backend.status = .{ .model = .checking };
    var writer = std.Io.Writer.fixed(&buffer);
    try rig.controller.writeStatus(rig.host(), &writer);
    try testing.expectEqualStrings(
        "{\"available\":true,\"reason\":null,\"microphone\":\"granted\",\"model\":{\"state\":\"checking\",\"fraction\":null,\"message\":null},\"session\":null}",
        writer.buffered(),
    );

    // Starting waits for the answer. It is not a missing model, so the web view
    // does not start a download.
    try testing.expectError(error.SpeechModelChecking, rig.controller.start(rig.host()));
    try testing.expect(!rig.controller.active());
    // And there is nothing to download yet.
    try testing.expect(!(try rig.controller.downloadModel()));
    try testing.expectEqual(@as(u32, 0), rig.backend.downloads.load(.acquire));

    // Once macOS answers, the same calls work.
    rig.backend.status = .{ .model = .missing };
    try testing.expectError(error.SpeechModelMissing, rig.controller.start(rig.host()));
    try testing.expect(try rig.controller.downloadModel());
}

test "a Mac with no English speech model says so" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    var buffer: [512]u8 = undefined;
    rig.backend.status = .{ .unavailable = .no_english };
    var writer = std.Io.Writer.fixed(&buffer);
    try rig.controller.writeStatus(rig.host(), &writer);
    try testing.expect(std.mem.startsWith(u8, writer.buffered(), "{\"available\":false,\"reason\":\"no_english\","));
    try testing.expectError(error.DictationUnavailable, rig.controller.start(rig.host()));
    try testing.expectError(error.DictationUnavailable, rig.controller.downloadModel());
}

test "the microphone counts as on only once capture has started" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    try testing.expect(!rig.controller.listening());

    const session = try rig.controller.start(rig.host());
    // The session exists, but the loop has not heard `started` yet. In the app
    // the person may still be looking at the macOS microphone prompt, and Sage
    // must be free to lock, so nothing is held.
    try testing.expect(rig.controller.active());
    try testing.expect(!rig.controller.listening());
    try testing.expectEqual(@as(usize, 0), rig.capture.holds.items.len);

    const Started = struct {
        fn done(r: *Rig) bool {
            return r.capture.count("dictation:started") > 0;
        }
    };
    try rig.pumpUntil(Started.done);
    try testing.expect(rig.controller.listening());
    try testing.expectEqualSlices(bool, &.{true}, rig.capture.holds.items);

    rig.controller.stop(rig.host(), session, true);
    try testing.expect(!rig.controller.listening());
    try testing.expectEqualSlices(bool, &.{ true, false }, rig.capture.holds.items);
}

test "a session that ends before the microphone starts never holds anything" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.engine.fail_on_begin = true;
    const session = try rig.controller.start(rig.host());
    try rig.pumpUntil(Rig.stopped);
    try expectStopped(&rig, 0, session, "engine_failed");
    try testing.expect(!rig.controller.listening());
    try testing.expectEqual(@as(usize, 0), rig.capture.holds.items.len);
    try testing.expectEqual(@as(usize, 1), rig.capture.sessions_ended);
}

test "every way a session ends lets go of the microphone hold" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    const Started = struct {
        fn done(r: *Rig) bool {
            return r.capture.count("dictation:started") > 0;
        }
    };
    const Ends = enum { locked, quit, stopped, failed };
    for ([_]Ends{ .locked, .quit, .stopped, .failed }) |how| {
        try testing.expect(rig.controller.waitIdle(testing.io, 3000));
        rig.engine = .{};
        rig.capture.holds.clearRetainingCapacity();
        for (rig.capture.names.items) |item| testing.allocator.free(item);
        for (rig.capture.payloads.items) |item| testing.allocator.free(item);
        rig.capture.names.clearRetainingCapacity();
        rig.capture.payloads.clearRetainingCapacity();
        if (how == .failed) rig.engine.script = &.{.{ .at_samples = 800, .kind = .failed }};

        const session = try rig.controller.start(rig.host());
        try rig.pumpUntil(Started.done);
        try testing.expect(rig.controller.listening());
        switch (how) {
            .locked => rig.controller.cancelAll(rig.host(), .locked),
            .quit => rig.controller.cancelAll(rig.host(), .quit),
            .stopped => {
                rig.controller.stop(rig.host(), session, false);
                try rig.pumpUntil(Rig.stopped);
            },
            .failed => {
                try rig.pushSamples(800);
                try rig.pumpUntil(Rig.stopped);
            },
        }
        try testing.expect(!rig.controller.listening());
        try testing.expectEqualSlices(bool, &.{ true, false }, rig.capture.holds.items);
    }
}

test "the model download starts only when there is something to download" {
    var rig: Rig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.backend.status = .{ .model = .missing };
    try testing.expect(try rig.controller.downloadModel());
    rig.backend.status = .{ .model = .installed };
    try testing.expect(!(try rig.controller.downloadModel()));
    rig.backend.status = .{ .unavailable = .engine_missing };
    try testing.expectError(error.DictationUnavailable, rig.controller.downloadModel());
    var bare: Controller = .{};
    try testing.expectError(error.DictationUnavailable, bare.downloadModel());
}

test "event JSON for started and stopped" {
    var buffer: [256]u8 = undefined;
    try testing.expectEqualStrings("{\"session\":3}", try writeStartedEvent(&buffer, 3));
    try testing.expectEqualStrings(
        "{\"session\":3,\"reason\":\"user\",\"message\":null}",
        try writeStoppedEvent(&buffer, 3, .user),
    );
    const failed = try writeStoppedEvent(&buffer, 3, .engine_failed);
    try testing.expect(std.mem.indexOf(u8, failed, "\"reason\":\"engine_failed\",\"message\":\"Dictation stopped") != null);
    for ([_]StopReason{ .user, .discarded, .locked, .quit }) |reason| {
        try testing.expect(reason.message() == null);
    }
    for ([_]StopReason{ .denied, .no_input, .input_lost, .engine_failed }) |reason| {
        try testing.expect(reason.message() != null);
    }
}
