const std = @import("std");
const builtin = @import("builtin");
const native_sdk = @import("native_sdk");
const objc = @import("objc.zig");

/// What macOS says about Sage's access to the microphone. The Native SDK
/// capture reports a single "failed" event for a denied permission, a missing
/// device, and an engine that would not start, so Sage asks the OS itself.
pub const Status = enum {
    granted,
    denied,
    restricted,
    undetermined,

    pub fn name(self: Status) []const u8 {
        return @tagName(self);
    }
};

/// The Microphone page of Privacy & Security. The web view never picks a URL.
pub const settings_url = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

/// `AVAuthorizationStatus` raw values.
const status_not_determined: i64 = 0;
const status_restricted: i64 = 1;
const status_denied: i64 = 2;
const status_authorized: i64 = 3;

/// Map the raw `AVAuthorizationStatus`. A value this code does not know reads
/// as `undetermined`, so a new case in a later macOS lets the capture ask.
pub fn statusFromRaw(raw: i64) Status {
    return switch (raw) {
        status_authorized => .granted,
        status_denied => .denied,
        status_restricted => .restricted,
        status_not_determined => .undetermined,
        else => .undetermined,
    };
}

var av_foundation: ?std.DynLib = null;
var media_type_audio: ?*anyopaque = null;

/// `AVCaptureDevice authorizationStatusForMediaType:` with `AVMediaTypeAudio`,
/// through the Objective-C runtime. Off macOS, or when AVFoundation cannot be
/// loaded, nothing is granted.
pub fn status() Status {
    if (builtin.os.tag != .macos) return .denied;
    const api = objc.load() orelse return .denied;
    const audio = mediaTypeAudio() orelse return .denied;
    const class = api.get_class("AVCaptureDevice") orelse return .denied;
    const raw = objc.msg1Int(api, class, objc.sel(api, "authorizationStatusForMediaType:"), audio);
    return statusFromRaw(raw);
}

/// `AVMediaTypeAudio` is a global NSString. The symbol's address is a pointer
/// to that global, so one dereference yields the string object.
fn mediaTypeAudio() ?*anyopaque {
    if (media_type_audio) |value| return value;
    var lib = std.DynLib.open("/System/Library/Frameworks/AVFoundation.framework/AVFoundation") catch return null;
    const global = lib.lookup(*const *anyopaque, "AVMediaTypeAudio") orelse {
        lib.close();
        return null;
    };
    av_foundation = lib;
    media_type_audio = global.*;
    return media_type_audio;
}

/// Open the Microphone page of Privacy & Security in System Settings.
pub fn openSettings(services: native_sdk.platform.PlatformServices) !void {
    try services.openExternalUrl(settings_url);
}

test "status maps every AVAuthorizationStatus" {
    try std.testing.expectEqual(Status.undetermined, statusFromRaw(0));
    try std.testing.expectEqual(Status.restricted, statusFromRaw(1));
    try std.testing.expectEqual(Status.denied, statusFromRaw(2));
    try std.testing.expectEqual(Status.granted, statusFromRaw(3));
    try std.testing.expectEqual(Status.undetermined, statusFromRaw(99));
    try std.testing.expectEqualStrings("undetermined", Status.undetermined.name());
}

test "status reads the real authorization without crashing" {
    // The answer depends on the machine, so only the call is checked.
    const value = status();
    switch (value) {
        .granted, .denied, .restricted, .undetermined => {},
    }
}

test "the settings URL is the fixed Microphone page" {
    try std.testing.expectEqualStrings(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        settings_url,
    );
}
