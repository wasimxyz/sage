const std = @import("std");
const builtin = @import("builtin");

/// Minimal Objective-C runtime access, loaded lazily from libobjc. Shared by
/// window.zig, menu.zig, and touchid.zig for the small AppKit and
/// LocalAuthentication calls the Native SDK does not expose.
pub const Api = struct {
    get_class: *const fn (name: [*:0]const u8) callconv(.c) ?*anyopaque,
    sel_register: *const fn (name: [*:0]const u8) callconv(.c) *anyopaque,
    msg_send: *const fn () callconv(.c) void,
    allocate_class_pair: *const fn (superclass: ?*anyopaque, name: [*:0]const u8, extra_bytes: usize) callconv(.c) ?*anyopaque,
    add_method: *const fn (cls: ?*anyopaque, name: *anyopaque, imp: *const anyopaque, types: [*:0]const u8) callconv(.c) bool,
    register_class_pair: *const fn (cls: ?*anyopaque) callconv(.c) void,
};

var objc_lib: ?std.DynLib = null;
var objc_api: ?Api = null;

pub fn load() ?Api {
    if (objc_api) |api| return api;
    if (builtin.os.tag != .macos) return null;
    var lib = std.DynLib.open("/usr/lib/libobjc.A.dylib") catch return null;
    const get_class = lib.lookup(*const fn (name: [*:0]const u8) callconv(.c) ?*anyopaque, "objc_getClass") orelse {
        lib.close();
        return null;
    };
    const sel_register = lib.lookup(*const fn (name: [*:0]const u8) callconv(.c) *anyopaque, "sel_registerName") orelse {
        lib.close();
        return null;
    };
    const msg_send = lib.lookup(*const fn () callconv(.c) void, "objc_msgSend") orelse {
        lib.close();
        return null;
    };
    const allocate_class_pair = lib.lookup(*const fn (superclass: ?*anyopaque, name: [*:0]const u8, extra_bytes: usize) callconv(.c) ?*anyopaque, "objc_allocateClassPair") orelse {
        lib.close();
        return null;
    };
    const add_method = lib.lookup(*const fn (cls: ?*anyopaque, name: *anyopaque, imp: *const anyopaque, types: [*:0]const u8) callconv(.c) bool, "class_addMethod") orelse {
        lib.close();
        return null;
    };
    const register_class_pair = lib.lookup(*const fn (cls: ?*anyopaque) callconv(.c) void, "objc_registerClassPair") orelse {
        lib.close();
        return null;
    };
    objc_lib = lib;
    const api: Api = .{
        .get_class = get_class,
        .sel_register = sel_register,
        .msg_send = msg_send,
        .allocate_class_pair = allocate_class_pair,
        .add_method = add_method,
        .register_class_pair = register_class_pair,
    };
    objc_api = api;
    return api;
}

pub fn sel(api: Api, name: [:0]const u8) *anyopaque {
    return api.sel_register(name.ptr);
}

/// A message that takes no arguments and returns nothing, such as
/// `invalidate`.
pub fn msgVoid(api: Api, object: ?*anyopaque, selector: *anyopaque) void {
    const send: *const fn (?*anyopaque, *anyopaque) callconv(.c) void = @ptrCast(api.msg_send);
    send(object, selector);
}

pub fn msg(api: Api, object: ?*anyopaque, selector: *anyopaque) ?*anyopaque {
    const send: *const fn (?*anyopaque, *anyopaque) callconv(.c) ?*anyopaque = @ptrCast(api.msg_send);
    return send(object, selector);
}

pub fn msg1(api: Api, object: ?*anyopaque, selector: *anyopaque, arg: ?*anyopaque) ?*anyopaque {
    const send: *const fn (?*anyopaque, *anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque = @ptrCast(api.msg_send);
    return send(object, selector, arg);
}

/// setObject:forKey: — object, selector, then (id, id).
pub fn msg2(api: Api, object: ?*anyopaque, selector: *anyopaque, first: ?*anyopaque, second: ?*anyopaque) ?*anyopaque {
    const send: *const fn (?*anyopaque, *anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque = @ptrCast(api.msg_send);
    return send(object, selector, first, second);
}

/// A bytes:length: message — object, selector, then (pointer, NSUInteger).
pub fn msgBytesLen(api: Api, object: ?*anyopaque, selector: *anyopaque, bytes: ?*const anyopaque, len: usize) ?*anyopaque {
    const send: *const fn (?*anyopaque, *anyopaque, ?*const anyopaque, usize) callconv(.c) ?*anyopaque = @ptrCast(api.msg_send);
    return send(object, selector, bytes, len);
}

/// numberWithBool: — object, selector, then (BOOL).
pub fn msgBool(api: Api, object: ?*anyopaque, selector: *anyopaque, value: bool) ?*anyopaque {
    const send: *const fn (?*anyopaque, *anyopaque, bool) callconv(.c) ?*anyopaque = @ptrCast(api.msg_send);
    return send(object, selector, value);
}

pub fn msgInt(api: Api, object: ?*anyopaque, selector: *anyopaque) i64 {
    const send: *const fn (?*anyopaque, *anyopaque) callconv(.c) i64 = @ptrCast(api.msg_send);
    return send(object, selector);
}

pub fn msg1i(api: Api, object: ?*anyopaque, selector: *anyopaque, arg: i64) ?*anyopaque {
    const send: *const fn (?*anyopaque, *anyopaque, i64) callconv(.c) ?*anyopaque = @ptrCast(api.msg_send);
    return send(object, selector, arg);
}

/// initWithTitle:action:keyEquivalent: — object, selector, then (id, SEL, id).
pub fn msgIdSelId(api: Api, object: ?*anyopaque, selector: *anyopaque, first: ?*anyopaque, second: *anyopaque, third: ?*anyopaque) ?*anyopaque {
    const send: *const fn (?*anyopaque, *anyopaque, ?*anyopaque, *anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque = @ptrCast(api.msg_send);
    return send(object, selector, first, second, third);
}

/// insertItem:atIndex: — object, selector, then (id, NSInteger).
pub fn msgVoidIdInt(api: Api, object: ?*anyopaque, selector: *anyopaque, arg: ?*anyopaque, index: i64) void {
    const send: *const fn (?*anyopaque, *anyopaque, ?*anyopaque, i64) callconv(.c) void = @ptrCast(api.msg_send);
    send(object, selector, arg, index);
}

/// addSubview:positioned:relativeTo: — object, selector, then (id, NSInteger, id).
pub fn msgVoidIdIntId(api: Api, object: ?*anyopaque, selector: *anyopaque, first: ?*anyopaque, place: i64, second: ?*anyopaque) void {
    const send: *const fn (?*anyopaque, *anyopaque, ?*anyopaque, i64, ?*anyopaque) callconv(.c) void = @ptrCast(api.msg_send);
    send(object, selector, first, place, second);
}

/// addObserver:selector:name:object: — object, selector, then (id, SEL, id, id).
pub fn msgVoidIdSelIdId(
    api: Api,
    object: ?*anyopaque,
    selector: *anyopaque,
    observer: ?*anyopaque,
    sel_arg: *anyopaque,
    name: ?*anyopaque,
    obj: ?*anyopaque,
) void {
    const send: *const fn (?*anyopaque, *anyopaque, ?*anyopaque, *anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void = @ptrCast(api.msg_send);
    send(object, selector, observer, sel_arg, name, obj);
}

/// performSelectorOnMainThread:withObject:waitUntilDone: — (SEL, id, BOOL).
pub fn msgVoidSelIdBool(
    api: Api,
    object: ?*anyopaque,
    selector: *anyopaque,
    sel_arg: *anyopaque,
    arg: ?*anyopaque,
    wait: bool,
) void {
    const send: *const fn (?*anyopaque, *anyopaque, *anyopaque, ?*anyopaque, bool) callconv(.c) void = @ptrCast(api.msg_send);
    send(object, selector, sel_arg, arg, wait);
}

/// performSelector:withObject:afterDelay: — (SEL, id, NSTimeInterval).
pub fn msgVoidSelIdDelay(
    api: Api,
    object: ?*anyopaque,
    selector: *anyopaque,
    sel_arg: *anyopaque,
    arg: ?*anyopaque,
    delay: f64,
) void {
    const send: *const fn (?*anyopaque, *anyopaque, *anyopaque, ?*anyopaque, f64) callconv(.c) void = @ptrCast(api.msg_send);
    send(object, selector, sel_arg, arg, delay);
}

/// setMaterial: — object, selector, then (NSInteger).
pub fn msgVoidInt(api: Api, object: ?*anyopaque, selector: *anyopaque, value: i64) void {
    const send: *const fn (?*anyopaque, *anyopaque, i64) callconv(.c) void = @ptrCast(api.msg_send);
    send(object, selector, value);
}

/// setKeyEquivalentModifierMask: — object, selector, then (NSUInteger).
pub fn msgVoidUInt(api: Api, object: ?*anyopaque, selector: *anyopaque, value: u64) void {
    const send: *const fn (?*anyopaque, *anyopaque, u64) callconv(.c) void = @ptrCast(api.msg_send);
    send(object, selector, value);
}

/// addLocalMonitorForEventsMatchingMask:handler: — object, selector, then
/// (NSEventMask, block).
pub fn msgUIntBlock(api: Api, object: ?*anyopaque, selector: *anyopaque, value: u64, block: *const anyopaque) ?*anyopaque {
    const send: *const fn (?*anyopaque, *anyopaque, u64, *const anyopaque) callconv(.c) ?*anyopaque = @ptrCast(api.msg_send);
    return send(object, selector, value, block);
}

/// canEvaluatePolicy:error: — object, selector, then (LAPolicy, NSError **).
pub fn msgBoolIntPtr(api: Api, object: ?*anyopaque, selector: *anyopaque, policy: i64, out_error: ?*anyopaque) bool {
    const send: *const fn (?*anyopaque, *anyopaque, i64, ?*anyopaque) callconv(.c) bool = @ptrCast(api.msg_send);
    return send(object, selector, policy, out_error);
}

/// isKindOfClass: — object, selector, then (Class).
pub fn msgIsKindOfClass(api: Api, object: ?*anyopaque, class: ?*anyopaque) bool {
    const send: *const fn (?*anyopaque, *anyopaque, ?*anyopaque) callconv(.c) bool = @ptrCast(api.msg_send);
    return send(object, sel(api, "isKindOfClass:"), class);
}

/// respondsToSelector: — object, then the selector to query.
pub fn msgRespondsToSelector(api: Api, object: ?*anyopaque, query: *anyopaque) bool {
    const send: *const fn (?*anyopaque, *anyopaque, *anyopaque) callconv(.c) bool = @ptrCast(api.msg_send);
    return send(object, sel(api, "respondsToSelector:"), query);
}

/// setOpaque: — object, selector, then (BOOL).
pub fn msgVoidBool(api: Api, object: ?*anyopaque, selector: *anyopaque, value: bool) void {
    const send: *const fn (?*anyopaque, *anyopaque, bool) callconv(.c) void = @ptrCast(api.msg_send);
    send(object, selector, value);
}

/// cancelPreviousPerformRequestsWithTarget:selector:object: — (id, SEL, id).
pub fn msgVoidIdSelId(
    api: Api,
    object: ?*anyopaque,
    selector: *anyopaque,
    target: ?*anyopaque,
    sel_arg: *anyopaque,
    arg: ?*anyopaque,
) void {
    const send: *const fn (?*anyopaque, *anyopaque, ?*anyopaque, *anyopaque, ?*anyopaque) callconv(.c) void = @ptrCast(api.msg_send);
    send(object, selector, target, sel_arg, arg);
}

/// evaluatePolicy:localizedReason:reply: — object, selector, then
/// (LAPolicy, NSString, block).
pub fn msgVoidIntIdBlock(api: Api, object: ?*anyopaque, selector: *anyopaque, policy: i64, reason: ?*anyopaque, block: *const anyopaque) void {
    const send: *const fn (?*anyopaque, *anyopaque, i64, ?*anyopaque, *const anyopaque) callconv(.c) void = @ptrCast(api.msg_send);
    send(object, selector, policy, reason, block);
}

pub const CGPoint = extern struct { x: f64, y: f64 };
pub const CGSize = extern struct { width: f64, height: f64 };
pub const CGRect = extern struct { origin: CGPoint, size: CGSize };

pub fn msgRect(api: Api, object: ?*anyopaque, selector: *anyopaque) CGRect {
    const send: *const fn (?*anyopaque, *anyopaque) callconv(.c) CGRect = @ptrCast(api.msg_send);
    return send(object, selector);
}

pub fn msgSetRect(api: Api, object: ?*anyopaque, selector: *anyopaque, rect: CGRect) void {
    const send: *const fn (?*anyopaque, *anyopaque, CGRect) callconv(.c) void = @ptrCast(api.msg_send);
    send(object, selector, rect);
}

/// initWithFrame: — object, selector, then (CGRect).
pub fn msgInitRect(api: Api, object: ?*anyopaque, selector: *anyopaque, rect: CGRect) ?*anyopaque {
    const send: *const fn (?*anyopaque, *anyopaque, CGRect) callconv(.c) ?*anyopaque = @ptrCast(api.msg_send);
    return send(object, selector, rect);
}

/// Build an NSString from a null-terminated UTF-8 literal.
pub fn nsString(api: Api, text: [:0]const u8) ?*anyopaque {
    const class = api.get_class("NSString") orelse return null;
    const allocated = msg(api, class, sel(api, "alloc")) orelse return null;
    return msg1(api, allocated, sel(api, "initWithUTF8String:"), @ptrCast(@constCast(text.ptr)));
}
