import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { createDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { createAttemptSetupFixture } from "../embedded-agent-runner/run/attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "../embedded-agent-runner/run/attempt-tool-prepare.js";
import { AuthStorage, ModelRegistry } from "../sessions/index.js";

/** Deterministic model boundary; admission, tool policy, and filesystem tools are real. */
export async function executeRecoveryToolEffects(
  params: Record<string, unknown>,
  workspaceDir: string,
) {
  const config: OpenClawConfig = {
    plugins: { enabled: false },
    tools: { allow: ["read", "write"] },
    agents: { defaults: { workspace: workspaceDir } },
  };
  const runId = String(params.idempotencyKey);
  const admission = prepareSystemAgentRunAdmission(config, runId, "main", "restart-recovery-test");
  const authStorage = AuthStorage.inMemory();
  try {
    const prepared = await prepareEmbeddedAttemptToolBase({
      agentDir: path.join(workspaceDir, "agent"),
      attempt: {
        admittedRunContext: await admission.admit("embedded"),
        config,
        runId,
        sessionId: String(params.sessionId),
        sessionKey: String(params.sessionKey),
        sessionFile: path.join(workspaceDir, "recovery.jsonl"),
        workspaceDir,
        prompt: String(params.message),
        timeoutMs: 10_000,
        forceRestartSafeTools: params.forceRestartSafeTools === true,
        toolsAllow: ["read", "write"],
        oneShotCliRun: true,
        provider: "openai",
        modelId: "recovery-test",
        model: {
          id: "recovery-test",
          name: "Recovery test",
          provider: "openai",
          api: "openai-completions",
          baseUrl: "https://example.invalid",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
        },
        authStorage,
        authProfileStore: { version: 1, profiles: {} },
        modelRegistry: ModelRegistry.inMemory(authStorage),
        thinkLevel: "off",
      },
      setup: createAttemptSetupFixture({
        effectiveCwd: workspaceDir,
        effectiveWorkspace: workspaceDir,
        resolvedWorkspace: workspaceDir,
        sessionPermissionRoot: workspaceDir,
        sandboxSessionKey: String(params.sessionKey),
      }),
      markCoreToolStage: () => {},
      onYield: async () => {},
      runAbortController: new AbortController(),
      runTrace: createDiagnosticTraceContext(),
      skillUsagePaths: undefined,
      skillsSnapshot: undefined,
      codeModeSkills: [],
      toolSearchCatalogExecutor: async () => {
        throw new Error("unexpected catalog execution");
      },
    });
    try {
      const read = prepared.toolsRaw.find((tool) => tool.name === "read");
      if (!read) {
        throw new Error("safe read tool missing");
      }
      const readResult = await read.execute("safe-read", {
        path: path.join(workspaceDir, "safe.txt"),
      });
      // Try the same concrete mutation in restricted and unrestricted turns. The
      // unrestricted control proves the command reaches a functioning file sink.
      const write = prepared.toolsRaw.find((tool) => tool.name === "write");
      await write?.execute("forbidden-write", {
        path: path.join(workspaceDir, "effect.txt"),
        content: "mutation reached the filesystem",
      });
      return { readResult, toolNames: prepared.toolsRaw.map((tool) => tool.name) };
    } finally {
      await Promise.all(prepared.runCleanups.map((cleanup) => cleanup("complete")));
    }
  } finally {
    admission.close();
  }
}
