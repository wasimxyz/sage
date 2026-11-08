const std = @import("std");
const builtin = @import("builtin");
const ollama = @import("ollama.zig");
const eve_sidecar = @import("eve_sidecar.zig");

/// The bundled server, relative to the app's `Contents` folder. Packaging
/// copies the Ollama tree to `Resources/ollama/` and keeps this layout.
pub const bundled_rel_path = "Resources/ollama/ollama";
/// Dev builds take the binary path from this variable. `make dev` sets it.
pub const dev_binary_env = "SAGE_OLLAMA_PATH";
/// Folder under the data directory that holds the log and the pid file.
pub const state_dir_name = "ollama";
pub const log_name = "serve.log";
pub const pid_name = "serve.pid";
/// Once the log grows past this, `ensureRunning` cuts it back to empty.
pub const log_cap_bytes: u64 = 1024 * 1024;
/// How much of the end of the log is read to find its last line.
const log_tail_bytes = 4096;
/// Same wait as Chat between restarts of a child that exited.
pub const retry_interval_ms: i64 = 10_000;
const stop_wait_ms: i64 = 3_000;
const leftover_wait_ms: i64 = 1_000;
const poll_ms: i64 = 50;
/// `exec` hands the shell's process id to the server, so the pid file names
/// the server itself. `>>` opens the log in append mode, so the parent can cut
/// the log back while the server keeps writing to it.
const serve_script = "exec \"$0\" serve >>\"$1\" 2>&1";
/// libproc's PROC_PIDPATHINFO_MAXSIZE.
const pid_path_max = 4096;

pub const Kind = enum {
    /// Not running, and the last start did not fail for a known reason.
    down,
    /// The bundled binary is not in this copy of Sage.
    missing,
    /// Something else holds the port, and it is not an old Sage server.
    port_busy,
    /// The child process is running.
    ready,
};

extern "c" fn proc_pidpath(pid: c_int, buffer: [*]u8, buffersize: u32) c_int;

/// `<Contents>/Resources/ollama/ollama` for a binary inside an app bundle,
/// the same way `bundledNodePath` finds Node. Unpackaged binaries get null.
pub fn bundledOllamaPath(exe_path: []const u8, buf: []u8) ?[]u8 {
    const macos_dir = std.fs.path.dirname(exe_path) orelse return null;
    if (!std.mem.eql(u8, std.fs.path.basename(macos_dir), "MacOS")) return null;
    const contents_dir = std.fs.path.dirname(macos_dir) orelse return null;
    return std.fmt.bufPrint(buf, "{s}/{s}", .{ contents_dir, bundled_rel_path }) catch null;
}

/// Whether Sage runs from inside an app bundle (`Contents/MacOS/<exe>`). The
/// mode follows where the executable sits, the way Chat and Node are found:
/// a bundled app runs its own Ollama on the packaged port, and every other
/// launch (`native dev`, `make eval`, `make seed-dev`, `zig build run`) runs
/// the binary named by `SAGE_OLLAMA_PATH` on the dev port.
pub fn runsFromBundle(io: std.Io) bool {
    var exe_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const exe_len = std.process.executablePath(io, &exe_buf) catch return false;
    return isBundleExecutable(exe_buf[0..exe_len]);
}

pub fn isBundleExecutable(exe_path: []const u8) bool {
    var buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    return bundledOllamaPath(exe_path, &buf) != null;
}

/// The dev binary path from `SAGE_OLLAMA_PATH`. Only an absolute path counts.
pub fn resolveDevBinary(env_value: ?[]const u8) ?[]const u8 {
    const value = env_value orelse return null;
    if (value.len == 0 or !std.fs.path.isAbsolute(value)) return null;
    return value;
}

/// Build the environment for `ollama serve`. It starts from the Chat allowlist
/// and then sets the server's own values. Only `OLLAMA_MODELS` is copied from
/// Sage's environment. Every other `OLLAMA_*` variable stays out.
pub fn fillServeEnv(
    child_env: *std.process.Environ.Map,
    parent: *const std.process.Environ.Map,
    port: u16,
) !void {
    for (eve_sidecar.chat_env_allowlist) |key| {
        if (parent.get(key)) |value| try child_env.put(key, value);
    }
    try child_env.put("PATH", "/usr/bin:/bin");
    var host_buf: [32]u8 = undefined;
    const host_value = try std.fmt.bufPrint(&host_buf, "{s}:{d}", .{ ollama.host, port });
    try child_env.put("OLLAMA_HOST", host_value);
    try child_env.put("OLLAMA_NO_CLOUD", "1");
    try child_env.put("OLLAMA_NOPRUNE", "1");
    if (parent.get("OLLAMA_MODELS")) |value| try child_env.put("OLLAMA_MODELS", value);
}

/// A leftover server is ours only when its executable is the binary Sage
/// would start. A reused process id running something else must not match.
pub fn pidPathMatches(process_path: []const u8, binary_path: []const u8) bool {
    if (process_path.len == 0 or binary_path.len == 0) return false;
    return std.mem.eql(u8, process_path, binary_path);
}

/// The last line with text in `text`, without its line break or spaces.
pub fn lastNonEmptyLine(text: []const u8) []const u8 {
    var end = text.len;
    while (end > 0) {
        var start = end;
        while (start > 0 and text[start - 1] != '\n') start -= 1;
        const line = std.mem.trim(u8, text[start..end], " \t\r");
        if (line.len > 0) return line;
        if (start == 0) break;
        end = start - 1;
    }
    return "";
}

pub fn logNeedsTrim(size: u64) bool {
    return size > log_cap_bytes;
}

pub fn canRetry(last_attempt_ms: i64, now_ms: i64) bool {
    return now_ms - last_attempt_ms >= retry_interval_ms;
}

/// Owns the bundled `ollama serve` child: starts it, keeps it running, and
/// stops it on quit. Worker threads call in, so every method that changes
/// state takes `mutex`. `io` is passed in because a test can build a server
/// without ever starting it.
pub const Server = struct {
    mutex: std.Io.Mutex = .init,
    kind: Kind = .down,
    /// Set by `stop`. A worker that raced with quit must not start a new child.
    stopped: bool = false,
    allocator: std.mem.Allocator = undefined,
    env_map: ?*const std.process.Environ.Map = null,
    port: u16 = 0,
    /// The binary to run, or empty when this copy has none.
    binary: []const u8 = &.{},
    log_path: []const u8 = &.{},
    pid_path: []const u8 = &.{},
    /// The child's process id. It is also the process group id, because the
    /// child starts its own group. Zero when no child is running.
    pid: i32 = 0,
    last_attempt_ms: i64 = 0,

    /// Find the binary, clear any old server from a previous run, and start
    /// the child. Does not wait for the server to answer. Runs even while
    /// Sage is locked, so the server is up before unlock.
    pub fn start(
        self: *Server,
        allocator: std.mem.Allocator,
        io: std.Io,
        data_dir: []const u8,
        env_map: *const std.process.Environ.Map,
        bundled: bool,
    ) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.allocator = allocator;
        self.env_map = env_map;
        self.port = ollama.port;
        self.stopped = false;
        self.binary = resolveBinary(io, allocator, env_map, bundled) orelse &.{};
        if (data_dir.len > 0) {
            const state_dir = std.fmt.allocPrint(allocator, "{s}/{s}", .{ data_dir, state_dir_name }) catch "";
            if (state_dir.len > 0) {
                std.Io.Dir.cwd().createDirPath(io, state_dir) catch {};
                self.log_path = std.fmt.allocPrint(allocator, "{s}/{s}", .{ state_dir, log_name }) catch &.{};
                self.pid_path = std.fmt.allocPrint(allocator, "{s}/{s}", .{ state_dir, pid_name }) catch &.{};
            }
        }
        self.attempt(io);
    }

    /// Restart the child if it exited, at most once per `retry_interval_ms`.
    /// Also cuts the log back when it is too large. The status poll calls this,
    /// so a crashed server comes back without a restart of Sage.
    pub fn ensureRunning(self: *Server, io: std.Io) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        if (self.stopped) return;
        if (self.kind == .ready) {
            if (self.pid > 0 and !self.childExited()) {
                trimLog(io, self.log_path);
                return;
            }
            self.pid = 0;
            self.kind = .down;
        }
        if (!canRetry(self.last_attempt_ms, nowMs(io))) return;
        self.attempt(io);
    }

    /// Stop the child on quit: SIGTERM to its group, up to `stop_wait_ms` to
    /// exit, then SIGKILL. Later calls do nothing, and no new child starts.
    pub fn stop(self: *Server, io: std.Io) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.stopped = true;
        if (self.pid > 0) {
            const pid = self.pid;
            signalServer(pid, .TERM);
            var waited: i64 = 0;
            while (waited < stop_wait_ms and !self.childExited()) : (waited += poll_ms) {
                std.Io.sleep(io, .fromMilliseconds(poll_ms), .awake) catch break;
            }
            if (self.pid > 0) {
                signalServer(pid, .KILL);
                var status: c_int = 0;
                _ = std.posix.system.waitpid(pid, &status, 0);
                self.pid = 0;
            }
        }
        if (self.pid_path.len > 0) std.Io.Dir.deleteFileAbsolute(io, self.pid_path) catch {};
        self.kind = .down;
    }

    /// The state as of now. Callers hold no lock afterwards.
    pub fn currentKind(self: *Server, io: std.Io) Kind {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        return self.kind;
    }

    /// Whether the binary is on disk and can run. The binary path is fixed at
    /// start, so this does not take the lock.
    pub fn binaryPresent(self: *const Server, io: std.Io) bool {
        if (self.binary.len == 0) return false;
        return fileExists(io, self.binary);
    }

    /// The last line the server wrote, copied into `buf`. Empty when there is
    /// no log yet. Reads the end of the file, so it works while the child runs.
    pub fn lastLogLine(self: *const Server, io: std.Io, buf: []u8) []const u8 {
        if (self.log_path.len == 0) return buf[0..0];
        return readLastLine(io, self.log_path, buf);
    }

    /// Spawn the child. Caller holds the mutex.
    fn attempt(self: *Server, io: std.Io) void {
        self.last_attempt_ms = nowMs(io);
        if (self.binary.len == 0 or !fileExists(io, self.binary)) {
            self.kind = .missing;
            return;
        }
        if (self.log_path.len == 0 or self.env_map == null) {
            self.kind = .down;
            return;
        }
        // A fresh log for each start. Output from an earlier run goes with it.
        createEmptyFile(io, self.log_path) catch {
            self.kind = .down;
            return;
        };
        self.stopLeftover(io);
        if (!eve_sidecar.portIsFree(io, self.port)) {
            self.kind = .port_busy;
            return;
        }
        var env = std.process.Environ.Map.init(self.allocator);
        defer env.deinit();
        fillServeEnv(&env, self.env_map.?, self.port) catch {
            self.kind = .down;
            return;
        };
        const argv = [_][]const u8{ "/bin/sh", "-c", serve_script, self.binary, self.log_path };
        const child = std.process.spawn(io, .{
            .argv = &argv,
            .environ_map = &env,
            .stdin = .ignore,
            .stdout = .ignore,
            .stderr = .ignore,
            .pgid = 0,
        }) catch {
            self.kind = .down;
            return;
        };
        const pid = child.id orelse {
            self.kind = .down;
            return;
        };
        self.pid = pid;
        if (self.pid_path.len > 0) writePidFile(io, self.pid_path, pid) catch {};
        self.kind = .ready;
    }

    /// Stop a server a previous Sage left running. It is killed only when its
    /// pid file names a live process whose executable is our binary. Caller
    /// holds the mutex.
    fn stopLeftover(self: *Server, io: std.Io) void {
        if (self.pid_path.len == 0) return;
        const pid = readPidFile(io, self.allocator, self.pid_path) orelse return;
        std.Io.Dir.deleteFileAbsolute(io, self.pid_path) catch {};
        if (pid <= 0 or !processAlive(pid)) return;
        var buf: [pid_path_max]u8 = undefined;
        const path = processExecutablePath(pid, &buf) orelse return;
        if (!pidPathMatches(path, self.binary)) return;
        signalServer(pid, .TERM);
        var waited: i64 = 0;
        while (waited < leftover_wait_ms and processAlive(pid)) : (waited += poll_ms) {
            std.Io.sleep(io, .fromMilliseconds(poll_ms), .awake) catch break;
        }
        if (processAlive(pid)) signalServer(pid, .KILL);
    }

    /// Reap the child if it exited. Returns true when there is no child left.
    /// Caller holds the mutex.
    fn childExited(self: *Server) bool {
        if (self.pid <= 0) return true;
        var status: c_int = 0;
        while (true) {
            const r = std.posix.system.waitpid(self.pid, &status, std.c.W.NOHANG);
            switch (std.posix.errno(r)) {
                .SUCCESS => if (r == 0) return false,
                .INTR => continue,
                .CHILD => {},
                else => return false,
            }
            break;
        }
        self.pid = 0;
        return true;
    }
};

fn resolveBinary(
    io: std.Io,
    allocator: std.mem.Allocator,
    env_map: *const std.process.Environ.Map,
    bundled: bool,
) ?[]const u8 {
    // A bundled app runs only its own copy and never reads `SAGE_OLLAMA_PATH`.
    if (!bundled) {
        const dev_path = resolveDevBinary(env_map.get(dev_binary_env)) orelse return null;
        return allocator.dupe(u8, dev_path) catch null;
    }
    var exe_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const exe_len = std.process.executablePath(io, &exe_buf) catch return null;
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const own_binary = bundledOllamaPath(exe_buf[0..exe_len], &path_buf) orelse return null;
    return allocator.dupe(u8, own_binary) catch null;
}

/// Signal the child's group. A group that is already gone falls back to the pid.
fn signalServer(pid: i32, sig: std.posix.SIG) void {
    std.posix.kill(-pid, sig) catch {
        std.posix.kill(pid, sig) catch {};
    };
}

fn processAlive(pid: i32) bool {
    std.posix.kill(pid, @enumFromInt(0)) catch |err| return err == error.PermissionDenied;
    return true;
}

fn processExecutablePath(pid: i32, buf: []u8) ?[]const u8 {
    if (builtin.os.tag != .macos) return null;
    const len = proc_pidpath(pid, buf.ptr, @intCast(buf.len));
    if (len <= 0) return null;
    return buf[0..@intCast(len)];
}

fn readPidFile(io: std.Io, allocator: std.mem.Allocator, path: []const u8) ?i32 {
    const text = std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(64)) catch return null;
    defer allocator.free(text);
    return std.fmt.parseInt(i32, std.mem.trim(u8, text, " \t\r\n"), 10) catch null;
}

fn writePidFile(io: std.Io, path: []const u8, pid: i32) !void {
    var buf: [16]u8 = undefined;
    const text = try std.fmt.bufPrint(&buf, "{d}\n", .{pid});
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = text });
}

fn createEmptyFile(io: std.Io, path: []const u8) !void {
    const file = try std.Io.Dir.createFileAbsolute(io, path, .{ .truncate = true });
    file.close(io);
}

/// Cut the log back to empty once it passes the cap. The server appends, so
/// it keeps writing at the new end of the file.
fn trimLog(io: std.Io, path: []const u8) void {
    if (path.len == 0) return;
    var file = std.Io.Dir.cwd().openFile(io, path, .{ .mode = .write_only }) catch return;
    defer file.close(io);
    const stat = file.stat(io) catch return;
    if (!logNeedsTrim(stat.size)) return;
    file.setLength(io, 0) catch {};
}

fn readLastLine(io: std.Io, path: []const u8, out: []u8) []const u8 {
    var file = std.Io.Dir.cwd().openFile(io, path, .{}) catch return out[0..0];
    defer file.close(io);
    const stat = file.stat(io) catch return out[0..0];
    const start: u64 = if (stat.size > log_tail_bytes) stat.size - log_tail_bytes else 0;
    var tail: [log_tail_bytes]u8 = undefined;
    const len: usize = @intCast(stat.size - start);
    const read = file.readPositionalAll(io, tail[0..len], start) catch return out[0..0];
    const line = lastNonEmptyLine(tail[0..read]);
    const copied = @min(line.len, out.len);
    @memcpy(out[0..copied], line[0..copied]);
    return out[0..copied];
}

fn fileExists(io: std.Io, path: []const u8) bool {
    std.Io.Dir.cwd().access(io, path, .{ .execute = true }) catch return false;
    return true;
}

fn nowMs(io: std.Io) i64 {
    return std.Io.Clock.awake.now(io).toMilliseconds();
}

test "bundledOllamaPath maps a Mac bundle executable" {
    var buf: [256]u8 = undefined;
    const path = bundledOllamaPath("/tmp/Sage.app/Contents/MacOS/Sage", &buf).?;
    try std.testing.expectEqualStrings("/tmp/Sage.app/Contents/Resources/ollama/ollama", path);
}

test "bundledOllamaPath ignores unpackaged binaries" {
    var buf: [256]u8 = undefined;
    try std.testing.expect(bundledOllamaPath("/tmp/zig-out/bin/Sage", &buf) == null);
}

test "resolveDevBinary takes only a non-empty absolute path" {
    try std.testing.expect(resolveDevBinary(null) == null);
    try std.testing.expect(resolveDevBinary("") == null);
    try std.testing.expect(resolveDevBinary("third_party/ollama/ollama") == null);
    try std.testing.expectEqualStrings(
        "/Users/sage/third_party/ollama/ollama",
        resolveDevBinary("/Users/sage/third_party/ollama/ollama").?,
    );
}

test "fillServeEnv pins loopback, turns cloud off, and turns pruning off" {
    var parent = std.process.Environ.Map.init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("HOME", "/Users/sage");
    try parent.put("TMPDIR", "/tmp/sage");
    try parent.put("PATH", "/opt/homebrew/bin");
    try parent.put("OLLAMA_API_KEY", "secret");
    try parent.put("OLLAMA_HOST", "0.0.0.0:9");
    try parent.put("OLLAMA_NO_CLOUD", "0");
    try parent.put("OLLAMA_KEEP_ALIVE", "-1");
    try parent.put("OLLAMA_DEBUG", "1");
    try parent.put("OLLAMA_MODELS", "/Volumes/models");
    try parent.put("NODE_OPTIONS", "--inspect");

    var child = std.process.Environ.Map.init(std.testing.allocator);
    defer child.deinit();
    try fillServeEnv(&child, &parent, 11435);

    try std.testing.expectEqualStrings("/Users/sage", child.get("HOME").?);
    try std.testing.expectEqualStrings("/tmp/sage", child.get("TMPDIR").?);
    try std.testing.expectEqualStrings("/usr/bin:/bin", child.get("PATH").?);
    try std.testing.expectEqualStrings("127.0.0.1:11435", child.get("OLLAMA_HOST").?);
    try std.testing.expectEqualStrings("1", child.get("OLLAMA_NO_CLOUD").?);
    try std.testing.expectEqualStrings("1", child.get("OLLAMA_NOPRUNE").?);
    try std.testing.expectEqualStrings("/Volumes/models", child.get("OLLAMA_MODELS").?);
    try std.testing.expect(child.get("NODE_OPTIONS") == null);
    try std.testing.expect(child.get("OLLAMA_API_KEY") == null);
    try std.testing.expect(child.get("OLLAMA_KEEP_ALIVE") == null);
    try std.testing.expect(child.get("OLLAMA_DEBUG") == null);

    var ollama_keys: usize = 0;
    var it = child.iterator();
    while (it.next()) |entry| {
        if (std.mem.startsWith(u8, entry.key_ptr.*, "OLLAMA_")) ollama_keys += 1;
    }
    try std.testing.expectEqual(@as(usize, 4), ollama_keys);
}

test "fillServeEnv leaves OLLAMA_MODELS unset when the parent has none" {
    var parent = std.process.Environ.Map.init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("OLLAMA_HOST", "0.0.0.0:9");

    var child = std.process.Environ.Map.init(std.testing.allocator);
    defer child.deinit();
    try fillServeEnv(&child, &parent, 11436);
    try std.testing.expect(child.get("OLLAMA_MODELS") == null);
    try std.testing.expectEqualStrings("127.0.0.1:11436", child.get("OLLAMA_HOST").?);
}

test "pidPathMatches needs the exact binary path" {
    try std.testing.expect(pidPathMatches("/A.app/Contents/Resources/ollama/ollama", "/A.app/Contents/Resources/ollama/ollama"));
    try std.testing.expect(!pidPathMatches("/usr/bin/vim", "/A.app/Contents/Resources/ollama/ollama"));
    try std.testing.expect(!pidPathMatches("", ""));
    try std.testing.expect(!pidPathMatches("/A.app/Contents/Resources/ollama/ollama", ""));
}

test "lastNonEmptyLine skips trailing blank lines" {
    try std.testing.expectEqualStrings("second", lastNonEmptyLine("first\nsecond\n\n"));
    try std.testing.expectEqualStrings("only", lastNonEmptyLine("only"));
    try std.testing.expectEqualStrings("", lastNonEmptyLine("  \n\r\n"));
    try std.testing.expectEqualStrings("", lastNonEmptyLine(""));
}

test "logNeedsTrim starts at one megabyte" {
    try std.testing.expect(!logNeedsTrim(1024 * 1024));
    try std.testing.expect(logNeedsTrim(1024 * 1024 + 1));
}

test "canRetry waits ten seconds" {
    try std.testing.expect(!canRetry(1_000, 10_999));
    try std.testing.expect(canRetry(1_000, 11_000));
}

test "a server with no binary reports missing and starts nothing" {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    var server: Server = .{};
    server.start(std.testing.allocator, std.testing.io, "", &env, false);
    try std.testing.expectEqual(Kind.missing, server.currentKind(std.testing.io));
    try std.testing.expect(!server.binaryPresent(std.testing.io));
    server.ensureRunning(std.testing.io);
    try std.testing.expectEqual(Kind.missing, server.currentKind(std.testing.io));
    server.stop(std.testing.io);
    try std.testing.expectEqual(Kind.down, server.currentKind(std.testing.io));
}

/// A port nothing listens on: bind port 0, read the port the system chose, and
/// close the socket. Tests use it so they never touch 11434, 11435, or 11436.
fn freeTestPort(io: std.Io) !u16 {
    const bind = try std.Io.net.IpAddress.parseIp4(ollama.host, 0);
    var listener = try std.Io.net.IpAddress.listen(&bind, io, .{ .reuse_address = true });
    defer listener.deinit(io);
    return listener.socket.address.getPort();
}

/// A temporary directory with its resolved path. `proc_pidpath` reports
/// resolved paths, so a test that compares them must use this one.
const ScratchDir = struct {
    tmp: std.testing.TmpDir,
    buf: [std.Io.Dir.max_path_bytes]u8 = undefined,
    len: usize = 0,

    fn init(self: *ScratchDir, io: std.Io) !void {
        self.tmp = std.testing.tmpDir(.{});
        errdefer self.tmp.cleanup();
        self.len = try self.tmp.dir.realPath(io, &self.buf);
    }

    fn deinit(self: *ScratchDir) void {
        self.tmp.cleanup();
    }

    fn path(self: *const ScratchDir) []const u8 {
        return self.buf[0..self.len];
    }
};

/// Write `data` to `<dir>/<name>` as an executable file and return its path.
fn writeExecutable(
    io: std.Io,
    dir: *ScratchDir,
    name: []const u8,
    data: []const u8,
    out: []u8,
) ![]const u8 {
    try dir.tmp.dir.writeFile(io, .{ .sub_path = name, .data = data });
    const full = try std.fmt.bufPrint(out, "{s}/{s}", .{ dir.path(), name });
    var z_buf: [std.Io.Dir.max_path_bytes:0]u8 = undefined;
    const full_z = try std.fmt.bufPrintZ(&z_buf, "{s}", .{full});
    try std.testing.expectEqual(@as(c_int, 0), std.c.chmod(full_z, 0o755));
    return full;
}

const fake_server_script =
    "#!/bin/sh\n" ++
    "echo 'time=now msg=\"Ollama cloud disabled: true\"' >&2\n" ++
    "exec /bin/sleep 30\n";

// Starts a stand-in for `ollama serve` (a script that logs once and then
// sleeps), checks the log and the state, and stops it. The port is one the
// system hands out, so a real Ollama never interferes.
test "server starts a child, logs its output, and stops it" {
    const io = std.testing.io;
    var scratch: ScratchDir = undefined;
    try scratch.init(io);
    defer scratch.deinit();
    const dir = scratch.path();

    var bin_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const bin = try writeExecutable(io, &scratch, "fake-ollama", fake_server_script, &bin_buf);

    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put(dev_binary_env, bin);

    const saved_port = ollama.port;
    ollama.port = try freeTestPort(io);
    defer ollama.port = saved_port;

    var server: Server = .{};
    server.start(std.heap.page_allocator, io, dir, &env, false);
    defer server.stop(io);
    try std.testing.expectEqual(Kind.ready, server.currentKind(io));
    try std.testing.expect(server.binaryPresent(io));

    var line_buf: [256]u8 = undefined;
    var line: []const u8 = "";
    var tries: usize = 0;
    while (tries < 60) : (tries += 1) {
        line = server.lastLogLine(io, &line_buf);
        if (line.len > 0) break;
        try std.Io.sleep(io, .fromMilliseconds(50), .awake);
    }
    try std.testing.expectEqualStrings("time=now msg=\"Ollama cloud disabled: true\"", line);

    const pid_file = try std.fmt.allocPrint(std.testing.allocator, "{s}/ollama/serve.pid", .{dir});
    defer std.testing.allocator.free(pid_file);
    std.Io.Dir.accessAbsolute(io, pid_file, .{}) catch return error.TestUnexpectedResult;

    server.stop(io);
    try std.testing.expectEqual(Kind.down, server.currentKind(io));
    try std.testing.expectError(error.FileNotFound, std.Io.Dir.accessAbsolute(io, pid_file, .{}));
}

/// Start `<binary> 30` in the background, detached from the test, and write
/// its pid to `pid_file`. A server that a crashed Sage left behind has no
/// parent either, so `launchd` reaps it once it exits.
fn spawnOrphan(io: std.Io, binary: []const u8, pid_file: []const u8) !i32 {
    var child = try std.process.spawn(io, .{
        .argv = &.{ "/bin/sh", "-c", "\"$0\" 30 </dev/null >/dev/null 2>&1 & echo $! >\"$1\"", binary, pid_file },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    });
    const term = try child.wait(io);
    try std.testing.expect(term == .exited and term.exited == 0);
    return readPidFile(io, std.testing.allocator, pid_file) orelse error.TestUnexpectedResult;
}

/// Wait until `pid` runs `binary`. Returns false if it never does.
fn waitForExecutable(io: std.Io, pid: i32, binary: []const u8) !bool {
    var tries: usize = 0;
    while (tries < 60) : (tries += 1) {
        var buf: [pid_path_max]u8 = undefined;
        if (processExecutablePath(pid, &buf)) |running| {
            if (std.mem.eql(u8, running, binary)) return true;
        }
        try std.Io.sleep(io, .fromMilliseconds(50), .awake);
    }
    return false;
}

fn waitForExit(pid: i32, io: std.Io) !bool {
    var tries: usize = 0;
    while (tries < 60) : (tries += 1) {
        if (!processAlive(pid)) return true;
        try std.Io.sleep(io, .fromMilliseconds(50), .awake);
    }
    return false;
}

/// Build a program that sleeps for 30 seconds, ignoring its arguments, at
/// `<dir>/<name>`. A script will not do: `proc_pidpath` names the interpreter
/// of a script, and a copy of a system binary such as `/bin/sleep` is killed at
/// launch. The compiler comes with the command line tools that build Sage.
fn buildSleeper(io: std.Io, dir: *ScratchDir, name: []const u8, out: []u8) ![]const u8 {
    try dir.tmp.dir.writeFile(io, .{
        .sub_path = "sleeper.c",
        .data = "#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n",
    });
    const full = try std.fmt.bufPrint(out, "{s}/{s}", .{ dir.path(), name });
    var src_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const src = try std.fmt.bufPrint(&src_buf, "{s}/sleeper.c", .{dir.path()});
    var cc = std.process.spawn(io, .{
        .argv = &.{ "/usr/bin/cc", "-o", full, src },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    }) catch return error.SkipZigTest;
    const term = cc.wait(io) catch return error.SkipZigTest;
    if (term != .exited or term.exited != 0) return error.SkipZigTest;
    return full;
}

// The leftover runs the exact binary Sage is told to start, so
// `proc_pidpath` reports the path that `pidPathMatches` compares.
test "start stops a leftover server when serve.pid names a process running our binary" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;
    const io = std.testing.io;
    var scratch: ScratchDir = undefined;
    try scratch.init(io);
    defer scratch.deinit();
    const dir = scratch.path();

    var bin_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const bin = try buildSleeper(io, &scratch, "fake-ollama", &bin_buf);

    try scratch.tmp.dir.createDirPath(io, state_dir_name);
    var pid_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const pid_file = try std.fmt.bufPrint(&pid_buf, "{s}/{s}/{s}", .{ dir, state_dir_name, pid_name });
    const leftover = try spawnOrphan(io, bin, pid_file);
    defer if (processAlive(leftover)) signalServer(leftover, .KILL);

    // The test means nothing unless the leftover is alive and runs the binary.
    // The shell forks before it execs the binary, so the path can read
    // `/bin/sh` for a moment.
    try std.testing.expect(try waitForExecutable(io, leftover, bin));

    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put(dev_binary_env, bin);
    const saved_port = ollama.port;
    ollama.port = try freeTestPort(io);
    defer ollama.port = saved_port;

    var server: Server = .{};
    server.start(std.heap.page_allocator, io, dir, &env, false);
    defer server.stop(io);

    try std.testing.expect(try waitForExit(leftover, io));
    try std.testing.expectEqual(Kind.ready, server.currentKind(io));
    // The pid file now names the new server, not the one that was stopped.
    const current = readPidFile(io, std.testing.allocator, pid_file) orelse return error.TestUnexpectedResult;
    try std.testing.expect(current != leftover);
}

test "start leaves alone a process in serve.pid that does not run our binary" {
    const io = std.testing.io;
    var scratch: ScratchDir = undefined;
    try scratch.init(io);
    defer scratch.deinit();
    const dir = scratch.path();

    var bin_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const bin = try writeExecutable(io, &scratch, "fake-ollama", fake_server_script, &bin_buf);

    // A pid file can name any process once the id has been reused.
    var other = try std.process.spawn(io, .{
        .argv = &.{ "/bin/sleep", "30" },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    });
    defer other.kill(io);
    const other_pid = other.id orelse return error.TestUnexpectedResult;

    try scratch.tmp.dir.createDirPath(io, state_dir_name);
    var pid_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const pid_file = try std.fmt.bufPrint(&pid_buf, "{s}/{s}/{s}", .{ dir, state_dir_name, pid_name });
    try writePidFile(io, pid_file, other_pid);

    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put(dev_binary_env, bin);
    const saved_port = ollama.port;
    ollama.port = try freeTestPort(io);
    defer ollama.port = saved_port;

    var server: Server = .{};
    server.start(std.heap.page_allocator, io, dir, &env, false);
    defer server.stop(io);

    try std.testing.expectEqual(Kind.ready, server.currentKind(io));
    // `waitpid` with no hang returns 0 while the process is still running.
    var status: c_int = 0;
    try std.testing.expectEqual(@as(c_int, 0), std.posix.system.waitpid(other_pid, &status, std.c.W.NOHANG));
    const current = readPidFile(io, std.testing.allocator, pid_file) orelse return error.TestUnexpectedResult;
    try std.testing.expect(current != other_pid);
}

test "start with bundled set never reads SAGE_OLLAMA_PATH" {
    const io = std.testing.io;
    var scratch: ScratchDir = undefined;
    try scratch.init(io);
    defer scratch.deinit();

    var bin_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const bin = try writeExecutable(io, &scratch, "fake-ollama", fake_server_script, &bin_buf);
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put(dev_binary_env, bin);

    // The test binary does not sit in `Contents/MacOS`, so a bundled start
    // finds no Ollama of its own and must not fall back to the dev path.
    var server: Server = .{};
    server.start(std.heap.page_allocator, io, "", &env, true);
    defer server.stop(io);
    try std.testing.expectEqual(Kind.missing, server.currentKind(io));
    try std.testing.expect(!server.binaryPresent(io));
}

test "isBundleExecutable follows where the executable sits" {
    try std.testing.expect(isBundleExecutable("/Applications/Sage.app/Contents/MacOS/Sage"));
    try std.testing.expect(!isBundleExecutable("/Users/sage/Projects/sage/zig-out/bin/Sage"));
    try std.testing.expect(!isBundleExecutable("/Users/sage/Projects/sage/zig-out/eval/bin/Sage"));
    try std.testing.expect(!isBundleExecutable("Sage"));
}
