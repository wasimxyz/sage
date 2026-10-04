const std = @import("std");
const builtin = @import("builtin");
const objc = @import("objc.zig");

/// LocalAuthentication via the Objective-C runtime, in the same DynLib style
/// as window.zig — the Native SDK exposes no biometric API. Policy 2
/// (LAPolicyDeviceOwnerAuthentication) shows Touch ID when the hardware has
/// it and falls back to the Mac login password in the same system prompt,
/// which is what makes a Touch-ID-only lock safe to offer. Policy 1 is
/// biometrics only, used to label the settings toggle honestly.
const la_policy_biometrics: i64 = 1;
const la_policy_device_owner: i64 = 2;

pub const Availability = struct {
    /// The system prompt can run at all (any Mac: Touch ID or login password).
    prompt: bool,
    /// Real Touch ID hardware is present and enrolled.
    biometrics: bool,
};

pub const CompleteFn = *const fn (context: *anyopaque, success: bool) void;

var la_framework: ?std.DynLib = null;
var system_lib: ?std.DynLib = null;
var la_context: ?*anyopaque = null;
var reply_context: ?*anyopaque = null;
var reply_complete: ?CompleteFn = null;

pub fn availability() Availability {
    if (builtin.os.tag != .macos) return .{ .prompt = false, .biometrics = false };
    const api = objc.load() orelse return .{ .prompt = false, .biometrics = false };
    const context = sharedContext(api) orelse return .{ .prompt = false, .biometrics = false };
    return .{
        .prompt = objc.msgBoolIntPtr(api, context, objc.sel(api, "canEvaluatePolicy:error:"), la_policy_device_owner, null),
        .biometrics = objc.msgBoolIntPtr(api, context, objc.sel(api, "canEvaluatePolicy:error:"), la_policy_biometrics, null),
    };
}

/// Show the system prompt. The reply block runs on a private Apple queue
/// thread and calls `complete` there; the caller hands off to the event loop
/// from that callback. Returns false when the prompt could not be shown.
/// Only one prompt runs at a time; a second call returns false.
pub fn prompt(reason: [:0]const u8, context: *anyopaque, complete: CompleteFn) bool {
    if (builtin.os.tag != .macos) return false;
    if (reply_context != null) return false;
    const api = objc.load() orelse return false;
    const la = sharedContext(api) orelse return false;
    const ns_reason = objc.nsString(api, reason) orelse return false;
    reply_context = context;
    reply_complete = complete;
    objc.msgVoidIntIdBlock(api, la, objc.sel(api, "evaluatePolicy:localizedReason:reply:"), la_policy_device_owner, ns_reason, &reply_block);
    return true;
}

/// The shared LAContext, so a Keychain read right after a successful prompt
/// can reuse the authentication instead of showing a second sheet
/// (kSecUseAuthenticationContext). Null until the first prompt or
/// availability check creates it.
pub fn authenticationContext() ?*anyopaque {
    return la_context;
}

/// Drop the shared context, so the next prompt evaluates a brand-new
/// LAContext. The confirmation prompts use this: the unlock the owner just
/// finished must not be the proof that turns the lock off.
pub fn resetContext() void {
    if (la_context) |context| {
        if (objc.load()) |api| objc.msgVoid(api, context, objc.sel(api, "invalidate"));
    }
    la_context = null;
}

/// The LAContext is created once and reused, and never released, like the menu
/// target in menu.zig. `resetContext` is the one thing that drops it.
fn sharedContext(api: objc.Api) ?*anyopaque {
    if (la_context) |context| return context;
    if (!loadLocalAuthentication()) return null;
    const cls = api.get_class("LAContext") orelse return null;
    const allocated = objc.msg(api, cls, objc.sel(api, "alloc")) orelse return null;
    const context = objc.msg(api, allocated, objc.sel(api, "init")) orelse return null;
    la_context = context;
    return context;
}

fn loadLocalAuthentication() bool {
    if (la_framework != null) return true;
    if (builtin.os.tag != .macos) return false;
    var system = std.DynLib.open("/usr/lib/libSystem.B.dylib") catch return false;
    const isa = system.lookup(*anyopaque, "_NSConcreteGlobalBlock") orelse {
        system.close();
        return false;
    };
    // Loading the framework registers LAContext with the runtime.
    const framework = std.DynLib.open("/System/Library/Frameworks/LocalAuthentication.framework/LocalAuthentication") catch {
        system.close();
        return false;
    };
    system_lib = system;
    la_framework = framework;
    reply_block.isa = isa;
    return true;
}

// A global block needs no copy/dispose helpers and is never copied, which
// makes it safe to hand to evaluatePolicy:localizedReason:reply: from Zig.
// Per-call state rides in reply_context/reply_complete instead of captures.
const block_is_global: c_int = 1 << 28;

const BlockDescriptor = extern struct {
    reserved: c_ulong = 0,
    size: c_ulong = @sizeOf(BlockLiteral),
};

const InvokeFn = fn (block: *BlockLiteral, success: bool, err: ?*anyopaque) callconv(.c) void;

const BlockLiteral = extern struct {
    isa: ?*anyopaque,
    flags: c_int,
    reserved: c_int = 0,
    invoke: *const InvokeFn,
    descriptor: *const BlockDescriptor,
};

var reply_descriptor: BlockDescriptor = .{};
var reply_block: BlockLiteral = .{
    .isa = null,
    .flags = block_is_global,
    .invoke = &replyInvoke,
    .descriptor = &reply_descriptor,
};

fn replyInvoke(block: *BlockLiteral, success: bool, err: ?*anyopaque) callconv(.c) void {
    _ = block;
    _ = err;
    const context = reply_context orelse return;
    const complete = reply_complete orelse return;
    reply_context = null;
    reply_complete = null;
    complete(context, success);
}
