import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

struct TalkModeRuntimeHistoryTests {
    private func message(
        _ text: String,
        timestamp: Double?,
        role: String = "assistant",
        runID: String? = nil,
        idempotencyKey: String? = nil,
        streamFallback: OpenClawChatStreamFallback? = nil) -> OpenClawChatMessage
    {
        OpenClawChatMessage(
            role: role,
            content: [
                OpenClawChatMessageContent(
                    type: "text",
                    text: text,
                    mimeType: nil,
                    fileName: nil,
                    content: nil),
            ],
            timestamp: timestamp,
            transcriptRunID: runID,
            idempotencyKey: idempotencyKey,
            streamFallback: streamFallback)
    }

    @Test func `history reply selection stays scoped to the accepted run`() {
        let target = self.message("target reply", timestamp: 10, runID: "talk-run")
        let laterForeign = self.message("foreign reply", timestamp: 20, runID: "other-run")

        #expect(TalkModeRuntime.assistantText(from: [target, laterForeign], runId: "talk-run", since: 0)
            == "target reply")
        #expect(TalkModeRuntime.assistantText(from: [target, laterForeign], runId: "missing", since: 0) == nil)
    }

    @Test(arguments: ["transcript", "idempotency", "stream"])
    func `exact run correlation does not require synchronized clocks`(_ source: String) throws {
        let since = 1_700_000_009.0
        let fallback = try JSONDecoder().decode(
            OpenClawChatStreamFallback.self,
            from: Data(#"{"runId":" talk-run "}"#.utf8))
        for timestamp in [1_700_000_000.0, 1_700_000_000_000.0, nil] as [Double?] {
            let target = self.message(
                "target reply",
                timestamp: timestamp,
                runID: source == "transcript" ? " talk-run " : nil,
                idempotencyKey: source == "idempotency" ? " talk-run " : nil,
                streamFallback: source == "stream" ? fallback : nil)
            let laterForeign = self.message("foreign reply", timestamp: since + 1, runID: "other-run")
            let matchingUser = self.message("user text", timestamp: since + 2, role: "user", runID: "talk-run")
            let history = [target, laterForeign, matchingUser]

            #expect(TalkModeRuntime.assistantText(from: history, runId: " talk-run ", since: since)
                == "target reply")
            #expect(TalkModeRuntime.assistantText(from: history, runId: "missing", since: since) == nil)
        }
    }

    @Test func `history without a run identity retains the timestamp cutoff`() {
        let since = 1_700_000_009.0
        let old = self.message("old reply", timestamp: since - 9)
        let undated = self.message("undated reply", timestamp: nil)
        let current = self.message("current reply", timestamp: since * 1000)
        for runID in [nil, "", " \n"] as [String?] {
            #expect(TalkModeRuntime.assistantText(from: [old, undated], runId: runID, since: since) == nil)
            #expect(TalkModeRuntime.assistantText(from: [old, current, undated], runId: runID, since: since)
                == "current reply")
        }
    }

    @Test func `run-correlated truncated messages remain selected for full-text retrieval`() {
        var target = self.message("preview", timestamp: 1, runID: "talk-run")
        target.isTruncated = true
        target.transcriptMessageID = "message-to-expand"
        let selected = TalkModeRuntime.assistantMessage(from: [target], runId: "talk-run", since: 10)

        #expect(selected?.transcriptMessageID == "message-to-expand")
        #expect(selected?.isTruncated == true)
    }
}
