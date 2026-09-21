import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { abortContinuationDispatchClaims } from "./continuation-dispatch-claims.js";
import {
  createContinuationOwnerSessionLoader,
  registerContinuationDelegateDispatchClaim,
} from "./delegate-spawn-authority.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  resetConfigRuntimeState();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("continuation delegate claim construction", () => {
  it("loads a non-main global owner from its resolved SQLite partition", async () => {
    await withTestDir({ prefix: "openclaw-continuation-owner-" }, async (dir) => {
      const stateDir = path.join(dir, "state");
      const storePath = path.join(dir, "shared-sessions.json");
      const sessionKey = "global-continuation-owner";
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      setRuntimeConfigSnapshot({
        agents: {
          list: [{ id: "main", default: true }, { id: "research" }],
        },
        session: { scope: "global", store: storePath },
      });
      replaceSessionEntrySync(
        {
          agentId: "research",
          defaultAgentId: "main",
          storePath,
          sessionKey,
        },
        {
          sessionId: "research-session",
          lifecycleRevision: "research-revision",
          updatedAt: 1,
        },
      );
      const researchPath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "research",
        defaultAgentId: "main",
      }).path;
      const mainPath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "main",
        defaultAgentId: "main",
      }).path;
      expect(fs.existsSync(researchPath)).toBe(true);
      expect(fs.existsSync(mainPath)).toBe(false);

      const ownerSession = createContinuationOwnerSessionLoader(sessionKey, "research");

      expect(ownerSession.agentId).toBe("research");
      expect(ownerSession.load()).toMatchObject({
        sessionId: "research-session",
        lifecycleRevision: "research-revision",
      });
      expect(fs.existsSync(mainPath)).toBe(false);
    });
  });

  it("does not register a claim when loading owner identity throws", () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const ownerSessionKey = "agent:main:owner-load-throws";

    expect(() =>
      registerContinuationDelegateDispatchClaim({
        controller: "pending",
        delegate: { task: "must not leak a claim" },
        ownerSession: {
          agentId: "main",
          load: () => {
            throw new Error("owner store unavailable");
          },
        },
        ownerSessionKey,
      }),
    ).toThrow("owner store unavailable");

    abortContinuationDispatchClaims(ownerSessionKey);
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing source owner before registering a claim", () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const ownerSessionKey = "agent:main:missing-owner";

    expect(() =>
      registerContinuationDelegateDispatchClaim({
        controller: "pending",
        delegate: { task: "must not register" },
        ownerSession: { agentId: "main", load: () => undefined },
        ownerSessionKey,
      }),
    ).toThrow("Continuation delegate source session owner is unavailable.");

    abortContinuationDispatchClaims(ownerSessionKey);
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it.each(["gateway-dispatch", "final-acceptance"] as const)(
    "rejects an owner deleted before %s",
    (boundary) => {
      const ownerSessionKey = `agent:main:deleted-${boundary}`;
      let current: { sessionId: string; lifecycleRevision: string; updatedAt: number } | undefined =
        {
          sessionId: "session-1",
          lifecycleRevision: "revision-1",
          updatedAt: 1,
        };
      const claim = registerContinuationDelegateDispatchClaim({
        controller: "pending",
        delegate: { task: "owned delegate" },
        ownerSession: { agentId: "main", load: () => current },
        ownerSessionKey,
      });
      current = undefined;

      expect(() => claim.authority.assertCurrent(boundary, null)).toThrow(
        "Continuation delegate source session lifecycle changed.",
      );
      claim.release();
    },
  );

  it("returns the persisted owner and rejects a replaced lifecycle", () => {
    const ownerSessionKey = "agent:main:owner";
    let current = {
      sessionId: "session-1",
      lifecycleRevision: "revision-1",
      updatedAt: 1,
    };
    const claim = registerContinuationDelegateDispatchClaim({
      controller: "pending",
      delegate: { task: "owned delegate" },
      ownerSession: {
        agentId: "main",
        load: () => current,
      },
      ownerSessionKey,
    });

    expect(claim.ownerAgentId).toBe("main");
    expect(() => claim.authority.assertCurrent("gateway-dispatch")).not.toThrow();
    current = {
      sessionId: "session-2",
      lifecycleRevision: "revision-2",
      updatedAt: 2,
    };
    expect(() => claim.authority.assertCurrent("registry-acceptance")).toThrow(
      "Continuation delegate source session lifecycle changed.",
    );
    claim.release();
  });
});
