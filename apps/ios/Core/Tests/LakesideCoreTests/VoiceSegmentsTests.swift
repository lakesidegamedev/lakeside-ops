import XCTest
@testable import LakesideCore

final class VoiceSegmentsTests: XCTestCase {
    private func texts(_ text: String) -> [String] { VoiceSegments.sentences(text).map(\.text) }
    private func words(_ text: String) -> [String] { text.split(whereSeparator: \.isWhitespace).map(String.init) }

    func testAbbreviationsDoNotEndASentence() {
        XCTAssertEqual(texts("Dr. Smith checked it. Then e.g. the fix landed at 3 p.m. Today it holds."),
                       ["Dr. Smith checked it.", "Then e.g. the fix landed at 3 p.m. Today it holds."])
        XCTAssertEqual(texts("See No. 5 in the list. It is done."), ["See No. 5 in the list.", "It is done."])
        XCTAssertEqual(texts("The answer is no. Then we move on."), ["The answer is no.", "Then we move on."])
        XCTAssertEqual(texts("J. Smith filed it. Done."), ["J. Smith filed it.", "Done."])
    }

    func testNumbersDecimalsAndTicketReferencesStayWhole() {
        XCTAssertEqual(texts("Ticket #1860 is fixed. Turn 77 paid 3.5 million. #1861 is next. Version 2.8.0 ships."),
                       ["Ticket #1860 is fixed.", "Turn 77 paid 3.5 million.", "#1861 is next.", "Version 2.8.0 ships."])
        XCTAssertEqual(texts("It costs $1,250.75 per turn. Fine."), ["It costs $1,250.75 per turn.", "Fine."])
    }

    func testWebAddressesStayWhole() {
        XCTAssertEqual(texts("See https://ops.example.com/a.b?x=1. Then reload the page."),
                       ["See https://ops.example.com/a.b?x=1.", "Then reload the page."])
        XCTAssertEqual(texts("Open example.com. It loads."), ["Open example.com.", "It loads."])
    }

    func testQuotedPhrasesStayWhole() {
        XCTAssertEqual(texts("He said \"Stop. Wait here.\" Then he left."), ["He said \"Stop. Wait here.\"", "Then he left."])
        XCTAssertEqual(texts("The note reads \u{201C}Do not merge. Checks are red.\u{201D} So I waited."),
                       ["The note reads \u{201C}Do not merge. Checks are red.\u{201D}", "So I waited."])
    }

    func testQuestionsExclamationsAndEllipses() {
        XCTAssertEqual(texts("Is it fixed? Yes! Mostly... Watch turn 80."), ["Is it fixed?", "Yes!", "Mostly...", "Watch turn 80."])
    }

    func testTextWithoutTerminalPunctuationIsOneSegment() {
        let text = "ok so the payroll looks fine now and the budget screen matches"
        XCTAssertEqual(VoiceSegments.segments(text), [text])
    }

    func testListsKeepTheirItemsApart() {
        let text = "Three things changed:\nPayroll is fixed\nBudget is fixed\nTaxes are next"
        XCTAssertEqual(texts(text), ["Three things changed:", "Payroll is fixed", "Budget is fixed", "Taxes are next"])
        let pieces = VoiceSegments.segments(text)
        XCTAssertEqual(pieces.first, "Three things changed: Payroll is fixed")
        XCTAssertEqual(pieces.dropFirst().joined(separator: " "), "Budget is fixed. Taxes are next")
    }

    func testFirstSegmentIsShortAndLaterOnesAreLonger() {
        let sentence = "The payroll run for the northern provinces finished on time and every worker was paid in full."
        let text = Array(repeating: sentence, count: 14).joined(separator: " ")
        let pieces = VoiceSegments.segments(text)
        XCTAssertGreaterThan(pieces.count, 2)
        XCTAssertLessThanOrEqual(pieces[0].count, VoiceSegments.firstLimit)
        XCTAssertLessThanOrEqual(texts(pieces[0]).count, 2)
        for piece in pieces.dropFirst() { XCTAssertLessThanOrEqual(piece.count, VoiceSegments.laterLimit) }
        for piece in pieces.dropFirst().dropLast() { XCTAssertGreaterThan(piece.count, VoiceSegments.firstLimit) }
        XCTAssertEqual(words(pieces.joined(separator: " ")), words(text))
        for piece in pieces { XCTAssertEqual(piece.last, ".", "pieces end on a sentence") }
    }

    func testAVeryLongSentenceIsCutAtAClause() {
        let clause = "the treasury moved the surplus into the reserve fund"
        let text = Array(repeating: clause, count: 16).joined(separator: ", ") + "."
        let pieces = VoiceSegments.segments(text)
        XCTAssertGreaterThan(pieces.count, 1)
        XCTAssertLessThanOrEqual(pieces[0].count, VoiceSegments.firstLimit)
        for piece in pieces.dropLast() { XCTAssertEqual(piece.last, ",", "cut after a comma: \(piece)") }
        for piece in pieces.dropFirst() { XCTAssertLessThanOrEqual(piece.count, VoiceSegments.laterLimit) }
        XCTAssertEqual(words(pieces.joined(separator: " ")), words(text))
    }

    func testALongSentenceWithoutClausesIsCutBetweenWords() {
        let text = Array(repeating: "payroll", count: 120).joined(separator: " ")
        let pieces = VoiceSegments.segments(text)
        XCTAssertGreaterThan(pieces.count, 1)
        XCTAssertLessThanOrEqual(pieces[0].count, VoiceSegments.firstLimit)
        for piece in pieces { XCTAssertTrue(words(piece).allSatisfy { $0 == "payroll" }, "never inside a word") }
        XCTAssertEqual(words(pieces.joined(separator: " ")), words(text))
    }

    func testAQuotedPhraseIsNotCutWhenAClauseIsAvailable() {
        let quote = "\"leave the budget, the payroll and the reserve exactly as they are\""
        let text = "First the treasury reviewed every province, then it wrote " + quote + " and " + String(repeating: "waited again ", count: 20) + "."
        let pieces = VoiceSegments.segments(text)
        XCTAssertTrue(pieces.contains { $0.contains(quote) }, "the quote stays in one piece: \(pieces)")
    }

    func testParagraphsAreRespected() {
        let first = String(repeating: "The fix is merged and the checks are green. ", count: 3).trimmingCharacters(in: .whitespaces)
        let second = "Next I will watch turn 80."
        let pieces = VoiceSegments.segments(first + "\n\n" + second)
        XCTAssertEqual(words(pieces.joined(separator: " ")), words(first + " " + second))
        XCTAssertEqual(VoiceSegments.sentences(first + "\n\n" + second).last?.breakBefore, .paragraph)
    }

    func testShortReplyIsOneSegmentAndEmptyIsNone() {
        XCTAssertEqual(VoiceSegments.segments("Got it."), ["Got it."])
        XCTAssertEqual(VoiceSegments.segments("  \n "), [])
    }

    func testRevisedAnswerSkipsSentencesAlreadySpoken() {
        let spoken = Set(VoiceSegments.keys("I'm checking this now. The payroll is fine."))
        XCTAssertEqual(VoiceSegments.unspoken("I'm checking this now.  The payroll is fine!\n\nThe budget is fine too.", spoken: spoken),
                       "The budget is fine too.")
        XCTAssertEqual(VoiceSegments.unspoken("The payroll is fine.", spoken: spoken), "")
        XCTAssertEqual(VoiceSegments.unspoken("Line one.\nLine two.", spoken: []), "Line one.\nLine two.")
    }
}
