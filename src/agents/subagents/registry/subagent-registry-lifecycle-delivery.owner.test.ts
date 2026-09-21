import { describe, expect, it } from "vitest";
import { loadPendingFinalDeliveryPayload } from "./subagent-registry-lifecycle-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

describe("subagent completion owner payload", () => {
  it("carries the validated requester and child owners into durable announcement payloads", () => {
    const entry = {
      runId: "run-owned",
      childSessionKey: "agent:research:subagent:child",
      agentId: "research",
      requesterSessionKey: "owned-parent",
      requesterAgentId: "main",
      requesterDisplayKey: "owned-parent",
      task: "complete work",
      cleanup: "keep",
      createdAt: 1,
      execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
    } as SubagentRunRecord;

    expect(loadPendingFinalDeliveryPayload(entry)).toMatchObject({
      childAgentId: "research",
      childSessionKey: entry.childSessionKey,
      requesterAgentId: "main",
      requesterSessionKey: "owned-parent",
    });
  });
});
