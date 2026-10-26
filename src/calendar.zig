const std = @import("std");
const builtin = @import("builtin");
const objc = @import("objc.zig");

/// The Mac's first day of the week as NSCalendar numbers it: 1 is Sunday and 7
/// is Saturday. It follows System Settings > General > Language & Region >
/// First day of week. The web view cannot read that setting, so Home asks for
/// it. Anything unexpected reads as Sunday.
pub fn firstWeekday() u8 {
    return readFirstWeekday() orelse 1;
}

/// The setting as the system gives it, or null when it cannot be read.
fn readFirstWeekday() ?u8 {
    const api = objc.load() orelse return null;
    const class = api.get_class("NSCalendar") orelse return null;
    const calendar = objc.msg(api, class, objc.sel(api, "autoupdatingCurrentCalendar")) orelse return null;
    return weekdayFrom(objc.msgInt(api, calendar, objc.sel(api, "firstWeekday")));
}

fn weekdayFrom(day: i64) ?u8 {
    if (day < 1 or day > 7) return null;
    return @intCast(day);
}

test "weekdayFrom accepts the seven NSCalendar days and nothing else" {
    try std.testing.expectEqual(@as(?u8, 1), weekdayFrom(1));
    try std.testing.expectEqual(@as(?u8, 2), weekdayFrom(2));
    try std.testing.expectEqual(@as(?u8, 7), weekdayFrom(7));
    try std.testing.expectEqual(@as(?u8, null), weekdayFrom(0));
    try std.testing.expectEqual(@as(?u8, null), weekdayFrom(8));
    try std.testing.expectEqual(@as(?u8, null), weekdayFrom(-1));
}

// firstWeekday falls back to Sunday on any failure, so a broken class or
// selector would still pass a range check. This reads the setting without the
// fallback.
test "the system calendar answers on macOS" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;
    const day = readFirstWeekday() orelse return error.TestUnexpectedResult;
    try std.testing.expect(day >= 1 and day <= 7);
    try std.testing.expectEqual(day, firstWeekday());
}
