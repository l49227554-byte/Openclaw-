// Covers preserved-state agent run completions: user-facing model state stays
// preserved while completion activity still advances unread state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { deriveSessionUnread } from "../../shared/session-unread.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { updateSessionStoreAfterAgentRun } from "./session-store.js";

vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string, _cfg?: OpenClawConfig) =>
    ["claude-cli", "codex-cli", "google-gemini-cli"].includes(provider.trim().toLowerCase()),
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

async function withTempSessionStore<T>(
  run: (params: { dir: string; storePath: string }) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
  try {
    return await run({ dir, storePath: path.join(dir, "sessions.json") });
  } finally {
    closeOpenClawAgentDatabasesForTest();
    // SQLite teardown can race fixture removal on loaded CI hosts. Keep the
    // retries bounded so persistent cleanup failures still surface.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
}

async function seedSessionStore(
  storePath: string,
  entries: Record<string, SessionEntry>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await patchSessionEntryCore({ storePath, sessionKey }, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
  }
}

type SessionStoreUpdateParams = Parameters<typeof updateSessionStoreAfterAgentRun>[0];

async function runSessionStoreUpdate(
  params: Omit<SessionStoreUpdateParams, "agentDir"> & { agentDir?: string },
) {
  await updateSessionStoreAfterAgentRun({
    ...params,
    agentDir: params.agentDir ?? "/tmp/openclaw-session-store-test-agent",
  });
}

describe("preserved-state completion activity", () => {
  it("preserves user-facing run accounting while allowing session touch metadata", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        agents: {
          defaults: {},
        },
      } as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-preserve-user-facing-run-state";
      const sessionId = "test-preserve-user-facing-run-state-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          lastInteractionAt: 10,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          contextTokens: 1_000_000,
          inputTokens: 11,
          outputTokens: 22,
          totalTokens: 333,
          totalTokensFresh: true,
          cacheRead: 4,
          cacheWrite: 5,
          estimatedCostUsd: 0.25,
          abortedLastRun: false,
          cliSessionBindings: {
            "claude-cli": { sessionId: "visible-cli-session" },
          },
          compactionCount: 7,
        },
      };
      await seedSessionStore(storePath, sessionStore);
      const freshVisibleEntry: SessionEntry = {
        sessionId: "fresh-visible-session-id",
        updatedAt: 2,
        sessionStartedAt: 777,
        lastInteractionAt: 20,
        lastActivityAt: 21,
        modelProvider: "openai",
        model: "gpt-5.5",
        contextTokens: 400_000,
        inputTokens: 44,
        outputTokens: 55,
        totalTokens: 666,
        totalTokensFresh: true,
        cacheRead: 7,
        cacheWrite: 8,
        estimatedCostUsd: 0.5,
        abortedLastRun: false,
        cliSessionBindings: {
          "claude-cli": { sessionId: "new-visible-cli-session" },
        },
        compactionCount: 9,
      };
      await seedSessionStore(storePath, { [sessionKey]: freshVisibleEntry });

      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 500,
          aborted: true,
          agentMeta: {
            sessionId,
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
            contextTokens: 200_000,
            usage: {
              input: 100,
              output: 50,
              cacheRead: 10,
              cacheWrite: 20,
            },
            compactionCount: 3,
            cliSessionBinding: {
              sessionId: "handoff-cli-session",
            },
          },
        },
      };

      await runSessionStoreUpdate({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "claude-cli",
        defaultModel: "claude-sonnet-4-6",
        result,
        preserveUserFacingSessionModelState: true,
      });

      const next = sessionStore[sessionKey];
      expect(next?.sessionId).toBe("fresh-visible-session-id");
      expect(next?.sessionStartedAt).toBe(777);
      expect(next?.modelProvider).toBe("openai");
      expect(next?.model).toBe("gpt-5.5");
      expect(next?.contextTokens).toBe(400_000);
      expect(next?.inputTokens).toBe(44);
      expect(next?.outputTokens).toBe(55);
      expect(next?.totalTokens).toBe(666);
      expect(next?.totalTokensFresh).toBe(true);
      expect(next?.cacheRead).toBe(7);
      expect(next?.cacheWrite).toBe(8);
      expect(next?.estimatedCostUsd).toBe(0.5);
      expect(next?.abortedLastRun).toBe(false);
      expect(next?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe("new-visible-cli-session");
      expect(next?.compactionCount).toBe(9);
      expect(next?.lastInteractionAt).toBeGreaterThan(20);
      // Preserved user-facing state still allows completion activity to advance.
      expect(next?.lastActivityAt).toBeGreaterThan(21);
    });
  });

  it("marks a preserved-state completion as unread activity", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-preserved-completion-activity";
      const sessionId = "test-preserved-completion-activity-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          lastReadAt: 10,
        },
      };
      await seedSessionStore(storePath, sessionStore);

      await runSessionStoreUpdate({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        touchInteraction: false,
        touchActivity: true,
        preserveUserFacingSessionModelState: true,
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "openai",
              model: "gpt-5.5",
            },
          },
        },
      });

      const next = sessionStore[sessionKey];
      expect(next?.lastActivityAt).toBeGreaterThan(10);
      expect(deriveSessionUnread(next)).toBe(true);
    });
  });
});
