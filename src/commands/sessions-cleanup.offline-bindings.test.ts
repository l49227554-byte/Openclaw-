import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { createAccountScopedConversationBindingManager } from "../infra/outbound/account-scoped-conversation-bindings.js";
import { listCurrentConversationBindingRecordsBySession } from "../infra/outbound/current-conversation-bindings.js";
import { getSessionBindingService, testing } from "../infra/outbound/session-binding-service.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const fixture = vi.hoisted(() => ({ cfg: {} as OpenClawConfig, callGateway: vi.fn() }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => fixture.cfg,
}));
vi.mock("../gateway/call.js", async () => ({
  ...(await vi.importActual<typeof import("../gateway/transport-error.js")>(
    "../gateway/transport-error.js",
  )),
  callGateway: fixture.callGateway,
}));

import { sessionsCleanupCommand } from "./sessions-cleanup.js";

const key = "agent:main:offline-missing";
const stateKey = Symbol.for("openclaw.test.offline-cleanup-bindings");

describe("offline CLI cleanup binding ownership", () => {
  it.each(
    (["explicit-store", "gateway-unavailable", "dry-run", "custom-store"] as const).flatMap(
      (route) => [true, false].map((enforce) => ({ route, enforce })),
    ),
  )(
    "preserves persisted routes without a registered manager: $route (enforce=$enforce)",
    async ({ route, enforce }) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        fixture.cfg = {
          agents: { ownership: "explicit", entries: { main: {} } },
          plugins: { enabled: false },
          session: {
            maintenance: {
              mode: "warn",
              maxDiskBytes: false,
              archiveDashboardAfter: false,
              pruneAfter: "365d",
            },
          },
        };
        await state.writeConfig(fixture.cfg);
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        replaceSessionEntrySync(
          { storePath, sessionKey: key },
          { sessionId: "offline-missing", updatedAt: Date.now() },
        );
        const manager = createAccountScopedConversationBindingManager({
          channel: "teamchat",
          cfg: fixture.cfg,
          stateKey,
          toStoredTargetKind: (kind) => kind,
          toSessionBindingTargetKind: (kind) => kind,
        });
        const service = getSessionBindingService();
        const binding = await service.bind({
          targetSessionKey: key,
          targetKind: "session",
          metadata: { agentId: "main" },
          conversation: {
            channel: "teamchat",
            accountId: "default",
            conversationId: "persisted-route",
          },
        });
        manager.stop();
        setActivePluginRegistry(createTestRegistry([]));
        expect(service.getCapabilities(binding.conversation).adapterAvailable).toBe(false);
        expect(
          listCurrentConversationBindingRecordsBySession(key, binding.conversation),
        ).toContainEqual(binding);
        const logs: string[] = [];
        const runtime = {
          log: (value: unknown) => logs.push(String(value)),
          error: (value: unknown) => logs.push(String(value)),
          exit: () => {},
        };
        fixture.callGateway.mockReset();
        fixture.callGateway.mockRejectedValue(
          new GatewayTransportError({
            kind: "closed",
            message: "test gateway unavailable",
            connectionDetails: { url: "ws://127.0.0.1:1", urlSource: "test", message: "test" },
          }),
        );
        const custom = state.statePath("custom.json");
        if (route === "custom-store") {
          replaceSessionEntrySync(
            { storePath: custom, sessionKey: key, agentId: "main" },
            { sessionId: "custom-missing", updatedAt: Date.now() },
          );
        }
        try {
          const run = sessionsCleanupCommand(
            {
              agent: "main",
              enforce,
              fixMissing: true,
              json: true,
              ...(route === "gateway-unavailable"
                ? {}
                : { store: route === "custom-store" ? custom : storePath }),
              ...(route === "dry-run" ? { dryRun: true } : {}),
            },
            runtime,
          );
          if (route === "explicit-store" || route === "gateway-unavailable") {
            await expect(run).rejects.toThrow(/offline.*binding.*Gateway/i);
          } else {
            await run;
          }
          expect(loadSessionEntry({ storePath, sessionKey: key })?.sessionId).toBe(
            "offline-missing",
          );
          expect(
            listCurrentConversationBindingRecordsBySession(key, binding.conversation),
          ).toContainEqual(binding);
          if (route === "custom-store") {
            expect(
              loadSessionEntry({ storePath: custom, sessionKey: key, agentId: "main" }),
            ).toBeUndefined();
          }
          expect(fixture.callGateway).toHaveBeenCalledTimes(
            route === "gateway-unavailable" ? 1 : 0,
          );
        } finally {
          manager.stop();
          testing.resetSessionBindingAdaptersForTests();
          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabaseForTest();
          setActivePluginRegistry(createTestRegistry([]));
          process.exitCode = undefined;
        }
      });
    },
  );
});
