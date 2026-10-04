const std = @import("std");
const builtin = @import("builtin");
const build_options = @import("build_options");
const runner = @import("runner");
const native_sdk = @import("native_sdk");
const journal = @import("journal.zig");
const import_mod = @import("import.zig");
const export_mod = @import("export.zig");
const keychain = @import("keychain.zig");
const lock_mod = @import("lock.zig");
const menu = @import("menu.zig");
const session_lock = @import("session_lock.zig");
const ollama = @import("ollama.zig");
const touchid = @import("touchid.zig");
const vault_mod = @import("vault.zig");
const window_chrome = @import("window.zig");
const agent_server = @import("agent_server.zig");
const eve_sidecar = @import("eve_sidecar.zig");
const dream = @import("dream.zig");
const memory_feature = @import("memory_feature.zig");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

// Keep command names, the packaged origins, and external-link prefixes in
// sync with app.json (`bridge.commands` and `security.navigation`).
// `make dev` sets NATIVE_SDK_MODE=dev and adds the Vite origin then.
// `zero://inline` is the automation server's origin for bridge round-trips;
// only builds compiled with -Dautomation=true carry it, so smoke tests can
// drive the bridge without widening the packaged app's policy.
const app_origin = "zero://app";
const vite_origin = "http://127.0.0.1:5173";
const inline_origin = "zero://inline";
const navigation_origins_packaged = [_][]const u8{app_origin};
const navigation_origins_dev = [_][]const u8{ app_origin, vite_origin };
const bridge_origins_app = [_][]const u8{app_origin};
const bridge_origins_app_inline = [_][]const u8{ app_origin, inline_origin };
const bridge_origins_dev = [_][]const u8{ app_origin, vite_origin };
const bridge_origins_dev_inline = [_][]const u8{ app_origin, vite_origin, inline_origin };
const external_link_urls = [_][]const u8{
    "https://canirun.ai",
    "https://canirun.ai/*",
    "https://www.canirun.ai",
    "https://www.canirun.ai/*",
};
const command_names = [_][]const u8{
    "journal.list",
    "journal.get",
    "home.feed",
    "journal.search",
    "journal.save",
    "journal.delete",
    "journal.readFile",
    "journal.importDialog",
    "journal.export",
    "journal.exportDialog",
    "data.counts",
    "data.deleteEntries",
    "data.deleteConversations",
    "data.deleteEmbeddings",
    "data.deleteMemories",
    "data.deleteAll",
    "embeddings.status",
    "embeddings.generate",
    "embeddings.pending",
    "dream.start",
    "dream.status",
    "memory.list",
    "memory.search",
    "memory.save",
    "memory.delete",
    "features.get",
    "window.drag",
    "window.alignTitlebar",
    "lock.status",
    "lock.setIdleTimeout",
    "lock.unlock",
    "lock.unlockTouchId",
    "lock.unlockRecoveryKey",
    "lock.setPassword",
    "lock.removePassword",
    "lock.disable",
    "lock.setTouchId",
    "encryption.enable",
    "encryption.disable",
    "encryption.newRecoveryKey",
    "encryption.saveRecoveryKey",
    "encryption.scrub",
    "chat.list",
    "chat.search",
    "chat.get",
    "chat.save",
    "chat.savePrefs",
    "chat.rename",
    "chat.delete",
    "chat.agent",
    "chat.agentToken",
    "agent.instructions.get",
    "agent.instructions.save",
    "ollama.models",
    "ollama.start",
    "ollama.pull",
    "ollama.pulls",
    "ollama.pullCancel",
    "ollama.delete",
    "system.hardware",
};
const async_handler_count = 13;

fn navigationOrigins(dev_mode: bool) []const []const u8 {
    if (dev_mode) return &navigation_origins_dev;
    return &navigation_origins_packaged;
}

fn bridgeOrigins(dev_mode: bool) []const []const u8 {
    if (dev_mode and build_options.automation) return &bridge_origins_dev_inline;
    if (dev_mode) return &bridge_origins_dev;
    if (build_options.automation) return &bridge_origins_app_inline;
    return &bridge_origins_app;
}

fn commandPolicy(dev_mode: bool, out: []native_sdk.BridgeCommandPolicy) []const native_sdk.BridgeCommandPolicy {
    const origins = bridgeOrigins(dev_mode);
    std.debug.assert(out.len == command_names.len);
    for (command_names, out) |name, *slot| {
        slot.* = .{ .name = name, .origins = origins };
    }
    return out;
}

fn originListed(origins: []const []const u8, origin: []const u8) bool {
    for (origins) |allowed| {
        if (std.mem.eql(u8, allowed, origin)) return true;
    }
    return false;
}

test "packaged policy does not trust the vite origin" {
    try std.testing.expect(originListed(navigationOrigins(false), app_origin));
    try std.testing.expect(!originListed(navigationOrigins(false), vite_origin));
    try std.testing.expect(originListed(navigationOrigins(true), vite_origin));
    try std.testing.expect(!originListed(bridgeOrigins(false), vite_origin));
    try std.testing.expect(originListed(bridgeOrigins(false), app_origin));
    try std.testing.expect(originListed(bridgeOrigins(true), vite_origin));
    if (build_options.automation) {
        try std.testing.expect(originListed(bridgeOrigins(false), inline_origin));
        try std.testing.expect(originListed(bridgeOrigins(true), inline_origin));
    } else {
        try std.testing.expect(!originListed(bridgeOrigins(false), inline_origin));
        try std.testing.expect(!originListed(bridgeOrigins(true), inline_origin));
    }
    for (external_link_urls) |url| {
        try std.testing.expect(std.mem.indexOf(u8, url, vite_origin) == null);
    }

    var policy: [command_names.len]native_sdk.BridgeCommandPolicy = undefined;
    for (commandPolicy(false, &policy)) |command| {
        try std.testing.expect(!originListed(command.origins, vite_origin));
        try std.testing.expect(originListed(command.origins, app_origin));
    }
    for (commandPolicy(true, &policy)) |command| {
        try std.testing.expect(originListed(command.origins, vite_origin));
    }
}

test "app.json lists the packaged origin only" {
    const raw = try std.Io.Dir.cwd().readFileAlloc(
        std.testing.io,
        "app.json",
        std.testing.allocator,
        .limited(64 * 1024),
    );
    defer std.testing.allocator.free(raw);
    const parsed = try std.json.parseFromSlice(
        std.json.Value,
        std.testing.allocator,
        raw,
        .{ .allocate = .alloc_always },
    );
    defer parsed.deinit();
    const root = parsed.value;
    try std.testing.expect(root == .object);

    const dev_url = root.object.get("frontend").?.object.get("dev").?.object.get("url").?;
    try std.testing.expect(dev_url == .string);
    try std.testing.expect(std.mem.startsWith(u8, dev_url.string, vite_origin));

    const allowed = root.object.get("security").?.object.get("navigation").?.object.get("allowed_origins").?;
    try std.testing.expect(allowed == .array);
    try std.testing.expectEqual(@as(usize, 1), allowed.array.items.len);
    try std.testing.expectEqualStrings(app_origin, allowed.array.items[0].string);

    const external = root.object.get("security").?.object.get("navigation").?.object.get("external_links").?.object.get("allowed_urls").?;
    try std.testing.expect(external == .array);
    for (external.array.items) |url| {
        try std.testing.expect(url == .string);
        try std.testing.expect(std.mem.indexOf(u8, url.string, vite_origin) == null);
    }

    const commands = root.object.get("bridge").?.object.get("commands").?;
    try std.testing.expect(commands == .array);
    try std.testing.expectEqual(command_names.len, commands.array.items.len);
    for (commands.array.items, command_names) |command, name| {
        try std.testing.expect(command == .object);
        const command_name = command.object.get("name").?;
        try std.testing.expectEqualStrings(name, command_name.string);
        const origins = command.object.get("origins").?;
        try std.testing.expect(origins == .array);
        try std.testing.expectEqual(@as(usize, 1), origins.array.items.len);
        try std.testing.expectEqualStrings(app_origin, origins.array.items[0].string);
    }
}

const App = struct {
    env_map: *std.process.Environ.Map,
    io: std.Io,
    app_id: [:0]const u8,
    store: journal.Store,
    lock: lock_mod.Lock,
    vault: vault_mod.Vault,
    lock_queue: *LockQueue,
    services: ?native_sdk.platform.PlatformServices = null,
    runtime: ?*native_sdk.Runtime = null,
    lock_job: ?*LockJob = null,
    /// The recovery key Sage just generated, normalized. It waits here until
    /// `encryption.enable` or `encryption.saveRecoveryKey` is called with the
    /// same text, so the web view can show a key but never choose one. Zeroed
    /// after use and when the session locks.
    recovery_candidate: ?[vault_mod.recovery_key_len]u8 = null,
    /// Whether FileVault is on, read with `fdesetup`. `on` is kept; `off` is
    /// read again after a while, so turning FileVault on clears the warning.
    file_vault: ?lock_mod.FileVault = null,
    file_vault_read_ms: i64 = 0,
    handlers: [command_names.len - async_handler_count]native_sdk.BridgeHandler = undefined,
    command_policy: [command_names.len]native_sdk.BridgeCommandPolicy = undefined,
    async_handlers: [async_handler_count]native_sdk.bridge.AsyncHandler = undefined,
    embed_queue: *EmbedQueue,
    dream_queue: *dream.Queue,
    dream_runner: dream.Runner = .{},
    agent_queue: *agent_server.Queue,
    agent: agent_server.Server = .{},
    eve: eve_sidecar.Sidecar = .{},
    data_dir: []const u8 = &.{},
    memory_mode_ready: bool = false,
    models: ollama.ModelPrefixes = .{},
    /// Copies of the vault flags, set at launch and whenever a handler
    /// persists a change. Any pending flag means the journal is still securing.
    rewrite_pending: bool = false,
    disable_pending: bool = false,
    scrub_pending: bool = false,
    pull_state: ollama.PullState = .{},
    pull_abort: ollama.Abort = .{ .io = undefined },
    /// The folder the export picker returned, if the user has picked one and
    /// has not exported yet. `journal.export` accepts this folder and nothing
    /// else, so the web view cannot choose where the journal lands.
    export_picked: export_mod.PickedFolder = .{},
    /// The exact paths returned by the most recent import picker. The web view
    /// gets these paths to drive the import UI, but only this core copy grants
    /// journal.readFile access.
    import_picked_paths: [native_sdk.platform.max_dialog_paths_bytes]u8 = undefined,
    import_picked_paths_len: usize = 0,

    fn app(self: *@This()) native_sdk.App {
        return .{
            .context = self,
            .name = "Sage",
            .source = native_sdk.frontend.productionSource(.{ .dist = "frontend/dist" }),
            .source_fn = source,
            .start_fn = start,
            .stop_fn = stop,
            .event_fn = onEvent,
        };
    }

    fn source(context: *anyopaque) anyerror!native_sdk.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return native_sdk.frontend.sourceFromEnv(self.env_map, .{
            .dist = "frontend/dist",
            .entry = "index.html",
        });
    }

    fn start(context: *anyopaque, runtime: *native_sdk.Runtime) anyerror!void {
        const self: *App = @ptrCast(@alignCast(context));
        self.services = runtime.options.platform.services;
        self.runtime = runtime;
        menu.install(self, .{
            .on_export = onExport,
            .on_import = onImport,
            .on_settings = onOpenSettings,
            .on_lock = onSessionLock,
        });
        self.syncLockMenu();
        session_lock.install(self.io, self, .{
            .on_lock = onSessionLock,
            .idle_timeout_ms = idleTimeoutForSession,
        });
        const packaged = if (self.env_map.get("NATIVE_SDK_MODE")) |mode|
            !std.mem.eql(u8, mode, "dev")
        else
            true;
        const has_data_dir_override = if (self.env_map.get("SAGE_DATA_DIR")) |override|
            override.len > 0
        else
            false;
        const launch_chat = packagedChatStartsAtLaunch(packaged, self.lock.unlocked, isSecuring(self));
        var memory_mode_ready = false;
        if (self.lock.unlocked and !isSecuring(self)) {
            syncMemoryFeatureMode(self) catch |err| {
                std.log.err("memory feature transition failed: {s}", .{@errorName(err)});
            };
            memory_mode_ready = self.memory_mode_ready;
        }
        self.memory_mode_ready = memory_mode_ready;
        agent_server.start(
            &self.agent,
            std.heap.page_allocator,
            self.data_dir,
            self.agent_queue,
            .{ .context = self, .wake_fn = wakeAgentQueue },
            .{
                .write_discovery = !packaged or has_data_dir_override,
                .peer_check = packaged and !has_data_dir_override,
                .memory_enabled = build_options.memory_enabled,
                .available = memory_mode_ready,
            },
        ) catch |err| {
            std.log.err("agent server failed to start: {s}", .{@errorName(err)});
        };
        if (self.agent.started) {
            self.eve.agent_token_hex = &self.agent.token_hex;
            self.eve.expected_pid = &self.agent.expected_pid;
            self.eve.start(
                std.heap.page_allocator,
                self.io,
                self.data_dir,
                self.env_map,
                packaged,
                launch_chat and memory_mode_ready,
            );
            if (launch_chat and !memory_mode_ready) {
                self.eve.setUnavailable("Chat is unavailable because Sage could not reset old memory sessions.");
            }
        }
    }

    fn stop(context: *anyopaque, runtime: *native_sdk.Runtime) anyerror!void {
        _ = runtime;
        const self: *App = @ptrCast(@alignCast(context));
        self.eve.stop();
    }

    fn syncLockMenu(self: *App) void {
        menu.setLockItemEnabled(self.lock.unlocked);
    }

    fn onSessionLock(context: *anyopaque) void {
        const self: *App = @ptrCast(@alignCast(context));
        sessionLock(self);
    }

    fn idleTimeoutForSession(context: *anyopaque) i64 {
        const self: *App = @ptrCast(@alignCast(context));
        return self.lock.idle_timeout_ms;
    }

    /// Fired from Sage > Settings, on the loop thread.
    fn onOpenSettings(context: *anyopaque) void {
        emitMainWindowEvent(context, "settings:open");
    }

    /// Fired from File > Import, on the loop thread.
    fn onImport(context: *anyopaque) void {
        emitMainWindowEvent(context, "journal:import");
    }

    /// Fired from File > Export, on the loop thread.
    fn onExport(context: *anyopaque) void {
        emitMainWindowEvent(context, "journal:export");
    }

    fn emitMainWindowEvent(context: *anyopaque, name: []const u8) void {
        const self: *App = @ptrCast(@alignCast(context));
        const runtime = self.runtime orelse return;
        runtime.emitWindowEvent(1, name, "{}") catch {};
    }

    fn onEvent(context: *anyopaque, runtime: *native_sdk.Runtime, event: native_sdk.Event) anyerror!void {
        const self: *App = @ptrCast(@alignCast(context));
        switch (event) {
            // An embeddings worker or the Touch ID prompt finished; complete
            // its job here, on the loop thread, where the database and
            // bridge responders live.
            .effects_wake => {
                drainEmbedJobs(self);
                drainDreamJobs(self);
                drainLockJobs(self);
                drainAgentJobs(self);
            },
            // Menu item IMPs emit window events directly; these command
            // names exist so automation can drive the same actions.
            // Use app.import / app.export here, not journal.export — that
            // name already belongs to the export-to-folder bridge command.
            .command => |command| {
                if (std.mem.eql(u8, command.name, "app.lock")) {
                    sessionLock(self);
                } else if (std.mem.eql(u8, command.name, "app.settings")) {
                    try runtime.emitWindowEvent(1, "settings:open", "{}");
                } else if (std.mem.eql(u8, command.name, "app.import")) {
                    try runtime.emitWindowEvent(1, "journal:import", "{}");
                } else if (std.mem.eql(u8, command.name, "app.export")) {
                    try runtime.emitWindowEvent(1, "journal:export", "{}");
                }
            },
            .lifecycle => |phase| {
                if (phase == .stop) {
                    self.eve.stop();
                }
            },
            else => {},
        }
    }

    fn bridge(self: *@This(), dev_mode: bool) native_sdk.BridgeDispatcher {
        const commands = commandPolicy(dev_mode, &self.command_policy);
        self.handlers = .{
            .{ .name = "journal.list", .context = self, .invoke_fn = handleList },
            .{ .name = "journal.get", .context = self, .invoke_fn = handleGet },
            .{ .name = "home.feed", .context = self, .invoke_fn = handleHomeFeed },
            .{ .name = "journal.search", .context = self, .invoke_fn = handleSearch },
            .{ .name = "journal.save", .context = self, .invoke_fn = handleSave },
            .{ .name = "journal.delete", .context = self, .invoke_fn = handleDelete },
            .{ .name = "journal.readFile", .context = self, .invoke_fn = handleReadFile },
            .{ .name = "journal.importDialog", .context = self, .invoke_fn = handleImportDialog },
            .{ .name = "journal.export", .context = self, .invoke_fn = handleExport },
            .{ .name = "journal.exportDialog", .context = self, .invoke_fn = handleExportDialog },
            .{ .name = "data.counts", .context = self, .invoke_fn = handleDataCounts },
            .{ .name = "data.deleteEntries", .context = self, .invoke_fn = handleDataDeleteEntries },
            .{ .name = "data.deleteConversations", .context = self, .invoke_fn = handleDataDeleteConversations },
            .{ .name = "data.deleteEmbeddings", .context = self, .invoke_fn = handleDataDeleteEmbeddings },
            .{ .name = "data.deleteMemories", .context = self, .invoke_fn = handleDataDeleteMemories },
            .{ .name = "data.deleteAll", .context = self, .invoke_fn = handleDataDeleteAll },
            .{ .name = "embeddings.pending", .context = self, .invoke_fn = handleEmbeddingsPending },
            .{ .name = "dream.status", .context = self, .invoke_fn = handleDreamStatus },
            .{ .name = "memory.list", .context = self, .invoke_fn = handleMemoryList },
            .{ .name = "memory.search", .context = self, .invoke_fn = handleMemorySearch },
            .{ .name = "memory.delete", .context = self, .invoke_fn = handleMemoryDelete },
            .{ .name = "features.get", .context = self, .invoke_fn = handleFeaturesGet },
            .{ .name = "window.drag", .context = self, .invoke_fn = handleWindowDrag },
            .{ .name = "window.alignTitlebar", .context = self, .invoke_fn = handleAlignTitlebar },
            .{ .name = "lock.status", .context = self, .invoke_fn = handleLockStatus },
            .{ .name = "lock.setIdleTimeout", .context = self, .invoke_fn = handleLockSetIdleTimeout },
            .{ .name = "lock.unlock", .context = self, .invoke_fn = handleLockUnlock },
            .{ .name = "lock.unlockRecoveryKey", .context = self, .invoke_fn = handleLockUnlockRecoveryKey },
            .{ .name = "lock.removePassword", .context = self, .invoke_fn = handleLockRemovePassword },
            .{ .name = "encryption.enable", .context = self, .invoke_fn = handleEncryptionEnable },
            .{ .name = "encryption.saveRecoveryKey", .context = self, .invoke_fn = handleEncryptionSaveRecoveryKey },
            .{ .name = "encryption.scrub", .context = self, .invoke_fn = handleEncryptionScrub },
            .{ .name = "chat.list", .context = self, .invoke_fn = handleChatList },
            .{ .name = "chat.search", .context = self, .invoke_fn = handleChatSearch },
            .{ .name = "chat.get", .context = self, .invoke_fn = handleChatGet },
            .{ .name = "chat.save", .context = self, .invoke_fn = handleChatSave },
            .{ .name = "chat.savePrefs", .context = self, .invoke_fn = handleChatSavePrefs },
            .{ .name = "chat.rename", .context = self, .invoke_fn = handleChatRename },
            .{ .name = "chat.delete", .context = self, .invoke_fn = handleChatDelete },
            .{ .name = "chat.agent", .context = self, .invoke_fn = handleChatAgent },
            .{ .name = "chat.agentToken", .context = self, .invoke_fn = handleChatAgentToken },
            .{ .name = "agent.instructions.get", .context = self, .invoke_fn = handleAgentInstructionsGet },
            .{ .name = "agent.instructions.save", .context = self, .invoke_fn = handleAgentInstructionsSave },
            .{ .name = "system.hardware", .context = self, .invoke_fn = handleSystemHardware },
            .{ .name = "ollama.pull", .context = self, .invoke_fn = handleOllamaPull },
            .{ .name = "ollama.pulls", .context = self, .invoke_fn = handleOllamaPulls },
            .{ .name = "ollama.pullCancel", .context = self, .invoke_fn = handleOllamaPullCancel },
        };
        self.async_handlers = .{
            .{ .name = "embeddings.status", .context = self, .invoke_fn = handleEmbeddingsStatus },
            .{ .name = "embeddings.generate", .context = self, .invoke_fn = handleEmbeddingsGenerate },
            .{ .name = "dream.start", .context = self, .invoke_fn = handleDreamStart },
            .{ .name = "memory.save", .context = self, .invoke_fn = handleMemorySave },
            .{ .name = "lock.unlockTouchId", .context = self, .invoke_fn = handleUnlockTouchId },
            .{ .name = "lock.setPassword", .context = self, .invoke_fn = handleLockSetPassword },
            .{ .name = "lock.disable", .context = self, .invoke_fn = handleLockDisable },
            .{ .name = "lock.setTouchId", .context = self, .invoke_fn = handleLockSetTouchId },
            .{ .name = "encryption.disable", .context = self, .invoke_fn = handleEncryptionDisable },
            .{ .name = "encryption.newRecoveryKey", .context = self, .invoke_fn = handleEncryptionNewRecoveryKey },
            .{ .name = "ollama.models", .context = self, .invoke_fn = handleOllamaModels },
            .{ .name = "ollama.start", .context = self, .invoke_fn = handleOllamaStart },
            .{ .name = "ollama.delete", .context = self, .invoke_fn = handleOllamaDelete },
        };
        return .{
            .policy = .{
                .enabled = true,
                .commands = commands,
            },
            .registry = .{ .handlers = &self.handlers },
            .async_registry = .{ .handlers = &self.async_handlers },
        };
    }
};

/// `fdesetup` answers in milliseconds. A hang costs this much of the loop
/// thread once, and then reads as unknown.
const file_vault_timeout_ms = 2_000;
/// How long an `off` answer is trusted before `fdesetup` runs again.
const file_vault_recheck_ms = 30_000;

/// Whether a cached FileVault answer can be used as is. `on` and `unknown`
/// stay: a failed read will not read better a moment later. `off` expires, so
/// the warning goes away after FileVault is turned on in System Settings.
fn fileVaultCacheFresh(known: lock_mod.FileVault, read_ms: i64, now_ms: i64) bool {
    return known != .off or now_ms - read_ms < file_vault_recheck_ms;
}

fn fileVaultState(self: *App) lock_mod.FileVault {
    const now_ms = std.Io.Clock.Timestamp.now(self.io, .real).raw.toMilliseconds();
    if (self.file_vault) |known| {
        if (fileVaultCacheFresh(known, self.file_vault_read_ms, now_ms)) return known;
    }
    const state = readFileVault(self.store.allocator, self.io);
    self.file_vault = state;
    self.file_vault_read_ms = now_ms;
    return state;
}

/// Runs `fdesetup isactive`, which needs no privileges and prints `true` or
/// `false`. Anything else, a failure to run it, or no answer inside the
/// timeout reads as unknown.
fn readFileVault(allocator: std.mem.Allocator, io: std.Io) lock_mod.FileVault {
    if (builtin.os.tag != .macos) return .unknown;
    const result = std.process.run(allocator, io, .{
        .argv = &.{ "/usr/bin/fdesetup", "isactive" },
        .stderr_limit = .limited(256),
        .stdout_limit = .limited(64),
        .timeout = .{ .duration = .{
            .raw = std.Io.Duration.fromMilliseconds(file_vault_timeout_ms),
            .clock = .awake,
        } },
    }) catch return .unknown;
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    const text = std.mem.trim(u8, result.stdout, " \t\r\n");
    if (std.mem.eql(u8, text, "true")) return .on;
    if (std.mem.eql(u8, text, "false")) return .off;
    return .unknown;
}

/// Lock the current session and clear every in-memory copy of its keys.
fn sessionLock(self: *App) void {
    if (!self.lock.enabled()) {
        App.emitMainWindowEvent(self, "lock:unavailable");
        return;
    }
    if (!self.lock.lockSession()) return;
    touchid.resetContext();
    self.vault.lockMemory();
    wipeRecoveryCandidate(self);
    if (self.agent.started) agent_server.setAvailable(&self.agent, false);
    self.eve.stop();
    self.eve.clearWorldKey();
    self.syncLockMenu();
    App.emitMainWindowEvent(self, "lock:changed");
}

/// Whether `App.start` can spawn packaged Chat. A locked or securing app
/// keeps Chat down until it is unlocked and ready.
fn packagedChatStartsAtLaunch(packaged: bool, unlocked: bool, securing: bool) bool {
    return packaged and unlocked and !securing;
}

// Journal data commands refuse to run while the app lock is engaged. The
// error name is all the web view sees — no titles, bodies, or search
// results leave the process before unlock.
fn requireUnlocked(self: *App) !void {
    if (!self.lock.unlocked) return error.Locked;
}

// Data commands also wait out a pending rewrite or file rebuild so a
// vacuum never races a reader, and mixed plaintext never leaves the process.
fn requireReady(self: *App) !void {
    try requireUnlocked(self);
    if (isSecuring(self)) return error.Securing;
}

fn requireMemoryModeReady(self: *const App) !void {
    if (!self.memory_mode_ready) return error.MemoryModeUnavailable;
}

fn isSecuring(self: *const App) bool {
    return self.rewrite_pending or self.disable_pending or self.scrub_pending;
}

fn markRewritePending(self: *App, on: bool) !void {
    try self.vault.setRewritePending(on);
    self.rewrite_pending = on;
}

fn markScrubPending(self: *App, on: bool) !void {
    try self.vault.setScrubPending(on);
    self.scrub_pending = on;
}

fn syncPendingFlags(self: *App) void {
    self.rewrite_pending = self.vault.rewrite_pending;
    self.disable_pending = self.vault.disable_pending;
    self.scrub_pending = self.vault.scrub_pending;
}

fn markRewriteForPlaintext(self: *App) !void {
    if (!self.vault.enabled or self.disable_pending or self.rewrite_pending) return;
    if (!self.vault.ciphertext_checked) {
        try markRewritePending(self, true);
        return;
    }
    if (try self.store.hasPlaintextProtectedFields()) try markRewritePending(self, true);
}

fn journalAccessBlocked(self: *const App) bool {
    return !self.lock.unlocked or isSecuring(self);
}

fn wakeAgentQueue(context: *anyopaque) void {
    const self: *App = @ptrCast(@alignCast(context));
    if (self.services) |services| services.wake() catch {};
}

fn handleList(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    return self.store.list(output);
}

fn handleHomeFeed(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    return self.store.homeFeed(invocation.request.payload, output);
}

fn handleGet(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    return self.store.get(invocation.request.payload, output);
}

fn handleSearch(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    return self.store.search(invocation.request.payload, output);
}

fn handleSave(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    return self.store.save(invocation.request.payload, output);
}

fn handleDelete(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    return self.store.delete(invocation.request.payload, output);
}

fn handleImportDialog(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    self.import_picked_paths_len = 0;
    try requireReady(self);

    const services = self.services orelse return error.UnsupportedService;
    var paths_buf: [native_sdk.platform.max_dialog_paths_bytes]u8 = undefined;
    const result = try services.showOpenDialog(.{
        .title = "Import markdown files",
        .allow_directories = false,
        .allow_multiple = true,
    }, &paths_buf);

    if (result.count == 0) {
        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("[]");
        return writer.buffered();
    }
    if (result.paths.len > self.import_picked_paths.len) return error.InvalidPath;

    const response = try import_mod.writeDialogPaths(result.paths, @intCast(result.count), output);
    @memcpy(self.import_picked_paths[0..result.paths.len], result.paths);
    self.import_picked_paths_len = result.paths.len;
    return response;
}

fn handleReadFile(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    return import_mod.readFile(
        self.io,
        self.store.allocator,
        invocation.request.payload,
        self.import_picked_paths[0..self.import_picked_paths_len],
        output,
    );
}

/// Runs the folder picker for an export, on the loop thread, and remembers
/// the folder it returned. `journal.export` writes only to that folder, so
/// the answer to "where should the markdown land?" comes from the user
/// instead of from whatever the web view happens to send.
fn handleExportDialog(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireUnlocked(self);
    self.export_picked.forget();

    const services = self.services orelse return error.UnsupportedService;
    var paths_buf: [native_sdk.platform.max_dialog_paths_bytes]u8 = undefined;
    const result = try services.showOpenDialog(.{
        .title = "Choose a folder for the export",
        .allow_directories = true,
        .allow_multiple = false,
    }, &paths_buf);

    var writer = std.Io.Writer.fixed(output);
    if (result.count == 0) {
        try writer.writeAll("{\"path\":null}");
        return writer.buffered();
    }
    const picked = export_mod.firstPath(result.paths) orelse return error.InvalidPath;
    try self.export_picked.remember(picked);
    try writer.writeAll("{\"path\":");
    try journal.writeJsonString(&writer, picked);
    try writer.writeByte('}');
    return writer.buffered();
}

fn handleExport(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    return export_mod.exportData(self.io, &self.store, invocation.request.payload, &self.export_picked, output);
}

fn handleDataCounts(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    return self.store.dataCounts(output);
}

fn handleDataDeleteEntries(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    dream.abortSilent(dreamHost(self));
    return self.store.deleteEntries(output);
}

fn handleDataDeleteConversations(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    dream.abortSilent(dreamHost(self));
    self.eve.stop();
    const result = self.store.deleteConversations(output) catch |err| {
        startEveSidecar(self);
        return err;
    };
    eve_sidecar.wipeWorkflowData(self.io, self.data_dir);
    startEveSidecar(self);
    return result;
}

fn handleDataDeleteEmbeddings(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    dream.abortSilent(dreamHost(self));
    return self.store.deleteEmbeddings(output);
}

fn handleDataDeleteMemories(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    dream.abortSilent(dreamHost(self));
    return self.store.deleteMemories(output);
}

fn handleDataDeleteAll(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    dream.abortSilent(dreamHost(self));
    self.eve.stop();
    const result = self.store.deleteAllData(output) catch |err| {
        startEveSidecar(self);
        return err;
    };
    eve_sidecar.wipeWorkflowData(self.io, self.data_dir);
    startEveSidecar(self);
    return result;
}

fn dreamHost(self: *App) dream.Host {
    return .{
        .store = &self.store,
        .io = self.io,
        .queue = self.dream_queue,
        .runner = &self.dream_runner,
        .services = self.services,
        .runtime = self.runtime,
        .models = self.models,
        .memory_enabled = build_options.memory_enabled,
    };
}

fn handleChatList(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    try requireMemoryModeReady(self);
    return self.store.chatList(output);
}

fn handleChatSearch(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    try requireMemoryModeReady(self);
    return self.store.chatSearch(invocation.request.payload, output);
}

fn handleChatGet(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    try requireMemoryModeReady(self);
    return self.store.chatGet(invocation.request.payload, output);
}

fn handleChatSave(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    try requireMemoryModeReady(self);
    return self.store.chatSave(invocation.request.payload, output);
}

fn handleChatSavePrefs(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    try requireMemoryModeReady(self);
    return self.store.chatSavePrefs(invocation.request.payload, output);
}

fn handleChatRename(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    try requireMemoryModeReady(self);
    return self.store.chatRename(invocation.request.payload, output);
}

fn handleChatDelete(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    try requireMemoryModeReady(self);
    var session_id_buf: [64]u8 = undefined;
    const result = try self.store.chatDelete(invocation.request.payload, output, &session_id_buf);
    if (result.session_id) |session_id| {
        if (self.eve.kind == .ready) {
            if (self.eve.agent_token_hex) |token| {
                eve_sidecar.cancelSession(self.io, session_id, token);
            }
        }
        eve_sidecar.deleteSessionData(self.io, self.data_dir, session_id);
    }
    return result.json;
}

fn handleChatAgentToken(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireUnlocked(self);
    if (!self.memory_mode_ready or !self.agent.started) {
        return std.fmt.bufPrint(output, "{{\"token\":\"\"}}", .{});
    }
    return std.fmt.bufPrint(output, "{{\"token\":\"{s}\"}}", .{self.agent.token_hex[0..]});
}

fn handleChatAgent(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireUnlocked(self);
    syncEveWorldKey(self);
    if (self.memory_mode_ready) {
        self.eve.ensureRunning();
    } else {
        self.eve.setUnavailable("Chat is unavailable because Sage could not reset old memory sessions.");
    }
    return self.eve.writeStatus(output);
}

fn handleAgentInstructionsGet(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    return self.store.agentInstructionsGet(output);
}

fn handleAgentInstructionsSave(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    return self.store.agentInstructionsSave(invocation.request.payload, output);
}

fn handleSystemHardware(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireUnlocked(self);
    const info = ollama.hardwareInfo(self.io, self.store.allocator);
    defer if (info.chip_name.len > 0) self.store.allocator.free(info.chip_name);
    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"chipName\":");
    try journal.writeJsonStringStreaming(&writer, info.chip_name);
    try writer.print(",\"ramGb\":{d},\"cpuCores\":{d}}}", .{ info.ram_gb, info.cpu_cores });
    return writer.buffered();
}

fn handleOllamaPull(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireUnlocked(self);
    var name_buf: [160]u8 = undefined;
    var used: usize = 0;
    const name = journal.jsonString(invocation.request.payload, "name", &name_buf, &used) orelse return error.InvalidRequest;
    if (!ollama.validModelName(name)) return error.InvalidRequest;
    if (!self.pull_state.begin(self.io, name)) return error.DownloadInProgress;

    self.pull_abort = .{ .io = self.io };
    const owned = self.store.allocator.dupe(u8, name) catch {
        self.pull_state.clearActive(self.io);
        return error.OutOfMemory;
    };
    const thread = std.Thread.spawn(.{}, runPullJob, .{ self, owned }) catch {
        self.store.allocator.free(owned);
        self.pull_state.clearActive(self.io);
        return error.OutOfMemory;
    };
    thread.detach();

    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"started\":true}");
    return writer.buffered();
}

fn handleOllamaPulls(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireUnlocked(self);
    var model_buf: [128]u8 = undefined;
    var status_buf: [192]u8 = undefined;
    const snap = self.pull_state.snapshot(self.io, &model_buf, &status_buf);
    var writer = std.Io.Writer.fixed(output);
    if (!snap.present) {
        try writer.writeAll("{\"pull\":null}");
        return writer.buffered();
    }
    try writer.writeAll("{\"pull\":{\"model\":");
    try journal.writeJsonStringStreaming(&writer, snap.model);
    try writer.writeAll(",\"status\":");
    try journal.writeJsonStringStreaming(&writer, snap.status);
    try writer.print(
        ",\"completed\":{d},\"total\":{d},\"done\":{},\"cancelled\":{},\"failed\":{},\"active\":{}}}}}",
        .{ snap.completed, snap.total, snap.done, snap.cancelled, snap.failed, snap.active },
    );
    return writer.buffered();
}

fn handleOllamaPullCancel(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireUnlocked(self);
    self.pull_state.requestCancel(self.io);
    self.pull_abort.fire();
    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"ok\":true}");
    return writer.buffered();
}

fn syncEveWorldKey(self: *App) void {
    if (self.vault.enabled) {
        var data_key = self.vault.dataKey() orelse {
            self.eve.clearWorldKey();
            return;
        };
        defer std.crypto.secureZero(u8, &data_key);
        self.eve.setWorldKeyFromDataKey(&data_key);
        return;
    }
    self.eve.clearWorldKey();
}

fn syncMemoryFeatureMode(self: *App) !void {
    self.memory_mode_ready = false;
    if (self.data_dir.len == 0) {
        self.memory_mode_ready = true;
        return;
    }
    const enabled = build_options.memory_enabled;
    const previous = try memory_feature.read(self.io, self.store.allocator, self.data_dir);
    var current = previous;
    if (memory_feature.needsDisableReset(previous, enabled)) {
        try memory_feature.write(self.io, self.data_dir, .disabling);
        self.eve.stop();
        try wipeMemoryWorkflowData(self);
        try self.store.disableMemoriesAndChats();
        try memory_feature.write(self.io, self.data_dir, .disabled);
        current = .disabled;
    }
    if (memory_feature.needsEnableRefresh(current, enabled)) {
        try memory_feature.write(self.io, self.data_dir, .enabling);
        try self.store.refreshMemoryExtractions();
        current = .enabled;
    } else if (enabled) {
        current = .enabled;
    }
    if (current != previous or previous == .unknown) {
        try memory_feature.write(self.io, self.data_dir, current);
    }
    self.memory_mode_ready = true;
}

fn wipeMemoryWorkflowData(self: *App) !void {
    if (self.env_map.get("NATIVE_SDK_MODE")) |mode| {
        if (std.mem.eql(u8, mode, "dev")) {
            const workflow_dir = self.env_map.get("SAGE_DEV_EVE_WORKFLOW_DIR") orelse
                return error.DevWorkflowDirectoryUnavailable;
            return eve_sidecar.wipeWorkflowDirectoryStrict(self.io, workflow_dir);
        }
    }
    try eve_sidecar.wipeWorkflowDataStrict(self.io, self.data_dir);
}

fn startEveSidecarAfterUnlock(self: *App) void {
    if (!self.lock.unlocked or isSecuring(self)) return;
    syncMemoryFeatureMode(self) catch |err| {
        if (self.agent.started) agent_server.setAvailable(&self.agent, false);
        std.log.err("memory feature transition failed: {s}", .{@errorName(err)});
        self.eve.setUnavailable("Chat is unavailable because Sage could not reset old memory sessions.");
        return;
    };
    if (self.agent.started) agent_server.setAvailable(&self.agent, true);
    syncEveWorldKey(self);
    self.eve.startNow();
}

fn stopAndWipeEveSidecar(self: *App) void {
    self.eve.stop();
    eve_sidecar.wipeWorkflowData(self.io, self.data_dir);
}

fn restartEveSidecar(self: *App) void {
    stopAndWipeEveSidecar(self);
    startEveSidecar(self);
}

fn startEveSidecar(self: *App) void {
    if (self.vault.enabled and !self.lock.unlocked) {
        self.eve.clearWorldKey();
        return;
    }
    syncEveWorldKey(self);
    self.eve.startNow();
}

fn handleEmbeddingsPending(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    return self.store.listPendingEmbeddings(output);
}

fn handleDreamStatus(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    const last = self.store.lastDreamedAt() catch null;
    defer if (last) |text| self.store.allocator.free(text);
    return self.dream_runner.writeStatus(if (last) |text| text else "", output);
}

fn handleFeaturesGet(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    try requireMemoryModeReady(self);
    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll(if (build_options.memory_enabled) "{\"memory\":true}" else "{\"memory\":false}");
    return writer.buffered();
}

fn requireMemoriesEnabled() !void {
    if (!build_options.memory_enabled) return error.MemoryUnavailable;
}

fn handleMemoryList(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    try requireMemoriesEnabled();
    return self.store.listMemories(output);
}

fn handleMemorySearch(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    try requireMemoriesEnabled();
    return self.store.memorySearch(invocation.request.payload, output);
}

fn handleMemoryDelete(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireReady(self);
    try requireMemoriesEnabled();
    var kind_buf: [32]u8 = undefined;
    var used: usize = 0;
    const kind_name = journal.jsonString(invocation.request.payload, "kind", &kind_buf, &used) orelse return error.InvalidRequest;
    const kind = journal.MemoryKind.parse(kind_name) orelse return error.InvalidRequest;
    const id = journal.jsonI64(invocation.request.payload, "id") orelse return error.InvalidRequest;
    try self.store.deleteMemory(kind, id);
    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"ok\":true}");
    return writer.buffered();
}

// --- lock ---

fn handleLockStatus(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    const securing = isSecuring(self);
    const scrubbing = self.scrub_pending and
        (self.lock.unlocked or (!self.rewrite_pending and !self.disable_pending));
    const extra: lock_mod.StatusExtra = .{
        .recovery_key_set = self.vault.enabled and self.vault.hasRecoverySlot(),
        .recovery_key_rotate = self.vault.enabled and self.vault.recovery_rotate,
        .file_vault = fileVaultState(self),
    };
    return self.lock.status(touchid.availability(), self.vault.enabled, securing, scrubbing, extra, output);
}

fn handleLockSetIdleTimeout(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireUnlocked(self);
    const timeout_ms = journal.jsonI64(invocation.request.payload, "idleTimeoutMs") orelse return error.InvalidRequest;
    try self.lock.setIdleTimeout(timeout_ms);
    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"ok\":true}");
    return writer.buffered();
}

fn handleLockUnlock(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    // Verify first, then unwrap the data key, and only then open the lock:
    // if the stored key material cannot be opened, the app stays locked.
    var password_buf: [1024]u8 = undefined;
    var used: usize = 0;
    defer @memset(&password_buf, 0);
    const password = journal.jsonString(invocation.request.payload, "password", &password_buf, &used) orelse return error.InvalidRequest;
    if (password.len == 0) return error.InvalidRequest;
    try self.lock.verifyPassword(password);
    if (self.vault.enabled) try self.vault.unlockWithPassword(password);
    self.lock.unlocked = true;
    session_lock.resetIdleClock();
    self.syncLockMenu();
    startEveSidecarAfterUnlock(self);
    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"ok\":true}");
    return writer.buffered();
}

// The first password on an encrypted journal gives someone a way to open the
// file offline, so it owes a fresh system prompt when Touch ID is the only
// method. An unlock with the recovery key is proof enough: the owner holds the
// key that opens everything, and may have forgotten the password.
fn handleLockSetPassword(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    var output: [64]u8 = undefined;
    // After an unlock with the recovery key, `setPassword` asks for no proof.
    const result = self.lock.setPassword(invocation.request.payload, &self.vault, &output) catch |err| switch (err) {
        error.TouchIdConfirmationRequired => {
            startLockPromptWithPayload(self, invocation, responder, .set_password, invocation.request.payload) catch |prompt_err| {
                respondErrorName(responder, invocation.request.id, prompt_err);
            };
            return;
        },
        else => {
            respondErrorName(responder, invocation.request.id, err);
            return;
        },
    };
    finishPasswordChange(self);
    responder.success(invocation.request.id, result) catch {};
}

/// A password change re-wraps the data key, so the previous wrap still sits in
/// the file until the rebuild. A failed rebuild is not a failed change: the new
/// password is already saved, so the command reports ok and the securing
/// screen retries through `encryption.scrub`.
fn finishPasswordChange(self: *App) void {
    self.syncLockMenu();
    scrubAfterKeyChange(self);
    startEveSidecarAfterUnlock(self);
}

fn scrubAfterKeyChange(self: *App) void {
    if (self.vault.scrub_pending and !self.rewrite_pending and !self.disable_pending) {
        self.scrub_pending = true;
        self.store.scrubStorage() catch return;
        markScrubPending(self, false) catch return;
    }
}

fn setPasswordAfterPrompt(self: *App, job: *LockJob) void {
    const payload = job.payload orelse {
        respondErrorName(job.responder, job.request_id, error.InvalidRequest);
        return;
    };
    var output: [64]u8 = undefined;
    const result = self.lock.setPasswordTrusted(payload, &self.vault, &output) catch |err| {
        respondErrorName(job.responder, job.request_id, err);
        return;
    };
    finishPasswordChange(self);
    job.responder.success(job.request_id, result) catch {};
}

/// Unlock with the recovery key, for a journal whose Keychain copy is gone or
/// whose owner forgot the password. The key shares the password's wrong-guess
/// count and wait, so switching between them buys a guesser nothing. Once in,
/// Sage puts the data key back in the Keychain and owes a new recovery key,
/// because the one just typed is no longer a secret.
fn handleLockUnlockRecoveryKey(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    if (!self.vault.enabled) return error.EncryptionNotEnabled;
    if (!self.vault.hasRecoverySlot()) return error.RecoveryKeyUnavailable;
    var typed_buf: [128]u8 = undefined;
    var used: usize = 0;
    defer @memset(&typed_buf, 0);
    const typed = journal.jsonString(invocation.request.payload, "recoveryKey", &typed_buf, &used) orelse return error.InvalidRequest;
    try self.lock.requireNoWait();
    self.vault.unlockWithRecovery(typed) catch |err| switch (err) {
        // A key that is not shaped like one is a typo, not a guess.
        error.WrongRecoveryKey => {
            self.lock.recordFailure();
            return err;
        },
        else => return err,
    };
    // The key is in memory now. If the rotation flag cannot be saved, stay
    // locked rather than let someone in who is never asked for a new key.
    self.vault.setRecoveryRotate(true) catch |err| {
        self.vault.lockMemory();
        return err;
    };
    self.lock.unlockRecovered();
    // The recovery key already opened the journal, so a failed Keychain write
    // does not undo the unlock. The reply says so, and the page tells the
    // owner that Touch ID will not open the journal until a later unlock with
    // the recovery key stores the copy.
    var touch_id_key_saved = true;
    if (self.lock.touch_id_enabled) {
        var key = self.vault.dataKey() orelse return error.Locked;
        defer std.crypto.secureZero(u8, &key);
        touch_id_key_saved = keychain.storeKey(self.app_id, &key);
    }
    session_lock.resetIdleClock();
    self.syncLockMenu();
    startEveSidecarAfterUnlock(self);
    return recoveryUnlockReply(output, touch_id_key_saved);
}

/// `{"ok":true}`, plus `touchIdKeyMissing` when the Keychain write failed.
fn recoveryUnlockReply(output: []u8, touch_id_key_saved: bool) ![]const u8 {
    if (touch_id_key_saved) return encryptionOk(output);
    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"ok\":true,\"touchIdKeyMissing\":true}");
    return writer.buffered();
}

/// Remove the password and leave Touch ID as the way in. Costs the current
/// password, except after an unlock with the recovery key. An encrypted
/// journal needs a recovery slot first: one already saved, or a new key that
/// Sage generated and the person typed back.
///
/// Every refusal comes before any write. The Keychain copy is replaced only
/// for a request that will go through, since a failed replace can leave Touch
/// ID with no copy at all.
fn handleLockRemovePassword(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireUnlocked(self);
    if (self.disable_pending) return error.Securing;
    const has_new_key = payloadHasRecoveryKey(invocation.request.payload);
    try self.lock.checkRemovePassword(invocation.request.payload, &self.vault, has_new_key);
    var bundle: ?vault_mod.Vault.WrapBundle = null;
    defer if (bundle) |*owned| owned.deinit(self.store.allocator);
    if (self.vault.enabled) {
        var data_key = self.vault.dataKey() orelse return error.Locked;
        defer std.crypto.secureZero(u8, &data_key);
        if (has_new_key) {
            var recovery_key = try takeRecoveryCandidate(self, invocation.request.payload);
            defer std.crypto.secureZero(u8, &recovery_key);
            bundle = try self.vault.wrapWithRecoveryKey(&recovery_key, &data_key);
        }
        // Touch ID is the everyday way in once the password is gone, so its
        // Keychain copy has to be there before the password is.
        if (self.lock.touch_id_enabled and !keychain.storeKey(self.app_id, &data_key)) return error.KeychainFailed;
    }
    const result = try self.lock.commitRemovePassword(
        &self.vault,
        if (bundle) |*owned| owned else null,
        output,
    );
    wipeRecoveryCandidate(self);
    finishPasswordChange(self);
    return result;
}

// Turning Touch ID off and turning the lock off both weaken the lock, so both
// are async: with a password set they verify it and answer at once, and
// without one they owe a fresh system prompt. `startLockPrompt` shows that
// sheet and `drainLockJobs` applies the change on this thread when it
// succeeds.

fn handleLockDisable(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    var output: [64]u8 = undefined;
    const result = self.lock.disable(invocation.request.payload, self.vault.enabled, &output) catch |err| switch (err) {
        // Touch ID is the only method, so the reply waits on the system sheet
        // instead of turning the lock off.
        error.TouchIdConfirmationRequired => {
            startLockPrompt(self, invocation, responder, .disable) catch |prompt_err| {
                respondLockFail(responder, invocation.request.id, prompt_err);
            };
            return;
        },
        else => {
            respondLockFail(responder, invocation.request.id, err);
            return;
        },
    };
    self.syncLockMenu();
    responder.success(invocation.request.id, result) catch {};
}

fn handleLockSetTouchId(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    const enabled = journal.jsonBool(invocation.request.payload, "enabled") orelse {
        respondFail(responder, invocation.request.id, "InvalidRequest");
        return;
    };
    if (enabled and !touchid.availability().prompt) {
        respondFail(responder, invocation.request.id, "TouchIdUnavailable");
        return;
    }
    // With encryption on, Touch ID needs the data key in the Keychain before
    // the flag flips, or the next biometric unlock could not unwrap.
    if (enabled and self.vault.enabled) {
        var key = self.vault.dataKey() orelse {
            respondFail(responder, invocation.request.id, "Locked");
            return;
        };
        defer std.crypto.secureZero(u8, &key);
        if (!keychain.storeKey(self.app_id, &key)) {
            respondFail(responder, invocation.request.id, "KeychainFailed");
            return;
        }
    }
    var output: [64]u8 = undefined;
    const result = self.lock.setTouchId(invocation.request.payload, self.vault.enabled, &output) catch |err| switch (err) {
        // No password to check, so the reply waits on the system sheet.
        error.TouchIdConfirmationRequired => {
            startLockPrompt(self, invocation, responder, .clear_touch_id) catch |prompt_err| {
                respondLockFail(responder, invocation.request.id, prompt_err);
            };
            return;
        },
        else => {
            respondLockFail(responder, invocation.request.id, err);
            return;
        },
    };
    if (!enabled) _ = keychain.deleteKey(self.app_id);
    self.syncLockMenu();
    responder.success(invocation.request.id, result) catch {};
}

// --- encryption ---

// With a password set, enabling carries the password: it derives the wrapping
// key, and verifying it again proves the person at the keyboard knows it. With
// Touch ID as the only method there is no password, so the journal is wrapped
// by a recovery key that Sage generated and the person typed back, and Touch ID
// opens it day to day through the Keychain copy. The data key never leaves the
// process.

fn handleEncryptionEnable(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireUnlocked(self);
    if (self.disable_pending) return error.Securing;
    // The wrapping key comes from a password or from the recovery key that
    // pairs with Touch ID, so encryption needs one of the two.
    if (!self.lock.password_set and !self.lock.touch_id_enabled) return error.PasswordRequired;
    var password_buf: [1024]u8 = undefined;
    var used: usize = 0;
    defer @memset(&password_buf, 0);
    var password: ?[]const u8 = null;
    var recovery_key: ?[vault_mod.recovery_key_len]u8 = null;
    defer if (recovery_key) |*key| std.crypto.secureZero(u8, key);
    if (self.lock.password_set) {
        const typed = journal.jsonString(invocation.request.payload, "password", &password_buf, &used) orelse return error.InvalidRequest;
        try self.lock.verifyPassword(typed);
        password = typed;
    } else if (!self.vault.enabled) {
        recovery_key = try takeRecoveryCandidate(self, invocation.request.payload);
    }
    defer if (recovery_key != null) wipeRecoveryCandidate(self);
    const fresh = !self.vault.enabled;
    if (fresh) {
        if (password) |typed| {
            try self.vault.enable(typed);
        } else {
            try self.vault.enableWithRecovery(&recovery_key.?);
        }
        syncPendingFlags(self);
    }
    // With Touch ID on, the same data key goes into the Keychain so the
    // biometric prompt can unwrap it. If that write fails on a fresh
    // enable, roll the whole thing back rather than leave Touch ID unable
    // to unlock.
    if (self.lock.touch_id_enabled) {
        var key = self.vault.dataKey() orelse return error.Locked;
        defer std.crypto.secureZero(u8, &key);
        if (!keychain.storeKey(self.app_id, &key)) {
            if (fresh) {
                self.store.setRowsEncrypted(false) catch {};
                self.vault.disable() catch {};
                syncPendingFlags(self);
            }
            return error.KeychainFailed;
        }
    }
    // A retry after a failed first attempt, or a launch that crashed mid-
    // rewrite, finds the vault already on: mark the rewrite unfinished and
    // let the walk below finish the job.
    try markRewritePending(self, true);
    stopAndWipeEveSidecar(self);
    try self.store.setRowsEncrypted(true);
    try self.vault.setCiphertextChecked(true);
    try markRewritePending(self, false);
    try markScrubPending(self, true);
    // Rows are encrypted. A failed rebuild is not a failed enable: return
    // ok and let the UI retry the scrub.
    self.store.scrubStorage() catch {
        return encryptionOk(output);
    };
    try markScrubPending(self, false);
    startEveSidecarAfterUnlock(self);
    return encryptionOk(output);
}

// --- recovery key

fn wipeRecoveryCandidate(self: *App) void {
    if (self.recovery_candidate) |*candidate| std.crypto.secureZero(u8, candidate);
    self.recovery_candidate = null;
}

fn payloadHasRecoveryKey(payload: []const u8) bool {
    var buf: [128]u8 = undefined;
    var used: usize = 0;
    defer @memset(&buf, 0);
    return journal.jsonString(payload, "recoveryKey", &buf, &used) != null;
}

/// Read the typed recovery key and check it against the one Sage generated.
/// The caller zeroes the returned copy, and wipes the candidate once it has
/// been used.
fn takeRecoveryCandidate(self: *App, payload: []const u8) ![vault_mod.recovery_key_len]u8 {
    var typed_buf: [128]u8 = undefined;
    var used: usize = 0;
    defer @memset(&typed_buf, 0);
    const typed = journal.jsonString(payload, "recoveryKey", &typed_buf, &used) orelse return error.InvalidRequest;
    var normalized: [vault_mod.recovery_key_len]u8 = undefined;
    defer std.crypto.secureZero(u8, &normalized);
    if (!vault_mod.normalizeRecoveryKey(typed, &normalized)) return error.InvalidRecoveryKey;
    const candidate = self.recovery_candidate orelse return error.RecoveryKeyRequired;
    if (!std.crypto.timing_safe.eql([vault_mod.recovery_key_len]u8, normalized, candidate)) return error.RecoveryKeyMismatch;
    return candidate;
}

/// Generate a recovery key, hold it as the candidate, and write it into
/// `output` for the dialog to show once.
fn issueRecoveryKey(self: *App, output: []u8) ![]const u8 {
    var key: [vault_mod.recovery_key_len]u8 = undefined;
    defer std.crypto.secureZero(u8, &key);
    try vault_mod.generateRecoveryKey(self.io, &key);
    var shown: [vault_mod.recovery_key_display_len]u8 = undefined;
    defer std.crypto.secureZero(u8, &shown);
    vault_mod.formatRecoveryKey(&key, &shown);
    self.recovery_candidate = key;
    var writer = std.Io.Writer.fixed(output);
    try writer.print("{{\"recoveryKey\":\"{s}\"}}", .{shown});
    return writer.buffered();
}

fn replyWithRecoveryKey(self: *App, responder: native_sdk.bridge.AsyncResponder, id: []const u8) !void {
    var output: [128]u8 = undefined;
    defer @memset(&output, 0);
    const json = try issueRecoveryKey(self, &output);
    responder.success(id, json) catch {};
}

/// Hand out a new recovery key after proof that the owner is here: the
/// password when one is set, a fresh system prompt when Touch ID is the only
/// method, nothing extra right after an unlock with the recovery key. The key
/// only counts once it comes back through `encryption.enable` or
/// `encryption.saveRecoveryKey`.
fn handleEncryptionNewRecoveryKey(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    newRecoveryKey(self, invocation, responder) catch |err| respondErrorName(responder, invocation.request.id, err);
}

fn newRecoveryKey(self: *App, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) !void {
    try requireUnlocked(self);
    if (self.disable_pending) return error.Securing;
    if (!self.vault.enabled and !self.lock.password_set and !self.lock.touch_id_enabled) return error.PasswordRequired;
    switch (self.lock.proofRequired()) {
        .none => return replyWithRecoveryKey(self, responder, invocation.request.id),
        .password => {
            var password_buf: [1024]u8 = undefined;
            var used: usize = 0;
            defer @memset(&password_buf, 0);
            const password = journal.jsonString(invocation.request.payload, "password", &password_buf, &used) orelse return error.CurrentPasswordRequired;
            try self.lock.verifyPassword(password);
            return replyWithRecoveryKey(self, responder, invocation.request.id);
        },
        .prompt => return startLockPrompt(self, invocation, responder, .new_recovery_key),
    }
}

fn newRecoveryKeyAfterPrompt(self: *App, job: *LockJob) void {
    requireUnlocked(self) catch |err| {
        respondErrorName(job.responder, job.request_id, err);
        return;
    };
    replyWithRecoveryKey(self, job.responder, job.request_id) catch |err| respondErrorName(job.responder, job.request_id, err);
}

/// Replace the recovery slot with the key Sage generated and the person typed
/// back, for "Make a new recovery key" and the one owed after a recovery
/// unlock. The old wrap is scrubbed from the file.
fn handleEncryptionSaveRecoveryKey(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    try requireUnlocked(self);
    if (self.disable_pending) return error.Securing;
    if (!self.vault.enabled) return error.EncryptionNotEnabled;
    var recovery_key = try takeRecoveryCandidate(self, invocation.request.payload);
    defer std.crypto.secureZero(u8, &recovery_key);
    var data_key = self.vault.dataKey() orelse return error.Locked;
    defer std.crypto.secureZero(u8, &data_key);
    var bundle = try self.vault.wrapWithRecoveryKey(&recovery_key, &data_key);
    defer bundle.deinit(self.store.allocator);
    try self.vault.saveRecoverySlot(&bundle);
    wipeRecoveryCandidate(self);
    syncPendingFlags(self);
    scrubAfterKeyChange(self);
    startEveSidecarAfterUnlock(self);
    return encryptionOk(output);
}

fn handleEncryptionScrub(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    if (self.disable_pending) {
        try finishEncryptionDisable(self);
        return encryptionOk(output);
    }
    if (self.rewrite_pending) {
        try requireUnlocked(self);
        stopAndWipeEveSidecar(self);
        try self.store.setRowsEncrypted(true);
        try self.vault.setCiphertextChecked(true);
        try markRewritePending(self, false);
        try markScrubPending(self, true);
    }
    if (self.scrub_pending) {
        try self.store.scrubStorage();
        try markScrubPending(self, false);
    }
    startEveSidecarAfterUnlock(self);
    return encryptionOk(output);
}

fn encryptionOk(output: []u8) ![]const u8 {
    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"ok\":true}");
    return writer.buffered();
}

/// Remove encryption. With a password, that password is the proof. With Touch
/// ID as the only method, a fresh system prompt is, and an unlock with the
/// recovery key counts as proof for the rest of that session.
fn handleEncryptionDisable(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    encryptionDisable(self, invocation, responder) catch |err| respondErrorName(responder, invocation.request.id, err);
}

fn encryptionDisable(self: *App, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) !void {
    try requireUnlocked(self);
    if (!self.vault.enabled) return error.EncryptionNotEnabled;
    switch (self.lock.proofRequired()) {
        .none => {},
        .prompt => return startLockPrompt(self, invocation, responder, .disable_encryption),
        .password => {
            var password_buf: [1024]u8 = undefined;
            var used: usize = 0;
            defer @memset(&password_buf, 0);
            const password = journal.jsonString(invocation.request.payload, "password", &password_buf, &used) orelse return error.InvalidRequest;
            try self.lock.verifyPassword(password);
        },
    }
    try disableEncryptionNow(self);
    responder.success(invocation.request.id, "{\"ok\":true}") catch {};
}

fn disableEncryptionNow(self: *App) !void {
    try requireUnlocked(self);
    try self.vault.beginDisable();
    syncPendingFlags(self);
    try finishEncryptionDisable(self);
}

fn disableEncryptionAfterPrompt(self: *App, job: *LockJob) void {
    disableEncryptionNow(self) catch |err| {
        respondErrorName(job.responder, job.request_id, err);
        return;
    };
    job.responder.success(job.request_id, "{\"ok\":true}") catch {};
}

fn finishEncryptionDisable(self: *App) !void {
    try requireUnlocked(self);
    if (!self.disable_pending) return error.DisableNotPending;

    stopAndWipeEveSidecar(self);
    // Keep the key and setup rows until every protected field decrypts.
    try self.store.setRowsEncrypted(false);
    try self.vault.disable();
    syncPendingFlags(self);
    _ = keychain.deleteKey(self.app_id);

    // The database is now plaintext and no longer needs the data key. Persist
    // the rebuild separately so a failed or interrupted vacuum can retry.
    try markScrubPending(self, true);
    try self.store.scrubStorage();
    try markScrubPending(self, false);
    startEveSidecarAfterUnlock(self);
}

// --- embeddings (async bridge commands) ---

// Embedding work blocks on a local HTTP server, so it must not run on the
// event loop: the async handler starts a job on a worker thread, the worker
// pushes the finished job to the embed queue and nudges the loop with
// `services.wake()`, and the `.effects_wake` event drains the queue on the
// loop thread. The database and bridge responders are only touched on the
// loop thread. Errors never escape the async handlers — an error that
// escapes bridge dispatch terminates the app — they become failure responses.

/// A wedged Ollama answers the status check slowly or never; fail fast.
const status_timeout_ms = ollama.status_timeout_ms;
/// Model load plus inference on a long entry can legitimately take a while.
const generate_timeout_ms = 120_000;

const EmbedQueue = struct {
    mutex: std.Io.Mutex = .init,
    jobs: std.ArrayList(*EmbedJob) = .empty,

    fn push(self: *EmbedQueue, io: std.Io, job: *EmbedJob) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        // On allocation failure the job is dropped and the frontend promise
        // never settles; the process is out of memory either way.
        self.jobs.append(std.heap.page_allocator, job) catch {};
    }

    fn takeAll(self: *EmbedQueue, io: std.Io) []*EmbedJob {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        const done = std.heap.page_allocator.dupe(*EmbedJob, self.jobs.items) catch return &.{};
        self.jobs.clearRetainingCapacity();
        return done;
    }
};

const EmbedJob = struct {
    kind: Kind,
    responder: native_sdk.bridge.AsyncResponder,
    request_id: []u8,
    entry_id: i64 = 0,
    chunks: [][]const u8 = &.{},
    // Written by the worker thread, read by the loop thread after the wake.
    status: ollama.Status = .{ .running = false, .model_pulled = false },
    model_name: []const u8 = "",
    vectors: [][]f32 = &.{},
    chat_models: ollama.ChatModels = .{ .running = false },
    delete_name: []const u8 = "",
    /// The parent PATH, so a worker can find an `ollama` CLI install.
    start_path: []const u8 = "",
    err: ?anyerror = null,
    /// Snapshot of `Store.data_generation` when the job started.
    generation: u64 = 0,
    memory_id: i64 = 0,
    memory_kind: journal.MemoryKind = .fact,
    memory_occurred_at: []u8 = &.{},
    memory_subject: []u8 = &.{},
    memory_text: []u8 = &.{},

    const Kind = enum { status, generate, models, start, delete, memory_save };
};

fn handleEmbeddingsStatus(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    requireUnlocked(self) catch {
        respondFail(responder, invocation.request.id, "Sage is locked.");
        return;
    };
    startStatusJob(self, invocation, responder) catch {
        respondFail(responder, invocation.request.id, "Could not check Ollama.");
    };
}

fn handleEmbeddingsGenerate(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    if (!self.lock.unlocked) {
        respondFail(responder, invocation.request.id, "Sage is locked.");
        return;
    }
    if (isSecuring(self)) {
        respondFail(responder, invocation.request.id, "Sage is securing your journal.");
        return;
    }
    startGenerateJob(self, invocation, responder) catch |err| {
        const message = switch (err) {
            error.InvalidRequest => "Missing entry id.",
            error.NotFound => "Entry not found.",
            else => "Could not start embedding.",
        };
        respondFail(responder, invocation.request.id, message);
    };
}

fn handleOllamaModels(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    requireUnlocked(self) catch {
        respondFail(responder, invocation.request.id, "Sage is locked.");
        return;
    };
    startModelsJob(self, invocation, responder) catch {
        respondFail(responder, invocation.request.id, "Could not list Ollama models.");
    };
}

fn handleOllamaStart(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    requireUnlocked(self) catch {
        respondFail(responder, invocation.request.id, "Sage is locked.");
        return;
    };
    startOllamaStartJob(self, invocation, responder) catch {
        respondFail(responder, invocation.request.id, "Could not start Ollama.");
    };
}

fn handleOllamaDelete(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    requireUnlocked(self) catch {
        respondFail(responder, invocation.request.id, "Sage is locked.");
        return;
    };
    var name_buf: [160]u8 = undefined;
    var used: usize = 0;
    const name = journal.jsonString(invocation.request.payload, "name", &name_buf, &used);
    if (name == null or !ollama.validModelName(name.?)) {
        respondFail(responder, invocation.request.id, "Missing model name.");
        return;
    }
    if (self.pull_state.matchesActive(self.io, name.?)) {
        respondFail(responder, invocation.request.id, "A download of this model is in progress.");
        return;
    }
    startDeleteJob(self, invocation, responder, name.?) catch {
        respondFail(responder, invocation.request.id, "Could not delete the model.");
    };
}

fn handleDreamStart(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    if (!self.lock.unlocked) {
        respondFail(responder, invocation.request.id, "Sage is locked.");
        return;
    }
    if (isSecuring(self)) {
        respondFail(responder, invocation.request.id, "Sage is securing your journal.");
        return;
    }
    dream.start(dreamHost(self), responder, invocation.request.id) catch |err| {
        const message = switch (err) {
            error.DreamInProgress => "Sage is already dreaming.",
            else => "Could not start dreaming.",
        };
        respondFail(responder, invocation.request.id, message);
    };
}

fn handleMemorySave(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    if (!self.lock.unlocked) {
        respondFail(responder, invocation.request.id, "Sage is locked.");
        return;
    }
    if (isSecuring(self)) {
        respondFail(responder, invocation.request.id, "Sage is securing your journal.");
        return;
    }
    if (!build_options.memory_enabled) {
        respondFail(responder, invocation.request.id, "Memories are unavailable.");
        return;
    }
    startMemorySave(self, invocation, responder) catch |err| {
        const message = switch (err) {
            error.InvalidRequest => "Missing memory fields.",
            error.InvalidEmbedding => "Missing memory fields.",
            error.NotFound => "Memory not found.",
            else => "Could not save the memory.",
        };
        respondFail(responder, invocation.request.id, message);
    };
}

fn startMemorySave(
    self: *App,
    invocation: native_sdk.bridge.Invocation,
    responder: native_sdk.bridge.AsyncResponder,
) !void {
    var string_buf: [32768]u8 = undefined;
    var used: usize = 0;
    const kind_name = journal.jsonString(invocation.request.payload, "kind", &string_buf, &used) orelse return error.InvalidRequest;
    const kind = journal.MemoryKind.parse(kind_name) orelse return error.InvalidRequest;
    const id = journal.jsonI64(invocation.request.payload, "id");

    if (kind == .profile) {
        const fact = journal.jsonString(invocation.request.payload, "fact", &string_buf, &used) orelse return error.InvalidRequest;
        const saved_id = try self.store.saveMemory(.{
            .fact = fact,
            .id = id,
            .kind = .profile,
            .model_name = "user",
        });
        var buffer: [64]u8 = undefined;
        var writer = std.Io.Writer.fixed(&buffer);
        try writer.writeAll("{\"id\":");
        try writer.print("{d}", .{saved_id});
        try writer.writeByte('}');
        try responder.success(invocation.request.id, writer.buffered());
        return;
    }

    const services = self.services orelse return error.RuntimeUnavailable;
    const allocator = self.store.allocator;
    const text_field: []const u8 = if (kind == .fact) "fact" else "event";
    const text = journal.jsonString(invocation.request.payload, text_field, &string_buf, &used) orelse return error.InvalidRequest;
    if (std.mem.trim(u8, text, " \t\r\n").len == 0) return error.InvalidRequest;
    const subject = if (kind == .fact)
        journal.jsonString(invocation.request.payload, "subject", &string_buf, &used) orelse return error.InvalidRequest
    else
        "";
    if (kind == .fact and std.mem.trim(u8, subject, " \t\r\n").len == 0) return error.InvalidRequest;
    const occurred_at = if (kind == .event)
        journal.jsonString(invocation.request.payload, "occurredAt", &string_buf, &used) orelse ""
    else
        "";

    const owned_text = try allocator.dupe(u8, text);
    const chunks = try allocator.alloc([]const u8, 1);
    var chunks_owned = true;
    defer if (chunks_owned) {
        allocator.free(owned_text);
        allocator.free(chunks);
    };
    chunks[0] = owned_text;

    const job = try allocator.create(EmbedJob);
    errdefer allocator.destroy(job);
    job.* = .{
        .kind = .memory_save,
        .responder = responder,
        .request_id = try allocator.dupe(u8, invocation.request.id),
        .chunks = chunks,
        .generation = self.store.data_generation,
        .memory_id = id orelse 0,
        .memory_kind = kind,
        .memory_occurred_at = try allocator.dupe(u8, occurred_at),
        .memory_subject = try allocator.dupe(u8, subject),
    };
    errdefer allocator.free(job.request_id);
    errdefer allocator.free(job.memory_occurred_at);
    errdefer allocator.free(job.memory_subject);
    const thread = try std.Thread.spawn(.{}, runGenerateJob, .{ self.io, allocator, self.embed_queue, services, job, self.models });
    thread.detach();
    chunks_owned = false;
}

fn respondFail(responder: native_sdk.bridge.AsyncResponder, id: []const u8, message: []const u8) void {
    responder.fail(id, .handler_failed, message) catch {};
}

fn startStatusJob(self: *App, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) !void {
    const services = self.services orelse return error.RuntimeUnavailable;
    const allocator = self.store.allocator;
    const job = try allocator.create(EmbedJob);
    errdefer allocator.destroy(job);
    job.* = .{
        .kind = .status,
        .responder = responder,
        .request_id = try allocator.dupe(u8, invocation.request.id),
    };
    errdefer allocator.free(job.request_id);
    const thread = try std.Thread.spawn(.{}, runStatusJob, .{ self.io, allocator, self.embed_queue, services, job, self.models });
    thread.detach();
}

fn startModelsJob(self: *App, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) !void {
    const services = self.services orelse return error.RuntimeUnavailable;
    const allocator = self.store.allocator;
    const job = try allocator.create(EmbedJob);
    errdefer allocator.destroy(job);
    job.* = .{
        .kind = .models,
        .responder = responder,
        .request_id = try allocator.dupe(u8, invocation.request.id),
    };
    errdefer allocator.free(job.request_id);
    const thread = try std.Thread.spawn(.{}, runModelsJob, .{ self.io, allocator, self.embed_queue, services, job, self.models });
    thread.detach();
}

/// Ollama may already be running, and a start that has to launch the app and
/// wait for the server can outlive a bridge round trip, so the launch and the
/// wait both happen on a worker thread.
fn startOllamaStartJob(self: *App, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) !void {
    const services = self.services orelse return error.RuntimeUnavailable;
    const allocator = self.store.allocator;
    const path_env = self.env_map.get("PATH");
    const job = try allocator.create(EmbedJob);
    errdefer allocator.destroy(job);
    job.* = .{
        .kind = .start,
        .responder = responder,
        .request_id = try allocator.dupe(u8, invocation.request.id),
        .start_path = try allocator.dupe(u8, path_env orelse ""),
    };
    errdefer allocator.free(job.request_id);
    errdefer allocator.free(job.start_path);
    const thread = try std.Thread.spawn(.{}, runStartJob, .{ self.io, allocator, self.embed_queue, services, job });
    thread.detach();
}

fn startDeleteJob(self: *App, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder, name: []const u8) !void {
    const services = self.services orelse return error.RuntimeUnavailable;
    const allocator = self.store.allocator;
    const job = try allocator.create(EmbedJob);
    errdefer allocator.destroy(job);
    job.* = .{
        .kind = .delete,
        .responder = responder,
        .request_id = try allocator.dupe(u8, invocation.request.id),
        .delete_name = try allocator.dupe(u8, name),
    };
    errdefer allocator.free(job.request_id);
    errdefer allocator.free(job.delete_name);
    const thread = try std.Thread.spawn(.{}, runDeleteJob, .{ self.io, allocator, self.embed_queue, services, job });
    thread.detach();
}

fn startGenerateJob(self: *App, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) !void {
    const services = self.services orelse return error.RuntimeUnavailable;
    const allocator = self.store.allocator;
    const id = journal.jsonI64(invocation.request.payload, "id") orelse return error.InvalidRequest;

    // The body read and chunking are fast and keep the database on the loop
    // thread; only the Ollama round-trip moves to a worker.
    const loaded = try self.store.loadBody(id);
    defer {
        allocator.free(loaded.body);
        allocator.free(loaded.format);
    }
    const text = try ollama.extractPlainText(allocator, loaded.body, loaded.format);
    defer allocator.free(text);
    const chunks = try ollama.chunkText(allocator, text);
    var chunks_owned = true;
    defer if (chunks_owned) {
        for (chunks) |chunk| allocator.free(chunk);
        allocator.free(chunks);
    };

    if (chunks.len == 0) {
        try responder.success(invocation.request.id, "{\"chunks\":0,\"dimensions\":0,\"model\":\"\"}");
        return;
    }

    const job = try allocator.create(EmbedJob);
    errdefer allocator.destroy(job);
    job.* = .{
        .kind = .generate,
        .responder = responder,
        .request_id = try allocator.dupe(u8, invocation.request.id),
        .entry_id = id,
        .chunks = chunks,
        .generation = self.store.data_generation,
    };
    errdefer allocator.free(job.request_id);
    const thread = try std.Thread.spawn(.{}, runGenerateJob, .{ self.io, allocator, self.embed_queue, services, job, self.models });
    thread.detach();
    chunks_owned = false;
}

fn runStatusJob(io: std.Io, allocator: std.mem.Allocator, queue: *EmbedQueue, services: native_sdk.platform.PlatformServices, job: *EmbedJob, models: ollama.ModelPrefixes) void {
    var abort: ollama.Abort = .{ .io = io };
    const watchdog = ollama.startWatchdog(&abort, status_timeout_ms);
    job.status = ollama.checkStatus(io, allocator, &abort, models);
    job.model_name = job.status.model_name;
    ollama.finishWatchdog(&abort, watchdog);
    queue.push(io, job);
    services.wake() catch {};
}

fn runGenerateJob(io: std.Io, allocator: std.mem.Allocator, queue: *EmbedQueue, services: native_sdk.platform.PlatformServices, job: *EmbedJob, models: ollama.ModelPrefixes) void {
    var abort: ollama.Abort = .{ .io = io };
    const watchdog = ollama.startWatchdog(&abort, generate_timeout_ms);
    const status = ollama.checkStatus(io, allocator, &abort, models);
    if (!status.running) {
        job.err = error.OllamaNotRunning;
    } else if (!status.model_pulled or status.model_name.len == 0) {
        job.err = error.ModelNotPulled;
    } else {
        job.model_name = status.model_name;
        if (ollama.embed(io, allocator, job.chunks, job.model_name, &abort)) |vectors| {
            job.vectors = vectors;
        } else |err| {
            job.err = err;
        }
    }
    ollama.finishWatchdog(&abort, watchdog);
    queue.push(io, job);
    services.wake() catch {};
}

fn runModelsJob(io: std.Io, allocator: std.mem.Allocator, queue: *EmbedQueue, services: native_sdk.platform.PlatformServices, job: *EmbedJob, models: ollama.ModelPrefixes) void {
    var abort: ollama.Abort = .{ .io = io };
    const watchdog = ollama.startWatchdog(&abort, status_timeout_ms);
    job.chat_models = ollama.listChatModels(io, allocator, &abort, models);
    ollama.finishWatchdog(&abort, watchdog);
    queue.push(io, job);
    services.wake() catch {};
}

fn runStartJob(io: std.Io, allocator: std.mem.Allocator, queue: *EmbedQueue, services: native_sdk.platform.PlatformServices, job: *EmbedJob) void {
    ollama.startServer(io, allocator, job.start_path) catch |err| {
        job.err = err;
    };
    queue.push(io, job);
    services.wake() catch {};
}

fn runDeleteJob(io: std.Io, allocator: std.mem.Allocator, queue: *EmbedQueue, services: native_sdk.platform.PlatformServices, job: *EmbedJob) void {
    var abort: ollama.Abort = .{ .io = io };
    const watchdog = ollama.startWatchdog(&abort, status_timeout_ms);
    ollama.deleteModel(io, allocator, job.delete_name, &abort) catch |err| {
        job.err = err;
    };
    ollama.finishWatchdog(&abort, watchdog);
    queue.push(io, job);
    services.wake() catch {};
}

fn runPullJob(self: *App, name: []u8) void {
    const allocator = self.store.allocator;
    defer allocator.free(name);
    const watchdog = ollama.startWatchdog(&self.pull_abort, ollama.pull_timeout_ms);
    const result = ollama.pullModel(self.io, allocator, name, &self.pull_state, &self.pull_abort);
    ollama.finishWatchdog(&self.pull_abort, watchdog);
    self.pull_state.finish(self.io, result);
    if (self.services) |services| services.wake() catch {};
}

fn drainEmbedJobs(self: *App) void {
    const jobs = self.embed_queue.takeAll(self.io);
    defer if (jobs.len > 0) std.heap.page_allocator.free(jobs);
    for (jobs) |job| completeEmbedJob(self, job);
}

fn completeEmbedJob(self: *App, job: *EmbedJob) void {
    const allocator = self.store.allocator;
    defer {
        allocator.free(job.request_id);
        for (job.chunks) |chunk| allocator.free(chunk);
        if (job.chunks.len > 0) allocator.free(job.chunks);
        for (job.vectors) |vec| allocator.free(vec);
        if (job.vectors.len > 0) allocator.free(job.vectors);
        if (job.model_name.len > 0) allocator.free(job.model_name);
        if (job.delete_name.len > 0) allocator.free(job.delete_name);
        if (job.start_path.len > 0) allocator.free(job.start_path);
        if (job.memory_occurred_at.len > 0) allocator.free(job.memory_occurred_at);
        if (job.memory_subject.len > 0) allocator.free(job.memory_subject);
        if (job.memory_text.len > 0) allocator.free(job.memory_text);
        for (job.chat_models.names) |name| allocator.free(name);
        if (job.chat_models.names.len > 0) allocator.free(job.chat_models.names);
        allocator.destroy(job);
    }
    switch (job.kind) {
        .status => {
            var buffer: [128]u8 = undefined;
            const body = std.fmt.bufPrint(&buffer, "{{\"running\":{},\"modelPulled\":{}}}", .{ job.status.running, job.status.model_pulled }) catch return;
            job.responder.success(job.request_id, body) catch {};
        },
        .models => {
            var body = std.Io.Writer.Allocating.init(allocator);
            defer body.deinit();
            body.writer.writeAll("{\"models\":[") catch return;
            for (job.chat_models.names, 0..) |name, index| {
                if (index > 0) body.writer.writeByte(',') catch return;
                journal.writeJsonStringStreaming(&body.writer, name) catch return;
            }
            body.writer.writeAll("]}") catch return;
            job.responder.success(job.request_id, body.written()) catch {};
        },
        .generate => {
            if (job.err) |err| {
                var pulled_buf: [256]u8 = undefined;
                const message = switch (err) {
                    error.OllamaNotRunning => "Ollama is not running.",
                    error.ModelNotPulled => ollama.embedNotPulledMessage(&pulled_buf, self.models.embed),
                    error.OllamaTimeout => "Ollama did not answer in time.",
                    else => "Embedding failed.",
                };
                respondFail(job.responder, job.request_id, message);
                return;
            }
            if (job.generation != self.store.data_generation) {
                respondFail(job.responder, job.request_id, "Journal data was deleted.");
                return;
            }
            self.store.replaceEmbeddings(job.entry_id, job.chunks, job.vectors, job.model_name) catch {
                respondFail(job.responder, job.request_id, "Could not store the embeddings.");
                return;
            };
            const dimensions = if (job.vectors.len > 0) job.vectors[0].len else 0;
            var buffer: [256]u8 = undefined;
            var writer = std.Io.Writer.fixed(&buffer);
            writer.writeAll("{\"chunks\":") catch return;
            writer.print("{d}", .{job.chunks.len}) catch return;
            writer.writeAll(",\"dimensions\":") catch return;
            writer.print("{d}", .{dimensions}) catch return;
            writer.writeAll(",\"model\":") catch return;
            writeJsonStringToWriter(&writer, job.model_name) catch return;
            writer.writeAll("}") catch return;
            job.responder.success(job.request_id, writer.buffered()) catch {};
        },
        .delete => {
            if (job.err) |err| {
                const message = switch (err) {
                    error.OllamaNotRunning => "Ollama is not running.",
                    error.OllamaTimeout => "Ollama did not answer in time.",
                    else => "Could not delete the model.",
                };
                respondFail(job.responder, job.request_id, message);
                return;
            }
            job.responder.success(job.request_id, "{\"ok\":true}") catch {};
        },
        .start => {
            if (job.err) |err| {
                const message = switch (err) {
                    error.OllamaNotInstalled => "Ollama is not installed on this Mac.",
                    error.OllamaStartTimeout => "Ollama did not start in time.",
                    else => "Could not start Ollama.",
                };
                respondFail(job.responder, job.request_id, message);
                return;
            }
            job.responder.success(job.request_id, "{\"ok\":true}") catch {};
        },
        .memory_save => {
            if (!build_options.memory_enabled) {
                respondFail(job.responder, job.request_id, "Memories are unavailable.");
                return;
            }
            if (job.err) |err| {
                var pulled_buf: [256]u8 = undefined;
                const message = switch (err) {
                    error.OllamaNotRunning => "Ollama is not running.",
                    error.ModelNotPulled => ollama.embedNotPulledMessage(&pulled_buf, self.models.embed),
                    error.OllamaTimeout => "Ollama did not answer in time.",
                    else => "Embedding failed.",
                };
                respondFail(job.responder, job.request_id, message);
                return;
            }
            if (job.generation != self.store.data_generation) {
                respondFail(job.responder, job.request_id, "Journal data was deleted.");
                return;
            }
            if (job.vectors.len != 1 or job.chunks.len != 1) {
                respondFail(job.responder, job.request_id, "Embedding failed.");
                return;
            }
            const saved_id = self.store.saveMemory(.{
                .embedding = job.vectors[0],
                .event = if (job.memory_kind == .event) job.chunks[0] else "",
                .fact = if (job.memory_kind == .fact) job.chunks[0] else "",
                .id = if (job.memory_id == 0) null else job.memory_id,
                .kind = job.memory_kind,
                .model_name = job.model_name,
                .occurred_at = job.memory_occurred_at,
                .subject = job.memory_subject,
            }) catch |err| {
                const message = switch (err) {
                    error.NotFound => "Memory not found.",
                    error.InvalidRequest, error.InvalidEmbedding => "Missing memory fields.",
                    else => "Could not save the memory.",
                };
                respondFail(job.responder, job.request_id, message);
                return;
            };
            var buffer: [64]u8 = undefined;
            var writer = std.Io.Writer.fixed(&buffer);
            writer.writeAll("{\"id\":") catch return;
            writer.print("{d}", .{saved_id}) catch return;
            writer.writeByte('}') catch return;
            job.responder.success(job.request_id, writer.buffered()) catch {};
        },
    }
}

fn drainDreamJobs(self: *App) void {
    dream.drain(dreamHost(self));
}

fn drainAgentJobs(self: *App) void {
    const jobs = self.agent_queue.takeAll();
    defer if (jobs.len > 0) std.heap.page_allocator.free(jobs);
    for (jobs) |job| completeAgentJob(self, job);
}

fn completeAgentJob(self: *App, job: *agent_server.Job) void {
    const allocator = self.store.allocator;
    const io = self.agent.io;
    switch (job.kind) {
        .search => {
            if (journalAccessBlocked(self)) {
                agent_server.replyLocked(io, job.stream);
                agent_server.closeJob(allocator, io, job);
                return;
            }
            if (!build_options.memory_enabled and job.target != .journal) {
                agent_server.replyJson(io, job.stream, 404, "Not Found", "{\"error\":\"not_found\"}");
                agent_server.closeJob(allocator, io, job);
                return;
            }
            startSearchEmbed(self, job);
        },
        .search_ready => {
            defer agent_server.closeJob(allocator, io, job);
            if (journalAccessBlocked(self)) {
                agent_server.replyLocked(io, job.stream);
                return;
            }
            if (!build_options.memory_enabled and job.target != .journal) {
                agent_server.replyJson(io, job.stream, 404, "Not Found", "{\"error\":\"not_found\"}");
                return;
            }
            if (job.err) |_| {
                agent_server.replyJson(io, job.stream, 503, "Service Unavailable", "{\"error\":\"embed_failed\"}");
                return;
            }
            if (job.vectors.len == 0) {
                const empty = switch (job.target) {
                    .journal => "{\"entries\":[]}",
                    .facts, .events => "{\"results\":[]}",
                };
                agent_server.replyJson(io, job.stream, 200, "OK", empty);
                return;
            }
            var body = std.Io.Writer.Allocating.init(allocator);
            defer body.deinit();
            const search = switch (job.target) {
                .journal => self.store.semanticSearchSummaries(job.vectors[0], job.limit, &body.writer),
                .facts => self.store.semanticSearchFacts(job.vectors[0], job.limit, &body.writer),
                .events => self.store.semanticSearchEvents(job.vectors[0], job.limit, &body.writer),
            };
            search catch {
                agent_server.replyJson(io, job.stream, 500, "Internal Server Error", "{\"error\":\"internal\"}");
                return;
            };
            agent_server.replyJson(io, job.stream, 200, "OK", body.written());
        },
        .get_entry => {
            defer agent_server.closeJob(allocator, io, job);
            if (journalAccessBlocked(self)) {
                agent_server.replyLocked(io, job.stream);
                return;
            }
            var body = std.Io.Writer.Allocating.init(allocator);
            defer body.deinit();
            self.store.writeEntryJson(job.entry_id, &body.writer) catch |err| switch (err) {
                error.NotFound => {
                    agent_server.replyJson(io, job.stream, 404, "Not Found", "{\"error\":\"not_found\"}");
                    return;
                },
                else => {
                    agent_server.replyJson(io, job.stream, 500, "Internal Server Error", "{\"error\":\"internal\"}");
                    return;
                },
            };
            agent_server.replyJson(io, job.stream, 200, "OK", body.written());
        },
        .memory_profile => {
            defer agent_server.closeJob(allocator, io, job);
            if (journalAccessBlocked(self)) {
                agent_server.replyLocked(io, job.stream);
                return;
            }
            if (!build_options.memory_enabled) {
                agent_server.replyJson(io, job.stream, 404, "Not Found", "{\"error\":\"not_found\"}");
                return;
            }
            var body = std.Io.Writer.Allocating.init(allocator);
            defer body.deinit();
            self.store.listProfile(journal.profile_recall_limit, &body.writer) catch {
                agent_server.replyJson(io, job.stream, 500, "Internal Server Error", "{\"error\":\"internal\"}");
                return;
            };
            agent_server.replyJson(io, job.stream, 200, "OK", body.written());
        },
        .agent_instructions => {
            defer agent_server.closeJob(allocator, io, job);
            if (journalAccessBlocked(self)) {
                agent_server.replyLocked(io, job.stream);
                return;
            }
            var body = std.Io.Writer.Allocating.init(allocator);
            defer body.deinit();
            self.store.writeAgentUserInstructionsJson(&body.writer) catch {
                agent_server.replyJson(io, job.stream, 500, "Internal Server Error", "{\"error\":\"internal\"}");
                return;
            };
            agent_server.replyJson(io, job.stream, 200, "OK", body.written());
        },
    }
}

fn startSearchEmbed(self: *App, job: *agent_server.Job) void {
    const io = self.agent.io;
    const services = self.services orelse {
        agent_server.replyJson(io, job.stream, 500, "Internal Server Error", "{\"error\":\"internal\"}");
        agent_server.closeJob(self.store.allocator, io, job);
        return;
    };
    const thread = std.Thread.spawn(.{}, runSearchEmbed, .{ self.io, self.store.allocator, self.agent_queue, services, job, self.models }) catch {
        agent_server.replyJson(io, job.stream, 500, "Internal Server Error", "{\"error\":\"internal\"}");
        agent_server.closeJob(self.store.allocator, io, job);
        return;
    };
    thread.detach();
}

fn runSearchEmbed(
    io: std.Io,
    allocator: std.mem.Allocator,
    queue: *agent_server.Queue,
    services: native_sdk.platform.PlatformServices,
    job: *agent_server.Job,
    models: ollama.ModelPrefixes,
) void {
    var abort: ollama.Abort = .{ .io = io };
    const watchdog = ollama.startWatchdog(&abort, generate_timeout_ms);
    const status = ollama.checkStatus(io, allocator, &abort, models);
    if (!status.running) {
        job.err = error.OllamaNotRunning;
        if (status.model_name.len > 0) allocator.free(status.model_name);
    } else if (!status.model_pulled or status.model_name.len == 0) {
        job.err = error.ModelNotPulled;
        if (status.model_name.len > 0) allocator.free(status.model_name);
    } else {
        job.model_name = status.model_name;
        const chunks = [_][]const u8{job.query};
        if (ollama.embed(io, allocator, &chunks, job.model_name, &abort)) |vectors| {
            job.vectors = vectors;
        } else |err| {
            job.err = err;
        }
    }
    ollama.finishWatchdog(&abort, watchdog);
    job.kind = .search_ready;
    queue.push(job);
    services.wake() catch {};
}

// --- LocalAuthentication prompts (async bridge commands) ---

// The LocalAuthentication reply block runs on a private Apple queue thread.
// It records the outcome on the job, pushes the job to the lock queue, and
// nudges the loop with `services.wake()` — the same shape as the embeddings
// workers. The job is completed by drainLockJobs on the loop thread, where
// the lock state and bridge responders live. At most one prompt is in
// flight; a second request fails fast instead of stacking system sheets.

/// What the sheet is asking for. The reply only says whether the user
/// succeeded; the purpose says which change a success applies.
const LockPurpose = enum { unlock, clear_touch_id, disable, set_password, disable_encryption, new_recovery_key };

const LockJob = struct {
    responder: native_sdk.bridge.AsyncResponder,
    request_id: []u8,
    purpose: LockPurpose,
    /// The request's payload when the change it asks for waits on the sheet,
    /// like the new password. Zeroed before it is freed.
    payload: ?[]u8 = null,
    // Written by the reply thread, read by the loop thread after the wake.
    success: bool = false,
};

const LockQueue = struct {
    mutex: std.Io.Mutex = .init,
    jobs: std.ArrayList(*LockJob) = .empty,

    fn push(self: *LockQueue, io: std.Io, job: *LockJob) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        // On allocation failure the job is dropped and the frontend promise
        // never settles; the process is out of memory either way.
        self.jobs.append(std.heap.page_allocator, job) catch {};
    }

    fn takeAll(self: *LockQueue, io: std.Io) []*LockJob {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        const done = std.heap.page_allocator.dupe(*LockJob, self.jobs.items) catch return &.{};
        self.jobs.clearRetainingCapacity();
        return done;
    }
};

/// Answer an async lock command with the name of the error, so the settings
/// error mapping keeps matching them the way it matches the sync handlers.
fn respondLockFail(responder: native_sdk.bridge.AsyncResponder, id: []const u8, err: anyerror) void {
    const message = switch (err) {
        error.Locked => "Sage is locked.",
        error.InvalidRequest => "InvalidRequest",
        error.CurrentPasswordRequired => "CurrentPasswordRequired",
        error.WrongPassword => "WrongPassword",
        error.EncryptionEnabled => "EncryptionEnabled",
        error.LastUnlockMethod => "LastUnlockMethod",
        error.TouchIdUnavailable => "TouchIdUnavailable",
        error.KeychainFailed => "KeychainFailed",
        error.PromptInFlight => "A Touch ID prompt is already showing.",
        else => "Could not update the lock.",
    };
    respondFail(responder, id, message);
}

/// Answer an async command with the name of the error, which is how a failed
/// sync handler reads in the web view, so the settings error mapping matches
/// both the same way.
fn respondErrorName(responder: native_sdk.bridge.AsyncResponder, id: []const u8, err: anyerror) void {
    const message = switch (err) {
        error.PromptInFlight => "A Touch ID prompt is already showing.",
        else => @errorName(err),
    };
    respondFail(responder, id, message);
}

fn handleUnlockTouchId(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    if (!self.lock.touch_id_enabled) {
        respondFail(responder, invocation.request.id, "Touch ID is not turned on.");
        return;
    }
    if (self.lock.unlocked) {
        responder.success(invocation.request.id, "{\"ok\":true}") catch {};
        return;
    }
    startLockPrompt(self, invocation, responder, .unlock) catch |err| {
        const message = switch (err) {
            error.PromptInFlight => "A Touch ID prompt is already showing.",
            else => "Touch ID is not available on this Mac.",
        };
        respondFail(responder, invocation.request.id, message);
    };
}

fn startLockPrompt(
    self: *App,
    invocation: native_sdk.bridge.Invocation,
    responder: native_sdk.bridge.AsyncResponder,
    purpose: LockPurpose,
) !void {
    return startLockPromptWithPayload(self, invocation, responder, purpose, null);
}

fn startLockPromptWithPayload(
    self: *App,
    invocation: native_sdk.bridge.Invocation,
    responder: native_sdk.bridge.AsyncResponder,
    purpose: LockPurpose,
    payload: ?[]const u8,
) !void {
    if (self.lock_job != null) return error.PromptInFlight;
    if (!touchid.availability().prompt) return error.TouchIdUnavailable;

    // A confirmation prompt evaluates a fresh context: the unlock the owner
    // just finished must not be the proof that turns the lock off. The unlock
    // prompt keeps the shared one, so the Keychain read right after can reuse
    // it instead of asking twice.
    const reason: [:0]const u8 = switch (purpose) {
        .unlock => "Unlock Sage",
        .clear_touch_id => "Turn off Touch ID",
        .disable => "Turn off the lock",
        .set_password => "Set a password for Sage",
        .disable_encryption => "Remove Sage's encryption",
        .new_recovery_key => "Make a Sage recovery key",
    };
    if (purpose != .unlock) touchid.resetContext();

    const allocator = self.store.allocator;
    const job = try allocator.create(LockJob);
    errdefer allocator.destroy(job);
    job.* = .{
        .responder = responder,
        .request_id = try allocator.dupe(u8, invocation.request.id),
        .purpose = purpose,
    };
    errdefer allocator.free(job.request_id);
    if (payload) |copy| job.payload = try allocator.dupe(u8, copy);
    errdefer if (job.payload) |held| {
        @memset(held, 0);
        allocator.free(held);
    };

    // Written before the prompt starts; the reply block cannot run before
    // evaluatePolicy is called, so the LA thread sees this store.
    self.lock_job = job;
    if (!touchid.prompt(reason, self, touchIdComplete)) {
        self.lock_job = null;
        return error.TouchIdUnavailable;
    }
}

/// Runs on LocalAuthentication's reply thread.
fn touchIdComplete(context: *anyopaque, success: bool) void {
    const self: *App = @ptrCast(@alignCast(context));
    const job = self.lock_job orelse return;
    job.success = success;
    self.lock_queue.push(self.io, job);
    if (self.services) |services| services.wake() catch {};
}

fn drainLockJobs(self: *App) void {
    const jobs = self.lock_queue.takeAll(self.io);
    defer if (jobs.len > 0) std.heap.page_allocator.free(jobs);
    for (jobs) |job| {
        const allocator = self.store.allocator;
        defer {
            if (job.payload) |held| {
                @memset(held, 0);
                allocator.free(held);
            }
            allocator.free(job.request_id);
            allocator.destroy(job);
        }
        self.lock_job = null;
        if (!job.success) {
            respondFail(job.responder, job.request_id, "Touch ID did not succeed.");
            continue;
        }
        switch (job.purpose) {
            .unlock => unlockAfterPrompt(self, job),
            .clear_touch_id => clearTouchIdAfterPrompt(self, job),
            .disable => disableAfterPrompt(self, job),
            .set_password => setPasswordAfterPrompt(self, job),
            .disable_encryption => disableEncryptionAfterPrompt(self, job),
            .new_recovery_key => newRecoveryKeyAfterPrompt(self, job),
        }
    }
}

fn unlockAfterPrompt(self: *App, job: *LockJob) void {
    // With encryption on, the Keychain holds the data key behind the same
    // user-presence check; the just-finished prompt's LAContext is reused so
    // the user is not asked twice.
    if (!self.vault.enabled) {
        self.lock.unlockTouchId();
        session_lock.resetIdleClock();
        self.syncLockMenu();
        startEveSidecarAfterUnlock(self);
        job.responder.success(job.request_id, "{\"ok\":true}") catch {};
        return;
    }
    var key: [vault_mod.data_key_len]u8 = undefined;
    defer std.crypto.secureZero(u8, &key);
    if (!keychain.readKey(self.app_id, touchid.authenticationContext(), &key)) {
        // With no password set, the recovery key is the way back in.
        respondFail(job.responder, job.request_id, if (self.lock.password_set)
            "Could not read the journal key. Use your password."
        else
            "Could not read the journal key. Use your recovery key.");
        return;
    }
    self.vault.setKey(key);
    self.lock.unlockTouchId();
    session_lock.resetIdleClock();
    self.syncLockMenu();
    startEveSidecarAfterUnlock(self);
    job.responder.success(job.request_id, "{\"ok\":true}") catch {};
}

fn clearTouchIdAfterPrompt(self: *App, job: *LockJob) void {
    // The lock can move while the sheet is up — a password may have been set
    // or removed — so the rules are checked again here.
    self.lock.clearTouchId(self.vault.enabled) catch |err| {
        respondLockFail(job.responder, job.request_id, err);
        return;
    };
    _ = keychain.deleteKey(self.app_id);
    self.syncLockMenu();
    job.responder.success(job.request_id, "{\"ok\":true}") catch {};
}

fn disableAfterPrompt(self: *App, job: *LockJob) void {
    self.lock.completeDisable(self.vault.enabled) catch |err| {
        respondLockFail(job.responder, job.request_id, err);
        return;
    };
    self.syncLockMenu();
    job.responder.success(job.request_id, "{\"ok\":true}") catch {};
}

fn handleWindowDrag(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = context;
    _ = invocation;
    return window_chrome.drag(output);
}

fn handleAlignTitlebar(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = context;
    return window_chrome.alignTitlebar(invocation.request.payload, output);
}

/// Write a JSON-escaped string value to a fixed writer.
fn writeJsonStringToWriter(writer: *std.Io.Writer, value: []const u8) !void {
    var scratch: [256]u8 = undefined;
    const quoted = native_sdk.bridge.writeJsonStringValue(&scratch, value);
    if (quoted.len == 0) return error.TooLarge;
    try writer.writeAll(quoted);
}

/// `SAGE_DATA_DIR` sends the journal and the discovery file to a throwaway
/// directory. The Unix socket name is hashed from that path. Empty values
/// fall back to the platform app data dir.
fn resolveAppDataDir(
    environ_map: *std.process.Environ.Map,
    app_id: [:0]const u8,
    buffer: []u8,
) ![]const u8 {
    if (environ_map.get("SAGE_DATA_DIR")) |override| {
        if (override.len > 0) return override;
    }
    return native_sdk.app_dirs.resolveOne(
        .{ .name = app_id },
        native_sdk.app_dirs.currentPlatform(),
        native_sdk.debug.envFromMap(environ_map),
        .data,
        buffer,
    );
}

pub fn main(init: std.process.Init) !void {
    const dev_mode = if (init.environ_map.get("NATIVE_SDK_MODE")) |mode|
        std.mem.eql(u8, mode, "dev")
    else
        false;
    const app_id: [:0]const u8 = if (dev_mode) "com.wasimxyz.sage-dev" else "com.wasimxyz.sage";

    var data_dir_buffer: [512]u8 = undefined;
    const app_data_dir = resolveAppDataDir(init.environ_map, app_id, &data_dir_buffer) catch
        return error.SqliteDataDirUnavailable;
    try std.Io.Dir.cwd().createDirPath(init.io, app_data_dir);
    const data_dir = try std.heap.page_allocator.dupe(u8, app_data_dir);

    const open_result = try native_sdk.RelationalStore.openMigrated(
        std.heap.page_allocator,
        app_data_dir,
        &journal.migrations,
    );
    const db = switch (open_result.outcome) {
        .ok => open_result.database.?,
        .migrate_failed => return error.SqliteMigrationFailed,
        .version_unknown => return error.SqliteVersionUnknown,
    };

    // Process-lifetime by design: a detached worker may push a finished job
    // while the process is exiting, after main's stack frame is gone.
    const embed_queue = try std.heap.page_allocator.create(EmbedQueue);
    embed_queue.* = .{};
    const dream_queue = try std.heap.page_allocator.create(dream.Queue);
    dream_queue.* = .{};
    const lock_queue = try std.heap.page_allocator.create(LockQueue);
    lock_queue.* = .{};
    const agent_queue = try std.heap.page_allocator.create(agent_server.Queue);
    agent_queue.* = .{};

    var app = App{
        .env_map = init.environ_map,
        .io = init.io,
        .app_id = app_id,
        .store = journal.Store.init(std.heap.page_allocator, db),
        .lock = undefined,
        .vault = undefined,
        .lock_queue = lock_queue,
        .embed_queue = embed_queue,
        .dream_queue = dream_queue,
        .agent_queue = agent_queue,
        .data_dir = data_dir,
        .models = ollama.ModelPrefixes.fromEnv(init.environ_map),
        .pull_abort = .{ .io = init.io },
    };
    // The vault and the lock read their rows from the same database; both
    // borrow the store's connection, so the app must not move after this
    // point.
    app.vault = try vault_mod.Vault.init(std.heap.page_allocator, init.io, &app.store.db);
    app.store.vault = &app.vault;
    app.lock = try lock_mod.Lock.init(std.heap.page_allocator, init.io, &app.store.db);
    try app.store.setSecureDelete(true);
    syncPendingFlags(&app);
    try markRewriteForPlaintext(&app);
    if (app.store.chatSessionIds(std.heap.page_allocator)) |session_ids| {
        defer {
            for (session_ids) |id| std.heap.page_allocator.free(id);
            if (session_ids.len > 0) std.heap.page_allocator.free(session_ids);
        }
        eve_sidecar.sweepOrphanedSessions(init.io, data_dir, session_ids);
    } else |_| {}
    defer app.lock.deinit();
    defer app.vault.deinit();
    defer app.store.deinit();
    // Stop the accept thread before the store goes away so a late request
    // cannot touch a closed database.
    defer agent_server.stop(&app.agent);
    defer app.eve.stop();

    var builtin_bridge_commands = [_]native_sdk.BridgeCommandPolicy{
        .{ .name = "native-sdk.dialog.openFile", .origins = bridgeOrigins(dev_mode) },
    };
    try runner.runWithOptions(app.app(), .{
        .app_name = "Sage",
        .window_title = if (dev_mode) "Sage (dev)" else "Sage",
        .bundle_id = app_id,
        .data_dir = data_dir,
        .icon_path = "assets/icon.svg",
        .bridge = app.bridge(dev_mode),
        .builtin_bridge = .{
            .enabled = true,
            .commands = &builtin_bridge_commands,
        },
        // The journal above is the only app.db this process opens, and it
        // already honors SAGE_DATA_DIR. Handing the runner that same database
        // keeps it from opening a second one under the platform data dir.
        .relational_store = app.store.db.binding(),
        .security = .{
            .navigation = .{
                .allowed_origins = navigationOrigins(dev_mode),
                .external_links = .{
                    .action = .open_system_browser,
                    .allowed_urls = &external_link_urls,
                },
            },
        },
    }, init);
}

test {
    _ = journal;
    _ = keychain;
    _ = lock_mod;
    _ = menu;
    _ = session_lock;
    _ = touchid;
    _ = vault_mod;
    _ = window_chrome;
    _ = import_mod;
    _ = export_mod;
    _ = @import("ollama.zig");
    _ = @import("agent_server.zig");
    _ = @import("eve_sidecar.zig");
    _ = @import("dream.zig");
}

// --- async bridge tests ---
//
// These drive the real worker-queue-drain path with a fake platform wake and
// a capturing responder. Ollama may or may not be running where tests run;
// both outcomes must produce a well-formed bridge response.

const WakeProbe = struct {
    wakes: std.atomic.Value(u32) = .init(0),

    fn wake(context: ?*anyopaque) anyerror!void {
        const self: *WakeProbe = @ptrCast(@alignCast(context.?));
        _ = self.wakes.fetchAdd(1, .monotonic);
    }
};

const ResponseCapture = struct {
    done: std.atomic.Value(bool) = .init(false),
    buffer: [2048]u8 = undefined,
    len: usize = 0,

    fn respond(context: *anyopaque, source: native_sdk.bridge.Source, response: []const u8) anyerror!void {
        _ = source;
        const self: *ResponseCapture = @ptrCast(@alignCast(context));
        if (response.len <= self.buffer.len) {
            @memcpy(self.buffer[0..response.len], response);
            self.len = response.len;
        }
        self.done.store(true, .release);
    }

    fn body(self: *const ResponseCapture) []const u8 {
        return self.buffer[0..self.len];
    }
};

fn expectOkResponse(response: []const u8) !void {
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":true,\"result\":{\"ok\":true}") != null);
}

/// A bridge failure carries the error's name as its message.
fn expectFailedResponse(response: []const u8, name: []const u8) !void {
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    var needle_buf: [96]u8 = undefined;
    const needle = try std.fmt.bufPrint(&needle_buf, "\"message\":\"{s}\"", .{name});
    try std.testing.expect(std.mem.indexOf(u8, response, needle) != null);
}

const EmbedTestRig = struct {
    app: App,
    /// `App.env_map` points here: handlers read PATH from it.
    env: std.process.Environ.Map,
    queue: EmbedQueue = .{},
    dream_queue: dream.Queue = .{},
    lock_queue: LockQueue = .{},
    agent_queue: agent_server.Queue = .{},
    capture: ResponseCapture = .{},
    // Heap-allocated: a detached worker's final wake may land after the test
    // frame has unwound.
    probe: *WakeProbe,

    /// Initializes in place: `app.embed_queue` points at `self.queue` and
    /// `app.lock` borrows the store's database, so the rig must not move
    /// after init.
    fn init(self: *EmbedTestRig) !void {
        const open_result = try native_sdk.RelationalStore.openMemoryMigrated(std.testing.allocator, &journal.migrations);
        const db = switch (open_result.outcome) {
            .ok => open_result.database.?,
            else => return error.SqliteMigrationFailed,
        };
        const probe = try std.heap.page_allocator.create(WakeProbe);
        probe.* = .{};
        self.* = .{
            .app = .{
                .env_map = undefined,
                .io = std.testing.io,
                .app_id = "com.wasimxyz.sage-test",
                .store = journal.Store.init(std.testing.allocator, db),
                .lock = undefined,
                .vault = undefined,
                .lock_queue = undefined,
                .embed_queue = undefined,
                .dream_queue = undefined,
                .agent_queue = undefined,
                .memory_mode_ready = true,
                .file_vault = .unknown,
                // Never read again: a test must not run `fdesetup`.
                .file_vault_read_ms = std.math.maxInt(i64),
                .handlers = undefined,
                .async_handlers = undefined,
            },
            .env = std.process.Environ.Map.init(std.testing.allocator),
            .probe = probe,
        };
        self.app.env_map = &self.env;
        self.app.embed_queue = &self.queue;
        self.app.dream_queue = &self.dream_queue;
        self.app.lock_queue = &self.lock_queue;
        self.app.agent_queue = &self.agent_queue;
        self.app.vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &self.app.store.db);
        self.app.store.vault = &self.app.vault;
        self.app.lock = try lock_mod.Lock.init(std.testing.allocator, std.testing.io, &self.app.store.db);
        self.app.services = .{ .context = probe, .wake_fn = WakeProbe.wake };
        self.app.pull_abort = .{ .io = std.testing.io };
        syncPendingFlags(&self.app);
    }

    /// Simulate a fresh process: reload lock and vault rows, copy the pending
    /// flags, forget the in-memory recovery candidate, and leave the lock in
    /// whatever state `Lock.init` chose. A new `Lock` starts with no recovered
    /// session, the way a new process does.
    fn relaunch(self: *EmbedTestRig) !void {
        wipeRecoveryCandidate(&self.app);
        self.app.lock.deinit();
        self.app.lock = try lock_mod.Lock.init(std.testing.allocator, std.testing.io, &self.app.store.db);
        self.app.vault.deinit();
        self.app.vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &self.app.store.db);
        self.app.store.vault = &self.app.vault;
        syncPendingFlags(&self.app);
    }

    fn deinit(self: *EmbedTestRig) void {
        dream.abort(dreamHost(&self.app), "test ended.");
        self.queue.jobs.deinit(std.heap.page_allocator);
        self.dream_queue.jobs.deinit(std.heap.page_allocator);
        self.lock_queue.jobs.deinit(std.heap.page_allocator);
        self.agent_queue.jobs.deinit(std.heap.page_allocator);
        self.app.lock.deinit();
        self.app.vault.deinit();
        self.app.store.deinit();
        self.env.deinit();
    }

    fn responder(self: *EmbedTestRig) native_sdk.bridge.AsyncResponder {
        return .{ .context = &self.capture, .source = .{}, .respond_fn = ResponseCapture.respond };
    }

    /// Call an async handler that answers inside the call, the way the lock
    /// commands do when a password is the proof and no system sheet shows.
    /// Returns the response envelope.
    fn callNow(self: *EmbedTestRig, handler: anytype, invocation: native_sdk.bridge.Invocation) ![]const u8 {
        self.capture.done.store(false, .release);
        self.capture.len = 0;
        try handler(@ptrCast(&self.app), invocation, self.responder());
        try std.testing.expect(self.capture.done.load(.acquire));
        return self.capture.body();
    }

    /// Simulate the event loop: drain the queue until the responder fires.
    fn pump(self: *EmbedTestRig) !void {
        try self.pumpUntil(130_000);
    }

    fn pumpUntil(self: *EmbedTestRig, timeout_ms: i64) !void {
        var waited_ms: i64 = 0;
        while (!self.capture.done.load(.acquire) and waited_ms < timeout_ms) {
            std.Io.sleep(std.testing.io, .fromMilliseconds(10), .awake) catch {};
            drainEmbedJobs(&self.app);
            drainDreamJobs(&self.app);
            waited_ms += 10;
        }
        try std.testing.expect(self.capture.done.load(.acquire));
    }
};

test "embeddings.status answers through the worker queue" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-status", .command = "embeddings.status", .payload = "{}" },
        .source = .{},
    };
    try handleEmbeddingsStatus(@ptrCast(&rig.app), invocation, rig.responder());
    try rig.pump();

    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"id\":\"t-status\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"running\":") != null);
    try std.testing.expect(rig.probe.wakes.load(.acquire) >= 1);
}

test "system.hardware reports chip and memory" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-hw", .command = "system.hardware", .payload = "{}" },
        .source = .{},
    };
    var output: [512]u8 = undefined;
    const json = try handleSystemHardware(@ptrCast(&rig.app), invocation, &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"chipName\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"ramGb\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"cpuCores\":") != null);
}

test "ollama.pulls is idle with no pull" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-pulls", .command = "ollama.pulls", .payload = "{}" },
        .source = .{},
    };
    var output: [256]u8 = undefined;
    const json = try handleOllamaPulls(@ptrCast(&rig.app), invocation, &output);
    try std.testing.expectEqualStrings("{\"pull\":null}", json);
}

test "ollama.pulls serializes an active pull" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    try std.testing.expect(rig.app.pull_state.begin(std.testing.io, "qwen3:0.6b"));

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-pulls-active", .command = "ollama.pulls", .payload = "{}" },
        .source = .{},
    };
    var output: [512]u8 = undefined;
    const json = try handleOllamaPulls(@ptrCast(&rig.app), invocation, &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"model\":\"qwen3:0.6b\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"active\":true") != null);
}

test "ollama.pull refuses a second download" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    try std.testing.expect(rig.app.pull_state.begin(std.testing.io, "qwen3:0.6b"));

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-pull-busy", .command = "ollama.pull", .payload = "{\"name\":\"qwen3:8b\"}" },
        .source = .{},
    };
    var output: [128]u8 = undefined;
    try std.testing.expectError(
        error.DownloadInProgress,
        handleOllamaPull(@ptrCast(&rig.app), invocation, &output),
    );
}

test "ollama.delete refuses a missing name" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-del-missing", .command = "ollama.delete", .payload = "{}" },
        .source = .{},
    };
    try handleOllamaDelete(@ptrCast(&rig.app), invocation, rig.responder());
    try std.testing.expect(rig.capture.done.load(.acquire));
    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "Missing model name.") != null);
}

test "ollama.delete refuses a model that is pulling" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    try std.testing.expect(rig.app.pull_state.begin(std.testing.io, "qwen3:8b"));

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-del-busy", .command = "ollama.delete", .payload = "{\"name\":\"qwen3:8b\"}" },
        .source = .{},
    };
    try handleOllamaDelete(@ptrCast(&rig.app), invocation, rig.responder());
    try std.testing.expect(rig.capture.done.load(.acquire));
    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "A download of this model is in progress.") != null);
}

test "embeddings.generate completes through the worker queue" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-gen", .command = "embeddings.generate", .payload = "{\"id\":1}" },
        .source = .{},
    };
    try handleEmbeddingsGenerate(@ptrCast(&rig.app), invocation, rig.responder());
    try rig.pump();

    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"id\":\"t-gen\"") != null);
    if (std.mem.indexOf(u8, response, "\"ok\":true") != null) {
        // Ollama is running: one short entry embeds as a single chunk.
        try std.testing.expect(std.mem.indexOf(u8, response, "\"chunks\":1") != null);
        try std.testing.expect(std.mem.indexOf(u8, response, "\"dimensions\":") != null);
    } else {
        // No Ollama here: the failure must still be a well-formed response.
        try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    }
    try std.testing.expect(rig.probe.wakes.load(.acquire) >= 1);
}

test "embeddings.generate reports a missing entry" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-missing", .command = "embeddings.generate", .payload = "{\"id\":999}" },
        .source = .{},
    };
    try handleEmbeddingsGenerate(@ptrCast(&rig.app), invocation, rig.responder());

    // The load fails on the calling thread — no worker, no wake.
    try std.testing.expect(rig.capture.done.load(.acquire));
    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "Entry not found.") != null);
}

test "dream.status reports idle" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-dream-status", .command = "dream.status", .payload = "{}" },
        .source = .{},
    };
    var output: [128]u8 = undefined;
    const json = try handleDreamStatus(@ptrCast(&rig.app), invocation, &output);
    try std.testing.expectEqualStrings(
        "{\"running\":false,\"done\":0,\"total\":0,\"lastDreamedAt\":null}",
        json,
    );
}

test "features.get reports build mode and memory bridge reads are gated" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.app.memory_mode_ready = false;

    const features = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-features", .command = "features.get", .payload = "{}" },
        .source = .{},
    };
    var output: [4096]u8 = undefined;
    try std.testing.expectError(error.MemoryModeUnavailable, handleFeaturesGet(@ptrCast(&rig.app), features, &output));
    rig.app.memory_mode_ready = true;
    const expected = if (build_options.memory_enabled) "{\"memory\":true}" else "{\"memory\":false}";
    try std.testing.expectEqualStrings(expected, try handleFeaturesGet(@ptrCast(&rig.app), features, &output));

    const memories = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-memory-list", .command = "memory.list", .payload = "{}" },
        .source = .{},
    };
    if (build_options.memory_enabled) {
        try std.testing.expect(std.mem.indexOf(u8, try handleMemoryList(@ptrCast(&rig.app), memories, &output), "\"profile\"") != null);
    } else {
        try std.testing.expectError(error.MemoryUnavailable, handleMemoryList(@ptrCast(&rig.app), memories, &output));
    }
}

test "memory mode startup transition is destructive only when disabling" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var data_dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = ".keep", .data = "" });
    const keep_len = try tmp.dir.realPathFile(std.testing.io, ".keep", &data_dir_buf);
    const data_dir = std.fs.path.dirname(data_dir_buf[0..keep_len]) orelse return error.InvalidPath;
    try tmp.dir.createDirPath(std.testing.io, "eve/.eve/.workflow-data");
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "eve/.eve/.workflow-data/old-run", .data = "old" });

    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.app.data_dir = data_dir;
    try memory_feature.write(
        std.testing.io,
        data_dir,
        if (build_options.memory_enabled) .disabled else .enabled,
    );

    const insert_old_chat = rig.app.store.db.exec(&.{.{
        .sql = "INSERT INTO chat_conversation (id, title, events) VALUES (?1, ?2, ?3);",
        .params = &.{ .{ .integer = 44 }, .{ .text = "Old chat" }, .{ .text = "" } },
    }});
    try std.testing.expect(insert_old_chat == .ok);
    _ = try rig.app.store.saveMemory(.{
        .fact = "Old profile memory",
        .kind = .profile,
        .model_name = "user",
    });

    try syncMemoryFeatureMode(&rig.app);
    try std.testing.expect(rig.app.memory_mode_ready);
    var memories_out: [4096]u8 = undefined;
    const memories = try rig.app.store.listMemories(&memories_out);
    var chats_out: [4096]u8 = undefined;
    const chats = try rig.app.store.chatList(&chats_out);
    const workflow = try std.fmt.allocPrint(std.testing.allocator, "{s}/eve/.eve/.workflow-data", .{data_dir});
    defer std.testing.allocator.free(workflow);
    const workflow_exists = blk: {
        std.Io.Dir.accessAbsolute(std.testing.io, workflow, .{}) catch break :blk false;
        break :blk true;
    };

    if (build_options.memory_enabled) {
        try std.testing.expect(std.mem.indexOf(u8, memories, "Old profile memory") != null);
        try std.testing.expect(std.mem.indexOf(u8, chats, "Old chat") != null);
        try std.testing.expect(workflow_exists);
    } else {
        try std.testing.expect(std.mem.indexOf(u8, memories, "Old profile memory") == null);
        try std.testing.expect(std.mem.indexOf(u8, chats, "Old chat") == null);
        try std.testing.expect(!workflow_exists);
    }

    const insert_new_chat = rig.app.store.db.exec(&.{.{
        .sql = "INSERT INTO chat_conversation (id, title, events) VALUES (?1, ?2, ?3);",
        .params = &.{ .{ .integer = 45 }, .{ .text = "New chat" }, .{ .text = "" } },
    }});
    try std.testing.expect(insert_new_chat == .ok);
    try syncMemoryFeatureMode(&rig.app);
    const after_second_sync = try rig.app.store.chatList(&chats_out);
    try std.testing.expect(std.mem.indexOf(u8, after_second_sync, "New chat") != null);
}

test "failed memory disable scrub stays pending and retries before Chat is ready" {
    if (build_options.memory_enabled) return;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var data_dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = ".keep", .data = "" });
    const keep_len = try tmp.dir.realPathFile(std.testing.io, ".keep", &data_dir_buf);
    const data_dir = std.fs.path.dirname(data_dir_buf[0..keep_len]) orelse return error.InvalidPath;

    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    rig.app.data_dir = data_dir;
    try memory_feature.write(std.testing.io, data_dir, .enabled);
    rig.app.store.fail_next_scrub = true;

    try std.testing.expectError(error.Busy, syncMemoryFeatureMode(&rig.app));
    try std.testing.expect(!rig.app.memory_mode_ready);
    try std.testing.expectEqual(.disabling, try memory_feature.read(std.testing.io, std.testing.allocator, data_dir));

    try syncMemoryFeatureMode(&rig.app);
    try std.testing.expect(rig.app.memory_mode_ready);
    try std.testing.expectEqual(.disabled, try memory_feature.read(std.testing.io, std.testing.allocator, data_dir));
}

test "dream.status includes lastDreamedAt after markDreamed" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    try rig.app.store.markDreamed(.entry, 1);

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-dream-last", .command = "dream.status", .payload = "{}" },
        .source = .{},
    };
    var output: [192]u8 = undefined;
    const json = try handleDreamStatus(@ptrCast(&rig.app), invocation, &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"lastDreamedAt\":\"20") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"running\":false") != null);
}

test "dream.start answers after the Ollama check" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.store.deleteAllData(&output);

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-dream", .command = "dream.start", .payload = "{}" },
        .source = .{},
    };
    try handleDreamStart(@ptrCast(&rig.app), invocation, rig.responder());
    try rig.pump();

    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"id\":\"t-dream\"") != null);
    if (std.mem.indexOf(u8, response, "\"ok\":true") != null) {
        try std.testing.expect(std.mem.indexOf(u8, response, "\"total\":0") != null);
    } else {
        try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    }
    try std.testing.expect(rig.probe.wakes.load(.acquire) >= 1);
}

test "dream.start refuses when already running" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    rig.app.dream_runner.running = true;
    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-dream-busy", .command = "dream.start", .payload = "{}" },
        .source = .{},
    };
    try handleDreamStart(@ptrCast(&rig.app), invocation, rig.responder());
    try std.testing.expect(rig.capture.done.load(.acquire));
    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "Sage is already dreaming.") != null);
}

test "lock.setIdleTimeout requires unlock and validates its value" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    try std.testing.expect(rig.app.lock.lockSession());

    const set_timeout = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-idle-timeout", .command = "lock.setIdleTimeout", .payload = "{\"idleTimeoutMs\":900000}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleLockSetIdleTimeout(@ptrCast(&rig.app), set_timeout, &output));

    const unlock = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-idle-unlock", .command = "lock.unlock", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleLockUnlock(@ptrCast(&rig.app), unlock, &output);
    try std.testing.expectEqualStrings("{\"ok\":true}", try handleLockSetIdleTimeout(@ptrCast(&rig.app), set_timeout, &output));
    try std.testing.expectEqual(@as(i64, 900_000), rig.app.lock.idle_timeout_ms);

    const invalid = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-idle-invalid", .command = "lock.setIdleTimeout", .payload = "{\"idleTimeoutMs\":120000}" },
        .source = .{},
    };
    try std.testing.expectError(error.InvalidIdleTimeout, handleLockSetIdleTimeout(@ptrCast(&rig.app), invalid, &output));
}

test "journal commands refuse while locked and answer after unlock" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    // Simulate a fresh launch: the lock row exists and the process is locked.
    rig.app.lock.unlocked = false;

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-locked", .command = "journal.list", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleList(@ptrCast(&rig.app), invocation, &output));
    const export_invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-export-locked", .command = "journal.export", .payload = "{\"destDir\":\"/tmp\"}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleExport(@ptrCast(&rig.app), export_invocation, &output));

    _ = try rig.app.lock.unlockPassword("{\"password\":\"correct horse\"}", &output);
    const json = try handleList(@ptrCast(&rig.app), invocation, &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Morning walk") != null);
}

test "home.feed refuses while locked and answers after unlock" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.lock.unlocked = false;

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-home-locked", .command = "home.feed", .payload = "{\"sinceDate\":\"2026-08-18\"}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleHomeFeed(@ptrCast(&rig.app), invocation, &output));

    _ = try rig.app.lock.unlockPassword("{\"password\":\"correct horse\"}", &output);
    const json = try handleHomeFeed(@ptrCast(&rig.app), invocation, &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Quiet evening") != null);
}

test "data.deleteAll refuses while locked and wipes content after unlock" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    const insert_chat = rig.app.store.db.exec(&.{.{
        .sql = "INSERT INTO chat_conversation (title, eve_session_id, stream_index, events) VALUES (?1, NULL, 0, ?2);",
        .params = &.{ .{ .text = "To wipe" }, .{ .text = "[]" } },
    }});
    try std.testing.expect(insert_chat == .ok);
    rig.app.lock.unlocked = false;

    const wipe = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-wipe", .command = "data.deleteAll", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleDataDeleteAll(@ptrCast(&rig.app), wipe, &output));

    _ = try rig.app.lock.unlockPassword("{\"password\":\"correct horse\"}", &output);
    const wiped = try handleDataDeleteAll(@ptrCast(&rig.app), wipe, &output);
    try std.testing.expectEqualStrings("{\"ok\":true}", wiped);

    const list = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-list", .command = "journal.list", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectEqualStrings("{\"entries\":[]}", try handleList(@ptrCast(&rig.app), list, &output));
    try std.testing.expectEqualStrings("{\"conversations\":[]}", try handleChatList(@ptrCast(&rig.app), list, &output));

    const status = try handleLockStatus(@ptrCast(&rig.app), list, &output);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"passwordSet\":true") != null);
}

test "data.deleteEntries refuses while locked" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.lock.unlocked = false;
    const wipe = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-delete-entries", .command = "data.deleteEntries", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleDataDeleteEntries(@ptrCast(&rig.app), wipe, &output));

    _ = try rig.app.lock.unlockPassword("{\"password\":\"correct horse\"}", &output);
    try std.testing.expectEqualStrings("{\"ok\":true}", try handleDataDeleteEntries(@ptrCast(&rig.app), wipe, &output));
    try std.testing.expectEqualStrings("{\"entries\":[]}", try handleList(@ptrCast(&rig.app), wipe, &output));
}

test "conversation wipe keeps workflow files when the database delete fails" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    const io = std.testing.io;
    var data_dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const data_dir = try std.fmt.bufPrint(
        &data_dir_buf,
        "/tmp/sage-data-wipe-failure-{d}",
        .{std.Io.Clock.awake.now(io).toMilliseconds()},
    );
    var workflow_dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const workflow_dir = try std.fmt.bufPrint(
        &workflow_dir_buf,
        "{s}/eve/.eve/.workflow-data/events",
        .{data_dir},
    );
    try std.Io.Dir.cwd().createDirPath(io, workflow_dir);
    var workflow_file_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const workflow_file = try std.fmt.bufPrint(&workflow_file_buf, "{s}/saved.json", .{workflow_dir});
    var file = try std.Io.Dir.createFileAbsolute(io, workflow_file, .{});
    try file.writeStreamingAll(io, "preserved workflow");
    file.close(io);
    rig.app.data_dir = data_dir;

    const drop = rig.app.store.db.exec(&.{.{
        .sql = "DROP TABLE chat_event;",
        .params = &.{},
    }});
    try std.testing.expect(drop == .ok);
    const wipe = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-delete-conversations-fail", .command = "data.deleteConversations", .payload = "{}" },
        .source = .{},
    };
    var output: [8192]u8 = undefined;
    try std.testing.expectError(error.SqliteWriteFailed, handleDataDeleteConversations(@ptrCast(&rig.app), wipe, &output));
    try std.Io.Dir.accessAbsolute(io, workflow_file, .{});

    var tmp_parent = try std.Io.Dir.openDirAbsolute(io, "/tmp", .{});
    defer tmp_parent.close(io);
    tmp_parent.deleteTree(io, std.fs.path.basename(data_dir)) catch {};
}

test "stale embed jobs do not write after deleteAllData" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    const stale_generation = rig.app.store.data_generation;
    var output: [8192]u8 = undefined;
    _ = try rig.app.store.deleteAllData(&output);
    _ = try rig.app.store.save(
        "{\"id\":null,\"title\":\"After wipe\",\"date\":\"2026-09-13\",\"wordCount\":2,\"format\":\"plain\",\"offset\":0,\"chunk\":\"Fresh entry.\",\"done\":true}",
        &output,
    );

    const allocator = rig.app.store.allocator;
    const stale_embed = try allocator.create(EmbedJob);
    const stale_chunk = try allocator.dupe(u8, "revived deleted text");
    const stale_chunks = try allocator.alloc([]const u8, 1);
    stale_chunks[0] = stale_chunk;
    const stale_vec = try allocator.alloc(f32, 3);
    stale_vec[0] = 0.1;
    stale_vec[1] = 0.2;
    stale_vec[2] = 0.3;
    const stale_vectors = try allocator.alloc([]f32, 1);
    stale_vectors[0] = stale_vec;
    stale_embed.* = .{
        .kind = .generate,
        .responder = rig.responder(),
        .request_id = try allocator.dupe(u8, "t-stale-embed"),
        .entry_id = 1,
        .chunks = stale_chunks,
        .vectors = stale_vectors,
        .model_name = try allocator.dupe(u8, "nomic-embed-text:v1.5"),
        .generation = stale_generation,
    };
    completeEmbedJob(&rig.app, stale_embed);
    try std.testing.expect(std.mem.indexOf(u8, rig.capture.body(), "Journal data was deleted.") != null);
    try std.testing.expectEqualStrings("{\"ids\":[1]}", try rig.app.store.listPendingEmbeddings(&output));

    rig.capture = .{};
    const fresh_embed = try allocator.create(EmbedJob);
    const fresh_chunk = try allocator.dupe(u8, "fresh chunk");
    const fresh_chunks = try allocator.alloc([]const u8, 1);
    fresh_chunks[0] = fresh_chunk;
    const fresh_vec = try allocator.alloc(f32, 3);
    fresh_vec[0] = 0.4;
    fresh_vec[1] = 0.5;
    fresh_vec[2] = 0.6;
    const fresh_vectors = try allocator.alloc([]f32, 1);
    fresh_vectors[0] = fresh_vec;
    fresh_embed.* = .{
        .kind = .generate,
        .responder = rig.responder(),
        .request_id = try allocator.dupe(u8, "t-fresh-embed"),
        .entry_id = 1,
        .chunks = fresh_chunks,
        .vectors = fresh_vectors,
        .model_name = try allocator.dupe(u8, "nomic-embed-text:v1.5"),
        .generation = rig.app.store.data_generation,
    };
    completeEmbedJob(&rig.app, fresh_embed);
    try std.testing.expectEqualStrings("{\"ids\":[]}", try rig.app.store.listPendingEmbeddings(&output));
}

test "journal.export refuses while locked" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.lock.unlocked = false;

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-export-locked", .command = "journal.export", .payload = "{\"destDir\":\"/tmp\"}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleExport(@ptrCast(&rig.app), invocation, &output));
}

test "journal.export refuses while a rewrite is pending" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    try markRewritePending(&rig.app, true);

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-export-securing", .command = "journal.export", .payload = "{\"destDir\":\"/tmp\"}" },
        .source = .{},
    };
    try std.testing.expectError(error.Securing, handleExport(@ptrCast(&rig.app), invocation, &output));
}

test "embeddings.generate refuses while locked" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.lock.unlocked = false;

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-gen-locked", .command = "embeddings.generate", .payload = "{\"id\":1}" },
        .source = .{},
    };
    try handleEmbeddingsGenerate(@ptrCast(&rig.app), invocation, rig.responder());

    // The refusal is immediate — no worker, no wake.
    try std.testing.expect(rig.capture.done.load(.acquire));
    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "Sage is locked.") != null);
}

test "dream.start refuses while locked" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.lock.unlocked = false;

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-dream-locked", .command = "dream.start", .payload = "{}" },
        .source = .{},
    };
    try handleDreamStart(@ptrCast(&rig.app), invocation, rig.responder());

    try std.testing.expect(rig.capture.done.load(.acquire));
    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "Sage is locked.") != null);
}

test "encryption.enable refuses while locked and without a password" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };

    // No password set: encryption has nothing to derive the wrapping key from.
    try std.testing.expectError(error.PasswordRequired, handleEncryptionEnable(@ptrCast(&rig.app), invocation, &output));

    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.lock.unlocked = false;
    try std.testing.expectError(error.Locked, handleEncryptionEnable(@ptrCast(&rig.app), invocation, &output));
}

test "encryption round-trips through a simulated relaunch" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);

    const enable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-on", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), enable, &output);
    try std.testing.expect(rig.app.vault.enabled);

    // A wrong password is rejected before anything unlocks.
    const wrong = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-wrong", .command = "lock.unlock", .payload = "{\"password\":\"nope\"}" },
        .source = .{},
    };
    try std.testing.expectError(error.WrongPassword, handleLockUnlock(@ptrCast(&rig.app), wrong, &output));

    // Simulate a relaunch: fresh lock and vault state read from the database.
    try rig.relaunch();
    try std.testing.expect(!rig.app.lock.unlocked);
    try std.testing.expect(rig.app.vault.enabled);
    try std.testing.expect(rig.app.vault.dataKey() == null);

    const list = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-list", .command = "journal.list", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleList(@ptrCast(&rig.app), list, &output));

    const unlock = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-unlock", .command = "lock.unlock", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleLockUnlock(@ptrCast(&rig.app), unlock, &output);
    try std.testing.expect(rig.app.vault.dataKey() != null);
    const json = try handleList(@ptrCast(&rig.app), list, &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Morning walk") != null);

    // Status reports the encrypted flag to the frontend.
    const status = try handleLockStatus(@ptrCast(&rig.app), list, &output);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"encrypted\":true") != null);

    // Disabling encryption returns the rows to plaintext and drops the key.
    const disable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-off", .command = "encryption.disable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    try expectOkResponse(try rig.callNow(handleEncryptionDisable, disable));
    try std.testing.expect(!rig.app.vault.enabled);
    const status_after = try handleLockStatus(@ptrCast(&rig.app), list, &output);
    try std.testing.expect(std.mem.indexOf(u8, status_after, "\"encrypted\":false") != null);
}

test "session lock clears the key and gates journal and Chat until unlock" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer rig.app.eve.clearWorldKey();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    const enable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-session-enc", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), enable, &output);
    try std.testing.expect(rig.app.vault.enabled);
    try std.testing.expect(rig.app.vault.dataKey() != null);

    sessionLock(&rig.app);
    try std.testing.expect(!rig.app.lock.unlocked);
    try std.testing.expect(rig.app.vault.enabled);
    try std.testing.expect(rig.app.vault.dataKey() == null);
    try std.testing.expect(rig.app.eve.world_key_hex == null);

    const list = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-session-list", .command = "journal.list", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleList(@ptrCast(&rig.app), list, &output));
    const token = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-session-token", .command = "chat.agentToken", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleChatAgentToken(@ptrCast(&rig.app), token, &output));

    const unlock = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-session-unlock", .command = "lock.unlock", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleLockUnlock(@ptrCast(&rig.app), unlock, &output);
    try std.testing.expect(rig.app.lock.unlocked);
    try std.testing.expect(rig.app.vault.dataKey() != null);
    try std.testing.expect(rig.app.eve.world_key_hex != null);
    try std.testing.expect(std.mem.indexOf(u8, try handleList(@ptrCast(&rig.app), list, &output), "Morning walk") != null);
    try std.testing.expectEqualStrings("{\"token\":\"\"}", try handleChatAgentToken(@ptrCast(&rig.app), token, &output));
}

test "encryption.enable retries finish the row rewrite" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);

    const enable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-on", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), enable, &output);
    try std.testing.expect(rig.app.vault.enabled);

    // A second call — the retry after a first attempt failed mid-rewrite —
    // succeeds instead of failing with AlreadyEnabled.
    const retry = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-retry", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    const json = try handleEncryptionEnable(@ptrCast(&rig.app), retry, &output);
    try std.testing.expectEqualStrings("{\"ok\":true}", json);
    try std.testing.expect(rig.app.vault.enabled);

    // A retry with the wrong password is still refused before any work.
    const wrong = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-wrong", .command = "encryption.enable", .payload = "{\"password\":\"nope\"}" },
        .source = .{},
    };
    try std.testing.expectError(error.WrongPassword, handleEncryptionEnable(@ptrCast(&rig.app), wrong, &output));
}

test "encryption.scrub clears a pending file scrub" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);

    const enable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-on", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), enable, &output);
    try std.testing.expect(!rig.app.rewrite_pending);
    try std.testing.expect(!rig.app.scrub_pending);

    // Simulate a launch (or a failed enable scrub) that still needs the file rebuilt.
    try markScrubPending(&rig.app, true);
    const list = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-status", .command = "lock.status", .payload = "{}" },
        .source = .{},
    };
    const status = try handleLockStatus(@ptrCast(&rig.app), list, &output);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"securing\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"scrubbing\":true") != null);

    const scrub = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-scrub", .command = "encryption.scrub", .payload = "{}" },
        .source = .{},
    };
    const json = try handleEncryptionScrub(@ptrCast(&rig.app), scrub, &output);
    try std.testing.expectEqualStrings("{\"ok\":true}", json);
    try std.testing.expect(!rig.app.scrub_pending);

    const again = try handleEncryptionScrub(@ptrCast(&rig.app), scrub, &output);
    try std.testing.expectEqualStrings("{\"ok\":true}", again);
    try std.testing.expect(!rig.app.scrub_pending);

    const status_after = try handleLockStatus(@ptrCast(&rig.app), list, &output);
    try std.testing.expect(std.mem.indexOf(u8, status_after, "\"securing\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_after, "\"scrubbing\":false") != null);
}

test "a crash mid-rewrite waits for unlock before scrubbing" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    try rig.app.vault.enable("correct horse");
    syncPendingFlags(&rig.app);
    try std.testing.expect(rig.app.rewrite_pending);

    try rig.relaunch();
    try std.testing.expect(!rig.app.lock.unlocked);
    try std.testing.expect(rig.app.rewrite_pending);
    try std.testing.expect(rig.app.vault.enabled);
    try std.testing.expect(rig.app.vault.dataKey() == null);

    const status_inv = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-status", .command = "lock.status", .payload = "{}" },
        .source = .{},
    };
    const status = try handleLockStatus(@ptrCast(&rig.app), status_inv, &output);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"securing\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"scrubbing\":false") != null);

    const scrub = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-scrub", .command = "encryption.scrub", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleEncryptionScrub(@ptrCast(&rig.app), scrub, &output));
    try std.testing.expect(rig.app.rewrite_pending);

    const list = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-list", .command = "journal.list", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleList(@ptrCast(&rig.app), list, &output));

    const unlock = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-unlock", .command = "lock.unlock", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleLockUnlock(@ptrCast(&rig.app), unlock, &output);
    try std.testing.expectError(error.Securing, handleList(@ptrCast(&rig.app), list, &output));

    const status_unlocked = try handleLockStatus(@ptrCast(&rig.app), status_inv, &output);
    try std.testing.expect(std.mem.indexOf(u8, status_unlocked, "\"securing\":true") != null);

    const json = try handleEncryptionScrub(@ptrCast(&rig.app), scrub, &output);
    try std.testing.expectEqualStrings("{\"ok\":true}", json);
    try std.testing.expect(!rig.app.rewrite_pending);
    try std.testing.expect(!rig.app.scrub_pending);
    try std.testing.expect(!(try rig.app.store.hasPlaintextProtectedFields()));
    const listed = try handleList(@ptrCast(&rig.app), list, &output);
    try std.testing.expect(std.mem.indexOf(u8, listed, "Morning walk") != null);
}

test "a crashed disable finishes turning encryption off after unlock" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    const prefix_looking_body = "sage:v1:my plain journal text";
    const seed_body = rig.app.store.db.exec(&.{.{
        .sql = "UPDATE journal_entry SET body = ?1 WHERE id = 1;",
        .params = &.{.{ .text = prefix_looking_body }},
    }});
    try std.testing.expect(seed_body == .ok);
    const enable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-on", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), enable, &output);

    // The process stops after decrypting rows but before dropping the key.
    try rig.app.vault.beginDisable();
    syncPendingFlags(&rig.app);
    try rig.app.store.setRowsEncrypted(false);
    try std.testing.expect(rig.app.vault.enabled);
    try std.testing.expect(rig.app.disable_pending);
    try std.testing.expect(rig.app.rewrite_pending);

    try rig.relaunch();
    try std.testing.expect(!rig.app.lock.unlocked);
    try std.testing.expect(rig.app.vault.enabled);
    try std.testing.expect(rig.app.vault.dataKey() == null);
    try std.testing.expect(rig.app.disable_pending);
    try std.testing.expect(rig.app.rewrite_pending);

    const scrub = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-disable-resume", .command = "encryption.scrub", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleEncryptionScrub(@ptrCast(&rig.app), scrub, &output));

    const unlock = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-unlock", .command = "lock.unlock", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleLockUnlock(@ptrCast(&rig.app), unlock, &output);
    _ = try handleEncryptionScrub(@ptrCast(&rig.app), scrub, &output);

    try std.testing.expect(!rig.app.vault.enabled);
    try std.testing.expect(rig.app.vault.kdf_json.len == 0);
    try std.testing.expect(rig.app.vault.wrapped_key.len == 0);
    try std.testing.expect(rig.app.vault.dataKey() == null);
    try std.testing.expect(!rig.app.disable_pending);
    try std.testing.expect(!rig.app.rewrite_pending);
    try std.testing.expect(!rig.app.scrub_pending);

    var raw = journal.KvRows.init(std.testing.allocator);
    defer raw.deinit();
    const outcome = rig.app.store.db.query(
        "SELECT 'body' AS key, body AS value FROM journal_entry WHERE id = 1;",
        &.{},
        &raw,
        journal.KvRows.collect,
    );
    try std.testing.expect(outcome == .ok);
    try std.testing.expect(!raw.failed);
    try std.testing.expect(raw.rows.items.len == 1);
    try std.testing.expectEqualStrings(prefix_looking_body, raw.rows.items[0].value);
}

test "a failed disable decrypt keeps the vault and key" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    const enable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-on", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), enable, &output);

    var corrupted_value = try rig.app.vault.encryptField(
        std.testing.allocator,
        vault_mod.aad_entry_body,
        "damaged ciphertext",
    );
    defer std.testing.allocator.free(corrupted_value);
    const tamper_at = vault_mod.field_prefix.len + 4;
    corrupted_value[tamper_at] = if (corrupted_value[tamper_at] == 'A') 'B' else 'A';
    const corrupted = rig.app.store.db.exec(&.{.{
        .sql = "UPDATE journal_entry SET body = ?1 WHERE id = 1;",
        .params = &.{.{ .text = corrupted_value }},
    }});
    try std.testing.expect(corrupted == .ok);

    const disable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-disable-corrupt", .command = "encryption.disable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    try expectFailedResponse(try rig.callNow(handleEncryptionDisable, disable), "CorruptField");
    try std.testing.expect(rig.app.vault.enabled);
    try std.testing.expect(rig.app.vault.dataKey() != null);
    try std.testing.expect(rig.app.vault.kdf_json.len > 0);
    try std.testing.expect(rig.app.vault.wrapped_key.len > 0);
    try std.testing.expect(rig.app.disable_pending);
    try std.testing.expect(rig.app.rewrite_pending);
}

test "a password change does not scrub before a pending disable" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    const enable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-on", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), enable, &output);

    try rig.app.vault.beginDisable();
    syncPendingFlags(&rig.app);
    try markScrubPending(&rig.app, true);
    rig.app.store.fail_next_scrub = true;

    const change = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-pw-pending-disable", .command = "lock.setPassword", .payload = "{\"current\":\"correct horse\",\"next\":\"another horse\"}" },
        .source = .{},
    };
    try expectOkResponse(try rig.callNow(handleLockSetPassword, change));
    try std.testing.expect(rig.app.store.fail_next_scrub);
    try std.testing.expect(rig.app.disable_pending);
    try std.testing.expect(rig.app.rewrite_pending);
    try std.testing.expect(rig.app.scrub_pending);
}

test "startup marks plaintext protected fields for re-encryption" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    const enable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-on", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), enable, &output);

    const plaintext = rig.app.store.db.exec(&.{.{
        .sql = "UPDATE journal_entry SET body = ?1 WHERE id = 1;",
        .params = &.{.{ .text = "legacy plaintext body" }},
    }});
    try std.testing.expect(plaintext == .ok);
    try rig.relaunch();
    try std.testing.expect(!rig.app.lock.unlocked);
    try std.testing.expect(!rig.app.rewrite_pending);
    try std.testing.expect(!rig.app.disable_pending);
    try std.testing.expect(!rig.app.scrub_pending);

    try markRewriteForPlaintext(&rig.app);
    try std.testing.expect(rig.app.rewrite_pending);
    try std.testing.expect(!rig.app.disable_pending);
    try std.testing.expect(!rig.app.scrub_pending);
    try std.testing.expect(rig.app.vault.rewrite_pending);

    const scrub = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-reencrypt", .command = "encryption.scrub", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleEncryptionScrub(@ptrCast(&rig.app), scrub, &output));

    const unlock = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-unlock", .command = "lock.unlock", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleLockUnlock(@ptrCast(&rig.app), unlock, &output);
    _ = try handleEncryptionScrub(@ptrCast(&rig.app), scrub, &output);

    try std.testing.expect(!rig.app.rewrite_pending);
    try std.testing.expect(!rig.app.disable_pending);
    try std.testing.expect(!rig.app.scrub_pending);
    try std.testing.expect(!(try rig.app.store.hasPlaintextProtectedFields()));
}

test "an older vault re-encrypts plaintext that begins with the ciphertext prefix" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    const enable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-on", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), enable, &output);

    const legacy_body = "sage:v1:legacy plaintext body";
    const plaintext = rig.app.store.db.exec(&.{.{
        .sql = "UPDATE journal_entry SET body = ?1 WHERE id = 1;",
        .params = &.{.{ .text = legacy_body }},
    }});
    try std.testing.expect(plaintext == .ok);
    const old_vault = rig.app.store.db.exec(&.{.{
        .sql = "DELETE FROM app_setting WHERE key = ?1;",
        .params = &.{.{ .text = "enc.ciphertext_checked" }},
    }});
    try std.testing.expect(old_vault == .ok);

    try rig.relaunch();
    try markRewriteForPlaintext(&rig.app);
    try std.testing.expect(rig.app.rewrite_pending);

    const scrub = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-rewrite-prefix-collision", .command = "encryption.scrub", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleEncryptionScrub(@ptrCast(&rig.app), scrub, &output));

    const unlock = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-unlock-prefix-collision", .command = "lock.unlock", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleLockUnlock(@ptrCast(&rig.app), unlock, &output);
    const list = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-list-prefix-collision", .command = "journal.list", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Securing, handleList(@ptrCast(&rig.app), list, &output));
    _ = try handleEncryptionScrub(@ptrCast(&rig.app), scrub, &output);

    try std.testing.expect(rig.app.vault.ciphertext_checked);
    try std.testing.expect(!rig.app.rewrite_pending);
    var raw = journal.KvRows.init(std.testing.allocator);
    defer raw.deinit();
    const outcome = rig.app.store.db.query(
        "SELECT 'body' AS key, body AS value FROM journal_entry WHERE id = 1;",
        &.{},
        &raw,
        journal.KvRows.collect,
    );
    try std.testing.expect(outcome == .ok);
    try std.testing.expect(!raw.failed);
    try std.testing.expectEqual(@as(usize, 1), raw.rows.items.len);
    try std.testing.expect(vault_mod.Vault.isEncryptedField(raw.rows.items[0].value));
    try std.testing.expect(std.mem.indexOf(u8, raw.rows.items[0].value, "legacy plaintext body") == null);
    const opened = try rig.app.vault.decryptField(
        std.testing.allocator,
        vault_mod.aad_entry_body,
        raw.rows.items[0].value,
    );
    defer std.testing.allocator.free(opened);
    try std.testing.expectEqualStrings(legacy_body, opened);
}

test "a successful scrub does not vacuum again on the next launch" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    const enable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-on", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), enable, &output);
    try std.testing.expect(!rig.app.rewrite_pending);
    try std.testing.expect(!rig.app.scrub_pending);

    try rig.relaunch();
    try std.testing.expect(rig.app.vault.enabled);
    try std.testing.expect(!rig.app.rewrite_pending);
    try std.testing.expect(!rig.app.scrub_pending);

    const status_inv = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-status", .command = "lock.status", .payload = "{}" },
        .source = .{},
    };
    const status = try handleLockStatus(@ptrCast(&rig.app), status_inv, &output);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"securing\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"scrubbing\":false") != null);
}

test "journal commands refuse while a rewrite or scrub is pending" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);

    const list = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-list", .command = "journal.list", .payload = "{}" },
        .source = .{},
    };
    const export_invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-export-securing", .command = "journal.export", .payload = "{\"destDir\":\"/tmp\"}" },
        .source = .{},
    };
    try markRewritePending(&rig.app, true);
    try std.testing.expectError(error.Securing, handleList(@ptrCast(&rig.app), list, &output));
    try std.testing.expectError(error.Securing, handleExport(@ptrCast(&rig.app), export_invocation, &output));
    const get_instructions = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-agent-get", .command = "agent.instructions.get", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Securing, handleAgentInstructionsGet(@ptrCast(&rig.app), get_instructions, &output));
    const save_instructions = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-agent-save", .command = "agent.instructions.save", .payload = "{\"user\":\"x\"}" },
        .source = .{},
    };
    try std.testing.expectError(error.Securing, handleAgentInstructionsSave(@ptrCast(&rig.app), save_instructions, &output));
    try markRewritePending(&rig.app, false);

    try markScrubPending(&rig.app, true);
    try std.testing.expectError(error.Securing, handleList(@ptrCast(&rig.app), list, &output));
    try std.testing.expectError(error.Securing, handleExport(@ptrCast(&rig.app), export_invocation, &output));

    const generate = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-gen", .command = "embeddings.generate", .payload = "{\"id\":1}" },
        .source = .{},
    };
    try handleEmbeddingsGenerate(@ptrCast(&rig.app), generate, rig.responder());
    try std.testing.expect(rig.capture.done.load(.acquire));
    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "Sage is securing your journal.") != null);
}

test "agent get_entry refuses while securing" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    try markScrubPending(&rig.app, true);

    const io = std.testing.io;
    rig.app.agent.io = io;
    const bind = try std.Io.net.IpAddress.parseIp4("127.0.0.1", 0);
    var listener = try std.Io.net.IpAddress.listen(&bind, io, .{ .reuse_address = true });
    defer listener.deinit(io);
    const port = listener.socket.address.getPort();
    const client_addr = try std.Io.net.IpAddress.parseIp4("127.0.0.1", port);
    const client = try std.Io.net.IpAddress.connect(&client_addr, io, .{ .mode = .stream, .protocol = .tcp });
    defer client.close(io);
    const server_stream = try listener.accept(io);

    const job = try std.testing.allocator.create(agent_server.Job);
    job.* = .{ .kind = .get_entry, .stream = server_stream, .entry_id = 1 };
    completeAgentJob(&rig.app, job);

    var response: std.ArrayList(u8) = .empty;
    defer response.deinit(std.testing.allocator);
    var reader_buf: [256]u8 = undefined;
    var dest: [256]u8 = undefined;
    var reader = client.reader(io, &reader_buf);
    while (true) {
        const n = reader.interface.readSliceShort(&dest) catch break;
        if (n == 0) break;
        try response.appendSlice(std.testing.allocator, dest[0..n]);
    }
    try std.testing.expect(std.mem.indexOf(u8, response.items, "409") != null);
    try std.testing.expect(std.mem.indexOf(u8, response.items, "\"error\":\"locked\"") != null);
}

test "encryption.enable reports ok when only the file rebuild fails" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.store.fail_next_scrub = true;

    const enable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-on", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    const json = try handleEncryptionEnable(@ptrCast(&rig.app), enable, &output);
    try std.testing.expectEqualStrings("{\"ok\":true}", json);
    try std.testing.expect(rig.app.vault.enabled);
    try std.testing.expect(!rig.app.rewrite_pending);
    try std.testing.expect(rig.app.scrub_pending);

    const status_inv = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-status", .command = "lock.status", .payload = "{}" },
        .source = .{},
    };
    const status = try handleLockStatus(@ptrCast(&rig.app), status_inv, &output);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"scrubbing\":true") != null);

    const list = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-list", .command = "journal.list", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Securing, handleList(@ptrCast(&rig.app), list, &output));

    const scrub = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-scrub", .command = "encryption.scrub", .payload = "{}" },
        .source = .{},
    };
    const scrubbed = try handleEncryptionScrub(@ptrCast(&rig.app), scrub, &output);
    try std.testing.expectEqualStrings("{\"ok\":true}", scrubbed);
    try std.testing.expect(!rig.app.scrub_pending);
    const listed = try handleList(@ptrCast(&rig.app), list, &output);
    try std.testing.expect(std.mem.indexOf(u8, listed, "Morning walk") != null);
}

test "a failed rebuild after a password change stays pending and still reports ok" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);

    // Encryption on and the file already rebuilt, so the only rebuild under
    // test is the one the password change owes.
    const enable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-enc-on", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), enable, &output);
    try std.testing.expect(rig.app.vault.enabled);
    try std.testing.expect(!rig.app.scrub_pending);

    rig.app.store.fail_next_scrub = true;
    const change = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-pw", .command = "lock.setPassword", .payload = "{\"current\":\"correct horse\",\"next\":\"another horse\"}" },
        .source = .{},
    };
    // The new password is saved, so a failed rebuild is not a failed change.
    try expectOkResponse(try rig.callNow(handleLockSetPassword, change));
    try std.testing.expect(rig.app.vault.scrub_pending);
    try std.testing.expect(rig.app.scrub_pending);

    const status_inv = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-status", .command = "lock.status", .payload = "{}" },
        .source = .{},
    };
    const status = try handleLockStatus(@ptrCast(&rig.app), status_inv, &output);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"scrubbing\":true") != null);

    // The securing screen retries through `encryption.scrub`.
    const scrub = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-scrub", .command = "encryption.scrub", .payload = "{}" },
        .source = .{},
    };
    _ = try handleEncryptionScrub(@ptrCast(&rig.app), scrub, &output);
    try std.testing.expect(!rig.app.vault.scrub_pending);
    try std.testing.expect(!rig.app.scrub_pending);

    const status_after = try handleLockStatus(@ptrCast(&rig.app), status_inv, &output);
    try std.testing.expect(std.mem.indexOf(u8, status_after, "\"scrubbing\":false") != null);
}

test "chat.agent refuses while locked with encryption on" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    const enable = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-agent-enc", .command = "encryption.enable", .payload = "{\"password\":\"correct horse\"}" },
        .source = .{},
    };
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), enable, &output);
    rig.app.lock.unlocked = false;

    const locked = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-agent-locked", .command = "chat.agent", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleChatAgent(@ptrCast(&rig.app), locked, &output));
}

test "chat.agentToken refuses while locked" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.lock.unlocked = false;

    const locked = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-token-locked", .command = "chat.agentToken", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleChatAgentToken(@ptrCast(&rig.app), locked, &output));
}

test "chat.agent refuses while locked with encryption off" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.lock.unlocked = false;

    const locked = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-agent-enc-off", .command = "chat.agent", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleChatAgent(@ptrCast(&rig.app), locked, &output));
}

test "system.hardware and Ollama commands refuse while locked" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.lock.unlocked = false;

    const hardware = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-hw-locked", .command = "system.hardware", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleSystemHardware(@ptrCast(&rig.app), hardware, &output));

    const pulls = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-pulls-locked", .command = "ollama.pulls", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleOllamaPulls(@ptrCast(&rig.app), pulls, &output));

    const pull_cancel = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-cancel-locked", .command = "ollama.pullCancel", .payload = "{}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleOllamaPullCancel(@ptrCast(&rig.app), pull_cancel, &output));

    const pull = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-pull-locked", .command = "ollama.pull", .payload = "{\"name\":\"qwen3:8b\"}" },
        .source = .{},
    };
    try std.testing.expectError(error.Locked, handleOllamaPull(@ptrCast(&rig.app), pull, &output));
}

test "embeddings.status refuses while locked" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.lock.unlocked = false;

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-status-locked", .command = "embeddings.status", .payload = "{}" },
        .source = .{},
    };
    try handleEmbeddingsStatus(@ptrCast(&rig.app), invocation, rig.responder());

    // The refusal is immediate — no worker, no wake.
    try std.testing.expect(rig.capture.done.load(.acquire));
    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "Sage is locked.") != null);
    try std.testing.expectEqual(@as(u32, 0), rig.probe.wakes.load(.acquire));
}

test "ollama.models refuses while locked" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.lock.unlocked = false;

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-models-locked", .command = "ollama.models", .payload = "{}" },
        .source = .{},
    };
    try handleOllamaModels(@ptrCast(&rig.app), invocation, rig.responder());

    try std.testing.expect(rig.capture.done.load(.acquire));
    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "Sage is locked.") != null);
    try std.testing.expectEqual(@as(u32, 0), rig.probe.wakes.load(.acquire));
}

test "ollama.start refuses while locked" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.lock.unlocked = false;

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-start-locked", .command = "ollama.start", .payload = "{}" },
        .source = .{},
    };
    try handleOllamaStart(@ptrCast(&rig.app), invocation, rig.responder());

    // The refusal is immediate — no worker, no wake, no launch.
    try std.testing.expect(rig.capture.done.load(.acquire));
    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "Sage is locked.") != null);
    try std.testing.expectEqual(@as(u32, 0), rig.probe.wakes.load(.acquire));
}

test "ollama.delete refuses while locked before checking the name" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    rig.app.lock.unlocked = false;

    const invocation = native_sdk.bridge.Invocation{
        .request = .{ .id = "t-del-locked", .command = "ollama.delete", .payload = "{\"name\":\"qwen3:8b\"}" },
        .source = .{},
    };
    try handleOllamaDelete(@ptrCast(&rig.app), invocation, rig.responder());

    try std.testing.expect(rig.capture.done.load(.acquire));
    const response = rig.capture.body();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "Sage is locked.") != null);
    try std.testing.expectEqual(@as(u32, 0), rig.probe.wakes.load(.acquire));
}

test "packaged Chat waits for unlock and completed encryption work at launch" {
    // Lock on: the lock screen is up and Chat stays down.
    try std.testing.expect(!packagedChatStartsAtLaunch(true, false, false));
    // Lock off starts Chat only when no encryption work is pending.
    try std.testing.expect(packagedChatStartsAtLaunch(true, true, false));
    try std.testing.expect(!packagedChatStartsAtLaunch(true, true, true));
    // `make dev`: `eve.start` returns at once when the app is not packaged.
    try std.testing.expect(!packagedChatStartsAtLaunch(false, true, false));
}

// --- Touch ID without a password: the recovery key ---

fn testInvocation(id: []const u8, command: []const u8, payload: []const u8) native_sdk.bridge.Invocation {
    return .{ .request = .{ .id = id, .command = command, .payload = payload }, .source = .{} };
}

/// The key as the dialog shows it, read back out of a reply.
fn shownKeyFrom(body: []const u8, out: *[vault_mod.recovery_key_display_len]u8) !void {
    const marker = "\"recoveryKey\":\"";
    const at = std.mem.indexOf(u8, body, marker) orelse return error.NoRecoveryKey;
    @memcpy(out, body[at + marker.len ..][0..out.len]);
}

/// Turn Touch ID on and encrypt with no password, the way Settings does: a key
/// is issued, typed back, and sent to `encryption.enable`. The system sheet
/// that normally guards the issue is skipped, since a test cannot answer it.
fn encryptWithTouchIdOnly(rig: *EmbedTestRig, shown: *[vault_mod.recovery_key_display_len]u8) !void {
    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setTouchId("{\"enabled\":true}", false, &output);
    const issued = try issueRecoveryKey(&rig.app, &output);
    try shownKeyFrom(issued, shown);
    var payload_buf: [128]u8 = undefined;
    const payload = try std.fmt.bufPrint(&payload_buf, "{{\"recoveryKey\":\"{s}\"}}", .{shown});
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), testInvocation("t-touch-enc", "encryption.enable", payload), &output);
}

fn recoveryPayload(buf: []u8, key: []const u8) ![]const u8 {
    return std.fmt.bufPrint(buf, "{{\"recoveryKey\":\"{s}\"}}", .{key});
}

test "encryption.enable with Touch ID alone wraps the journal key with the recovery key" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer rig.app.eve.clearWorldKey();
    defer _ = keychain.deleteKey(rig.app.app_id);

    var output: [8192]u8 = undefined;
    // Neither a password nor Touch ID: nothing can open the journal later.
    try std.testing.expectError(error.PasswordRequired, handleEncryptionEnable(@ptrCast(&rig.app), testInvocation("t-none", "encryption.enable", "{}"), &output));

    var shown: [vault_mod.recovery_key_display_len]u8 = undefined;
    try encryptWithTouchIdOnly(&rig, &shown);

    try std.testing.expect(rig.app.vault.enabled);
    try std.testing.expect(rig.app.vault.hasRecoverySlot());
    try std.testing.expect(!rig.app.vault.hasPasswordSlot());
    try std.testing.expect(!rig.app.lock.password_set);
    try std.testing.expect(rig.app.recovery_candidate == null);
    try std.testing.expect(!rig.app.rewrite_pending and !rig.app.scrub_pending);
    try std.testing.expect(!try rig.app.store.hasPlaintextProtectedFields());

    const list = testInvocation("t-list", "journal.list", "{}");
    try std.testing.expect(std.mem.indexOf(u8, try handleList(@ptrCast(&rig.app), list, &output), "Morning walk") != null);
    const status = try handleLockStatus(@ptrCast(&rig.app), list, &output);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"encrypted\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"recoveryKeySet\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"passwordSet\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"touchIdEnabled\":true") != null);
}

test "encryption.enable with Touch ID alone refuses a key Sage did not issue" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer _ = keychain.deleteKey(rig.app.app_id);

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setTouchId("{\"enabled\":true}", false, &output);
    var buf: [128]u8 = undefined;

    try std.testing.expectError(error.InvalidRequest, handleEncryptionEnable(@ptrCast(&rig.app), testInvocation("t-a", "encryption.enable", "{}"), &output));
    // Well formed, but Sage never issued it, so the web view cannot pick a weak one.
    const chosen = try recoveryPayload(&buf, "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA");
    try std.testing.expectError(error.RecoveryKeyRequired, handleEncryptionEnable(@ptrCast(&rig.app), testInvocation("t-b", "encryption.enable", chosen), &output));

    _ = try issueRecoveryKey(&rig.app, &output);
    try std.testing.expectError(error.RecoveryKeyMismatch, handleEncryptionEnable(@ptrCast(&rig.app), testInvocation("t-c", "encryption.enable", chosen), &output));
    const malformed = try recoveryPayload(&buf, "not a key");
    try std.testing.expectError(error.InvalidRecoveryKey, handleEncryptionEnable(@ptrCast(&rig.app), testInvocation("t-d", "encryption.enable", malformed), &output));
    try std.testing.expect(!rig.app.vault.enabled);
    try std.testing.expect(rig.app.vault.dataKey() == null);
}

test "after a relaunch the recovery key unlocks and owes a new key" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer rig.app.eve.clearWorldKey();
    defer _ = keychain.deleteKey(rig.app.app_id);

    var shown: [vault_mod.recovery_key_display_len]u8 = undefined;
    try encryptWithTouchIdOnly(&rig, &shown);
    try rig.relaunch();
    try std.testing.expect(!rig.app.lock.unlocked);
    try std.testing.expect(rig.app.vault.dataKey() == null);

    var output: [8192]u8 = undefined;
    var buf: [128]u8 = undefined;
    // There is no password to unlock with.
    try std.testing.expectError(error.NoPasswordSet, handleLockUnlock(@ptrCast(&rig.app), testInvocation("t-pw", "lock.unlock", "{\"password\":\"correct horse\"}"), &output));

    // A wrong key is a guess and counts. Text that is not shaped like a key is
    // a typo and does not.
    const wrong = try recoveryPayload(&buf, "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA");
    try std.testing.expectError(error.WrongRecoveryKey, handleLockUnlockRecoveryKey(@ptrCast(&rig.app), testInvocation("t-w", "lock.unlockRecoveryKey", wrong), &output));
    try std.testing.expectEqual(@as(u32, 1), rig.app.lock.failed_attempts);
    var typo_buf: [128]u8 = undefined;
    const typo = try recoveryPayload(&typo_buf, "AAAA-AAAA");
    try std.testing.expectError(error.InvalidRecoveryKey, handleLockUnlockRecoveryKey(@ptrCast(&rig.app), testInvocation("t-t", "lock.unlockRecoveryKey", typo), &output));
    try std.testing.expectEqual(@as(u32, 1), rig.app.lock.failed_attempts);
    try std.testing.expect(!rig.app.lock.unlocked);

    // The right key, typed the way someone copies it off paper.
    var lowered: [vault_mod.recovery_key_display_len]u8 = undefined;
    _ = std.ascii.lowerString(&lowered, &shown);
    const right = try recoveryPayload(&buf, &lowered);
    try std.testing.expectEqualStrings("{\"ok\":true}", try handleLockUnlockRecoveryKey(@ptrCast(&rig.app), testInvocation("t-r", "lock.unlockRecoveryKey", right), &output));
    try std.testing.expect(rig.app.lock.unlocked);
    try std.testing.expect(rig.app.lock.recovered);
    try std.testing.expect(rig.app.vault.dataKey() != null);
    try std.testing.expectEqual(@as(u32, 0), rig.app.lock.failed_attempts);
    const list = testInvocation("t-list", "journal.list", "{}");
    try std.testing.expect(std.mem.indexOf(u8, try handleList(@ptrCast(&rig.app), list, &output), "Morning walk") != null);
    const recovered_status = try handleLockStatus(@ptrCast(&rig.app), list, &output);
    try std.testing.expect(std.mem.indexOf(u8, recovered_status, "\"recoveryKeyRotate\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, recovered_status, "\"recoveredSession\":true") != null);

    // The debt survives quitting before the new key is saved.
    try rig.relaunch();
    try std.testing.expect(rig.app.vault.recovery_rotate);
    try std.testing.expect(!rig.app.lock.recovered);
}

test "wrong recovery keys start the same wait as wrong passwords" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer rig.app.eve.clearWorldKey();
    defer _ = keychain.deleteKey(rig.app.app_id);

    var shown: [vault_mod.recovery_key_display_len]u8 = undefined;
    try encryptWithTouchIdOnly(&rig, &shown);
    try rig.relaunch();

    var output: [8192]u8 = undefined;
    var buf: [128]u8 = undefined;
    var right_buf: [128]u8 = undefined;
    const wrong = testInvocation("t-w", "lock.unlockRecoveryKey", try recoveryPayload(&buf, "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA"));
    const right = testInvocation("t-r", "lock.unlockRecoveryKey", try recoveryPayload(&right_buf, &shown));
    rig.app.lock.clock_ms = 1_000_000;
    for (0..5) |_| {
        try std.testing.expectError(error.WrongRecoveryKey, handleLockUnlockRecoveryKey(@ptrCast(&rig.app), wrong, &output));
    }
    // Inside the wait even the right key is turned away, without being tried.
    try std.testing.expectError(error.TooManyAttempts, handleLockUnlockRecoveryKey(@ptrCast(&rig.app), right, &output));
    try std.testing.expect(!rig.app.lock.unlocked);
    rig.app.lock.clock_ms = 1_000_000 + 5_000;
    _ = try handleLockUnlockRecoveryKey(@ptrCast(&rig.app), right, &output);
    try std.testing.expect(rig.app.lock.unlocked);
}

test "a new recovery key replaces the old one and the old one stops working" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer rig.app.eve.clearWorldKey();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), testInvocation("t-enc", "encryption.enable", "{\"password\":\"correct horse\"}"), &output);
    try std.testing.expect(!rig.app.vault.hasRecoverySlot());

    // The password is the proof.
    try expectFailedResponse(try rig.callNow(handleEncryptionNewRecoveryKey, testInvocation("t-np", "encryption.newRecoveryKey", "{\"password\":\"wrong\"}")), "WrongPassword");
    try expectFailedResponse(try rig.callNow(handleEncryptionNewRecoveryKey, testInvocation("t-np", "encryption.newRecoveryKey", "{}")), "CurrentPasswordRequired");
    try std.testing.expect(rig.app.recovery_candidate == null);

    var first: [vault_mod.recovery_key_display_len]u8 = undefined;
    var second: [vault_mod.recovery_key_display_len]u8 = undefined;
    var buf: [128]u8 = undefined;
    for ([_]*[vault_mod.recovery_key_display_len]u8{ &first, &second }) |slot| {
        const body = try rig.callNow(handleEncryptionNewRecoveryKey, testInvocation("t-new", "encryption.newRecoveryKey", "{\"password\":\"correct horse\"}"));
        try shownKeyFrom(body, slot);
        // A different well-formed key is not the one that was shown.
        try std.testing.expectError(error.RecoveryKeyMismatch, handleEncryptionSaveRecoveryKey(@ptrCast(&rig.app), testInvocation("t-bad", "encryption.saveRecoveryKey", try recoveryPayload(&buf, "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA")), &output));
        _ = try handleEncryptionSaveRecoveryKey(@ptrCast(&rig.app), testInvocation("t-save", "encryption.saveRecoveryKey", try recoveryPayload(&buf, slot)), &output);
        try std.testing.expect(rig.app.vault.hasRecoverySlot());
        try std.testing.expect(rig.app.recovery_candidate == null);
        // The rebuild that drops the old wrap ran.
        try std.testing.expect(!rig.app.scrub_pending);
        // A key can be saved once.
        try std.testing.expectError(error.RecoveryKeyRequired, handleEncryptionSaveRecoveryKey(@ptrCast(&rig.app), testInvocation("t-again", "encryption.saveRecoveryKey", try recoveryPayload(&buf, slot)), &output));
    }
    try std.testing.expect(!std.mem.eql(u8, &first, &second));

    try rig.relaunch();
    try std.testing.expectError(error.WrongRecoveryKey, handleLockUnlockRecoveryKey(@ptrCast(&rig.app), testInvocation("t-old", "lock.unlockRecoveryKey", try recoveryPayload(&buf, &first)), &output));
    _ = try handleLockUnlockRecoveryKey(@ptrCast(&rig.app), testInvocation("t-new", "lock.unlockRecoveryKey", try recoveryPayload(&buf, &second)), &output);
    try std.testing.expect(rig.app.lock.unlocked);
    // The password still works beside the recovery key.
    try rig.relaunch();
    _ = try handleLockUnlock(@ptrCast(&rig.app), testInvocation("t-pw", "lock.unlock", "{\"password\":\"correct horse\"}"), &output);
    try std.testing.expect(rig.app.lock.unlocked);
}

test "removing the password leaves Touch ID and the recovery key, and a recovered owner can set a new one" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer rig.app.eve.clearWorldKey();
    defer _ = keychain.deleteKey(rig.app.app_id);

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    _ = try rig.app.lock.setTouchId("{\"enabled\":true}", false, &output);
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), testInvocation("t-enc", "encryption.enable", "{\"password\":\"correct horse\"}"), &output);

    // An encrypted journal needs a recovery key before the password can go.
    try std.testing.expectError(error.RecoveryKeyRequired, handleLockRemovePassword(@ptrCast(&rig.app), testInvocation("t-rm", "lock.removePassword", "{\"password\":\"correct horse\"}"), &output));
    try std.testing.expect(rig.app.lock.password_set);

    var shown: [vault_mod.recovery_key_display_len]u8 = undefined;
    try shownKeyFrom(try rig.callNow(handleEncryptionNewRecoveryKey, testInvocation("t-new", "encryption.newRecoveryKey", "{\"password\":\"correct horse\"}")), &shown);
    var payload_buf: [256]u8 = undefined;
    const wrong_password = try std.fmt.bufPrint(&payload_buf, "{{\"password\":\"wrong\",\"recoveryKey\":\"{s}\"}}", .{shown});
    try std.testing.expectError(error.WrongPassword, handleLockRemovePassword(@ptrCast(&rig.app), testInvocation("t-rm", "lock.removePassword", wrong_password), &output));
    try std.testing.expect(rig.app.lock.password_set);

    const remove = try std.fmt.bufPrint(&payload_buf, "{{\"password\":\"correct horse\",\"recoveryKey\":\"{s}\"}}", .{shown});
    try std.testing.expectEqualStrings("{\"ok\":true}", try handleLockRemovePassword(@ptrCast(&rig.app), testInvocation("t-rm", "lock.removePassword", remove), &output));
    try std.testing.expect(!rig.app.lock.password_set);
    try std.testing.expect(rig.app.lock.touch_id_enabled);
    try std.testing.expect(rig.app.vault.hasRecoverySlot() and !rig.app.vault.hasPasswordSlot());
    try std.testing.expect(rig.app.recovery_candidate == null);
    try std.testing.expect(!rig.app.scrub_pending);

    // The password rows are gone, not just ignored.
    var rows = journal.KvRows.init(std.testing.allocator);
    defer rows.deinit();
    const queried = rig.app.store.db.query(
        "SELECT key, value FROM app_setting WHERE key IN (?1, ?2, ?3);",
        &.{ .{ .text = "lock.password_hash" }, .{ .text = vault_mod.kdf_key }, .{ .text = vault_mod.wrapped_key_key } },
        &rows,
        journal.KvRows.collect,
    );
    try std.testing.expect(queried == .ok);
    try std.testing.expectEqual(@as(usize, 0), rows.rows.items.len);

    try rig.relaunch();
    try std.testing.expect(!rig.app.lock.unlocked);
    try std.testing.expectError(error.NoPasswordSet, handleLockUnlock(@ptrCast(&rig.app), testInvocation("t-pw", "lock.unlock", "{\"password\":\"correct horse\"}"), &output));
    _ = try handleLockUnlockRecoveryKey(@ptrCast(&rig.app), testInvocation("t-r", "lock.unlockRecoveryKey", try recoveryPayload(&payload_buf, &shown)), &output);

    // The owner just proved they hold the key, so a new password needs no
    // current one, and it gets a slot beside the recovery key.
    try expectOkResponse(try rig.callNow(handleLockSetPassword, testInvocation("t-set", "lock.setPassword", "{\"next\":\"brand new pass\"}")));
    try std.testing.expect(rig.app.lock.password_set and rig.app.vault.hasPasswordSlot());
    try rig.relaunch();
    _ = try handleLockUnlock(@ptrCast(&rig.app), testInvocation("t-pw2", "lock.unlock", "{\"password\":\"brand new pass\"}"), &output);
    try std.testing.expect(rig.app.lock.unlocked);
}

test "after a recovery unlock encryption can be removed without a password or a sheet" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer rig.app.eve.clearWorldKey();
    defer _ = keychain.deleteKey(rig.app.app_id);

    var shown: [vault_mod.recovery_key_display_len]u8 = undefined;
    try encryptWithTouchIdOnly(&rig, &shown);
    try rig.relaunch();
    var output: [8192]u8 = undefined;
    var buf: [128]u8 = undefined;
    _ = try handleLockUnlockRecoveryKey(@ptrCast(&rig.app), testInvocation("t-r", "lock.unlockRecoveryKey", try recoveryPayload(&buf, &shown)), &output);

    try expectOkResponse(try rig.callNow(handleEncryptionDisable, testInvocation("t-off", "encryption.disable", "{}")));
    try std.testing.expect(!rig.app.vault.enabled);
    try std.testing.expect(!rig.app.vault.hasRecoverySlot());
    try std.testing.expect(!rig.app.vault.recovery_rotate);
    const list = testInvocation("t-list", "journal.list", "{}");
    try std.testing.expect(std.mem.indexOf(u8, try handleList(@ptrCast(&rig.app), list, &output), "Morning walk") != null);
    // Touch ID is still the lock.
    try std.testing.expect(rig.app.lock.touch_id_enabled);
}

test "a session lock forgets the recovery candidate and the recovered flag" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setTouchId("{\"enabled\":true}", false, &output);
    _ = try issueRecoveryKey(&rig.app, &output);
    rig.app.lock.recovered = true;
    try std.testing.expect(rig.app.recovery_candidate != null);

    sessionLock(&rig.app);
    try std.testing.expect(!rig.app.lock.unlocked);
    try std.testing.expect(rig.app.recovery_candidate == null);
    try std.testing.expect(!rig.app.lock.recovered);
    // A locked app hands out no key.
    try expectFailedResponse(try rig.callNow(handleEncryptionNewRecoveryKey, testInvocation("t-new", "encryption.newRecoveryKey", "{}")), "Locked");
}

test "lock.status reports FileVault" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    var output: [8192]u8 = undefined;
    const status = testInvocation("t-status", "lock.status", "{}");
    try std.testing.expect(std.mem.indexOf(u8, try handleLockStatus(@ptrCast(&rig.app), status, &output), "\"fileVault\":\"unknown\"") != null);
    rig.app.file_vault = .off;
    try std.testing.expect(std.mem.indexOf(u8, try handleLockStatus(@ptrCast(&rig.app), status, &output), "\"fileVault\":\"off\"") != null);
}

test "a refused password removal leaves the Keychain alone" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer rig.app.eve.clearWorldKey();
    defer _ = keychain.deleteKey(rig.app.app_id);

    var output: [8192]u8 = undefined;
    _ = try rig.app.lock.setPassword("{\"next\":\"correct horse\"}", null, &output);
    _ = try rig.app.lock.setTouchId("{\"enabled\":true}", false, &output);
    _ = try handleEncryptionEnable(@ptrCast(&rig.app), testInvocation("t-enc", "encryption.enable", "{\"password\":\"correct horse\"}"), &output);

    // `storeKey` resets this to the OS status, so a sentinel that survives
    // means the Keychain was never written.
    const sentinel: i32 = 12345;
    keychain.last_os_status = sentinel;
    const wrong = testInvocation("t-wrong", "lock.removePassword", "{\"password\":\"wrong pass\"}");
    try std.testing.expectError(error.WrongPassword, handleLockRemovePassword(@ptrCast(&rig.app), wrong, &output));
    const missing = testInvocation("t-missing", "lock.removePassword", "{}");
    try std.testing.expectError(error.CurrentPasswordRequired, handleLockRemovePassword(@ptrCast(&rig.app), missing, &output));
    // The right password still has to bring a recovery key for an encrypted
    // journal that has none, and it has to be one Sage issued.
    const no_key = testInvocation("t-no-key", "lock.removePassword", "{\"password\":\"correct horse\"}");
    try std.testing.expectError(error.RecoveryKeyRequired, handleLockRemovePassword(@ptrCast(&rig.app), no_key, &output));
    const unissued = testInvocation("t-unissued", "lock.removePassword", "{\"password\":\"correct horse\",\"recoveryKey\":\"AAAA-AAAA-AAAA-AAAA-AAAA-AAAA\"}");
    try std.testing.expectError(error.RecoveryKeyRequired, handleLockRemovePassword(@ptrCast(&rig.app), unissued, &output));
    try std.testing.expectEqual(sentinel, keychain.last_os_status);
    try std.testing.expect(rig.app.lock.password_set and rig.app.vault.hasPasswordSlot());
}

test "turning the lock off ends a recovered session" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer rig.app.eve.clearWorldKey();
    defer _ = keychain.deleteKey(rig.app.app_id);

    var shown: [vault_mod.recovery_key_display_len]u8 = undefined;
    try encryptWithTouchIdOnly(&rig, &shown);
    try rig.relaunch();
    var output: [8192]u8 = undefined;
    var buf: [128]u8 = undefined;
    _ = try handleLockUnlockRecoveryKey(@ptrCast(&rig.app), testInvocation("t-r", "lock.unlockRecoveryKey", try recoveryPayload(&buf, &shown)), &output);
    try std.testing.expect(rig.app.lock.recovered);

    // The recovered session sets a password and removes encryption with no
    // proof, then turns the lock off with the password it just set.
    try expectOkResponse(try rig.callNow(handleEncryptionDisable, testInvocation("t-off", "encryption.disable", "{}")));
    try expectOkResponse(try rig.callNow(handleLockSetPassword, testInvocation("t-set", "lock.setPassword", "{\"next\":\"brand new pass\"}")));
    try expectOkResponse(try rig.callNow(handleLockDisable, testInvocation("t-lock-off", "lock.disable", "{\"password\":\"brand new pass\"}")));
    try std.testing.expect(!rig.app.lock.enabled());
    try std.testing.expect(!rig.app.lock.recovered);
    const status = try handleLockStatus(@ptrCast(&rig.app), testInvocation("t-s", "lock.status", "{}"), &output);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"recoveredSession\":false") != null);

    // A lock set up later in the same process earns no free pass.
    try expectOkResponse(try rig.callNow(handleLockSetPassword, testInvocation("t-set2", "lock.setPassword", "{\"next\":\"another pass1\"}")));
    try expectFailedResponse(try rig.callNow(handleLockSetPassword, testInvocation("t-set3", "lock.setPassword", "{\"next\":\"third pass12\"}")), "CurrentPasswordRequired");
}

/// Queue a finished Touch ID prompt, the way the reply thread does, so a test
/// can run what the loop thread does when the sheet closes.
fn queueLockJob(rig: *EmbedTestRig, purpose: LockPurpose, success: bool, payload: ?[]const u8) !void {
    const allocator = rig.app.store.allocator;
    const job = try allocator.create(LockJob);
    errdefer allocator.destroy(job);
    job.* = .{
        .responder = rig.responder(),
        .request_id = try allocator.dupe(u8, "t-job"),
        .purpose = purpose,
        .success = success,
    };
    errdefer allocator.free(job.request_id);
    if (payload) |text| job.payload = try allocator.dupe(u8, text);
    rig.capture.done.store(false, .release);
    rig.capture.len = 0;
    rig.app.lock_job = job;
    rig.lock_queue.push(rig.app.io, job);
}

test "a Touch ID sheet that succeeds sets the first password on an encrypted journal" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer rig.app.eve.clearWorldKey();
    defer _ = keychain.deleteKey(rig.app.app_id);

    var shown: [vault_mod.recovery_key_display_len]u8 = undefined;
    try encryptWithTouchIdOnly(&rig, &shown);

    // A sheet that did not succeed changes nothing.
    try queueLockJob(&rig, .set_password, false, "{\"next\":\"brand new pass\"}");
    drainLockJobs(&rig.app);
    try expectFailedResponse(rig.capture.body(), "Touch ID did not succeed.");
    try std.testing.expect(rig.app.lock_job == null);
    try std.testing.expect(!rig.app.lock.password_set and !rig.app.vault.hasPasswordSlot());

    try queueLockJob(&rig, .set_password, true, "{\"next\":\"brand new pass\"}");
    drainLockJobs(&rig.app);
    try expectOkResponse(rig.capture.body());
    try std.testing.expect(rig.app.lock.password_set);
    try std.testing.expect(rig.app.vault.hasPasswordSlot() and rig.app.vault.hasRecoverySlot());
    // The old wrap is rebuilt out of the file before the reply.
    try std.testing.expect(!rig.app.scrub_pending);

    try rig.relaunch();
    var output: [8192]u8 = undefined;
    _ = try handleLockUnlock(@ptrCast(&rig.app), testInvocation("t-pw", "lock.unlock", "{\"password\":\"brand new pass\"}"), &output);
    try std.testing.expect(rig.app.lock.unlocked);
}

test "a Touch ID sheet that succeeds removes encryption" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer rig.app.eve.clearWorldKey();
    defer _ = keychain.deleteKey(rig.app.app_id);

    var shown: [vault_mod.recovery_key_display_len]u8 = undefined;
    try encryptWithTouchIdOnly(&rig, &shown);

    // With no password and no recovered session, removing encryption owes a
    // sheet, and nothing is removed until it closes.
    try std.testing.expectEqual(lock_mod.Proof.prompt, rig.app.lock.proofRequired());
    try queueLockJob(&rig, .disable_encryption, false, null);
    drainLockJobs(&rig.app);
    try expectFailedResponse(rig.capture.body(), "Touch ID did not succeed.");
    try std.testing.expect(rig.app.vault.enabled);

    try queueLockJob(&rig, .disable_encryption, true, null);
    drainLockJobs(&rig.app);
    try expectOkResponse(rig.capture.body());
    try std.testing.expect(!rig.app.vault.enabled and !rig.app.vault.hasRecoverySlot());
    try std.testing.expect(rig.app.lock.touch_id_enabled);
    var output: [8192]u8 = undefined;
    const list = testInvocation("t-list", "journal.list", "{}");
    try std.testing.expect(std.mem.indexOf(u8, try handleList(@ptrCast(&rig.app), list, &output), "Morning walk") != null);
}

test "a Touch ID sheet that succeeds hands out a recovery key that can be saved" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer rig.app.eve.clearWorldKey();
    defer _ = keychain.deleteKey(rig.app.app_id);

    var first: [vault_mod.recovery_key_display_len]u8 = undefined;
    try encryptWithTouchIdOnly(&rig, &first);
    try rig.app.vault.setRecoveryRotate(true);

    try queueLockJob(&rig, .new_recovery_key, true, null);
    drainLockJobs(&rig.app);
    var second: [vault_mod.recovery_key_display_len]u8 = undefined;
    try shownKeyFrom(rig.capture.body(), &second);
    try std.testing.expect(rig.app.recovery_candidate != null);
    try std.testing.expect(!std.mem.eql(u8, &first, &second));

    var output: [8192]u8 = undefined;
    var buf: [128]u8 = undefined;
    _ = try handleEncryptionSaveRecoveryKey(@ptrCast(&rig.app), testInvocation("t-save", "encryption.saveRecoveryKey", try recoveryPayload(&buf, &second)), &output);

    // What reached the file: the rotate flag is gone and only the new key opens.
    try rig.relaunch();
    try std.testing.expect(!rig.app.vault.recovery_rotate);
    const status = try handleLockStatus(@ptrCast(&rig.app), testInvocation("t-s", "lock.status", "{}"), &output);
    try std.testing.expect(std.mem.indexOf(u8, status, "\"recoveryKeyRotate\":false") != null);
    try std.testing.expectError(error.WrongRecoveryKey, handleLockUnlockRecoveryKey(@ptrCast(&rig.app), testInvocation("t-old", "lock.unlockRecoveryKey", try recoveryPayload(&buf, &first)), &output));
    _ = try handleLockUnlockRecoveryKey(@ptrCast(&rig.app), testInvocation("t-new", "lock.unlockRecoveryKey", try recoveryPayload(&buf, &second)), &output);
}

test "a Touch ID sheet that closes after the app locked hands out no key" {
    var rig: EmbedTestRig = undefined;
    try rig.init();
    defer rig.deinit();
    defer rig.app.eve.clearWorldKey();
    defer _ = keychain.deleteKey(rig.app.app_id);

    var shown: [vault_mod.recovery_key_display_len]u8 = undefined;
    try encryptWithTouchIdOnly(&rig, &shown);
    sessionLock(&rig.app);

    try queueLockJob(&rig, .new_recovery_key, true, null);
    drainLockJobs(&rig.app);
    try expectFailedResponse(rig.capture.body(), "Locked");
    try std.testing.expect(rig.app.recovery_candidate == null);

    try queueLockJob(&rig, .disable_encryption, true, null);
    drainLockJobs(&rig.app);
    try expectFailedResponse(rig.capture.body(), "Locked");
    try std.testing.expect(rig.app.vault.enabled);
}

test "a failed Keychain write is reported to the page, not hidden" {
    var output: [128]u8 = undefined;
    try std.testing.expectEqualStrings("{\"ok\":true}", try recoveryUnlockReply(&output, true));
    try std.testing.expectEqualStrings("{\"ok\":true,\"touchIdKeyMissing\":true}", try recoveryUnlockReply(&output, false));
}

test "an off FileVault answer expires and the others stay" {
    const read: i64 = 1_000_000;
    try std.testing.expect(fileVaultCacheFresh(.on, read, read + 10 * file_vault_recheck_ms));
    try std.testing.expect(fileVaultCacheFresh(.unknown, read, read + 10 * file_vault_recheck_ms));
    try std.testing.expect(fileVaultCacheFresh(.off, read, read + file_vault_recheck_ms - 1));
    try std.testing.expect(!fileVaultCacheFresh(.off, read, read + file_vault_recheck_ms));
}
