import SwiftUI
import UIKit

/// The owner-approved Keir sprite pack. Three sheets share one grid:
/// frame i of state s is at x = i * cell, y = states[s].row * cell. The pack is
/// loaded once and every frame is cropped and cached on first use, so scrolling
/// the Ops screen never re-slices a sheet.
final class KeirSpriteBundleToken: NSObject {}

enum KeirSpriteSize: String {
    case small = "S"
    case medium = "M"
    case large = "L"
}

struct KeirSpritePack {
    struct SizeSpec {
        let cell: CGFloat
        let image: String
    }
    struct StateSpec {
        let row: Int
        let frames: Int
        let fps: Double
        let loop: Bool
    }

    let sizes: [String: SizeSpec]
    let states: [String: StateSpec]
    let priority: [String]
    let variety: [String]
    let blinkRange: ClosedRange<Double>
    let varietyRange: ClosedRange<Double>

    static let shared: KeirSpritePack? = load()

    static func load() -> KeirSpritePack? {
        guard let url = KeirSpriteResources.url("keir-frames", "json"),
              let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let number = { (value: Any?) -> Double? in (value as? NSNumber)?.doubleValue }
        let numbers = { (value: Any?) -> [Double] in (value as? [Any])?.compactMap { ($0 as? NSNumber)?.doubleValue } ?? [] }

        var sizes: [String: SizeSpec] = [:]
        for (key, raw) in (root["sizes"] as? [String: Any]) ?? [:] {
            guard let item = raw as? [String: Any], let cell = number(item["cell"]), let image = item["image"] as? String else { continue }
            sizes[key] = SizeSpec(cell: CGFloat(cell), image: image)
        }
        var states: [String: StateSpec] = [:]
        for (key, raw) in (root["states"] as? [String: Any]) ?? [:] {
            guard let item = raw as? [String: Any], let row = number(item["row"]), let frames = number(item["frames"]),
                  let fps = number(item["fps"]) else { continue }
            states[key] = StateSpec(row: Int(row), frames: Int(frames), fps: fps, loop: item["loop"] as? Bool ?? true)
        }
        let varietyRoot = root["idle_variety"] as? [String: Any] ?? [:]
        let every = numbers(varietyRoot["every_s"])
        let blink = numbers(varietyRoot["blink_every_s"])
        let variety = varietyRoot["pick_from"] as? [String] ?? []
        return KeirSpritePack(
            sizes: sizes,
            states: states,
            priority: root["priority"] as? [String] ?? [],
            variety: variety,
            blinkRange: (blink.count >= 2 ? blink[0] : 3)...(blink.count >= 2 ? blink[1] : 6),
            varietyRange: (every.count >= 2 ? every[0] : 18)...(every.count >= 2 ? every[1] : 40)
        )
    }

    /// The first state in the pack's priority order that the caller says applies.
    func resolve(_ available: Set<String>) -> String? {
        priority.first { available.contains($0) }
    }
}

enum KeirSpriteResources {
    static let bundle = Bundle(for: KeirSpriteBundleToken.self)
    static func url(_ name: String, _ extensionName: String) -> URL? {
        bundle.url(forResource: name, withExtension: extensionName)
            ?? bundle.url(forResource: name, withExtension: extensionName, subdirectory: "KeirSprites")
            ?? bundle.url(forResource: name, withExtension: extensionName, subdirectory: "Resources/KeirSprites")
            ?? bundle.url(forResource: name, withExtension: extensionName, subdirectory: "Resources")
    }
}

final class KeirSheetCache {
    static let shared = KeirSheetCache()
    private var sheets: [String: UIImage] = [:]
    private var frames: [String: UIImage] = [:]
    private let lock = NSLock()

    func sheet(size: String) -> UIImage? {
        lock.lock()
        if let image = sheets[size] { lock.unlock(); return image }
        lock.unlock()
        guard let spec = KeirSpritePack.shared?.sizes[size],
              let url = KeirSpriteResources.url((spec.image as NSString).deletingPathExtension, "png"),
              let image = UIImage(contentsOfFile: url.path) else { return nil }
        lock.lock(); sheets[size] = image; lock.unlock()
        return image
    }

    /// Crops one cell. The sheet's origin is top-left; CGImage.cropping uses the
    /// same pixel order, so row 0 is the first row of the PNG.
    func frame(state: String, size: String, index: Int) -> UIImage? {
        let key = "\(size)/\(state)/\(index)"
        lock.lock()
        if let image = frames[key] { lock.unlock(); return image }
        lock.unlock()
        guard let pack = KeirSpritePack.shared,
              let stateSpec = pack.states[state],
              let sizeSpec = pack.sizes[size],
              index >= 0, index < stateSpec.frames,
              let sheet = sheet(size: size), let cg = sheet.cgImage else { return nil }
        let cell = sizeSpec.cell
        let rect = CGRect(x: CGFloat(index) * cell, y: CGFloat(stateSpec.row) * cell, width: cell, height: cell)
        guard let cropped = cg.cropping(to: rect) else { return nil }
        let image = UIImage(cgImage: cropped, scale: sheet.scale, orientation: .up)
        lock.lock(); frames[key] = image; lock.unlock()
        return image
    }
}

/// One player for all three sizes. Frames are drawn at the state's fps with
/// nearest-neighbour sampling and no implicit or repeatForever animation, so
/// XCUITest can still reach idle. Reduce Motion shows frame zero and never
/// starts the timeline.
struct KeirSprite: View {
    let state: String
    var size: KeirSpriteSize = .medium
    var start: Date?
    var cycles: Int = 1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appearedAt = Date()

    private var spec: KeirSpritePack.StateSpec? { KeirSpritePack.shared?.states[state] }
    private var fps: Double { max(1, spec?.fps ?? 6) }

    var body: some View {
        if reduceMotion {
            frame(0)
        } else {
            TimelineView(.periodic(from: .now, by: 1.0 / fps)) { timeline in
                frame(index(at: timeline.date))
            }
        }
    }

    @ViewBuilder
    private func frame(_ index: Int) -> some View {
        if let image = KeirSheetCache.shared.frame(state: state, size: size.rawValue, index: index) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
        } else {
            Color.clear
        }
    }

    private func index(at date: Date) -> Int {
        guard let spec else { return 0 }
        let count = max(1, spec.frames)
        // Loops run on the absolute clock so a state change does not restart
        // mid-pose. One-shots run from the moment the caller says they began.
        let origin = spec.loop ? Date(timeIntervalSinceReferenceDate: 0) : (start ?? appearedAt)
        let raw = Int(((date.timeIntervalSince(origin) * spec.fps).rounded(.down)))
        let total = count * max(1, cycles)
        if spec.loop { return ((raw % count) + count) % count }
        if raw >= total { return count - 1 }
        return ((raw % count) + count) % count
    }
}

/// Decides which state the widget is in. The state is recomputed inside the
/// timeline so time-based states (talking, celebrate, blink, quirks) advance
/// without mutating the parent view. Priority comes from keir-frames.json.
struct KeirPortrait: View {
    var busy = false
    var waiting = 0
    var lineAt: Date?
    var changedAt: Date?
    var error = false
    var size: KeirSpriteSize = .medium
    var forced: String?
    @State private var appearedAt: Date?

    private var pack: KeirSpritePack? { KeirSpritePack.shared }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.2)) { timeline in
            let plan = plan(at: timeline.date)
            KeirSprite(state: plan.state, size: size, start: plan.start, cycles: plan.cycles)
        }
        .onAppear { if appearedAt == nil { appearedAt = Date() } }
    }

    private struct Plan {
        let state: String
        let start: Date?
        let cycles: Int
    }

    private func plan(at date: Date) -> Plan {
        guard let pack else { return Plan(state: "idle", start: nil, cycles: 1) }
        if let forced, pack.states[forced] != nil {
            return Plan(state: forced, start: nil, cycles: 1)
        }
        // Hello on the first appearance. A failure or an owner decision is
        // more important than the greeting.
        if let appearedAt, !error,
           let wave = pack.states["wave"],
           date.timeIntervalSince(appearedAt) < Double(wave.frames) / wave.fps {
            return Plan(state: "wave", start: appearedAt, cycles: 1)
        }

        var available = Set<String>()
        if error { available.insert("error") }
        if waiting > 0 { available.insert("alert") }
        if busy || lineAt == nil { available.insert("thinking") }
        if let changedAt {
            let age = date.timeIntervalSince(changedAt)
            if age < 2.4 { available.insert("talking") }
            else if age < 5.0, waiting == 0 { available.insert("celebrate") }
        }
        let base = pack.resolve(available) ?? "idle"
        if base != "idle" {
            let celebrateStart = changedAt.map { $0.addingTimeInterval(2.4) }
            return Plan(state: base, start: base == "celebrate" ? celebrateStart : nil, cycles: base == "celebrate" ? 2 : 1)
        }

        // Idle variety: blink on a 4.5s cycle (inside 3-6) and one quirk on a
        // 29s cycle (inside 18-40). The quirk is chosen from a date-seeded hash,
        // so the same second produces the same frame in snapshots.
        let t = date.timeIntervalSinceReferenceDate
        if let blink = pack.states["blink"] {
            let duration = Double(blink.frames) / blink.fps
            let phase = schedulePhase(t, period: 4.5, offset: 1.7)
            if phase < duration {
                return Plan(state: "blink", start: date.addingTimeInterval(-phase), cycles: 1)
            }
        }
        let choices = pack.variety.filter { pack.states[$0] != nil }
        if !choices.isEmpty {
            let period = 29.0, offset = 7.3
            let phase = schedulePhase(t, period: period, offset: offset)
            let cycle = Int(((t + offset) / period).rounded(.down))
            let hash = UInt64(bitPattern: Int64(cycle)) &* 0x9E3779B97F4A7C15
            let state = choices[Int(hash % UInt64(choices.count))]
            if let spec = pack.states[state] {
                let duration = Double(spec.frames) / spec.fps
                if phase < duration {
                    return Plan(state: state, start: date.addingTimeInterval(-phase), cycles: 1)
                }
            }
        }
        return Plan(state: "idle", start: nil, cycles: 1)
    }

    private func schedulePhase(_ t: Double, period: Double, offset: Double) -> Double {
        let value = (t + offset).truncatingRemainder(dividingBy: period)
        return value < 0 ? value + period : value
    }
}
