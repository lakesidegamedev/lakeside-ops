import XCTest
@testable import LakesideOps

/// The portrait is the product: every row must be a full 24-pixel line and
/// every character must resolve to a palette colour, or the Canvas silently
/// drops the pixel and the character stops looking like Keir.
final class StarmerArtTests: XCTestCase {
    func testPortraitIsACompletePixelGrid() {
        XCTAssertEqual(StarmerArt.columns, 24)
        XCTAssertEqual(StarmerArt.baseRows.count, 24)
        for (index, row) in StarmerArt.baseRows.enumerated() {
            XCTAssertEqual(row.count, 24, "row \(index) is \(row.count) pixels")
            for character in row {
                XCTAssertTrue(character == "." || StarmerArt.palette[character] != nil, "row \(index) has an unknown pixel \(character)")
            }
        }
    }

    func testPaletteCoversHairSkinGlassesShirtTieAndSuit() {
        for character in "HhSsGEWTUuM" {
            XCTAssertNotNil(StarmerArt.palette[character], "missing \(character)")
        }
        XCTAssertEqual(StarmerArt.palette.count, 15)
    }

    func testEveryMoodIsACompleteFrame() {
        for mood in StarmerMood.allCases {
            for time in [0.0, 0.16, 0.5, 1.0, 2.4, 4.4] {
                let rows = StarmerArt.rows(for: mood, time: time)
                XCTAssertEqual(rows.count, 24, "\(mood) at \(time)s")
                for (index, row) in rows.enumerated() {
                    XCTAssertEqual(row.count, 24, "\(mood) row \(index) at \(time)s")
                    for character in row {
                        XCTAssertTrue(character == "." || StarmerArt.palette[character] != nil, "\(mood) has an unknown pixel \(character)")
                    }
                }
            }
        }
    }

    func testExpressionsActuallyDiffer() {
        let idle = StarmerArt.rows(for: .idle, time: 1.0).joined()
        let thinking = StarmerArt.rows(for: .thinking, time: 0.6).joined()
        let alert = StarmerArt.rows(for: .alert, time: 0.3).joined()
        let celebrate = StarmerArt.rows(for: .celebrate, time: 0.0).joined()
        XCTAssertNotEqual(idle, thinking)
        XCTAssertNotEqual(idle, alert)
        XCTAssertNotEqual(idle, celebrate)
        XCTAssertNotEqual(thinking, alert)
    }
}
