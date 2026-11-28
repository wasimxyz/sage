//! The test runner for the app tests. It is Zig 0.16's default runner
//! (`lib/compiler/test_runner.zig`) without fuzzing, plus one change: when
//! `SAGE_TEST_SHARD` is `i/n`, it lists and runs only the tests whose index
//! modulo n is i. `build.zig` starts n copies of the test binary at once, one
//! per shard, so the tests run in n processes. Copy the default runner again
//! when you bump Zig.
const builtin = @import("builtin");

const std = @import("std");
const Io = std.Io;
const testing = std.testing;
const panic = std.debug.panic;

comptime {
    if (builtin.fuzz) @compileError("Sage's test runner does not fuzz. Use Zig's default runner.");
}

pub const std_options: std.Options = .{
    .logFn = log,
};

/// The variable `build.zig` sets on each shard's run, as `i/n`.
pub const shard_env = "SAGE_TEST_SHARD";

var log_err_count: usize = 0;
var fba: std.heap.FixedBufferAllocator = .init(&fba_buffer);
var fba_buffer: [8192]u8 = undefined;
var stdin_buffer: [4096]u8 = undefined;
var stdout_buffer: [4096]u8 = undefined;
var stdin_reader: Io.File.Reader = undefined;
var stdout_writer: Io.File.Writer = undefined;
const runner_threaded_io: Io = Io.Threaded.global_single_threaded.io();

const Shard = struct { index: u32, count: u32 };

/// Reads `i/n`. A bad value stops the run, so a typo never skips tests.
fn parseShard(text: []const u8) Shard {
    const slash = std.mem.indexOfScalar(u8, text, '/') orelse
        panic("{s} must be i/n, got \"{s}\"", .{ shard_env, text });
    const index = std.fmt.parseUnsigned(u32, text[0..slash], 10) catch
        panic("{s} must be i/n, got \"{s}\"", .{ shard_env, text });
    const count = std.fmt.parseUnsigned(u32, text[slash + 1 ..], 10) catch
        panic("{s} must be i/n, got \"{s}\"", .{ shard_env, text });
    if (count == 0 or index >= count)
        panic("{s} must be i/n with i < n, got \"{s}\"", .{ shard_env, text });
    return .{ .index = index, .count = count };
}

/// Every nth test, starting at this shard's index. Neighbouring tests often
/// share a slow setup, so this spreads the slow ones across the shards.
/// Returns indexes into `builtin.test_functions`. The list lives as long as
/// the process.
fn selectTests(environ: std.process.Environ) []const u32 {
    const shard = parseShard(environ.getPosix(shard_env) orelse "0/1");
    const selected = std.heap.page_allocator.alloc(u32, builtin.test_functions.len) catch
        @panic("out of memory listing the tests");
    var len: usize = 0;
    for (0..builtin.test_functions.len) |i| {
        if (i % shard.count != shard.index) continue;
        selected[len] = @intCast(i);
        len += 1;
    }
    return selected[0..len];
}

pub fn main(init: std.process.Init.Minimal) void {
    @disableInstrumentation();

    const args = init.args.toSlice(fba.allocator()) catch |err| panic("unable to parse command line args: {t}", .{err});

    var listen = false;

    for (args[1..]) |arg| {
        if (std.mem.eql(u8, arg, "--listen=-")) {
            listen = true;
        } else if (std.mem.startsWith(u8, arg, "--seed=")) {
            testing.random_seed = std.fmt.parseUnsigned(u32, arg["--seed=".len..], 0) catch
                @panic("unable to parse --seed command line argument");
        } else if (std.mem.startsWith(u8, arg, "--cache-dir")) {
            // Only fuzzing reads the cache dir.
        } else {
            panic("unrecognized command line argument: {s}", .{arg});
        }
    }

    const selected = selectTests(init.environ);
    if (listen) {
        return mainServer(init, selected) catch |err| panic("internal test runner failure: {t}", .{err});
    } else {
        return mainTerminal(init, selected);
    }
}

fn mainServer(init: std.process.Init.Minimal, selected: []const u32) !void {
    @disableInstrumentation();
    stdin_reader = .initStreaming(.stdin(), runner_threaded_io, &stdin_buffer);
    stdout_writer = .initStreaming(.stdout(), runner_threaded_io, &stdout_buffer);
    var server = try std.zig.Server.init(.{
        .in = &stdin_reader.interface,
        .out = &stdout_writer.interface,
        .zig_version = builtin.zig_version_string,
    });

    while (true) {
        const hdr = try server.receiveMessage();
        switch (hdr.tag) {
            .exit => {
                return std.process.exit(0);
            },
            .query_test_metadata => {
                testing.allocator_instance = .{};
                defer if (testing.allocator_instance.deinit() == .leak) {
                    @panic("internal test runner memory leak");
                };

                var string_bytes: std.ArrayList(u8) = .empty;
                defer string_bytes.deinit(testing.allocator);
                try string_bytes.append(testing.allocator, 0); // Reserve 0 for null.

                // The build runner numbers tests by their place in this list,
                // so `run_test` below maps its index back through `selected`.
                const names = try testing.allocator.alloc(u32, selected.len);
                defer testing.allocator.free(names);
                const expected_panic_msgs = try testing.allocator.alloc(u32, selected.len);
                defer testing.allocator.free(expected_panic_msgs);

                for (selected, names, expected_panic_msgs) |test_index, *name, *expected_panic_msg| {
                    const test_fn = builtin.test_functions[test_index];
                    name.* = @intCast(string_bytes.items.len);
                    try string_bytes.ensureUnusedCapacity(testing.allocator, test_fn.name.len + 1);
                    string_bytes.appendSliceAssumeCapacity(test_fn.name);
                    string_bytes.appendAssumeCapacity(0);
                    expected_panic_msg.* = 0;
                }

                try server.serveTestMetadata(.{
                    .names = names,
                    .expected_panic_msgs = expected_panic_msgs,
                    .string_bytes = string_bytes.items,
                });
            },

            .run_test => {
                testing.environ = init.environ;
                testing.allocator_instance = .{};
                testing.io_instance = .init(testing.allocator, .{
                    .argv0 = .init(init.args),
                    .environ = init.environ,
                });
                log_err_count = 0;
                const index = try server.receiveBody_u32();
                const test_fn = builtin.test_functions[selected[index]];

                // let the build server know we're starting the test now
                try server.serveStringMessage(.test_started, &.{});

                const TestResults = std.zig.Server.Message.TestResults;
                const status: TestResults.Status = if (test_fn.func()) |v| s: {
                    v;
                    break :s .pass;
                } else |err| switch (err) {
                    error.SkipZigTest => .skip,
                    else => s: {
                        if (@errorReturnTrace()) |trace| {
                            std.debug.dumpErrorReturnTrace(trace);
                        }
                        break :s .fail;
                    },
                };
                testing.io_instance.deinit();
                const leak_count = testing.allocator_instance.detectLeaks();
                testing.allocator_instance.deinitWithoutLeakChecks();
                try server.serveTestResults(.{
                    .index = index,
                    .flags = .{
                        .status = status,
                        .fuzz = false,
                        .log_err_count = std.math.lossyCast(
                            @FieldType(TestResults.Flags, "log_err_count"),
                            log_err_count,
                        ),
                        .leak_count = std.math.lossyCast(
                            @FieldType(TestResults.Flags, "leak_count"),
                            leak_count,
                        ),
                    },
                });
            },

            else => {
                std.debug.print("unsupported message: {x}\n", .{@intFromEnum(hdr.tag)});
                std.process.exit(1);
            },
        }
    }
}

fn mainTerminal(init: std.process.Init.Minimal, selected: []const u32) void {
    @disableInstrumentation();

    var ok_count: usize = 0;
    var skip_count: usize = 0;
    var fail_count: usize = 0;
    const root_node = std.Progress.start(runner_threaded_io, .{
        .root_name = "Test",
        .estimated_total_items = selected.len,
    });
    const have_tty = Io.File.stderr().isTty(runner_threaded_io) catch unreachable;

    var leaks: usize = 0;
    for (selected, 0..) |test_index, i| {
        const test_fn = builtin.test_functions[test_index];
        testing.allocator_instance = .{};
        testing.io_instance = .init(testing.allocator, .{
            .argv0 = .init(init.args),
            .environ = init.environ,
        });
        defer {
            testing.io_instance.deinit();
            if (testing.allocator_instance.deinit() == .leak) leaks += 1;
        }
        testing.log_level = .warn;
        testing.environ = init.environ;

        const test_node = root_node.start(test_fn.name, 0);
        if (!have_tty) {
            std.debug.print("{d}/{d} {s}...", .{ i + 1, selected.len, test_fn.name });
        }
        if (test_fn.func()) |_| {
            ok_count += 1;
            test_node.end();
            if (!have_tty) std.debug.print("OK\n", .{});
        } else |err| switch (err) {
            error.SkipZigTest => {
                skip_count += 1;
                if (have_tty) {
                    std.debug.print("{d}/{d} {s}...SKIP\n", .{ i + 1, selected.len, test_fn.name });
                } else {
                    std.debug.print("SKIP\n", .{});
                }
                test_node.end();
            },
            else => {
                fail_count += 1;
                if (have_tty) {
                    std.debug.print("{d}/{d} {s}...FAIL ({t})\n", .{
                        i + 1, selected.len, test_fn.name, err,
                    });
                } else {
                    std.debug.print("FAIL ({t})\n", .{err});
                }
                if (@errorReturnTrace()) |trace| {
                    std.debug.dumpErrorReturnTrace(trace);
                }
                test_node.end();
            },
        }
    }
    root_node.end();
    if (ok_count == selected.len) {
        std.debug.print("All {d} tests passed.\n", .{ok_count});
    } else {
        std.debug.print("{d} passed; {d} skipped; {d} failed.\n", .{ ok_count, skip_count, fail_count });
    }
    if (log_err_count != 0) {
        std.debug.print("{d} errors were logged.\n", .{log_err_count});
    }
    if (leaks != 0) {
        std.debug.print("{d} tests leaked memory.\n", .{leaks});
    }
    if (leaks != 0 or log_err_count != 0 or fail_count != 0) {
        std.process.exit(1);
    }
}

pub fn log(
    comptime message_level: std.log.Level,
    comptime scope: @EnumLiteral(),
    comptime format: []const u8,
    args: anytype,
) void {
    @disableInstrumentation();
    if (@intFromEnum(message_level) <= @intFromEnum(std.log.Level.err)) {
        log_err_count +|= 1;
    }
    if (@intFromEnum(message_level) <= @intFromEnum(testing.log_level)) {
        std.debug.print(
            "[" ++ @tagName(scope) ++ "] (" ++ @tagName(message_level) ++ "): " ++ format ++ "\n",
            args,
        );
    }
}
