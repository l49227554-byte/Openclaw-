import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountScopedConversationBindingManager } from "../../infra/outbound/account-scoped-conversation-bindings.js";
import {
  listCurrentConversationBindingRecordsBySession,
  resolveCurrentConversationBindingRecord,
  updateCurrentConversationBindingRecord,
} from "../../infra/outbound/current-conversation-bindings.js";
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
  testing,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionEntry } from "./types.js";

const race = vi.hoisted(() => ({
  beforeCommit: undefined as (() => void) | undefined,
  afterCommit: undefined as (() => Promise<void> | void) | undefined,
  publicationError: undefined as Error | undefined,
}));

// Interleave at real archive boundaries; SQLite planning and commit remain real.
vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      const result = await actual.materializeSessionStateDeletePlans(...args);
      const hook = race.beforeCommit;
      race.beforeCommit = undefined;
      hook?.();
      return result;
    },
  };
});
vi.mock("./session-accessor.sqlite-archive-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-accessor.sqlite-archive-store.js")>();
  return {
    ...actual,
    publishSessionStateArchives: async (
      ...args: Parameters<typeof actual.publishSessionStateArchives>
    ) => {
      const hook = race.afterCommit;
      race.afterCommit = undefined;
      await hook?.();
      if (race.publicationError) {
        throw race.publicationError;
      }
      return await actual.publishSessionStateArchives(...args);
    },
  };
});

import { runSessionsCleanup } from "./cleanup-service.js";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";

const managerStateKey = Symbol.for("openclaw.test.cleanup-bindings");
const service = getSessionBindingService();
const key = "agent:main:missing";

afterEach(() => {
  race.beforeCommit = undefined;
  race.afterCommit = undefined;
  race.publicationError = undefined;
});

async function withFixture(
  run: (fixture: {
    state: OpenClawTestState;
    cfg: OpenClawConfig;
    storePath: string;
    seed: (sessionKey: string, extra?: Partial<SessionEntry>) => void;
    bind: (sessionKey: string) => Promise<SessionBindingRecord[]>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, beta: {} } },
      session: {
        maintenance: {
          mode: "warn",
          maxDiskBytes: false,
          archiveDashboardAfter: false,
          pruneAfter: "365d",
        },
      },
    };
    await state.writeConfig(cfg);
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: {
            id: "workspace",
            meta: { aliases: [] },
            conversationBindings: { supportsCurrentConversationBinding: true },
          },
        },
        {
          pluginId: "teamchat",
          source: "test",
          plugin: {
            id: "teamchat",
            meta: { aliases: [] },
            conversationBindings: {
              supportsCurrentConversationBinding: true,
              bindingStore: "adapter",
            },
          },
        },
      ]),
    );
    const manager = createAccountScopedConversationBindingManager({
      channel: "teamchat",
      cfg,
      stateKey: managerStateKey,
      toStoredTargetKind: (kind) => kind,
      toSessionBindingTargetKind: (kind) => kind,
    });
    const seed = (sessionKey: string, extra: Partial<SessionEntry> = {}) => {
      const entry = { sessionId: `id-${sessionKey}`, updatedAt: Date.now(), ...extra };
      replaceSessionEntrySync({ sessionKey, storePath }, entry);
      appendTranscriptEventSync(
        { sessionKey, sessionId: entry.sessionId, storePath },
        { type: "proof", content: "recoverable metadata" },
      );
    };
    const bind = async (sessionKey: string) =>
      Promise.all(
        ["workspace", "teamchat"].map((channel) =>
          service.bind({
            targetSessionKey: sessionKey,
            targetKind: "session",
            metadata: { agentId: "main" },
            conversation: { channel, accountId: "default", conversationId: sessionKey },
          }),
        ),
      );
    try {
      await run({ state, cfg, storePath, seed, bind });
    } finally {
      manager.stop();
      testing.resetSessionBindingAdaptersForTests();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      setActivePluginRegistry(createTestRegistry([]));
    }
  });
}

describe("missing-session cleanup binding ownership", () => {
  it("removes committed missing-entry bindings from real registered and generic SQLite owners", async () => {
    await withFixture(async ({ cfg, storePath, seed, bind }) => {
      seed(key);
      await bind(key);
      const result = await runSessionsCleanup({
        cfg,
        opts: { agent: "main", enforce: true, fixMissing: true },
      });
      expect(result.appliedSummaries[0]?.missing).toBe(1);
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      expect(loadSessionEntry({ storePath, sessionKey: key })).toBeUndefined();
      expect(service.listBySession(key)).toEqual([]);
    });
  });

  it.each([
    { dryRun: true, enforce: true, fixMissing: true },
    { enforce: false, fixMissing: false },
    { enforce: true, fixMissing: false },
  ])("preserves bindings when cleanup does not remove entries: %j", async (opts) => {
    await withFixture(async ({ cfg, storePath, seed, bind }) => {
      seed(key);
      const before = await bind(key);
      await runSessionsCleanup({ cfg, opts: { agent: "main", ...opts } });
      expect(loadSessionEntry({ storePath, sessionKey: key })).toBeDefined();
      expect(service.listBySession(key)).toEqual(expect.arrayContaining(before));
    });
  });

  it("preserves readable transcripts, shelved archives and active harness bindings", async () => {
    await withFixture(async ({ cfg, storePath, seed, bind }) => {
      for (const [suffix, extra] of [
        ["readable", {}],
        ["shelved", { archivedAt: Date.now() }],
        ["harness", { modelSelectionLocked: true }],
      ] as const) {
        const sessionKey = `agent:main:${suffix}`;
        seed(sessionKey, extra);
        await bind(sessionKey);
        if (suffix === "readable") {
          appendTranscriptMessageSync(
            { storePath, sessionKey, sessionId: `id-${sessionKey}` },
            { message: { role: "user", content: "Keep this history" } },
          );
        }
      }
      const result = await runSessionsCleanup({
        cfg,
        opts: { agent: "main", enforce: true, fixMissing: true },
      });
      expect(result.appliedSummaries[0]?.missing).toBe(0);
      for (const suffix of ["readable", "shelved", "harness"]) {
        expect(service.listBySession(`agent:main:${suffix}`)).toHaveLength(2);
      }
    });
  });

  it.each(["global", key])(
    "does not clear canonical bindings from an unrelated custom store with key %s",
    async (sessionKey) => {
      await withFixture(async ({ cfg, state, seed, bind }) => {
        seed(sessionKey);
        const before = await bind(sessionKey);
        const custom = state.statePath("custom.json");
        replaceSessionEntrySync(
          { storePath: custom, sessionKey, agentId: "main" },
          { sessionId: "custom-missing", updatedAt: Date.now() },
        );
        const result = await runSessionsCleanup({
          cfg,
          opts: { agent: "main", store: custom, enforce: true, fixMissing: true },
        });
        expect(result.appliedSummaries[0]?.missing).toBe(1);
        expect(service.listBySession(sessionKey)).toEqual(expect.arrayContaining(before));
      });
    },
  );

  it("does not clear main's bare-key bindings when pruning beta's partition", async () => {
    await withFixture(async ({ cfg, state, seed, bind }) => {
      seed("global");
      const before = await bind("global");
      const storePath = path.join(state.sessionsDir("beta"), "sessions.json");
      replaceSessionEntrySync(
        { storePath, agentId: "beta", sessionKey: "global" },
        { sessionId: "beta-missing", updatedAt: Date.now() },
      );
      await runSessionsCleanup({ cfg, opts: { agent: "beta", enforce: true, fixMissing: true } });
      expect(service.listBySession("global")).toEqual(expect.arrayContaining(before));
    });
  });

  it("keeps a replacement entry and its bindings when the expected entry changes before commit", async () => {
    await withFixture(async ({ cfg, storePath, seed, bind }) => {
      seed(key);
      const before = await bind(key);
      race.beforeCommit = () =>
        replaceSessionEntrySync(
          { storePath, sessionKey: key },
          { sessionId: "replacement", updatedAt: Date.now() },
        );
      await expect(
        runSessionsCleanup({
          cfg,
          opts: { agent: "main", enforce: true, fixMissing: true },
        }),
      ).rejects.toThrow("changed before lifecycle removal");
      expect(loadSessionEntry({ storePath, sessionKey: key })?.sessionId).toBe("replacement");
      expect(service.listBySession(key)).toEqual(expect.arrayContaining(before));
    });
  });

  it("still clears committed bindings when subsequent archive publication fails", async () => {
    await withFixture(async ({ cfg, storePath, seed, bind }) => {
      seed(key);
      await bind(key);
      race.publicationError = new Error("injected archive publication failure");
      await expect(
        runSessionsCleanup({ cfg, opts: { agent: "main", enforce: true, fixMissing: true } }),
      ).rejects.toThrow("injected archive publication failure");
      expect(loadSessionEntry({ storePath, sessionKey: key })).toBeUndefined();
      expect(service.listBySession(key)).toEqual([]);
    });
  });

  it.each(["entry", "binding"] as const)(
    "preserves a new %s created while a registered unbind awaits",
    async (replacement) => {
      await withFixture(async ({ cfg, storePath, seed, bind }) => {
        seed(key);
        const bindings = await bind(key);
        const registered = bindings.find((binding) => binding.conversation.channel === "teamchat");
        if (!registered) {
          throw new Error("expected registered binding");
        }
        const scope = registered.conversation;
        let entered = false;
        registerSessionBindingAdapter({
          channel: scope.channel,
          accountId: scope.accountId,
          supportsConditionalUnbind: true,
          listBySession: (target) => listCurrentConversationBindingRecordsBySession(target, scope),
          resolveByConversation: resolveCurrentConversationBindingRecord,
          unbind: async (input) => {
            await Promise.resolve();
            entered = true;
            if (replacement === "entry") {
              replaceSessionEntrySync(
                { storePath, sessionKey: key },
                { sessionId: "new-generation", updatedAt: Date.now() },
              );
            } else {
              updateCurrentConversationBindingRecord(scope, (current) =>
                current ? { ...current, boundAt: current.boundAt + 1 } : current,
              );
            }
            const { previous, current } = updateCurrentConversationBindingRecord(
              scope,
              (binding) =>
                binding && (!input.shouldUnbind || input.shouldUnbind(binding)) ? null : binding,
            );
            return previous && !current ? [previous] : [];
          },
        });
        await runSessionsCleanup({ cfg, opts: { agent: "main", enforce: true, fixMissing: true } });
        expect(entered).toBe(true);
        expect(service.resolveByConversation(scope)).toBeTruthy();
        if (replacement === "entry") {
          expect(loadSessionEntry({ storePath, sessionKey: key })?.sessionId).toBe(
            "new-generation",
          );
        } else {
          expect(service.resolveByConversation(scope)?.boundAt).toBe(registered.boundAt + 1);
        }
      });
    },
  );

  it("preserves real same-millisecond rebindings after the session commit", async () => {
    await withFixture(async ({ cfg, seed, bind }) => {
      seed(key);
      const before = await bind(key);
      const replacements: SessionBindingRecord[] = [];
      race.afterCommit = async () => {
        for (const binding of before) {
          const clock = vi.spyOn(Date, "now").mockReturnValue(binding.boundAt);
          try {
            replacements.push(
              await service.bind({
                targetSessionKey: key,
                targetKind: "session",
                conversation: binding.conversation,
                metadata: { agentId: "main" },
              }),
            );
          } finally {
            clock.mockRestore();
          }
        }
      };
      await runSessionsCleanup({ cfg, opts: { agent: "main", enforce: true, fixMissing: true } });
      expect(service.listBySession(key)).toHaveLength(2);
      expect(service.listBySession(key)).toEqual(expect.arrayContaining(replacements));
    });
  });

  it.each(["unguarded", "read-only", "read-only-with-marker"])(
    "reports a partial failure for a %s adapter",
    async (kind) => {
      await withFixture(async ({ cfg, seed, bind }) => {
        seed(key);
        const before = await bind(key);
        const unbind = vi.fn(async () => []);
        registerSessionBindingAdapter({
          channel: "teamchat",
          accountId: "default",
          listBySession: () =>
            before.filter((record) => record.conversation.channel === "teamchat"),
          resolveByConversation: () => before[1] ?? null,
          ...(kind === "unguarded" ? { unbind } : {}),
          supportsConditionalUnbind: kind === "read-only-with-marker",
        });
        await expect(
          runSessionsCleanup({ cfg, opts: { agent: "main", enforce: true, fixMissing: true } }),
        ).rejects.toThrow("conditional cleanup");
        expect(unbind).not.toHaveBeenCalled();
      });
    },
  );
});
