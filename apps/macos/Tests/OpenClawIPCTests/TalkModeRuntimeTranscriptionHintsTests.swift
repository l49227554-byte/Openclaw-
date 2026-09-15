import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

extension TalkModeRuntimeSpeechTests {
    @Test @MainActor func `relay hints use current preferences and never retain command authority`() async throws {
        try #require(AppStateStore.shared.isPreview)
        let previous = AppStateStore.shared.talkStopPhrases
        defer { AppStateStore.shared.talkStopPhrases = previous }
        let catalog = Data(#"""
        {"realtime":{"providers":[{"id":"openai","configured":true,"transcriptionCommandHints":{
          "version":1,"kind":"local-stop-phrases","mode":"realtime","transport":"gateway-relay",
          "models":["gpt-realtime-2.1"],"transcriptionModel":"gpt-4o-mini-transcribe",
          "maxPhrases":8,"maxPhraseUtf16Units":64,"maxTotalUtf16Units":256,"maxPromptUtf8Bytes":1024
        }}]}}
        """#.utf8)
        for phrases: [String] in [["conversation finished"], []] {
            AppStateStore.shared.talkStopPhrases = phrases
            let requests = RuntimeTestRelayRequestLog()
            let bootstrap = try makeRuntimeTestBootstrap(
                requests: requests, realtimeModel: "gpt-realtime-2.1", catalog: catalog)
            let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: { bootstrap })
            await runtime._test_setRealtimeAudioCaptureProvider { RuntimeTestAudioCapture() }
            let lifecycle = await runtime._test_prepareEnabledLifecycle()
            await runtime._test_enableRealtimeRelaySelection()
            do {
                try await runtime.startRealtimeRelay(generation: lifecycle)
                #expect(await requests.createdHintPhrases() == [phrases.isEmpty ? nil : phrases])
                #expect(await requests.snapshot().methods == (
                    phrases.isEmpty
                        ? ["talk.session.create", "talk.catalog"]
                        : ["talk.catalog", "talk.session.create", "talk.catalog"]))
                AppStateStore.shared.talkStopPhrases = []
                let relay = await runtime.realtimeRelayGeneration
                await runtime.handleRealtimeTranscript(
                    .init(role: "user", text: "conversation finished", isFinal: true), relayGeneration: relay)
                #expect(await runtime.isEnabled)
                #expect(await runtime.realtimeSession != nil)
            } catch {
                await runtime.setEnabled(false)
                throw error
            }
            await runtime.setEnabled(false)
        }
    }
}
