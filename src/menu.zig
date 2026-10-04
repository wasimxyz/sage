const std = @import("std");
const builtin = @import("builtin");
const objc = @import("objc.zig");

/// Callback fired when the user picks a Sage application-menu item.
pub const OpenFn = *const fn (context: *anyopaque) void;

pub const Callbacks = struct {
    on_export: OpenFn,
    on_import: OpenFn,
    on_settings: OpenFn,
    on_lock: OpenFn,
};

var callbacks: ?Callbacks = null;
var menu_context: *anyopaque = undefined;
var lock_item: ?*anyopaque = null;
var installed = false;

const ns_event_modifier_flag_shift: u64 = 1 << 17;
const ns_event_modifier_flag_command: u64 = 1 << 20;

/// Insert Sage items into the host-built menus. The SDK host owns the
/// application menu, and a declared File menu would replace Edit, View,
/// and Window, so these items are added at runtime. Settings goes in
/// the application menu. Import and Export go at the top of File.
/// Everything created here intentionally leaks: the target, items, and
/// class live as long as the process.
pub fn install(context: *anyopaque, next: Callbacks) void {
    if (builtin.os.tag != .macos) return;
    if (installed) return;
    const api = objc.load() orelse return;
    callbacks = next;
    menu_context = context;
    if (installMacos(api)) installed = true;
}

/// Enable the Lock menu item while Sage is unlocked, including when the lock is off.
pub fn setLockItemEnabled(enabled: bool) void {
    if (builtin.os.tag != .macos) return;
    const item = lock_item orelse return;
    const api = objc.load() orelse return;
    objc.msgVoidBool(api, item, objc.sel(api, "setEnabled:"), enabled);
}

fn installMacos(api: objc.Api) bool {
    const target = createTarget(api) orelse return false;
    const settings_item = createItem(
        api,
        target,
        "Settings",
        ",",
        "settingsClicked:",
        "gearshape",
        ns_event_modifier_flag_command,
    ) orelse return false;
    const app_lock_item = createItem(
        api,
        target,
        "Lock",
        "l",
        "lockClicked:",
        "lock",
        ns_event_modifier_flag_command,
    ) orelse return false;
    const app_menu = appMenu(api) orelse return false;
    const separator_class = api.get_class("NSMenuItem") orelse return false;
    const app_separator = objc.msg(api, separator_class, objc.sel(api, "separatorItem")) orelse return false;
    // About, separator, Settings, Lock, separator, Hide…
    objc.msgVoidIdInt(api, app_menu, objc.sel(api, "insertItem:atIndex:"), app_separator, 1);
    objc.msgVoidIdInt(api, app_menu, objc.sel(api, "insertItem:atIndex:"), settings_item, 2);
    objc.msgVoidIdInt(api, app_menu, objc.sel(api, "insertItem:atIndex:"), app_lock_item, 3);
    lock_item = app_lock_item;

    const file_menu = submenuNamed(api, "File") orelse return true;
    const import_item = createItem(
        api,
        target,
        "Import",
        "o",
        "importClicked:",
        "square.and.arrow.down",
        ns_event_modifier_flag_command,
    ) orelse return true;
    const export_item = createItem(
        api,
        target,
        "Export",
        "e",
        "exportClicked:",
        "square.and.arrow.up",
        ns_event_modifier_flag_command | ns_event_modifier_flag_shift,
    ) orelse return true;
    const file_separator = objc.msg(api, separator_class, objc.sel(api, "separatorItem")) orelse return true;
    objc.msgVoidIdInt(api, file_menu, objc.sel(api, "insertItem:atIndex:"), import_item, 0);
    objc.msgVoidIdInt(api, file_menu, objc.sel(api, "insertItem:atIndex:"), export_item, 1);
    objc.msgVoidIdInt(api, file_menu, objc.sel(api, "insertItem:atIndex:"), file_separator, 2);
    return true;
}

fn createTarget(api: objc.Api) ?*anyopaque {
    const nsobject = api.get_class("NSObject") orelse return null;
    const cls = api.allocate_class_pair(nsobject, "SageMenuTarget", 0) orelse return null;
    if (!api.add_method(cls, objc.sel(api, "settingsClicked:"), @ptrCast(&settingsImp), "v@:@")) return null;
    if (!api.add_method(cls, objc.sel(api, "lockClicked:"), @ptrCast(&lockImp), "v@:@")) return null;
    if (!api.add_method(cls, objc.sel(api, "importClicked:"), @ptrCast(&importImp), "v@:@")) return null;
    if (!api.add_method(cls, objc.sel(api, "exportClicked:"), @ptrCast(&exportImp), "v@:@")) return null;
    api.register_class_pair(cls);
    const allocated = objc.msg(api, cls, objc.sel(api, "alloc")) orelse return null;
    return objc.msg(api, allocated, objc.sel(api, "init"));
}

fn createItem(
    api: objc.Api,
    target: *anyopaque,
    title_text: [:0]const u8,
    key_text: [:0]const u8,
    action: [:0]const u8,
    symbol: ?[:0]const u8,
    modifiers: u64,
) ?*anyopaque {
    const title = objc.nsString(api, title_text) orelse return null;
    const key = objc.nsString(api, key_text) orelse return null;
    const cls = api.get_class("NSMenuItem") orelse return null;
    const allocated = objc.msg(api, cls, objc.sel(api, "alloc")) orelse return null;
    const item = objc.msgIdSelId(api, allocated, objc.sel(api, "initWithTitle:action:keyEquivalent:"), title, objc.sel(api, action), key) orelse return null;
    _ = objc.msg1(api, item, objc.sel(api, "setTarget:"), target);
    objc.msgVoidUInt(api, item, objc.sel(api, "setKeyEquivalentModifierMask:"), modifiers);
    if (symbol) |name| {
        const image_class = api.get_class("NSImage") orelse return item;
        const symbol_name = objc.nsString(api, name) orelse return item;
        const description = objc.nsString(api, title_text) orelse return item;
        const image = objc.msg2(api, image_class, objc.sel(api, "imageWithSystemSymbolName:accessibilityDescription:"), symbol_name, description);
        _ = objc.msg1(api, item, objc.sel(api, "setImage:"), image);
    }
    return item;
}

fn appMenu(api: objc.Api) ?*anyopaque {
    return submenuNamed(api, null);
}

fn submenuNamed(api: objc.Api, title_text: ?[:0]const u8) ?*anyopaque {
    const ns_app_class = api.get_class("NSApplication") orelse return null;
    const app = objc.msg(api, ns_app_class, objc.sel(api, "sharedApplication")) orelse return null;
    const main_menu = objc.msg(api, app, objc.sel(api, "mainMenu")) orelse return null;
    if (title_text == null) {
        const first = objc.msg1i(api, main_menu, objc.sel(api, "itemAtIndex:"), 0) orelse return null;
        return objc.msg(api, first, objc.sel(api, "submenu"));
    }
    const wanted = title_text.?;
    const count = objc.msgInt(api, main_menu, objc.sel(api, "numberOfItems"));
    var index: i64 = 0;
    while (index < count) : (index += 1) {
        const item = objc.msg1i(api, main_menu, objc.sel(api, "itemAtIndex:"), index) orelse continue;
        const title = objc.msg(api, item, objc.sel(api, "title")) orelse continue;
        const utf8 = objc.msg(api, title, objc.sel(api, "UTF8String")) orelse continue;
        const bytes: [*:0]const u8 = @ptrCast(utf8);
        if (std.mem.eql(u8, std.mem.span(bytes), wanted)) {
            return objc.msg(api, item, objc.sel(api, "submenu"));
        }
    }
    return null;
}

fn settingsImp(self: ?*anyopaque, cmd: *anyopaque, sender: ?*anyopaque) callconv(.c) void {
    _ = self;
    _ = cmd;
    _ = sender;
    if (callbacks) |next| next.on_settings(menu_context);
}

fn lockImp(self: ?*anyopaque, cmd: *anyopaque, sender: ?*anyopaque) callconv(.c) void {
    _ = self;
    _ = cmd;
    _ = sender;
    if (callbacks) |next| next.on_lock(menu_context);
}

fn importImp(self: ?*anyopaque, cmd: *anyopaque, sender: ?*anyopaque) callconv(.c) void {
    _ = self;
    _ = cmd;
    _ = sender;
    if (callbacks) |next| next.on_import(menu_context);
}

fn exportImp(self: ?*anyopaque, cmd: *anyopaque, sender: ?*anyopaque) callconv(.c) void {
    _ = self;
    _ = cmd;
    _ = sender;
    if (callbacks) |next| next.on_export(menu_context);
}
