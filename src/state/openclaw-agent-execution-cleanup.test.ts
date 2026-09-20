import { afterEach, expect, it, vi } from "vitest";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerCleanupOperations } from "./openclaw-state-worker-contract.js";

const edge = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  repairs: [] as Array<{ phase: string; error: unknown }>,
  forbidden: vi.fn((): never => {
    throw new Error("Cleanup schema proof crossed a native database or Worker boundary");
  }),
}));

// The non-isolated CI shard may have cached the production cleanup module first.
// Register runtime mocks after invalidating that shared module graph.
vi.resetModules();
vi.doMock("node:sqlite", () => ({ DatabaseSync: edge.forbidden }));
vi.doMock("node:worker_threads", () => ({ Worker: edge.forbidden }));
vi.doMock("../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/shared-state.worker.js"),
}));
vi.doMock("../infra/sqlite-worker-identity.js", () => ({
  readDatabasePathIdentity: async (canonicalPath: string) => ({
    key: "file:synthetic-state",
    canonicalPath,
  }),
}));
vi.doMock("../infra/sqlite-worker-store.js", () => ({
  openSharedStateSqliteWorkerStore: async (
    options: { databasePath: string },
    context: SqliteWorkerStateContext,
  ) => {
    runWithSqliteWorkerStateContext(context, () =>
      inspectRepairPolicy("open", options.databasePath),
    );
    const store: SqliteWorkerStore<OpenClawStateWorkerCleanupOperations> = {
      async execute(command) {
        inspectRepairPolicy("cleanup", command.input.sharedStatePath);
      },
      close: edge.close,
    };
    return store;
  },
  runSqliteWorkerStoreOperation: async (
    store: SqliteWorkerStore<OpenClawStateWorkerCleanupOperations>,
    operation: (scope: SqliteWorkerStore<OpenClawStateWorkerCleanupOperations>) => Promise<void>,
    context: SqliteWorkerStateContext,
  ) => runWithSqliteWorkerStateContext(context, () => operation(store)),
}));

const { runWithSqliteWorkerStateContext } = await import("../infra/sqlite-worker-state-context.js");
const { assertOpenClawStateSchemaRepairAllowed, getExistingOpenClawStateSchemaPath } =
  await import("./openclaw-state-db-schema-policy.js");
const { cleanupRetiredAgentDatabaseLease } = await import("./openclaw-agent-execution-cleanup.js");

function inspectRepairPolicy(phase: string, databasePath: string) {
  let error: unknown;
  try {
    assertOpenClawStateSchemaRepairAllowed(databasePath);
  } catch (failure) {
    error = failure;
  }
  edge.repairs.push({ phase, error });
}

afterEach(() => {
  expect(edge.forbidden).not.toHaveBeenCalled();
  edge.repairs.length = 0;
  vi.clearAllMocks();
});

it("retains installed-schema repair ownership through retired agent lease cleanup", async () => {
  const databasePath = "/synthetic/state/openclaw.sqlite";
  const context: OpenClawStateWorkerContext = {
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    coordinatorRuntime: { directory: "/synthetic/coordinators", keepAlive: true },
    existingSchemaPath: databasePath,
    admission: {
      databasePath,
      identity: { key: "file:synthetic-state", canonicalPath: databasePath },
      assertCurrent() {},
    },
  };
  // There is no ambient schema scope for the mocked transport to inherit.
  expect(getExistingOpenClawStateSchemaPath()).toBeUndefined();
  await cleanupRetiredAgentDatabaseLease({
    context,
    stopped: Promise.resolve(),
    assertOwned() {},
    lease: {
      leaseId: "synthetic-lease",
      agentId: "main",
      path: "/synthetic/agents/main.sqlite",
      ownerPid: process.pid,
      ownerStartTime: null,
      sharedStatePath: databasePath,
      sharedStateIdentity: "file:synthetic-state",
    },
  });
  expect(edge.repairs).toEqual(
    ["open", "cleanup"].map((phase) => ({
      phase,
      error: expect.objectContaining({
        message: expect.stringContaining("schema repair is owned by the existing installation"),
      }),
    })),
  );
  expect(edge.close).toHaveBeenCalledOnce();
  expect(getExistingOpenClawStateSchemaPath()).toBeUndefined();
});
