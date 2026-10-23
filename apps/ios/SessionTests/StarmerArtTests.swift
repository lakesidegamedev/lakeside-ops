import XCTest
@testable import LakesideOps

/// The portrait is the product: every row must be a full 24-pixel line and
/// every character must resolve to a palette colour, or the Canvas silently
/// drops the pixel and the character stops looking like Keir.
final class StarmerArtTests: XCTestCase {
    func testPortraitIsACompletePixelGrid() {
        XCTAssertEqual(StarmerArt.columns, 24)
        XCTAssertEqual(StarmerArt.rows.count, 24)
        for (index, row) in StarmerArt.rows.enumerated() {
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
        XCTAssertEqual(StarmerArt.palette.count, 11)
    }
}
