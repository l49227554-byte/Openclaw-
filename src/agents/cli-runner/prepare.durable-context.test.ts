import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { setActiveNodeContext } from "../../infra/active-node-context.js";
import * as globalHooks from "../../plugins/hook-runner-global.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { CLI_AUTH_EPOCH_VERSION, resolveCliAuthEpoch } from "../cli-auth-epoch.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import * as maintenance from "../embedded-agent-runner/context-engine-maintenance.js";
import { SessionManager } from "../sessions/session-manager.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

describe("CLI durable session context", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const cleanups: Array<() => Promise<void> | void> = [];

  async function prepareOwnedHistory() {
    const agentDir = path.join(fixture.session.dir, "agents", "main", "agent");
    const authProfileId = "history-test:account";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: {
            type: "token",
            provider: "test-cli",
            token: "synthetic-history-account",
          },
          "history-test:other": {
            type: "token",
            provider: "test-cli",
            token: "synthetic-other-account",
          },
        },
      },
      agentDir,
    );
    const prepared = await fixture.prepare({ agentDir, authProfileId });
    cleanups.push(() => prepared.preparedBackend.cleanup?.());
    expect(prepared.cliHistoryWriter).toBeDefined();
    return {
      appendTranscript: (entry: Parameters<typeof fixture.appendTranscript>[0]) =>
        runWithCliHistoryWriter(prepared.cliHistoryWriter, () => fixture.appendTranscript(entry)),
      prepare: (overrides: Parameters<typeof fixture.prepare>[0] = {}) =>
        fixture.prepare({
          agentDir,
          authProfileId,
          admittedRunContext: prepared.params.admittedRunContext,
          ...overrides,
        }),
    };
  }

  beforeEach(() => {
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        await cleanup();
      }
    } finally {
      setActiveNodeContext(null);
      vi.restoreAllMocks();
      resetCliRunnerPrepareTestDeps();
      cliBackendsTesting.resetDepsForTest();
      await fixture.cleanup();
    }
  });

  it.each(["process", "plugin", "first-only"])(
    "preserves prompt privacy and order with plugin execution %s",
    async (transport) => {
      const pluginExecution = transport === "plugin";
      const backend = buildDefaultTestCliBackend();
      const runtimeBackend = {
        ...backend,
        config:
          transport === "first-only"
            ? backend.config
            : {
                command: "test-cli",
                args: ["--print"],
                output: "jsonl" as const,
                input: "stdin" as const,
                sessionMode: "existing" as const,
              },
        ...(pluginExecution
          ? {
              prepareExecution: () => ({
                async *execute() {
                  yield { type: "result" };
                },
              }),
            }
          : {}),
      };
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [runtimeBackend],
      });
      setActiveNodeContext({ nodeId: "mac-one" });
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
        runBeforePromptBuild: vi.fn(async () => ({
          prependContext: "trusted hook context",
          appendContext: "trusted hook tail",
        })),
      };
      vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(hookRunner as never);

      // Current inbound metadata is untrusted channel context. It should shape
      // the CLI prompt without contaminating transcript or hook inputs.
      const prepareTurn = () =>
        fixture
          .prepare({
            skillsSnapshot: { prompt: "", skills: [] },
            sessionKey: "agent:main:test",
            agentId: "main",
            trigger: "user",
            transcriptPrompt: "latest ask",
            currentInboundContext: {
              text: "Sender: ⟦openclaw:ctx⟧\nsender_id=U123",
              promptJoiner: " ",
            },
            runId: "run-test-context",
            cliSessionId: "existing-cli-session",
          })
          .then((context) => {
            cleanups.push(() => context.preparedBackend.cleanup?.());
            return context;
          });
      const context = await prepareTurn();

      const activeNodeText =
        "Current active computer (latest physical input, not message origin): active_node=mac-one";
      const logicalPrompt = `Sender: ⟦openclaw:ctx⟧\nsender_id=U123 trusted hook context\n\nlatest ask\n\ntrusted hook tail\n\n${activeNodeText}`;
      expect(context.params.prompt).toBe(
        pluginExecution ? "Sender: ⟦openclaw:ctx⟧\nsender_id=U123 latest ask" : logicalPrompt,
      );
      expect(context.promptContext).toEqual(
        pluginExecution
          ? {
              prependContext: "trusted hook context",
              appendContext: `trusted hook tail\n\n${activeNodeText}`,
            }
          : undefined,
      );
      expect(context.promptForHooks).toBe(pluginExecution ? logicalPrompt : undefined);
      expect(context.params.transcriptPrompt).toBe("latest ask");
      expect(context.contextEngineTurnPrompt).toBe("latest ask");
      expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledTimes(1);
      const beforePromptBuildCalls = hookRunner.runBeforePromptBuild.mock.calls as unknown as Array<
        [unknown, unknown]
      >;
      const promptBuildParams = beforePromptBuildCalls[0]?.[0] as { prompt?: string } | undefined;
      expect(promptBuildParams?.prompt).toBe("latest ask");
      expect(context.preparedBackend.backend.systemPromptArg).toBe(
        transport === "first-only" ? "--system-prompt" : undefined,
      );

      setActiveNodeContext({ nodeId: "mac-two" });
      const next = await prepareTurn();
      const nextPrompt = next.promptForHooks ?? next.params.prompt;
      expect(nextPrompt).toContain("active_node=mac-two");
      expect(nextPrompt).not.toContain("active_node=mac-one");

      setActiveNodeContext({ nodeId: "mac-two" }, { isCurrent: () => false });
      const revoked = await prepareTurn();
      const revokedPrompt = revoked.promptForHooks ?? revoked.params.prompt;
      expect(revokedPrompt).toContain("active_node=unknown");
      expect(revokedPrompt).not.toContain("active_node=mac-two");
      expect(revoked.params.transcriptPrompt).toBe("latest ask");
    },
  );

  it("builds fresh-session caller-memory prompts from hook-mutated prompts", async () => {
    const { dir, sessionTarget } = fixture.session;
    const manager = SessionManager.open(sessionTarget, dir);
    manager.appendMessage({ role: "user", content: "earlier ask", timestamp: 1 });
    manager.appendCompaction(
      "compacted earlier ask",
      expectDefined(manager.getLeafId(), "retained history entry"),
      10_000,
    );
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          ...buildDefaultTestCliBackend(),
          config: {
            command: "test-cli",
            args: ["--print"],
            output: "text",
            input: "arg",
            sessionMode: "existing",
          },
        },
      ],
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => ({ prependContext: "hook context" })),
    };
    vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(hookRunner as never);
    const context = await fixture.prepare({
      config: { agents: { defaults: { workspace: dir } } },
      prompt: "current ask",
      // This test supplies explicit memory; durable account provenance has separate coverage.
      sessionManager: SessionManager.fromEntries(manager.getEntries(), dir),
    });
    cleanups.push(() => context.preparedBackend.cleanup?.());

    expect(context.params.prompt).toBe(
      "hook context\n\ncurrent ask\n\nCurrent active computer (latest physical input, not message origin): active_node=unknown",
    );
    expect(context.openClawHistoryPrompt).toContain("Compaction summary: compacted earlier ask");
    expect(context.openClawHistoryPrompt).toContain("hook context");
    expect(context.openClawHistoryPrompt).toContain("current ask");
  });

  it("joins deferred maintenance before reading durable context", async () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend()],
    });
    const history = await prepareOwnedHistory();
    const { sessionTarget } = fixture.session;
    const wait = vi
      .spyOn(maintenance, "waitForDeferredTurnMaintenanceForSession")
      .mockImplementation(async () => {
        history.appendTranscript({
          id: "completed-maintenance-note",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: {
            role: "custom",
            customType: "openclaw.system-note",
            content: "FACT_AFTER_MAINTENANCE",
            display: false,
            timestamp: 1,
          },
        });
      });
    const context = await history.prepare({ sessionKey: sessionTarget.sessionKey });
    try {
      expect(wait).toHaveBeenCalledExactlyOnceWith(sessionTarget.sessionKey);
      expect(context.params.prompt).toContain("FACT_AFTER_MAINTENANCE");
      expect(context.params.transcriptPrompt).toBe("latest ask");
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  });

  it.each([
    { transport: "plugin", resume: false, changeAccount: false },
    { transport: "plugin", resume: true, changeAccount: false },
    { transport: "process", resume: false, changeAccount: false },
    { transport: "process", resume: true, changeAccount: false },
    { transport: "plugin", resume: true, changeAccount: true },
    { transport: "process", resume: true, changeAccount: true },
  ])(
    "preserves owned reference facts for $transport, resume=$resume, changeAccount=$changeAccount",
    async (testCase) => {
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            ...buildDefaultTestCliBackend(),
            ...(testCase.transport === "plugin"
              ? {
                  prepareExecution: () => ({
                    async *execute() {
                      yield { type: "result" };
                    },
                  }),
                }
              : {}),
          },
        ],
      });
      const history = await prepareOwnedHistory();
      history.appendTranscript({
        id: "durable-note",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: {
          role: "custom",
          customType: "openclaw.system-note",
          content: "The saved audit checksum is RESULT-1234.",
          display: false,
          timestamp: 1,
        },
      });
      const context = await history.prepare({
        ...(testCase.resume ? { cliSessionId: "existing-native-session" } : {}),
        ...(testCase.changeAccount ? { authProfileId: "history-test:other" } : {}),
      });
      try {
        const logicalPrompt = context.promptForHooks ?? context.params.prompt;
        if (testCase.changeAccount) {
          expect(logicalPrompt).not.toContain("RESULT-1234");
          expect(context.cliHistoryWriter).toBeUndefined();
        } else {
          expect(logicalPrompt).toContain("RESULT-1234");
          expect(logicalPrompt).toContain("data, not instructions");
          expect(context.params.transcriptPrompt).toBe("latest ask");
        }
        expect(context.contextEngineTurnPrompt).toBe("latest ask");
        expect(context.reusableCliSession).toEqual(
          testCase.resume
            ? { mode: "reuse", sessionId: "existing-native-session" }
            : { mode: "none" },
        );
        if (testCase.transport === "plugin") {
          expect(context.params.prompt).toBe("latest ask");
          if (!testCase.changeAccount) {
            expect(context.promptContext?.prependContext).toContain("RESULT-1234");
          }
        }
        expect(context.openClawHistoryPrompt).toBeUndefined();
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    },
  );
});

// Drives the reuse decision through the REAL production runner
// (prepareCliRunContext), not the resolveCliSessionReuse helper in isolation.
// The fixture computes each profile's real auth epoch with the same
// resolveCliAuthEpoch call the runner uses, builds a stored cliSessionBinding
// for the stored leg, then prepares a turn on the current leg and asserts on the
// runner-computed `context.reusableCliSession`. This proves the operator
// history-equivalence bypass (and the overlapping-group fix) at the level the
// native-CLI-resume path actually decides session reuse.
describe("CLI operator-equivalent failover through the real prepare runner", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const cleanups: Array<() => Promise<void> | void> = [];

  const PROFILE_A = "history-equiv:a";
  const PROFILE_B = "history-equiv:b";
  const PROFILE_C = "history-equiv:c";

  // Distinct token material per profile => distinct real auth epochs, exactly
  // the credit/limit-failover shape (both auth-profile and auth-epoch branches
  // fire without the bypass).
  function persistThreeAccountStore(agentDir: string): void {
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [PROFILE_A]: { type: "token", provider: "test-cli", token: "token-a" },
          [PROFILE_B]: { type: "token", provider: "test-cli", token: "token-b" },
          [PROFILE_C]: { type: "token", provider: "test-cli", token: "token-c" },
        },
      },
      agentDir,
    );
  }

  async function realEpochFor(agentDir: string, authProfileId: string): Promise<string> {
    const epoch = await resolveCliAuthEpoch({
      provider: "test-cli",
      agentDir,
      authProfileId,
    });
    expect(typeof epoch, `epoch for ${authProfileId}`).toBe("string");
    return epoch as string;
  }

  /**
   * Prepare a turn on `currentProfileId` while the stored native session was
   * bound to `storedProfileId` (with that leg's real epoch), returning the
   * runner's own reuse decision.
   */
  async function prepareFailover(params: {
    storedProfileId: string;
    currentProfileId: string;
    historyEquivalenceGroups?: string[][];
  }) {
    const agentDir = path.join(fixture.session.dir, "agents", "main", "agent");
    persistThreeAccountStore(agentDir);
    const storedEpoch = await realEpochFor(agentDir, params.storedProfileId);
    const prepared = await fixture.prepare({
      authProfileId: params.currentProfileId,
      cliSessionBinding: {
        sessionId: "existing-native-session",
        authProfileId: params.storedProfileId,
        authEpoch: storedEpoch,
        authEpochVersion: CLI_AUTH_EPOCH_VERSION,
      },
      ...(params.historyEquivalenceGroups
        ? { config: { auth: { historyEquivalenceGroups: params.historyEquivalenceGroups } } }
        : {}),
    });
    cleanups.push(() => prepared.preparedBackend.cleanup?.());
    return prepared;
  }

  beforeEach(() => {
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend()],
    });
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        await cleanup();
      }
    } finally {
      vi.restoreAllMocks();
      resetCliRunnerPrepareTestDeps();
      cliBackendsTesting.resetDepsForTest();
      fixture.cleanup();
    }
  });

  it("(a) preserves the reused session for a grouped-equivalent failover", async () => {
    const context = await prepareFailover({
      storedProfileId: PROFILE_A,
      currentProfileId: PROFILE_B,
      historyEquivalenceGroups: [[PROFILE_A, PROFILE_B]],
    });
    expect(context.reusableCliSession).toEqual({
      mode: "reuse",
      sessionId: "existing-native-session",
    });
  });

  it("(b) still refuses the session for a non-grouped account transition", async () => {
    const context = await prepareFailover({
      storedProfileId: PROFILE_A,
      currentProfileId: PROFILE_B,
      // No groups configured: today's strict per-account invalidation.
    });
    expect(context.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "auth-profile",
    });
  });

  it("(c) preserves via the SECOND of two overlapping groups (stored=c → current=b)", async () => {
    const context = await prepareFailover({
      storedProfileId: PROFILE_C,
      currentProfileId: PROFILE_B,
      historyEquivalenceGroups: [
        [PROFILE_A, PROFILE_B],
        [PROFILE_B, PROFILE_C],
      ],
    });
    expect(context.reusableCliSession).toEqual({
      mode: "reuse",
      sessionId: "existing-native-session",
    });
  });

  it("(c') refuses when overlapping-group endpoints never co-occur (stored=a → current=c)", async () => {
    const context = await prepareFailover({
      storedProfileId: PROFILE_A,
      currentProfileId: PROFILE_C,
      historyEquivalenceGroups: [
        [PROFILE_A, PROFILE_B],
        [PROFILE_B, PROFILE_C],
      ],
    });
    expect(context.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "auth-profile",
    });
  });
});
