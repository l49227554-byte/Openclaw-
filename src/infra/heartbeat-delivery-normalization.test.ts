import { describe, expect, it } from "vitest";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "../agents/failover/user-copy.js";
import { classifyHeartbeatAgentOutcome } from "./heartbeat-delivery-normalization.js";
import { resolveHeartbeatRunPrompt } from "./heartbeat-runner-prompt.js";

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

describe("resolveHeartbeatRunPrompt (#153543)", () => {
  it("does not admit queued generic events into scheduled task turns", () => {
    const result = resolveHeartbeatRunPrompt({
      cfg: {},
      preflight: {
        isExecEventWake: false,
        isCronWake: false,
        isWakePayload: false,
        session: {
          sessionKey: "agent:main:heartbeat",
          inspectsRunQueue: true,
          entry: undefined,
          run: { kind: "shared", sessionKey: "agent:main:heartbeat" },
          conversationEntry: undefined,
          storePath: "/tmp/store.json",
          suppressOriginatingContext: false,
        },
        pendingEventEntries: [
          {
            id: "evt-discord-1",
            ts: Date.now(),
            text: "background event from Discord",
            contextKey: "task:background-job",
            deliveryContext: {
              channel: "discord",
              to: "discord-user",
            },
          },
        ],
        turnSourceDeliveryContext: { channel: "discord", to: "discord-user" },
        hasTaggedCronEvents: false,
        shouldInspectPendingEvents: true,
        authoritativeScheduledTick: false,
      },
      canRelayToUser: true,
      startedAt: Date.now(),
      scheduledTasks: [
        {
          jobId: "job-scheduled-1",
          name: "scheduled-task",
          prompt: "run scheduled task",
        },
      ],
      useHeartbeatResponseTool: false,
    });

    expect(result.genericEvents).toEqual([]);
    expect(result.prompt).not.toContain("background event from Discord");
    expect(result.hasTaskContinuation).toBe(false);
  });
});
