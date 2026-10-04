const std = @import("std");
const builtin = @import("builtin");
const lock_mod = @import("lock.zig");
const objc = @import("objc.zig");

const idle_check_interval_seconds: f64 = 15;
const observer_class_name: [:0]const u8 = "SageSessionLockObserver";

pub const Callbacks = struct {
    on_lock: *const fn (context: *anyopaque) void,
    idle_timeout_ms: *const fn (context: *anyopaque) i64,
};

var installed = false;
var callback_context: ?*anyopaque = null;
var callbacks: ?Callbacks = null;
var clock_io: ?std.Io = null;
var last_activity_ms: i64 = 0;
var observer: ?*anyopaque = null;
var event_monitor: ?*anyopaque = null;
var system_library: ?std.DynLib = null;

/// Watch AppKit's sleep notifications, Sage-window input, and its idle clock.
pub fn install(io: std.Io, context: *anyopaque, next: Callbacks) void {
    if (builtin.os.tag != .macos or installed) return;
    const api = objc.load() orelse return;
    clock_io = io;
    callback_context = context;
    callbacks = next;
    resetIdleClock();

    const target = createObserver(api) orelse return;
    observer = target;
    installWorkspaceNotifications(api, target);
    installScreensaverNotification(api, target);
    installActivityMonitor(api);
    scheduleIdleCheck(api, target);
    installed = true;
}

/// Start a fresh idle interval after a successful unlock.
pub fn resetIdleClock() void {
    last_activity_ms = nowMs();
}

fn recordActivity() void {
    last_activity_ms = nowMs();
}

fn nowMs() i64 {
    const io = clock_io orelse return 0;
    return std.Io.Clock.Timestamp.now(io, .awake).raw.toMilliseconds();
}

fn createObserver(api: objc.Api) ?*anyopaque {
    const cls = observerClass(api) orelse return null;
    const allocated = objc.msg(api, cls, objc.sel(api, "alloc")) orelse return null;
    return objc.msg(api, allocated, objc.sel(api, "init"));
}

fn observerClass(api: objc.Api) ?*anyopaque {
    if (api.get_class(observer_class_name.ptr)) |cls| return cls;
    const nsobject = api.get_class("NSObject") orelse return null;
    const cls = api.allocate_class_pair(nsobject, observer_class_name.ptr, 0) orelse return null;
    if (!api.add_method(cls, objc.sel(api, "notificationReceived:"), @ptrCast(&notificationReceivedImp), "v@:@")) return null;
    if (!api.add_method(cls, objc.sel(api, "lockOnMain:"), @ptrCast(&lockOnMainImp), "v@:@")) return null;
    if (!api.add_method(cls, objc.sel(api, "checkIdle:"), @ptrCast(&checkIdleImp), "v@:@")) return null;
    api.register_class_pair(cls);
    return cls;
}

fn installWorkspaceNotifications(api: objc.Api, target: *anyopaque) void {
    const workspace_class = api.get_class("NSWorkspace") orelse return;
    const workspace = objc.msg(api, workspace_class, objc.sel(api, "sharedWorkspace")) orelse return;
    const center = objc.msg(api, workspace, objc.sel(api, "notificationCenter")) orelse return;
    addObserver(api, center, target, "NSWorkspaceWillSleepNotification");
    addObserver(api, center, target, "NSWorkspaceScreensDidSleepNotification");
}

fn installScreensaverNotification(api: objc.Api, target: *anyopaque) void {
    const center_class = api.get_class("NSDistributedNotificationCenter") orelse return;
    const center = objc.msg(api, center_class, objc.sel(api, "defaultCenter")) orelse return;
    addObserver(api, center, target, "com.apple.screensaver.didstart");
}

fn addObserver(api: objc.Api, center: *anyopaque, target: *anyopaque, name_text: [:0]const u8) void {
    const name = objc.nsString(api, name_text) orelse return;
    objc.msgVoidIdSelIdId(
        api,
        center,
        objc.sel(api, "addObserver:selector:name:object:"),
        target,
        objc.sel(api, "notificationReceived:"),
        name,
        null,
    );
}

fn installActivityMonitor(api: objc.Api) void {
    var system = std.DynLib.open("/usr/lib/libSystem.B.dylib") catch return;
    const block_isa = system.lookup(*anyopaque, "_NSConcreteGlobalBlock") orelse {
        system.close();
        return;
    };
    system_library = system;
    activity_block.isa = block_isa;

    const event_class = api.get_class("NSEvent") orelse return;
    event_monitor = objc.msgUIntBlock(
        api,
        event_class,
        objc.sel(api, "addLocalMonitorForEventsMatchingMask:handler:"),
        activity_event_mask,
        @ptrCast(&activity_block),
    );
}

fn scheduleIdleCheck(api: objc.Api, target: *anyopaque) void {
    objc.msgVoidSelIdDelay(
        api,
        target,
        objc.sel(api, "performSelector:withObject:afterDelay:"),
        objc.sel(api, "checkIdle:"),
        null,
        idle_check_interval_seconds,
    );
}

fn notificationReceivedImp(self: ?*anyopaque, cmd: *anyopaque, notification: ?*anyopaque) callconv(.c) void {
    _ = cmd;
    const api = objc.load() orelse return;
    objc.msgVoidSelIdBool(
        api,
        self,
        objc.sel(api, "performSelectorOnMainThread:withObject:waitUntilDone:"),
        objc.sel(api, "lockOnMain:"),
        notification,
        false,
    );
}

fn lockOnMainImp(self: ?*anyopaque, cmd: *anyopaque, notification: ?*anyopaque) callconv(.c) void {
    _ = self;
    _ = cmd;
    _ = notification;
    const context = callback_context orelse return;
    const next = callbacks orelse return;
    next.on_lock(context);
}

fn checkIdleImp(self: ?*anyopaque, cmd: *anyopaque, arg: ?*anyopaque) callconv(.c) void {
    _ = cmd;
    _ = arg;
    const context = callback_context orelse return;
    const next = callbacks orelse return;
    const timeout_ms = next.idle_timeout_ms(context);
    if (lock_mod.idleShouldLock(timeout_ms, last_activity_ms, nowMs())) {
        next.on_lock(context);
    }
    const api = objc.load() orelse return;
    if (self) |target| scheduleIdleCheck(api, target);
}

const activity_event_mask: u64 =
    (1 << 1) | // left mouse down
    (1 << 2) | // left mouse up
    (1 << 3) | // right mouse down
    (1 << 4) | // right mouse up
    (1 << 5) | // mouse moved
    (1 << 6) | // left mouse dragged
    (1 << 7) | // right mouse dragged
    (1 << 8) | // mouse entered
    (1 << 9) | // mouse exited
    (1 << 10) | // key down
    (1 << 11) | // key up
    (1 << 12) | // modifier changed
    (1 << 18) | // rotate
    (1 << 19) | // gesture began
    (1 << 20) | // gesture ended
    (1 << 22) | // scroll wheel
    (1 << 25) | // other mouse down
    (1 << 26) | // other mouse up
    (1 << 27) | // other mouse dragged
    (1 << 29) | // gesture
    (1 << 30) | // magnify
    (1 << 31) | // swipe
    (1 << 32); // smart magnify

const block_is_global: c_int = 1 << 28;

const BlockDescriptor = extern struct {
    reserved: c_ulong = 0,
    size: c_ulong = @sizeOf(ActivityBlock),
};

const ActivityInvokeFn = fn (block: *ActivityBlock, event: ?*anyopaque) callconv(.c) ?*anyopaque;

const ActivityBlock = extern struct {
    isa: ?*anyopaque,
    flags: c_int,
    reserved: c_int = 0,
    invoke: *const ActivityInvokeFn,
    descriptor: *const BlockDescriptor,
};

var activity_descriptor: BlockDescriptor = .{};
var activity_block: ActivityBlock = .{
    .isa = null,
    .flags = block_is_global,
    .invoke = &activityInvoke,
    .descriptor = &activity_descriptor,
};

fn activityInvoke(block: *ActivityBlock, event: ?*anyopaque) callconv(.c) ?*anyopaque {
    _ = block;
    recordActivity();
    return event;
}
