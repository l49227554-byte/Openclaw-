// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient, GatewayRequestError } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import {
  answerConfirmDialog,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../test-helpers/modal-dialog.ts";
import { withSessionWorkspaceRecovery } from "./session-workspace-recovery.runtime.ts";

function createRecoveryHarness(action: "delete" | "archive") {
  const client = new GatewayBrowserClient({ url: "ws://gateway.example.test" });
  const session = {
    key: "agent:main:offline",
    sessionId: "offline-session",
    agentId: "main",
    label: "Offline session",
  };
  const recoveryError = (sessionId = session.sessionId) =>
    new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "Reconnect the device to preserve its workspace.",
      details: {
        code: "SESSION_WORKSPACE_RECOVERY_REQUIRED",
        cause: "device_offline",
        recoveryAction: "continue_on_gateway",
        sessionId,
        source: { generation: 5, environmentId: "device-environment", ownerEpoch: 70 },
      },
    });
  const error = recoveryError();
  const move = createDeferred<void>();
  let current = true;
  const abort = new AbortController();
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    hello: {
      type: "hello-ok",
      protocol: 4,
      features: { methods: ["sessions.move", "sessions.delete", "sessions.patch"] },
      auth: { role: "operator", scopes: ["operator.write", "operator.admin"] },
      snapshot: {},
    },
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: session.key,
    lastError: null,
    lastErrorCode: null,
  };
  const gateway = {
    snapshot,
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  };
  const remove = vi
    .fn<() => Promise<unknown>>()
    .mockRejectedValueOnce(error)
    .mockResolvedValue({
      ok: true,
      deleted: true,
      key: session.key,
      entry: { sessionId: session.sessionId, updatedAt: 1, archivedAt: 1 },
    });
  const request = vi.spyOn(client, "request").mockImplementation(async (method) => {
    if (method === "sessions.delete" || method === "sessions.patch") {
      return await remove();
    }
    if (method === "sessions.move") {
      await move.promise;
      return { ok: true };
    }
    if (method === "sessions.list") {
      return sessionsResult([], 1);
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const sessions = createSessionCapability(gateway, {
    state: { selectedId: "main" },
    subscribe: () => () => undefined,
  });
  const operations: Promise<unknown>[] = [];
  return {
    error,
    recoveryError,
    remove,
    move,
    request,
    snapshot,
    retire() {
      current = false;
      abort.abort();
    },
    run() {
      const operation = withSessionWorkspaceRecovery({
        action,
        session,
        scope: { client, gateway, signal: abort.signal },
        isCurrent: () => current,
        request: async () =>
          action === "delete"
            ? await sessions.delete(session.key, {
                agentId: session.agentId,
                expectedSessionId: session.sessionId,
              })
            : await sessions.patch(
                session.key,
                { archived: true },
                {
                  agentId: session.agentId,
                  expectedSessionId: session.sessionId,
                },
              ),
      });
      operations.push(operation);
      void operation.catch(() => undefined);
      return operation;
    },
    async dispose() {
      current = false;
      abort.abort();
      move.resolve();
      await Promise.allSettled(operations);
      sessions.dispose();
      request.mockRestore();
    },
  };
}

describe.each(["delete", "archive"] as const)("workspace recovery before %s", (action) => {
  let restoreDialog: () => void;
  let h: ReturnType<typeof createRecoveryHarness>;

  beforeEach(() => {
    restoreDialog = installDialogPolyfill();
    h = createRecoveryHarness(action);
  });

  afterEach(async () => {
    await h.dispose();
    document.body.replaceChildren();
    restoreDialog();
  });

  it("retries the real removal only after explicit loss consent and completed recovery", async () => {
    const operation = h.run();
    const actions = await waitForConfirmDialogActions();
    expect(actions.textContent).toContain(`Discard changes and ${action}`);
    expect(document.body.textContent).toContain("Reconnect it to keep those changes");
    expect(h.request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
    answerConfirmDialog(actions, "confirm");
    await vi.waitFor(() =>
      expect(h.request).toHaveBeenCalledWith("sessions.move", {
        key: "agent:main:offline",
        agentId: "main",
        expected: { generation: 5, environmentId: "device-environment", ownerEpoch: 70 },
        target: { kind: "gateway" },
        abandonSource: true,
      }),
    );
    expect(h.remove).toHaveBeenCalledOnce();
    h.move.resolve();
    await expect(operation).resolves.toBeDefined();
    expect(h.remove).toHaveBeenCalledTimes(2);
  });

  it("keeps the original failure when consent is declined", async () => {
    const operation = h.run();
    answerConfirmDialog(await waitForConfirmDialogActions(), "cancel");
    await expect(operation).rejects.toBe(h.error);
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  });

  it("does not recover another session identity", async () => {
    const error = h.recoveryError("replacement-session");
    h.remove.mockReset().mockRejectedValue(error);
    await expect(h.run()).rejects.toBe(error);
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(h.request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  });

  it.each(["dialog", "move"] as const)("retires intent during the %s", async (stage) => {
    const operation = h.run();
    const actions = await waitForConfirmDialogActions();
    if (stage === "move") {
      answerConfirmDialog(actions, "confirm");
      await vi.waitFor(() =>
        expect(h.request).toHaveBeenCalledWith("sessions.move", expect.anything()),
      );
    }
    h.retire();
    h.move.resolve();
    await expect(operation).resolves.toBeUndefined();
    expect(h.remove).toHaveBeenCalledOnce();
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    if (stage === "dialog") {
      expect(h.request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
    }
  });

  it("rechecks access after confirmation", async () => {
    const operation = h.run();
    const actions = await waitForConfirmDialogActions();
    h.snapshot.hello = {
      type: "hello-ok",
      protocol: 4,
      features: { methods: ["sessions.move"] },
      auth: { role: "operator", scopes: ["operator.read"] },
      snapshot: {},
    };
    answerConfirmDialog(actions, "confirm");
    await expect(operation).rejects.toThrow();
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  });

  it("reports a move failure without retrying removal", async () => {
    const error = new Error("Device ownership changed");
    const operation = h.run();
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await vi.waitFor(() =>
      expect(h.request).toHaveBeenCalledWith("sessions.move", expect.anything()),
    );
    h.move.reject(error);
    await expect(operation).rejects.toBe(error);
    expect(h.remove).toHaveBeenCalledOnce();
  });

  it("reports a second removal rejection without another recovery prompt", async () => {
    const secondError = h.recoveryError();
    h.remove.mockRejectedValueOnce(secondError);
    const operation = h.run();
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    h.move.resolve();
    await expect(operation).rejects.toBe(secondError);
    expect(h.remove).toHaveBeenCalledTimes(2);
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.move")).toHaveLength(1);
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});
