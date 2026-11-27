// A small helper for scripts/screenshots.sh. It runs as a separate program,
// compiled into the scratch folder on each run.
//
//   window preflight        Exit 0 when this terminal may record the screen.
//                           Otherwise ask macOS for access and exit 1.
//   window window-id <pid>  Print the id of the largest normal window the
//                           process owns, for `screencapture -l`.
//   window frontmost <pid>  Exit 0 when the process is the frontmost app.
//   window activate <pid>   Ask macOS to bring the process to the front.
import AppKit
import CoreGraphics
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func pidArgument() -> pid_t {
  guard CommandLine.arguments.count > 2, let pid = pid_t(CommandLine.arguments[2]) else {
    fail("Pass the process id.")
  }
  return pid
}

let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""

switch command {
case "preflight":
  if CGPreflightScreenCaptureAccess() {
    exit(0)
  }
  _ = CGRequestScreenCaptureAccess()
  fail(
    "This terminal cannot record the screen, so the captures would show only the desktop. "
      + "Turn it on in System Settings > Privacy & Security > Screen & System Audio Recording, "
      + "restart the terminal, and run make screenshots again.")

case "window-id":
  let pid = pidArgument()
  let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
  guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    fail("Could not list windows.")
  }
  var best: (id: Int, area: Double)?
  for window in windows {
    guard (window[kCGWindowOwnerPID as String] as? Int).map({ pid_t($0) }) == pid,
      (window[kCGWindowLayer as String] as? Int) == 0,
      let id = window[kCGWindowNumber as String] as? Int,
      let bounds = window[kCGWindowBounds as String] as? [String: Double]
    else { continue }
    let area = (bounds["Width"] ?? 0) * (bounds["Height"] ?? 0)
    if best == nil || area > best!.area {
      best = (id, area)
    }
  }
  guard let found = best else {
    fail("Process \(pid) has no window.")
  }
  print(found.id)

case "frontmost":
  let pid = pidArgument()
  exit(NSWorkspace.shared.frontmostApplication?.processIdentifier == pid ? 0 : 1)

case "activate":
  let pid = pidArgument()
  guard let app = NSRunningApplication(processIdentifier: pid) else {
    fail("No app with process id \(pid).")
  }
  exit(app.activate(options: [.activateAllWindows]) ? 0 : 1)

default:
  fail("Usage: window preflight | window-id <pid> | frontmost <pid> | activate <pid>")
}
