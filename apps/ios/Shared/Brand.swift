import SwiftUI

/// Colors and marks shared with the Lakeside web surfaces.
enum Brand {
    static func adaptive(_ dark: UInt32, _ light: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
        })
    }
    static let background = adaptive(0x0a0f14, 0xf7f8fa)
    static let surface = adaptive(0x111b26, 0xffffff)
    static let raised = adaptive(0x16222e, 0xeaf0f6)
    static let sky = adaptive(0x38bdf8, 0x0284c7)
    static let onAccent = adaptive(0x06222f, 0xffffff)
    static let mint = adaptive(0x21c8a0, 0x0d9488)
    static let ink = adaptive(0xeaf0f6, 0x1a1d24)
}

struct LakesideStyle: ViewModifier {
    @AppStorage("appearance") private var appearance = "dark"
    func body(content: Content) -> some View {
        content.tint(Brand.sky).foregroundStyle(Brand.ink)
            .preferredColorScheme(appearance == "system" ? nil : appearance == "light" ? .light : .dark)
            .scrollContentBackground(.hidden)
            .background(Brand.background)
    }
}

extension View {
    func lakesideScreen() -> some View {
        scrollContentBackground(.hidden).background(Brand.background)
            .toolbarBackground(Brand.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }
    func brandCard() -> some View {
        padding(18).background(Brand.surface, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(Brand.sky.opacity(0.12)))
    }
}

struct BrandMark: View {
    var surface: Surface
    var size: CGFloat = 44
    var body: some View {
        Image(surface == .ask ? "AskMark" : "LakesideMark")
            .resizable().scaledToFit().frame(width: size, height: size)
            .accessibilityLabel(surface == .ask ? "Lakeside Ask logo" : "Lakeside Games logo")
    }
}

struct BrandHeader: View {
    var surface: Surface
    var compact = false
    var body: some View {
        HStack(spacing: 10) {
            BrandMark(surface: surface, size: 30)
            Text(surface == .ask ? "Ask" : "Lakeside").font(.headline.weight(.bold))
            if !compact {
                Text(surface == .ask ? "LAKESIDE" : "OPS")
                    .font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(1.2).foregroundStyle(Brand.sky)
            }
        }.lineLimit(1).fixedSize(horizontal: true, vertical: false).accessibilityElement(children: .combine)
    }
}

struct BrandHero: View {
    var surface: Surface
    var compact = false
    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 12 : 20) {
            HStack(spacing: 12) {
                BrandMark(surface: surface, size: compact ? 44 : 64)
                VStack(alignment: .leading, spacing: 4) {
                    Text(surface.title).font(.headline)
                    Text(surface == .ask ? "GROUNDED IN YOUR GAME" : "LAKESIDE GAMES / OPERATIONS")
                        .font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(1.2).foregroundStyle(Brand.sky)
                }
            }
            Text(surface == .ask ? "Know your\nnext move." : surface == .hub ? "Your studio.\nIn motion." : "Talk to Keir.\nRun the studio.")
                .font(.system(size: compact ? 38 : 48, weight: .bold, design: .rounded)).tracking(-1.8).fixedSize(horizontal: false, vertical: true)
            Text(surface == .ask ? "Answers about how the game actually works. Live context. Sources you can follow." : surface == .hub ? "One assistant with lasting memory. A team that grows with the task. Your studio, wherever you are." : "Ask, decide and follow the work. Tickets, approvals and studio health, all in one place.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
