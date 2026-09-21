import Foundation
import XCTest

/// Opt-in real Gateway proof. Use only a task-owned paired simulator and synthetic Photos library.
@MainActor
final class SentImageHistoryUITests: XCTestCase {
    func testSentPhotoRemainsVisibleAfterReplyAndRelaunch() throws {
        guard ProcessInfo.processInfo.environment["OPENCLAW_IOS_LIVE_GATEWAY"] == "1",
              let reply = ProcessInfo.processInfo.environment["OPENCLAW_IOS_EXPECTED_PHOTO_REPLY"]
        else { throw XCTSkip("Requires an isolated Gateway with a synthetic photo reply") }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-initial-tab", "chat", "--openclaw-initial-destination", "chat",
            "--openclaw-sidebar-visibility", "hidden",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        app.launch()
        let sidebar = app.buttons["RootTabs.Sidebar.Show"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 10))
        sidebar.tap()
        let newChat = app.buttons["New Chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 5))
        newChat.tap()

        let picker = app.buttons["chat-attachment-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10))
        // iOS 27 SwiftUI menus and Photos images expose incorrect isHittable values;
        // these native centers were verified by independent HID input.
        picker.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let library = app.buttons["Photo Library"]
        XCTAssertTrue(library.waitForExistence(timeout: 5))
        library.tap()
        let photo = app.images.matching(NSPredicate(format: "label BEGINSWITH %@", "Photo,")).firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 10))
        photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let done = app.navigationBars["Photos"].buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        XCTAssertTrue(done.isEnabled)
        done.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let staged = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "photo-")).firstMatch
        XCTAssertTrue(staged.waitForExistence(timeout: 10))
        self.capture(app, name: "photo-staged-before-send")
        // No keyboard focus: this isolates history rendering from the separately repaired composer cycle.
        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertTrue(send.isEnabled)
        XCTAssertTrue(send.isHittable)
        send.tap()
        XCTAssertTrue(app.staticTexts[reply].waitForExistence(timeout: 45))
        let image = app.buttons["chat-message-image"].firstMatch
        let imageExists = image.waitForExistence(timeout: 15)
        self.capture(app, name: "sent-photo-after-canonical-reply")
        XCTAssertTrue(imageExists, "Sent image must survive canonical history, not only optimistic staging")
        XCTAssertTrue(image.isHittable)
        image.tap()
        let close = app.buttons["Close image preview"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        self.capture(app, name: "sent-photo-preview")
        close.tap()
        sidebar.tap()
        let selectedSession = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH %@ AND isSelected == true",
            "RootTabs.Sidebar.Session.")).firstMatch
        XCTAssertTrue(selectedSession.waitForExistence(timeout: 10))
        let sessionIdentifier = selectedSession.identifier
        XCTAssertFalse(sessionIdentifier == "RootTabs.Sidebar.Session.")
        app.terminate()
        app.launch()
        XCTAssertTrue(sidebar.waitForExistence(timeout: 10))
        sidebar.tap()
        let createdSession = app.buttons[sessionIdentifier]
        XCTAssertTrue(createdSession.waitForExistence(timeout: 20), "Created conversation must survive relaunch")
        createdSession.tap()
        XCTAssertTrue(app.staticTexts[reply].waitForExistence(timeout: 20))
        XCTAssertTrue(
            app.buttons["chat-message-image"].firstMatch.waitForExistence(timeout: 20),
            "Sent image must remain fetchable after relaunch/cache reload")
        XCTAssertEqual(
            app.buttons.matching(identifier: "chat-message-image").count, 1,
            "Created conversation must contain its single sent photo")
        self.capture(app, name: "sent-photo-after-relaunch")
    }

    private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
