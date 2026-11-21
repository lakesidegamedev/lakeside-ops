import Foundation

/// Splits a spoken reply into pieces the online voice can synthesize quickly.
/// The first piece is short (one or two sentences) so audio starts fast; later
/// pieces are longer so the voice flows. Pieces end at sentence or paragraph
/// boundaries, never inside a number, an abbreviation, a ticket reference, a
/// decimal, a web address or a quoted phrase. A sentence too long for one piece
/// is cut at a clause boundary, or as a last resort between words.
public enum VoiceSegments {
    public static let firstLimit = 220
    public static let laterLimit = 550

    public enum Break: Int, Comparable {
        case none = 0, line = 1, paragraph = 2
        public static func < (a: Break, b: Break) -> Bool { a.rawValue < b.rawValue }
    }
    public struct Sentence: Equatable {
        public let text: String
        public let breakBefore: Break
    }

    /// The reply as sentences, each with the break that came before it. A line
    /// break always ends a sentence, so list items without punctuation stay apart.
    public static func sentences(_ text: String) -> [Sentence] {
        var result: [Sentence] = []
        var sawBlank = false
        for line in text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { sawBlank = true; continue }
            let first: Break = result.isEmpty ? .none : sawBlank ? .paragraph : .line
            sawBlank = false
            for (index, sentence) in split(line: trimmed).enumerated() {
                result.append(Sentence(text: sentence, breakBefore: index == 0 ? first : .none))
            }
        }
        return result
    }

    /// Speakable pieces in order. Joining them with spaces gives back every word.
    public static func segments(_ text: String, first: Int = firstLimit, later: Int = laterLimit) -> [String] {
        var queue = sentences(text)
        var out: [String] = []
        var current = "", count = 0, index = 0
        while index < queue.count {
            let limit = out.isEmpty ? first : later
            let sentence = queue[index]
            // A new paragraph starts a new piece once this one has some body.
            if !current.isEmpty && sentence.breakBefore == .paragraph && current.count >= limit * 3 / 5 {
                out.append(current); current = ""; count = 0; continue
            }
            let joined = current.isEmpty ? sentence.text : current + joiner(current, sentence) + sentence.text
            let maxSentences = out.isEmpty ? 2 : Int.max
            if joined.count <= limit && count < maxSentences {
                current = joined; count += 1; index += 1; continue
            }
            if !current.isEmpty { out.append(current); current = ""; count = 0; continue }
            let (head, rest) = cut(sentence.text, limit: limit)
            out.append(head)
            if rest.isEmpty { index += 1 } else { queue[index] = Sentence(text: rest, breakBefore: .none) }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    /// The comparison form of a sentence: case, spacing and edge punctuation do
    /// not make a sentence new.
    public static func key(_ sentence: String) -> String {
        let edges = CharacterSet.punctuationCharacters.union(.whitespacesAndNewlines).union(.symbols)
        return sentence.lowercased()
            .components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
            .trimmingCharacters(in: edges)
    }

    public static func keys(_ text: String) -> [String] { sentences(text).map { key($0.text) }.filter { !$0.isEmpty } }

    /// The reply without the sentences already spoken, keeping its line and
    /// paragraph breaks. Used when a provisional answer is revised in place.
    public static func unspoken(_ text: String, spoken: Set<String>) -> String {
        var out = "", pending = Break.none
        for sentence in sentences(text) {
            let k = key(sentence.text)
            if k.isEmpty || spoken.contains(k) { pending = max(pending, sentence.breakBefore); continue }
            let brk = max(pending, sentence.breakBefore)
            pending = .none
            if !out.isEmpty { out += brk == .paragraph ? "\n\n" : brk == .line ? "\n" : " " }
            out += sentence.text
        }
        return out
    }

    // MARK: Sentence boundaries

    private static let terminal: Set<Character> = [".", "!", "?", "\u{2026}"]
    private static let closers: Set<Character> = ["\"", "\u{201D}", "\u{2019}", "'", ")", "]"]
    private static let openers: Set<Character> = ["\"", "\u{201C}", "\u{2018}", "'", "(", "[", "#"]
    private static let abbreviations: Set<String> = [
        "mr", "mrs", "ms", "dr", "st", "jr", "sr", "prof", "vs", "etc", "approx", "inc", "ltd", "corp", "dept",
        "cf", "al", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "gov", "gen", "sen", "rep",
    ]
    /// Abbreviations that only count as such before a number ("No. 5").
    private static let numberAbbreviations: Set<String> = ["no", "nos", "vol", "fig", "p", "pp", "ch", "sec"]

    private static func split(line: String) -> [String] {
        let chars = Array(line)
        var out: [String] = []
        var start = 0, i = 0, quoted = false
        while i < chars.count {
            let c = chars[i]
            if c == "\"" { quoted.toggle() } else if c == "\u{201C}" { quoted = true } else if c == "\u{201D}" { quoted = false }
            guard terminal.contains(c) else { i += 1; continue }
            var end = i + 1
            while end < chars.count, terminal.contains(chars[end]) { end += 1 }
            let single = end == i + 1 && c == "."
            while end < chars.count, closers.contains(chars[end]) {
                if chars[end] == "\"" { if !quoted { break }; quoted = false }
                else if chars[end] == "\u{201D}" { quoted = false }
                end += 1
            }
            if !quoted, end < chars.count, chars[end].isWhitespace, boundary(chars, at: i, after: end, single: single) {
                let piece = String(chars[start..<end]).trimmingCharacters(in: .whitespaces)
                if !piece.isEmpty { out.append(piece) }
                start = end
            }
            i = end
        }
        let tail = String(chars[start...]).trimmingCharacters(in: .whitespaces)
        if !tail.isEmpty { out.append(tail) }
        return out
    }

    private static func boundary(_ chars: [Character], at index: Int, after end: Int, single: Bool) -> Bool {
        var next = end
        while next < chars.count, chars[next].isWhitespace { next += 1 }
        guard next < chars.count else { return false }
        let n = chars[next]
        guard n.isUppercase || n.isNumber || openers.contains(n) else { return false }
        guard single else { return true }
        var back = index
        while back > 0, !chars[back - 1].isWhitespace { back -= 1 }
        var token = String(chars[back..<index])
        while let f = token.first, openers.contains(f) { token.removeFirst() }
        guard !token.isEmpty else { return true }
        let lower = token.lowercased()
        if abbreviations.contains(lower) { return false }
        if numberAbbreviations.contains(lower) && n.isNumber { return false }
        if token.count == 1, token.first?.isLetter == true { return false }
        // "e.g", "U.S", "a.m": short letter groups joined by periods.
        let parts = lower.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count > 1, parts.allSatisfy({ !$0.isEmpty && $0.count <= 2 && $0.allSatisfy(\.isLetter) }) { return false }
        return true
    }

    // MARK: Pieces

    private static func joiner(_ previous: String, _ next: Sentence) -> String {
        guard next.breakBefore != .none, let last = previous.last else { return " " }
        if terminal.contains(last) || closers.contains(last) || ",;:".contains(last) { return " " }
        // A list item or heading without punctuation gets a pause before the next line.
        if let f = next.text.first, f.isUppercase || f.isNumber { return ". " }
        return " "
    }

    /// The longest head of `text` within `limit` that ends at a clause boundary,
    /// else between words, never inside a quoted phrase when avoidable.
    static func cut(_ text: String, limit: Int) -> (String, String) {
        let chars = Array(text)
        guard chars.count > limit, limit > 1 else { return (text, "") }
        var inside = [Bool](repeating: false, count: chars.count)
        var quoted = false
        for (k, c) in chars.enumerated() {
            if c == "\"" { quoted.toggle() } else if c == "\u{201C}" { quoted = true } else if c == "\u{201D}" { quoted = false }
            inside[k] = quoted
        }
        func parts(_ headEnd: Int, _ restStart: Int) -> (String, String) {
            (String(chars[..<headEnd]).trimmingCharacters(in: .whitespaces),
             String(chars[restStart...]).trimmingCharacters(in: .whitespaces))
        }
        let top = min(limit, chars.count - 1)
        var k = top - 1
        while k >= limit * 2 / 5 {
            if ",;:".contains(chars[k]), chars[k + 1] == " ", !inside[k] { return parts(k + 1, k + 2) }
            k -= 1
        }
        k = top
        while k >= limit / 3 {
            if chars[k] == " ", !inside[k] { return parts(k, k + 1) }
            k -= 1
        }
        k = top
        while k >= 1 {
            if chars[k] == " " { return parts(k, k + 1) }
            k -= 1
        }
        if let space = chars[limit...].firstIndex(of: " ") { return parts(space, space + 1) }
        return (text, "")
    }
}
