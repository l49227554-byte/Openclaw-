import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct WebChatManagerTests {
    @Test func `route identity includes the session and normalized agent`() {
        let work = WebChatRoute(sessionKey: "global", agentID: " Work ")
        let sameWork = WebChatRoute(sessionKey: "global", agentID: "work")
        let main = WebChatRoute(sessionKey: "global", agentID: "main")

        #expect(work == sameWork)
        #expect(work != main)
        #expect(work != WebChatRoute(sessionKey: "main", agentID: "work"))
    }

    @Test func `blank agent route normalizes to nil`() {
        #expect(WebChatRoute(sessionKey: "global", agentID: "  ") ==
            WebChatRoute(sessionKey: "global", agentID: nil))
    }
}
