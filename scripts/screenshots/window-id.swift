// Prints the CGWindowID of the frontmost window owned by the named process.
import CoreGraphics
import Foundation

let owner = CommandLine.arguments.dropFirst().first ?? "Glimpse"
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    exit(1)
}
for window in windows {
    guard window[kCGWindowOwnerName as String] as? String == owner,
        let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
        let id = window[kCGWindowNumber as String] as? Int
    else { continue }
    print(id)
    exit(0)
}
exit(1)
