const std = @import("std");
const builtin = @import("builtin");
const journal = @import("journal.zig");

const max_request_bytes: usize = 256 * 1024;
const token_bytes: usize = 32;
pub const token_hex_len: usize = token_bytes * 2;
/// A request that stops making progress is abandoned this long after the
/// connection is accepted, so a half-written request cannot park a task.
const request_read_timeout_ms: i64 = 2000;
/// Reads wait in poll slices because cancelation only interrupts a thread
/// parked inside one of `std.Io`'s own syscalls. A quit that cancels a read
/// waits at most this long.
const read_poll_slice_ms: i64 = 100;
/// Each connection runs on its own task, and `std.Io` spawns a thread per
/// task. Cap the in-flight connections so a same-user process in `make dev`
/// cannot exhaust threads.
const max_connections: u32 = 16;
pub const socket_env = "SAGE_AGENT_SOCKET";
const legacy_socket_file_name = "agent.sock";
const socket_path_prefix = "/tmp/sage-";
const socket_hash_bytes: usize = 8;
const sol_local: i32 = 0;
const local_peerpid: u32 = 0x002;

pub const Wake = struct {
    context: *anyopaque,
    wake_fn: *const fn (*anyopaque) void,

    fn call(self: Wake) void {
        self.wake_fn(self.context);
    }
};

pub const SearchTarget = enum { journal, facts, events };

pub const Job = struct {
    kind: Kind,
    stream: std.Io.net.Stream,
    entry_id: i64 = 0,
    query: []u8 = &.{},
    limit: i64 = 5,
    vectors: [][]f32 = &.{},
    model_name: []const u8 = &.{},
    err: ?anyerror = null,
    target: SearchTarget = .journal,

    pub const Kind = enum { get_entry, search, search_ready, memory_profile, agent_instructions };
};

pub const Queue = struct {
    mutex: std.Io.Mutex = .init,
    io: std.Io = undefined,
    jobs: std.ArrayList(*Job) = .empty,

    pub fn push(self: *Queue, job: *Job) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        self.jobs.append(std.heap.page_allocator, job) catch {};
    }

    pub fn takeAll(self: *Queue) []*Job {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        const done = std.heap.page_allocator.dupe(*Job, self.jobs.items) catch return &.{};
        self.jobs.clearRetainingCapacity();
        return done;
    }
};

pub const Server = struct {
    allocator: std.mem.Allocator = undefined,
    // Window-loop Io never finishes accept() from a background thread.
    // This Threaded Io owns listen/accept/read/write so Chat tools can connect.
    threaded: *std.Io.Threaded = undefined,
    io: std.Io = undefined,
    queue: *Queue = undefined,
    wake: Wake = undefined,
    token_hex: [token_hex_len]u8 = undefined,
    discovery_path: []u8 = &.{},
    socket_path: []u8 = &.{},
    expected_pid: std.atomic.Value(i32) = .init(0),
    peer_check: bool = false,
    memory_enabled: bool = false,
    available: std.atomic.Value(bool) = .init(false),
    listener: ?std.Io.net.Server = null,
    accept_task: ?std.Io.Future(void) = null,
    connections: std.Io.Group = .init,
    active_connections: std.atomic.Value(u32) = .init(0),
    stopped: std.atomic.Value(bool) = .init(false),
    started: bool = false,
};

pub const StartOptions = struct {
    write_discovery: bool,
    peer_check: bool,
    memory_enabled: bool = false,
    available: bool = false,
};

pub fn setAvailable(self: *Server, available: bool) void {
    self.available.store(available, .release);
}

pub fn start(
    self: *Server,
    allocator: std.mem.Allocator,
    data_dir: []const u8,
    queue: *Queue,
    wake: Wake,
    options: StartOptions,
) !void {
    self.allocator = allocator;
    self.queue = queue;
    self.wake = wake;
    self.peer_check = options.peer_check;
    self.memory_enabled = options.memory_enabled;
    self.available.store(options.available, .release);
    self.expected_pid.store(0, .release);
    self.stopped.store(false, .release);

    const threaded = try allocator.create(std.Io.Threaded);
    errdefer allocator.destroy(threaded);
    threaded.* = std.Io.Threaded.init(allocator, .{});
    errdefer threaded.deinit();
    self.threaded = threaded;
    self.io = threaded.io();
    queue.io = self.io;

    var raw: [token_bytes]u8 = undefined;
    try std.Io.randomSecure(self.io, &raw);
    hexEncode(&self.token_hex, &raw);

    const socket_path = try allocSocketPath(allocator, data_dir);
    errdefer allocator.free(socket_path);
    errdefer std.Io.Dir.deleteFileAbsolute(self.io, socket_path) catch {};
    if (socket_path.len > maxUnixPathLen()) return error.NameTooLong;
    std.Io.Dir.deleteFileAbsolute(self.io, socket_path) catch {};
    deleteLegacySocket(self.io, allocator, data_dir);

    const discovery_path = try std.fmt.allocPrint(allocator, "{s}/agent-server.json", .{data_dir});
    errdefer allocator.free(discovery_path);
    // Drop a leftover file from a previous launch before we know this one is live.
    std.Io.Dir.deleteFileAbsolute(self.io, discovery_path) catch {};

    const bind_addr = try std.Io.net.UnixAddress.init(socket_path);
    var listener = try bind_addr.listen(self.io, .{});
    errdefer listener.deinit(self.io);
    try chmodPath(socket_path);

    if (options.write_discovery) {
        try writeDiscoveryFile(self.io, discovery_path, socket_path, &self.token_hex);
        errdefer std.Io.Dir.deleteFileAbsolute(self.io, discovery_path) catch {};
    }

    self.listener = listener;
    self.socket_path = socket_path;
    self.discovery_path = discovery_path;
    self.accept_task = self.io.concurrent(acceptLoop, .{self}) catch |err| {
        self.listener = null;
        return err;
    };
    self.started = true;
}

pub fn stop(self: *Server) void {
    if (!self.started) return;
    self.stopped.store(true, .release);
    if (self.listener) |*listener| {
        listener.deinit(self.io);
        self.listener = null;
    }
    if (self.accept_task) |*task| {
        task.await(self.io);
        self.accept_task = null;
    }
    // Cancel after the accept loop ends, so no task joins the group late.
    // A canceled task returns from its read and closes its own socket.
    self.connections.cancel(self.io);
    self.expected_pid.store(0, .release);
    if (self.discovery_path.len > 0) {
        std.Io.Dir.deleteFileAbsolute(self.io, self.discovery_path) catch {};
        self.allocator.free(self.discovery_path);
        self.discovery_path = &.{};
    }
    if (self.socket_path.len > 0) {
        std.Io.Dir.deleteFileAbsolute(self.io, self.socket_path) catch {};
        self.allocator.free(self.socket_path);
        self.socket_path = &.{};
    }
    self.threaded.deinit();
    self.allocator.destroy(self.threaded);
    self.started = false;
}

pub fn replyJson(io: std.Io, stream: std.Io.net.Stream, status: u16, reason: []const u8, body: []const u8) void {
    var header_buf: [256]u8 = undefined;
    const header = std.fmt.bufPrint(
        &header_buf,
        "HTTP/1.1 {d} {s}\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n",
        .{ status, reason, body.len },
    ) catch return;
    var write_buf: [1024]u8 = undefined;
    var writer = stream.writer(io, &write_buf);
    writer.interface.writeAll(header) catch {};
    writer.interface.writeAll(body) catch {};
    writer.interface.flush() catch {};
}

pub fn replyLocked(io: std.Io, stream: std.Io.net.Stream) void {
    replyJson(io, stream, 409, "Conflict", "{\"error\":\"locked\"}");
}

pub fn closeJob(allocator: std.mem.Allocator, io: std.Io, job: *Job) void {
    job.stream.close(io);
    if (job.query.len > 0) allocator.free(job.query);
    if (job.model_name.len > 0) allocator.free(job.model_name);
    for (job.vectors) |vec| allocator.free(vec);
    if (job.vectors.len > 0) allocator.free(job.vectors);
    allocator.destroy(job);
}

fn acceptLoop(self: *Server) void {
    while (!self.stopped.load(.acquire)) {
        const listener = if (self.listener) |*item| item else break;
        const stream = listener.accept(self.io) catch |err| switch (err) {
            error.Canceled, error.SocketNotListening => break,
            else => continue,
        };
        // Accept again right away: the connection is read on its own task, so
        // one stalled client cannot hold up the next one.
        if (!reserveConnection(self)) {
            replyJson(self.io, stream, 503, "Service Unavailable", "{\"error\":\"busy\"}");
            stream.close(self.io);
            continue;
        }
        self.connections.concurrent(self.io, handleConnection, .{ self, stream }) catch {
            releaseConnection(self);
            replyJson(self.io, stream, 503, "Service Unavailable", "{\"error\":\"busy\"}");
            stream.close(self.io);
        };
    }
}

fn reserveConnection(self: *Server) bool {
    var current = self.active_connections.load(.acquire);
    while (true) {
        if (current >= max_connections) return false;
        if (self.active_connections.cmpxchgWeak(current, current + 1, .acq_rel, .acquire)) |actual| {
            current = actual;
            continue;
        }
        return true;
    }
}

fn releaseConnection(self: *Server) void {
    _ = self.active_connections.fetchSub(1, .acq_rel);
}

/// Waits until `handle` has a request byte to read, or until `deadline`
/// passes. `std.Io` gives a stream read no deadline of its own, and its
/// cancelation only interrupts threads parked inside `std.Io`'s syscalls, so
/// a read that waits here polls in short slices and checks for cancelation
/// between them.
fn waitReadable(io: std.Io, handle: std.posix.fd_t, deadline: std.Io.Clock.Timestamp) !void {
    var fds = [_]std.posix.pollfd{.{
        .fd = handle,
        .events = std.posix.POLL.IN,
        .revents = 0,
    }};
    while (true) {
        try std.Io.checkCancel(io);
        const remaining_ms = deadline.durationFromNow(io).raw.toMilliseconds();
        if (remaining_ms <= 0) return error.Timeout;
        const slice_ms: i32 = @intCast(@min(remaining_ms, read_poll_slice_ms));
        const rc = std.posix.system.poll(&fds, fds.len, slice_ms);
        switch (std.posix.errno(rc)) {
            .SUCCESS => {
                // Zero means the slice elapsed, not the deadline. Hangup and
                // error revents still go to the read, which reports them.
                if (rc == 0) continue;
                return;
            },
            .INTR => continue,
            else => |err| return std.posix.unexpectedErrno(err),
        }
    }
}

fn handleConnection(self: *Server, stream: std.Io.net.Stream) void {
    defer releaseConnection(self);

    if (self.peer_check) {
        const expected = self.expected_pid.load(.acquire);
        const got = peerPid(stream.socket.handle) orelse {
            stream.close(self.io);
            return;
        };
        if (!peerPidAllowed(expected, got)) {
            stream.close(self.io);
            return;
        }
    }

    var request_buf: [max_request_bytes]u8 = undefined;
    const deadline = std.Io.Clock.Timestamp.fromNow(self.io, .{
        .raw = .fromMilliseconds(request_read_timeout_ms),
        .clock = .awake,
    });
    const parsed = readRequest(self.io, stream, &request_buf, deadline) catch |err| switch (err) {
        // A canceled read means Sage is shutting down; nothing to answer.
        error.Canceled => {
            stream.close(self.io);
            return;
        },
        error.Timeout => {
            replyJson(self.io, stream, 408, "Request Timeout", "{\"error\":\"timeout\"}");
            stream.close(self.io);
            return;
        },
        else => {
            replyJson(self.io, stream, 400, "Bad Request", "{\"error\":\"bad_request\"}");
            stream.close(self.io);
            return;
        },
    };

    if (!tokenMatches(&self.token_hex, parsed.token)) {
        replyJson(self.io, stream, 401, "Unauthorized", "{\"error\":\"unauthorized\"}");
        stream.close(self.io);
        return;
    }

    if (std.mem.eql(u8, parsed.method, "GET") and std.mem.eql(u8, parsed.path, "/health")) {
        replyJson(self.io, stream, 200, "OK", "{\"ok\":true}");
        stream.close(self.io);
        return;
    }

    if (!self.available.load(.acquire)) {
        replyJson(self.io, stream, 503, "Service Unavailable", "{\"error\":\"unavailable\"}");
        stream.close(self.io);
        return;
    }

    if (std.mem.eql(u8, parsed.method, "GET") and std.mem.eql(u8, parsed.path, "/features")) {
        replyJson(self.io, stream, 200, "OK", if (self.memory_enabled) "{\"memory\":true}" else "{\"memory\":false}");
        stream.close(self.io);
        return;
    }

    if (std.mem.eql(u8, parsed.method, "GET") and std.mem.startsWith(u8, parsed.path, "/journal/entry/")) {
        const id_text = parsed.path["/journal/entry/".len..];
        const id = std.fmt.parseInt(i64, id_text, 10) catch {
            replyJson(self.io, stream, 400, "Bad Request", "{\"error\":\"bad_request\"}");
            stream.close(self.io);
            return;
        };
        enqueue(self, stream, .{ .kind = .get_entry, .stream = stream, .entry_id = id }) catch {
            replyJson(self.io, stream, 500, "Internal Server Error", "{\"error\":\"internal\"}");
            stream.close(self.io);
        };
        return;
    }

    if (std.mem.eql(u8, parsed.method, "POST") and std.mem.eql(u8, parsed.path, "/journal/search")) {
        enqueueSearch(self, stream, parsed.body, .journal);
        return;
    }

    if (std.mem.eql(u8, parsed.method, "GET") and std.mem.eql(u8, parsed.path, "/memory/profile")) {
        if (!self.memory_enabled) {
            replyJson(self.io, stream, 404, "Not Found", "{\"error\":\"not_found\"}");
            stream.close(self.io);
            return;
        }
        enqueue(self, stream, .{ .kind = .memory_profile, .stream = stream }) catch {
            replyJson(self.io, stream, 500, "Internal Server Error", "{\"error\":\"internal\"}");
            stream.close(self.io);
        };
        return;
    }

    if (std.mem.eql(u8, parsed.method, "GET") and std.mem.eql(u8, parsed.path, "/agent/instructions")) {
        enqueue(self, stream, .{ .kind = .agent_instructions, .stream = stream }) catch {
            replyJson(self.io, stream, 500, "Internal Server Error", "{\"error\":\"internal\"}");
            stream.close(self.io);
        };
        return;
    }

    if (std.mem.eql(u8, parsed.method, "POST") and std.mem.eql(u8, parsed.path, "/memory/facts/search")) {
        if (!self.memory_enabled) {
            replyJson(self.io, stream, 404, "Not Found", "{\"error\":\"not_found\"}");
            stream.close(self.io);
            return;
        }
        enqueueSearch(self, stream, parsed.body, .facts);
        return;
    }

    if (std.mem.eql(u8, parsed.method, "POST") and std.mem.eql(u8, parsed.path, "/memory/events/search")) {
        if (!self.memory_enabled) {
            replyJson(self.io, stream, 404, "Not Found", "{\"error\":\"not_found\"}");
            stream.close(self.io);
            return;
        }
        enqueueSearch(self, stream, parsed.body, .events);
        return;
    }

    replyJson(self.io, stream, 404, "Not Found", "{\"error\":\"not_found\"}");
    stream.close(self.io);
}

fn enqueueSearch(self: *Server, stream: std.Io.net.Stream, body: []const u8, target: SearchTarget) void {
    var used: usize = 0;
    var string_buf: [8192]u8 = undefined;
    const query = journal.jsonString(body, "query", &string_buf, &used) orelse {
        replyJson(self.io, stream, 400, "Bad Request", "{\"error\":\"bad_request\"}");
        stream.close(self.io);
        return;
    };
    if (query.len == 0) {
        replyJson(self.io, stream, 400, "Bad Request", "{\"error\":\"bad_request\"}");
        stream.close(self.io);
        return;
    }
    const provided = journal.jsonF32Array(body, "embedding", self.allocator) catch {
        replyJson(self.io, stream, 400, "Bad Request", "{\"error\":\"bad_request\"}");
        stream.close(self.io);
        return;
    };
    const limit = journal.jsonI64(body, "limit") orelse 5;
    const owned_query = self.allocator.dupe(u8, query) catch {
        if (provided) |vec| self.allocator.free(vec);
        replyJson(self.io, stream, 500, "Internal Server Error", "{\"error\":\"internal\"}");
        stream.close(self.io);
        return;
    };
    if (provided) |vec| {
        if (vec.len > 0) {
            enqueueReadySearch(self, stream, owned_query, vec, limit, target);
            return;
        }
        self.allocator.free(vec);
    }
    enqueue(self, stream, .{
        .kind = .search,
        .stream = stream,
        .query = owned_query,
        .limit = if (limit < 1) 5 else limit,
        .target = target,
    }) catch {
        self.allocator.free(owned_query);
        replyJson(self.io, stream, 500, "Internal Server Error", "{\"error\":\"internal\"}");
        stream.close(self.io);
    };
}

fn enqueueReadySearch(
    self: *Server,
    stream: std.Io.net.Stream,
    owned_query: []u8,
    vec: []f32,
    limit: i64,
    target: SearchTarget,
) void {
    const batch = self.allocator.alloc([]f32, 1) catch {
        self.allocator.free(vec);
        self.allocator.free(owned_query);
        replyJson(self.io, stream, 500, "Internal Server Error", "{\"error\":\"internal\"}");
        stream.close(self.io);
        return;
    };
    batch[0] = vec;
    enqueue(self, stream, .{
        .kind = .search_ready,
        .stream = stream,
        .query = owned_query,
        .limit = if (limit < 1) 5 else limit,
        .vectors = batch,
        .target = target,
    }) catch {
        self.allocator.free(vec);
        self.allocator.free(batch);
        self.allocator.free(owned_query);
        replyJson(self.io, stream, 500, "Internal Server Error", "{\"error\":\"internal\"}");
        stream.close(self.io);
    };
}

fn enqueue(self: *Server, stream: std.Io.net.Stream, values: Job) !void {
    _ = stream;
    const job = try self.allocator.create(Job);
    job.* = values;
    self.queue.push(job);
    self.wake.call();
}

const ParsedRequest = struct {
    method: []const u8,
    path: []const u8,
    token: []const u8,
    body: []const u8,
};

fn readRequest(
    io: std.Io,
    stream: std.Io.net.Stream,
    buffer: []u8,
    deadline: std.Io.Clock.Timestamp,
) !ParsedRequest {
    var reader_buffer: [1024]u8 = undefined;
    var stream_reader = stream.reader(io, &reader_buffer);
    const reader = &stream_reader.interface;
    var filled: usize = 0;
    var header_end: ?usize = null;
    var need: usize = buffer.len;
    while (filled < need and filled < buffer.len) {
        // readSliceShort waits for the full slice. A Chat tool sends headers
        // and then waits for the reply, so that call never finishes.
        // Wait for a readable socket first: `fillMore` reads once, so it
        // cannot block waiting to fill its buffer.
        try waitReadable(io, stream.socket.handle, deadline);
        reader.fillMore() catch |err| switch (err) {
            error.EndOfStream => break,
            // A canceled read arrives as ReadFailed, with the real error kept
            // on the reader.
            error.ReadFailed => {
                const cause = stream_reader.err orelse error.ReadFailed;
                if (cause == error.Canceled) return error.Canceled;
                return error.BadRequest;
            },
        };
        const chunk = reader.buffered();
        if (chunk.len == 0) continue;
        const take_len = @min(chunk.len, buffer.len - filled);
        @memcpy(buffer[filled .. filled + take_len], chunk[0..take_len]);
        reader.toss(take_len);
        filled += take_len;
        if (header_end == null) {
            if (std.mem.indexOf(u8, buffer[0..filled], "\r\n\r\n")) |end| {
                need = try requestBytesNeeded(end, try contentLength(buffer[0..end]), buffer.len);
                header_end = end;
            }
        }
    }
    return parseRequest(buffer[0..filled]);
}

fn requestBytesNeeded(header_end: usize, body_length: usize, buffer_len: usize) error{BadRequest}!usize {
    const body_start = std.math.add(usize, header_end, 4) catch return error.BadRequest;
    const request_end = std.math.add(usize, body_start, body_length) catch return error.BadRequest;
    if (request_end > buffer_len) return error.BadRequest;
    return request_end;
}

fn contentLength(head: []const u8) error{BadRequest}!usize {
    var lines = std.mem.splitSequence(u8, head, "\r\n");
    _ = lines.next();
    while (lines.next()) |header_line| {
        if (header_line.len == 0) continue;
        const colon = std.mem.indexOfScalar(u8, header_line, ':') orelse continue;
        const name = std.mem.trim(u8, header_line[0..colon], " \t");
        const value = std.mem.trim(u8, header_line[colon + 1 ..], " \t");
        if (std.ascii.eqlIgnoreCase(name, "content-length")) {
            return std.fmt.parseInt(usize, value, 10) catch return error.BadRequest;
        }
    }
    return 0;
}

fn parseRequest(raw: []const u8) !ParsedRequest {
    const header_end = std.mem.indexOf(u8, raw, "\r\n\r\n") orelse return error.BadRequest;
    const head = raw[0..header_end];
    const rest = raw[header_end + 4 ..];

    const line_end = std.mem.indexOf(u8, head, "\r\n") orelse head.len;
    const line = head[0..line_end];
    const method_end = std.mem.indexOfScalar(u8, line, ' ') orelse return error.BadRequest;
    const method = line[0..method_end];
    const after_method = line[method_end + 1 ..];
    const path_end = std.mem.indexOfScalar(u8, after_method, ' ') orelse after_method.len;
    const path = after_method[0..path_end];
    if (method.len == 0 or path.len == 0) return error.BadRequest;

    var token: []const u8 = "";
    var content_length: usize = 0;
    var lines = std.mem.splitSequence(u8, head[line_end..], "\r\n");
    _ = lines.next();
    while (lines.next()) |header_line| {
        if (header_line.len == 0) continue;
        const colon = std.mem.indexOfScalar(u8, header_line, ':') orelse continue;
        const name = std.mem.trim(u8, header_line[0..colon], " \t");
        const value = std.mem.trim(u8, header_line[colon + 1 ..], " \t");
        if (std.ascii.eqlIgnoreCase(name, "authorization")) {
            const prefix = "Bearer ";
            if (std.ascii.startsWithIgnoreCase(value, prefix)) {
                token = std.mem.trim(u8, value[prefix.len..], " \t");
            }
        } else if (std.ascii.eqlIgnoreCase(name, "content-length")) {
            content_length = std.fmt.parseInt(usize, value, 10) catch 0;
        }
    }

    const body = if (content_length == 0)
        rest
    else if (content_length > rest.len)
        rest
    else
        rest[0..content_length];

    return .{ .method = method, .path = path, .token = token, .body = body };
}

/// Hashes both sides and compares the digests, so a missing, short, or wrong
/// token all take the same path to the 401. Nothing returns early on length, so
/// the reply time does not tell a caller whether its guess was the right shape.
/// The Chat port's Node auth hashes both sides the same way.
fn tokenMatches(expected: *const [token_hex_len]u8, got: []const u8) bool {
    const Sha256 = std.crypto.hash.sha2.Sha256;
    var expected_digest: [Sha256.digest_length]u8 = undefined;
    Sha256.hash(expected, &expected_digest, .{});
    var got_digest: [Sha256.digest_length]u8 = undefined;
    Sha256.hash(got, &got_digest, .{});
    return std.crypto.timing_safe.eql([Sha256.digest_length]u8, expected_digest, got_digest);
}

pub fn peerPidAllowed(expected: i32, got: i32) bool {
    return expected != 0 and expected == got;
}

fn peerPid(handle: std.posix.fd_t) ?i32 {
    if (builtin.os.tag != .macos) return null;
    var pid: i32 = 0;
    var len: std.c.socklen_t = @sizeOf(i32);
    const rc = std.c.getsockopt(handle, sol_local, local_peerpid, &pid, &len);
    if (rc != 0) return null;
    if (len != @sizeOf(i32)) return null;
    if (pid <= 0) return null;
    return pid;
}

fn maxUnixPathLen() usize {
    return switch (builtin.os.tag) {
        .macos, .ios, .driverkit, .maccatalyst, .tvos, .watchos, .visionos => 103,
        else => std.Io.net.UnixAddress.max_len - 1,
    };
}

pub fn allocSocketPath(allocator: std.mem.Allocator, data_dir: []const u8) ![]u8 {
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(data_dir, &digest, .{});
    var hex: [socket_hash_bytes * 2]u8 = undefined;
    hexEncode(&hex, digest[0..socket_hash_bytes]);
    return std.fmt.allocPrint(allocator, "{s}{s}.sock", .{ socket_path_prefix, hex[0..] });
}

fn deleteLegacySocket(io: std.Io, allocator: std.mem.Allocator, data_dir: []const u8) void {
    const legacy = std.fmt.allocPrint(allocator, "{s}/{s}", .{ data_dir, legacy_socket_file_name }) catch return;
    defer allocator.free(legacy);
    std.Io.Dir.deleteFileAbsolute(io, legacy) catch {};
}

fn chmodPath(path: []const u8) !void {
    var buf: [std.Io.net.UnixAddress.max_len + 1]u8 = undefined;
    if (path.len + 1 > buf.len) return error.NameTooLong;
    @memcpy(buf[0..path.len], path);
    buf[path.len] = 0;
    if (std.c.chmod(buf[0..path.len :0], 0o600) != 0) return error.AccessDenied;
}

fn hexEncode(out: []u8, bytes: []const u8) void {
    const digits = "0123456789abcdef";
    for (bytes, 0..) |byte, i| {
        out[i * 2] = digits[byte >> 4];
        out[i * 2 + 1] = digits[byte & 0x0f];
    }
}

fn writeDiscoveryFile(io: std.Io, path: []const u8, socket_path: []const u8, token: *const [token_hex_len]u8) !void {
    var json_buf: [512]u8 = undefined;
    var writer = std.Io.Writer.fixed(&json_buf);
    try writer.writeAll("{\"socket\":\"");
    for (socket_path) |c| {
        switch (c) {
            '"' => try writer.writeAll("\\\""),
            '\\' => try writer.writeAll("\\\\"),
            else => try writer.writeByte(c),
        }
    }
    try writer.print("\",\"token\":\"{s}\"}}", .{token});
    const json = writer.buffered();
    std.Io.Dir.deleteFileAbsolute(io, path) catch {};
    var file = try std.Io.Dir.createFileAbsolute(io, path, .{
        .permissions = .fromMode(0o600),
    });
    defer file.close(io);
    try file.writeStreamingAll(io, json);
}

test "parseRequest reads a bearer GET" {
    const raw = "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer abc\r\n\r\n";
    const parsed = try parseRequest(raw);
    try std.testing.expectEqualStrings("GET", parsed.method);
    try std.testing.expectEqualStrings("/health", parsed.path);
    try std.testing.expectEqualStrings("abc", parsed.token);
}

test "parseRequest reads agent instructions GET" {
    const raw = "GET /agent/instructions HTTP/1.1\r\nAuthorization: Bearer tok\r\n\r\n";
    const parsed = try parseRequest(raw);
    try std.testing.expectEqualStrings("GET", parsed.method);
    try std.testing.expectEqualStrings("/agent/instructions", parsed.path);
    try std.testing.expectEqualStrings("tok", parsed.token);
}

test "parseRequest reads a JSON POST body" {
    const raw = "POST /journal/search HTTP/1.1\r\nContent-Length: 16\r\nAuthorization: Bearer tok\r\n\r\n{\"query\":\"fog\"}";
    const parsed = try parseRequest(raw);
    try std.testing.expectEqualStrings("POST", parsed.method);
    try std.testing.expectEqualStrings("/journal/search", parsed.path);
    try std.testing.expectEqualStrings("tok", parsed.token);
    try std.testing.expectEqualStrings("{\"query\":\"fog\"}", parsed.body);
}

test "parseRequest reads a search body with an embedding" {
    const raw = "POST /journal/search HTTP/1.1\r\nContent-Length: 38\r\nAuthorization: Bearer tok\r\n\r\n{\"query\":\"fog\",\"embedding\":[0.1,0.2]}";
    const parsed = try parseRequest(raw);
    try std.testing.expectEqualStrings("{\"query\":\"fog\",\"embedding\":[0.1,0.2]}", parsed.body);
}

test "requestBytesNeeded rejects overflowing and oversized lengths" {
    try std.testing.expectEqual(@as(usize, 28), try requestBytesNeeded(4, 20, 256));
    try std.testing.expectError(error.BadRequest, requestBytesNeeded(4, std.math.maxInt(usize), 256));
    try std.testing.expectError(error.BadRequest, requestBytesNeeded(4, 253, 256));
}

test "peerPidAllowed rejects zero and mismatch" {
    try std.testing.expect(!peerPidAllowed(0, 1));
    try std.testing.expect(!peerPidAllowed(12, 34));
    try std.testing.expect(peerPidAllowed(12, 12));
}

test "tokenMatches compares digests for every length" {
    const expected = [_]u8{'a'} ** token_hex_len;
    try std.testing.expect(tokenMatches(&expected, &expected));

    var wrong = [_]u8{'a'} ** token_hex_len;
    wrong[token_hex_len - 1] = 'b';
    try std.testing.expect(!tokenMatches(&expected, &wrong));

    var wrong_first = [_]u8{'a'} ** token_hex_len;
    wrong_first[0] = 'b';
    try std.testing.expect(!tokenMatches(&expected, &wrong_first));

    // A missing, short, or overlong token never matches.
    try std.testing.expect(!tokenMatches(&expected, ""));
    try std.testing.expect(!tokenMatches(&expected, "aa"));
    const long = [_]u8{'a'} ** (token_hex_len + 1);
    try std.testing.expect(!tokenMatches(&expected, &long));
}

test "allocSocketPath stays under the macOS limit" {
    const long_dir = "/Users/" ++ ("a" ** 80) ++ "/Library/Application Support/com.wasimxyz.sage";
    const path = try allocSocketPath(std.testing.allocator, long_dir);
    defer std.testing.allocator.free(path);
    try std.testing.expect(path.len <= 103);
    try std.testing.expect(std.mem.startsWith(u8, path, socket_path_prefix));
    try std.testing.expect(std.mem.endsWith(u8, path, ".sock"));
}

test "allocSocketPath differs across data dirs" {
    const a = try allocSocketPath(std.testing.allocator, "/tmp/sage-a");
    defer std.testing.allocator.free(a);
    const b = try allocSocketPath(std.testing.allocator, "/tmp/sage-b");
    defer std.testing.allocator.free(b);
    try std.testing.expect(!std.mem.eql(u8, a, b));
}

fn ignoreWake(_: *anyopaque) void {}

fn testDataDir(io: std.Io, tmp: *std.testing.TmpDir, path_buf: *[std.Io.Dir.max_path_bytes]u8) ![]const u8 {
    try tmp.dir.writeFile(io, .{ .sub_path = ".keep", .data = "" });
    const file_len = try tmp.dir.realPathFile(io, ".keep", path_buf);
    return std.fs.path.dirname(path_buf[0..file_len]) orelse error.NoDir;
}

test "start writes a socket discovery file" {
    if (builtin.os.tag == .linux) return error.SkipZigTest;

    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = try testDataDir(io, &tmp, &path_buf);

    var queue: Queue = .{};
    var server: Server = .{};
    try start(&server, std.testing.allocator, dir_path, &queue, .{
        .context = undefined,
        .wake_fn = ignoreWake,
    }, .{ .write_discovery = true, .peer_check = false });
    defer stop(&server);

    const contents = try tmp.dir.readFileAlloc(io, "agent-server.json", std.testing.allocator, .limited(1024));
    defer std.testing.allocator.free(contents);
    try std.testing.expect(std.mem.indexOf(u8, contents, "\"socket\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, contents, "\"token\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, contents, "\"port\"") == null);
    try std.testing.expect(std.mem.indexOf(u8, contents, server.socket_path) != null);
    try std.testing.expect(std.mem.startsWith(u8, server.socket_path, socket_path_prefix));
}

test "start skips the discovery file when asked" {
    if (builtin.os.tag == .linux) return error.SkipZigTest;

    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = try testDataDir(io, &tmp, &path_buf);

    var queue: Queue = .{};
    var server: Server = .{};
    try start(&server, std.testing.allocator, dir_path, &queue, .{
        .context = undefined,
        .wake_fn = ignoreWake,
    }, .{ .write_discovery = false, .peer_check = false });
    defer stop(&server);

    tmp.dir.access(io, "agent-server.json", .{}) catch |err| {
        try std.testing.expectEqual(error.FileNotFound, err);
        return;
    };
    try std.testing.expect(false);
}

test "health answers after start" {
    // Connecting from std.testing.io while accept runs on Server's Threaded Io
    // deadlocks on Linux. Skip the round-trip here; parseRequest tests still cover
    // the HTTP shape, and macOS developers can run this against a live listener.
    if (builtin.os.tag == .linux) return error.SkipZigTest;

    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = try testDataDir(io, &tmp, &path_buf);

    var queue: Queue = .{};
    var server: Server = .{};
    try start(&server, std.testing.allocator, dir_path, &queue, .{
        .context = undefined,
        .wake_fn = ignoreWake,
    }, .{ .write_discovery = true, .peer_check = false });
    defer stop(&server);

    const address = try std.Io.net.UnixAddress.init(server.socket_path);
    const stream = try address.connect(io);
    defer stream.close(io);

    const Watch = struct {
        io: std.Io,
        stream: std.Io.net.Stream,
        done: std.atomic.Value(bool) = .init(false),

        fn run(self: *@This()) void {
            var elapsed: i64 = 0;
            while (elapsed < 2000) {
                std.Io.sleep(self.io, .fromMilliseconds(50), .awake) catch return;
                if (self.done.load(.acquire)) return;
                elapsed += 50;
            }
            self.stream.shutdown(self.io, .both) catch {};
        }
    };
    var watch: Watch = .{ .io = io, .stream = stream };
    const watch_thread = try std.Thread.spawn(.{}, Watch.run, .{&watch});
    defer {
        watch.done.store(true, .release);
        watch_thread.join();
    }

    var request_buf: [160]u8 = undefined;
    const request = try std.fmt.bufPrint(
        &request_buf,
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {s}\r\nConnection: close\r\n\r\n",
        .{&server.token_hex},
    );
    var write_buf: [256]u8 = undefined;
    var writer = stream.writer(io, &write_buf);
    try writer.interface.writeAll(request);
    try writer.interface.flush();

    var response: std.ArrayList(u8) = .empty;
    defer response.deinit(std.testing.allocator);
    var reader_buf: [256]u8 = undefined;
    var dest: [256]u8 = undefined;
    var reader = stream.reader(io, &reader_buf);
    while (true) {
        const n = reader.interface.readSliceShort(&dest) catch break;
        if (n == 0) break;
        try response.appendSlice(std.testing.allocator, dest[0..n]);
    }

    try std.testing.expect(std.mem.indexOf(u8, response.items, "HTTP/1.1 200") != null);
    try std.testing.expect(std.mem.indexOf(u8, response.items, "{\"ok\":true}") != null);
}

/// Reads until the peer closes, shutting the socket down if that takes longer
/// than `backstop_ms`, so a reply that never arrives fails a test instead of
/// hanging it.
fn readResponse(io: std.Io, stream: std.Io.net.Stream, backstop_ms: i64, out: *std.ArrayList(u8)) !void {
    const Watch = struct {
        io: std.Io,
        stream: std.Io.net.Stream,
        backstop_ms: i64,
        done: std.atomic.Value(bool) = .init(false),

        fn run(self: *@This()) void {
            var elapsed: i64 = 0;
            while (elapsed < self.backstop_ms) {
                std.Io.sleep(self.io, .fromMilliseconds(50), .awake) catch return;
                if (self.done.load(.acquire)) return;
                elapsed += 50;
            }
            self.stream.shutdown(self.io, .both) catch {};
        }
    };
    var watch: Watch = .{ .io = io, .stream = stream, .backstop_ms = backstop_ms };
    const watch_thread = try std.Thread.spawn(.{}, Watch.run, .{&watch});
    defer {
        watch.done.store(true, .release);
        watch_thread.join();
    }

    var reader_buf: [256]u8 = undefined;
    var dest: [256]u8 = undefined;
    var reader = stream.reader(io, &reader_buf);
    while (true) {
        const n = reader.interface.readSliceShort(&dest) catch break;
        if (n == 0) break;
        try out.appendSlice(std.testing.allocator, dest[0..n]);
    }
}

test "read deadline answers a stalled request with 408" {
    if (builtin.os.tag == .linux) return error.SkipZigTest;

    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = try testDataDir(io, &tmp, &path_buf);

    var queue: Queue = .{};
    var server: Server = .{};
    try start(&server, std.testing.allocator, dir_path, &queue, .{
        .context = undefined,
        .wake_fn = ignoreWake,
    }, .{ .write_discovery = false, .peer_check = false });
    defer stop(&server);

    const address = try std.Io.net.UnixAddress.init(server.socket_path);
    const stream = try address.connect(io);
    defer stream.close(io);

    // Headers that never end. This request carries no token either: the read
    // is what times out, not the auth check.
    var write_buf: [128]u8 = undefined;
    var writer = stream.writer(io, &write_buf);
    try writer.interface.writeAll("GET /health HTTP/1.1\r\nHost: local\r\n");
    try writer.interface.flush();

    var response: std.ArrayList(u8) = .empty;
    defer response.deinit(std.testing.allocator);
    // The backstop outlasts the server deadline, so a reply that never comes
    // leaves an empty response and fails an assertion instead of the clock.
    try readResponse(io, stream, request_read_timeout_ms + 4000, &response);

    try std.testing.expect(std.mem.indexOf(u8, response.items, "HTTP/1.1 408") != null);
    try std.testing.expect(std.mem.indexOf(u8, response.items, "\"error\":\"timeout\"") != null);
}

test "a stalled client does not block the next connection" {
    if (builtin.os.tag == .linux) return error.SkipZigTest;

    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = try testDataDir(io, &tmp, &path_buf);

    var queue: Queue = .{};
    var server: Server = .{};
    try start(&server, std.testing.allocator, dir_path, &queue, .{
        .context = undefined,
        .wake_fn = ignoreWake,
    }, .{ .write_discovery = false, .peer_check = false });
    defer stop(&server);

    const address = try std.Io.net.UnixAddress.init(server.socket_path);

    // The first client stops halfway through its request and stays connected.
    // Shutting it down instead would unblock the inline accept loop on its own
    // and hide the bug this test exists for.
    const stalled = try address.connect(io);
    defer stalled.close(io);
    var stalled_buf: [128]u8 = undefined;
    var stalled_writer = stalled.writer(io, &stalled_buf);
    try stalled_writer.interface.writeAll("GET /health HTTP/1.1\r\nHost: local\r\n");
    try stalled_writer.interface.flush();

    const started = std.Io.Clock.Timestamp.now(io, .awake);

    const stream = try address.connect(io);
    defer stream.close(io);
    var request_buf: [160]u8 = undefined;
    const request = try std.fmt.bufPrint(
        &request_buf,
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {s}\r\nConnection: close\r\n\r\n",
        .{&server.token_hex},
    );
    var write_buf: [256]u8 = undefined;
    var writer = stream.writer(io, &write_buf);
    try writer.interface.writeAll(request);
    try writer.interface.flush();

    var response: std.ArrayList(u8) = .empty;
    defer response.deinit(std.testing.allocator);
    try readResponse(io, stream, 3 * request_read_timeout_ms, &response);
    const elapsed_ms = started.untilNow(io).raw.toMilliseconds();

    try std.testing.expect(std.mem.indexOf(u8, response.items, "HTTP/1.1 200") != null);
    // The second client is answered while the first still stalls, well before
    // the backstop that closed its socket. Waiting out the stalled client's
    // deadline instead is what the old inline accept loop did, so this bound
    // tells the two apart.
    try std.testing.expect(elapsed_ms < request_read_timeout_ms / 2);
}

test "peer check closes callers that are not the agent" {
    if (builtin.os.tag == .linux) return error.SkipZigTest;

    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = try testDataDir(io, &tmp, &path_buf);

    var queue: Queue = .{};
    var server: Server = .{};
    try start(&server, std.testing.allocator, dir_path, &queue, .{
        .context = undefined,
        .wake_fn = ignoreWake,
    }, .{ .write_discovery = false, .peer_check = true });
    defer stop(&server);

    const address = try std.Io.net.UnixAddress.init(server.socket_path);
    const stream = try address.connect(io);
    defer stream.close(io);

    const Watch = struct {
        io: std.Io,
        stream: std.Io.net.Stream,
        done: std.atomic.Value(bool) = .init(false),

        fn run(self: *@This()) void {
            var elapsed: i64 = 0;
            while (elapsed < 2000) {
                std.Io.sleep(self.io, .fromMilliseconds(50), .awake) catch return;
                if (self.done.load(.acquire)) return;
                elapsed += 50;
            }
            self.stream.shutdown(self.io, .both) catch {};
        }
    };
    var watch: Watch = .{ .io = io, .stream = stream };
    const watch_thread = try std.Thread.spawn(.{}, Watch.run, .{&watch});
    defer {
        watch.done.store(true, .release);
        watch_thread.join();
    }

    var request_buf: [160]u8 = undefined;
    const request = try std.fmt.bufPrint(
        &request_buf,
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {s}\r\nConnection: close\r\n\r\n",
        .{&server.token_hex},
    );
    var write_buf: [256]u8 = undefined;
    var writer = stream.writer(io, &write_buf);
    writer.interface.writeAll(request) catch {};
    writer.interface.flush() catch {};

    var response: std.ArrayList(u8) = .empty;
    defer response.deinit(std.testing.allocator);
    var dest: [256]u8 = undefined;
    var reader_buf: [256]u8 = undefined;
    var reader = stream.reader(io, &reader_buf);
    while (true) {
        const n = reader.interface.readSliceShort(&dest) catch break;
        if (n == 0) break;
        try response.appendSlice(std.testing.allocator, dest[0..n]);
    }
    try std.testing.expectEqual(@as(usize, 0), response.items.len);
}

test "peer check allows the expected pid" {
    if (builtin.os.tag == .linux) return error.SkipZigTest;

    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = try testDataDir(io, &tmp, &path_buf);

    var queue: Queue = .{};
    var server: Server = .{};
    try start(&server, std.testing.allocator, dir_path, &queue, .{
        .context = undefined,
        .wake_fn = ignoreWake,
    }, .{ .write_discovery = false, .peer_check = true });
    defer stop(&server);

    server.expected_pid.store(std.c.getpid(), .release);

    const address = try std.Io.net.UnixAddress.init(server.socket_path);
    const stream = try address.connect(io);
    defer stream.close(io);

    const Watch = struct {
        io: std.Io,
        stream: std.Io.net.Stream,
        done: std.atomic.Value(bool) = .init(false),

        fn run(self: *@This()) void {
            var elapsed: i64 = 0;
            while (elapsed < 2000) {
                std.Io.sleep(self.io, .fromMilliseconds(50), .awake) catch return;
                if (self.done.load(.acquire)) return;
                elapsed += 50;
            }
            self.stream.shutdown(self.io, .both) catch {};
        }
    };
    var watch: Watch = .{ .io = io, .stream = stream };
    const watch_thread = try std.Thread.spawn(.{}, Watch.run, .{&watch});
    defer {
        watch.done.store(true, .release);
        watch_thread.join();
    }

    var request_buf: [160]u8 = undefined;
    const request = try std.fmt.bufPrint(
        &request_buf,
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {s}\r\nConnection: close\r\n\r\n",
        .{&server.token_hex},
    );
    var write_buf: [256]u8 = undefined;
    var writer = stream.writer(io, &write_buf);
    try writer.interface.writeAll(request);
    try writer.interface.flush();

    var response: std.ArrayList(u8) = .empty;
    defer response.deinit(std.testing.allocator);
    var reader_buf: [256]u8 = undefined;
    var dest: [256]u8 = undefined;
    var reader = stream.reader(io, &reader_buf);
    while (true) {
        const n = reader.interface.readSliceShort(&dest) catch break;
        if (n == 0) break;
        try response.appendSlice(std.testing.allocator, dest[0..n]);
    }

    try std.testing.expect(std.mem.indexOf(u8, response.items, "HTTP/1.1 200") != null);
    try std.testing.expect(std.mem.indexOf(u8, response.items, "{\"ok\":true}") != null);
}
