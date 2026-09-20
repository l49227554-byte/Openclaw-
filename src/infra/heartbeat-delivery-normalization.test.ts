import { describe, expect, it } from "vitest";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "../agents/failover/user-copy.js";
import { classifyHeartbeatAgentOutcome } from "./heartbeat-delivery-normalization.js";

describe("classifyHeartbeatAgentOutcome (#153543)", () => {
  it("does not rewrite generic failure to heartbeat failure copy for exec completions", () => {
    const outcome = classifyHeartbeatAgentOutcome({
      agentRun: {
        agentRunFailed: true,
        replyPayload: { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT },
      },
      hasRelayableExecCompletion: true,
      suppressUnmarkedSourceReplies: false,
      responsePrefix: undefined,
      ackMaxChars: 300,
    });

    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.normalized.text).toBe(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
      expect(outcome.normalized.text).not.toBe(HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT);
    }
  });

  it("does not rewrite generic failure to heartbeat failure copy for cron events", () => {
    const outcome = classifyHeartbeatAgentOutcome({
      agentRun: {
        agentRunFailed: true,
        replyPayload: { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT },
      },
      hasRelayableExecCompletion: false,
      hasCronEvents: true,
      suppressUnmarkedSourceReplies: false,
      responsePrefix: undefined,
      ackMaxChars: 300,
    });

    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.normalized.text).toBe(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
      expect(outcome.normalized.text).not.toBe(HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT);
    }
  });

  it("rewrites generic failure to heartbeat failure copy for heartbeat turns", () => {
    const outcome = classifyHeartbeatAgentOutcome({
      agentRun: {
        agentRunFailed: true,
        replyPayload: { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT },
      },
      hasRelayableExecCompletion: false,
      hasCronEvents: false,
      suppressUnmarkedSourceReplies: false,
      responsePrefix: undefined,
      ackMaxChars: 300,
    });

    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.normalized.text).toBe(HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT);
    }
  });
});
