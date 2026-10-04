const std = @import("std");

const PlatformOption = enum {
    auto,
    @"null",
    macos,
    linux,
    windows,
};

const TraceOption = enum {
    off,
    events,
    runtime,
    all,
};

const WebEngineOption = enum {
    system,
    chromium,
};

const WebLayerOption = enum {
    auto,
    include,
    exclude,
};

const PackageTarget = enum {
    macos,
    windows,
    linux,
};

const app_exe_name = "Sage";

pub fn build(b: *std.Build) void {
    const target = nativeSdkTarget(b);
    // -Doptimize is registered by hand (not the std helper) so the
    // graph can tell "unset" from "explicit": run/dev default to
    // Debug for the edit loop, while `zig build package` wraps its own
    // ReleaseSafe exe — the same split `native dev`/`native build`
    // apply. An explicit -Doptimize (or --release) pins both roles.
    const optimize_request = b.option(std.builtin.OptimizeMode, "optimize", "Prioritize performance, safety, or binary size");
    const optimize = optimizeMode(b, optimize_request, .Debug);
    const package_optimize = optimizeMode(b, optimize_request, .ReleaseSafe);
    const platform_option = b.option(PlatformOption, "platform", "Desktop backend: auto, null, macos, linux, windows") orelse .auto;
    // -Dtrace is registered by hand for the same reason as -Doptimize: the
    // graph can tell "unset" from "explicit". The dev loop keeps `events`
    // so `native dev` can be watched; a release-shaped dev exe and the
    // packaged app default to `off`, because those builds otherwise append
    // an unencrypted native-sdk.jsonl next to the bundle id. An explicit
    // -Dtrace pins both roles.
    const trace_request = b.option(TraceOption, "trace", "Trace output: off, events, runtime, all");
    const dev_trace_default: TraceOption = if (optimize == .Debug) .events else .off;
    const trace = traceMode(trace_request, dev_trace_default);
    const package_trace = traceMode(trace_request, .off);
    const debug_overlay = b.option(bool, "debug-overlay", "Enable debug overlay output") orelse false;
    const automation_enabled = b.option(bool, "automation", "Enable Native SDK automation artifacts") orelse false;
    const live_ollama = b.option(bool, "live-ollama", "Run tests that call a local Ollama server") orelse false;
    const js_bridge_enabled = b.option(bool, "js-bridge", "Enable optional JavaScript bridge stubs") orelse false;
    const memory_enabled = b.option(bool, "memory", "Enable Memories in Chat, Dream, and the UI") orelse false;
    const web_engine_override = b.option(WebEngineOption, "web-engine", "Override app.zon web engine: system, chromium");
    const web_layer_override = b.option(WebLayerOption, "web-layer", "Override app.zon webview_layer: auto, include, exclude");
    const cef_dir_override = b.option([]const u8, "cef-dir", "Override CEF root directory for Chromium builds");
    const cef_auto_install_override = b.option(bool, "cef-auto-install", "Override app.zon CEF auto-install setting");
    const package_target = b.option(PackageTarget, "package-target", "Package target: macos, windows, linux") orelse .macos;
    const native_sdk_override = b.option([]const u8, "native-sdk-path", "Path to the Native SDK framework checkout");
    const native_sdk_path = resolveNativeSdkPath(b, native_sdk_override);
    // `native build` forwards -D flags only, and for an ejected app it passes
    // no --prefix of its own, so the eval runner redirects its throwaway
    // automation install through this option. That keeps zig-out/bin/Sage as
    // the binary `make build` and `make dev` write. Run before any install
    // step is created: getInstallPath reads the prefix at construction.
    if (b.option([]const u8, "install-prefix", "Install prefix override for throwaway builds")) |install_prefix| {
        b.resolveInstallPrefix(install_prefix, .{});
    }
    const package_optimize_name = @tagName(package_optimize);
    const selected_platform: PlatformOption = switch (platform_option) {
        .auto => if (target.result.os.tag == .macos) .macos else if (target.result.os.tag == .linux) .linux else if (target.result.os.tag == .windows) .windows else .@"null",
        else => platform_option,
    };
    if (selected_platform == .macos and target.result.os.tag != .macos) {
        @panic("-Dplatform=macos requires a macOS target");
    }
    if (selected_platform == .linux and target.result.os.tag != .linux) {
        @panic("-Dplatform=linux requires a Linux target");
    }
    if (selected_platform == .windows and target.result.os.tag != .windows) {
        @panic("-Dplatform=windows requires a Windows target");
    }
    const app_config = appManifestBuildConfig(b);
    const web_engine = web_engine_override orelse app_config.web_engine;
    if (app_config.updates_enabled and selected_platform == .macos and web_engine == .chromium) {
        @panic("\nnative updates currently require the system macOS host; use web_engine = \"system\" or remove the updates block\n");
    }
    const cef_dir = cef_dir_override orelse defaultCefDir(selected_platform, app_config.cef_dir);
    const cef_auto_install = cef_auto_install_override orelse app_config.cef_auto_install;
    if (web_engine == .chromium and selected_platform != .macos) {
        @panic("-Dweb-engine=chromium currently requires -Dplatform=macos");
    }
    const web_layer = resolveWebLayer(app_config, web_engine, web_layer_override);

    const native_sdk_mod = nativeSdkModule(b, target, optimize, native_sdk_path);
    const relational_migrations_source = if (app_config.relational_capability)
        sqliteMigrationsSource(b, native_sdk_path)
    else
        nativeSdkPath(b, native_sdk_path, "src/app_runner/no_migrations.zig");
    const platform_name: []const u8 = switch (selected_platform) {
        .auto => unreachable,
        .@"null" => "null",
        .macos => "macos",
        .linux => "linux",
        .windows => "windows",
    };
    const options_mod = appOptions(b, trace, platform_name, web_engine, debug_overlay, automation_enabled, live_ollama, js_bridge_enabled, web_layer, memory_enabled);
    const agent_instructions_mod = agentInstructionsModule(b);

    const runner_mod = localModule(b, target, optimize, "src/runner.zig");
    runner_mod.addImport("native_sdk", native_sdk_mod);
    runner_mod.addImport("build_options", options_mod);
    runner_mod.addImport("app_manifest_zon", appManifestModule(b));
    const migrations_mod = b.createModule(.{ .root_source_file = relational_migrations_source, .target = target, .optimize = optimize });
    migrations_mod.addImport("native_sdk", native_sdk_mod);
    runner_mod.addImport("relational_migrations", migrations_mod);

    const app_mod = localModule(b, target, optimize, "src/main.zig");
    app_mod.addImport("native_sdk", native_sdk_mod);
    app_mod.addImport("build_options", options_mod);
    app_mod.addImport("runner", runner_mod);
    app_mod.addImport("agent_instructions", agent_instructions_mod);
    if (app_config.sqlite_capability) addSqliteEngine(b, app_mod, native_sdk_path);
    addMacosInfoPlist(b, app_mod, target, app_config);
    const exe = b.addExecutable(.{
        .name = app_exe_name,
        .root_module = app_mod,
        // Zig 0.16.0's self-hosted x86_64 backend (the Debug default)
        // miscompiles the SysV C calling convention for the long
        // mixed-argument signatures the platform hosts use, shifting
        // stack-passed pointers by one slot (a Debug dev run on
        // x86_64 Linux crashes creating its first shell view). Force
        // LLVM there, mirroring the Native SDK build graph; Release
        // modes already use LLVM, so only Debug changes.
        .use_llvm = useLlvmWorkaround(target),
    });
    // Windows subsystem posture (mirrors the Native SDK build graph):
    // release-shaped exes are GUI-subsystem so the app never flashes a
    // console behind its window; Debug keeps the console for dev logs.
    // Redirected logging still works on GUI exes - only console
    // AUTO-allocation is subsystem-gated.
    if (target.result.os.tag == .windows and optimize != .Debug) {
        exe.subsystem = .windows;
    }
    linkPlatform(b, target, app_mod, exe, selected_platform, web_engine, web_layer, native_sdk_path, cef_dir, cef_auto_install);
    b.installArtifact(exe);

    const frontend_install = b.addSystemCommand(&.{ "npm", "install", "--prefix", "frontend" });
    const frontend_install_step = b.step("frontend-install", "Install frontend dependencies");
    frontend_install_step.dependOn(&frontend_install.step);

    const frontend_build = b.addSystemCommand(&.{ "npm", "--prefix", "frontend", "run", "build" });
    frontend_build.step.dependOn(&frontend_install.step);
    const frontend_step = b.step("frontend-build", "Build the frontend");
    frontend_step.dependOn(&frontend_build.step);

    const run = b.addRunArtifact(exe);
    run.step.dependOn(&frontend_build.step);
    addCefRuntimeRunFiles(b, target, run, exe, web_engine, cef_dir);
    addWebView2RuntimeRunFiles(b, target, run, web_engine, web_layer, native_sdk_path);
    const run_step = b.step("run", "Run the app");
    run_step.dependOn(&run.step);

    const dev = b.addSystemCommand(&.{ "native", "dev", "--manifest", "app.json", "--binary" });
    dev.addFileArg(exe.getEmittedBin());
    addWebView2RuntimeRunFiles(b, target, dev, web_engine, web_layer, native_sdk_path);
    dev.step.dependOn(&exe.step);
    dev.step.dependOn(&frontend_install.step);
    const dev_step = b.step("dev", "Run the frontend dev server and native shell");
    dev_step.dependOn(&dev.step);

    // `zig build package` wraps its own exe: ReleaseSafe by default
    // (GUI subsystem on Windows) so the packaged artifact
    // is never a Debug console binary just because the dev loop
    // defaults to Debug. When -Doptimize/--release pinned one mode and
    // -Dtrace pinned one value for everything, the roles agree and the
    // dev exe is reused as-is.
    const package_exe = if (package_optimize == optimize and package_trace == trace) exe else pkg: {
        const package_sdk_mod = nativeSdkModule(b, target, package_optimize, native_sdk_path);
        const package_options_mod = if (package_trace == trace) options_mod else appOptions(b, package_trace, platform_name, web_engine, debug_overlay, automation_enabled, live_ollama, js_bridge_enabled, web_layer, memory_enabled);
        const package_runner_mod = localModule(b, target, package_optimize, "src/runner.zig");
        package_runner_mod.addImport("native_sdk", package_sdk_mod);
        package_runner_mod.addImport("build_options", package_options_mod);
        package_runner_mod.addImport("app_manifest_zon", appManifestModule(b));
        const package_migrations_mod = b.createModule(.{ .root_source_file = relational_migrations_source, .target = target, .optimize = package_optimize });
        package_migrations_mod.addImport("native_sdk", package_sdk_mod);
        package_runner_mod.addImport("relational_migrations", package_migrations_mod);
        const package_app_mod = localModule(b, target, package_optimize, "src/main.zig");
        package_app_mod.addImport("native_sdk", package_sdk_mod);
        package_app_mod.addImport("build_options", package_options_mod);
        package_app_mod.addImport("runner", package_runner_mod);
        package_app_mod.addImport("agent_instructions", agent_instructions_mod);
        if (app_config.sqlite_capability) addSqliteEngine(b, package_app_mod, native_sdk_path);
        addMacosInfoPlist(b, package_app_mod, target, app_config);
        const built = b.addExecutable(.{
            .name = app_exe_name,
            .root_module = package_app_mod,
            // Same self-hosted x86_64 workaround as the dev exe above
            // (only reachable when -Doptimize pins Debug for both roles).
            .use_llvm = useLlvmWorkaround(target),
        });
        // Same subsystem posture as the dev exe above, keyed on this
        // exe's own mode: release-shaped Windows exes are GUI-subsystem.
        if (target.result.os.tag == .windows and package_optimize != .Debug) {
            built.subsystem = .windows;
        }
        linkPlatform(b, target, package_app_mod, built, selected_platform, web_engine, web_layer, native_sdk_path, cef_dir, cef_auto_install);
        break :pkg built;
    };

    const package_output = b.fmt("zig-out/package/{s}-{s}-{s}-{s}{s}", .{ app_exe_name, app_config.version, @tagName(package_target), package_optimize_name, packageSuffix(package_target) });
    const package = b.addSystemCommand(&.{
        "native",
        "package",
        "--target",
        @tagName(package_target),
        "--manifest",
        "app.json",
        "--assets","frontend/dist",
        "--optimize",
        package_optimize_name,
        "--output",
        package_output,
        "--binary",
    });
    // The CLI resolves SDK-owned package inputs (the vendored WebView2
    // loader) from the framework root; a PATH-resolved `native` could
    // belong to a different checkout than the one this build compiled
    // against, so hand the same root over explicitly.
    package.setEnvironmentVariable("NATIVE_SDK_PATH", b.pathFromRoot(native_sdk_path));
    package.addFileArg(package_exe.getEmittedBin());
    package.addArgs(&.{ "--web-engine", @tagName(web_engine), "--cef-dir", cef_dir });
    // Forward the RESOLVED web-layer decision, never the raw inputs:
    // this graph already decided web vs native-only for the exe it is
    // packaging (app.zon declarations plus -Dweb-layer/-Dweb-engine),
    // and the CLI re-inferring from app.zon alone would miss a
    // flag-driven override. Handing over the decision itself makes
    // exe/package agreement structural.
    package.addArgs(&.{ "--web-layer", if (web_layer) "include" else "exclude" });
    if (cef_auto_install) package.addArg("--cef-auto-install");
    package.step.dependOn(&package_exe.step);
    package.step.dependOn(&frontend_build.step);
    const package_step = b.step("package", "Create a local package artifact");
    package_step.dependOn(&package.step);
    if (package_target == .macos) {
        // native package --update-archive would snapshot the .app before this
        // copy, so the update zip would ship without the Chat agent. Build the
        // zip after copy_agent instead.
        const agent_install = b.addSystemCommand(&.{ "npm", "install", "--prefix", "agent" });
        const agent_build = b.addSystemCommand(&.{ "npm", "--prefix", "agent", "run", "build" });
        agent_build.step.dependOn(&agent_install.step);
        const copy_agent = b.addSystemCommand(&.{ "sh", "scripts/copy-agent-into-app.sh", package_output });
        copy_agent.step.dependOn(&package.step);
        copy_agent.step.dependOn(&agent_build.step);
        package_step.dependOn(&copy_agent.step);
        if (app_config.updates_enabled and b.graph.host.result.os.tag == .macos) {
            const update_archive = b.addSystemCommand(&.{ "sh", "scripts/update-archive-packaged-app.sh", package_output });
            update_archive.step.dependOn(&copy_agent.step);
            package_step.dependOn(&update_archive.step);
        }
    }

    // Tests default to the null platform so `native test` / `zig build test`
    // do not link the Mac window host. The journal tests talk to an
    // in-memory database and do not open a window. Pass `-Dplatform=null`
    // for the app too, and this reuses that module.
    const test_app_mod = if (selected_platform == .@"null") app_mod else test_app: {
        const test_options_mod = appOptions(b, trace, "null", web_engine, debug_overlay, automation_enabled, live_ollama, js_bridge_enabled, web_layer, memory_enabled);
        const test_runner_mod = localModule(b, target, optimize, "src/runner.zig");
        test_runner_mod.addImport("native_sdk", native_sdk_mod);
        test_runner_mod.addImport("build_options", test_options_mod);
        test_runner_mod.addImport("app_manifest_zon", appManifestModule(b));
        test_runner_mod.addImport("relational_migrations", migrations_mod);
        const test_mod = localModule(b, target, optimize, "src/main.zig");
        test_mod.addImport("native_sdk", native_sdk_mod);
        test_mod.addImport("build_options", test_options_mod);
        test_mod.addImport("runner", test_runner_mod);
        test_mod.addImport("agent_instructions", agent_instructions_mod);
        if (app_config.sqlite_capability) addSqliteEngine(b, test_mod, native_sdk_path);
        break :test_app test_mod;
    };
    const tests = b.addTest(.{ .root_module = test_app_mod });
    const test_step = b.step("test", "Run tests");
    test_step.dependOn(&b.addRunArtifact(tests).step);
}

// Zig 0.16.0's self-hosted x86_64 backend miscompiles the SysV C
// calling convention for long mixed int/pointer/double signatures
// (the platform hosts' view-create calls) and f32-heavy ones (the
// embed viewport ABI): stack-passed arguments arrive shifted, so a
// Debug x86_64 build crashes at the first platform call that passes
// strings on the stack. Force the LLVM backend on x86_64 until the
// upstream backend is fixed; Release modes already default to LLVM,
// so this only changes Debug builds.
fn useLlvmWorkaround(target: std.Build.ResolvedTarget) ?bool {
    return if (target.result.cpu.arch == .x86_64) true else null;
}

/// Bare Mach-O dev executables have no bundle Info.plist. Embed launch
/// policy plus capture usage strings so LaunchServices starts accessory
/// apps without a transient Dock tile and macOS can present consent.
/// Packaged apps receive the richer external plist from the package command.
fn addMacosInfoPlist(b: *std.Build, app_mod: *std.Build.Module, target: std.Build.ResolvedTarget, config: AppManifestBuildConfig) void {
    if (target.result.os.tag != .macos) return;
    if (config.dock_visible and !config.microphone_permission and !config.system_audio_permission) return;

    const launch_policy = if (!config.dock_visible)
        "  <key>LSUIElement</key>\\n  <true/>\\n"
    else
        "";
    const microphone = if (config.microphone_permission)
        "  <key>NSMicrophoneUsageDescription</key>\\n  <string>This app captures microphone audio when you start recording.</string>\\n"
    else
        "";
    const system_audio = if (config.system_audio_permission)
        "  <key>NSAudioCaptureUsageDescription</key>\\n  <string>This app captures system audio when you start recording.</string>\\n" ++
            "  <key>NSScreenCaptureUsageDescription</key>\\n  <string>This app captures system audio when you start recording.</string>\\n"
    else
        "";
    const source = b.fmt(
        \\#define NATIVE_SDK_INFO_PLIST "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n" "<plist version=\"1.0\">\n<dict>\n{s}{s}{s}</dict>\n</plist>\n"
        \\__attribute__((used, section("__TEXT,__info_plist")))
        \\static const unsigned char native_sdk_info_plist[sizeof(NATIVE_SDK_INFO_PLIST) - 1] = NATIVE_SDK_INFO_PLIST;
        \\
    , .{ launch_policy, microphone, system_audio });
    const generated = b.addWriteFiles().add("native_sdk_macos_info_plist.c", source);
    app_mod.addCSourceFile(.{ .file = generated, .flags = &.{} });
}

// Resolve the optimize mode for one exe role (mirrors the Native SDK
// build graph): an explicit -Doptimize wins for every role, --release
// resolves through zig's release_mode, and only when neither was
// passed does the role keep its own default — Debug for the dev loop,
// ReleaseSafe for the exe `zig build package` wraps.
fn optimizeMode(b: *std.Build, requested: ?std.builtin.OptimizeMode, default_mode: std.builtin.OptimizeMode) std.builtin.OptimizeMode {
    if (requested) |mode| return mode;
    return switch (b.release_mode) {
        .off => default_mode,
        .any, .fast => .ReleaseFast,
        .safe => .ReleaseSafe,
        .small => .ReleaseSmall,
    };
}

// Resolve the trace mode for one exe role (mirrors `optimizeMode`): an
// explicit -Dtrace wins for every role, and only when the flag is absent
// does the role keep its own default.
fn traceMode(requested: ?TraceOption, default_mode: TraceOption) TraceOption {
    return requested orelse default_mode;
}

// The build_options module for one exe role. Every field is shared except
// `trace`, which is baked into the module it feeds: the traced dev loop
// and the untraced packaged app cannot share one.
fn appOptions(
    b: *std.Build,
    trace: TraceOption,
    platform: []const u8,
    web_engine: WebEngineOption,
    debug_overlay: bool,
    automation: bool,
    live_ollama: bool,
    js_bridge: bool,
    web_layer: bool,
    memory_enabled: bool,
) *std.Build.Module {
    const options = b.addOptions();
    options.addOption([]const u8, "platform", platform);
    options.addOption([]const u8, "trace", @tagName(trace));
    options.addOption([]const u8, "web_engine", @tagName(web_engine));
    options.addOption(bool, "debug_overlay", debug_overlay);
    options.addOption(bool, "automation", automation);
    options.addOption(bool, "live_ollama", live_ollama);
    options.addOption(bool, "js_bridge", js_bridge);
    options.addOption(bool, "web_layer", web_layer);
    options.addOption(bool, "memory_enabled", memory_enabled);
    return options.createModule();
}

fn nativeSdkTarget(b: *std.Build) std.Build.ResolvedTarget {
    const target = b.standardTargetOptions(.{});
    if (target.result.os.tag != .macos) return target;

    if (b.sysroot == null) {
        b.sysroot = macosSdkPath(b) orelse b.sysroot;
    }

    var query = target.query;
    query.os_tag = .macos;
    query.os_version_min = .{ .semver = .{ .major = 11, .minor = 0, .patch = 0 } };
    return b.resolveTargetQuery(query);
}

fn macosSdkPath(b: *std.Build) ?[]const u8 {
    if (b.graph.environ_map.get("SDKROOT")) |sdkroot| {
        if (sdkroot.len > 0) return sdkroot;
    }

    const result = std.process.run(b.allocator, b.graph.io, .{
        .argv = &.{ "xcrun", "--sdk", "macosx", "--show-sdk-path" },
        .stdout_limit = .limited(4096),
        .stderr_limit = .limited(4096),
    }) catch return null;
    defer b.allocator.free(result.stderr);
    if (result.term != .exited or result.term.exited != 0) {
        b.allocator.free(result.stdout);
        return null;
    }
    return std.mem.trimEnd(u8, result.stdout, "\r\n");
}

fn agentInstructionsModule(b: *std.Build) *std.Build.Module {
    const source = b.fmt(
        "pub const text: []const u8 = \"{f}\";\n",
        .{std.zig.fmtString(@embedFile("agent/agent/instructions.md"))},
    );
    const generated = b.addWriteFiles().add("agent_instructions.zig", source);
    return b.createModule(.{ .root_source_file = generated });
}

fn localModule(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode, path: []const u8) *std.Build.Module {
    return b.createModule(.{
        .root_source_file = b.path(path),
        .target = target,
        .optimize = optimize,
    });
}

fn nativeSdkPath(b: *std.Build, native_sdk_path: []const u8, sub_path: []const u8) std.Build.LazyPath {
    return .{ .cwd_relative = b.pathJoin(&.{ native_sdk_path, sub_path }) };
}

/// Prefer an explicit `-Dnative-sdk-path`, then `NATIVE_SDK_PATH` (the
/// `native` CLI sets this to the installed package), then the global
/// `npm` CLI install. A baked-in eject path would only work on the
/// machine that generated `build.zig`.
fn resolveNativeSdkPath(b: *std.Build, override: ?[]const u8) []const u8 {
    if (override) |path| {
        if (nativeSdkRootExists(b, path)) return path;
        std.debug.panic("Native SDK not found at -Dnative-sdk-path={s} (missing src/root.zig)", .{path});
    }
    if (b.graph.environ_map.get("NATIVE_SDK_PATH")) |path| {
        if (path.len > 0 and nativeSdkRootExists(b, path)) return path;
    }
    if (discoverNpmGlobalNativeSdk(b)) |path| return path;
    const pinned_cli_version = comptime std.mem.trim(
        u8,
        @embedFile(".native-sdk-version"),
        " \t\r\n",
    );
    @panic("cannot find the Native SDK (src/root.zig).\n" ++
        "Install the pinned CLI: npm install -g @native-sdk/cli@" ++ pinned_cli_version ++ "\n" ++
        "Or pass -Dnative-sdk-path=/path/to/@native-sdk/cli\n" ++
        "Or set NATIVE_SDK_PATH to that directory.");
}

fn nativeSdkRootExists(b: *std.Build, root: []const u8) bool {
    const root_zig = b.pathJoin(&.{ root, "src", "root.zig" });
    std.Io.Dir.cwd().access(b.graph.io, root_zig, .{}) catch return false;
    return true;
}

fn discoverNpmGlobalNativeSdk(b: *std.Build) ?[]const u8 {
    const result = std.process.run(b.allocator, b.graph.io, .{
        .argv = &.{ "npm", "root", "-g" },
        .stdout_limit = .limited(4096),
        .stderr_limit = .limited(4096),
    }) catch return null;
    defer b.allocator.free(result.stderr);
    defer b.allocator.free(result.stdout);
    if (result.term != .exited or result.term.exited != 0) return null;
    const npm_root = std.mem.trimEnd(u8, result.stdout, "\r\n");
    if (npm_root.len == 0) return null;
    const path = b.pathJoin(&.{ npm_root, "@native-sdk", "cli" });
    if (nativeSdkRootExists(b, path)) return path;
    return null;
}

fn nativeSdkModule(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode, native_sdk_path: []const u8) *std.Build.Module {
    const geometry_mod = externalModule(b, target, optimize, native_sdk_path, "src/primitives/geometry/root.zig");
    const assets_mod = externalModule(b, target, optimize, native_sdk_path, "src/primitives/assets/root.zig");
    const app_dirs_mod = externalModule(b, target, optimize, native_sdk_path, "src/primitives/app_dirs/root.zig");
    const trace_mod = externalModule(b, target, optimize, native_sdk_path, "src/primitives/trace/root.zig");
    const app_manifest_mod = externalModule(b, target, optimize, native_sdk_path, "src/primitives/app_manifest/root.zig");
    const diagnostics_mod = externalModule(b, target, optimize, native_sdk_path, "src/primitives/diagnostics/root.zig");
    const platform_info_mod = externalModule(b, target, optimize, native_sdk_path, "src/primitives/platform_info/root.zig");
    const json_mod = externalModule(b, target, optimize, native_sdk_path, "src/primitives/json/root.zig");
    const canvas_mod = externalModule(b, target, optimize, native_sdk_path, "src/primitives/canvas/root.zig");
    canvas_mod.addImport("geometry", geometry_mod);
    canvas_mod.addImport("json", json_mod);
    const debug_mod = externalModule(b, target, optimize, native_sdk_path, "src/debug/root.zig");
    debug_mod.addImport("app_dirs", app_dirs_mod);
    debug_mod.addImport("trace", trace_mod);

    const native_sdk_mod = externalModule(b, target, optimize, native_sdk_path, "src/root.zig");
    native_sdk_mod.addIncludePath(nativeSdkPath(b, native_sdk_path, "third_party/sqlite"));
    native_sdk_mod.addImport("geometry", geometry_mod);
    native_sdk_mod.addImport("assets", assets_mod);
    native_sdk_mod.addImport("app_dirs", app_dirs_mod);
    native_sdk_mod.addImport("trace", trace_mod);
    native_sdk_mod.addImport("app_manifest", app_manifest_mod);
    native_sdk_mod.addImport("diagnostics", diagnostics_mod);
    native_sdk_mod.addImport("platform_info", platform_info_mod);
    native_sdk_mod.addImport("json", json_mod);
    native_sdk_mod.addImport("canvas", canvas_mod);
    return native_sdk_mod;
}

fn sqliteMigrationsSource(b: *std.Build, native_sdk_path: []const u8) std.Build.LazyPath {
    const generate = b.addSystemCommand(&.{ "node" });
    generate.addFileArg(nativeSdkPath(b, native_sdk_path, "build/ts_run.mjs"));
    generate.addFileArg(nativeSdkPath(b, native_sdk_path, "packages/core/src/sqlite_cli.ts"));
    generate.addArg("--src");
    generate.addDirectoryArg(b.path("src"));
    generate.addArg("--zig-out");
    const migrations = generate.addOutputFileArg("migrations.zig");
    generate.addArgs(&.{ "--state", "src/schema/migrations.lock.json" });
    if (b.build_root.handle.access(b.graph.io, "src/schema/migrations.lock.json", .{})) |_| {
        generate.addFileInput(b.path("src/schema/migrations.lock.json"));
    } else |_| {}
    generate.addFileInput(nativeSdkPath(b, native_sdk_path, "packages/core/src/sqlite_codegen.ts"));
    generate.addFileInput(nativeSdkPath(b, native_sdk_path, "packages/core/src/sqlite_runtime_policy.ts"));
    addAppSqlDirInputs(b, generate, "src");
    return migrations;
}

fn addAppSqlDirInputs(b: *std.Build, run: *std.Build.Step.Run, src_path: []const u8) void {
    var dir = b.build_root.handle.openDir(b.graph.io, src_path, .{ .iterate = true }) catch return;
    defer dir.close(b.graph.io);
    var walker = dir.walk(b.allocator) catch return;
    defer walker.deinit();
    while (walker.next(b.graph.io) catch null) |entry| {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.basename, ".sql")) continue;
        run.addFileInput(b.path(b.fmt("{s}/{s}", .{ src_path, entry.path })));
    }
}

fn addSqliteEngine(b: *std.Build, app_mod: *std.Build.Module, native_sdk_path: []const u8) void {
    app_mod.addIncludePath(nativeSdkPath(b, native_sdk_path, "third_party/sqlite"));
    app_mod.addCSourceFile(.{
        .file = nativeSdkPath(b, native_sdk_path, "third_party/sqlite/sqlite3.c"),
        .flags = &.{ "-DSQLITE_THREADSAFE=2", "-DSQLITE_OMIT_LOAD_EXTENSION", "-DSQLITE_DQS=0", "-DSQLITE_ENABLE_FTS5", "-DSQLITE_ENABLE_JSON1", "-DSQLITE_ENABLE_UPDATE_HOOK", "-DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1", "-DSQLITE_DEFAULT_MEMSTATUS=0" },
    });
    app_mod.link_libc = true;
}

fn externalModule(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode, native_sdk_path: []const u8, path: []const u8) *std.Build.Module {
    return b.createModule(.{
        .root_source_file = nativeSdkPath(b, native_sdk_path, path),
        .target = target,
        .optimize = optimize,
    });
}

fn linkPlatform(b: *std.Build, target: std.Build.ResolvedTarget, app_mod: *std.Build.Module, exe: *std.Build.Step.Compile, platform: PlatformOption, web_engine: WebEngineOption, web_layer: bool, native_sdk_path: []const u8, cef_dir: []const u8, cef_auto_install: bool) void {
    if (platform == .macos) {
        switch (web_engine) {
            .system => {
                const sdk_include = if (b.sysroot) |sysroot| b.fmt("-I{s}/usr/include", .{sysroot}) else "";
                const flags: []const []const u8 = if (b.sysroot) |sysroot| &.{ "-fobjc-arc", "-fno-sanitize=builtin", "-ObjC", "-mmacosx-version-min=11.0", "-isysroot", sysroot, sdk_include } else &.{ "-fobjc-arc", "-fno-sanitize=builtin", "-ObjC", "-mmacosx-version-min=11.0" };
                app_mod.addCSourceFile(.{ .file = nativeSdkPath(b, native_sdk_path, "src/platform/macos/appkit_host.m"), .flags = flags });
                app_mod.linkFramework("WebKit", .{});
            },
            .chromium => {
                const cef_check = addCefCheck(b, target, cef_dir);
                if (cef_auto_install) {
                    const cef_auto = b.addSystemCommand(&.{ "native", "cef", "install", "--dir", cef_dir });
                    cef_check.step.dependOn(&cef_auto.step);
                }
                exe.step.dependOn(&cef_check.step);
                const include_arg = b.fmt("-I{s}", .{cef_dir});
                const define_arg = b.fmt("-DNATIVE_SDK_CEF_DIR=\"{s}\"", .{cef_dir});
                // The SDK's usr/include must stay a system include dir (searched after zig's
                // bundled libc++/libc headers). A plain -I shadows libc++'s <string.h>/<math.h>
                // wrappers in ObjC++ and surfaces SDK nullability gaps as a diagnostic flood.
                const sdk_include = if (b.sysroot) |sysroot| b.fmt("-isystem{s}/usr/include", .{sysroot}) else "";
                const flags: []const []const u8 = if (b.sysroot) |sysroot| &.{ "-fobjc-arc", "-fno-sanitize=builtin", "-ObjC++", "-std=c++17", "-stdlib=libc++", "-mmacosx-version-min=11.0", "-isysroot", sysroot, sdk_include, include_arg, define_arg } else &.{ "-fobjc-arc", "-fno-sanitize=builtin", "-ObjC++", "-std=c++17", "-stdlib=libc++", "-mmacosx-version-min=11.0", include_arg, define_arg };
                app_mod.addCSourceFile(.{ .file = nativeSdkPath(b, native_sdk_path, "src/platform/macos/cef_host.mm"), .flags = flags });
                app_mod.addObjectFile(b.path(b.fmt("{s}/libcef_dll_wrapper/libcef_dll_wrapper.a", .{cef_dir})));
                app_mod.addFrameworkPath(b.path(b.fmt("{s}/Release", .{cef_dir})));
                app_mod.linkFramework("Chromium Embedded Framework", .{});
                app_mod.addRPath(.{ .cwd_relative = "@executable_path/Frameworks" });
            },
        }
        if (b.sysroot) |sysroot| {
            app_mod.addFrameworkPath(.{ .cwd_relative = b.pathJoin(&.{ sysroot, "System/Library/Frameworks" }) });
        }
        app_mod.linkFramework("AppKit", .{});
        app_mod.linkFramework("AVFoundation", .{});
        app_mod.linkFramework("CoreMedia", .{});
        app_mod.linkFramework("ScreenCaptureKit", .{ .weak = true });
        app_mod.linkFramework("CoreVideo", .{});
        app_mod.linkFramework("MediaToolbox", .{});
        app_mod.linkFramework("Accelerate", .{});
        app_mod.linkFramework("Foundation", .{});
        app_mod.linkFramework("CoreText", .{});
        app_mod.linkFramework("UniformTypeIdentifiers", .{});
        app_mod.linkFramework("Security", .{});
        app_mod.linkFramework("Metal", .{});
        app_mod.linkFramework("QuartzCore", .{});
        app_mod.linkSystemLibrary("c", .{});
        if (web_engine == .chromium) app_mod.linkSystemLibrary("c++", .{});
    } else if (platform == .linux) {
        switch (web_engine) {
            .system => if (web_layer) {
                app_mod.addCSourceFile(.{ .file = nativeSdkPath(b, native_sdk_path, "src/platform/linux/gtk_host.c"), .flags = &.{} });
                app_mod.linkSystemLibrary("gtk4", .{});
                app_mod.linkSystemLibrary("webkitgtk-6.0", .{});
                app_mod.linkSystemLibrary("dl", .{});
            } else {
                // Native-only app (nothing in app.zon declares web use):
                // compile the GTK host without the embedded web layer.
                // The stub define excludes the layer outright — the host
                // honors it before probing for the WebKitGTK header, so
                // the layer stays out even on machines where the
                // development package is installed — libwebkitgtk is
                // neither linked nor required at runtime, and the
                // executable carries no WebKit reference at all. This
                // is the expected, configured state of every canvas
                // app on Linux, so the stub compile is deliberately
                // silent — no build note, no compiler diagnostic (the
                // host's seam comment explains why even an
                // informational pragma is dangerous); a stubbed host
                // teaches at runtime by reporting WebViewNotFound the
                // moment an app actually uses a WebView.
                app_mod.addCSourceFile(.{ .file = nativeSdkPath(b, native_sdk_path, "src/platform/linux/gtk_host.c"), .flags = &.{"-DNATIVE_SDK_ALLOW_WEBKITGTK_STUB"} });
                app_mod.linkSystemLibrary("gtk4", .{});
                app_mod.linkSystemLibrary("dl", .{});
            },
            .chromium => {
                const cef_check = addCefCheck(b, target, cef_dir);
                if (cef_auto_install) {
                    const cef_auto = b.addSystemCommand(&.{ "native", "cef", "install", "--dir", cef_dir });
                    cef_check.step.dependOn(&cef_auto.step);
                }
                exe.step.dependOn(&cef_check.step);
                const include_arg = b.fmt("-I{s}", .{cef_dir});
                const define_arg = b.fmt("-DNATIVE_SDK_CEF_DIR=\"{s}\"", .{cef_dir});
                app_mod.addCSourceFile(.{ .file = nativeSdkPath(b, native_sdk_path, "src/platform/linux/cef_host.cpp"), .flags = &.{ "-std=c++17", include_arg, define_arg } });
                app_mod.addObjectFile(b.path(b.fmt("{s}/libcef_dll_wrapper/libcef_dll_wrapper.a", .{cef_dir})));
                app_mod.addLibraryPath(b.path(b.fmt("{s}/Release", .{cef_dir})));
                app_mod.linkSystemLibrary("cef", .{});
                app_mod.addRPath(.{ .cwd_relative = "$ORIGIN" });
            },
        }
        app_mod.linkSystemLibrary("c", .{});
        if (web_engine == .chromium) app_mod.linkSystemLibrary("stdc++", .{});
    } else if (platform == .windows) {
        switch (web_engine) {
            .system => if (web_layer) {
                // The vendored WebView2 SDK header (third_party/webview2)
                // turns on the host's embedded-WebView layer; the host
                // fails the compile by design if it cannot be found.
                app_mod.addIncludePath(nativeSdkPath(b, native_sdk_path, "third_party/webview2/include"));
                app_mod.addCSourceFile(.{ .file = nativeSdkPath(b, native_sdk_path, "src/platform/windows/webview2_host.cpp"), .flags = &.{ "-std=c++17" } });
                // WebView2Loader.dll rides next to the installed app
                // executable: the host loads it at runtime to discover
                // the machine's WebView2 runtime. Canvas apps never
                // touch it.
                const loader = b.addInstallBinFile(nativeSdkPath(b, native_sdk_path, webView2LoaderSubPath(target)), "WebView2Loader.dll");
                b.getInstallStep().dependOn(&loader.step);
            } else {
                // Native-only app (nothing in app.zon declares web use):
                // compile the host without the embedded-WebView layer.
                // The stub define excludes the layer outright — the host
                // honors it before probing for the WebView2 header, so
                // the layer stays out even on machines where the SDK
                // headers are reachable through the system include paths
                // — no WebView2Loader.dll is installed or path-wired,
                // and the executable carries no reference to it at all.
                // This is the expected, configured state of every
                // canvas app on Windows, so the stub compile is
                // deliberately silent — no build note, no compiler
                // diagnostic (the host's seam comment explains why
                // even an informational pragma is dangerous); a
                // stubbed host teaches at runtime by reporting
                // WebViewNotFound the moment an app actually uses a
                // WebView.
                app_mod.addCSourceFile(.{ .file = nativeSdkPath(b, native_sdk_path, "src/platform/windows/webview2_host.cpp"), .flags = &.{ "-std=c++17", "-DNATIVE_SDK_ALLOW_WEBVIEW2_STUB" } });
            },
            .chromium => {
                const cef_check = addCefCheck(b, target, cef_dir);
                if (cef_auto_install) {
                    const cef_auto = b.addSystemCommand(&.{ "native", "cef", "install", "--dir", cef_dir });
                    cef_check.step.dependOn(&cef_auto.step);
                }
                exe.step.dependOn(&cef_check.step);
                const include_arg = b.fmt("-I{s}", .{cef_dir});
                const define_arg = b.fmt("-DNATIVE_SDK_CEF_DIR=\"{s}\"", .{cef_dir});
                app_mod.addCSourceFile(.{ .file = nativeSdkPath(b, native_sdk_path, "src/platform/windows/cef_host.cpp"), .flags = &.{ "-std=c++17", include_arg, define_arg } });
                app_mod.addObjectFile(b.path(b.fmt("{s}/libcef_dll_wrapper/libcef_dll_wrapper.lib", .{cef_dir})));
                app_mod.addLibraryPath(b.path(b.fmt("{s}/Release", .{cef_dir})));
            },
        }
        app_mod.addCSourceFile(.{ .file = nativeSdkPath(b, native_sdk_path, "src/platform/windows/gpu_surface_renderer.cpp"), .flags = &.{ "-std=c++17" } });
        app_mod.linkSystemLibrary("c", .{});
        app_mod.linkSystemLibrary("c++", .{});
        app_mod.linkSystemLibrary("user32", .{});
        app_mod.linkSystemLibrary("gdi32", .{});
        app_mod.linkSystemLibrary("d2d1", .{});
        app_mod.linkSystemLibrary("dwrite", .{});
        app_mod.linkSystemLibrary("imm32", .{});
        app_mod.linkSystemLibrary("comctl32", .{});
        app_mod.linkSystemLibrary("ole32", .{});
        app_mod.linkSystemLibrary("oleacc", .{});
        app_mod.linkSystemLibrary("shell32", .{});
        // TypeScript cores link ScriptC's host runtime, whose network-interface
        // helpers use GetAdaptersAddresses and Winsock address conversion.
        app_mod.linkSystemLibrary("iphlpapi", .{});
        app_mod.linkSystemLibrary("ws2_32", .{});
        // The audio backend: Media Foundation (session + source resolver
        // + streaming audio renderer) and WinHTTP (the cache fill).
        app_mod.linkSystemLibrary("mf", .{});
        app_mod.linkSystemLibrary("mfplat", .{});
        app_mod.linkSystemLibrary("winhttp", .{});
        if (web_engine == .chromium) app_mod.linkSystemLibrary("libcef", .{});
    }
}

/// The vendored WebView2Loader.dll for the target architecture, relative
/// to the framework root.
fn webView2LoaderSubPath(target: std.Build.ResolvedTarget) []const u8 {
    return if (target.result.cpu.arch == .aarch64)
        "third_party/webview2/arm64/WebView2Loader.dll"
    else
        "third_party/webview2/x64/WebView2Loader.dll";
}

/// `zig build run` and `zig build dev` execute the cached artifact, which
/// has no installed WebView2Loader.dll beside it; the vendored loader's
/// directory goes on the step's PATH so the host's LoadLibrary resolves it
/// (`native dev` passes its environment on to the app it spawns). A
/// native-only build never loads the library, so its PATH stays clean.
fn addWebView2RuntimeRunFiles(b: *std.Build, target: std.Build.ResolvedTarget, run: *std.Build.Step.Run, web_engine: WebEngineOption, web_layer: bool, native_sdk_path: []const u8) void {
    if (web_engine != .system) return;
    if (!web_layer) return;
    if (target.result.os.tag != .windows) return;
    const loader_dir = std.fs.path.dirname(webView2LoaderSubPath(target)).?;
    run.addPathDir(b.pathFromRoot(b.pathJoin(&.{ native_sdk_path, loader_dir })));
}

fn addCefRuntimeRunFiles(b: *std.Build, target: std.Build.ResolvedTarget, run: *std.Build.Step.Run, exe: *std.Build.Step.Compile, web_engine: WebEngineOption, cef_dir: []const u8) void {
    if (web_engine != .chromium) return;
    if (target.result.os.tag != .macos) return;
    const copy = b.addSystemCommand(&.{ "sh", "-c", b.fmt(
        \\set -e
        \\exe="$0"
        \\exe_dir="$(dirname "$exe")"
        \\rm -rf "zig-out/Frameworks/Chromium Embedded Framework.framework" "zig-out/bin/Frameworks/Chromium Embedded Framework.framework" ".zig-cache/o/Frameworks/Chromium Embedded Framework.framework" &&
        \\mkdir -p "zig-out/Frameworks" "zig-out/bin/Frameworks" ".zig-cache/o/Frameworks" "$exe_dir" &&
        \\cp -R "{s}/Release/Chromium Embedded Framework.framework" "zig-out/Frameworks/" &&
        \\cp -R "{s}/Release/Chromium Embedded Framework.framework" "zig-out/bin/Frameworks/" &&
        \\cp -R "{s}/Release/Chromium Embedded Framework.framework" ".zig-cache/o/Frameworks/" &&
        \\cp "{s}/Release/Chromium Embedded Framework.framework/Libraries/libEGL.dylib" "$exe_dir/" &&
        \\cp "{s}/Release/Chromium Embedded Framework.framework/Libraries/libGLESv2.dylib" "$exe_dir/" &&
        \\cp "{s}/Release/Chromium Embedded Framework.framework/Libraries/libvk_swiftshader.dylib" "$exe_dir/" &&
        \\cp "{s}/Release/Chromium Embedded Framework.framework/Libraries/vk_swiftshader_icd.json" "$exe_dir/"
    , .{ cef_dir, cef_dir, cef_dir, cef_dir, cef_dir, cef_dir, cef_dir }) });
    copy.addFileArg(exe.getEmittedBin());
    run.step.dependOn(&copy.step);
}

fn addCefCheck(b: *std.Build, target: std.Build.ResolvedTarget, cef_dir: []const u8) *std.Build.Step.Run {
    const script = switch (target.result.os.tag) {
        .macos => b.fmt(
        \\test -f "{s}/include/cef_app.h" &&
        \\test -d "{s}/Release/Chromium Embedded Framework.framework" &&
        \\test -f "{s}/libcef_dll_wrapper/libcef_dll_wrapper.a" || {{
        \\  echo "missing CEF dependency for -Dweb-engine=chromium" >&2
        \\  echo "Expected:" >&2
        \\  echo "  {s}/include/cef_app.h" >&2
        \\  echo "  {s}/Release/Chromium Embedded Framework.framework" >&2
        \\  echo "  {s}/libcef_dll_wrapper/libcef_dll_wrapper.a" >&2
        \\  echo "Fix with: native cef install --dir {s}" >&2
        \\  echo "Or rerun with: -Dcef-auto-install=true" >&2
        \\  echo "Pass -Dcef-dir=/path/to/cef if your bundle lives elsewhere." >&2
        \\  exit 1
        \\}}
        , .{ cef_dir, cef_dir, cef_dir, cef_dir, cef_dir, cef_dir, cef_dir }),
        .linux => b.fmt(
        \\test -f "{s}/include/cef_app.h" &&
        \\test -f "{s}/Release/libcef.so" &&
        \\test -f "{s}/libcef_dll_wrapper/libcef_dll_wrapper.a" || {{
        \\  echo "missing CEF dependency for -Dweb-engine=chromium" >&2
        \\  echo "Fix with: native cef install --dir {s}" >&2
        \\  exit 1
        \\}}
        , .{ cef_dir, cef_dir, cef_dir, cef_dir }),
        .windows => b.fmt(
        \\test -f "{s}/include/cef_app.h" &&
        \\test -f "{s}/Release/libcef.dll" &&
        \\test -f "{s}/libcef_dll_wrapper/libcef_dll_wrapper.lib" || {{
        \\  echo "missing CEF dependency for -Dweb-engine=chromium" >&2
        \\  echo "Fix with: native cef install --dir {s}" >&2
        \\  exit 1
        \\}}
        , .{ cef_dir, cef_dir, cef_dir, cef_dir }),
        else => "echo unsupported CEF target >&2; exit 1",
    };
    return b.addSystemCommand(&.{ "sh", "-c", script });
}

fn packageSuffix(target: PackageTarget) []const u8 {
    return switch (target) {
        .macos => ".app",
        .windows, .linux => "",
    };
}

/// What this build graph reads out of app.zon: the web-engine/CEF
/// knobs and the web-layer inference inputs. An unreadable or
/// unparsable manifest falls back to the system engine WITH the web
/// layer kept — over-inclusion is a size cost, wrong exclusion is a
/// broken app.
const AppManifestBuildConfig = struct {
    web_engine: WebEngineOption = .system,
    cef_dir: []const u8 = "third_party/cef/macos",
    cef_auto_install: bool = false,
    webview_layer: WebLayerOption = .auto,
    dock_visible: bool = true,
    microphone_permission: bool = false,
    system_audio_permission: bool = false,
    sqlite_capability: bool = false,
    relational_capability: bool = false,
    updates_enabled: bool = false,
    version: []const u8 = "0.0.0",
    /// The first web declaration found (for teaching messages), or
    /// null when app.zon declares no web use. `web_engine = "system"`
    /// alone is NOT web intent — it is the default in many canvas
    /// manifests.
    web_declaration: ?[]const u8 = null,
};

/// The lenient app.zon shape parsed for inference: only the fields
/// that decide the web layer and the web engine; everything else is
/// ignored. Full schema validation stays with `native validate`.
const InferenceManifest = struct {
    capabilities: []const []const u8 = &.{},
    permissions: []const []const u8 = &.{},
    dock_visible: bool = true,
    web_engine: []const u8 = "system",
    webview_layer: []const u8 = "auto",
    cef: struct {
        dir: []const u8 = "third_party/cef/macos",
        auto_install: bool = false,
    } = .{},
    frontend: ?struct {} = null,
    updates: ?struct {} = null,
    version: []const u8 = "0.0.0",
    shell: struct {
        windows: []const struct {
            views: []const struct {
                kind: []const u8 = "",
            } = &.{},
        } = &.{},
    } = .{},
};

fn defaultCefDir(platform: PlatformOption, configured: []const u8) []const u8 {
    if (!std.mem.eql(u8, configured, "third_party/cef/macos")) return configured;
    return switch (platform) {
        .linux => "third_party/cef/linux",
        .windows => "third_party/cef/windows",
        else => configured,
    };
}

fn appManifestBuildConfig(b: *std.Build) AppManifestBuildConfig {
    // The fallback for a manifest this lenient parse cannot read
    // keeps the web layer (see AppManifestBuildConfig): a shape
    // mismatch here is not proof the app declares no web use.
    const fallback: AppManifestBuildConfig = .{ .web_declaration = "an app.json this build graph could not parse" };
    const source = @embedFile("app.json");
    @setEvalBranchQuota(4000);
    const raw = std.json.parseFromSliceLeaky(InferenceManifest, b.allocator, source, .{ .ignore_unknown_fields = true }) catch return fallback;
    var config: AppManifestBuildConfig = .{
        .web_engine = parseWebEngine(raw.web_engine) orelse .system,
        .cef_dir = raw.cef.dir,
        .cef_auto_install = raw.cef.auto_install,
        .webview_layer = parseWebLayer(raw.webview_layer) orelse @panic("app.zon .webview_layer must be \"auto\", \"include\", or \"exclude\""),
        .dock_visible = raw.dock_visible,
        .microphone_permission = hasManifestPermission(raw.permissions, "microphone"),
        .system_audio_permission = hasManifestPermission(raw.permissions, "system_audio"),
        .sqlite_capability = hasManifestCapability(raw.capabilities, "store") or hasManifestCapability(raw.capabilities, "sqlite"),
        .relational_capability = hasManifestCapability(raw.capabilities, "sqlite"),
        .updates_enabled = raw.updates != null,
        .version = raw.version,
    };
    config.web_declaration = blk: {
        if (raw.frontend != null) break :blk "a .frontend block";
        for (raw.capabilities) |capability| {
            if (std.mem.eql(u8, capability, "webview")) break :blk "the \"webview\" capability";
        }
        for (raw.shell.windows) |window| {
            for (window.views) |view| {
                if (std.mem.eql(u8, view.kind, "webview")) break :blk "a .shell webview view";
            }
        }
        break :blk null;
    };
    return config;
}

fn appManifestModule(b: *std.Build) *std.Build.Module {
    const root = std.json.parseFromSliceLeaky(std.json.Value, b.allocator, @embedFile("app.json"), .{ .parse_numbers = false }) catch
        @panic("cannot parse app.json; run `native check` for a precise diagnostic");
    if (root != .object) @panic("app.json must contain one object");
    var out = std.Io.Writer.Allocating.init(b.allocator);
    writeManifestValue(&out.writer, root, 0) catch |err| switch (err) {
        error.NullNotAllowed => @panic("app.json cannot contain null values; omit optional fields instead"),
        else => @panic("out of memory converting app.json"),
    };
    const generated = b.addWriteFiles().add("app_manifest.zon", out.written());
    return b.createModule(.{ .root_source_file = generated });
}

fn writeManifestValue(writer: *std.Io.Writer, value: std.json.Value, depth: usize) !void {
    switch (value) {
        .null => return error.NullNotAllowed,
        .bool => |v| try writer.writeAll(if (v) "true" else "false"),
        .integer => |v| try writer.print("{d}", .{v}),
        .float => |v| try writer.print("{d}", .{v}),
        .number_string => |v| try writer.writeAll(v),
        .string => |v| try writer.print("\"{f}\"", .{std.zig.fmtString(v)}),
        .array => |array| {
            try writer.writeAll(".{");
            for (array.items) |item| {
                try writeManifestValue(writer, item, depth + 1);
                try writer.writeByte(',');
            }
            try writer.writeByte('}');
        },
        .object => |object| {
            try writer.writeAll(".{");
            var iterator = object.iterator();
            while (iterator.next()) |entry| {
                if (depth == 0 and std.mem.eql(u8, entry.key_ptr.*, "$schema")) continue;
                try writer.print(".{f}=", .{std.zig.fmtId(entry.key_ptr.*)});
                try writeManifestValue(writer, entry.value_ptr.*, depth + 1);
                try writer.writeByte(',');
            }
            try writer.writeByte('}');
        },
    }
}

fn hasManifestPermission(permissions: []const []const u8, name: []const u8) bool {
    for (permissions) |permission| {
        if (std.mem.eql(u8, permission, name)) return true;
    }
    return false;
}

fn hasManifestCapability(capabilities: []const []const u8, name: []const u8) bool {
    for (capabilities) |capability| {
        if (std.mem.eql(u8, capability, name)) return true;
    }
    return false;
}

/// The web-layer decision for this build — the same declare-to-use
/// contract the Native SDK's standard build graph, CLI, and runner
/// apply: an app is WEB when app.zon declares web use (a .frontend
/// block, the "webview" capability, a .shell webview view) or the
/// build resolves to the Chromium engine; otherwise it is
/// NATIVE-ONLY and the platform host compiles without the
/// embedded-WebView layer. `.webview_layer` (and `-Dweb-layer`)
/// override the inference — but an exclude that contradicts a web
/// declaration is a hard configure error, never a silently broken
/// app.
fn resolveWebLayer(config: AppManifestBuildConfig, web_engine: WebEngineOption, override: ?WebLayerOption) bool {
    const setting = override orelse config.webview_layer;
    const declaration: ?[]const u8 = config.web_declaration orelse
        (if (web_engine == .chromium) "the Chromium web engine" else null);
    return switch (setting) {
        .include => true,
        .auto => declaration != null,
        .exclude => {
            if (declaration) |reason| {
                std.debug.panic(
                    "the web layer is excluded ({s}) but the app declares web use ({s}); remove the exclude or drop the web declaration",
                    .{ if (override != null) "-Dweb-layer=exclude" else "app.zon .webview_layer = \"exclude\"", reason },
                );
            }
            return false;
        },
    };
}

fn parseWebEngine(value: []const u8) ?WebEngineOption {
    if (std.mem.eql(u8, value, "system")) return .system;
    if (std.mem.eql(u8, value, "chromium")) return .chromium;
    return null;
}

fn parseWebLayer(value: []const u8) ?WebLayerOption {
    if (std.mem.eql(u8, value, "auto")) return .auto;
    if (std.mem.eql(u8, value, "include")) return .include;
    if (std.mem.eql(u8, value, "exclude")) return .exclude;
    return null;
}
