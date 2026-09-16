// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resetToolStream, resetToolStreamRun } from "./tool-stream-state.ts";
import { agentEvent, createHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

function thinking(runId: string, seq: number, text: string, delta = text) {
  return agentEvent(runId, seq, "thinking", { text, delta });
}

describe("reasoning stream", () => {
  it("accumulates the cumulative text of the open block for the active run", () => {
    const host = createHost({ chatRunId: "run-1" });
    expect(handleAgentEvent(host, thinking("run-1", 1, "Let me", "Let me"))).toBe(true);
    expect(handleAgentEvent(host, thinking("run-1", 2, "Let me check", " check"))).toBe(true);
    expect(host.chatReasoningSegments).toEqual([
      { runId: "run-1", text: "Let me check", ts: expect.any(Number), seq: 2 },
    ]);
  });

  it("starts a new block when the cumulative text restarts", () => {
    const host = createHost({ chatRunId: "run-1" });
    handleAgentEvent(host, thinking("run-1", 1, "First block"));
    handleAgentEvent(host, thinking("run-1", 2, "Second", "Second"));
    handleAgentEvent(host, thinking("run-1", 3, "Second block", " block"));
    expect(host.chatReasoningSegments?.map(({ text, settled }) => ({ text, settled }))).toEqual([
      { text: "First block", settled: true },
      { text: "Second block", settled: undefined },
    ]);
  });

  it("grows the open block from delta-only frames and ignores stale snapshots", () => {
    const host = createHost({ chatRunId: "run-1" });
    handleAgentEvent(host, thinking("run-1", 1, "Plan the"));
    handleAgentEvent(host, agentEvent("run-1", 2, "thinking", { delta: " edit" }));
    expect(host.chatReasoningSegments?.[0]?.text).toBe("Plan the edit");
    // A shorter cumulative frame with a lower sequence is a stale replay.
    handleAgentEvent(host, thinking("run-1", 1, "Plan"));
    expect(host.chatReasoningSegments?.[0]?.text).toBe("Plan the edit");
    // A shorter cumulative frame with a newer sequence is a coalesced prefix.
    handleAgentEvent(host, thinking("run-1", 3, "Plan the"));
    expect(host.chatReasoningSegments?.map(({ text }) => text)).toEqual(["Plan the edit"]);
  });

  it("ignores reasoning for runs this pane is not driving", () => {
    const host = createHost({ chatRunId: "run-1" });
    expect(handleAgentEvent(host, thinking("run-2", 1, "Other run"))).toBe(true);
    expect(host.chatReasoningSegments).toEqual([]);
    const idle = createHost({ chatRunId: null });
    handleAgentEvent(idle, thinking("run-1", 1, "No active run"));
    expect(idle.chatReasoningSegments).toEqual([]);
  });

  it("drops blank frames without opening a block", () => {
    const host = createHost({ chatRunId: "run-1" });
    handleAgentEvent(host, thinking("run-1", 1, "  \n"));
    expect(host.chatReasoningSegments).toEqual([]);
  });

  it("settles open blocks when the run lifecycle ends", () => {
    const host = createHost({ chatRunId: "run-1" });
    handleAgentEvent(host, thinking("run-1", 1, "Almost done"));
    handleAgentEvent(host, agentEvent("run-1", 2, "lifecycle", { phase: "end" }));
    expect(host.chatReasoningSegments?.[0]?.settled).toBe(true);
    // A late frame after the end starts a fresh block instead of reopening.
    handleAgentEvent(host, thinking("run-1", 3, "Almost done now", " now"));
    expect(host.chatReasoningSegments?.map(({ text }) => text)).toEqual([
      "Almost done",
      "Almost done now",
    ]);
  });

  it("resets with the tool stream, per run and entirely", () => {
    const host = createHost({ chatRunId: "run-1" });
    handleAgentEvent(host, thinking("run-1", 1, "Keep"));
    host.chatReasoningSegments = [
      ...(host.chatReasoningSegments ?? []),
      { runId: "run-0", text: "Older", ts: 1, seq: 1, settled: true },
    ];
    resetToolStreamRun(host, "run-1");
    expect(host.chatReasoningSegments?.map(({ runId }) => runId)).toEqual(["run-0"]);
    resetToolStream(host);
    expect(host.chatReasoningSegments).toEqual([]);
  });
});
