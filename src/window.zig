const std = @import("std");
const builtin = @import("builtin");
const objc = @import("objc.zig");

const ns_event_type_left_mouse_down: i64 = 1;

const ns_window_close_button: i64 = 0;
const ns_window_miniaturize_button: i64 = 1;
const ns_window_zoom_button: i64 = 2;
const ns_window_full_screen: i64 = 1 << 14;
const ns_window_below: i64 = -1;
const ns_visual_effect_material_sidebar: i64 = 7;
const ns_visual_effect_blending_behind_window: i64 = 0;
const ns_visual_effect_state_follows_window: i64 = 0;
const ns_visual_effect_state_inactive: i64 = 2;
const ns_view_width_sizable: u64 = 2;
const ns_view_height_sizable: u64 = 16;
const sage_vibrancy_id: [:0]const u8 = "sage-sidebar-vibrancy";
const appearance_observer_class: [:0]const u8 = "SageTitlebarObserver";
const appearance_changed_name: [:0]const u8 = "AppleInterfaceThemeChangedNotification";
const frame_changed_name: [:0]const u8 = "NSViewFrameDidChangeNotification";
const reapply_after_appearance_s: f64 = 0.16;
const webview_search_depth: u8 = 6;
const layer_search_depth: u8 = 8;

var last_height: f64 = 36;
var last_leading: ?f64 = null;
var appearance_target: ?*anyopaque = null;
var appearance_observer_installed = false;
var frame_observer_installed = false;
var applying_alignment = false;
var measured_pitch: ?f64 = null;
const default_button_pitch: f64 = 20;

fn keyWindow(api: objc.Api) ?*anyopaque {
    const ns_app_class = api.get_class("NSApplication") orelse return null;
    const app = objc.msg(api, ns_app_class, objc.sel(api, "sharedApplication")) orelse return null;
    return objc.msg(api, app, objc.sel(api, "keyWindow")) orelse objc.msg(api, app, objc.sel(api, "mainWindow"));
}

fn sameRect(a: objc.CGRect, b: objc.CGRect) bool {
    return a.origin.x == b.origin.x and a.origin.y == b.origin.y and
        a.size.width == b.size.width and a.size.height == b.size.height;
}

/// Skip no-op writes so frequent re-applies do not invalidate layout.
fn setFrameIfChanged(api: objc.Api, view: *anyopaque, frame: objc.CGRect) void {
    const current = objc.msgRect(api, view, objc.sel(api, "frame"));
    if (sameRect(current, frame)) return;
    objc.msgSetRect(api, view, objc.sel(api, "setFrame:"), frame);
}

fn centerTrafficLights(height: f64, leading: ?f64) void {
    if (height <= 0) return;
    // Our own setFrame calls post frame-change notifications; skip those.
    if (applying_alignment) return;
    applying_alignment = true;
    defer applying_alignment = false;
    const api = objc.load() orelse return;
    const window = keyWindow(api) orelse return;
    if (objc.msgInt(api, window, objc.sel(api, "styleMask")) & ns_window_full_screen != 0) return;

    const close = objc.msg1i(api, window, objc.sel(api, "standardWindowButton:"), ns_window_close_button) orelse return;
    const titlebar_view = objc.msg(api, close, objc.sel(api, "superview")) orelse return;
    const container = objc.msg(api, titlebar_view, objc.sel(api, "superview")) orelse titlebar_view;

    var container_frame = objc.msgRect(api, container, objc.sel(api, "frame"));
    const top = container_frame.origin.y + container_frame.size.height;
    container_frame.size.height = height;
    container_frame.origin.y = top - height;
    setFrameIfChanged(api, container, container_frame);

    if (titlebar_view != container) {
        var titlebar_frame = objc.msgRect(api, titlebar_view, objc.sel(api, "frame"));
        titlebar_frame.origin.y = 0;
        titlebar_frame.size.height = height;
        setFrameIfChanged(api, titlebar_view, titlebar_frame);
    }

    // Place every button from absolute values so running this twice, or
    // halfway through an AppKit relayout, gives the same result.
    const pitch = buttonPitch(api, window);
    for (traffic_light_buttons, 0..) |kind, index| {
        const button = objc.msg1i(api, window, objc.sel(api, "standardWindowButton:"), kind) orelse continue;
        var frame = objc.msgRect(api, button, objc.sel(api, "frame"));
        frame.origin.y = (height - frame.size.height) / 2.0;
        if (leading) |target_x| frame.origin.x = target_x + pitch * @as(f64, @floatFromInt(index));
        setFrameIfChanged(api, button, frame);
    }
    watchTitlebarFrames(api, container, titlebar_view, window);
}

/// Distance between button origins. macOS lays the buttons out at a fixed
/// pitch, so read it once while they are still where AppKit put them.
fn buttonPitch(api: objc.Api, window: *anyopaque) f64 {
    if (measured_pitch) |pitch| return pitch;
    const close = objc.msg1i(api, window, objc.sel(api, "standardWindowButton:"), ns_window_close_button) orelse return default_button_pitch;
    const mini = objc.msg1i(api, window, objc.sel(api, "standardWindowButton:"), ns_window_miniaturize_button) orelse return default_button_pitch;
    const pitch = objc.msgRect(api, mini, objc.sel(api, "frame")).origin.x - objc.msgRect(api, close, objc.sel(api, "frame")).origin.x;
    // A sane pitch is wider than a button and no wider than two.
    if (pitch < 14 or pitch > 40) return default_button_pitch;
    measured_pitch = pitch;
    return pitch;
}

const traffic_light_buttons = [_]i64{ ns_window_close_button, ns_window_miniaturize_button, ns_window_zoom_button };

/// AppKit lays the title bar out again while the window is dragged, which
/// moves the buttons for a frame or two. Listen for those frame changes on
/// the title bar views and buttons and re-apply the inset right away, in the
/// same run loop turn, so the wrong position is never drawn.
fn watchTitlebarFrames(api: objc.Api, container: *anyopaque, titlebar_view: *anyopaque, window: *anyopaque) void {
    if (frame_observer_installed) return;
    const target = createAppearanceTarget(api) orelse return;
    const center_class = api.get_class("NSNotificationCenter") orelse return;
    const center = objc.msg(api, center_class, objc.sel(api, "defaultCenter")) orelse return;
    const name = objc.nsString(api, frame_changed_name) orelse return;
    const post_sel = objc.sel(api, "setPostsFrameChangedNotifications:");
    const add_sel = objc.sel(api, "addObserver:selector:name:object:");
    const handler = objc.sel(api, "titlebarFrameChanged:");

    var watched = [_]?*anyopaque{ container, titlebar_view, null, null, null };
    for (traffic_light_buttons, 0..) |kind, index| {
        watched[2 + index] = objc.msg1i(api, window, objc.sel(api, "standardWindowButton:"), kind);
    }
    for (watched) |maybe_view| {
        const view = maybe_view orelse continue;
        objc.msgVoidBool(api, view, post_sel, true);
        objc.msgVoidIdSelIdId(api, center, add_sel, target, handler, name, view);
    }
    // The buttons can also move without a frame change we can see (AppKit
    // swaps them or lays them out later), so re-apply on the window's own
    // update, move, resize and key notifications as well.
    for (window_notification_names) |notification_name| {
        const notification = objc.nsString(api, notification_name) orelse continue;
        objc.msgVoidIdSelIdId(api, center, add_sel, target, handler, notification, window);
    }
    frame_observer_installed = true;
}

const window_notification_names = [_][:0]const u8{
    "NSWindowDidUpdateNotification",
    "NSWindowDidMoveNotification",
    "NSWindowDidResizeNotification",
    "NSWindowDidBecomeKeyNotification",
    "NSWindowDidResignKeyNotification",
};

fn jsonF64(payload: []const u8, field: []const u8) ?f64 {
    var needle_buf: [32]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\":", .{field}) catch return null;
    const start = std.mem.indexOf(u8, payload, needle) orelse return null;
    var index = start + needle.len;
    while (index < payload.len and (payload[index] == ' ' or payload[index] == '\t')) index += 1;
    var end = index;
    while (end < payload.len) : (end += 1) {
        const ch = payload[end];
        const ok = (ch >= '0' and ch <= '9') or ch == '.' or ch == '-' or ch == '+' or ch == 'e' or ch == 'E';
        if (!ok) break;
    }
    if (end == index) return null;
    return std.fmt.parseFloat(f64, payload[index..end]) catch null;
}

fn isMacosFullscreen() bool {
    if (builtin.os.tag != .macos) return false;
    const api = objc.load() orelse return false;
    const window = keyWindow(api) orelse return false;
    return objc.msgInt(api, window, objc.sel(api, "styleMask")) & ns_window_full_screen != 0;
}

fn viewIdentifierIs(api: objc.Api, view: *anyopaque, expected: [:0]const u8) bool {
    const identifier = objc.msg(api, view, objc.sel(api, "identifier")) orelse return false;
    const utf8 = objc.msg(api, identifier, objc.sel(api, "UTF8String")) orelse return false;
    const bytes: [*:0]const u8 = @ptrCast(utf8);
    return std.mem.eql(u8, std.mem.span(bytes), expected);
}

fn existingVibrancyView(api: objc.Api, content: *anyopaque) ?*anyopaque {
    const subviews = objc.msg(api, content, objc.sel(api, "subviews")) orelse return null;
    const count = objc.msgInt(api, subviews, objc.sel(api, "count"));
    var index: i64 = 0;
    while (index < count) : (index += 1) {
        const view = objc.msg1i(api, subviews, objc.sel(api, "objectAtIndex:"), index) orelse continue;
        if (viewIdentifierIs(api, view, sage_vibrancy_id)) return view;
    }
    return null;
}

fn existingWebView(api: objc.Api, content: *anyopaque) ?*anyopaque {
    return findWebView(api, content, webview_search_depth);
}

fn findWebView(api: objc.Api, view: *anyopaque, depth: u8) ?*anyopaque {
    const wk = api.get_class("WKWebView") orelse return null;
    if (objc.msgIsKindOfClass(api, view, wk)) return view;
    if (depth == 0) return null;
    const subviews = objc.msg(api, view, objc.sel(api, "subviews")) orelse return null;
    const count = objc.msgInt(api, subviews, objc.sel(api, "count"));
    var index: i64 = 0;
    while (index < count) : (index += 1) {
        const child = objc.msg1i(api, subviews, objc.sel(api, "objectAtIndex:"), index) orelse continue;
        if (findWebView(api, child, depth - 1)) |found| return found;
    }
    return null;
}

fn setKvcBool(api: objc.Api, object: *anyopaque, key: [:0]const u8, value: bool) void {
    const ns_number = api.get_class("NSNumber") orelse return;
    const boxed = objc.msgBool(api, ns_number, objc.sel(api, "numberWithBool:"), value) orelse return;
    const name = objc.nsString(api, key) orelse return;
    _ = objc.msg2(api, object, objc.sel(api, "setValue:forKey:"), boxed, name);
}

fn clearCgColor(api: objc.Api) ?*anyopaque {
    const ns_color = api.get_class("NSColor") orelse return null;
    const clear = objc.msg(api, ns_color, objc.sel(api, "clearColor")) orelse return null;
    return objc.msg(api, clear, objc.sel(api, "CGColor"));
}

fn clearLayerFill(api: objc.Api, layer: *anyopaque, clear_cg: ?*anyopaque) void {
    objc.msgVoidBool(api, layer, objc.sel(api, "setOpaque:"), false);
    _ = objc.msg1(api, layer, objc.sel(api, "setBackgroundColor:"), clear_cg);
}

fn clearFullSizeLayers(api: objc.Api, layer: *anyopaque, full: objc.CGRect, clear_cg: ?*anyopaque, depth: u8) void {
    const bounds = objc.msgRect(api, layer, objc.sel(api, "bounds"));
    if (@abs(bounds.size.width - full.size.width) < 1.5 and @abs(bounds.size.height - full.size.height) < 1.5) {
        clearLayerFill(api, layer, clear_cg);
    }
    if (depth == 0) return;
    const sublayers = objc.msg(api, layer, objc.sel(api, "sublayers")) orelse return;
    const count = objc.msgInt(api, sublayers, objc.sel(api, "count"));
    var index: i64 = 0;
    while (index < count) : (index += 1) {
        const child = objc.msg1i(api, sublayers, objc.sel(api, "objectAtIndex:"), index) orelse continue;
        clearFullSizeLayers(api, child, full, clear_cg, depth - 1);
    }
}

/// WebKit adds an opaque overhang layer after reload. Clearing the view
/// fill is not enough; full-size compositor layers have to be cleared too.
fn clearWebViewBackdrop(api: objc.Api, content: *anyopaque) void {
    const webview = existingWebView(api, content) orelse return;
    objc.msgVoidBool(api, webview, objc.sel(api, "setOpaque:"), false);
    setKvcBool(api, webview, "drawsBackground", false);
    setKvcBool(api, webview, "drawsTransparentBackground", true);
    const under_sel = objc.sel(api, "setUnderPageBackgroundColor:");
    if (objc.msgRespondsToSelector(api, webview, under_sel)) {
        if (api.get_class("NSColor")) |ns_color| {
            if (objc.msg(api, ns_color, objc.sel(api, "clearColor"))) |clear| {
                _ = objc.msg1(api, webview, under_sel, clear);
            }
        }
    }
    const layer = objc.msg(api, webview, objc.sel(api, "layer")) orelse return;
    const clear_cg = clearCgColor(api);
    clearLayerFill(api, layer, clear_cg);
    const bounds = objc.msgRect(api, layer, objc.sel(api, "bounds"));
    clearFullSizeLayers(api, layer, bounds, clear_cg, layer_search_depth);
}

fn syncVibrancyState(api: objc.Api, window: *anyopaque, effect: *anyopaque) void {
    const fullscreen = objc.msgInt(api, window, objc.sel(api, "styleMask")) & ns_window_full_screen != 0;
    objc.msgVoidInt(
        api,
        effect,
        objc.sel(api, "setState:"),
        if (fullscreen) ns_visual_effect_state_inactive else ns_visual_effect_state_follows_window,
    );
}

/// Sidebar blur behind the web view. Translucent sidebar CSS lets the
/// desktop show through. Full screen turns this effect off, and the
/// frontend also paints the sidebar opaque then.
fn installSidebarVibrancy() void {
    const api = objc.load() orelse return;
    const window = keyWindow(api) orelse return;
    const content = objc.msg(api, window, objc.sel(api, "contentView")) orelse return;
    clearWebViewBackdrop(api, content);

    if (existingVibrancyView(api, content)) |effect| {
        syncVibrancyState(api, window, effect);
        return;
    }

    const class = api.get_class("NSVisualEffectView") orelse return;
    const allocated = objc.msg(api, class, objc.sel(api, "alloc")) orelse return;
    const bounds = objc.msgRect(api, content, objc.sel(api, "bounds"));
    const effect = objc.msgInitRect(api, allocated, objc.sel(api, "initWithFrame:"), bounds) orelse return;

    objc.msgVoidInt(api, effect, objc.sel(api, "setMaterial:"), ns_visual_effect_material_sidebar);
    objc.msgVoidInt(api, effect, objc.sel(api, "setBlendingMode:"), ns_visual_effect_blending_behind_window);
    const identifier = objc.nsString(api, sage_vibrancy_id) orelse return;
    _ = objc.msg1(api, effect, objc.sel(api, "setIdentifier:"), identifier);
    objc.msgVoidUInt(api, effect, objc.sel(api, "setAutoresizingMask:"), ns_view_width_sizable | ns_view_height_sizable);
    objc.msgVoidIdIntId(
        api,
        content,
        objc.sel(api, "addSubview:positioned:relativeTo:"),
        effect,
        ns_window_below,
        null,
    );
    syncVibrancyState(api, window, effect);
}

fn writeAlignTitlebarJson(output: []u8, fullscreen: bool) ![]const u8 {
    var writer = std.Io.Writer.fixed(output);
    try writer.print("{{\"ok\":true,\"fullscreen\":{s}}}", .{if (fullscreen) "true" else "false"});
    return writer.buffered();
}

fn startMacosWindowDrag() void {
    const api = objc.load() orelse return;
    const ns_app_class = api.get_class("NSApplication") orelse return;
    const app = objc.msg(api, ns_app_class, objc.sel(api, "sharedApplication")) orelse return;
    const event = objc.msg(api, app, objc.sel(api, "currentEvent")) orelse return;
    if (objc.msgInt(api, event, objc.sel(api, "type")) != ns_event_type_left_mouse_down) return;
    const window = objc.msg(api, event, objc.sel(api, "window")) orelse objc.msg(api, app, objc.sel(api, "keyWindow")) orelse return;
    if (objc.msgInt(api, event, objc.sel(api, "clickCount")) >= 2) {
        _ = objc.msg1(api, window, objc.sel(api, "performZoom:"), null);
        return;
    }
    _ = objc.msg1(api, window, objc.sel(api, "performWindowDragWithEvent:"), event);
}

pub fn drag(output: []u8) ![]const u8 {
    if (builtin.os.tag == .macos) startMacosWindowDrag();
    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"ok\":true}");
    return writer.buffered();
}

fn applyLastAlignment() void {
    installSidebarVibrancy();
    centerTrafficLights(last_height, last_leading);
}

/// macOS redraws the hidden inset title bar when light/dark appearance
/// changes, which drops the frames we set. Re-apply the last inset after
/// that redraw finishes.
fn watchAppearanceChanges() void {
    if (appearance_observer_installed) return;
    const api = objc.load() orelse return;
    const target = createAppearanceTarget(api) orelse return;
    const center_class = api.get_class("NSDistributedNotificationCenter") orelse return;
    const center = objc.msg(api, center_class, objc.sel(api, "defaultCenter")) orelse return;
    const name = objc.nsString(api, appearance_changed_name) orelse return;
    objc.msgVoidIdSelIdId(
        api,
        center,
        objc.sel(api, "addObserver:selector:name:object:"),
        target,
        objc.sel(api, "themeChanged:"),
        name,
        null,
    );
    appearance_observer_installed = true;
}

fn createAppearanceTarget(api: objc.Api) ?*anyopaque {
    if (appearance_target) |target| return target;
    const cls = observerClass(api) orelse return null;
    const allocated = objc.msg(api, cls, objc.sel(api, "alloc")) orelse return null;
    const target = objc.msg(api, allocated, objc.sel(api, "init")) orelse return null;
    appearance_target = target;
    return target;
}

fn observerClass(api: objc.Api) ?*anyopaque {
    if (api.get_class(appearance_observer_class.ptr)) |cls| return cls;
    const nsobject = api.get_class("NSObject") orelse return null;
    const cls = api.allocate_class_pair(nsobject, appearance_observer_class.ptr, 0) orelse return null;
    if (!api.add_method(cls, objc.sel(api, "themeChanged:"), @ptrCast(&themeChangedImp), "v@:@")) return null;
    if (!api.add_method(cls, objc.sel(api, "scheduleReapply:"), @ptrCast(&scheduleReapplyImp), "v@:@")) return null;
    if (!api.add_method(cls, objc.sel(api, "reapplyTitlebar:"), @ptrCast(&reapplyTitlebarImp), "v@:@")) return null;
    if (!api.add_method(cls, objc.sel(api, "titlebarFrameChanged:"), @ptrCast(&titlebarFrameChangedImp), "v@:@")) return null;
    api.register_class_pair(cls);
    return cls;
}

fn themeChangedImp(self: ?*anyopaque, cmd: *anyopaque, notification: ?*anyopaque) callconv(.c) void {
    _ = cmd;
    _ = notification;
    const api = objc.load() orelse return;
    objc.msgVoidSelIdBool(
        api,
        self,
        objc.sel(api, "performSelectorOnMainThread:withObject:waitUntilDone:"),
        objc.sel(api, "scheduleReapply:"),
        null,
        false,
    );
}

fn scheduleDelayedReapply() void {
    const api = objc.load() orelse return;
    const target = createAppearanceTarget(api) orelse return;
    const nsobject = api.get_class("NSObject") orelse return;
    objc.msgVoidIdSelId(
        api,
        nsobject,
        objc.sel(api, "cancelPreviousPerformRequestsWithTarget:selector:object:"),
        target,
        objc.sel(api, "reapplyTitlebar:"),
        null,
    );
    objc.msgVoidSelIdDelay(
        api,
        target,
        objc.sel(api, "performSelector:withObject:afterDelay:"),
        objc.sel(api, "reapplyTitlebar:"),
        null,
        reapply_after_appearance_s,
    );
}

fn scheduleReapplyImp(self: ?*anyopaque, cmd: *anyopaque, arg: ?*anyopaque) callconv(.c) void {
    _ = self;
    _ = cmd;
    _ = arg;
    applyLastAlignment();
    scheduleDelayedReapply();
}

fn reapplyTitlebarImp(self: ?*anyopaque, cmd: *anyopaque, arg: ?*anyopaque) callconv(.c) void {
    _ = self;
    _ = cmd;
    _ = arg;
    applyLastAlignment();
}

fn titlebarFrameChangedImp(self: ?*anyopaque, cmd: *anyopaque, notification: ?*anyopaque) callconv(.c) void {
    _ = self;
    _ = cmd;
    _ = notification;
    centerTrafficLights(last_height, last_leading);
}


pub fn alignTitlebar(payload: []const u8, output: []u8) ![]const u8 {
    if (builtin.os.tag == .macos) {
        last_height = jsonF64(payload, "height") orelse 36;
        last_leading = jsonF64(payload, "leading");
        applyLastAlignment();
        watchAppearanceChanges();
        scheduleDelayedReapply();
    }
    return writeAlignTitlebarJson(output, isMacosFullscreen());
}

test "window.drag writes ok json" {
    var buffer: [32]u8 = undefined;
    const json = try drag(&buffer);
    try std.testing.expectEqualStrings("{\"ok\":true}", json);
}

test "window.alignTitlebar writes ok json" {
    var buffer: [64]u8 = undefined;
    const json = try alignTitlebar("{\"height\":36,\"leading\":16}", &buffer);
    try std.testing.expectEqualStrings("{\"ok\":true,\"fullscreen\":false}", json);
}
