const std = @import("std");
const builtin = @import("builtin");
const objc = @import("objc.zig");

/// The macOS Keychain mirror of the journal data key, so Touch ID can unwrap
/// it (#48). The item is a generic password holding the raw 32-byte key,
/// created with a SecAccessControl requiring user presence — Touch ID or the
/// Mac login password — so macOS itself refuses to hand the key out without
/// the user. In a signed build it never syncs and never leaves this Mac
/// (kSecAttrAccessibleWhenUnlockedThisDeviceOnly via the access control).
/// Ad-hoc builds get the weaker fallback described in `storeKey`.
///
/// All Security.framework calls go through dlopen'd symbols and the
/// Objective-C runtime, in the same style as touchid.zig: the Native SDK
/// exposes no Keychain API. None of this is reachable from the web view; the
/// bridge handlers in main.zig are the only callers.
const account = "journal-data-key";

// kSecAccessControlUserPresence: Touch ID when present, else the Mac login
// password — the same population the lock screen's LocalAuthentication
// prompt (LAPolicyDeviceOwnerAuthentication) accepts.
const user_presence: usize = 1;

const err_sec_success: i32 = 0;
const err_sec_item_not_found: i32 = -25300;
// Access-controlled items need a real code signature; ad-hoc dev builds get
// this refusal instead.
const err_sec_missing_entitlement: i32 = -34018;

const SecAccessControlCreateWithFlagsFn = *const fn (
    allocator: ?*anyopaque,
    protection: ?*anyopaque,
    flags: usize,
    out_error: ?*?*anyopaque,
) callconv(.c) ?*anyopaque;
const SecItemFn = *const fn (attributes: ?*anyopaque, result: ?*?*anyopaque) callconv(.c) i32;
const CFReleaseFn = *const fn (object: ?*anyopaque) callconv(.c) void;

const Api = struct {
    sec_item_add: SecItemFn,
    sec_item_copy_matching: SecItemFn,
    sec_item_delete: SecItemFn,
    access_control_create: SecAccessControlCreateWithFlagsFn,
    cf_release: CFReleaseFn,
    // The kSec* constants are global CFStringRef variables; each of these is
    // the dereferenced string object, usable directly as a dictionary key.
    class: *anyopaque,
    class_generic_password: *anyopaque,
    attr_service: *anyopaque,
    attr_account: *anyopaque,
    value_data: *anyopaque,
    attr_access_control: *anyopaque,
    attr_accessible: *anyopaque,
    accessible_unlocked_device: *anyopaque,
    return_data: *anyopaque,
    match_limit: *anyopaque,
    match_limit_one: *anyopaque,
    use_auth_context: *anyopaque,
};

var security_api: ?Api = null;

fn load() ?Api {
    if (security_api) |api| return api;
    if (builtin.os.tag != .macos) return null;
    var security = std.DynLib.open("/System/Library/Frameworks/Security.framework/Security") catch return null;
    errdefer security.close();
    var core_foundation = std.DynLib.open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation") catch return null;
    errdefer core_foundation.close();

    const api: Api = .{
        .sec_item_add = security.lookup(SecItemFn, "SecItemAdd") orelse return null,
        .sec_item_copy_matching = security.lookup(SecItemFn, "SecItemCopyMatching") orelse return null,
        .sec_item_delete = security.lookup(SecItemFn, "SecItemDelete") orelse return null,
        .access_control_create = security.lookup(SecAccessControlCreateWithFlagsFn, "SecAccessControlCreateWithFlags") orelse return null,
        .cf_release = core_foundation.lookup(CFReleaseFn, "CFRelease") orelse return null,
        .class = secString(&security, "kSecClass") orelse return null,
        .class_generic_password = secString(&security, "kSecClassGenericPassword") orelse return null,
        .attr_service = secString(&security, "kSecAttrService") orelse return null,
        .attr_account = secString(&security, "kSecAttrAccount") orelse return null,
        .value_data = secString(&security, "kSecValueData") orelse return null,
        .attr_access_control = secString(&security, "kSecAttrAccessControl") orelse return null,
        .attr_accessible = secString(&security, "kSecAttrAccessible") orelse return null,
        .accessible_unlocked_device = secString(&security, "kSecAttrAccessibleWhenUnlockedThisDeviceOnly") orelse return null,
        .return_data = secString(&security, "kSecReturnData") orelse return null,
        .match_limit = secString(&security, "kSecMatchLimit") orelse return null,
        .match_limit_one = secString(&security, "kSecMatchLimitOne") orelse return null,
        .use_auth_context = secString(&security, "kSecUseAuthenticationContext") orelse return null,
    };
    security_api = api;
    return api;
}

/// A kSec* constant is a global holding a CFStringRef; the symbol's address
/// is a pointer to that global, so one dereference yields the string object.
fn secString(lib: *std.DynLib, name: [:0]const u8) ?*anyopaque {
    const global = lib.lookup(*const *anyopaque, name) orelse return null;
    return global.*;
}

/// The raw OSStatus from the last SecItem call, for diagnostics.
pub var last_os_status: i32 = 0;

/// Store the data key, replacing any previous copy. Returns false when the
/// Keychain write failed; the caller decides whether to roll back.
///
/// The preferred item carries a SecAccessControl requiring user presence, so
/// macOS itself demands Touch ID or the login password before releasing the
/// key. That needs a real code signature: ad-hoc dev builds get
/// errSecMissingEntitlement, and fall back to a plain login-keychain item,
/// where the app's own LocalAuthentication prompt is the only gate. The
/// fallback still passes kSecAttrAccessible, but the file-based keychain
/// does not store it. The strong path takes over once Sage ships signed.
pub fn storeKey(service: [:0]const u8, key: *const [32]u8) bool {
    last_os_status = 0;
    if (builtin.os.tag != .macos) return false;
    const api = load() orelse return false;
    const obj = objc.load() orelse return false;

    const data_class = obj.get_class("NSData") orelse return false;
    const allocated_data = objc.msg(obj, data_class, objc.sel(obj, "alloc")) orelse return false;
    const data = objc.msgBytesLen(obj, allocated_data, objc.sel(obj, "initWithBytes:length:"), key.ptr, key.len) orelse return false;
    defer api.cf_release(data);

    if (api.access_control_create(null, api.accessible_unlocked_device, user_presence, null)) |acl| {
        defer api.cf_release(acl);
        const dict = baseQuery(obj, api, service) orelse return false;
        defer api.cf_release(dict);
        dictSet(obj, dict, api.value_data, data);
        dictSet(obj, dict, api.attr_access_control, acl);
        _ = deleteKey(service);
        last_os_status = api.sec_item_add(dict, null);
        if (last_os_status == err_sec_success) return true;
        if (last_os_status != err_sec_missing_entitlement) return false;
    } else {
        return false;
    }

    // Unsigned-build fallback: no access control, so Sage's own Touch ID
    // prompt is the only Touch ID check. The file-based login keychain accepts
    // kSecAttrAccessible but does not store it, so the item is not marked this
    // device only either (docs/security/keychain.md).
    const dict = baseQuery(obj, api, service) orelse return false;
    defer api.cf_release(dict);
    dictSet(obj, dict, api.value_data, data);
    dictSet(obj, dict, api.attr_accessible, api.accessible_unlocked_device);
    _ = deleteKey(service);
    last_os_status = api.sec_item_add(dict, null);
    return last_os_status == err_sec_success;
}

/// Read the data key back. With an access-controlled item this is the moment
/// macOS demands user presence; passing the LAContext from the just-finished
/// Touch ID prompt reuses that authentication instead of showing a second
/// sheet. Returns false when the item is missing or the user was rejected.
pub fn readKey(service: [:0]const u8, la_context: ?*anyopaque, out: *[32]u8) bool {
    if (builtin.os.tag != .macos) return false;
    const api = load() orelse return false;
    const obj = objc.load() orelse return false;

    const dict = baseQuery(obj, api, service) orelse return false;
    defer api.cf_release(dict);
    dictSet(obj, dict, api.return_data, objc.msgBool(obj, obj.get_class("NSNumber") orelse return false, objc.sel(obj, "numberWithBool:"), true) orelse return false);
    dictSet(obj, dict, api.match_limit, api.match_limit_one);
    if (la_context) |context| dictSet(obj, dict, api.use_auth_context, context);

    var result: ?*anyopaque = null;
    if (api.sec_item_copy_matching(dict, &result) != err_sec_success) return false;
    const data = result orelse return false;
    defer api.cf_release(data);
    if (objc.msgInt(obj, data, objc.sel(obj, "length")) != 32) return false;
    const bytes: [*]const u8 = @ptrCast(objc.msg(obj, data, objc.sel(obj, "bytes")) orelse return false);
    @memcpy(out, bytes[0..32]);
    return true;
}

/// Remove the mirrored key. A missing item counts as success.
pub fn deleteKey(service: [:0]const u8) bool {
    if (builtin.os.tag != .macos) return false;
    const api = load() orelse return false;
    const obj = objc.load() orelse return false;
    const dict = baseQuery(obj, api, service) orelse return false;
    defer api.cf_release(dict);
    const status = api.sec_item_delete(dict, null);
    return status == err_sec_success or status == err_sec_item_not_found;
}

/// Return an owned dictionary; each caller releases it after its Security call.
fn baseQuery(obj: objc.Api, api: Api, service: [:0]const u8) ?*anyopaque {
    const class = obj.get_class("NSMutableDictionary") orelse return null;
    const allocated = objc.msg(obj, class, objc.sel(obj, "alloc")) orelse return null;
    const dict = objc.msg(obj, allocated, objc.sel(obj, "init")) orelse return null;
    var transferred = false;
    defer if (!transferred) api.cf_release(dict);

    dictSet(obj, dict, api.class, api.class_generic_password);
    const service_value = objc.nsString(obj, service) orelse return null;
    defer api.cf_release(service_value);
    dictSet(obj, dict, api.attr_service, service_value);
    const account_value = objc.nsString(obj, account) orelse return null;
    defer api.cf_release(account_value);
    dictSet(obj, dict, api.attr_account, account_value);

    transferred = true;
    return dict;
}

fn dictSet(obj: objc.Api, dict: *anyopaque, key: *anyopaque, value: ?*anyopaque) void {
    _ = objc.msg2(obj, dict, objc.sel(obj, "setObject:forKey:"), value, key);
}

test "the security framework loads on macOS" {
    if (builtin.os.tag != .macos) return;
    try std.testing.expect(load() != null);
}

test "diagnose a keychain write against a throwaway service" {
    if (builtin.os.tag != .macos) return;
    const key: [32]u8 = @splat(7);
    const ok = storeKey("com.wasimxyz.sage-keychain-test", &key);
    try std.testing.expect(ok);
    _ = deleteKey("com.wasimxyz.sage-keychain-test");
}
