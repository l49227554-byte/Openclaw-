import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  cleanupTalkConnection,
  forgetUnifiedTalkSession,
  getUnifiedTalkSession,
  registerTalkConnectionCleanup,
  rememberUnifiedTalkSession,
} from "./talk-session-registry.js";

describe("Talk connection cleanup registry", () => {
  it("keeps one cleanup per relay kind and fences reentrant cleanup", () => {
    const replacedRealtimeCleanup = vi.fn();
    const transcriptionCleanup = vi.fn();
    const log = { warn: vi.fn() };
    const realtimeCleanup = vi.fn(() => {
      cleanupTalkConnection("conn-dedupe", log);
    });

    registerTalkConnectionCleanup("conn-dedupe", "realtime-relay", replacedRealtimeCleanup);
    registerTalkConnectionCleanup("conn-dedupe", "realtime-relay", realtimeCleanup);
    registerTalkConnectionCleanup("conn-dedupe", "transcription-relay", transcriptionCleanup);

    cleanupTalkConnection("conn-dedupe", log);
    cleanupTalkConnection("conn-dedupe", log);

    expect(replacedRealtimeCleanup).not.toHaveBeenCalled();
    expect(realtimeCleanup).toHaveBeenCalledOnce();
    expect(realtimeCleanup.mock.contexts).toEqual([undefined]);
    expect(transcriptionCleanup).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("continues cleanup after one relay owner throws", () => {
    const cleanupError = new Error("realtime cleanup failed");
    const transcriptionCleanup = vi.fn();
    const log = { warn: vi.fn() };

    registerTalkConnectionCleanup(
      "conn-error",
      "realtime-relay",
      vi.fn().mockImplementationOnce(() => {
        throw cleanupError;
      }),
    );
    registerTalkConnectionCleanup("conn-error", "transcription-relay", transcriptionCleanup);

    cleanupTalkConnection("conn-error", log);

    expect(log.warn).toHaveBeenCalledWith(
      "failed to run realtime-relay Talk cleanup after connection disconnect: realtime cleanup failed",
    );
    expect(transcriptionCleanup).toHaveBeenCalledOnce();
    cleanupTalkConnection("conn-error", log);
  });

  it("retains failed async cleanup for shutdown retry without replacing its owner", async () => {
    const first = createDeferred();
    const finish = createDeferred();
    const log = { warn: vi.fn() };
    const queued = createDeferred();
    const queuedStarted = createDeferred();
    const replacement = vi.fn(() => {
      queuedStarted.resolve();
      return queued.promise;
    });
    const cleanup = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => finish.promise);
    registerTalkConnectionCleanup("conn-async-retry", "browser-control", cleanup);
    cleanupTalkConnection("conn-async-retry", log);
    cleanupTalkConnection("conn-async-retry", log);
    expect(cleanup).toHaveBeenCalledOnce();
    const firstObserved = first.promise.catch(() => undefined);
    first.reject(new Error("physical cleanup failed"));
    await firstObserved;
    await Promise.resolve();
    registerTalkConnectionCleanup("conn-async-retry", "browser-control", replacement);
    let drained = false;
    const draining = drainGlobalSingletonLifecycleState("restart").then(() => {
      drained = true;
    });
    let concurrentDrained = false;
    const concurrentDrain = drainGlobalSingletonLifecycleState("restart").then(() => {
      concurrentDrained = true;
    });
    try {
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(replacement).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(drained).toBe(false);
      finish.resolve();
      await queuedStarted.promise;
      expect(drained).toBe(false);
      expect(concurrentDrained).toBe(false);
      expect(replacement).toHaveBeenCalledOnce();
      queued.resolve();
      await Promise.all([draining, concurrentDrain]);
      cleanupTalkConnection("conn-async-retry", log);
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("physical cleanup failed"));
    } finally {
      finish.resolve();
      queued.resolve();
      await Promise.all([draining, concurrentDrain]);
    }
  });

  it("joins a restart drain started before the cleanup callback returns", async () => {
    const finish = createDeferred();
    let drained = false;
    let draining = Promise.resolve();
    registerTalkConnectionCleanup("conn-reentrant-drain", "browser-control", () => {
      draining = drainGlobalSingletonLifecycleState("restart").then(() => {
        drained = true;
      });
      return finish.promise;
    });
    cleanupTalkConnection("conn-reentrant-drain", { warn: vi.fn() });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(drained).toBe(false);
    } finally {
      finish.resolve();
      await draining;
    }
    expect(drained).toBe(true);
  });
});

describe("Talk session id lookup trim", () => {
  it("resolves and forgets padded session ids against exact Map keys", () => {
    rememberUnifiedTalkSession("talk-trim-1", {
      kind: "managed-room",
      handoffId: "h1",
      token: "t",
      roomId: "r",
    });
    expect(getUnifiedTalkSession(" talk-trim-1 ").kind).toBe("managed-room");
    forgetUnifiedTalkSession(" talk-trim-1 ");
    expect(() => getUnifiedTalkSession("talk-trim-1")).toThrow(/Unknown Talk session/);
  });

  it("talk.session.close lookup path resolves a padded realtime relay id then forgets it", () => {
    // Mirrors talk.session.close: getUnifiedTalkSession → stop → forgetUnifiedTalkSession
    rememberUnifiedTalkSession("relay-close-pad", {
      kind: "realtime-relay",
      connId: "conn-1",
      relaySessionId: "relay-close-pad",
      sessionTarget: {
        agentId: "main",
        canonicalKey: "agent:main:main",
        storeKey: "agent:main:main",
        storePath: "/tmp/unused",
      } as never,
    });
    const session = getUnifiedTalkSession(" relay-close-pad ");
    expect(session.kind).toBe("realtime-relay");
    if (session.kind === "realtime-relay") {
      expect(session.relaySessionId).toBe("relay-close-pad");
      expect(session.connId).toBe("conn-1");
    }
    forgetUnifiedTalkSession(" relay-close-pad ");
    expect(() => getUnifiedTalkSession("relay-close-pad")).toThrow(/Unknown Talk session/);
  });
});
