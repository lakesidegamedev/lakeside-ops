import SwiftUI
import LakesideCore

struct FailureBanner: View {
    let message: String
    var body: some View { Label(message, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.red).padding().frame(maxWidth: .infinity, alignment: .leading) }
}

struct NativeMarkdown: View {
    let text: String
    var streaming = false
    /// Paragraphs fill the available width by default. A chat bubble passes
    /// false so short replies hug their text instead of spanning the screen.
    var fills = true
    @Environment(\.horizontalSizeClass) private var sizeClass
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                if block.code && ["mermaid", "mmd", "ahd-map"].contains(block.language) {
                    if block.closed || !streaming { NativeVisualization(language: block.language, source: block.text) }
                    else { ProgressView("Preparing visualization…").font(.caption) }
                } else if block.code {
                    ScrollView(.horizontal) { Text(block.text).font(.system(.footnote, design: .monospaced)).padding(12) }
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                } else if block.text.hasPrefix("# ") {
                    Text(inline(String(block.text.dropFirst(2)))).font(.title2.bold())
                } else if block.text.hasPrefix("## ") {
                    Text(inline(String(block.text.dropFirst(3)))).font(.title3.bold())
                } else if block.text.hasPrefix("### ") {
                    Text(inline(String(block.text.dropFirst(4)))).font(.headline)
                } else if block.text.split(separator: "\n").filter({ $0.contains("|") }).count >= 2 {
                    table(block.text)
                } else if fills { Text(inline(block.text)).frame(maxWidth: .infinity, alignment: .leading) }
                else { Text(inline(block.text)).fixedSize(horizontal: false, vertical: true) }
            }
        }.textSelection(.enabled)
    }
    private func inline(_ value: String) -> AttributedString {
        (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value)
    }
    private struct Block { var text: String; var code: Bool; var language: String; var closed: Bool }
    private var blocks: [Block] {
        var result: [Block] = []; var lines: [String] = []; var code = false; var language = ""
        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                if !lines.isEmpty { result.append(Block(text: lines.joined(separator: "\n"), code: code, language: language, closed: true)); lines = [] }
                if !code { language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces).lowercased() }
                code.toggle()
            } else if line.isEmpty && !code {
                if !lines.isEmpty { result.append(Block(text: lines.joined(separator: "\n"), code: false, language: "", closed: true)); lines = [] }
            } else { lines.append(line) }
        }
        if !lines.isEmpty { result.append(Block(text: lines.joined(separator: "\n"), code: code, language: language, closed: !code)) }
        return result
    }
    @ViewBuilder private func table(_ text: String) -> some View {
        let rows = MarkdownTable.rows(text)
        if let header = rows.first, sizeClass == .compact {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(rows.dropFirst().enumerated()), id: \.offset) { _, row in
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                            VStack(alignment: .leading, spacing: 2) {
                                if column > 0, column < header.count { Text(inline(header[column])).font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
                                Text(inline(cell)).fontWeight(column == 0 ? .semibold : .regular).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                }
            }.accessibilityIdentifier("markdown-table-cards")
        } else {
            ScrollView(.horizontal) {
                Grid(alignment: .topLeading, horizontalSpacing: 20, verticalSpacing: 12) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(inline(cell)).fontWeight(index == 0 ? .semibold : .regular)
                                    .frame(width: 240, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }.padding(12)
            }.background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
        }
    }

}

struct JSONDetail: View {
    let title: String
    let value: JSONValue
    var body: some View {
        List {
            if !value.object.isEmpty {
                ForEach(value.object.keys.sorted(), id: \.self) { key in
                    let field = value[key]
                    if !field.object.isEmpty || !field.array.isEmpty {
                        NavigationLink(key) { JSONDetail(title: key, value: field) }
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(key).font(.caption).foregroundStyle(.secondary)
                            if field.string.count > 120 { NativeMarkdown(text: field.string) }
                            else { Text(field == .null ? "None" : field.string).textSelection(.enabled) }
                        }.padding(.vertical, 3)
                    }
                }
            } else if !value.array.isEmpty {
                ForEach(Array(value.array.enumerated()), id: \.offset) { index, item in
                    NavigationLink(item.first("title", "name", "label", "date").nonempty ?? "Item \(index + 1)") { JSONDetail(title: "Details", value: item) }
                }
            } else { Text(value.string.nonempty ?? value.pretty).textSelection(.enabled) }
        }.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
    }
}

extension String { var nonempty: String? { isEmpty ? nil : self } }

struct AccountView: View {
    @EnvironmentObject private var session: AppSession
    @State private var signingOut = false
    @AppStorage("appearance") private var appearance = "system"
    var body: some View {
        List {
            Section { BrandHeader(surface: session.surface).padding(.vertical, 8) }.listRowBackground(Brand.surface)
            if session.surface == .ask {
                Section { UsagePanel(usage: session.profile["usage"]).listRowInsets(EdgeInsets()).listRowBackground(Color.clear) }
            }
            if let error = session.error { FailureBanner(message: error) }
            Section("Account") {
                Text(session.profile.first("email", "role").nonempty ?? session.profile["identity"].first("username", "email", "id"))
                if !session.profile["entitlement"]["label"].string.isEmpty { LabeledContent("Access", value: session.profile["entitlement"]["label"].string) }

                Button("Sign out", role: .destructive) { signingOut = true; Task { await session.signOut(); signingOut = false } }.disabled(signingOut)
            }
            Section("Appearance") {
                Picker("Theme", selection: $appearance) {
                    Text("Lakeside dark").tag("dark"); Text("Light").tag("light"); Text("System").tag("system")
                }
            }
            Section {
                LabeledContent("App", value: session.surface.title)
                LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                Text("Connected to \(session.surface.host)").foregroundStyle(.secondary)
            }
        }.lakesideScreen().navigationTitle("Account").refreshable { await session.refreshProfile() }.task { await session.refreshProfile() }
    }
}


enum MarkdownTable {
    static func rows(_ text: String) -> [[String]] {
        text.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: CharacterSet(charactersIn: "| :-\t")).isEmpty }.map { line in
            var cells = line.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
            if cells.first == "" { cells.removeFirst() }
            if cells.last == "" { cells.removeLast() }
            return cells
        }
    }
}
