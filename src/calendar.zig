const std = @import("std");
const objc = @import("objc.zig");

/// The Mac's first day of the week as NSCalendar numbers it: 1 is Sunday and 7
/// is Saturday. It follows System Settings > General > Language & Region >
/// First day of week. The web view cannot read that setting, so Home asks for
/// it. Anything unexpected reads as Sunday.
pub fn firstWeekday() u8 {
    const api = objc.load() orelse return 1;
    const class = api.get_class("NSCalendar") orelse return 1;
    const calendar = objc.msg(api, class, objc.sel(api, "autoupdatingCurrentCalendar")) orelse return 1;
    const day = objc.msgInt(api, calendar, objc.sel(api, "firstWeekday"));
    if (day < 1 or day > 7) return 1;
    return @intCast(day);
}

test "firstWeekday is a day of the week" {
    const day = firstWeekday();
    try std.testing.expect(day >= 1 and day <= 7);
}
