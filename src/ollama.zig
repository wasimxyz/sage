const builtin = @import("builtin");
const std = @import("std");

pub const host = "127.0.0.1";
pub const port: u16 = 11434;
/// Any pulled tag of the embedding model counts (e.g. `nomic-embed-text:latest`);
/// the status check reports the exact name it found. Override with `SAGE_EMBED_MODEL`.
pub const model_prefix = "nomic-embed-text";
/// The summary model tag. A pulled model whose name starts with it counts.
/// Override with `SAGE_SUMMARY_MODEL`.
pub const summary_model = "qwen3.5:9b";

/// Embedding and summary prefixes resolved once from `environ_map` in `main`.
pub const ModelPrefixes = struct {
    embed: []const u8 = model_prefix,
    summary: []const u8 = summary_model,

    pub fn fromEnv(environ_map: *std.process.Environ.Map) ModelPrefixes {
        return .{
            .embed = modelPrefixFrom(environ_map.get("SAGE_EMBED_MODEL"), model_prefix),
            .summary = modelPrefixFrom(environ_map.get("SAGE_SUMMARY_MODEL"), summary_model),
        };
    }
};

/// Pick an override when it is present and non-empty; otherwise `fallback`.
pub fn modelPrefixFrom(env_value: ?[]const u8, fallback: []const u8) []const u8 {
    if (env_value) |value| {
        if (value.len > 0) return value;
    }
    return fallback;
}

/// "pull this model" hint when the summary model is missing.
pub fn summaryNotPulledMessage(buffer: []u8, prefix: []const u8) []const u8 {
    return std.fmt.bufPrint(
        buffer,
        "The summary model is not pulled. Run: ollama pull {s}",
        .{prefix},
    ) catch "The summary model is not pulled.";
}

/// "pull this model" hint when the embedding model is missing.
pub fn embedNotPulledMessage(buffer: []u8, prefix: []const u8) []const u8 {
    return std.fmt.bufPrint(
        buffer,
        "The embedding model is not pulled. Run: ollama pull {s}",
        .{prefix},
    ) catch "The embedding model is not pulled.";
}
pub const max_chunk_bytes: usize = 8000;
pub const max_summary_input_bytes: usize = 24 * 1024;
pub const max_extract_input_bytes: usize = 12 * 1024;
pub const max_title_input_bytes: usize = 8 * 1024;
pub const title_limit: usize = 60;

const generate_context_tokens = 16_384;

const summary_prompt_prefix =
    "Write a summary of the journal entry using one sentence per distinct topic, event, or feeling. " ++
    "A longer entry naturally gets a longer summary. " ++
    "Only include what the entry actually states; don't add reasons, causes, or context it doesn't give. " ++
    "If the entry leaves something unclear, keep the summary just as unclear. " ++
    "Do not use a heading, a label, or bullet points. Output only the summary.\n\n";

const chat_summary_prompt_prefix =
    "Write a plain two-to-three sentence summary of the conversation below. " ++
    "Cover the main questions, answers, and conclusions. Do not use a heading, a label, or bullet points. " ++
    "Output only the summary.\n\n";

const chat_title_prompt_prefix =
    "Write a short title for the conversation below. " ++
    "Use the recent messages. Three to eight words. " ++
    "Do not use a heading, a label, quotes, or extra punctuation. " ++
    "Output only the title.\n\n";

const extract_prompt_prefix =
    "Extract lasting memories from the text below. Reply with JSON only: no markdown, no commentary, no code fences. " ++
    "Use this shape: {\"profile\":[\"stable facts about the author\"],\"facts\":[{\"subject\":\"person name or user\",\"fact\":\"one durable fact\"}],\"events\":[{\"event\":\"what happened\",\"date\":\"YYYY-MM-DD or empty\"}]}. " ++
    "profile holds identity, preferences, and lasting traits of the journal author. " ++
    "facts hold durable facts about other people or relationships. " ++
    "events hold specific things that happened. " ++
    "Do not invent. Skip fleeting feelings unless they are a lasting trait. " ++
    "Use empty arrays when nothing qualifies. At most 8 profile items, 12 facts, and 12 events.\n\n";

pub const Status = struct {
    running: bool,
    model_pulled: bool,
    model_name: []const u8 = "",
};

pub const SummaryStatus = struct {
    running: bool,
    embed_pulled: bool,
    summary_pulled: bool,
    embed_model_name: []const u8 = "",
    summary_model_name: []const u8 = "",
};

/// Multi-GB pulls can sit on the socket for a long time; the watchdog is a
/// last-resort hang guard. The user can cancel sooner via `Abort.fire`.
pub const pull_timeout_ms: i64 = 2 * 60 * 60 * 1000;

pub const HardwareInfo = struct {
    chip_name: []const u8,
    ram_gb: u32,
    cpu_cores: u32,
};

/// Shared progress for an in-flight (or last) `POST /api/pull`.
pub const PullState = struct {
    mutex: std.Io.Mutex = .init,
    present: bool = false,
    active: bool = false,
    cancel_requested: bool = false,
    done: bool = false,
    cancelled: bool = false,
    failed: bool = false,
    completed: u64 = 0,
    total: u64 = 0,
    model_buf: [128]u8 = undefined,
    model_len: usize = 0,
    status_buf: [192]u8 = undefined,
    status_len: usize = 0,

    pub const Snapshot = struct {
        present: bool = false,
        active: bool = false,
        done: bool = false,
        cancelled: bool = false,
        failed: bool = false,
        completed: u64 = 0,
        total: u64 = 0,
        model: []const u8 = "",
        status: []const u8 = "",
    };

    fn resetLocked(self: *PullState, name: []const u8) void {
        const n = @min(name.len, self.model_buf.len);
        @memcpy(self.model_buf[0..n], name[0..n]);
        self.model_len = n;
        self.status_len = 0;
        self.completed = 0;
        self.total = 0;
        self.present = true;
        self.active = true;
        self.cancel_requested = false;
        self.done = false;
        self.cancelled = false;
        self.failed = false;
    }

    pub fn begin(self: *PullState, io: std.Io, name: []const u8) bool {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        if (self.active) return false;
        self.resetLocked(name);
        return true;
    }

    pub fn requestCancel(self: *PullState, io: std.Io) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.cancel_requested = true;
    }

    pub fn clearActive(self: *PullState, io: std.Io) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.active = false;
    }

    pub fn matchesActive(self: *PullState, io: std.Io, name: []const u8) bool {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        if (!self.active) return false;
        return std.mem.eql(u8, self.model_buf[0..self.model_len], name);
    }

    pub fn finish(self: *PullState, io: std.Io, result: anyerror!void) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.active = false;
        if (result) |_| {
            self.done = true;
            self.failed = false;
            self.cancelled = false;
        } else |_| {
            if (self.cancel_requested) {
                self.cancelled = true;
                self.failed = false;
                self.done = false;
            } else {
                self.failed = true;
                self.cancelled = false;
                self.done = false;
            }
        }
    }

    fn setProgress(self: *PullState, io: std.Io, status: []const u8, completed: ?u64, total: ?u64) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        const n = @min(status.len, self.status_buf.len);
        @memcpy(self.status_buf[0..n], status[0..n]);
        self.status_len = n;
        if (completed) |value| self.completed = value;
        if (total) |value| self.total = value;
    }

    pub fn snapshot(self: *PullState, io: std.Io, model_out: []u8, status_out: []u8) Snapshot {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        const model_n = @min(self.model_len, model_out.len);
        @memcpy(model_out[0..model_n], self.model_buf[0..model_n]);
        const status_n = @min(self.status_len, status_out.len);
        @memcpy(status_out[0..status_n], self.status_buf[0..status_n]);
        return .{
            .present = self.present,
            .active = self.active,
            .done = self.done,
            .cancelled = self.cancelled,
            .failed = self.failed,
            .completed = self.completed,
            .total = self.total,
            .model = model_out[0..model_n],
            .status = status_out[0..status_n],
        };
    }
};

/// Cooperative cancel handle shared between the thread running an Ollama
/// call and a watchdog thread. When the watchdog fires, it shuts down the
/// in-flight socket so a wedged server fails the blocked read instead of
/// hanging the worker forever.
pub const Abort = struct {
    io: std.Io,
    mutex: std.Io.Mutex = .init,
    stream: ?std.Io.net.Stream = null,
    fired: std.atomic.Value(bool) = .init(false),
    done: std.atomic.Value(bool) = .init(false),

    /// Publish the connected socket so the watchdog can interrupt it. If the
    /// watchdog already fired, the socket is shut down immediately.
    fn arm(self: *Abort, stream: std.Io.net.Stream) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.fired.load(.acquire)) {
            stream.shutdown(self.io, .both) catch {};
            return;
        }
        self.stream = stream;
    }

    fn disarm(self: *Abort) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        self.stream = null;
    }

    pub fn fire(self: *Abort) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        self.fired.store(true, .release);
        if (self.stream) |stream| stream.shutdown(self.io, .both) catch {};
        self.stream = null;
    }
};

/// Start a watchdog thread that fires `abort` after `timeout_ms` unless the
/// work finishes first. Always pair with `finishWatchdog` to join the thread.
pub fn startWatchdog(abort: *Abort, timeout_ms: i64) ?std.Thread {
    return std.Thread.spawn(.{}, watchdogMain, .{ abort, timeout_ms }) catch null;
}

/// Signal completion and join the watchdog thread (exits within ~100 ms).
pub fn finishWatchdog(abort: *Abort, thread: ?std.Thread) void {
    abort.done.store(true, .release);
    if (thread) |t| t.join();
}

fn watchdogMain(abort: *Abort, timeout_ms: i64) void {
    const step_ms: i64 = 100;
    var elapsed: i64 = 0;
    while (elapsed < timeout_ms) {
        std.Io.sleep(abort.io, .fromMilliseconds(step_ms), .awake) catch return;
        if (abort.done.load(.acquire)) return;
        elapsed += step_ms;
    }
    abort.fire();
}

/// Check whether Ollama is running and whether the embedding model is pulled.
/// Any network failure is reported as `running = false` (no error returned).
/// When `abort` is given, the socket is published to it so a watchdog can
/// interrupt a wedged read.
pub fn checkStatus(
    io: std.Io,
    allocator: std.mem.Allocator,
    abort: ?*Abort,
    models: ModelPrefixes,
) Status {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const names = listPulledNames(io, a, abort) orelse
        return .{ .running = false, .model_pulled = false };
    if (firstPrefixed(names, models.embed)) |name| {
        const owned = allocator.dupe(u8, name) catch
            return .{ .running = true, .model_pulled = false, .model_name = "" };
        return .{ .running = true, .model_pulled = true, .model_name = owned };
    }
    return .{ .running = true, .model_pulled = false, .model_name = "" };
}

/// Check whether Ollama is running and whether both the summary model and
/// the embedding model are pulled. Caller owns `embed_model_name` and
/// `summary_model_name` via `allocator`.
pub fn checkSummaryStatus(
    io: std.Io,
    allocator: std.mem.Allocator,
    abort: ?*Abort,
    models: ModelPrefixes,
) SummaryStatus {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const names = listPulledNames(io, a, abort) orelse
        return .{ .running = false, .embed_pulled = false, .summary_pulled = false };
    var status: SummaryStatus = .{ .running = true, .embed_pulled = false, .summary_pulled = false };
    if (firstPrefixed(names, models.embed)) |name| {
        status.embed_model_name = allocator.dupe(u8, name) catch "";
        status.embed_pulled = status.embed_model_name.len > 0;
    }
    if (firstPrefixed(names, models.summary)) |name| {
        status.summary_model_name = allocator.dupe(u8, name) catch "";
        status.summary_pulled = status.summary_model_name.len > 0;
    }
    return status;
}

pub const ChatModels = struct {
    running: bool,
    names: [][]u8 = &.{},
};

/// List chat models from Ollama, skipping the embedding model prefix.
/// Caller owns `names` (each string and the outer slice) via `allocator`.
pub fn listChatModels(
    io: std.Io,
    allocator: std.mem.Allocator,
    abort: ?*Abort,
    models: ModelPrefixes,
) ChatModels {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const pulled = listPulledNames(io, a, abort) orelse
        return .{ .running = false };

    var names = std.ArrayList([]u8).empty;
    errdefer {
        for (names.items) |name| allocator.free(name);
        names.deinit(allocator);
    }
    for (pulled) |name| {
        if (std.mem.startsWith(u8, name, models.embed)) continue;
        const owned = allocator.dupe(u8, name) catch continue;
        names.append(allocator, owned) catch {
            allocator.free(owned);
            continue;
        };
    }
    const slice = names.toOwnedSlice(allocator) catch {
        for (names.items) |name| allocator.free(name);
        names.deinit(allocator);
        return .{ .running = true };
    };
    return .{ .running = true, .names = slice };
}

/// Chat's Ollama warning offers a Start button; this is what it runs. Sage
/// asks LaunchServices to open the macOS app, and falls back to an `ollama
/// serve` CLI install. Both paths then wait for `/api/tags`, so the warning
/// clears only once a local model server really answers.
pub const start_timeout_ms: i64 = 30_000;
pub const start_poll_ms: i64 = 500;
/// A wedged server must not hold the worker that is waiting for it.
pub const status_timeout_ms: i64 = 10_000;
pub const macos_app_name = "Ollama";
const macos_open_path = "/usr/bin/open";
const macos_env_path = "/usr/bin/env";
const cli_name = "ollama";
/// A packaged app inherits launchd's PATH, which holds neither Homebrew
/// prefix, so the usual install locations are checked directly.
const cli_search_dirs = [_][]const u8{
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Applications/Ollama.app/Contents/Resources",
};
/// `open` normally exits as soon as LaunchServices accepts the launch, so this
/// deadline only covers a stuck LaunchServices. It is not the server wait:
/// that budget is `start_timeout_ms`, inside `waitUntilRunning`.
const open_wait_ms: i64 = 3_000;
/// How often the wait for `open` re-checks whether it exited, and how often it
/// re-checks the elapsed budget.
const open_poll_ms: i64 = 50;

pub const StartError = error{
    /// Neither the app nor an `ollama` CLI is on this Mac.
    OllamaNotInstalled,
    /// Something launched but never answered `/api/tags`.
    OllamaStartTimeout,
};

/// Start Ollama and wait until it answers. An already running server is not
/// an error. `path_env` is the parent PATH; it may be empty.
pub fn startServer(io: std.Io, allocator: std.mem.Allocator, path_env: ?[]const u8) !void {
    if (isRunning(io, allocator)) return;
    if (launchApp(io, macos_app_name)) {
        return waitUntilRunning(io, allocator);
    }
    const cli = findCli(io, allocator, path_env) orelse return StartError.OllamaNotInstalled;
    defer allocator.free(cli);
    try launchServe(io, cli);
    return waitUntilRunning(io, allocator);
}

/// The first `ollama` executable on `path_env`, then in the usual install
/// locations. Caller owns the returned path.
pub fn findCli(io: std.Io, allocator: std.mem.Allocator, path_env: ?[]const u8) ?[]const u8 {
    if (path_env) |path| {
        var dirs = std.mem.splitScalar(u8, path, ':');
        while (dirs.next()) |dir| {
            if (dir.len == 0) continue;
            if (cliIn(io, allocator, dir)) |found| return found;
        }
    }
    for (cli_search_dirs) |dir| {
        if (cliIn(io, allocator, dir)) |found| return found;
    }
    return null;
}

fn cliIn(io: std.Io, allocator: std.mem.Allocator, dir: []const u8) ?[]const u8 {
    const path = std.fs.path.join(allocator, &.{ dir, cli_name }) catch return null;
    const stat = std.Io.Dir.cwd().statFile(io, path, .{}) catch {
        allocator.free(path);
        return null;
    };
    if (stat.kind != .file) {
        allocator.free(path);
        return null;
    }
    return path;
}

/// `open -a <name>` hands the launch to LaunchServices, which finds the app
/// wherever it is installed. `false` means no app by that name.
fn launchApp(io: std.Io, app_name: []const u8) bool {
    const argv = [_][]const u8{ macos_open_path, "-a", app_name };
    var child = std.process.spawn(io, .{
        .argv = &argv,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    }) catch return false;
    const term = waitForOpen(io, &child, open_wait_ms) orelse return false;
    return switch (term) {
        .exited => |code| code == 0,
        else => false,
    };
}

/// Waits up to `timeout_ms` for `open` and reports its term; a child that
/// outlives the budget is signalled, so its term reads as the signal. A hung
/// `open` would otherwise hold the start worker, and the notice with it, until
/// the bridge call returned.
fn waitForOpen(io: std.Io, child: *std.process.Child, timeout_ms: i64) ?std.process.Child.Term {
    var watch: OpenWatch = .{
        .io = io,
        .pid = child.id orelse return null,
        .timeout_ms = timeout_ms,
    };
    // No watchdog means no way to bound the wait, so report no app instead of
    // blocking; the child is dropped the way the server Sage starts is.
    const watchdog: ?std.Thread = if (builtin.os.tag == .windows)
        null
    else
        std.Thread.spawn(.{}, OpenWatch.run, .{&watch}) catch return null;
    const term = child.wait(io) catch null;
    if (watchdog) |thread| {
        watch.done.store(true, .release);
        thread.join();
    }
    return term;
}

/// Signals `open` once it outlives its budget. Only the waiting thread reaps:
/// `std.process.Child.kill` waits for the child itself, and a second waiter on
/// one pid is a double free inside the std implementation.
const OpenWatch = struct {
    io: std.Io,
    pid: std.process.Child.Id,
    timeout_ms: i64,
    done: std.atomic.Value(bool) = .init(false),

    fn run(self: *OpenWatch) void {
        var waited_ms: i64 = 0;
        while (waited_ms < self.timeout_ms) {
            std.Io.sleep(self.io, .fromMilliseconds(open_poll_ms), .awake) catch return;
            if (self.done.load(.acquire)) return;
            waited_ms += open_poll_ms;
        }
        std.posix.kill(self.pid, .TERM) catch {};
    }
};

/// `ollama serve` stays in the foreground, so it gets its own process group
/// and ignored stdio: the server keeps running after Sage quits. `/usr/bin/env`
/// pins the bind address, so an inherited `OLLAMA_HOST` cannot move the server
/// off the loopback interface Sage calls.
fn launchServe(io: std.Io, cli: []const u8) !void {
    var host_var_buf: [64]u8 = undefined;
    const host_var = try std.fmt.bufPrint(
        &host_var_buf,
        "OLLAMA_HOST={s}:{d}",
        .{ host, port },
    );
    const argv = [_][]const u8{ macos_env_path, host_var, cli, "serve" };
    // The handle is dropped on purpose: Sage does not own the server it
    // started, and a later Start finds it running and returns at once.
    _ = try std.process.spawn(io, .{
        .argv = &argv,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .pgid = if (builtin.os.tag == .windows) null else 0,
    });
}

fn waitUntilRunning(io: std.Io, allocator: std.mem.Allocator) !void {
    // Wall time, not a poll count: one probe can sit on the socket for
    // `status_timeout_ms`, so counting `start_poll_ms` steps alone would
    // stretch this budget from 30 seconds to minutes.
    const started = std.Io.Clock.Timestamp.now(io, .awake);
    while (!isRunning(io, allocator)) {
        if (started.untilNow(io).raw.toMilliseconds() >= start_timeout_ms) {
            return StartError.OllamaStartTimeout;
        }
        std.Io.sleep(io, .fromMilliseconds(start_poll_ms), .awake) catch
            return StartError.OllamaStartTimeout;
    }
}

/// True when Ollama answers `/api/tags`.
fn isRunning(io: std.Io, allocator: std.mem.Allocator) bool {
    var abort: Abort = .{ .io = io };
    const watchdog = startWatchdog(&abort, status_timeout_ms);
    defer finishWatchdog(&abort, watchdog);
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    return listPulledNames(io, arena.allocator(), &abort) != null;
}

/// Ollama library names are `name`, `name:tag`, or `namespace/name:tag`.
pub fn validModelName(name: []const u8) bool {
    if (name.len == 0 or name.len > 128) return false;
    for (name) |c| {
        const ok = std.ascii.isAlphanumeric(c) or c == '.' or c == '_' or c == '-' or c == ':' or c == '/';
        if (!ok) return false;
    }
    return true;
}

/// CPU name, RAM, and core count for canirun.ai. Caller owns `chip_name`
/// when it is non-empty.
pub fn hardwareInfo(io: std.Io, allocator: std.mem.Allocator) HardwareInfo {
    if (comptime builtin.os.tag == .macos) {
        return hardwareInfoMacos(allocator);
    }
    return hardwareInfoLinux(io, allocator);
}

/// `POST /api/pull` and stream NDJSON progress into `state` until success,
/// error, or `abort` fires.
pub fn pullModel(
    io: std.Io,
    allocator: std.mem.Allocator,
    name: []const u8,
    state: *PullState,
    abort: ?*Abort,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var request_body = std.ArrayList(u8).empty;
    try appendModelObject(&request_body, a, name, ",\"stream\":true}");

    const address = std.Io.net.IpAddress.resolve(io, host, port) catch return error.OllamaNotRunning;
    const stream = std.Io.net.IpAddress.connect(&address, io, .{ .mode = .stream, .protocol = .tcp }) catch return error.OllamaNotRunning;
    defer stream.close(io);
    if (abort) |handle| handle.arm(stream);
    defer if (abort) |handle| handle.disarm();

    var header_buffer: [384]u8 = undefined;
    const header = std.fmt.bufPrint(
        &header_buffer,
        "POST /api/pull HTTP/1.1\r\nHost: {s}\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n",
        .{ host, request_body.items.len },
    ) catch return error.RequestTooLarge;
    var write_buffer: [4096]u8 = undefined;
    var stream_writer = std.Io.net.Stream.writer(stream, io, &write_buffer);
    try stream_writer.interface.writeAll(header);
    try stream_writer.interface.writeAll(request_body.items);
    try stream_writer.interface.flush();

    var reader_buffer: [8192]u8 = undefined;
    var dest_buffer: [8192]u8 = undefined;
    var stream_reader = std.Io.net.Stream.reader(stream, io, &reader_buffer);

    var raw = std.ArrayList(u8).empty;
    var headers_end: ?usize = null;
    while (headers_end == null) {
        if (abortFired(abort)) return error.OllamaCancelled;
        const len = stream_reader.interface.readSliceShort(&dest_buffer) catch break;
        if (len == 0) break;
        try raw.appendSlice(a, dest_buffer[0..len]);
        headers_end = std.mem.indexOf(u8, raw.items, "\r\n\r\n");
    }
    const sep = headers_end orelse return error.InvalidResponse;
    if (!statusIs2xx(raw.items)) return error.OllamaRequestFailed;
    const leftover = raw.items[sep + 4 ..];
    const chunked = transferIsChunked(raw.items[0..sep]);

    var decoder = ChunkedDecoder{};
    var decoded = std.ArrayList(u8).empty;
    var line_buf = std.ArrayList(u8).empty;
    var succeeded = false;

    if (chunked) {
        try decoder.push(a, leftover, &decoded);
        try feedPullLines(&line_buf, a, decoded.items, state, io, &succeeded);
        decoded.clearRetainingCapacity();
    } else {
        try feedPullLines(&line_buf, a, leftover, state, io, &succeeded);
    }

    while (!succeeded) {
        if (abortFired(abort)) return error.OllamaCancelled;
        const len = stream_reader.interface.readSliceShort(&dest_buffer) catch break;
        if (len == 0) break;
        if (chunked) {
            try decoder.push(a, dest_buffer[0..len], &decoded);
            try feedPullLines(&line_buf, a, decoded.items, state, io, &succeeded);
            decoded.clearRetainingCapacity();
        } else {
            try feedPullLines(&line_buf, a, dest_buffer[0..len], state, io, &succeeded);
        }
    }

    if (line_buf.items.len > 0) {
        const line = std.mem.trim(u8, line_buf.items, " \t\r\n");
        if (line.len > 0) {
            if (try applyPullLine(state, io, a, line)) succeeded = true;
        }
    }

    if (abortFired(abort)) return error.OllamaCancelled;
    if (!succeeded) return error.OllamaRequestFailed;
}

/// `DELETE /api/delete` for a local Ollama model tag.
pub fn deleteModel(io: std.Io, allocator: std.mem.Allocator, name: []const u8, abort: ?*Abort) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var request_body = std.ArrayList(u8).empty;
    try appendModelObject(&request_body, a, name, "}");

    const address = std.Io.net.IpAddress.resolve(io, host, port) catch return error.OllamaNotRunning;
    const stream = std.Io.net.IpAddress.connect(&address, io, .{ .mode = .stream, .protocol = .tcp }) catch return error.OllamaNotRunning;
    defer stream.close(io);
    if (abort) |handle| handle.arm(stream);
    defer if (abort) |handle| handle.disarm();

    var header_buffer: [384]u8 = undefined;
    const header = std.fmt.bufPrint(
        &header_buffer,
        "DELETE /api/delete HTTP/1.1\r\nHost: {s}\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n",
        .{ host, request_body.items.len },
    ) catch return error.RequestTooLarge;
    var write_buffer: [4096]u8 = undefined;
    var stream_writer = std.Io.net.Stream.writer(stream, io, &write_buffer);
    try stream_writer.interface.writeAll(header);
    try stream_writer.interface.writeAll(request_body.items);
    try stream_writer.interface.flush();

    var response = std.ArrayList(u8).empty;
    var reader_buffer: [4096]u8 = undefined;
    var dest_buffer: [4096]u8 = undefined;
    var stream_reader = std.Io.net.Stream.reader(stream, io, &reader_buffer);
    while (true) {
        const len = stream_reader.interface.readSliceShort(&dest_buffer) catch break;
        if (len == 0) break;
        try response.appendSlice(a, dest_buffer[0..len]);
    }

    if (abort) |handle| {
        if (handle.fired.load(.acquire)) return error.OllamaTimeout;
    }
    if (!statusIs2xx(response.items)) return error.OllamaRequestFailed;
}

/// Embed a batch of text chunks via `POST /api/embed`. Returns one `[]f32` per
/// input chunk. Caller owns the returned slices (and the outer slice) via
/// `allocator`. When `abort` is given, the socket is published to it and a
/// fired watchdog fails the call with `error.OllamaTimeout`.
pub fn embed(
    io: std.Io,
    allocator: std.mem.Allocator,
    chunks: []const []const u8,
    model_name: []const u8,
    abort: ?*Abort,
) ![][]f32 {
    if (chunks.len == 0) return try allocator.alloc([]f32, 0);

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var request_body = std.ArrayList(u8).empty;
    try request_body.appendSlice(a, "{\"model\":");
    try writeJsonString(&request_body, a, model_name);
    try request_body.appendSlice(a, ",\"input\":[");
    for (chunks, 0..) |chunk, index| {
        if (index > 0) try request_body.appendSlice(a, ",");
        try writeJsonString(&request_body, a, chunk);
    }
    try request_body.appendSlice(a, "]}");

    const address = try std.Io.net.IpAddress.resolve(io, host, port);
    const stream = try std.Io.net.IpAddress.connect(&address, io, .{ .mode = .stream, .protocol = .tcp });
    defer stream.close(io);
    if (abort) |handle| handle.arm(stream);
    defer if (abort) |handle| handle.disarm();

    var header_buffer: [256]u8 = undefined;
    const header = std.fmt.bufPrint(&header_buffer, "POST /api/embed HTTP/1.1\r\nHost: {s}\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{ host, request_body.items.len }) catch return error.RequestTooLarge;
    var write_buffer: [4096]u8 = undefined;
    var stream_writer = std.Io.net.Stream.writer(stream, io, &write_buffer);
    try stream_writer.interface.writeAll(header);
    try stream_writer.interface.writeAll(request_body.items);
    try stream_writer.interface.flush();

    var response = std.ArrayList(u8).empty;
    var reader_buffer: [8192]u8 = undefined;
    var dest_buffer: [8192]u8 = undefined;
    var stream_reader = std.Io.net.Stream.reader(stream, io, &reader_buffer);
    while (true) {
        const len = stream_reader.interface.readSliceShort(&dest_buffer) catch break;
        if (len == 0) break;
        try response.appendSlice(a, dest_buffer[0..len]);
    }

    if (abort) |handle| {
        if (handle.fired.load(.acquire)) return error.OllamaTimeout;
    }
    if (!statusIs2xx(response.items)) return error.OllamaRequestFailed;
    const body = httpBody(response.items, a) orelse return error.InvalidResponse;

    var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{ .allocate = .alloc_always });
    defer parsed.deinit();
    const root = parsed.value;
    if (root != .object) return error.InvalidResponse;
    const embeddings = root.object.get("embeddings") orelse return error.InvalidResponse;
    if (embeddings != .array) return error.InvalidResponse;
    if (embeddings.array.items.len != chunks.len) return error.EmbeddingCountMismatch;

    const result = try allocator.alloc([]f32, chunks.len);
    var filled: usize = 0;
    errdefer {
        for (result[0..filled]) |vec| allocator.free(vec);
        allocator.free(result);
    }
    for (embeddings.array.items, 0..) |item, index| {
        if (item != .array) return error.InvalidResponse;
        const vec = try allocator.alloc(f32, item.array.items.len);
        errdefer allocator.free(vec);
        for (item.array.items, 0..) |component, ci| {
            switch (component) {
                .float => |f| vec[ci] = @floatCast(f),
                .integer => |i| vec[ci] = @floatFromInt(i),
                else => return error.InvalidResponse,
            }
        }
        result[index] = vec;
        filled += 1;
    }
    return result;
}

/// Ask the summary model for a short plain-text summary of `text`. Caller
/// owns the returned slice via `allocator`. Empty entries get a fixed
/// sentence so they still receive an embedding. Residual `<think>` blocks
/// are stripped even when the request asked the model not to think.
pub fn summarize(
    io: std.Io,
    allocator: std.mem.Allocator,
    text: []const u8,
    model_name: []const u8,
    abort: ?*Abort,
) ![]u8 {
    return summarizeWithPrefix(io, allocator, text, model_name, abort, summary_prompt_prefix, "This journal entry is empty.", max_summary_input_bytes);
}

/// Same as `summarize`, with a prompt written for a chat transcript.
pub fn summarizeChat(
    io: std.Io,
    allocator: std.mem.Allocator,
    text: []const u8,
    model_name: []const u8,
    abort: ?*Abort,
) ![]u8 {
    return summarizeWithPrefix(io, allocator, text, model_name, abort, chat_summary_prompt_prefix, "This conversation is empty.", max_summary_input_bytes);
}

/// Ask the summary model for a short title from recent chat messages.
/// Caller owns the returned slice. Empty input or empty model output
/// is `error.EmptyTitle`. Residual `<think>` blocks are stripped.
pub fn titleChat(
    io: std.Io,
    allocator: std.mem.Allocator,
    text: []const u8,
    model_name: []const u8,
    abort: ?*Abort,
) ![]u8 {
    const trimmed = std.mem.trim(u8, text, " \t\r\n");
    if (trimmed.len == 0) return error.EmptyTitle;

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const input = if (trimmed.len <= max_title_input_bytes)
        trimmed
    else
        trimmed[0..utf8SafeEnd(trimmed, 0, max_title_input_bytes)];

    var prompt = std.ArrayList(u8).empty;
    try prompt.appendSlice(a, chat_title_prompt_prefix);
    try prompt.appendSlice(a, input);

    const cleaned = try generateText(io, a, prompt.items, model_name, abort);
    return clipChatTitle(allocator, cleaned);
}

/// First line, no wrapping quotes or `Title:` label, collapsed
/// whitespace, clipped to `title_limit` with an ellipsis.
pub fn clipChatTitle(allocator: std.mem.Allocator, text: []const u8) ![]u8 {
    var t = firstLine(text);
    t = std.mem.trim(u8, t, " \t\r");
    t = stripWrappingQuotes(t);
    t = stripTitleLabel(t);
    t = stripWrappingQuotes(t);
    const collapsed = try collapseWhitespace(allocator, t);
    defer allocator.free(collapsed);
    if (collapsed.len == 0) return error.EmptyTitle;
    if (collapsed.len <= title_limit) return try allocator.dupe(u8, collapsed);
    const keep = utf8SafeEnd(collapsed, 0, title_limit - 1);
    if (keep == 0) return error.EmptyTitle;
    const ellipsis = "…";
    const out = try allocator.alloc(u8, keep + ellipsis.len);
    @memcpy(out[0..keep], collapsed[0..keep]);
    @memcpy(out[keep..], ellipsis);
    return out;
}

fn firstLine(text: []const u8) []const u8 {
    if (std.mem.indexOfScalar(u8, text, '\n')) |index| {
        var line = text[0..index];
        if (line.len > 0 and line[line.len - 1] == '\r') {
            line = line[0 .. line.len - 1];
        }
        return line;
    }
    return text;
}

fn stripWrappingQuotes(text: []const u8) []const u8 {
    const t = std.mem.trim(u8, text, " \t");
    if (t.len < 2) return t;
    const first = t[0];
    const last = t[t.len - 1];
    if ((first == '"' and last == '"') or (first == '\'' and last == '\'')) {
        return std.mem.trim(u8, t[1 .. t.len - 1], " \t");
    }
    return t;
}

fn stripTitleLabel(text: []const u8) []const u8 {
    const t = std.mem.trim(u8, text, " \t");
    if (t.len >= 6 and std.ascii.eqlIgnoreCase(t[0..6], "title:")) {
        return std.mem.trim(u8, t[6..], " \t");
    }
    return t;
}

fn collapseWhitespace(allocator: std.mem.Allocator, text: []const u8) ![]u8 {
    var out = std.ArrayList(u8).empty;
    errdefer out.deinit(allocator);
    var pending_space = false;
    for (text) |byte| {
        const space = byte == ' ' or byte == '\t' or byte == '\n' or byte == '\r';
        if (space) {
            if (out.items.len > 0) pending_space = true;
            continue;
        }
        if (pending_space) {
            try out.append(allocator, ' ');
            pending_space = false;
        }
        try out.append(allocator, byte);
    }
    return out.toOwnedSlice(allocator);
}

fn summarizeWithPrefix(
    io: std.Io,
    allocator: std.mem.Allocator,
    text: []const u8,
    model_name: []const u8,
    abort: ?*Abort,
    prefix: []const u8,
    empty_text: []const u8,
    max_input: usize,
) ![]u8 {
    const trimmed = std.mem.trim(u8, text, " \t\r\n");
    if (trimmed.len == 0) return try allocator.dupe(u8, empty_text);

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const input = if (trimmed.len <= max_input)
        trimmed
    else
        trimmed[0..utf8SafeEnd(trimmed, 0, max_input)];

    var prompt = std.ArrayList(u8).empty;
    try prompt.appendSlice(a, prefix);
    try prompt.appendSlice(a, input);

    const cleaned = try generateText(io, a, prompt.items, model_name, abort);
    if (cleaned.len == 0) return error.EmptySummary;
    return try allocator.dupe(u8, cleaned);
}

pub const ExtractedFact = struct {
    subject: []u8,
    fact: []u8,
};

pub const ExtractedEvent = struct {
    event: []u8,
    date: []u8,
};

pub const Extraction = struct {
    profile: [][]u8 = &.{},
    facts: []ExtractedFact = &.{},
    events: []ExtractedEvent = &.{},

    pub fn deinit(self: Extraction, allocator: std.mem.Allocator) void {
        for (self.profile) |item| allocator.free(item);
        if (self.profile.len > 0) allocator.free(self.profile);
        for (self.facts) |item| {
            allocator.free(item.subject);
            allocator.free(item.fact);
        }
        if (self.facts.len > 0) allocator.free(self.facts);
        for (self.events) |item| {
            allocator.free(item.event);
            allocator.free(item.date);
        }
        if (self.events.len > 0) allocator.free(self.events);
    }
};

/// Ask the summary model for JSON memories. Caller owns the result via
/// `allocator`. Malformed model output is salvaged when a JSON object can
/// still be found; otherwise the extraction is empty, not an error.
pub fn extract(
    io: std.Io,
    allocator: std.mem.Allocator,
    text: []const u8,
    model_name: []const u8,
    abort: ?*Abort,
) !Extraction {
    const trimmed = std.mem.trim(u8, text, " \t\r\n");
    if (trimmed.len == 0) return .{};

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const input = if (trimmed.len <= max_extract_input_bytes)
        trimmed
    else
        trimmed[0..utf8SafeEnd(trimmed, 0, max_extract_input_bytes)];

    var prompt = std.ArrayList(u8).empty;
    try prompt.appendSlice(a, extract_prompt_prefix);
    try prompt.appendSlice(a, input);

    const cleaned = try generateText(io, a, prompt.items, model_name, abort);
    return parseExtraction(allocator, cleaned);
}

/// Extract plain text from a journal entry body. `markdown` and `plain`
/// formats pass through unchanged. `tiptap` JSON bodies are walked: text nodes
/// are concatenated and block nodes are separated by `\n\n`.
pub fn extractPlainText(allocator: std.mem.Allocator, body: []const u8, format: []const u8) ![]u8 {
    if (std.mem.eql(u8, format, "markdown") or std.mem.eql(u8, format, "plain")) {
        return try allocator.dupe(u8, body);
    }
    if (std.mem.eql(u8, format, "tiptap")) {
        return try tiptapToPlainText(allocator, body);
    }
    return try allocator.dupe(u8, body);
}

/// Split text into chunks of at most `max_chunk_bytes` UTF-8 bytes, breaking on
/// paragraph boundaries (`\n\n`) where possible. A single oversized paragraph
/// is hard-split at UTF-8-safe boundaries. Caller owns the returned slices.
pub fn chunkText(allocator: std.mem.Allocator, text: []const u8) ![][]const u8 {
    if (text.len == 0) return try allocator.alloc([]const u8, 0);
    if (text.len <= max_chunk_bytes) {
        const result = try allocator.alloc([]const u8, 1);
        result[0] = try allocator.dupe(u8, text);
        return result;
    }

    var chunks = std.ArrayList([]const u8).empty;
    var current = std.ArrayList(u8).empty;
    var paragraph_start: usize = 0;
    var i: usize = 0;
    while (i < text.len) {
        const at_boundary = i + 1 < text.len and text[i] == '\n' and text[i + 1] == '\n';
        if (at_boundary) {
            try appendParagraph(&chunks, &current, allocator, text[paragraph_start..i]);
            paragraph_start = i + 2;
            i = paragraph_start;
            continue;
        }
        i += 1;
    }
    // Handle the final paragraph (from last boundary to end of text).
    if (paragraph_start < text.len) {
        try appendParagraph(&chunks, &current, allocator, text[paragraph_start..text.len]);
    }
    if (current.items.len > 0) {
        try chunks.append(allocator, try allocator.dupe(u8, current.items));
    }
    current.deinit(allocator);
    return try chunks.toOwnedSlice(allocator);
}

/// Add one paragraph to the chunk under construction in `current`, flushing it
/// into `chunks` when full and hard-splitting a paragraph that exceeds
/// `max_chunk_bytes` on its own.
fn appendParagraph(
    chunks: *std.ArrayList([]const u8),
    current: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    paragraph: []const u8,
) !void {
    const separator_len: usize = if (current.items.len > 0) 2 else 0;
    if (current.items.len + separator_len + paragraph.len > max_chunk_bytes and current.items.len > 0) {
        try chunks.append(allocator, try allocator.dupe(u8, current.items));
        current.clearRetainingCapacity();
    }
    if (paragraph.len > max_chunk_bytes) {
        if (current.items.len > 0) {
            try chunks.append(allocator, try allocator.dupe(u8, current.items));
            current.clearRetainingCapacity();
        }
        var p_start: usize = 0;
        while (p_start < paragraph.len) {
            const p_end = utf8SafeEnd(paragraph, p_start, max_chunk_bytes);
            try chunks.append(allocator, try allocator.dupe(u8, paragraph[p_start..p_end]));
            p_start = p_end;
        }
    } else {
        if (current.items.len > 0) try current.appendSlice(allocator, "\n\n");
        try current.appendSlice(allocator, paragraph);
    }
}

// --- internals ---

fn abortFired(abort: ?*Abort) bool {
    const handle = abort orelse return false;
    return handle.fired.load(.acquire);
}

fn appendModelObject(out: *std.ArrayList(u8), a: std.mem.Allocator, name: []const u8, extra: []const u8) !void {
    try out.appendSlice(a, "{\"model\":");
    try writeJsonString(out, a, name);
    try out.appendSlice(a, ",\"name\":");
    try writeJsonString(out, a, name);
    try out.appendSlice(a, extra);
}

fn ownedName(allocator: std.mem.Allocator, text: []const u8) []const u8 {
    return allocator.dupe(u8, text) catch "";
}

fn hardwareInfoMacos(allocator: std.mem.Allocator) HardwareInfo {
    var brand_buf: [128]u8 = undefined;
    const chip = sysctlString("machdep.cpu.brand_string", &brand_buf) orelse "Apple Silicon";
    var ram_gb: u32 = 8;
    if (sysctlU64("hw.memsize")) |bytes| {
        ram_gb = @intCast(@max(@as(u64, 1), (bytes + 512 * 1024 * 1024) / (1024 * 1024 * 1024)));
    }
    var cores: u32 = 1;
    if (sysctlU32("hw.physicalcpu")) |count| {
        cores = @max(count, 1);
    }
    return .{
        .chip_name = ownedName(allocator, chip),
        .ram_gb = ram_gb,
        .cpu_cores = cores,
    };
}

fn hardwareInfoLinux(io: std.Io, allocator: std.mem.Allocator) HardwareInfo {
    var ram_gb: u32 = 8;
    var cores: u32 = 1;
    var chip: []const u8 = "Linux";

    if (readProcFile(io, allocator, "/proc/meminfo")) |text| {
        defer allocator.free(text);
        if (parseMemTotalGb(text)) |gb| ram_gb = gb;
    }
    if (readProcFile(io, allocator, "/proc/cpuinfo")) |text| {
        defer allocator.free(text);
        cores = parseCpuCores(text);
        chip = parseCpuName(text);
        return .{
            .chip_name = ownedName(allocator, chip),
            .ram_gb = ram_gb,
            .cpu_cores = cores,
        };
    }
    return .{
        .chip_name = ownedName(allocator, chip),
        .ram_gb = ram_gb,
        .cpu_cores = cores,
    };
}

fn readProcFile(io: std.Io, allocator: std.mem.Allocator, path: []const u8) ?[]u8 {
    var file = std.Io.Dir.cwd().openFile(io, path, .{}) catch return null;
    defer file.close(io);
    var read_buffer: [1024]u8 = undefined;
    var reader = file.reader(io, &read_buffer);
    return reader.interface.allocRemaining(allocator, .limited(32 * 1024)) catch null;
}

fn parseMemTotalGb(text: []const u8) ?u32 {
    const key = "MemTotal:";
    const start = std.mem.indexOf(u8, text, key) orelse return null;
    const rest = std.mem.trimStart(u8, text[start + key.len ..], " \t");
    var end: usize = 0;
    while (end < rest.len and rest[end] >= '0' and rest[end] <= '9') end += 1;
    const kb = std.fmt.parseInt(u64, rest[0..end], 10) catch return null;
    const gb = (kb + 512 * 1024) / (1024 * 1024);
    return @intCast(@max(gb, 1));
}

fn parseCpuCores(text: []const u8) u32 {
    var count: u32 = 0;
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "processor")) count += 1;
    }
    return if (count == 0) 1 else count;
}

fn parseCpuName(text: []const u8) []const u8 {
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "model name") or std.mem.startsWith(u8, line, "Hardware")) {
            const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
            const name = std.mem.trim(u8, line[colon + 1 ..], " \t\r");
            if (name.len > 0) return name;
        }
    }
    return "Linux";
}

fn sysctlString(name: [*:0]const u8, buf: []u8) ?[]const u8 {
    if (comptime builtin.os.tag != .macos) return null;
    var size: usize = buf.len;
    if (std.c.sysctlbyname(name, buf.ptr, &size, null, 0) != 0) return null;
    if (size == 0) return null;
    const n = if (buf[size - 1] == 0) size - 1 else size;
    return std.mem.trim(u8, buf[0..n], " \t\r\n");
}

fn sysctlU64(name: [*:0]const u8) ?u64 {
    if (comptime builtin.os.tag != .macos) return null;
    var value: u64 = 0;
    var size: usize = @sizeOf(u64);
    if (std.c.sysctlbyname(name, &value, &size, null, 0) != 0) return null;
    return value;
}

fn sysctlU32(name: [*:0]const u8) ?u32 {
    if (comptime builtin.os.tag != .macos) return null;
    var value: u32 = 0;
    var size: usize = @sizeOf(u32);
    if (std.c.sysctlbyname(name, &value, &size, null, 0) != 0) return null;
    return value;
}

const ChunkedDecoder = struct {
    pending: std.ArrayList(u8) = .empty,
    remaining: usize = 0,
    phase: enum { size, data, crlf, done } = .size,
    done: bool = false,

    fn push(self: *ChunkedDecoder, a: std.mem.Allocator, bytes: []const u8, out: *std.ArrayList(u8)) !void {
        try self.pending.appendSlice(a, bytes);
        try self.drain(a, out);
    }

    fn drain(self: *ChunkedDecoder, a: std.mem.Allocator, out: *std.ArrayList(u8)) !void {
        while (!self.done) {
            switch (self.phase) {
                .size => {
                    const idx = std.mem.indexOf(u8, self.pending.items, "\r\n") orelse return;
                    var size_text = self.pending.items[0..idx];
                    if (std.mem.indexOfScalar(u8, size_text, ';')) |semi| size_text = size_text[0..semi];
                    self.remaining = std.fmt.parseInt(usize, std.mem.trim(u8, size_text, " \t"), 16) catch
                        return error.InvalidChunkedBody;
                    self.consume(idx + 2);
                    if (self.remaining == 0) {
                        self.done = true;
                        self.phase = .done;
                        return;
                    }
                    self.phase = .data;
                },
                .data => {
                    if (self.pending.items.len == 0) return;
                    const take = @min(self.remaining, self.pending.items.len);
                    try out.appendSlice(a, self.pending.items[0..take]);
                    self.consume(take);
                    self.remaining -= take;
                    if (self.remaining == 0) self.phase = .crlf;
                },
                .crlf => {
                    if (self.pending.items.len < 2) return;
                    if (self.pending.items[0] != '\r' or self.pending.items[1] != '\n') {
                        return error.InvalidChunkedBody;
                    }
                    self.consume(2);
                    self.phase = .size;
                },
                .done => return,
            }
        }
    }

    fn consume(self: *ChunkedDecoder, n: usize) void {
        const rest_len = self.pending.items.len - n;
        std.mem.copyForwards(u8, self.pending.items[0..rest_len], self.pending.items[n..]);
        self.pending.shrinkRetainingCapacity(rest_len);
    }
};

fn feedPullLines(
    pending: *std.ArrayList(u8),
    a: std.mem.Allocator,
    bytes: []const u8,
    state: *PullState,
    io: std.Io,
    succeeded: *bool,
) !void {
    try pending.appendSlice(a, bytes);
    while (std.mem.indexOfScalar(u8, pending.items, '\n')) |nl| {
        var line = pending.items[0..nl];
        if (line.len > 0 and line[line.len - 1] == '\r') line = line[0 .. line.len - 1];
        if (line.len > 0) {
            if (try applyPullLine(state, io, a, line)) succeeded.* = true;
        }
        const rest_len = pending.items.len - nl - 1;
        std.mem.copyForwards(u8, pending.items[0..rest_len], pending.items[nl + 1 ..]);
        pending.shrinkRetainingCapacity(rest_len);
    }
}

fn applyPullLine(state: *PullState, io: std.Io, a: std.mem.Allocator, line: []const u8) !bool {
    var parsed = std.json.parseFromSlice(std.json.Value, a, line, .{ .allocate = .alloc_always }) catch
        return false;
    defer parsed.deinit();
    if (parsed.value != .object) return false;
    const obj = parsed.value.object;
    if (obj.get("error")) |err_val| {
        if (err_val == .string) state.setProgress(io, err_val.string, null, null);
        return error.OllamaRequestFailed;
    }
    const status = if (obj.get("status")) |s| (if (s == .string) s.string else "") else "";
    const completed = if (obj.get("completed")) |c| jsonU64(c) else null;
    const total = if (obj.get("total")) |t| jsonU64(t) else null;
    state.setProgress(io, status, completed, total);
    return std.mem.eql(u8, status, "success");
}

fn jsonU64(value: std.json.Value) ?u64 {
    return switch (value) {
        .integer => |i| if (i >= 0) @intCast(i) else null,
        .float => |f| if (f >= 0) @intFromFloat(f) else null,
        else => null,
    };
}

fn tiptapToPlainText(allocator: std.mem.Allocator, body: []const u8) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var parsed = std.json.parseFromSlice(std.json.Value, a, body, .{ .allocate = .alloc_always }) catch
        return try allocator.dupe(u8, "");
    defer parsed.deinit();

    var out = std.ArrayList(u8).empty;
    var pending_break = false;
    try walkTiptap(&out, a, parsed.value, &pending_break);
    return try allocator.dupe(u8, out.items);
}

/// Walk a Tiptap JSON doc, concatenating text nodes. Block nodes set
/// `pending_break` instead of writing a separator directly, so nested blocks
/// (a list item inside a list) collapse to one blank line before the next
/// text. `hardBreak` nodes emit a single newline.
fn walkTiptap(out: *std.ArrayList(u8), a: std.mem.Allocator, value: std.json.Value, pending_break: *bool) !void {
    switch (value) {
        .object => |obj| {
            const node_type = obj.get("type") orelse return;
            if (node_type != .string) return;
            const t = node_type.string;

            if (std.mem.eql(u8, t, "text")) {
                if (obj.get("text")) |text| {
                    if (text == .string) {
                        if (pending_break.* and out.items.len > 0) try out.appendSlice(a, "\n\n");
                        pending_break.* = false;
                        try out.appendSlice(a, text.string);
                    }
                }
                return;
            }

            if (std.mem.eql(u8, t, "hardBreak")) {
                if (pending_break.*) {
                    // The pending block break already separates here.
                    if (out.items.len > 0) try out.appendSlice(a, "\n\n");
                    pending_break.* = false;
                } else if (out.items.len > 0) {
                    try out.append(a, '\n');
                }
                return;
            }

            const block_nodes = [_][]const u8{
                "doc", "paragraph", "heading", "bulletList", "orderedList",
                "listItem", "blockquote", "codeBlock",
            };
            for (block_nodes) |bn| {
                if (std.mem.eql(u8, t, bn)) {
                    pending_break.* = true;
                    break;
                }
            }

            const content = obj.get("content");
            if (content) |c| if (c == .array) {
                for (c.array.items) |child| {
                    try walkTiptap(out, a, child, pending_break);
                }
            };
        },
        .array => |arr| {
            for (arr.items) |child| {
                try walkTiptap(out, a, child, pending_break);
            }
        },
        else => {},
    }
}

fn firstPrefixed(names: []const []const u8, prefix: []const u8) ?[]const u8 {
    for (names) |name| {
        if (std.mem.startsWith(u8, name, prefix)) return name;
    }
    return null;
}

/// GET `/api/tags` and return pulled model names allocated in `a`.
/// `null` means Ollama is not reachable.
fn listPulledNames(io: std.Io, a: std.mem.Allocator, abort: ?*Abort) ?[]const []const u8 {
    const address = std.Io.net.IpAddress.resolve(io, host, port) catch return null;
    const stream = std.Io.net.IpAddress.connect(&address, io, .{ .mode = .stream, .protocol = .tcp }) catch return null;
    defer stream.close(io);
    if (abort) |handle| handle.arm(stream);
    defer if (abort) |handle| handle.disarm();

    var request_buffer: [256]u8 = undefined;
    const request = std.fmt.bufPrint(&request_buffer, "GET /api/tags HTTP/1.1\r\nHost: {s}\r\nConnection: close\r\n\r\n", .{host}) catch
        return null;
    var write_buffer: [256]u8 = undefined;
    var stream_writer = std.Io.net.Stream.writer(stream, io, &write_buffer);
    stream_writer.interface.writeAll(request) catch return null;
    stream_writer.interface.flush() catch return null;

    var response = std.ArrayList(u8).empty;
    var reader_buffer: [4096]u8 = undefined;
    var dest_buffer: [4096]u8 = undefined;
    var stream_reader = std.Io.net.Stream.reader(stream, io, &reader_buffer);
    while (true) {
        const len = stream_reader.interface.readSliceShort(&dest_buffer) catch break;
        if (len == 0) break;
        response.appendSlice(a, dest_buffer[0..len]) catch return null;
    }

    if (!statusIs2xx(response.items)) return null;
    const body = httpBody(response.items, a) orelse return &.{};
    return pulledNamesFromTags(a, body);
}

/// True when `/api/tags` marks `item` as a cloud model. Ollama sets
/// `remote_host` and `remote_model` on those, and a prompt sent to one leaves
/// this Mac.
fn isRemoteModel(item: std.json.ObjectMap) bool {
    for ([_][]const u8{ "remote_host", "remote_model" }) |key| {
        const value = item.get(key) orelse continue;
        if (value == .string and value.string.len > 0) return true;
    }
    return false;
}

/// Parse a `/api/tags` body into the names of models that run on this Mac.
/// Cloud models are skipped so Chat, Dream, and embeddings never pick one.
fn pulledNamesFromTags(a: std.mem.Allocator, body: []const u8) []const []const u8 {
    const parsed = std.json.parseFromSlice(std.json.Value, a, body, .{ .allocate = .alloc_always }) catch
        return &.{};
    const root = parsed.value;
    if (root != .object) return &.{};
    const models = root.object.get("models") orelse return &.{};
    if (models != .array) return &.{};

    var names = std.ArrayList([]const u8).empty;
    for (models.array.items) |item| {
        if (item != .object) continue;
        if (isRemoteModel(item.object)) continue;
        const name = item.object.get("name") orelse continue;
        if (name != .string) continue;
        names.append(a, name.string) catch continue;
    }
    return names.toOwnedSlice(a) catch &.{};
}

/// Drop a leading `<think>…</think>` block (or a leftover closing tag) and
/// trim surrounding whitespace.
fn stripThink(text: []const u8) []const u8 {
    const close = "</think>";
    const rest = if (std.mem.indexOf(u8, text, close)) |end|
        text[end + close.len ..]
    else
        text;
    return std.mem.trim(u8, rest, " \t\r\n");
}

fn buildGenerateRequestBody(a: std.mem.Allocator, model_name: []const u8, prompt: []const u8) ![]u8 {
    var request_body = std.ArrayList(u8).empty;
    errdefer request_body.deinit(a);
    try request_body.appendSlice(a, "{\"model\":");
    try writeJsonString(&request_body, a, model_name);
    try request_body.appendSlice(a, ",\"prompt\":");
    try writeJsonString(&request_body, a, prompt);
    try request_body.appendSlice(a, ",\"stream\":false,\"think\":false,\"options\":{\"num_ctx\":");
    var context_buffer: [16]u8 = undefined;
    const context = try std.fmt.bufPrint(&context_buffer, "{d}", .{generate_context_tokens});
    try request_body.appendSlice(a, context);
    try request_body.appendSlice(a, "}}");
    return try request_body.toOwnedSlice(a);
}

/// POST `/api/generate` and return the cleaned `response` text allocated in
/// `a`. Residual `<think>` blocks are stripped.
fn generateText(
    io: std.Io,
    a: std.mem.Allocator,
    prompt: []const u8,
    model_name: []const u8,
    abort: ?*Abort,
) ![]const u8 {
    const request_body = try buildGenerateRequestBody(a, model_name, prompt);

    const address = try std.Io.net.IpAddress.resolve(io, host, port);
    const stream = try std.Io.net.IpAddress.connect(&address, io, .{ .mode = .stream, .protocol = .tcp });
    defer stream.close(io);
    if (abort) |handle| handle.arm(stream);
    defer if (abort) |handle| handle.disarm();

    var header_buffer: [256]u8 = undefined;
    const header = std.fmt.bufPrint(&header_buffer, "POST /api/generate HTTP/1.1\r\nHost: {s}\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{ host, request_body.len }) catch return error.RequestTooLarge;
    var write_buffer: [4096]u8 = undefined;
    var stream_writer = std.Io.net.Stream.writer(stream, io, &write_buffer);
    try stream_writer.interface.writeAll(header);
    try stream_writer.interface.writeAll(request_body);
    try stream_writer.interface.flush();

    var response = std.ArrayList(u8).empty;
    var reader_buffer: [8192]u8 = undefined;
    var dest_buffer: [8192]u8 = undefined;
    var stream_reader = std.Io.net.Stream.reader(stream, io, &reader_buffer);
    while (true) {
        const len = stream_reader.interface.readSliceShort(&dest_buffer) catch break;
        if (len == 0) break;
        try response.appendSlice(a, dest_buffer[0..len]);
    }

    if (abort) |handle| {
        if (handle.fired.load(.acquire)) return error.OllamaTimeout;
    }
    if (!statusIs2xx(response.items)) return error.OllamaRequestFailed;
    const body = httpBody(response.items, a) orelse return error.InvalidResponse;

    var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{ .allocate = .alloc_always });
    defer parsed.deinit();
    const root = parsed.value;
    if (root != .object) return error.InvalidResponse;
    const raw = root.object.get("response") orelse return error.InvalidResponse;
    if (raw != .string) return error.InvalidResponse;
    return stripThink(raw.string);
}

pub fn parseExtraction(allocator: std.mem.Allocator, raw: []const u8) !Extraction {
    const json_text = salvageJsonObject(raw) orelse return .{};
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, json_text, .{ .allocate = .alloc_always }) catch return .{};
    defer parsed.deinit();
    if (parsed.value != .object) return .{};

    var profile_list = std.ArrayList([]u8).empty;
    errdefer {
        for (profile_list.items) |item| allocator.free(item);
        profile_list.deinit(allocator);
    }
    var fact_list = std.ArrayList(ExtractedFact).empty;
    errdefer {
        for (fact_list.items) |item| {
            allocator.free(item.subject);
            allocator.free(item.fact);
        }
        fact_list.deinit(allocator);
    }
    var event_list = std.ArrayList(ExtractedEvent).empty;
    errdefer {
        for (event_list.items) |item| {
            allocator.free(item.event);
            allocator.free(item.date);
        }
        event_list.deinit(allocator);
    }

    if (parsed.value.object.get("profile")) |profile| if (profile == .array) {
        for (profile.array.items) |item| {
            if (profile_list.items.len >= 8) break;
            const text = jsonStringValue(item) orelse continue;
            const trimmed = std.mem.trim(u8, text, " \t\r\n");
            if (trimmed.len == 0) continue;
            try profile_list.append(allocator, try allocator.dupe(u8, trimmed));
        }
    };
    if (parsed.value.object.get("facts")) |facts| if (facts == .array) {
        for (facts.array.items) |item| {
            if (fact_list.items.len >= 12) break;
            if (item != .object) continue;
            const subject_raw = jsonStringValue(item.object.get("subject") orelse continue) orelse continue;
            const fact_raw = jsonStringValue(item.object.get("fact") orelse continue) orelse continue;
            const subject = std.mem.trim(u8, subject_raw, " \t\r\n");
            const fact = std.mem.trim(u8, fact_raw, " \t\r\n");
            if (subject.len == 0 or fact.len == 0) continue;
            try fact_list.append(allocator, .{
                .subject = try allocator.dupe(u8, subject),
                .fact = try allocator.dupe(u8, fact),
            });
        }
    };
    if (parsed.value.object.get("events")) |events| if (events == .array) {
        for (events.array.items) |item| {
            if (event_list.items.len >= 12) break;
            if (item != .object) continue;
            const event_raw = jsonStringValue(item.object.get("event") orelse continue) orelse continue;
            const event_text = std.mem.trim(u8, event_raw, " \t\r\n");
            if (event_text.len == 0) continue;
            const date_raw = if (item.object.get("date")) |date| jsonStringValue(date) else null;
            const date = std.mem.trim(u8, date_raw orelse "", " \t\r\n");
            try event_list.append(allocator, .{
                .event = try allocator.dupe(u8, event_text),
                .date = try allocator.dupe(u8, date),
            });
        }
    };

    return .{
        .profile = try profile_list.toOwnedSlice(allocator),
        .facts = try fact_list.toOwnedSlice(allocator),
        .events = try event_list.toOwnedSlice(allocator),
    };
}

fn jsonStringValue(value: std.json.Value) ?[]const u8 {
    return switch (value) {
        .string => |text| text,
        else => null,
    };
}

fn salvageJsonObject(raw: []const u8) ?[]const u8 {
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    if (trimmed.len == 0) return null;
    var slice = trimmed;
    if (std.mem.startsWith(u8, slice, "```")) {
        if (std.mem.indexOfScalar(u8, slice, '\n')) |nl| {
            slice = std.mem.trim(u8, slice[nl + 1 ..], " \t\r\n");
            if (std.mem.endsWith(u8, slice, "```")) {
                slice = std.mem.trim(u8, slice[0 .. slice.len - 3], " \t\r\n");
            }
        }
    }
    const start = std.mem.indexOfScalar(u8, slice, '{') orelse return null;
    const end = std.mem.lastIndexOfScalar(u8, slice, '}') orelse return null;
    if (end < start) return null;
    return slice[start .. end + 1];
}

fn writeJsonString(out: *std.ArrayList(u8), a: std.mem.Allocator, value: []const u8) !void {
    try out.append(a, '"');
    for (value) |byte| {
        switch (byte) {
            '"' => try out.appendSlice(a, "\\\""),
            '\\' => try out.appendSlice(a, "\\\\"),
            '\n' => try out.appendSlice(a, "\\n"),
            '\r' => try out.appendSlice(a, "\\r"),
            '\t' => try out.appendSlice(a, "\\t"),
            0x08 => try out.appendSlice(a, "\\b"),
            0x0c => try out.appendSlice(a, "\\f"),
            else => {
                if (byte < 0x20) {
                    var buf: [6]u8 = undefined;
                    _ = std.fmt.bufPrint(&buf, "\\u{x:0>4}", .{byte}) catch unreachable;
                    try out.appendSlice(a, buf[0..6]);
                } else {
                    try out.append(a, byte);
                }
            },
        }
    }
    try out.append(a, '"');
}

/// Return the decoded body of a complete HTTP response. Bodies sent with
/// `Transfer-Encoding: chunked` (which Ollama uses for `/api/embed`) are
/// de-framed into `a`; identity bodies are returned as a slice of `response`.
fn httpBody(response: []const u8, a: std.mem.Allocator) ?[]const u8 {
    const sep = std.mem.indexOf(u8, response, "\r\n\r\n") orelse return null;
    const headers = response[0..sep];
    const raw = response[sep + 4 ..];
    if (!transferIsChunked(headers)) return raw;
    return decodeChunked(a, raw) catch null;
}

fn transferIsChunked(headers: []const u8) bool {
    var lines = std.mem.splitSequence(u8, headers, "\r\n");
    while (lines.next()) |line| {
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        const name = std.mem.trim(u8, line[0..colon], " \t");
        if (!std.ascii.eqlIgnoreCase(name, "transfer-encoding")) continue;
        var encodings = std.mem.splitScalar(u8, line[colon + 1 ..], ',');
        while (encodings.next()) |enc| {
            if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, enc, " \t"), "chunked")) return true;
        }
    }
    return false;
}

fn decodeChunked(a: std.mem.Allocator, raw: []const u8) ![]const u8 {
    var out = std.ArrayList(u8).empty;
    var i: usize = 0;
    while (true) {
        const line_end = std.mem.indexOfPos(u8, raw, i, "\r\n") orelse return error.InvalidChunkedBody;
        var size_text = raw[i..line_end];
        // Strip optional chunk extensions (`size;name=value`).
        if (std.mem.indexOfScalar(u8, size_text, ';')) |semi| size_text = size_text[0..semi];
        const size = std.fmt.parseInt(usize, std.mem.trim(u8, size_text, " \t"), 16) catch
            return error.InvalidChunkedBody;
        i = line_end + 2;
        if (size == 0) return try out.toOwnedSlice(a);
        if (i + size + 2 > raw.len) return error.InvalidChunkedBody;
        try out.appendSlice(a, raw[i .. i + size]);
        i += size;
        if (raw[i] != '\r' or raw[i + 1] != '\n') return error.InvalidChunkedBody;
        i += 2;
    }
}

fn statusIs2xx(response: []const u8) bool {
    return std.mem.startsWith(u8, response, "HTTP/1.1 2") or
        std.mem.startsWith(u8, response, "HTTP/1.0 2");
}

fn utf8SafeEnd(bytes: []const u8, start: usize, max_len: usize) usize {
    var end = @min(bytes.len, start + max_len);
    if (end < bytes.len) {
        while (end > start and (bytes[end] & 0xC0) == 0x80) end -= 1;
    }
    return end;
}

// --- tests ---

test "Dream generate request sets a 16K context window" {
    const allocator = std.testing.allocator;
    const body = try buildGenerateRequestBody(allocator, "qwen3.5:9b", "prompt");
    defer allocator.free(body);

    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, body, .{ .allocate = .alloc_always });
    defer parsed.deinit();
    if (parsed.value != .object) return error.TestUnexpectedResult;
    const options = parsed.value.object.get("options") orelse return error.TestUnexpectedResult;
    if (options != .object) return error.TestUnexpectedResult;
    const num_ctx = options.object.get("num_ctx") orelse return error.TestUnexpectedResult;
    if (num_ctx != .integer) return error.TestUnexpectedResult;
    try std.testing.expectEqual(@as(i64, generate_context_tokens), num_ctx.integer);
}

test "chunkText returns single chunk for short text" {
    const allocator = std.testing.allocator;
    const text = "Hello world.";
    const chunks = try chunkText(allocator, text);
    defer {
        for (chunks) |c| allocator.free(c);
        allocator.free(chunks);
    }
    try std.testing.expectEqual(@as(usize, 1), chunks.len);
    try std.testing.expectEqualStrings(text, chunks[0]);
}

test "chunkText returns empty list for empty text" {
    const allocator = std.testing.allocator;
    const chunks = try chunkText(allocator, "");
    defer allocator.free(chunks);
    try std.testing.expectEqual(@as(usize, 0), chunks.len);
}

test "chunkText splits on paragraph boundaries" {
    const allocator = std.testing.allocator;
    var big = std.ArrayList(u8).empty;
    defer big.deinit(allocator);
    try big.appendSlice(allocator, "Para one: ");
    for (0..1000) |_| try big.appendSlice(allocator, "abcdefghij");
    try big.appendSlice(allocator, "\n\nPara two is short.");
    const chunks = try chunkText(allocator, big.items);
    defer {
        for (chunks) |c| allocator.free(c);
        allocator.free(chunks);
    }
    try std.testing.expect(chunks.len >= 2);
    try std.testing.expect(std.mem.startsWith(u8, chunks[0], "Para one:"));
    try std.testing.expectEqualStrings("Para two is short.", chunks[chunks.len - 1]);
}

test "chunkText hard-splits oversized paragraph" {
    const allocator = std.testing.allocator;
    var big = std.ArrayList(u8).empty;
    defer big.deinit(allocator);
    for (0..5000) |_| try big.appendSlice(allocator, "ab");
    const chunks = try chunkText(allocator, big.items);
    defer {
        for (chunks) |c| allocator.free(c);
        allocator.free(chunks);
    }
    try std.testing.expect(chunks.len >= 2);
    for (chunks) |c| try std.testing.expect(c.len <= max_chunk_bytes);
}

test "chunkText respects UTF-8 boundaries" {
    const allocator = std.testing.allocator;
    // Build text with multibyte chars (emoji = 4 bytes) larger than max.
    var big = std.ArrayList(u8).empty;
    defer big.deinit(allocator);
    for (0..3000) |_| try big.appendSlice(allocator, "🎉");
    const chunks = try chunkText(allocator, big.items);
    defer {
        for (chunks) |c| allocator.free(c);
        allocator.free(chunks);
    }
    try std.testing.expect(chunks.len >= 2);
    for (chunks) |c| try std.testing.expect(c.len <= max_chunk_bytes);
}

test "extractPlainText passes through markdown" {
    const allocator = std.testing.allocator;
    const body = "# Title\n\nSome **markdown**.";
    const out = try extractPlainText(allocator, body, "markdown");
    defer allocator.free(out);
    try std.testing.expectEqualStrings(body, out);
}

test "extractPlainText passes through plain" {
    const allocator = std.testing.allocator;
    const body = "Just plain text.";
    const out = try extractPlainText(allocator, body, "plain");
    defer allocator.free(out);
    try std.testing.expectEqualStrings(body, out);
}

test "extractPlainText walks a simple tiptap doc" {
    const allocator = std.testing.allocator;
    const body = "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Hello \"},{\"type\":\"text\",\"text\":\"world\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Second para.\"}]}]}";
    const out = try extractPlainText(allocator, body, "tiptap");
    defer allocator.free(out);
    try std.testing.expectEqualStrings("Hello world\n\nSecond para.", out);
}

test "extractPlainText handles invalid tiptap json" {
    const allocator = std.testing.allocator;
    const out = try extractPlainText(allocator, "not json", "tiptap");
    defer allocator.free(out);
    try std.testing.expectEqualStrings("", out);
}

test "writeJsonString escapes special characters" {
    const allocator = std.testing.allocator;
    var out = std.ArrayList(u8).empty;
    defer out.deinit(allocator);
    try writeJsonString(&out, allocator, "hello \"world\"\n\t\\");
    try std.testing.expectEqualStrings("\"hello \\\"world\\\"\\n\\t\\\\\"", out.items);
}

test "httpBody finds body after headers" {
    const response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}";
    const body = httpBody(response, std.testing.allocator).?;
    try std.testing.expectEqualStrings("{\"ok\":true}", body);
}

test "httpBody returns null without separator" {
    try std.testing.expect(httpBody("no headers here", std.testing.allocator) == null);
}

test "httpBody decodes chunked transfer encoding" {
    const response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n" ++
        "5\r\n{\"ok\"\r\n6\r\n:true}\r\n0\r\n\r\n";
    const body = httpBody(response, std.testing.allocator).?;
    defer std.testing.allocator.free(body);
    try std.testing.expectEqualStrings("{\"ok\":true}", body);
}

test "httpBody decodes chunked body with many chunks" {
    const allocator = std.testing.allocator;
    var raw = std.ArrayList(u8).empty;
    defer raw.deinit(allocator);
    try raw.appendSlice(allocator, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
    // 64 chunks of 100 bytes each of 'x'.
    for (0..64) |_| try raw.appendSlice(allocator, "64\r\n" ++ ("x" ** 100) ++ "\r\n");
    try raw.appendSlice(allocator, "0\r\n\r\n");
    const body = httpBody(raw.items, allocator).?;
    defer allocator.free(body);
    try std.testing.expectEqual(@as(usize, 6400), body.len);
    for (body) |ch| try std.testing.expectEqual(@as(u8, 'x'), ch);
}

test "httpBody returns null for malformed chunked body" {
    const response = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nnope\r\n0\r\n\r\n";
    try std.testing.expect(httpBody(response, std.testing.allocator) == null);
}

test "statusIs2xx recognizes success codes" {
    try std.testing.expect(statusIs2xx("HTTP/1.1 200 OK\r\n"));
    try std.testing.expect(statusIs2xx("HTTP/1.0 201 Created\r\n"));
    try std.testing.expect(!statusIs2xx("HTTP/1.1 404 Not Found\r\n"));
    try std.testing.expect(!statusIs2xx("HTTP/1.1 500 Error\r\n"));
}

test "pulledNamesFromTags skips cloud models" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const body =
        \\{"models":[
        \\{"name":"qwen3.5:9b","model":"qwen3.5:9b","size":6000000000},
        \\{"name":"gpt-oss:120b-cloud","model":"gpt-oss:120b-cloud","remote_model":"gpt-oss:120b","remote_host":"https://ollama.com:443","size":384},
        \\{"name":"nomic-embed-text:latest","model":"nomic-embed-text:latest"}
        \\]}
    ;
    const names = pulledNamesFromTags(arena.allocator(), body);
    try std.testing.expectEqual(@as(usize, 2), names.len);
    try std.testing.expectEqualStrings("qwen3.5:9b", names[0]);
    try std.testing.expectEqualStrings("nomic-embed-text:latest", names[1]);
}

test "pulledNamesFromTags skips an entry with only remote_model set" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const body = "{\"models\":[{\"name\":\"cloudy\",\"remote_model\":\"upstream\"},{\"name\":\"local\"}]}";
    const names = pulledNamesFromTags(arena.allocator(), body);
    try std.testing.expectEqual(@as(usize, 1), names.len);
    try std.testing.expectEqualStrings("local", names[0]);
}

test "pulledNamesFromTags keeps a local model with empty or non-string remote fields" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const body = "{\"models\":[{\"name\":\"a\",\"remote_host\":\"\"},{\"name\":\"b\",\"remote_host\":null,\"remote_model\":7}]}";
    const names = pulledNamesFromTags(arena.allocator(), body);
    try std.testing.expectEqual(@as(usize, 2), names.len);
}

test "pulledNamesFromTags returns empty for a missing list or garbage" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectEqual(@as(usize, 0), pulledNamesFromTags(arena.allocator(), "{}").len);
    try std.testing.expectEqual(@as(usize, 0), pulledNamesFromTags(arena.allocator(), "not json").len);
    try std.testing.expectEqual(@as(usize, 0), pulledNamesFromTags(arena.allocator(), "{\"models\":\"x\"}").len);
}

test "extractPlainText separates nested list items with one blank line" {
    const allocator = std.testing.allocator;
    const body = "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Intro\"}]},{\"type\":\"bulletList\",\"content\":[{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"One\"}]}]},{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Two\"}]}]}]}]}";
    const out = try extractPlainText(allocator, body, "tiptap");
    defer allocator.free(out);
    try std.testing.expectEqualStrings("Intro\n\nOne\n\nTwo", out);
}

test "extractPlainText keeps hard breaks as single newlines" {
    const allocator = std.testing.allocator;
    const body = "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"line one\"},{\"type\":\"hardBreak\"},{\"type\":\"text\",\"text\":\"line two\"}]}]}";
    const out = try extractPlainText(allocator, body, "tiptap");
    defer allocator.free(out);
    try std.testing.expectEqualStrings("line one\nline two", out);
}

test "watchdog fires after the deadline" {
    var abort: Abort = .{ .io = std.testing.io };
    const thread = startWatchdog(&abort, 50);
    // Never mark the work done; the watchdog must fire on its own.
    while (!abort.fired.load(.acquire)) {
        std.Io.sleep(std.testing.io, .fromMilliseconds(10), .awake) catch {};
    }
    finishWatchdog(&abort, thread);
    try std.testing.expect(abort.fired.load(.acquire));
}

test "watchdog stays quiet when work finishes first" {
    var abort: Abort = .{ .io = std.testing.io };
    const thread = startWatchdog(&abort, 10000);
    finishWatchdog(&abort, thread);
    try std.testing.expect(!abort.fired.load(.acquire));
}

test "stripThink removes a think block and trims" {
    try std.testing.expectEqualStrings(
        "Fog sat low over the trail.",
        stripThink("<think>planning</think>\nFog sat low over the trail.\n"),
    );
}

test "stripThink drops a leftover closing tag" {
    try std.testing.expectEqualStrings(
        "The apartment was still.",
        stripThink("</think>\nThe apartment was still."),
    );
}

test "stripThink leaves plain text alone" {
    try std.testing.expectEqualStrings("Just the day.", stripThink("  Just the day.  "));
}

test "clipChatTitle takes the first line and strips quotes" {
    const allocator = std.testing.allocator;
    const titled = try clipChatTitle(allocator, "Title: \"Fog on the hill\"\nmore");
    defer allocator.free(titled);
    try std.testing.expectEqualStrings("Fog on the hill", titled);

    const quoted = try clipChatTitle(allocator, "'A walk'");
    defer allocator.free(quoted);
    try std.testing.expectEqualStrings("A walk", quoted);
}

test "clipChatTitle collapses whitespace and clips to 60" {
    const allocator = std.testing.allocator;
    const collapsed = try clipChatTitle(allocator, "  Fog   on   the hill  ");
    defer allocator.free(collapsed);
    try std.testing.expectEqualStrings("Fog on the hill", collapsed);

    const long = "a" ** 80;
    const clipped = try clipChatTitle(allocator, long);
    defer allocator.free(clipped);
    try std.testing.expectEqual(@as(usize, 59 + "…".len), clipped.len);
    try std.testing.expect(std.mem.endsWith(u8, clipped, "…"));
    try std.testing.expectEqualStrings("a" ** 59, clipped[0..59]);
}

test "clipChatTitle rejects empty output" {
    try std.testing.expectError(error.EmptyTitle, clipChatTitle(std.testing.allocator, "   \n"));
    try std.testing.expectError(error.EmptyTitle, clipChatTitle(std.testing.allocator, "\"\""));
}

test "parseExtraction reads a clean object" {
    const allocator = std.testing.allocator;
    const result = try parseExtraction(
        allocator,
        "{\"profile\":[\"Likes quiet walks\"],\"facts\":[{\"subject\":\"Maya\",\"fact\":\"Lives nearby\"}],\"events\":[{\"event\":\"Walked the creek trail\",\"date\":\"2026-08-28\"}]}",
    );
    defer result.deinit(allocator);
    try std.testing.expectEqual(@as(usize, 1), result.profile.len);
    try std.testing.expectEqualStrings("Likes quiet walks", result.profile[0]);
    try std.testing.expectEqual(@as(usize, 1), result.facts.len);
    try std.testing.expectEqualStrings("Maya", result.facts[0].subject);
    try std.testing.expectEqualStrings("Lives nearby", result.facts[0].fact);
    try std.testing.expectEqual(@as(usize, 1), result.events.len);
    try std.testing.expectEqualStrings("Walked the creek trail", result.events[0].event);
    try std.testing.expectEqualStrings("2026-08-28", result.events[0].date);
}

test "parseExtraction salvages fenced JSON and skips empty strings" {
    const allocator = std.testing.allocator;
    const result = try parseExtraction(
        allocator,
        "```json\n{\"profile\":[\"  \",\"Keeps a journal\"],\"facts\":[],\"events\":[{\"event\":\"\",\"date\":\"2026-01-01\"}]}\n```",
    );
    defer result.deinit(allocator);
    try std.testing.expectEqual(@as(usize, 1), result.profile.len);
    try std.testing.expectEqualStrings("Keeps a journal", result.profile[0]);
    try std.testing.expectEqual(@as(usize, 0), result.facts.len);
    try std.testing.expectEqual(@as(usize, 0), result.events.len);
}

test "parseExtraction returns empty on garbage" {
    const allocator = std.testing.allocator;
    const result = try parseExtraction(allocator, "no json here");
    defer result.deinit(allocator);
    try std.testing.expectEqual(@as(usize, 0), result.profile.len);
    try std.testing.expectEqual(@as(usize, 0), result.facts.len);
    try std.testing.expectEqual(@as(usize, 0), result.events.len);
}

test "validModelName accepts library tags and rejects junk" {
    try std.testing.expect(validModelName("qwen3:8b"));
    try std.testing.expect(validModelName("ibm/granite4.1:3b"));
    try std.testing.expect(!validModelName(""));
    try std.testing.expect(!validModelName("qwen3:8b\nHost: evil"));
    try std.testing.expect(!validModelName("has space"));
}

test "appendModelObject writes model and name keys" {
    const allocator = std.testing.allocator;
    var out = std.ArrayList(u8).empty;
    defer out.deinit(allocator);
    try appendModelObject(&out, allocator, "qwen3:8b", ",\"stream\":true}");
    try std.testing.expectEqualStrings(
        "{\"model\":\"qwen3:8b\",\"name\":\"qwen3:8b\",\"stream\":true}",
        out.items,
    );
}

test "ChunkedDecoder handles split chunks and extensions" {
    const allocator = std.testing.allocator;
    var decoder = ChunkedDecoder{};
    defer decoder.pending.deinit(allocator);
    var out = std.ArrayList(u8).empty;
    defer out.deinit(allocator);
    const src = "5;ext=1\r\n{\"ok\"\r\n6\r\n:true}\r\n0\r\n\r\n";
    for (src) |byte| {
        var one = [_]u8{byte};
        try decoder.push(allocator, &one, &out);
    }
    try std.testing.expect(decoder.done);
    try std.testing.expectEqualStrings("{\"ok\":true}", out.items);
}

test "feedPullLines parses NDJSON progress and success" {
    const allocator = std.testing.allocator;
    var state: PullState = .{};
    _ = state.begin(std.testing.io, "qwen3:0.6b");
    var pending = std.ArrayList(u8).empty;
    defer pending.deinit(allocator);
    var succeeded = false;
    try feedPullLines(
        &pending,
        allocator,
        "{\"status\":\"pulling manifest\"}\n{\"status\":\"downloading\",\"total\":100,\"completed\":40}\n{\"stat",
        &state,
        std.testing.io,
        &succeeded,
    );
    try std.testing.expect(!succeeded);
    try feedPullLines(
        &pending,
        allocator,
        "us\":\"success\"}\n",
        &state,
        std.testing.io,
        &succeeded,
    );
    try std.testing.expect(succeeded);
    var model_buf: [128]u8 = undefined;
    var status_buf: [192]u8 = undefined;
    const snap = state.snapshot(std.testing.io, &model_buf, &status_buf);
    try std.testing.expectEqualStrings("success", snap.status);
    try std.testing.expectEqual(@as(u64, 40), snap.completed);
    try std.testing.expectEqual(@as(u64, 100), snap.total);
}

test "parseMemTotalGb rounds kilobytes to gigabytes" {
    try std.testing.expectEqual(@as(u32, 16), parseMemTotalGb("MemTotal:       16384000 kB\n"));
    try std.testing.expectEqual(@as(u32, 1), parseMemTotalGb("MemTotal: 1024 kB\n"));
}

test "applyPullLine treats error lines as failure" {
    const allocator = std.testing.allocator;
    var state: PullState = .{};
    _ = state.begin(std.testing.io, "missing");
    try std.testing.expectError(
        error.OllamaRequestFailed,
        applyPullLine(&state, std.testing.io, allocator, "{\"error\":\"file does not exist\"}"),
    );
    var model_buf: [128]u8 = undefined;
    var status_buf: [192]u8 = undefined;
    const snap = state.snapshot(std.testing.io, &model_buf, &status_buf);
    try std.testing.expectEqualStrings("file does not exist", snap.status);
}

test "hardwareInfo reports at least one core and some RAM" {
    const info = hardwareInfo(std.testing.io, std.testing.allocator);
    defer if (info.chip_name.len > 0) std.testing.allocator.free(info.chip_name);
    try std.testing.expect(info.cpu_cores >= 1);
    try std.testing.expect(info.ram_gb >= 1);
    try std.testing.expect(info.chip_name.len > 0);
}

test "modelPrefixFrom keeps the default when the override is missing or empty" {
    try std.testing.expectEqualStrings(model_prefix, modelPrefixFrom(null, model_prefix));
    try std.testing.expectEqualStrings(model_prefix, modelPrefixFrom("", model_prefix));
    try std.testing.expectEqualStrings("llama3.2", modelPrefixFrom("llama3.2", model_prefix));
    try std.testing.expectEqualStrings(summary_model, modelPrefixFrom(null, summary_model));
    try std.testing.expectEqualStrings("qwen3:4b", modelPrefixFrom("qwen3:4b", summary_model));
}

test "ModelPrefixes.fromEnv reads SAGE_EMBED_MODEL and SAGE_SUMMARY_MODEL" {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    const defaults = ModelPrefixes.fromEnv(&env);
    try std.testing.expectEqualStrings(model_prefix, defaults.embed);
    try std.testing.expectEqualStrings(summary_model, defaults.summary);

    try env.put("SAGE_EMBED_MODEL", "custom-embed");
    try env.put("SAGE_SUMMARY_MODEL", "qwen3:4b");
    const overridden = ModelPrefixes.fromEnv(&env);
    try std.testing.expectEqualStrings("custom-embed", overridden.embed);
    try std.testing.expectEqualStrings("qwen3:4b", overridden.summary);

    try env.put("SAGE_EMBED_MODEL", "");
    try std.testing.expectEqualStrings(model_prefix, ModelPrefixes.fromEnv(&env).embed);
}

test "findCli takes the first ollama on PATH" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = cli_name, .data = "" });
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_len = try tmp.dir.realPath(std.testing.io, &path_buf);
    const dir = path_buf[0..dir_len];
    const expected = try std.fs.path.join(std.testing.allocator, &.{ dir, cli_name });
    defer std.testing.allocator.free(expected);

    const path_env = try std.fmt.allocPrint(
        std.testing.allocator,
        "/nonexistent-sage-dir:{s}",
        .{dir},
    );
    defer std.testing.allocator.free(path_env);
    const found = findCli(std.testing.io, std.testing.allocator, path_env) orelse
        return error.TestUnexpectedResult;
    defer std.testing.allocator.free(found);
    try std.testing.expectEqualStrings(expected, found);
}

test "launchApp reports an app that is not installed" {
    // A name no Mac has: `open` exits non-zero, so `startServer` falls back
    // to the CLI instead of waiting for a server that was never launched.
    try std.testing.expect(!launchApp(std.testing.io, "SageMissingOllamaTest"));
}

test "waitForOpen reads a quick child's exit code" {
    const argv = [_][]const u8{"/usr/bin/true"};
    var child = try std.process.spawn(std.testing.io, .{
        .argv = &argv,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    });

    const term = waitForOpen(std.testing.io, &child, open_wait_ms) orelse
        return error.TestUnexpectedResult;
    switch (term) {
        .exited => |code| try std.testing.expect(code == 0),
        else => return error.TestUnexpectedResult,
    }
}

test "waitForOpen signals a child that outlives its deadline" {
    // A hung `open` must not hold the start worker: the deadline signals it,
    // and the wait reports the signal rather than the child's own exit.
    const argv = [_][]const u8{ "/bin/sleep", "30" };
    var child = try std.process.spawn(std.testing.io, .{
        .argv = &argv,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    });

    const started = std.Io.Clock.Timestamp.now(std.testing.io, .awake);
    const term = waitForOpen(std.testing.io, &child, 300) orelse
        return error.TestUnexpectedResult;
    const elapsed_ms = started.untilNow(std.testing.io).raw.toMilliseconds();

    // The signal ends the wait; the 30 second sleep does not.
    try std.testing.expect(elapsed_ms < 5_000);
    switch (term) {
        .signal => |signal| try std.testing.expect(signal == std.posix.SIG.TERM),
        else => return error.TestUnexpectedResult,
    }
}
