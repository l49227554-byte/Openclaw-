import { describe, expect, it } from "vitest";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "../agents/failover/user-copy.js";
import { classifyHeartbeatAgentOutcome } from "./heartbeat-delivery-normalization.js";
import {
  resolveHeartbeatRunPrompt,
  resolveHeartbeatTurnEventSelection,
  type HeartbeatPreflight,
} from "./heartbeat-runner-prompt.js";

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
  it("selects one route cohort and excludes foreign queued content", () => {
    const preflight: HeartbeatPreflight = {
      isExecEventWake: true,
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
          id: "exec-a",
          ts: 1,
          text: "exec finished: route-a",
          contextKey: "exec:a",
          deliveryContext: { channel: "discord", to: "conversation-a" },
        },
        {
          id: "task-b",
          ts: 2,
          text: "private task content from conversation B",
          contextKey: "task:b",
          deliveryContext: { channel: "feishu", to: "user:b" },
        },
      ],
      turnSourceDeliveryContext: { channel: "feishu", to: "user:b" },
      hasTaggedCronEvents: false,
      shouldInspectPendingEvents: true,
      authoritativeScheduledTick: false,
    };

    const eventSelection = resolveHeartbeatTurnEventSelection({
      preflight,
      scheduledTasks: [],
    });
    expect(eventSelection.turnSourceDeliveryContext).toMatchObject({
      channel: "discord",
      to: "conversation-a",
    });
    expect(eventSelection.execEvents.map((event) => event.id)).toEqual(["exec-a"]);
    expect(eventSelection.genericEvents).toEqual([]);

    const result = resolveHeartbeatRunPrompt({
      cfg: {},
      preflight,
      canRelayToUser: true,
      startedAt: 3,
      scheduledTasks: [],
      useHeartbeatResponseTool: false,
      eventSelection,
    });
    expect(result.genericEvents).toEqual([]);
    expect(result.prompt).not.toContain("private task content from conversation B");
  });

  it("admits route-compatible generic events alongside the selected exec cohort", () => {
    const preflight: HeartbeatPreflight = {
      isExecEventWake: true,
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
          id: "exec-a",
          ts: 1,
          text: "exec finished: route-a",
          contextKey: "exec:a",
          deliveryContext: { channel: "discord", to: "conversation-a" },
        },
        {
          id: "generic-same-route",
          ts: 2,
          text: "Gateway restart ok: queued notification",
          contextKey: "task:same-route",
          deliveryContext: { channel: "discord", to: "conversation-a" },
        },
        {
          id: "generic-unrouted",
          ts: 3,
          text: "Gateway restart ok: no route of its own",
          contextKey: "task:unrouted",
        },
        {
          id: "generic-foreign",
          ts: 4,
          text: "private task content from conversation B",
          contextKey: "task:b",
          deliveryContext: { channel: "feishu", to: "user:b" },
        },
      ],
      turnSourceDeliveryContext: { channel: "feishu", to: "user:b" },
      hasTaggedCronEvents: false,
      shouldInspectPendingEvents: true,
      authoritativeScheduledTick: false,
    };

    const eventSelection = resolveHeartbeatTurnEventSelection({
      preflight,
      scheduledTasks: [],
    });

    // Same-route and unrouted content rides along; conversation B stays queued.
    expect(eventSelection.genericEvents.map((event) => event.id)).toEqual([
      "generic-same-route",
      "generic-unrouted",
    ]);
    expect(eventSelection.turnSourceDeliveryContext).toMatchObject({
      channel: "discord",
      to: "conversation-a",
    });

    const result = resolveHeartbeatRunPrompt({
      cfg: {},
      preflight,
      canRelayToUser: true,
      startedAt: 5,
      scheduledTasks: [],
      useHeartbeatResponseTool: false,
      eventSelection,
    });
    expect(result.genericEvents.map((event) => event.id)).toEqual([
      "generic-same-route",
      "generic-unrouted",
    ]);
    expect(result.prompt).not.toContain("private task content from conversation B");
  });

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
