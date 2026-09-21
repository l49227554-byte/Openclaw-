/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { CronCompactJob, CronJobsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import {
  createSidebarAttentionStore,
  type SidebarAttentionStore,
} from "../app/sidebar-attention-store.ts";
import { captureChatOutboxAdmission } from "../lib/chat/outbox-store.ts";
import {
  admitStoredChatComposerQueueItem,
  removeStoredChatComposerQueueItem,
} from "../pages/chat/composer-persistence.ts";
import { hiddenScopeUpgradeCapability } from "../test-helpers/application-context.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { sidebarInboxTabCounts } from "./sidebar-attention-entries.ts";
import { SidebarAttentionStoreController } from "./sidebar-attention-store.ts";

type CompactCronPage = CronJobsListResult<CronCompactJob>;
function cronPage(id?: string): CompactCronPage {
  const jobs = id
    ? [
        {
          id,
          name: id,
          enabled: true,
          updatedAtMs: 0,
          scheduleKind: "every" as const,
          nextRunAt: null,
          nextRunAtMs: null,
          lastRunAt: null,
          lastRunAtMs: null,
          lastRunError: null,
          lastRunStatus: "error" as const,
        },
      ]
    : [];
  return {
    jobs,
    snapshotRevision: id ?? "empty",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

let store: SidebarAttentionStore | undefined;
afterEach(() => {
  store?.dispose();
  store = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createStore(
  gateway: ApplicationContext["gateway"],
  connectionBootstrap?: ApplicationContext["connectionBootstrap"],
) {
  const agentSelection = {
    state: { selectedId: "main", scopeId: null },
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["agentSelection"];
  return createSidebarAttentionStore({
    gateway,
    agentSelection,
    agents: {
      state: { agentsList: null },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["agents"],
    overlays: {
      snapshot: { approvalQueue: [] },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["overlays"],
    scopeUpgrade: hiddenScopeUpgradeCapability,
    connectionBootstrap,
  });
}

it("keeps only nondismissable local incidents available offline and observes canonical removal", async () => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  const request = vi.fn(async (method: string) =>
    method === "cron.list"
      ? cronPage("failed-job")
      : method === "cron.status"
        ? { enabled: true, jobs: 1 }
        : { ts: 1, providers: [] },
  );
  const client = mockClient(request);
  Object.defineProperties(client, {
    recoveryScope: { value: "owner-a" },
    recoveryScopeReady: { value: true },
  });
  const harness = createGatewayHarness(client);
  const host = {
    client,
    connected: true,
    settings: harness.gateway.connection,
    sessionKey: "agent:main:review",
  };
  const row = {
    id: "local-review",
    text: "private submission",
    createdAt: 1,
    sendState: "unconfirmed" as const,
    sendRunId: "run-review",
  };
  expect(
    admitStoredChatComposerQueueItem(host, captureChatOutboxAdmission(host, host.sessionKey), row),
  ).toBe(true);
  store = createStore(harness.gateway);
  store.activate(SidebarAttentionStoreController);
  await waitForFast(() =>
    expect(store?.entries.map((entry) => entry.type)).toEqual(["outbox", "attention"]),
  );
  expect(sidebarInboxTabCounts(store.entries)).toMatchObject({
    all: 2,
    system: 1,
    automations: 1,
  });
  expect(store.entries[0]?.dismissal).toBeNull();
  expect(JSON.stringify(store.entries[0])).not.toContain("private submission");
  harness.update({ phase: "reconnecting", hello: null });
  const calls = request.mock.calls.length;
  expect(store.entries.map((entry) => entry.type)).toEqual(["outbox"]);
  expect(sidebarInboxTabCounts(store.entries)).toMatchObject({
    all: 1,
    system: 1,
    automations: 0,
  });
  expect(removeStoredChatComposerQueueItem(host, host.sessionKey, row.id, row)).toBe(true);
  expect(store.entries).toEqual([]);
  expect(request.mock.calls).toHaveLength(calls);
});
