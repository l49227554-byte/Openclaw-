import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentRuntimeApprovalAuthorityValidator,
  mintAgentRuntimeIdentityToken,
} from "../../gateway/agent-runtime-identity-token.js";
import { validateAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  closeAdmittedRunDelegatedAuthority,
  getAdmittedRunDelegatedAuthority,
} from "../admitted-run-context.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import {
  invokeNativeHookRelay,
  registerNativeHookRelay,
  registerOwnedNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
  testing,
} from "./native-hook-relay.js";

function readTestNativeAgentId(rawPayload: unknown): string | undefined {
  if (!isRecord(rawPayload) || typeof rawPayload.agent_id !== "string") {
    return undefined;
  }
  return rawPayload.agent_id.trim() || undefined;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await testing.clearNativeHookRelaysForTests();
});

describe("native hook execution admission", () => {
  it("rejects a bound pre-tool policy result after exact host authority closes", async () => {
    let active = true;
    const admitExecution = vi.fn();
    let resolvePolicy:
      | ((value: { blocked: false; params: Record<string, unknown> }) => void)
      | undefined;
    const runBeforeToolCall = vi.fn(
      () =>
        new Promise<{ blocked: false; params: Record<string, unknown> }>((resolve) => {
          resolvePolicy = resolve;
        }),
    );
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId: "codex-bound-authority-close",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall,
      executionAdmission: { toolNames: ["exec"], admit: admitExecution },
      assertActive: () => {
        if (!active) {
          throw new Error("agent harness host capability is no longer active");
        }
      },
    });
    const invocation = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        openclaw_approval_mode: "report",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-close-1",
        tool_input: { command: "git status" },
      },
    });
    await vi.waitFor(() => expect(runBeforeToolCall).toHaveBeenCalledTimes(1));
    active = false;
    resolvePolicy?.({ blocked: false, params: { command: "git status" } });

    await expect(invocation).rejects.toThrow("agent harness host capability is no longer active");
    expect(admitExecution).not.toHaveBeenCalled();
    expect(runBeforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: "defer",
        nativeOperation: { cwd: "/repo" },
      }),
    );
  });

  it("keeps only a claimed flat native child after foreground cleanup", async () => {
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId: "run-retained-child",
    });
    const delegatedAuthority = getAdmittedRunDelegatedAuthority(admittedRunContext);
    if (!delegatedAuthority) {
      throw new Error("Expected admitted delegated authority");
    }
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const approvalRequester = vi.fn(async () => "allow" as const);
    const admitExecution = vi.fn();
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);
    let retainChild = true;
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId: "codex-retained-direct-child",
      sessionId: "session-1",
      runId: "run-retained-child",
      allowedEvents: ["pre_tool_use", "permission_request", "post_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      executionAdmission: { toolNames: ["exec"], admit: admitExecution },
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => retainChild,
        allowPreToolUse: (claim) => claim === "child-thread",
        onDispose: () => {},
      },
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: { tool_name: "Bash", tool_input: { command: "true" } },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    const permission = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        agent_id: "child-thread",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "true" },
      },
    });
    expect(JSON.parse(permission.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(approvalRequester).toHaveBeenCalledOnce();

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "post_tool_use",
        rawPayload: {
          agent_id: "child-thread",
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "true" },
          tool_response: { output: "ok" },
          tool_use_id: "child-post-tool",
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(afterToolCall).toHaveBeenCalledOnce();

    expect(closeAdmittedRunDelegatedAuthority(admittedRunContext)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(delegatedAuthority)).toBe(false);
    await expect(
      mintAgentRuntimeIdentityToken({
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: admittedRunContext.operationalRunInstance,
      }),
    ).rejects.toThrow("requires active delegated run authority");
    expect(
      createAgentRuntimeApprovalAuthorityValidator()({
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: admittedRunContext.operationalRunInstance,
        delegatedAuthority: { kind: "local", ...delegatedAuthority },
      }),
    ).toBe(false);
    relay.unregister();
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          agent_id: "child-thread",
          tool_name: "Bash",
          tool_input: { command: "true" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          agent_id: "child-thread",
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "true" },
        },
      }),
    ).rejects.toThrow("foreground invocation not allowed");
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "post_tool_use",
        rawPayload: {
          agent_id: "child-thread",
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "true" },
          tool_response: { output: "ok" },
          tool_use_id: "child-post-tool-after-close",
        },
      }),
    ).rejects.toThrow("foreground invocation not allowed");
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          agent_id: "unknown-child",
          tool_name: "Bash",
          tool_input: { command: "true" },
        },
      }),
    ).rejects.toThrow("retained invocation not allowed");
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          agent: { agent_id: "child-thread" },
          tool_name: "Bash",
          tool_input: { command: "true" },
        },
      }),
    ).rejects.toThrow("foreground invocation not allowed");

    expect(admitExecution).toHaveBeenCalledTimes(2);
    expect(admitExecution).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rawPayload: expect.objectContaining({ agent_id: "child-thread" }),
      }),
      expect.any(Function),
    );
    retainChild = false;
    relay.unregister();
  });

  it.each(["owned", "public"] as const)(
    "records native execution custody only through the bundled owner (%s)",
    async (registration) => {
      const admit = vi.fn();
      const params = {
        provider: "codex" as const,
        sessionId: "openclaw-session",
        runId: "execution-admission",
        executionAdmission: { toolNames: ["exec_command"], admit },
      };
      const relay =
        registration === "owned"
          ? registerOwnedNativeHookRelay(params)
          : registerNativeHookRelay(params);
      expect(relay.shouldRelayEvent("pre_tool_use")).toBe(registration === "owned");
      expect(relay.toolMatcherForEvent("pre_tool_use")).toEqual(
        registration === "owned" ? ["exec"] : undefined,
      );
      const rawPayload = {
        session_id: "native-root",
        turn_id: "native-turn",
        tool_use_id: "native-call",
        tool_name: "Bash",
        tool_input: { command: "true" },
      };
      await expect(
        invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "pre_tool_use",
          rawPayload,
        }),
      ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
      if (registration === "owned") {
        expect(admit).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            sessionId: "openclaw-session",
            turnId: "native-turn",
            toolUseId: "native-call",
            rawPayload,
          }),
          expect.any(Function),
        );
      } else {
        expect(admit).not.toHaveBeenCalled();
      }
      admit.mockClear();
      await invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: { ...rawPayload, tool_name: "apply_patch" },
      });
      expect(admit).not.toHaveBeenCalled();
    },
  );

  it.each(["scoped policy", "all tools", "loop detection"] as const)(
    "unions execution custody with existing pre-tool work (%s)",
    (work) => {
      if (work !== "loop detection") {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_tool_call",
              handler: vi.fn(),
              ...(work === "scoped policy" ? { matcher: ["apply_patch"] } : {}),
            },
          ]),
        );
      }
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "execution-admission",
        sessionKey: "agent:main:execution-admission",
        runId: "execution-admission",
        ...(work === "loop detection"
          ? { config: { tools: { loopDetection: { enabled: true } } } }
          : {}),
        executionAdmission: { toolNames: ["exec"], admit: vi.fn() },
      });
      expect(relay.shouldRelayEvent("pre_tool_use")).toBe(true);
      expect(relay.toolMatcherForEvent("pre_tool_use")).toEqual(
        work === "scoped policy" ? ["apply_patch", "exec"] : undefined,
      );
    },
  );

  it.each(["blocked", "rewritten", "failed"] as const)(
    "does not retain execution custody for a %s policy result",
    async (result) => {
      const admit = vi.fn();
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "execution-admission",
        runId: "execution-admission",
        executionAdmission: { toolNames: ["exec"], admit },
        runBeforeToolCall: async () => {
          if (result === "failed") {
            throw new Error("fixture policy failed");
          }
          return result === "blocked"
            ? { blocked: true, kind: "veto", reason: "fixture policy blocked" }
            : { blocked: false, params: { command: "rewritten" } };
        },
      });
      const invocation = invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: { tool_name: "Bash", tool_use_id: "call", tool_input: { command: "true" } },
      });
      if (result === "failed") {
        await expect(invocation).rejects.toThrow("fixture policy failed");
      } else {
        const response = await invocation;
        expect(JSON.parse(response.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
      }
      expect(admit).not.toHaveBeenCalled();
    },
  );

  it.each(["accepted", "failed", "retired"] as const)(
    "preserves deferred approval when execution custody is %s",
    async (result) => {
      const onResolution = vi.fn();
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "execution-admission",
        runId: "execution-admission",
        runBeforeToolCall: async () => ({
          blocked: false,
          params: { command: "true" },
          deferredApproval: {
            approval: { title: "fixture", description: "fixture", onResolution },
            toolName: "exec",
            baseParams: { command: "true" },
          },
        }),
        executionAdmission: {
          toolNames: ["exec"],
          admit: () => {
            if (result === "failed") {
              throw new Error("execution custody unavailable");
            }
            if (result === "retired") {
              relay.unregister();
            }
          },
        },
      });
      const invocation = invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          tool_name: "Bash",
          tool_use_id: "call",
          tool_input: { command: "true" },
          openclaw_approval_mode: "report",
        },
      });
      if (result === "accepted") {
        await expect(invocation).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
        expect(onResolution).not.toHaveBeenCalled();
        relay.unregister();
      } else {
        await expect(invocation).rejects.toThrow(
          result === "failed" ? "execution custody unavailable" : /inactive|foreground/,
        );
      }
      expect(onResolution).toHaveBeenCalledExactlyOnceWith("cancelled");
      await expect(
        resolveNativeHookRelayDeferredToolApproval({ relayId: relay.relayId, toolUseId: "call" }),
      ).resolves.toBeUndefined();
    },
  );
});
