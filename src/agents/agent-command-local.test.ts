import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runLocalAgentCommand } from "./agent-command-local.js";
import {
  bindActiveOperatorTurnAuthority,
  type CronCreatorAuthorityCapability,
} from "./cron-creator-authority-context.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  resolveDeps: vi.fn(async () => ({})),
}));

vi.mock("./command/prepare.js", () => ({
  prepareAgentCommandExecution: mocks.prepare,
}));

vi.mock("./command/runtime-loaders.js", () => ({
  resolveAgentCommandDeps: mocks.resolveDeps,
}));

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "local-command-authority" });
});
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearActivePluginRegistry();
  await state.cleanup();
});

function createPrepared(senderIsOwner: boolean) {
  return {
    cfg: {},
    opts: { runId: "run-local", senderIsOwner },
    runId: "run-local",
    sessionAgentId: "main",
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
  };
}

describe("runLocalAgentCommand operator authority", () => {
  it("binds local authority to the exact admitted operator run and revokes it at settlement", async () => {
    mocks.prepare.mockResolvedValueOnce(createPrepared(true));
    let retained: ReturnType<typeof bindActiveOperatorTurnAuthority>;
    let capability: CronCreatorAuthorityCapability | undefined;

    await runLocalAgentCommand({
      opts: { message: "test", runId: "run-local" },
      runtime: {} as RuntimeEnv,
      operatorAuthority: true,
      run: async (prepared) => {
        capability = prepared.opts.cronCreatorAuthorityCapability;
        retained = bindActiveOperatorTurnAuthority(prepared.runId);
        expect(capability?.callerOrigin).toEqual({ kind: "local" });
        expect(retained?.source).toBe("local");
      },
    });

    expect(() => retained?.assertActive()).toThrow();
    expect(capability?.active).toBe(false);
  });

  it("does not mint local authority for a non-owner or system run", async () => {
    for (const testCase of [
      { operatorAuthority: true, senderIsOwner: false },
      { operatorAuthority: false, senderIsOwner: true },
    ]) {
      mocks.prepare.mockResolvedValueOnce(createPrepared(testCase.senderIsOwner));
      await runLocalAgentCommand({
        opts: { message: "test", runId: "run-local" },
        runtime: {} as RuntimeEnv,
        operatorAuthority: testCase.operatorAuthority,
        run: async (prepared) => {
          expect(prepared.opts.cronCreatorAuthorityCapability).toBeUndefined();
          expect(bindActiveOperatorTurnAuthority(prepared.runId)).toBeUndefined();
        },
      });
    }
  });
});

it("keeps runtime memory registrations through local command preparation", async () => {
  const registry = createEmptyPluginRegistry();
  const pluginId = "memory-fixture";
  registry.plugins.push(createPluginRecord({ id: pluginId }));
  const supplement = { search: async () => [], get: async () => null };
  const prepare = async () => ["prepared memory"];
  const builder = () => ["memory guidance"];
  registry.memoryCorpusSupplements.push({ pluginId, supplement });
  registry.memoryPromptPreparations.push({ pluginId, prepare });
  registry.memoryPromptSupplements.push({ pluginId, builder });
  setActivePluginRegistry(registry, undefined, "default", state.workspaceDir);
  mocks.prepare.mockResolvedValueOnce({
    ...createPrepared(false),
    cfg: { plugins: { entries: { [pluginId]: { enabled: true } } } },
  });
  await runLocalAgentCommand({
    opts: { message: "test", runId: "local-memory" },
    runtime: {} as RuntimeEnv,
    run: async () => {
      const captured = getPluginRuntimeGenerationRegistry();
      expect(captured?.memoryCorpusSupplements).toContainEqual({ pluginId, supplement });
      expect(captured?.memoryPromptPreparations).toContainEqual({ pluginId, prepare });
      expect(captured?.memoryPromptSupplements).toContainEqual({ pluginId, builder });
    },
  });
});
