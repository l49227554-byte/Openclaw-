import Foundation
import Testing
@testable import OpenClawChatUI

private actor AgentNavigationGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false

    func wait() async {
        guard !self.released else { return }
        await withCheckedContinuation { self.continuation = $0 }
    }

    func release() {
        self.released = true
        self.continuation?.resume()
        self.continuation = nil
    }
}

private actor AgentNavigationTransport: OpenClawChatTransport {
    enum Failure: Error { case offline }

    let catalogs: [Result<OpenClawChatAgentsListResponse?, Failure>]
    let catalogGate: AgentNavigationGate?
    let sendGate: AgentNavigationGate?
    private(set) var catalogRequests = 0
    private(set) var sentKeys: [String] = []
    private(set) var createdKeys: [String] = []
    private(set) var listedAgentIDs: [String?] = []

    init(
        catalogs: [Result<OpenClawChatAgentsListResponse?, Failure>],
        catalogGate: AgentNavigationGate? = nil,
        sendGate: AgentNavigationGate? = nil)
    {
        self.catalogs = catalogs
        self.catalogGate = catalogGate
        self.sendGate = sendGate
    }

    func listAgents() async throws -> OpenClawChatAgentsListResponse? {
        let index = self.catalogRequests
        self.catalogRequests += 1
        let result = self.catalogs[min(index, self.catalogs.count - 1)]
        if index == 0 { await self.catalogGate?.wait() }
        return try result.get()
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        OpenClawChatHistoryPayload(sessionKey: sessionKey, sessionId: nil, messages: [], thinkingLevel: "off")
    }

    func listSessions(
        limit _: Int?,
        search _: String?,
        archived _: Bool,
        agentID: String?) async throws -> OpenClawChatSessionsListResponse
    {
        self.listedAgentIDs.append(agentID)
        return OpenClawChatSessionsListResponse(
            ts: nil, path: nil, count: 0, defaults: nil, sessions: [])
    }

    func sendMessage(
        sessionKey: String,
        message _: String,
        thinking _: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        self.sentKeys.append(sessionKey)
        await self.sendGate?.wait()
        return OpenClawChatSendResponse(runId: idempotencyKey, status: "ok")
    }

    func createSession(
        key: String,
        label _: String?,
        parentSessionKey _: String?,
        worktree _: Bool?) async throws -> OpenClawChatCreateSessionResponse
    {
        self.createdKeys.append(key)
        return OpenClawChatCreateSessionResponse(ok: true, key: key, sessionId: nil)
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func deleteSession(key _: String) async throws {}

    nonisolated func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }
}

@MainActor
private final class AgentNavigationFixture {
    let suite = "OpenClawAgentNavigationTests.\(UUID().uuidString)"
    let defaults: UserDefaults
    let viewModel: OpenClawChatViewModel

    init(
        transport: AgentNavigationTransport,
        sessionKey: String = "main",
        routingContract: String = "per-agent|main|main")
    {
        self.defaults = UserDefaults(suiteName: self.suite)!
        self.viewModel = OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            activeAgentId: "main",
            sessionRoutingContract: routingContract,
            modelPickerStore: ChatModelPickerStore(defaults: self.defaults))
    }

    func close() {
        self.viewModel.detachTransport()
        self.defaults.removePersistentDomain(forName: self.suite)
    }
}

@MainActor
struct ChatViewModelAgentNavigationTests {
    private func catalog(contract: String = "per-agent|main|main") -> OpenClawChatAgentsListResponse {
        OpenClawChatAgentsListResponse(
            defaultId: "main",
            agents: [.init(id: "main", name: "Assistant"), .init(id: "research", name: "Research")],
            sessionRoutingContract: contract)
    }

    @Test(arguments: ["per-agent|inbox|main", "global|inbox|main"])
    func `agent selection reopens its main and keeps sends and new chats on that agent`(contract: String) async throws {
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog(contract: contract))])
        let fixture = AgentNavigationFixture(transport: transport, routingContract: contract)
        defer { fixture.close() }
        let vm = fixture.viewModel
        await vm.refreshAgents()

        vm.switchAgent(to: "RESEARCH")
        let mainKey = contract.hasPrefix("global|") ? "global" : "inbox"
        let selectedKey = "agent:research:\(mainKey)"
        #expect(vm.sessionKey == selectedKey)
        #expect(vm.selectedAgentID == "research")
        #expect(vm.selectedAgent?.displayName == "Research")
        #expect(vm.selectedAgentMainSessionKey == selectedKey)
        try await waitUntil("selected agent roster loads") {
            await transport.listedAgentIDs.contains("research")
        }
        _ = await vm.fetchSessionList(search: "older", archived: true)
        #expect(await transport.listedAgentIDs.last == "research")
        vm.switchAgent(to: "research")
        #expect(await transport.createdKeys.isEmpty)

        vm.syncActiveAgentId("replacement-default")
        #expect(vm.selectedAgentID == "research")
        vm.input = "Hello Research"
        vm.send()
        try await waitUntil("send reaches selected agent") { await transport.sentKeys == [selectedKey] }
        try await waitUntil("send settles") { await MainActor.run { !vm.isSending } }

        #expect(await vm.startNewSession())
        #expect(await transport.createdKeys.count == 1)
        #expect(vm.sessionKey.hasPrefix("agent:research:"))
    }

    @Test(arguments: ["main", "global"])
    func `alias draft survives agent navigation and canonical return`(alias: String) async {
        let contract = alias == "global" ? "global|main|main" : "per-agent|main|main"
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog(contract: contract))])
        let fixture = AgentNavigationFixture(transport: transport, sessionKey: alias, routingContract: contract)
        defer { fixture.close() }
        let vm = fixture.viewModel
        await vm.refreshAgents()
        vm.input = "Unsent assistant draft"
        vm.switchAgent(to: "main")
        #expect(vm.input == "Unsent assistant draft")
        vm.switchAgent(to: "research")
        #expect(vm.input.isEmpty)
        vm.input = "Unsent research draft"
        vm.switchAgent(to: "main")
        #expect(vm.input == "Unsent assistant draft")
        vm.switchAgent(to: "research")
        #expect(vm.input == "Unsent research draft")
    }

    @Test(arguments: ["per-agent|inbox|main", "global|inbox|main"])
    func `deleting a selected agent thread returns to that agents primary conversation`(contract: String) async throws {
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog(contract: contract))])
        let fixture = AgentNavigationFixture(
            transport: transport,
            sessionKey: "agent:research:topic",
            routingContract: contract)
        defer { fixture.close() }
        let vm = fixture.viewModel
        let mainKey = contract.hasPrefix("global|") ? "global" : "inbox"

        vm.deleteSession("agent:research:topic")

        try await waitUntil("selected agent primary opens") {
            await MainActor.run { vm.sessionKey == "agent:research:\(mainKey)" }
        }
        #expect(vm.selectedAgentID == "research")
    }

    @Test func `accepted alias send does not restore a duplicate draft after navigation`() async throws {
        let sendGate = AgentNavigationGate()
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog())], sendGate: sendGate)
        let fixture = AgentNavigationFixture(transport: transport)
        defer { fixture.close() }
        let vm = fixture.viewModel
        await vm.refreshAgents()
        vm.input = "Send once"
        vm.send()
        try await waitUntil("alias send starts") { await transport.sentKeys == ["main"] }
        vm.switchAgent(to: "research")
        vm.syncActiveAgentId("replacement-default")
        await sendGate.release()
        try await waitUntil("alias send settles") { await MainActor.run { !vm.isSending } }
        vm.switchAgent(to: "main")
        #expect(vm.input.isEmpty)
        #expect(vm.recallPreviousInput(caretOnFirstLine: true))
        #expect(vm.input == "Send once")
    }

    @Test func `agent selection preserves an attachment owned by the current chat`() async {
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog())])
        let fixture = AgentNavigationFixture(transport: transport)
        defer { fixture.close() }
        let vm = fixture.viewModel
        await vm.refreshAgents()
        vm.attachments = [.init(url: nil, data: Data([1]), fileName: "draft.png", mimeType: "image/png", preview: nil)]
        vm.switchAgent(to: "research")
        #expect(vm.sessionKey == "main")
        #expect(vm.selectedAgentID == "main")
        #expect(vm.attachments.count == 1)
        #expect(vm.errorText != nil)
    }

    @Test(arguments: [false, true])
    func `reconnect discards a previous route catalog response`(replacement: Bool) async throws {
        let gate = AgentNavigationGate()
        let updated = OpenClawChatAgentsListResponse(defaultId: "new", agents: [.init(id: "new")])
        let transport = AgentNavigationTransport(
            catalogs: [.success(self.catalog()), .success(updated)],
            catalogGate: gate)
        let fixture = AgentNavigationFixture(transport: transport)
        defer { fixture.close() }
        let vm = fixture.viewModel
        let first = Task { await vm.refreshAgents() }
        try await waitUntil("first catalog starts") { await transport.catalogRequests == 1 }
        if replacement {
            vm.handleTransportEvent(.routeChanged)
        } else {
            vm.handleTransportEvent(.health(ok: false))
            vm.handleTransportEvent(.health(ok: true))
        }
        try await waitUntil("replacement catalog arrives") {
            await MainActor.run { vm.agentChoices.map(\.id) == ["new"] }
        }
        await gate.release()
        await first.value
        #expect(vm.agentChoices.map(\.id) == ["new"])
        #expect(!vm.isLoadingAgents)
        #expect(vm.agentsErrorText == nil)
    }

    @Test func `catalog retry clears errors and an empty authoritative roster removes old choices`() async {
        let transport = AgentNavigationTransport(catalogs: [
            .failure(.offline), .success(self.catalog()), .success(nil),
        ])
        let fixture = AgentNavigationFixture(transport: transport)
        defer { fixture.close() }
        let vm = fixture.viewModel
        await vm.refreshAgents()
        #expect(vm.agentsErrorText != nil)
        #expect(!vm.isLoadingAgents)
        await vm.refreshAgents()
        #expect(vm.agentsErrorText == nil)
        #expect(vm.agentChoices.count == 2)
        await vm.refreshAgents()
        #expect(vm.agentChoices.isEmpty)
    }
}
