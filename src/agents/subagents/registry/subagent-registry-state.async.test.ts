import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as workerStore from "../../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForSessions,
  getSubagentRunsSnapshotForRead,
  invalidateSubagentSessionListReadCache,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk,
  withSubagentSessionListRunsSnapshotForRead,
} from "./subagent-registry-state.js";
import * as store from "./subagent-registry.store.sqlite.js";
import type { SubagentRunReadRecord, SubagentRunRecord } from "./subagent-registry.types.js";

const transport = vi.hoisted(() => ({
  execute: vi.fn<() => Promise<Map<string, SubagentRunReadRecord> | undefined>>(),
}));
vi.mock("../../../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: async (
    _context: unknown,
    operation: (worker: { execute: typeof transport.execute }) => Promise<unknown>,
  ) => operation({ execute: transport.execute }),
}));

let state: OpenClawTestState;
let memory: Map<string, SubagentRunRecord>;
let replies: ReturnType<
  typeof createDeferredCore<Map<string, SubagentRunReadRecord> | undefined>
>[];
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
  openOpenClawStateDatabase();
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
  clearSubagentRunsReadCacheForTest();
  memory = new Map();
  replies = [];
  transport.execute.mockReset().mockImplementation(() => {
    const reply = createDeferredCore<Map<string, SubagentRunReadRecord> | undefined>();
    replies.push(reply);
    return reply.promise;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearSubagentRunsReadCacheForTest();
  await state.cleanup();
});
function runs(model: string, runId = "one") {
  const run = createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    model,
    completion: { required: false },
    delivery: { status: "not_required" },
  });
  return new Map([[run.runId, run]]);
}
async function started(index: number) {
  await vi.waitFor(() => expect(replies).toHaveLength(index + 1));
  return replies[index]!;
}
function read() {
  return withSubagentSessionListRunsSnapshotForRead(
    memory,
    captureOpenClawStateWorkerContext(),
    (snapshot) => [...snapshot.values()].map((run) => run.model),
  );
}

it("coalesces a fill and projects current memory after the reply", async () => {
  const first = read();
  await started(0);
  const second = read();
  expect(replies).toHaveLength(1);
  for (const [id, run] of runs("current")) {
    memory.set(id, run);
  }
  replies[0]!.resolve(runs("old"));
  expect(await first).toEqual(["current"]);
  expect(await second).toEqual(["current"]);
});

it.each([
  "full publication",
  "named deletion",
  "failed best effort",
  "restore",
  "ownership rebind",
  "reset",
])("rejects a delayed reply across %s in the same millisecond", async (change) => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const first = read();
  await started(0);
  if (change === "full publication") {
    persistSubagentRunsToDisk(runs("current"));
  } else if (change === "named deletion") {
    persistSubagentRunsToDisk(new Map(), ["one"]);
  } else if (change === "failed best effort") {
    vi.spyOn(store, "saveSubagentRegistryToSqlite").mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    persistSubagentRunsToDisk(runs("current"));
  } else if (change === "restore") {
    store.saveSubagentRegistryToSqlite(runs("current"));
    restoreSubagentRunsFromDisk({ runs: memory });
  } else if (change === "ownership rebind") {
    invalidateSubagentSessionListReadCache();
  } else {
    clearSubagentRunsReadCacheForTest();
  }
  replies[0]!.resolve(runs("old"));
  if (["restore", "ownership rebind", "reset"].includes(change)) {
    (await started(1)).resolve(runs("current"));
  }
  expect(await first).toEqual(change === "named deletion" ? [] : ["current"]);
});

it("keeps the accepted newer fill when replies finish out of order", async () => {
  const first = read();
  await started(0);
  clearSubagentRunsReadCacheForTest();
  const second = read();
  await started(1);
  replies[1]!.resolve(runs("current"));
  expect(await second).toEqual(["current"]);
  replies[0]!.resolve(runs("old"));
  expect(await first).toEqual(["current"]);
  expect(await read()).toEqual(["current"]);
});

it("does not supersede a fill on a rolled-back strict write", async () => {
  const first = read();
  await started(0);
  vi.spyOn(store, "saveSubagentRegistryToSqlite").mockImplementationOnce(() => {
    throw new Error("write failed");
  });
  expect(() => persistSubagentRunsToDiskOrThrow(runs("uncommitted"))).toThrow("write failed");
  replies[0]!.resolve(runs("committed"));
  expect(await first).toEqual(["committed"]);
});

it.each([1600, 900])(
  "lets a waiting caller consume a slow or clock-shifted fill once (%i)",
  async (completedAt) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const first = read();
    await started(0);
    now.mockReturnValue(completedAt);
    replies[0]!.resolve(runs("first"));
    expect(await first).toEqual(["first"]);
    const second = read();
    await started(1);
    replies[1]!.resolve(runs("second"));
    expect(await second).toEqual(["second"]);
  },
);

it("does not retarget a waiting read after its database closes", async () => {
  const context = captureOpenClawStateWorkerContext();
  const first = withSubagentSessionListRunsSnapshotForRead(memory, context, (snapshot) => [
    ...snapshot.keys(),
  ]);
  await started(0);
  const rejected = expect(first).rejects.toThrow();
  await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
  replies[0]!.resolve(runs("old"));
  await rejected;
});

it.each(["read failure", "absent database"])(
  "shares the %s fallback with existing waiters and lets a later call retry",
  async (failure) => {
    const settled = createDeferredCore();
    const operation = vi
      .spyOn(workerStore, "runOpenClawStateWorkerOperation")
      .mockImplementation(async () => {
        await settled.promise;
        if (failure === "read failure") {
          throw new Error("read failed");
        }
        return undefined;
      });
    const readers = Array.from({ length: 8 }, () => read());
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    for (const [id, run] of runs("memory", "memory")) {
      memory.set(id, run);
    }
    persistSubagentRunsToDisk(
      new Map([...runs("written", "written"), ...runs("deleted", "deleted")]),
      ["written", "deleted"],
    );
    persistSubagentRunsToDisk(new Map(), ["deleted"]);
    settled.resolve();
    expect(await Promise.all(readers)).toEqual(
      Array.from({ length: 8 }, () => ["written", "memory"]),
    );
    expect(operation).toHaveBeenCalledTimes(1);
    operation.mockRestore();

    const retry = read();
    (await started(0)).resolve(runs("persisted", "persisted"));
    expect(await retry).toEqual(["persisted", "written", "memory"]);
  },
);

it.each(["reset", "ownership rebind"])("supersedes a settled fallback after %s", async (change) => {
  const first = withSubagentSessionListRunsSnapshotForRead(
    memory,
    captureOpenClawStateWorkerContext(),
    () => {
      if (change === "reset") {
        clearSubagentRunsReadCacheForTest();
      } else {
        invalidateSubagentSessionListReadCache();
      }
    },
  );
  await started(0);
  const second = read();
  replies[0]!.reject(new Error("read failed"));
  await first;
  (await started(1)).resolve(runs("current"));
  expect(await second).toEqual(["current"]);
});

it("rejects a reply after its captured maintenance scope has retired", async () => {
  const scope = createOpenClawDatabaseMaintenanceScope();
  const context = scope.run(() => captureOpenClawStateWorkerContext());
  const first = withSubagentSessionListRunsSnapshotForRead(memory, context, (snapshot) => [
    ...snapshot.keys(),
  ]);
  await started(0);
  const rejected = expect(first).rejects.toThrow("scope is closed");
  await scope.close();
  replies[0]!.resolve(runs("old"));
  await rejected;
});

it("keeps the scalar full-record cache when a compact fill publishes", async () => {
  store.saveSubagentRegistryToSqlite(runs("current"));
  const pending = read();
  await started(0);
  const scalar = getSubagentRunsSnapshotForSessions(memory, ["agent:main:main"]);
  expect(scalar.get("one")?.task).toBe("one");
  replies[0]!.resolve(new Map([["one", { ...runs("current").get("one")!, task: undefined }]]));
  await pending;
  expect(getSubagentRunsSnapshotForRead(new Map()).get("one")?.task).toBe("one");
});

it.each([false, true])(
  "settles complete fills through a stream of named writes and deletions (failed=%s)",
  async (failed) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const initial = new Map([
      ...runs("durable", "durable"),
      ...runs("old"),
      ...runs("deleted", "deleted"),
    ]);
    if (failed) {
      vi.spyOn(store, "saveSubagentRegistryChangesToSqlite").mockImplementation(() => {
        throw new Error("write failed");
      });
    }
    const first = read();
    await started(0);
    for (let index = 0; index < 8; index++) {
      persistSubagentRunsToDisk(runs(`current-${index}`), ["one"]);
      persistSubagentRunsToDisk(new Map(), ["deleted"]);
    }
    expect(replies).toHaveLength(1);
    replies[0]!.resolve(initial);
    expect(await first).toEqual(["durable", "current-7"]);
    now.mockReturnValue(1600);
    const second = read();
    await started(1);
    for (let index = 8; index < 16; index++) {
      persistSubagentRunsToDisk(runs(`current-${index}`), ["one"]);
      persistSubagentRunsToDisk(new Map(), ["deleted"]);
    }
    replies[1]!.resolve(new Map([...runs("stale"), ...runs("deleted", "deleted")]));
    expect(await second).toEqual(["durable", "current-15"]);
    expect(replies).toHaveLength(2);
  },
);

it("hydrates durable-only rows after a cold named publication", async () => {
  persistSubagentRunsToDisk(runs("current"), ["one"]);
  const pending = read();
  await started(0);
  replies[0]!.resolve(new Map([...runs("durable", "durable"), ...runs("old")]));
  expect(await pending).toEqual(["durable", "current"]);
});
