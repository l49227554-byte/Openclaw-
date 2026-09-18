import { describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  spawnAcpForPlugin,
  SpawnAcpForPluginResult,
} from "../agents/subagents/spawn/acp-spawn-plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginAcpRuntimeError } from "../plugins/runtime/types-acp.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";

type IdempotencyHarness = {
  createRuntime: () => PluginRuntime["acp"];
  scoped: <T>(run: () => T, overrides?: { pluginId?: string }) => T;
  getConfig: () => OpenClawConfig;
  spawnAcpForPluginMock: Mock<typeof spawnAcpForPlugin>;
  acceptedSpawn: (overrides?: Partial<SpawnAcpForPluginResult>) => SpawnAcpForPluginResult;
  expectAcpError: (promise: Promise<unknown>, code: string) => Promise<PluginAcpRuntimeError>;
  pluginId: string;
  otherPluginId: string;
};

/** Uses the owning test file's runtime lifecycle and reset hooks without adding a test root. */
export function registerPluginAcpIdempotencyTests({
  createRuntime,
  scoped,
  getConfig,
  spawnAcpForPluginMock,
  acceptedSpawn,
  expectAcpError,
  pluginId,
  otherPluginId,
}: IdempotencyHarness): void {
  describe("plugin ACP spawn idempotency", () => {
    it("replays the accepted result for the same key and canonical input", async () => {
      const runtime = createRuntime();
      const first = await scoped(() =>
        runtime.spawn({ task: "same", idempotencyKey: "k1", label: "a" }),
      );
      const second = await scoped(() =>
        runtime.spawn({ task: "same", idempotencyKey: "k1", label: "a" }),
      );
      expect(first.replayed).toBeUndefined();
      expect(second).toEqual({ ...first, replayed: true });
      expect(spawnAcpForPluginMock).toHaveBeenCalledTimes(1);
    });

    it("does not alias a changed input under the same key", async () => {
      const runtime = createRuntime();
      spawnAcpForPluginMock
        .mockResolvedValueOnce(acceptedSpawn({ runId: "run-a" }))
        .mockResolvedValueOnce(acceptedSpawn({ runId: "run-b" }));
      const first = await scoped(() => runtime.spawn({ task: "one", idempotencyKey: "k2" }));
      const second = await scoped(() => runtime.spawn({ task: "two", idempotencyKey: "k2" }));
      expect(first.runId).toBe("run-a");
      expect(second.runId).toBe("run-b");
      expect(second.replayed).toBeUndefined();
      expect(spawnAcpForPluginMock).toHaveBeenCalledTimes(2);
    });

    it("retains the earlier receipt when the same key alternates inputs (A, B, A)", async () => {
      const runtime = createRuntime();
      let launched = 0;
      spawnAcpForPluginMock.mockImplementation(async () =>
        acceptedSpawn({ runId: `run-${++launched}` }),
      );
      const now = vi.spyOn(Date, "now");
      let clock = 1_000_000;
      now.mockImplementation(() => clock);
      const a = await scoped(() => runtime.spawn({ task: "A", idempotencyKey: "same" }));
      const b = await scoped(() => runtime.spawn({ task: "B", idempotencyKey: "same" }));
      const aAgain = await scoped(() => runtime.spawn({ task: "A", idempotencyKey: "same" }));
      const bAgain = await scoped(() => runtime.spawn({ task: "B", idempotencyKey: "same" }));
      expect(a.runId).toBe("run-1");
      expect(b.runId).toBe("run-2");
      expect(aAgain).toEqual({ ...a, replayed: true });
      expect(bAgain).toEqual({ ...b, replayed: true });
      expect(launched).toBe(2);
      // Both receipts share the existing 10 minute window and are pruned together after it.
      clock += 10 * 60_000;
      const aLater = await scoped(() => runtime.spawn({ task: "A", idempotencyKey: "same" }));
      expect(aLater.replayed).toBeUndefined();
      expect(aLater.runId).toBe("run-3");
      expect(launched).toBe(3);
    });

    it("bounds receipts per plugin and evicts the oldest tuple first", async () => {
      const runtime = createRuntime();
      let launched = 0;
      spawnAcpForPluginMock.mockImplementation(async () =>
        acceptedSpawn({ runId: `run-${++launched}` }),
      );
      const now = vi.spyOn(Date, "now");
      let clock = 1_000_000;
      now.mockImplementation(() => clock);
      const first = await scoped(() => runtime.spawn({ task: "task-0", idempotencyKey: "bound" }));
      for (let index = 1; index < 200; index += 1) {
        clock += 1;
        await scoped(() => runtime.spawn({ task: `task-${index}`, idempotencyKey: "bound" }));
      }
      expect(launched).toBe(200);
      // The 201st distinct tuple evicts the oldest receipt (task-0) and nothing else.
      clock += 1;
      await scoped(() => runtime.spawn({ task: "task-200", idempotencyKey: "bound" }));
      expect(launched).toBe(201);
      const replayLatest = await scoped(() =>
        runtime.spawn({ task: "task-199", idempotencyKey: "bound" }),
      );
      expect(replayLatest.replayed).toBe(true);
      const relaunchOldest = await scoped(() =>
        runtime.spawn({ task: "task-0", idempotencyKey: "bound" }),
      );
      expect(relaunchOldest.replayed).toBeUndefined();
      expect(relaunchOldest.runId).not.toBe(first.runId);
      expect(launched).toBe(202);
    });

    it("rejects unique requests at pending capacity while retaining expired pending replays", async () => {
      const runtime = createRuntime();
      const gate = createDeferred<SpawnAcpForPluginResult>();
      let started = createDeferred();
      spawnAcpForPluginMock.mockImplementation(() => {
        started.resolve();
        return gate.promise;
      });
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const spawn = (taskText: string) =>
        scoped(() => runtime.spawn({ task: taskText, idempotencyKey: "bound" }));
      const pending: Array<ReturnType<typeof spawn>> = [];
      for (let index = 0; index < 200; index += 1) {
        started = createDeferred();
        pending.push(spawn(`pending-${index}`));
        await started.promise;
      }
      // Pending work must keep its receipt even beyond the completed-receipt TTL.
      now.mockReturnValue(1_000_000 + 10 * 60_000);
      const replay = spawn("pending-0");
      const overflow = spawn("overflow").catch((error: unknown) => error);
      const overflowAgain = spawn("overflow-again").catch((error: unknown) => error);
      gate.resolve(acceptedSpawn());
      await Promise.all(pending);
      for (const result of await Promise.all([overflow, overflowAgain])) {
        expect(result).toBeInstanceOf(PluginAcpRuntimeError);
        expect(result).toMatchObject({ code: "ACP_PLUGIN_ADMISSION_REJECTED" });
      }
      expect(spawnAcpForPluginMock).toHaveBeenCalledTimes(200);
      expect(await replay).toMatchObject({ runId: "run-1", replayed: true });
      await spawn("after-settlement");
      expect(spawnAcpForPluginMock).toHaveBeenCalledTimes(201);
    });

    it("evicts settled receipts under pressure without evicting older pending work", async () => {
      const runtime = createRuntime();
      const gate = createDeferred<SpawnAcpForPluginResult>();
      const started = createDeferred();
      spawnAcpForPluginMock.mockImplementation(async (input: { task: string }) => {
        started.resolve();
        return input.task === "pending" ? await gate.promise : acceptedSpawn({ runId: input.task });
      });
      let clock = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => clock++);
      const spawn = (taskText: string) =>
        scoped(() => runtime.spawn({ task: taskText, idempotencyKey: "bound" }));
      const pending = spawn("pending");
      await started.promise;
      let replay: ReturnType<typeof spawn> | undefined;
      try {
        for (let index = 0; index < 200; index += 1) {
          await spawn(`settled-${index}`);
        }
        expect(await spawn("settled-199")).toMatchObject({ replayed: true });
        expect(await spawn("settled-0")).not.toHaveProperty("replayed");
        replay = spawn("pending");
        expect(spawnAcpForPluginMock).toHaveBeenCalledTimes(202);
      } finally {
        gate.resolve(acceptedSpawn({ runId: "pending-run" }));
        await pending;
        await replay;
      }
      expect(await replay).toMatchObject({ runId: "pending-run", replayed: true });
    });

    it("scopes replay to the calling plugin", async () => {
      const runtime = createRuntime();
      getConfig().plugins = {
        entries: {
          [pluginId]: { acp: { allowDetachedSpawn: true } },
          [otherPluginId]: { acp: { allowDetachedSpawn: true } },
        },
      };
      await scoped(() => runtime.spawn({ task: "same", idempotencyKey: "k3" }));
      await scoped(() => runtime.spawn({ task: "same", idempotencyKey: "k3" }), {
        pluginId: otherPluginId,
      });
      expect(spawnAcpForPluginMock).toHaveBeenCalledTimes(2);
    });

    it("evicts failed admission or launch so the next attempt runs again", async () => {
      const runtime = createRuntime();
      spawnAcpForPluginMock.mockResolvedValueOnce({
        status: "forbidden",
        errorCode: "subagent_policy",
        error: "too many",
      } as SpawnAcpForPluginResult);
      await expectAcpError(
        scoped(() => runtime.spawn({ task: "x", idempotencyKey: "k4" })),
        "ACP_PLUGIN_ADMISSION_REJECTED",
      );
      const retry = await scoped(() => runtime.spawn({ task: "x", idempotencyKey: "k4" }));
      expect(retry.replayed).toBeUndefined();
      expect(spawnAcpForPluginMock).toHaveBeenCalledTimes(2);
    });
  });
}
