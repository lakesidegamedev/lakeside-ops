import AppKit
import Foundation

// Copy verified artwork. Headless AppKit drawing previously emitted solid black icons.
for folder in ["Ops"] {
    let source = URL(fileURLWithPath: "Artwork/" + folder + "Icon.png")
    let data = try Data(contentsOf: source)
    guard let bitmap = NSBitmapImageRep(data: data), bitmap.pixelsWide == 1024, bitmap.pixelsHigh == 1024, !bitmap.hasAlpha else {
        fatalError("App icons must be 1024px RGB PNGs without alpha")
    }
    guard bitmap.colorAt(x: 512, y: 400) != bitmap.colorAt(x: 0, y: 0) else { fatalError("App icon is blank") }
    let root = URL(fileURLWithPath: folder + "/Assets.xcassets")
    let destination = root.appendingPathComponent("AppIcon.appiconset")
    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
    try data.write(to: destination.appendingPathComponent("Icon.png"))
    let mark = root.appendingPathComponent("KeirMark.imageset")
    try FileManager.default.createDirectory(at: mark, withIntermediateDirectories: true)
    try data.write(to: mark.appendingPathComponent("Keir.png"))
    let markInfo: [String: Any] = ["images": [["filename": "Keir.png", "idiom": "universal"]], "info": ["author": "xcode", "version": 1]]
    try JSONSerialization.data(withJSONObject: markInfo).write(to: mark.appendingPathComponent("Contents.json"))
    let content: [String: Any] = ["images": [["filename": "Icon.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"]], "info": ["author": "xcode", "version": 1]]
    try JSONSerialization.data(withJSONObject: content, options: [.prettyPrinted, .sortedKeys]).write(to: destination.appendingPathComponent("Contents.json"))
    try Data("{\"info\":{\"author\":\"xcode\",\"version\":1}}".utf8).write(to: root.appendingPathComponent("Contents.json"))
}
