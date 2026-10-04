const std = @import("std");
const native_sdk = @import("native_sdk");
const agent_server = @import("agent_server.zig");

pub const host = "127.0.0.1";
pub const port: u16 = 2001;
pub const origin = "http://127.0.0.1:2001";
pub const retry_interval_ms: i64 = 10_000;

const port_text = "2001";
const macos_dir_name = "MacOS";
const node_major_required: u32 = 24;
const missing_node_message = "This copy of Sage is incomplete.";
const stop_wait_ms: i64 = 1_000;
const stop_poll_ms: i64 = 50;

pub const Kind = enum {
    down,
    missing_build,
    missing_node,
    port_busy,
    ready,
};

pub const world_key_len = 32;
pub const world_key_hex_len = 64;
pub const world_key_env = "SAGE_EVE_WORLD_KEY";
const world_key_info = "sage/eve-world/v1";
const hex_digits = "0123456789abcdef";

/// Parent variables copied into packaged Chat. Ollama settings stay out:
/// the child always uses the local URL set in `fillChatChildEnv`.
const chat_env_allowlist = [_][]const u8{
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
};

pub const Sidecar = struct {
    allocator: std.mem.Allocator = undefined,
    io: std.Io = undefined,
    data_dir: []const u8 = &.{},
    env_map: *std.process.Environ.Map = undefined,
    packaged: bool = false,
    last_attempt_ms: i64 = 0,
    kind: Kind = .down,
    message: []const u8 = "",
    child: ?std.process.Child = null,
    group_id: i32 = 0,
    world_key_hex: ?[world_key_hex_len]u8 = null,
    agent_token_hex: ?*const [agent_server.token_hex_len]u8 = null,
    expected_pid: ?*std.atomic.Value(i32) = null,

    pub fn start(
        self: *Sidecar,
        allocator: std.mem.Allocator,
        io: std.Io,
        data_dir: []const u8,
        env_map: *std.process.Environ.Map,
        packaged: bool,
        spawn_now: bool,
    ) void {
        self.allocator = allocator;
        self.io = io;
        self.data_dir = data_dir;
        self.env_map = env_map;
        self.packaged = packaged;
        if (!packaged) return;
        if (!spawn_now) return;
        self.attempt();
    }

    pub fn startNow(self: *Sidecar) void {
        if (!self.packaged) return;
        if (self.kind == .ready and !self.childExited()) return;
        self.attempt();
    }

    pub fn setUnavailable(self: *Sidecar, message: []const u8) void {
        self.setKind(.down, message);
    }

    pub fn setWorldKeyFromDataKey(self: *Sidecar, data_key: *const [world_key_len]u8) void {
        var world_key = deriveWorldKey(data_key);
        defer std.crypto.secureZero(u8, &world_key);
        self.clearWorldKey();
        self.world_key_hex = encodeHex(world_key);
    }

    pub fn clearWorldKey(self: *Sidecar) void {
        if (self.world_key_hex) |*hex| {
            std.crypto.secureZero(u8, hex);
        }
        self.world_key_hex = null;
    }

    pub fn ensureRunning(self: *Sidecar) void {
        if (!self.packaged) return;
        if (self.kind == .ready) {
            if (!self.childExited()) return;
            self.clearExpectedPid();
            self.setKind(.down, "The Chat agent stopped. Sage will try to start it again.");
            self.attempt();
            return;
        }
        if (!canRetry(self.last_attempt_ms, nowMs(self.io))) return;
        self.attempt();
    }

    fn attempt(self: *Sidecar) void {
        self.last_attempt_ms = nowMs(self.io);
        const allocator = self.allocator;
        const io = self.io;
        const env_map = self.env_map;

        var exe_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const exe_len = std.process.executablePath(io, &exe_buf) catch {
            self.fail(.down, "The Chat agent failed to start.");
            return;
        };
        const exe_path = exe_buf[0..exe_len];
        var resource_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const resource_dir = agentResourceDir(exe_path, &resource_buf) orelse {
            self.fail(.down, "The Chat agent failed to start.");
            return;
        };
        if (!dirExists(io, resource_dir) or !bundleComplete(io, resource_dir)) {
            self.fail(
                .missing_build,
                "This copy of Sage is missing the chat agent. Rebuild the app with zig build package.",
            );
            return;
        }
        if (!portIsFree(io, port)) {
            self.fail(.port_busy, "Port 2001 is already in use, so Chat cannot start.");
            return;
        }

        var node_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const node_path = bundledNodePath(exe_path, &node_buf) orelse {
            self.fail(.missing_node, missing_node_message);
            return;
        };
        if (!nodePathSupported(allocator, io, node_path)) {
            self.fail(.missing_node, missing_node_message);
            return;
        }

        const cwd = std.fmt.allocPrint(allocator, "{s}/eve", .{self.data_dir}) catch {
            self.fail(.down, "The Chat agent failed to start.");
            return;
        };
        defer allocator.free(cwd);
        std.Io.Dir.cwd().createDirPath(io, cwd) catch {
            self.fail(.down, "The Chat agent failed to start.");
            return;
        };
        linkBundle(io, resource_dir, cwd) catch {
            self.fail(.down, "The Chat agent failed to start.");
            return;
        };

        var server_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const server_entry = productionServerEntry(cwd, &server_buf) orelse {
            self.fail(.down, "The Chat agent failed to start.");
            return;
        };

        var guard_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const guard_preload = workflowGuardPreload(cwd, &guard_buf) orelse {
            self.fail(.down, "The Chat agent failed to start.");
            return;
        };

        var child_env = std.process.Environ.Map.init(allocator);
        defer child_env.deinit();
        var path_override: ?[]u8 = null;
        defer if (path_override) |value| allocator.free(value);
        const socket_path = agent_server.allocSocketPath(allocator, self.data_dir) catch {
            self.fail(.down, "The Chat agent failed to start.");
            return;
        };
        defer allocator.free(socket_path);
        const path_value: ?[]const u8 = if (std.fs.path.dirname(node_path)) |node_dir| blk: {
            if (env_map.get("PATH")) |existing| {
                path_override = std.fmt.allocPrint(allocator, "{s}:{s}", .{ node_dir, existing }) catch {
                    self.fail(.down, "The Chat agent failed to start.");
                    return;
                };
                break :blk path_override.?;
            } else {
                break :blk node_dir;
            }
        } else null;
        fillChatChildEnv(&child_env, env_map, path_value, socket_path) catch {
            self.fail(.down, "The Chat agent failed to start.");
            return;
        };

        // eve start launches this same file with stdin ignored. Sage starts it
        // directly so the token pipe and the process-id check apply to the
        // process that answers Chat.
        const argv = [_][]const u8{
            node_path,
            "--import",
            guard_preload,
            server_entry,
        };
        var child = std.process.spawn(io, .{
            .argv = &argv,
            .cwd = .{ .path = cwd },
            .environ_map = &child_env,
            .stdin = .pipe,
            .stdout = .ignore,
            .stderr = .ignore,
            .pgid = if (builtinPosix()) 0 else null,
        }) catch {
            self.fail(.down, "The Chat agent failed to start.");
            return;
        };
        if (!self.writeSpawnSecrets(&child)) {
            child.kill(io);
            self.fail(.down, "The Chat agent failed to start.");
            return;
        }
        self.storeExpectedPid(&child);
        self.group_id = processGroupId(&child);
        self.child = child;
        self.setKind(.ready, "");
    }

    pub fn stop(self: *Sidecar) void {
        self.clearWorldKey();
        self.clearExpectedPid();
        if (self.group_id > 0) {
            std.posix.kill(-self.group_id, std.posix.SIG.TERM) catch {};
            var waited: i64 = 0;
            while (waited < stop_wait_ms) {
                if (self.childExited()) break;
                std.Io.sleep(self.io, .fromMilliseconds(stop_poll_ms), .awake) catch break;
                waited += stop_poll_ms;
            }
            if (self.group_id > 0) {
                std.posix.kill(-self.group_id, std.posix.SIG.KILL) catch {};
            }
            self.group_id = 0;
        }
        if (self.child) |*child| {
            child.kill(self.io);
            self.child = null;
        }
        self.message = "";
        self.kind = .down;
    }

    pub fn writeStatus(self: *const Sidecar, output: []u8) ![]const u8 {
        return writeStatusJson(output, self.kind, self.message);
    }

    fn fail(self: *Sidecar, kind: Kind, message: []const u8) void {
        self.setKind(kind, message);
    }

    fn setKind(self: *Sidecar, kind: Kind, message: []const u8) void {
        self.kind = kind;
        self.message = message;
    }

    fn clearExpectedPid(self: *Sidecar) void {
        if (self.expected_pid) |slot| slot.store(0, .release);
    }

    fn storeExpectedPid(self: *Sidecar, child: *const std.process.Child) void {
        const slot = self.expected_pid orelse return;
        const pid: i32 = if (child.id) |id| @intCast(id) else 0;
        slot.store(pid, .release);
    }

    fn writeSpawnSecrets(self: *Sidecar, child: *std.process.Child) bool {
        const token = self.agent_token_hex orelse return false;
        const stdin = child.stdin orelse return false;
        var payload_buf: [agent_server.token_hex_len + world_key_hex_len + 4]u8 = undefined;
        const world_key: ?[]const u8 = if (self.world_key_hex) |*hex| hex[0..] else null;
        const payload = spawnPayload(&payload_buf, token, world_key) orelse return false;
        stdin.writeStreamingAll(self.io, payload) catch return false;
        stdin.close(self.io);
        child.stdin = null;
        return true;
    }

    fn childExited(self: *Sidecar) bool {
        const child = self.child orelse return true;
        if (!builtinPosix()) return false;
        const pid = child.id orelse return true;
        while (true) {
            var status: c_int = 0;
            const r = std.posix.system.waitpid(pid, &status, std.c.W.NOHANG);
            switch (std.posix.errno(r)) {
                .SUCCESS => {
                    if (r == 0) return false;
                },
                .INTR => continue,
                .CHILD => {},
                else => return false,
            }
            break;
        }
        self.child = null;
        self.group_id = 0;
        return true;
    }
};

pub fn canRetry(last_attempt_ms: i64, now_ms: i64) bool {
    return now_ms - last_attempt_ms >= retry_interval_ms;
}

/// Build the environment for packaged Chat. Copies a short allowlist from
/// Sage, then pins Ollama to this machine. `OLLAMA_API_KEY` and the world
/// key are never included; the world key goes through the spawn pipe.
fn fillChatChildEnv(
    child_env: *std.process.Environ.Map,
    parent: *std.process.Environ.Map,
    path_value: ?[]const u8,
    socket_path: []const u8,
) !void {
    for (chat_env_allowlist) |key| {
        if (parent.get(key)) |value| {
            try child_env.put(key, value);
        }
    }
    if (path_value) |path| {
        try child_env.put("PATH", path);
    }
    try child_env.put("EVE_TELEMETRY_DISABLED", "1");
    try child_env.put(agent_server.socket_env, socket_path);
    try child_env.put("HOST", host);
    try child_env.put("NITRO_HOST", host);
    try child_env.put("NITRO_PORT", port_text);
    try child_env.put("PORT", port_text);
    try child_env.put("OLLAMA_BASE_URL", "http://127.0.0.1:11434/api");
}

pub fn deriveWorldKey(data_key: *const [world_key_len]u8) [world_key_len]u8 {
    const Hkdf = std.crypto.kdf.hkdf.HkdfSha256;
    const prk = Hkdf.extract("", data_key);
    var out: [world_key_len]u8 = undefined;
    Hkdf.expand(&out, world_key_info, prk);
    return out;
}

pub fn encodeHex(bytes: [world_key_len]u8) [world_key_hex_len]u8 {
    var out: [world_key_hex_len]u8 = undefined;
    for (bytes, 0..) |byte, i| {
        out[i * 2] = hex_digits[byte >> 4];
        out[i * 2 + 1] = hex_digits[byte & 0x0f];
    }
    return out;
}

pub fn wipeWorkflowData(io: std.Io, data_dir: []const u8) void {
    wipeWorkflowDataStrict(io, data_dir) catch {};
}

pub fn wipeWorkflowDataStrict(io: std.Io, data_dir: []const u8) !void {
    if (data_dir.len == 0) return;
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buf, "{s}/eve/.eve/.workflow-data", .{data_dir});
    try wipeWorkflowDirectoryStrict(io, path);
}

pub fn wipeWorkflowDirectoryStrict(io: std.Io, path: []const u8) !void {
    if (path.len == 0) return;
    const parent_path = std.fs.path.dirname(path) orelse return error.InvalidPath;
    const base = std.fs.path.basename(path);
    var parent = std.Io.Dir.openDirAbsolute(io, parent_path, .{}) catch |err| {
        if (err == error.FileNotFound) return;
        return err;
    };
    defer parent.close(io);
    parent.deleteTree(io, base) catch |err| {
        if (err == error.FileNotFound) return;
        return err;
    };
}

const session_id_prefix = "wrun_";
const session_ulid_len = 26;
const cancel_timeout_ms: i64 = 1_000;
pub const orphan_grace_ms: i64 = 60 * 60 * 1_000;
const match_name_cap = 256;
const match_pass_cap = 32;
const stream_name_cap = 32;
const stream_index_max_bytes = 16 * 1024;
const hook_id_cap = 64;
const index_key_cap = 64;

/// True when `id` is a workflow run id (`wrun_` + 26 Crockford characters)
/// with no path separators. Session ids are untrusted filesystem keys.
pub fn isValidSessionId(id: []const u8) bool {
    if (id.len != session_id_prefix.len + session_ulid_len) return false;
    if (!std.mem.eql(u8, id[0..session_id_prefix.len], session_id_prefix)) return false;
    for (id[session_id_prefix.len..]) |byte| {
        if (!isCrockford(byte)) return false;
    }
    return true;
}

const cancel_header_max = 512;

/// HTTP request that asks eve to cancel one session. Empty tokens are rejected
/// so a cancel is never sent without the agent-server secret.
pub fn cancelRequestHeader(buf: []u8, session_id: []const u8, token: []const u8) ?[]const u8 {
    if (token.len == 0) return null;
    return std.fmt.bufPrint(
        buf,
        "POST /eve/v1/session/{s}/cancel HTTP/1.1\r\nHost: {s}:{d}\r\nAuthorization: Bearer {s}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        .{ session_id, host, port, token },
    ) catch null;
}

/// Best-effort cancel of an in-flight eve turn. Failures are ignored so chat
/// deletion can still remove the on-disk session files.
pub fn cancelSession(io: std.Io, session_id: []const u8, token: []const u8) void {
    if (!isValidSessionId(session_id)) return;

    var header_buffer: [cancel_header_max]u8 = undefined;
    const header = cancelRequestHeader(&header_buffer, session_id, token) orelse return;

    const address = std.Io.net.IpAddress.parseIp4(host, port) catch return;
    const stream = std.Io.net.IpAddress.connect(&address, io, .{
        .mode = .stream,
        .protocol = .tcp,
    }) catch return;
    defer stream.close(io);

    var abort = CancelAbort{ .io = io };
    abort.arm(stream);
    const watchdog = std.Thread.spawn(.{}, cancelWatchdogMain, .{ &abort, cancel_timeout_ms }) catch null;
    defer finishCancelWatchdog(&abort, watchdog);

    var write_buffer: [cancel_header_max]u8 = undefined;
    var stream_writer = std.Io.net.Stream.writer(stream, io, &write_buffer);
    stream_writer.interface.writeAll(header) catch return;
    stream_writer.interface.flush() catch return;

    var dest_buffer: [256]u8 = undefined;
    var reader_buffer: [256]u8 = undefined;
    var stream_reader = std.Io.net.Stream.reader(stream, io, &reader_buffer);
    _ = stream_reader.interface.readSliceShort(&dest_buffer) catch {};
}

/// Remove one session's files from `.eve/.workflow-data`. Missing trees and
/// individual files are ignored. Invalid ids are rejected so a stored value
/// cannot walk out of the workflow directory.
pub fn deleteSessionData(io: std.Io, data_dir: []const u8, session_id: []const u8) void {
    if (data_dir.len == 0) return;
    if (!isValidSessionId(session_id)) return;

    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root = std.fmt.bufPrint(&root_buf, "{s}/eve/.eve/.workflow-data", .{data_dir}) catch return;

    deleteExactFile(io, root, "runs", session_id, ".json");
    deleteMatchingNames(io, root, "steps", session_id, .run);
    deleteMatchingNames(io, root, "events", session_id, .run);
    deleteMatchingNames(io, root, "waits", session_id, .run);
    deleteSessionStreams(io, root, session_id);
    deleteSessionHooks(io, root, session_id);
    deleteMatchingNames(io, root, ".locks/runs", session_id, .run);
    deleteMatchingNames(io, root, ".locks/steps", session_id, .run);
    deleteMatchingNames(io, root, ".locks/waits", session_id, .run);
    deleteMatchingNames(io, root, ".locks/attributes", session_id, .run);
}

/// Remove workflow files for run ids that no chat row still references.
/// Run files younger than `orphan_grace_ms` are left alone so a crash
/// before the first save does not collect an in-progress session.
pub fn sweepOrphanedSessions(io: std.Io, data_dir: []const u8, session_ids: []const []const u8) void {
    sweepOrphanedSessionsGrace(io, data_dir, session_ids, orphan_grace_ms);
}

/// Same as `sweepOrphanedSessions` with a caller-chosen grace. Tests pass
/// `0` to treat every run file as old.
pub fn sweepOrphanedSessionsGrace(
    io: std.Io,
    data_dir: []const u8,
    session_ids: []const []const u8,
    grace_ms: i64,
) void {
    if (data_dir.len == 0) return;

    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root = std.fmt.bufPrint(&root_buf, "{s}/eve/.eve/.workflow-data", .{data_dir}) catch return;
    var runs_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const runs_path = joinUnder(&runs_buf, root, "runs") orelse return;

    var pass: usize = 0;
    while (pass < match_pass_cap) : (pass += 1) {
        var dir = std.Io.Dir.openDirAbsolute(io, runs_path, .{ .iterate = true }) catch return;
        var names: [match_name_cap][64]u8 = undefined;
        var lens: [match_name_cap]usize = undefined;
        var count: usize = 0;
        var it = dir.iterate();
        while (it.next(io) catch break) |entry| {
            if (!std.mem.endsWith(u8, entry.name, ".json")) continue;
            const id = entry.name[0 .. entry.name.len - ".json".len];
            if (!isValidSessionId(id)) continue;
            if (containsId(session_ids, id)) continue;
            if (runFileIsYoung(io, runs_path, entry.name, grace_ms)) continue;
            if (count == names.len) break;
            if (id.len > names[count].len) continue;
            @memcpy(names[count][0..id.len], id);
            lens[count] = id.len;
            count += 1;
        }
        dir.close(io);
        if (count == 0) return;
        for (0..count) |index| {
            deleteSessionData(io, data_dir, names[index][0..lens[index]]);
        }
        if (count < names.len) return;
    }
}

const NameMatch = enum { run, stream_chunk };

const HookIdSet = struct {
    names: [hook_id_cap][128]u8 = undefined,
    lens: [hook_id_cap]usize = undefined,
    count: usize = 0,

    fn add(self: *HookIdSet, id: []const u8) void {
        if (!isSafeName(id)) return;
        if (self.contains(id)) return;
        if (self.count == self.names.len) return;
        if (id.len > self.names[self.count].len) return;
        @memcpy(self.names[self.count][0..id.len], id);
        self.lens[self.count] = id.len;
        self.count += 1;
    }

    fn contains(self: *const HookIdSet, id: []const u8) bool {
        for (0..self.count) |index| {
            if (std.mem.eql(u8, self.names[index][0..self.lens[index]], id)) return true;
        }
        return false;
    }

    fn get(self: *const HookIdSet, index: usize) []const u8 {
        return self.names[index][0..self.lens[index]];
    }
};

const CancelAbort = struct {
    io: std.Io,
    mutex: std.Io.Mutex = .init,
    stream: ?std.Io.net.Stream = null,
    fired: std.atomic.Value(bool) = .init(false),
    done: std.atomic.Value(bool) = .init(false),

    fn arm(self: *CancelAbort, stream: std.Io.net.Stream) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.fired.load(.acquire)) {
            stream.shutdown(self.io, .both) catch {};
            return;
        }
        self.stream = stream;
    }

    fn fire(self: *CancelAbort) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        self.fired.store(true, .release);
        if (self.stream) |stream| stream.shutdown(self.io, .both) catch {};
        self.stream = null;
    }
};

fn finishCancelWatchdog(abort: *CancelAbort, thread: ?std.Thread) void {
    abort.done.store(true, .release);
    if (thread) |t| t.join();
}

fn cancelWatchdogMain(abort: *CancelAbort, timeout_ms: i64) void {
    const step_ms: i64 = 100;
    var elapsed: i64 = 0;
    while (elapsed < timeout_ms) {
        std.Io.sleep(abort.io, .fromMilliseconds(step_ms), .awake) catch return;
        if (abort.done.load(.acquire)) return;
        elapsed += step_ms;
    }
    abort.fire();
}

fn isCrockford(byte: u8) bool {
    return switch (byte) {
        '0'...'9',
        'A'...'H',
        'J',
        'K',
        'M',
        'N',
        'P'...'T',
        'V'...'Z',
        'a'...'h',
        'j',
        'k',
        'm',
        'n',
        'p'...'t',
        'v'...'z',
        => true,
        else => false,
    };
}

fn isSafeName(name: []const u8) bool {
    if (name.len == 0 or name.len > 128) return false;
    if (std.mem.eql(u8, name, ".") or std.mem.eql(u8, name, "..")) return false;
    if (std.mem.indexOfScalar(u8, name, '/') != null) return false;
    if (std.mem.indexOfScalar(u8, name, '\\') != null) return false;
    if (std.mem.indexOf(u8, name, "..") != null) return false;
    return true;
}

fn runNameMatches(name: []const u8, session_id: []const u8) bool {
    if (!std.mem.startsWith(u8, name, session_id)) return false;
    if (name.len == session_id.len) return true;
    const next = name[session_id.len];
    return next == '-' or next == '.';
}

fn streamChunkNameMatches(name: []const u8, session_id: []const u8) bool {
    const ulid = session_id[session_id_prefix.len..];
    const stream_prefix = "strm_";
    if (!std.mem.startsWith(u8, name, stream_prefix)) return false;
    const rest = name[stream_prefix.len..];
    if (!std.mem.startsWith(u8, rest, ulid)) return false;
    if (rest.len == ulid.len) return true;
    return rest[ulid.len] == '_';
}

fn nameMatches(name: []const u8, session_id: []const u8, kind: NameMatch) bool {
    if (!isSafeName(name)) return false;
    return switch (kind) {
        .run => runNameMatches(name, session_id),
        .stream_chunk => streamChunkNameMatches(name, session_id),
    };
}

fn joinUnder(buf: []u8, root: []const u8, rel: []const u8) ?[]u8 {
    return std.fmt.bufPrint(buf, "{s}/{s}", .{ root, rel }) catch null;
}

fn removeAbsolute(io: std.Io, path: []const u8) void {
    std.Io.Dir.deleteFileAbsolute(io, path) catch {
        const parent_path = std.fs.path.dirname(path) orelse return;
        const base = std.fs.path.basename(path);
        if (!isSafeName(base)) return;
        var parent = std.Io.Dir.openDirAbsolute(io, parent_path, .{}) catch return;
        defer parent.close(io);
        parent.deleteTree(io, base) catch {};
    };
}

fn removeNamed(dir: *std.Io.Dir, io: std.Io, name: []const u8) void {
    if (!isSafeName(name)) return;
    var zbuf: [129]u8 = undefined;
    if (name.len >= zbuf.len) return;
    @memcpy(zbuf[0..name.len], name);
    zbuf[name.len] = 0;
    const z: [:0]const u8 = zbuf[0..name.len :0];
    dir.deleteFile(io, z) catch {
        dir.deleteTree(io, z) catch {};
    };
}

fn deleteExactFile(
    io: std.Io,
    root: []const u8,
    rel_dir: []const u8,
    session_id: []const u8,
    suffix: []const u8,
) void {
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}/{s}{s}", .{ root, rel_dir, session_id, suffix }) catch return;
    std.Io.Dir.deleteFileAbsolute(io, path) catch {};
}

fn deleteMatchingNames(
    io: std.Io,
    root: []const u8,
    rel_dir: []const u8,
    session_id: []const u8,
    kind: NameMatch,
) void {
    var dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = joinUnder(&dir_buf, root, rel_dir) orelse return;
    var dir = std.Io.Dir.openDirAbsolute(io, dir_path, .{ .iterate = true }) catch return;
    defer dir.close(io);

    var names: [match_name_cap][128]u8 = undefined;
    var lens: [match_name_cap]usize = undefined;
    var pass: usize = 0;
    while (pass < match_pass_cap) : (pass += 1) {
        var count: usize = 0;
        var it = dir.iterate();
        while (it.next(io) catch break) |entry| {
            if (!nameMatches(entry.name, session_id, kind)) continue;
            if (count == names.len) break;
            if (entry.name.len > names[count].len) continue;
            @memcpy(names[count][0..entry.name.len], entry.name);
            lens[count] = entry.name.len;
            count += 1;
        }
        if (count == 0) return;
        for (0..count) |index| {
            removeNamed(&dir, io, names[index][0..lens[index]]);
        }
        if (count < names.len) return;
    }
}

fn deleteSessionStreams(io: std.Io, root: []const u8, session_id: []const u8) void {
    var index_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const index_path = std.fmt.bufPrint(&index_buf, "{s}/streams/runs/{s}.json", .{ root, session_id }) catch return;
    var contents_buf: [stream_index_max_bytes]u8 = undefined;
    if (readSmallFile(io, index_path, &contents_buf)) |contents| {
        var stored: [stream_name_cap][128]u8 = undefined;
        var lens: [stream_name_cap]usize = undefined;
        const count = parseJsonStringArray(contents, "streams", &stored, &lens);
        var i: usize = 0;
        while (i < count) : (i += 1) {
            const stream_name = stored[i][0..lens[i]];
            if (!isSafeName(stream_name)) continue;
            var chunk_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
            const chunk_path = std.fmt.bufPrint(&chunk_buf, "{s}/streams/chunks/{s}", .{ root, stream_name }) catch continue;
            removeAbsolute(io, chunk_path);
        }
    }
    std.Io.Dir.deleteFileAbsolute(io, index_path) catch {};
    deleteMatchingNames(io, root, "streams/chunks", session_id, .stream_chunk);
}

fn deleteSessionHooks(io: std.Io, root: []const u8, session_id: []const u8) void {
    var hooks: HookIdSet = .{};
    collectHookIdsFromByRun(io, root, session_id, &hooks);
    collectHookIdsFromIdIndex(io, root, session_id, &hooks);
    for (0..hooks.count) |index| {
        const hook_id = hooks.get(index);
        deleteExactFile(io, root, "hooks", hook_id, ".json");
        deleteExactFile(io, root, ".locks/hooks", hook_id, ".disposed");
        deleteEmptyIndexKey(io, root, "hooks/id-index", hook_id);
    }
    deleteHookTokens(io, root, session_id, &hooks);
    deleteHookResumes(io, root, session_id);
    deleteHookTokenIndexEntries(io, root, session_id);
}

fn collectHookIdsFromByRun(
    io: std.Io,
    root: []const u8,
    session_id: []const u8,
    hooks: *HookIdSet,
) void {
    var by_run_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const by_run_path = joinUnder(&by_run_buf, root, "hooks/by-run") orelse return;
    var dir = std.Io.Dir.openDirAbsolute(io, by_run_path, .{ .iterate = true }) catch return;
    defer dir.close(io);

    var names: [hook_id_cap][128]u8 = undefined;
    var lens: [hook_id_cap]usize = undefined;
    var count: usize = 0;
    var it = dir.iterate();
    while (it.next(io) catch null) |entry| {
        if (!nameMatches(entry.name, session_id, .run)) continue;
        if (count == names.len) break;
        if (entry.name.len > names[count].len) continue;
        @memcpy(names[count][0..entry.name.len], entry.name);
        lens[count] = entry.name.len;
        count += 1;
    }

    for (0..count) |index| {
        const name = names[index][0..lens[index]];
        var file_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const file_path = std.fmt.bufPrint(&file_buf, "{s}/{s}", .{ by_run_path, name }) catch {
            removeNamed(&dir, io, name);
            continue;
        };
        var contents_buf: [1024]u8 = undefined;
        var hook_buf: [128]u8 = undefined;
        const hook_id = blk: {
            if (readSmallFile(io, file_path, &contents_buf)) |contents| {
                if (jsonStringField(contents, "hookId", &hook_buf)) |value| break :blk value;
            }
            break :blk hookIdFromByRunName(name, session_id, &hook_buf);
        };
        if (hook_id) |id| hooks.add(id);
        removeNamed(&dir, io, name);
    }
}

fn collectHookIdsFromIdIndex(
    io: std.Io,
    root: []const u8,
    session_id: []const u8,
    hooks: *HookIdSet,
) void {
    deleteMatchingIndexKeys(io, root, "hooks/id-index", session_id, hooks);
}

fn deleteHookTokenIndexEntries(io: std.Io, root: []const u8, session_id: []const u8) void {
    deleteMatchingIndexKeys(io, root, "hooks/token-index", session_id, null);
}

fn deleteMatchingIndexKeys(
    io: std.Io,
    root: []const u8,
    rel_dir: []const u8,
    session_id: []const u8,
    hooks: ?*HookIdSet,
) void {
    var dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = joinUnder(&dir_buf, root, rel_dir) orelse return;
    var dir = std.Io.Dir.openDirAbsolute(io, dir_path, .{ .iterate = true }) catch return;
    defer dir.close(io);

    var keys: [index_key_cap][128]u8 = undefined;
    var lens: [index_key_cap]usize = undefined;
    var count: usize = 0;
    var it = dir.iterate();
    while (it.next(io) catch null) |entry| {
        if (entry.kind != .directory and entry.kind != .sym_link) continue;
        if (!isSafeName(entry.name)) continue;
        if (entry.name.len > 128) continue;
        var name_buf: [128]u8 = undefined;
        @memcpy(name_buf[0..entry.name.len], entry.name);
        const key = name_buf[0..entry.name.len];
        if (!deleteMatchingIndexEntries(io, dir_path, key, session_id)) continue;
        if (hooks) |set| {
            set.add(key);
            deleteExactFile(io, root, "hooks", key, ".json");
            deleteExactFile(io, root, ".locks/hooks", key, ".disposed");
        }
        if (count < keys.len) {
            @memcpy(keys[count][0..key.len], key);
            lens[count] = key.len;
            count += 1;
        }
    }

    for (0..count) |index| {
        deleteEmptyIndexKey(io, root, rel_dir, keys[index][0..lens[index]]);
    }
}

fn deleteMatchingIndexEntries(
    io: std.Io,
    parent_path: []const u8,
    key: []const u8,
    session_id: []const u8,
) bool {
    var dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = std.fmt.bufPrint(&dir_buf, "{s}/{s}", .{ parent_path, key }) catch return false;
    var dir = std.Io.Dir.openDirAbsolute(io, dir_path, .{ .iterate = true }) catch return false;
    defer dir.close(io);

    var names: [index_key_cap][128]u8 = undefined;
    var lens: [index_key_cap]usize = undefined;
    var count: usize = 0;
    var matched = false;
    var pass: usize = 0;
    while (pass < match_pass_cap) : (pass += 1) {
        count = 0;
        var it = dir.iterate();
        while (it.next(io) catch break) |entry| {
            if (!isSafeName(entry.name)) continue;
            var file_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
            const file_path = std.fmt.bufPrint(&file_buf, "{s}/{s}", .{ dir_path, entry.name }) catch continue;
            var contents_buf: [1024]u8 = undefined;
            const contents = readSmallFile(io, file_path, &contents_buf) orelse continue;
            if (std.mem.indexOf(u8, contents, session_id) == null) continue;
            matched = true;
            if (count == names.len) break;
            if (entry.name.len > names[count].len) continue;
            @memcpy(names[count][0..entry.name.len], entry.name);
            lens[count] = entry.name.len;
            count += 1;
        }
        if (count == 0) break;
        for (0..count) |index| {
            removeNamed(&dir, io, names[index][0..lens[index]]);
        }
        if (count < names.len) break;
    }
    return matched;
}

fn deleteEmptyIndexKey(io: std.Io, root: []const u8, rel_dir: []const u8, key: []const u8) void {
    if (!isSafeName(key)) return;
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}/{s}", .{ root, rel_dir, key }) catch return;
    if (dirHasEntries(io, path)) return;
    removeAbsolute(io, path);
}

fn dirHasEntries(io: std.Io, path: []const u8) bool {
    var dir = std.Io.Dir.openDirAbsolute(io, path, .{ .iterate = true }) catch return false;
    defer dir.close(io);
    var it = dir.iterate();
    while (it.next(io) catch return true) |entry| {
        if (std.mem.eql(u8, entry.name, ".") or std.mem.eql(u8, entry.name, "..")) continue;
        return true;
    }
    return false;
}

fn hookIdFromByRunName(name: []const u8, session_id: []const u8, out: []u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, name, session_id)) return null;
    if (name.len <= session_id.len + 1) return null;
    if (name[session_id.len] != '-') return null;
    if (!std.mem.endsWith(u8, name, ".json")) return null;
    const hook_id = name[session_id.len + 1 .. name.len - ".json".len];
    if (hook_id.len == 0 or hook_id.len > out.len) return null;
    @memcpy(out[0..hook_id.len], hook_id);
    return out[0..hook_id.len];
}

fn deleteHookTokens(io: std.Io, root: []const u8, session_id: []const u8, hooks: *const HookIdSet) void {
    var tokens_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const tokens_path = joinUnder(&tokens_buf, root, "hooks/tokens") orelse return;
    var dir = std.Io.Dir.openDirAbsolute(io, tokens_path, .{ .iterate = true }) catch return;
    defer dir.close(io);

    var names: [hook_id_cap][128]u8 = undefined;
    var lens: [hook_id_cap]usize = undefined;
    var tokens: [hook_id_cap][256]u8 = undefined;
    var token_lens: [hook_id_cap]usize = undefined;
    var claim_hooks: [hook_id_cap][128]u8 = undefined;
    var claim_hook_lens: [hook_id_cap]usize = undefined;
    var count: usize = 0;
    var it = dir.iterate();
    while (it.next(io) catch null) |entry| {
        if (!std.mem.endsWith(u8, entry.name, ".json")) continue;
        if (std.mem.endsWith(u8, entry.name, ".recovery.json")) continue;
        if (!isSafeName(entry.name)) continue;
        var file_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const file_path = std.fmt.bufPrint(&file_buf, "{s}/{s}", .{ tokens_path, entry.name }) catch continue;
        var contents_buf: [4096]u8 = undefined;
        const contents = readSmallFile(io, file_path, &contents_buf) orelse continue;
        if (std.mem.indexOf(u8, contents, session_id) == null) continue;
        if (count == names.len) break;
        if (entry.name.len > names[count].len) continue;
        @memcpy(names[count][0..entry.name.len], entry.name);
        lens[count] = entry.name.len;
        token_lens[count] = 0;
        claim_hook_lens[count] = 0;
        if (jsonStringField(contents, "token", tokens[count][0..])) |token| {
            token_lens[count] = token.len;
        }
        if (jsonStringField(contents, "hookId", claim_hooks[count][0..])) |hook_id| {
            claim_hook_lens[count] = hook_id.len;
        }
        count += 1;
    }

    for (0..count) |index| {
        if (token_lens[index] > 0) {
            const token = tokens[index][0..token_lens[index]];
            var digest: [world_key_len]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(token, &digest, .{});
            const hex = encodeHex(digest);
            var index_path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
            if (std.fmt.bufPrint(&index_path_buf, "{s}/hooks/token-index/{s}", .{ root, hex })) |index_path| {
                removeAbsolute(io, index_path);
            } else |_| {}
            if (claim_hook_lens[index] > 0) {
                deleteRecoveryMarker(io, root, token, session_id, claim_hooks[index][0..claim_hook_lens[index]]);
            }
            for (0..hooks.count) |hook_index| {
                deleteRecoveryMarker(io, root, token, session_id, hooks.get(hook_index));
            }
        }
        removeNamed(&dir, io, names[index][0..lens[index]]);
    }
}

fn deleteRecoveryMarker(
    io: std.Io,
    root: []const u8,
    token: []const u8,
    session_id: []const u8,
    hook_id: []const u8,
) void {
    if (!isSafeName(hook_id)) return;
    const hex = hashNulSeparated(&.{ token, session_id, hook_id });
    deleteExactFile(io, root, "hooks/tokens", &hex, ".recovery.json");
}

fn deleteHookResumes(io: std.Io, root: []const u8, session_id: []const u8) void {
    var resumes_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const resumes_path = joinUnder(&resumes_buf, root, "hooks/resumes") orelse return;
    var dir = std.Io.Dir.openDirAbsolute(io, resumes_path, .{ .iterate = true }) catch return;
    defer dir.close(io);

    var names: [hook_id_cap][128]u8 = undefined;
    var lens: [hook_id_cap]usize = undefined;
    var count: usize = 0;
    var it = dir.iterate();
    while (it.next(io) catch null) |entry| {
        if (!std.mem.endsWith(u8, entry.name, ".json")) continue;
        if (!isSafeName(entry.name)) continue;
        var file_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const file_path = std.fmt.bufPrint(&file_buf, "{s}/{s}", .{ resumes_path, entry.name }) catch continue;
        var contents_buf: [4096]u8 = undefined;
        const contents = readSmallFile(io, file_path, &contents_buf) orelse continue;
        if (std.mem.indexOf(u8, contents, session_id) == null) continue;
        if (count == names.len) break;
        if (entry.name.len > names[count].len) continue;
        @memcpy(names[count][0..entry.name.len], entry.name);
        lens[count] = entry.name.len;
        count += 1;
    }

    for (0..count) |index| {
        removeNamed(&dir, io, names[index][0..lens[index]]);
    }
}

fn hashNulSeparated(parts: []const []const u8) [world_key_hex_len]u8 {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    for (parts, 0..) |part, index| {
        if (index > 0) hasher.update("\x00");
        hasher.update(part);
    }
    var digest: [world_key_len]u8 = undefined;
    hasher.final(&digest);
    return encodeHex(digest);
}

fn containsId(ids: []const []const u8, id: []const u8) bool {
    for (ids) |item| {
        if (std.mem.eql(u8, item, id)) return true;
    }
    return false;
}

fn runFileIsYoung(io: std.Io, runs_path: []const u8, name: []const u8, grace_ms: i64) bool {
    if (grace_ms <= 0) return false;
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ runs_path, name }) catch return true;
    var file = std.Io.Dir.cwd().openFile(io, path, .{}) catch return true;
    defer file.close(io);
    const stat = file.stat(io) catch return true;
    const now_ms = std.Io.Clock.awake.now(io).toMilliseconds();
    const mtime_ms: i64 = @intCast(@divTrunc(stat.mtime.nanoseconds, 1_000_000));
    return now_ms - mtime_ms < grace_ms;
}

fn readSmallFile(io: std.Io, path: []const u8, buf: []u8) ?[]u8 {
    var file = std.Io.Dir.cwd().openFile(io, path, .{}) catch return null;
    defer file.close(io);
    var read_buffer: [512]u8 = undefined;
    var reader = file.reader(io, &read_buffer);
    var n: usize = 0;
    while (n < buf.len) {
        const got = reader.interface.readSliceShort(buf[n..]) catch {
            return if (n == 0) null else buf[0..n];
        };
        if (got == 0) break;
        n += got;
    }
    return buf[0..n];
}

fn jsonStringField(payload: []const u8, field: []const u8, out: []u8) ?[]const u8 {
    var key_buf: [64]u8 = undefined;
    const key = std.fmt.bufPrint(&key_buf, "\"{s}\"", .{field}) catch return null;
    var pos: usize = 0;
    while (std.mem.indexOfPos(u8, payload, pos, key)) |at| {
        var i = at + key.len;
        while (i < payload.len and std.ascii.isWhitespace(payload[i])) i += 1;
        if (i >= payload.len or payload[i] != ':') {
            pos = at + 1;
            continue;
        }
        i += 1;
        while (i < payload.len and std.ascii.isWhitespace(payload[i])) i += 1;
        if (i >= payload.len or payload[i] != '"') return null;
        i += 1;
        const start = i;
        while (i < payload.len) {
            if (payload[i] == '\\') {
                i += 2;
                continue;
            }
            if (payload[i] == '"') break;
            i += 1;
        }
        if (i >= payload.len) return null;
        const raw = payload[start..i];
        if (raw.len > out.len) return null;
        if (std.mem.indexOfScalar(u8, raw, '\\') != null) return null;
        @memcpy(out[0..raw.len], raw);
        return out[0..raw.len];
    }
    return null;
}

fn parseJsonStringArray(payload: []const u8, field: []const u8, dest: [][128]u8, lens: []usize) usize {
    var key_buf: [64]u8 = undefined;
    const key = std.fmt.bufPrint(&key_buf, "\"{s}\"", .{field}) catch return 0;
    const at = std.mem.indexOf(u8, payload, key) orelse return 0;
    var i = at + key.len;
    while (i < payload.len and std.ascii.isWhitespace(payload[i])) i += 1;
    if (i >= payload.len or payload[i] != ':') return 0;
    i += 1;
    while (i < payload.len and std.ascii.isWhitespace(payload[i])) i += 1;
    if (i >= payload.len or payload[i] != '[') return 0;
    i += 1;
    var count: usize = 0;
    while (i < payload.len and count < dest.len) {
        while (i < payload.len and (std.ascii.isWhitespace(payload[i]) or payload[i] == ',')) i += 1;
        if (i >= payload.len or payload[i] == ']') break;
        if (payload[i] != '"') break;
        i += 1;
        const start = i;
        while (i < payload.len) {
            if (payload[i] == '\\') {
                i += 2;
                continue;
            }
            if (payload[i] == '"') break;
            i += 1;
        }
        if (i >= payload.len) break;
        const raw = payload[start..i];
        i += 1;
        if (raw.len == 0 or raw.len > dest[count].len) continue;
        if (std.mem.indexOfScalar(u8, raw, '\\') != null) continue;
        @memcpy(dest[count][0..raw.len], raw);
        lens[count] = raw.len;
        count += 1;
    }
    return count;
}

pub fn writeStatusJson(output: []u8, kind: Kind, message: []const u8) ![]const u8 {
    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"status\":\"");
    try writer.writeAll(@tagName(kind));
    try writer.writeAll("\",\"host\":");
    if (kind == .ready) {
        try writer.writeAll("\"");
        try writer.writeAll(origin);
        try writer.writeAll("\"");
    } else {
        try writer.writeAll("null");
    }
    try writer.writeAll(",\"message\":");
    var scratch: [512]u8 = undefined;
    const quoted = native_sdk.bridge.writeJsonStringValue(&scratch, message);
    if (quoted.len == 0) return error.TooLarge;
    try writer.writeAll(quoted);
    try writer.writeByte('}');
    return writer.buffered();
}

pub fn agentResourceDir(exe_path: []const u8, buf: []u8) ?[]u8 {
    const macos_dir = std.fs.path.dirname(exe_path) orelse return null;
    if (!std.mem.eql(u8, std.fs.path.basename(macos_dir), macos_dir_name)) return null;
    const contents_dir = std.fs.path.dirname(macos_dir) orelse return null;
    return std.fmt.bufPrint(buf, "{s}/Resources/agent", .{contents_dir}) catch null;
}

pub fn bundledNodePath(exe_path: []const u8, buf: []u8) ?[]u8 {
    const macos_dir = std.fs.path.dirname(exe_path) orelse return null;
    if (!std.mem.eql(u8, std.fs.path.basename(macos_dir), macos_dir_name)) return null;
    const contents_dir = std.fs.path.dirname(macos_dir) orelse return null;
    return std.fmt.bufPrint(buf, "{s}/Resources/node/bin/node", .{contents_dir}) catch null;
}

pub fn nodeMajor(version: []const u8) ?u32 {
    var text = std.mem.trim(u8, version, " \t\r\n");
    if (text.len > 0 and (text[0] == 'v' or text[0] == 'V')) text = text[1..];
    const end = std.mem.indexOfScalar(u8, text, '.') orelse text.len;
    if (end == 0) return null;
    return std.fmt.parseInt(u32, text[0..end], 10) catch null;
}

fn nowMs(io: std.Io) i64 {
    return std.Io.Clock.awake.now(io).toMilliseconds();
}

fn builtinPosix() bool {
    return @import("builtin").os.tag != .windows and @import("builtin").os.tag != .wasi;
}

fn processGroupId(child: *const std.process.Child) i32 {
    if (!builtinPosix()) return 0;
    if (child.id) |id| return @intCast(id);
    return 0;
}

fn spawnPayload(buf: []u8, token: *const [agent_server.token_hex_len]u8, world_key: ?[]const u8) ?[]const u8 {
    if (world_key) |key| {
        return std.fmt.bufPrint(buf, "{s}\n{s}\n", .{ token, key }) catch null;
    }
    return std.fmt.bufPrint(buf, "{s}\n\n", .{token}) catch null;
}

fn dirExists(io: std.Io, path: []const u8) bool {
    var dir = std.Io.Dir.openDirAbsolute(io, path, .{}) catch return false;
    dir.close(io);
    return true;
}

fn fileExists(io: std.Io, path: []const u8) bool {
    std.Io.Dir.accessAbsolute(io, path, .{}) catch return false;
    return true;
}

pub const server_entry_rel = ".output/server/index.mjs";

pub fn productionServerEntry(cwd: []const u8, buf: []u8) ?[]u8 {
    return std.fmt.bufPrint(buf, "{s}/{s}", .{ cwd, server_entry_rel }) catch null;
}

pub const workflow_guard_rel = "agent/lib/workflow-guard-preload.ts";

/// Node loads this before the Chat server so the agent-server token guards
/// eve's `/.well-known/workflow/` routes as well as the Chat routes.
pub fn workflowGuardPreload(cwd: []const u8, buf: []u8) ?[]u8 {
    return std.fmt.bufPrint(buf, "{s}/{s}", .{ cwd, workflow_guard_rel }) catch null;
}

fn bundleComplete(io: std.Io, resource_dir: []const u8) bool {
    var output_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const output_dir = std.fmt.bufPrint(&output_buf, "{s}/.output", .{resource_dir}) catch return false;
    var modules_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const modules_dir = std.fmt.bufPrint(&modules_buf, "{s}/node_modules", .{resource_dir}) catch return false;
    var agent_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const agent_dir = std.fmt.bufPrint(&agent_buf, "{s}/agent", .{resource_dir}) catch return false;
    var pkg_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const pkg = std.fmt.bufPrint(&pkg_buf, "{s}/package.json", .{resource_dir}) catch return false;
    var eve_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const eve_bin = std.fmt.bufPrint(&eve_buf, "{s}/node_modules/.bin/eve", .{resource_dir}) catch return false;
    var server_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const server_entry = productionServerEntry(resource_dir, &server_buf) orelse return false;
    var guard_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const guard = workflowGuardPreload(resource_dir, &guard_buf) orelse return false;
    return dirExists(io, output_dir) and dirExists(io, modules_dir) and dirExists(io, agent_dir) and
        fileExists(io, pkg) and fileExists(io, eve_bin) and fileExists(io, server_entry) and
        fileExists(io, guard);
}

fn portIsFree(io: std.Io, listen_port: u16) bool {
    const addr = std.Io.net.IpAddress.parseIp4(host, listen_port) catch return false;
    var listener = std.Io.net.IpAddress.listen(&addr, io, .{ .reuse_address = true }) catch return false;
    listener.deinit(io);
    return true;
}

fn linkBundle(io: std.Io, resource_dir: []const u8, cwd: []const u8) !void {
    try relink(io, resource_dir, cwd, ".output", true);
    try relink(io, resource_dir, cwd, "node_modules", true);
    try relink(io, resource_dir, cwd, "agent", true);
    // eve's project discovery treats a symlink package.json as "other", not a
    // file, and then refuses to start. Copy the real file into the cwd.
    try copyNamedFile(io, resource_dir, cwd, "package.json");
}

fn copyNamedFile(io: std.Io, resource_dir: []const u8, cwd: []const u8, name: []const u8) !void {
    var dest_dir = try std.Io.Dir.openDirAbsolute(io, cwd, .{});
    defer dest_dir.close(io);
    dest_dir.deleteFile(io, name) catch {};
    var source_dir = try std.Io.Dir.openDirAbsolute(io, resource_dir, .{});
    defer source_dir.close(io);
    try std.Io.Dir.copyFile(source_dir, name, dest_dir, name, io, .{ .replace = true });
}

fn relink(
    io: std.Io,
    resource_dir: []const u8,
    cwd: []const u8,
    name: []const u8,
    is_directory: bool,
) !void {
    var target_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const target = try std.fmt.bufPrint(&target_buf, "{s}/{s}", .{ resource_dir, name });
    var dir = try std.Io.Dir.openDirAbsolute(io, cwd, .{});
    defer dir.close(io);
    dir.deleteFile(io, name) catch {};
    try dir.symLink(io, target, name, .{ .is_directory = is_directory });
}

fn nodePathSupported(allocator: std.mem.Allocator, io: std.Io, path: []const u8) bool {
    if (!fileExists(io, path)) return false;
    const output = captureCommand(allocator, io, &.{ path, "-v" }) catch return false;
    defer allocator.free(output);
    const major = nodeMajor(output) orelse return false;
    return major == node_major_required;
}

fn captureCommand(allocator: std.mem.Allocator, io: std.Io, argv: []const []const u8) ![]u8 {
    const result = try std.process.run(allocator, io, .{
        .argv = argv,
        .stderr_limit = .limited(4096),
        .stdout_limit = .limited(4096),
    });
    defer allocator.free(result.stderr);
    switch (result.term) {
        .exited => |code| if (code != 0) {
            allocator.free(result.stdout);
            return error.CommandFailed;
        },
        else => {
            allocator.free(result.stdout);
            return error.CommandFailed;
        },
    }
    return result.stdout;
}

test "productionServerEntry joins the built Chat server path" {
    var buf: [256]u8 = undefined;
    const path = productionServerEntry("/tmp/eve", &buf).?;
    try std.testing.expectEqualStrings("/tmp/eve/.output/server/index.mjs", path);
}

test "workflowGuardPreload joins the guard path under the agent directory" {
    var buf: [256]u8 = undefined;
    const path = workflowGuardPreload("/tmp/eve", &buf).?;
    try std.testing.expectEqualStrings("/tmp/eve/agent/lib/workflow-guard-preload.ts", path);
}

test "agentResourceDir maps a Mac bundle executable" {
    var buf: [256]u8 = undefined;
    const path = agentResourceDir("/tmp/Sage.app/Contents/MacOS/Sage", &buf).?;
    try std.testing.expectEqualStrings("/tmp/Sage.app/Contents/Resources/agent", path);
}

test "agentResourceDir ignores unpackaged binaries" {
    var buf: [256]u8 = undefined;
    try std.testing.expect(agentResourceDir("/tmp/zig-out/bin/Sage", &buf) == null);
}

test "bundledNodePath maps a Mac bundle executable" {
    var buf: [256]u8 = undefined;
    const path = bundledNodePath("/tmp/Sage.app/Contents/MacOS/Sage", &buf).?;
    try std.testing.expectEqualStrings("/tmp/Sage.app/Contents/Resources/node/bin/node", path);
}

test "bundledNodePath ignores unpackaged binaries" {
    var buf: [256]u8 = undefined;
    try std.testing.expect(bundledNodePath("/tmp/zig-out/bin/Sage", &buf) == null);
}

test "nodeMajor parses v24 tags" {
    try std.testing.expectEqual(@as(u32, 24), nodeMajor("v24.14.0\n").?);
    try std.testing.expectEqual(@as(u32, 22), nodeMajor("v22.0.0").?);
    try std.testing.expect(nodeMajor("") == null);
}

test "nodePathSupported rejects a missing binary" {
    try std.testing.expect(!nodePathSupported(std.testing.allocator, std.testing.io, "/tmp/missing-node-bin"));
}

test "canRetry waits ten seconds" {
    try std.testing.expect(!canRetry(1_000, 10_999));
    try std.testing.expect(canRetry(1_000, 11_000));
    try std.testing.expect(canRetry(0, retry_interval_ms));
}

test "fillChatChildEnv pins Ollama and drops secrets" {
    var parent = std.process.Environ.Map.init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("HOME", "/Users/sage");
    try parent.put("LANG", "en_US.UTF-8");
    try parent.put("PATH", "/usr/bin");
    try parent.put("OLLAMA_BASE_URL", "https://evil.example/api");
    try parent.put("OLLAMA_API_KEY", "secret");
    try parent.put("OLLAMA_MODEL", "remote-model");
    try parent.put("OLLAMA_CONTEXT_WINDOW", "999999");
    try parent.put("NODE_OPTIONS", "--inspect");
    try parent.put("DYLD_INSERT_LIBRARIES", "/tmp/libevil.dylib");
    try parent.put(world_key_env, "ab" ** 32);

    var child_env = std.process.Environ.Map.init(std.testing.allocator);
    defer child_env.deinit();
    try fillChatChildEnv(&child_env, &parent, "/app/node/bin:/usr/bin", "/tmp/sage-sock");

    try std.testing.expectEqualStrings("/Users/sage", child_env.get("HOME").?);
    try std.testing.expectEqualStrings("en_US.UTF-8", child_env.get("LANG").?);
    try std.testing.expectEqualStrings("/app/node/bin:/usr/bin", child_env.get("PATH").?);
    try std.testing.expectEqualStrings("http://127.0.0.1:11434/api", child_env.get("OLLAMA_BASE_URL").?);
    try std.testing.expectEqualStrings("1", child_env.get("EVE_TELEMETRY_DISABLED").?);
    try std.testing.expectEqualStrings("/tmp/sage-sock", child_env.get(agent_server.socket_env).?);
    try std.testing.expectEqualStrings(host, child_env.get("HOST").?);
    try std.testing.expectEqualStrings(host, child_env.get("NITRO_HOST").?);
    try std.testing.expectEqualStrings(port_text, child_env.get("NITRO_PORT").?);
    try std.testing.expectEqualStrings(port_text, child_env.get("PORT").?);
    try std.testing.expect(child_env.get("OLLAMA_API_KEY") == null);
    try std.testing.expect(child_env.get("OLLAMA_MODEL") == null);
    try std.testing.expect(child_env.get("OLLAMA_CONTEXT_WINDOW") == null);
    try std.testing.expect(child_env.get("NODE_OPTIONS") == null);
    try std.testing.expect(child_env.get("DYLD_INSERT_LIBRARIES") == null);
    try std.testing.expect(child_env.get(world_key_env) == null);
    try std.testing.expect(child_env.get("USER") == null);
}

test "spawnPayload writes token then world key" {
    const token = "a" ** agent_server.token_hex_len;
    const key = "b" ** world_key_hex_len;
    var buf: [agent_server.token_hex_len + world_key_hex_len + 4]u8 = undefined;
    const with_key = spawnPayload(&buf, token, key).?;
    try std.testing.expectEqualStrings(token ++ "\n" ++ key ++ "\n", with_key);
    const without_key = spawnPayload(&buf, token, null).?;
    try std.testing.expectEqualStrings(token ++ "\n\n", without_key);
}

test "writeStatusJson includes host only when ready" {
    var buf: [256]u8 = undefined;
    const ready = try writeStatusJson(&buf, .ready, "");
    try std.testing.expectEqualStrings(
        "{\"status\":\"ready\",\"host\":\"http://127.0.0.1:2001\",\"message\":\"\"}",
        ready,
    );
    const missing = try writeStatusJson(&buf, .missing_node, missing_node_message);
    try std.testing.expectEqualStrings(
        "{\"status\":\"missing_node\",\"host\":null,\"message\":\"This copy of Sage is incomplete.\"}",
        missing,
    );
}

test "deriveWorldKey is deterministic and not the data key" {
    var data_key: [world_key_len]u8 = undefined;
    for (&data_key, 0..) |*byte, i| byte.* = @intCast(i);
    const first = deriveWorldKey(&data_key);
    const second = deriveWorldKey(&data_key);
    try std.testing.expectEqualSlices(u8, &first, &second);
    try std.testing.expect(!std.mem.eql(u8, &first, &data_key));
    try std.testing.expectEqualStrings(
        "482300727ce9d88b5b843689c6c4b4f02519225f7b4a20fe066ce8bfc96cc823",
        &encodeHex(first),
    );
}

test "stop overwrites the derived world key" {
    var sidecar: Sidecar = .{};
    const data_key: [world_key_len]u8 = @splat(0x42);
    sidecar.setWorldKeyFromDataKey(&data_key);

    var stored_hex: *[world_key_hex_len]u8 = undefined;
    if (sidecar.world_key_hex) |*hex| stored_hex = hex;
    sidecar.stop();

    try std.testing.expect(sidecar.world_key_hex == null);
    const zero_hex = [_]u8{0} ** world_key_hex_len;
    try std.testing.expectEqualSlices(u8, &zero_hex, stored_hex);
}

test "wipeWorkflowData removes nested files and ignores a missing tree" {
    const io = std.testing.io;
    var tmp_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const tmp = try std.fmt.bufPrint(
        &tmp_buf,
        "/tmp/sage-eve-wipe-{d}",
        .{std.Io.Clock.awake.now(io).toMilliseconds()},
    );
    var nested_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const nested = try std.fmt.bufPrint(&nested_buf, "{s}/eve/.eve/.workflow-data/events", .{tmp});
    try std.Io.Dir.cwd().createDirPath(io, nested);
    var file_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const file_path = try std.fmt.bufPrint(&file_buf, "{s}/secret.json", .{nested});
    var file = try std.Io.Dir.createFileAbsolute(io, file_path, .{});
    try file.writeStreamingAll(io, "plaintext-session");
    file.close(io);
    wipeWorkflowData(io, tmp);
    try std.testing.expectError(error.FileNotFound, std.Io.Dir.accessAbsolute(io, nested, .{}));
    wipeWorkflowData(io, tmp);
    var tmp_parent = try std.Io.Dir.openDirAbsolute(io, "/tmp", .{});
    defer tmp_parent.close(io);
    tmp_parent.deleteTree(io, std.fs.path.basename(tmp)) catch {};
}

test "wipeWorkflowDirectoryStrict removes a development agent store" {
    const io = std.testing.io;
    var tmp_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const tmp = try std.fmt.bufPrint(
        &tmp_buf,
        "/tmp/sage-eve-dev-wipe-{d}",
        .{std.Io.Clock.awake.now(io).toMilliseconds()},
    );
    var nested_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const nested = try std.fmt.bufPrint(&nested_buf, "{s}/.eve/.workflow-data/events", .{tmp});
    try std.Io.Dir.cwd().createDirPath(io, nested);
    var file_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const file_path = try std.fmt.bufPrint(&file_buf, "{s}/secret.json", .{nested});
    var file = try std.Io.Dir.createFileAbsolute(io, file_path, .{});
    try file.writeStreamingAll(io, "memory-bearing-session");
    file.close(io);

    var workflow_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const workflow = try std.fmt.bufPrint(&workflow_buf, "{s}/.eve/.workflow-data", .{tmp});
    try wipeWorkflowDirectoryStrict(io, workflow);
    try std.testing.expectError(error.FileNotFound, std.Io.Dir.accessAbsolute(io, workflow, .{}));
    var tmp_parent = try std.Io.Dir.openDirAbsolute(io, "/tmp", .{});
    defer tmp_parent.close(io);
    tmp_parent.deleteTree(io, std.fs.path.basename(tmp)) catch {};
}

test "cancelRequestHeader sends the bearer token" {
    const session_id = "wrun_01AAAAAAAAAAAAAAAAAAAAAAAA";
    const token = "ab" ** 32;
    var buf: [cancel_header_max]u8 = undefined;
    const header = cancelRequestHeader(&buf, session_id, token).?;
    try std.testing.expect(std.mem.indexOf(u8, header, "Authorization: Bearer " ++ token) != null);
    try std.testing.expect(std.mem.startsWith(u8, header, "POST /eve/v1/session/" ++ session_id ++ "/cancel "));
    try std.testing.expect(std.mem.endsWith(u8, header, "\r\n\r\n"));
    try std.testing.expect(cancelRequestHeader(&buf, session_id, "") == null);
}

test "isValidSessionId accepts workflow run ids only" {
    try std.testing.expect(isValidSessionId("wrun_01AAAAAAAAAAAAAAAAAAAAAAAA"));
    try std.testing.expect(isValidSessionId("wrun_01abcdefghjkmnpqrstvwxyzab"));
    try std.testing.expect(!isValidSessionId(""));
    try std.testing.expect(!isValidSessionId("sess-1"));
    try std.testing.expect(!isValidSessionId("wrun_"));
    try std.testing.expect(!isValidSessionId("wrun_01AAAAAAAAAAAAAAAAAAAAAAA"));
    try std.testing.expect(!isValidSessionId("wrun_01AAAAAAAAAAAAAAAAAAAAAAAAA"));
    try std.testing.expect(!isValidSessionId("wrun_01AAAAAAAAAAAAAAAAAAAAAAAI"));
    try std.testing.expect(!isValidSessionId("../wrun_01AAAAAAAAAAAAAAAAAAAAAAAA"));
    try std.testing.expect(!isValidSessionId("wrun_/../secret"));
    try std.testing.expect(!isValidSessionId("wrun_01AAAAAA/AAAAAAAAAAAAAAA"));
}

test "deleteSessionData removes one run and leaves the other" {
    const io = std.testing.io;
    const gone = "wrun_01AAAAAAAAAAAAAAAAAAAAAAAA";
    const keep = "wrun_01BBBBBBBBBBBBBBBBBBBBBBBB";
    const gone_live_hook = "hook_01AAAAAAAAAAAAAAAAAAAAAAAA";
    const gone_disposed_hook = "hook_01CCCCCCCCCCCCCCCCCCCCCCCC";
    const keep_live_hook = "hook_01BBBBBBBBBBBBBBBBBBBBBBBB";
    const keep_disposed_hook = "hook_01DDDDDDDDDDDDDDDDDDDDDDDD";
    const gone_token = gone ++ ":turn-control:1";
    const keep_token = keep ++ ":turn-control:1";
    const gone_disposed_token = gone ++ ":turn-control:0";
    const keep_disposed_token = keep ++ ":turn-control:0";
    const gone_extra = "strm_01ZZZZZZZZZZZZZZZZZZZZZZZZ";
    const keep_extra = "strm_01YYYYYYYYYYYYYYYYYYYYYYYY";

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var data_dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const data_dir = try testTmpAbs(io, &tmp, &data_dir_buf);
    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_buf, "{s}/eve/.eve/.workflow-data", .{data_dir});

    try testWriteLiveRunTree(io, root, gone, gone_live_hook, gone_token, "strm_01AAAAAAAAAAAAAAAAAAAAAAAA_user", gone_extra);
    try testWriteDisposedHookFiles(io, root, gone, gone_disposed_hook, gone_disposed_token);
    try testWriteLiveRunTree(io, root, keep, keep_live_hook, keep_token, "strm_01BBBBBBBBBBBBBBBBBBBBBBBB_user", keep_extra);
    try testWriteDisposedHookFiles(io, root, keep, keep_disposed_hook, keep_disposed_token);

    var canary_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const canary = try std.fmt.bufPrint(&canary_buf, "{s}/eve/.eve/canary.txt", .{data_dir});
    try testWriteAbs(io, canary, "keep-me");

    deleteSessionData(io, data_dir, gone);

    try expectAbsMissing(io, root, "runs/" ++ gone ++ ".json");
    try expectAbsMissing(io, root, "steps/" ++ gone ++ "-step_01AAAAAAAAAAAAAAAAAAAAAAAA.json");
    try expectAbsMissing(io, root, "events/" ++ gone ++ "-evnt_00000000000000000000000001.json");
    try expectAbsMissing(io, root, "waits/" ++ gone ++ "-wait_01AAAAAAAAAAAAAAAAAAAAAAAA.json");
    try expectAbsMissing(io, root, "streams/runs/" ++ gone ++ ".json");
    try expectAbsMissing(io, root, "streams/chunks/strm_01AAAAAAAAAAAAAAAAAAAAAAAA_user");
    try expectAbsMissing(io, root, "streams/chunks/" ++ gone_extra);
    try expectAbsMissing(io, root, "hooks/by-run/" ++ gone ++ "-" ++ gone_live_hook ++ ".json");
    try expectAbsMissing(io, root, "hooks/" ++ gone_live_hook ++ ".json");
    try expectAbsMissing(io, root, "hooks/id-index/" ++ gone_live_hook);
    try expectAbsMissing(io, root, "hooks/id-index/" ++ gone_disposed_hook);
    try expectTokenPath(io, root, "hooks/tokens/", gone_token, ".json", false);
    try expectRecoveryPath(io, root, gone_token, gone, gone_live_hook, false);
    try expectTokenIndexEntry(io, root, gone_token, false);
    try expectTokenIndexEntry(io, root, gone_disposed_token, false);
    try expectResumePath(io, root, gone, false);
    try expectAbsMissing(io, root, "hooks/" ++ gone_disposed_hook ++ ".json");
    try expectAbsMissing(io, root, ".locks/hooks/" ++ gone_disposed_hook ++ ".disposed");
    try expectAbsMissing(io, root, ".locks/runs/" ++ gone ++ ".pending");
    try expectAbsMissing(io, root, ".locks/runs/" ++ gone ++ ".terminal");
    try expectAbsMissing(io, root, ".locks/attributes/" ++ gone ++ "-attr.created");

    try expectAbsExists(io, root, "runs/" ++ keep ++ ".json");
    try expectAbsExists(io, root, "steps/" ++ keep ++ "-step_01BBBBBBBBBBBBBBBBBBBBBBBB.json");
    try expectAbsExists(io, root, "events/" ++ keep ++ "-evnt_00000000000000000000000001.json");
    try expectAbsExists(io, root, "waits/" ++ keep ++ "-wait_01BBBBBBBBBBBBBBBBBBBBBBBB.json");
    try expectAbsExists(io, root, "streams/runs/" ++ keep ++ ".json");
    try expectAbsExists(io, root, "streams/chunks/strm_01BBBBBBBBBBBBBBBBBBBBBBBB_user/chunk");
    try expectAbsExists(io, root, "streams/chunks/" ++ keep_extra ++ "/chunk");
    try expectAbsExists(io, root, "hooks/by-run/" ++ keep ++ "-" ++ keep_live_hook ++ ".json");
    try expectAbsExists(io, root, "hooks/" ++ keep_live_hook ++ ".json");
    try expectAbsExists(io, root, "hooks/id-index/" ++ keep_live_hook ++ "/evnt.json");
    try expectAbsExists(io, root, "hooks/id-index/" ++ keep_disposed_hook ++ "/evnt.json");
    try expectTokenPath(io, root, "hooks/tokens/", keep_token, ".json", true);
    try expectRecoveryPath(io, root, keep_token, keep, keep_live_hook, true);
    try expectTokenIndexEntry(io, root, keep_token, true);
    try expectTokenIndexEntry(io, root, keep_disposed_token, true);
    try expectResumePath(io, root, keep, true);
    try expectAbsExists(io, root, ".locks/hooks/" ++ keep_disposed_hook ++ ".disposed");
    try expectAbsExists(io, root, ".locks/runs/" ++ keep ++ ".pending/.keep");
    try expectAbsExists(io, root, ".locks/runs/" ++ keep ++ ".terminal");
    try expectAbsExists(io, root, ".locks/attributes/" ++ keep ++ "-attr.created");
    try std.testing.expect(testAbsExists(io, canary));
}

test "deleteSessionData ignores a missing tree and rejects a malicious id" {
    const io = std.testing.io;
    const gone = "wrun_01AAAAAAAAAAAAAAAAAAAAAAAA";

    deleteSessionData(io, "/tmp/sage-eve-missing-session-data", gone);

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var data_dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const data_dir = try testTmpAbs(io, &tmp, &data_dir_buf);
    var canary_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const canary = try std.fmt.bufPrint(&canary_buf, "{s}/eve/.eve/canary.txt", .{data_dir});
    try testWriteAbs(io, canary, "keep-me");
    var secret_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const secret = try std.fmt.bufPrint(&secret_buf, "{s}/secret.txt", .{data_dir});
    try testWriteAbs(io, secret, "nope");

    deleteSessionData(io, data_dir, "../x");
    deleteSessionData(io, data_dir, "wrun_/../secret.txt");
    deleteSessionData(io, data_dir, "wrun_..");
    deleteSessionData(io, data_dir, gone);

    try std.testing.expect(testAbsExists(io, canary));
    try std.testing.expect(testAbsExists(io, secret));
}

test "sweepOrphanedSessions deletes old unreferenced runs" {
    const io = std.testing.io;
    const gone = "wrun_01AAAAAAAAAAAAAAAAAAAAAAAA";
    const keep = "wrun_01BBBBBBBBBBBBBBBBBBBBBBBB";
    const gone_hook = "hook_01AAAAAAAAAAAAAAAAAAAAAAAA";
    const keep_hook = "hook_01BBBBBBBBBBBBBBBBBBBBBBBB";

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var data_dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const data_dir = try testTmpAbs(io, &tmp, &data_dir_buf);
    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_buf, "{s}/eve/.eve/.workflow-data", .{data_dir});

    try testWriteDisposedRunTree(io, root, gone, gone_hook, gone ++ ":turn-control:0", "strm_01AAAAAAAAAAAAAAAAAAAAAAAA_user");
    try testWriteDisposedRunTree(io, root, keep, keep_hook, keep ++ ":turn-control:0", "strm_01BBBBBBBBBBBBBBBBBBBBBBBB_user");

    const keep_ids = [_][]const u8{keep};
    sweepOrphanedSessionsGrace(io, data_dir, &keep_ids, 0);

    try expectAbsMissing(io, root, "runs/" ++ gone ++ ".json");
    try expectAbsMissing(io, root, "hooks/id-index/" ++ gone_hook);
    try expectAbsExists(io, root, "runs/" ++ keep ++ ".json");
    try expectAbsExists(io, root, "hooks/id-index/" ++ keep_hook ++ "/evnt.json");
}

test "sweepOrphanedSessions keeps a young unreferenced run" {
    const io = std.testing.io;
    const gone = "wrun_01AAAAAAAAAAAAAAAAAAAAAAAA";
    const gone_hook = "hook_01AAAAAAAAAAAAAAAAAAAAAAAA";

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var data_dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const data_dir = try testTmpAbs(io, &tmp, &data_dir_buf);
    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_buf, "{s}/eve/.eve/.workflow-data", .{data_dir});

    try testWriteDisposedRunTree(io, root, gone, gone_hook, gone ++ ":turn-control:0", "strm_01AAAAAAAAAAAAAAAAAAAAAAAA_user");

    sweepOrphanedSessions(io, data_dir, &.{});

    try expectAbsExists(io, root, "runs/" ++ gone ++ ".json");
    try expectAbsExists(io, root, "hooks/id-index/" ++ gone_hook ++ "/evnt.json");
}

test "sweepOrphanedSessions ignores a missing tree" {
    sweepOrphanedSessions(std.testing.io, "/tmp/sage-eve-missing-orphan-sweep", &.{});
    sweepOrphanedSessionsGrace(std.testing.io, "/tmp/sage-eve-missing-orphan-sweep", &.{}, 0);
}

fn testTmpAbs(io: std.Io, tmp: *std.testing.TmpDir, buf: []u8) ![]const u8 {
    try tmp.dir.writeFile(io, .{ .sub_path = ".keep", .data = "" });
    const keep_len = try tmp.dir.realPathFile(io, ".keep", buf);
    return std.fs.path.dirname(buf[0..keep_len]) orelse error.InvalidPath;
}

fn testAbsExists(io: std.Io, path: []const u8) bool {
    std.Io.Dir.accessAbsolute(io, path, .{}) catch return false;
    return true;
}

fn expectAbsMissing(io: std.Io, root: []const u8, rel: []const u8) !void {
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ root, rel });
    try std.testing.expect(!testAbsExists(io, path));
}

fn expectAbsExists(io: std.Io, root: []const u8, rel: []const u8) !void {
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ root, rel });
    try std.testing.expect(testAbsExists(io, path));
}

fn expectTokenPath(
    io: std.Io,
    root: []const u8,
    prefix: []const u8,
    token: []const u8,
    suffix: []const u8,
    exists: bool,
) !void {
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const hex = tokenFileName(token);
    const path = try std.fmt.bufPrint(&path_buf, "{s}/{s}{s}{s}", .{ root, prefix, hex, suffix });
    try std.testing.expectEqual(exists, testAbsExists(io, path));
}

fn expectTokenIndexEntry(io: std.Io, root: []const u8, token: []const u8, exists: bool) !void {
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const hex = tokenFileName(token);
    const path = try std.fmt.bufPrint(&path_buf, "{s}/hooks/token-index/{s}/evnt.json", .{ root, hex });
    try std.testing.expectEqual(exists, testAbsExists(io, path));
}

fn expectRecoveryPath(
    io: std.Io,
    root: []const u8,
    token: []const u8,
    session_id: []const u8,
    hook_id: []const u8,
    exists: bool,
) !void {
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const hex = hashNulSeparated(&.{ token, session_id, hook_id });
    const path = try std.fmt.bufPrint(&path_buf, "{s}/hooks/tokens/{s}.recovery.json", .{ root, hex });
    try std.testing.expectEqual(exists, testAbsExists(io, path));
}

fn expectResumePath(io: std.Io, root: []const u8, session_id: []const u8, exists: bool) !void {
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const hex = hashNulSeparated(&.{ session_id, "resume-1" });
    const path = try std.fmt.bufPrint(&path_buf, "{s}/hooks/resumes/{s}.json", .{ root, hex });
    try std.testing.expectEqual(exists, testAbsExists(io, path));
}

fn testWriteAbs(io: std.Io, path: []const u8, contents: []const u8) !void {
    if (std.fs.path.dirname(path)) |dir_path| {
        try std.Io.Dir.cwd().createDirPath(io, dir_path);
    }
    var file = try std.Io.Dir.createFileAbsolute(io, path, .{});
    defer file.close(io);
    try file.writeStreamingAll(io, contents);
}

fn tokenFileName(token: []const u8) [world_key_hex_len]u8 {
    var digest: [world_key_len]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(token, &digest, .{});
    return encodeHex(digest);
}

fn testWriteSharedRunFiles(
    io: std.Io,
    root: []const u8,
    session_id: []const u8,
    stream_name: []const u8,
    extra_stream: ?[]const u8,
) !void {
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const run_path = try std.fmt.bufPrint(&path_buf, "{s}/runs/{s}.json", .{ root, session_id });
    try testWriteAbs(io, run_path, "{\"runId\":\"x\"}");

    const step_path = try std.fmt.bufPrint(&path_buf, "{s}/steps/{s}-step_{s}.json", .{ root, session_id, session_id[session_id_prefix.len..] });
    try testWriteAbs(io, step_path, "{}");

    const event_path = try std.fmt.bufPrint(&path_buf, "{s}/events/{s}-evnt_00000000000000000000000001.json", .{ root, session_id });
    try testWriteAbs(io, event_path, "{}");

    const wait_path = try std.fmt.bufPrint(&path_buf, "{s}/waits/{s}-wait_{s}.json", .{ root, session_id, session_id[session_id_prefix.len..] });
    try testWriteAbs(io, wait_path, "{}");

    const stream_index = try std.fmt.bufPrint(&path_buf, "{s}/streams/runs/{s}.json", .{ root, session_id });
    var stream_json_buf: [256]u8 = undefined;
    const stream_json = if (extra_stream) |extra|
        try std.fmt.bufPrint(&stream_json_buf, "{{\"streams\":[\"{s}\",\"{s}\"]}}", .{ stream_name, extra })
    else
        try std.fmt.bufPrint(&stream_json_buf, "{{\"streams\":[\"{s}\"]}}", .{stream_name});
    try testWriteAbs(io, stream_index, stream_json);

    const chunk_path = try std.fmt.bufPrint(&path_buf, "{s}/streams/chunks/{s}/chunk", .{ root, stream_name });
    try testWriteAbs(io, chunk_path, "chunk");
    if (extra_stream) |extra| {
        const extra_path = try std.fmt.bufPrint(&path_buf, "{s}/streams/chunks/{s}/chunk", .{ root, extra });
        try testWriteAbs(io, extra_path, "chunk");
    }

    const lock_dir = try std.fmt.bufPrint(&path_buf, "{s}/.locks/runs/{s}.pending/.keep", .{ root, session_id });
    try testWriteAbs(io, lock_dir, "");

    const lock_file = try std.fmt.bufPrint(&path_buf, "{s}/.locks/runs/{s}.terminal", .{ root, session_id });
    try testWriteAbs(io, lock_file, "");

    const attr_lock = try std.fmt.bufPrint(&path_buf, "{s}/.locks/attributes/{s}-attr.created", .{ root, session_id });
    try testWriteAbs(io, attr_lock, "");
}

fn testWriteLiveHookFiles(
    io: std.Io,
    root: []const u8,
    session_id: []const u8,
    hook_id: []const u8,
    token: []const u8,
) !void {
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const by_run_path = try std.fmt.bufPrint(&path_buf, "{s}/hooks/by-run/{s}-{s}.json", .{ root, session_id, hook_id });
    var hook_json_buf: [96]u8 = undefined;
    const hook_json = try std.fmt.bufPrint(&hook_json_buf, "{{\"hookId\":\"{s}\"}}", .{hook_id});
    try testWriteAbs(io, by_run_path, hook_json);

    const hook_file = try std.fmt.bufPrint(&path_buf, "{s}/hooks/{s}.json", .{ root, hook_id });
    try testWriteAbs(io, hook_file, hook_json);

    try testWriteIndexEntry(io, root, "hooks/id-index", hook_id, session_id);

    const hex = tokenFileName(token);
    const token_file = try std.fmt.bufPrint(&path_buf, "{s}/hooks/tokens/{s}.json", .{ root, hex });
    var token_json_buf: [256]u8 = undefined;
    const token_json = try std.fmt.bufPrint(
        &token_json_buf,
        "{{\"token\":\"{s}\",\"runId\":\"{s}\",\"hookId\":\"{s}\"}}",
        .{ token, session_id, hook_id },
    );
    try testWriteAbs(io, token_file, token_json);

    try testWriteIndexEntry(io, root, "hooks/token-index", &hex, session_id);

    const recovery_hex = hashNulSeparated(&.{ token, session_id, hook_id });
    const recovery_file = try std.fmt.bufPrint(&path_buf, "{s}/hooks/tokens/{s}.recovery.json", .{ root, recovery_hex });
    try testWriteAbs(io, recovery_file, "{\"eventId\":\"evnt_1\"}");
}

fn testWriteDisposedHookFiles(
    io: std.Io,
    root: []const u8,
    session_id: []const u8,
    hook_id: []const u8,
    token: []const u8,
) !void {
    try testWriteIndexEntry(io, root, "hooks/id-index", hook_id, session_id);
    try testWriteIndexEntry(io, root, "hooks/token-index", &tokenFileName(token), session_id);

    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dispose_lock = try std.fmt.bufPrint(&path_buf, "{s}/.locks/hooks/{s}.disposed", .{ root, hook_id });
    try testWriteAbs(io, dispose_lock, "");

    const resume_hex = hashNulSeparated(&.{ session_id, "resume-1" });
    const resume_file = try std.fmt.bufPrint(&path_buf, "{s}/hooks/resumes/{s}.json", .{ root, resume_hex });
    var resume_json_buf: [128]u8 = undefined;
    const resume_json = try std.fmt.bufPrint(&resume_json_buf, "{{\"runId\":\"{s}\",\"resumeId\":\"resume-1\"}}", .{session_id});
    try testWriteAbs(io, resume_file, resume_json);
}

fn testWriteIndexEntry(
    io: std.Io,
    root: []const u8,
    rel_dir: []const u8,
    key: []const u8,
    session_id: []const u8,
) !void {
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buf, "{s}/{s}/{s}/evnt.json", .{ root, rel_dir, key });
    var json_buf: [80]u8 = undefined;
    const json = try std.fmt.bufPrint(&json_buf, "{{\"runId\":\"{s}\"}}", .{session_id});
    try testWriteAbs(io, path, json);
}

fn testWriteLiveRunTree(
    io: std.Io,
    root: []const u8,
    session_id: []const u8,
    hook_id: []const u8,
    token: []const u8,
    stream_name: []const u8,
    extra_stream: []const u8,
) !void {
    try testWriteSharedRunFiles(io, root, session_id, stream_name, extra_stream);
    try testWriteLiveHookFiles(io, root, session_id, hook_id, token);
}

fn testWriteDisposedRunTree(
    io: std.Io,
    root: []const u8,
    session_id: []const u8,
    hook_id: []const u8,
    token: []const u8,
    stream_name: []const u8,
) !void {
    try testWriteSharedRunFiles(io, root, session_id, stream_name, null);
    try testWriteDisposedHookFiles(io, root, session_id, hook_id, token);
}
