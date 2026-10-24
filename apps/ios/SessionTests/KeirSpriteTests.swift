import XCTest
import UIKit
@testable import LakesideOps

final class KeirSpriteTests: XCTestCase {
    func testFramesJSONParsesAndCoversThePack() throws {
        let pack = try XCTUnwrap(KeirSpritePack.load())
        XCTAssertEqual(pack.states.count, 45)
        XCTAssertEqual(pack.priority.count, 15)
        XCTAssertEqual(Set(pack.sizes.keys), Set(["S", "M", "L"]))
        XCTAssertEqual(pack.sizes["S"]?.cell, CGFloat(24))
        XCTAssertEqual(pack.sizes["M"]?.cell, CGFloat(40))
        XCTAssertEqual(pack.sizes["L"]?.cell, CGFloat(80))
        XCTAssertNotNil(pack.states["idle"])
        XCTAssertNotNil(pack.states["wave"])
        XCTAssertGreaterThanOrEqual(pack.blinkRange.lowerBound, 3)
        XCTAssertLessThanOrEqual(pack.blinkRange.upperBound, 6)
        XCTAssertGreaterThanOrEqual(pack.varietyRange.lowerBound, 18)
        XCTAssertLessThanOrEqual(pack.varietyRange.upperBound, 40)
    }

    func testEveryFrameFitsAllThreeSheets() throws {
        let pack = try XCTUnwrap(KeirSpritePack.load())
        for (key, size) in pack.sizes {
            let sheet = try XCTUnwrap(KeirSheetCache.shared.sheet(size: key), "\(key) sheet")
            let image = try XCTUnwrap(sheet.cgImage)
            let cell = Int(size.cell)
            XCTAssertEqual(image.width, cell * 10, "\(key) sheet width")
            XCTAssertEqual(image.height, cell * 45, "\(key) sheet height")
            for (name, state) in pack.states {
                XCTAssertGreaterThanOrEqual(state.frames, 1, name)
                XCTAssertLessThanOrEqual(state.frames, 10, name)
                XCTAssertGreaterThanOrEqual(state.row, 0, name)
                XCTAssertLessThanOrEqual((state.row + 1) * cell, image.height, "\(key)/\(name) row")
                XCTAssertLessThanOrEqual(state.frames * cell, image.width, "\(key)/\(name) frames")
                XCTAssertNotNil(KeirSheetCache.shared.frame(state: name, size: key, index: 0), "\(key)/\(name) first frame")
                XCTAssertNotNil(KeirSheetCache.shared.frame(state: name, size: key, index: state.frames - 1), "\(key)/\(name) last frame")
                XCTAssertNil(KeirSheetCache.shared.frame(state: name, size: key, index: state.frames), "\(key)/\(name) past the end")
            }
        }
    }

    func testPriorityAndIdleVarietyResolve() throws {
        let pack = try XCTUnwrap(KeirSpritePack.load())
        for name in pack.priority {
            XCTAssertNotNil(pack.states[name], "priority names \(name)")
        }
        for name in pack.variety {
            XCTAssertNotNil(pack.states[name], "idle variety names \(name)")
        }
        for index in pack.priority.indices {
            let available = Set(pack.priority.prefix(index + 1))
            XCTAssertEqual(pack.resolve(available), Optional(pack.priority[index]), "priority \(index)")
        }
        XCTAssertNil(pack.resolve([]))
    }
}
