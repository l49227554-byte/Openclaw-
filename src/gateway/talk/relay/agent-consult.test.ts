import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { RealtimeVoiceAgentConsultRunner } from "../../../talk/provider-types.js";
import { bindTalkRealtimeRelayAgentConsult } from "./agent-consult.js";
import type { RelaySession } from "./state.js";

function createRunPrompt(run: () => Promise<{ text: string }>) {
  return Object.assign(vi.fn<RealtimeVoiceAgentConsultRunner>(run), {
    adoptCompletionClaims: vi.fn(),
    claimAppend: vi.fn(() => true),
    claimFailureAppend: vi.fn(() => true),
  });
}

function createRelayStub(): RelaySession {
  return {
    id: "relay-consult",
    context: { logGateway: { debug: vi.fn(), warn: vi.fn() } },
  } as unknown as RelaySession;
}

describe("bindTalkRealtimeRelayAgentConsult", () => {
  it("opens the hold before the readiness flush and keeps it for the whole consult", async () => {
    const relay = createRelayStub();
    const readiness = createDeferred();
    const runPrompt = createRunPrompt(async () => ({ text: "done" }));
    const runAgentConsult = bindTalkRealtimeRelayAgentConsult(
      runPrompt as never,
      () => relay,
      () => readiness.promise,
    );

    const run = runAgentConsult({ prompt: "what time is it" } as never);
    expect(relay.assistantTranscriptHold?.depth).toBe(1);
    expect(runPrompt).not.toHaveBeenCalled();
    readiness.resolve();
    await expect(run).resolves.toEqual({ text: "done" });
    await vi.waitFor(() => expect(relay.assistantTranscriptHold).toBeUndefined());
  });

  it("holds assistant transcript appends for the whole consult and releases them once it settles", async () => {
    const relay = createRelayStub();
    let resolveRun!: (value: { text: string }) => void;
    const pendingRun = new Promise<{ text: string }>((resolve) => {
      resolveRun = resolve;
    });
    const runAgentConsult = bindTalkRealtimeRelayAgentConsult(
      createRunPrompt(() => pendingRun) as never,
      () => relay,
      async () => {},
    );

    const run = runAgentConsult({ prompt: "what is on my calendar" } as never);
    await vi.waitFor(() => expect(relay.assistantTranscriptHold?.depth).toBe(1));
    resolveRun({ text: "done" });
    await expect(run).resolves.toEqual({ text: "done" });
    await vi.waitFor(() => expect(relay.assistantTranscriptHold).toBeUndefined());
  });

  it("releases the hold when the consult fails", async () => {
    const relay = createRelayStub();
    const runAgentConsult = bindTalkRealtimeRelayAgentConsult(
      createRunPrompt(async () => {
        throw new Error("consult failed");
      }) as never,
      () => relay,
      async () => {},
    );

    await expect(runAgentConsult({ prompt: "again" } as never)).rejects.toThrow("consult failed");
    await vi.waitFor(() => expect(relay.assistantTranscriptHold).toBeUndefined());
  });

  it("does not run a consult once the relay is gone", async () => {
    const runPrompt = createRunPrompt(async () => ({ text: "done" }));
    const runAgentConsult = bindTalkRealtimeRelayAgentConsult(
      runPrompt as never,
      () => undefined,
      async () => {},
    );

    await expect(runAgentConsult({ prompt: "hi" } as never)).rejects.toThrow(
      "Realtime gateway-relay session is closed",
    );
    expect(runPrompt).not.toHaveBeenCalled();
  });
});
