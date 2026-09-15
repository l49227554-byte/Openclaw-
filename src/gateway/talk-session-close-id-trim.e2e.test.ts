import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import { getTalkHandoff } from "./talk-handoff.js";
import { getUnifiedTalkSession } from "./talk-session-registry.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import {
  installGatewayTestHooks,
  testState,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const GATEWAY_TOKEN = "talk-session-close-trim-e2e-token";

describe("talk.session.close Gateway E2E", () => {
  it("closes a live managed-room Talk session when talk.session.close receives a padded sessionId", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for talk session close E2E fixtures");
    }
    testState.gatewayAuth = { mode: "token", token: GATEWAY_TOKEN };
    testState.sessionStorePath = path.join(stateDir, "sessions.sqlite");

    await withGatewayServer(async ({ port }) => {
      await writeSessionStore({
        entries: {
          "agent:main:main": {
            sessionId: "talk-session-close-trim-session",
            updatedAt: Date.now(),
          },
        },
      });
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: GATEWAY_TOKEN,
        scopes: [ADMIN_SCOPE],
        timeoutMs: 60_000,
      });
      try {
        const created = await client.request<{ sessionId?: string; handoffId?: string }>(
          "talk.session.create",
          { transport: "managed-room", sessionKey: "agent:main:main" },
        );
        const sessionId = created.sessionId;
        if (!sessionId) {
          throw new Error("talk.session.create did not return a sessionId");
        }
        expect(getUnifiedTalkSession(sessionId).kind).toBe("managed-room");
        expect(getTalkHandoff(created.handoffId ?? sessionId)).toBeDefined();

        const padded = ` ${sessionId} `;
        expect(padded).not.toBe(sessionId);
        await expect(client.request("talk.session.close", { sessionId: padded })).resolves.toEqual({
          ok: true,
        });
        expect(() => getUnifiedTalkSession(sessionId)).toThrow(/Unknown Talk session/);
        expect(getTalkHandoff(created.handoffId ?? sessionId)).toBeUndefined();
        await expect(client.request("talk.session.close", { sessionId })).rejects.toThrow(
          /Unknown Talk session/,
        );
        console.log(
          `[talk.session.close Gateway client E2E] created=true closed=true forgotten=true padded=${JSON.stringify(padded)} exact=${sessionId}`,
        );
      } finally {
        await disconnectGatewayClient(client);
      }
    });
  }, 120_000);
});
