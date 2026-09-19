import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = spawnMock(...args);
      void Promise.resolve().then(() => child.emit("spawn"));
      return child;
    },
  };
});
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    signalProcessTree: (...args: Parameters<typeof actual.signalProcessTree>) => {
      args[2]?.onComplete?.();
    },
  };
});
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { startProcess, terminateProcess } from "./sandbox-exec-server/processes.js";
import type { ManagedProcess, OpenClawExecServer } from "./sandbox-exec-server/types.js";

function createFakeChild(): ChildProcessWithoutNullStreams {
  // SAFETY: Only the intercepted spawn path consumes this event/stream fixture; no OS child is created.
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42_424,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
}
function createExecServer(sandbox: SandboxContext): OpenClawExecServer {
  if (!sandbox.backend || !sandbox.fsBridge) {
    throw new Error("Sandbox fixture requires an execution and filesystem owner");
  }
  return {
    environmentId: "workspace-test",
    authPath: "/workspace-test",
    refCount: 1,
    closed: false,
    url: "http://127.0.0.1",
    server: { clients: [], close: (callback) => callback() },
    networkIsolated: true,
    sandbox,
    backend: sandbox.backend,
    fsBridge: sandbox.fsBridge,
    children: new Set(),
    cleanupTasks: new Set(),
  };
}
function processStartParams(processId: string) {
  return {
    processId,
    argv: ["sh", "-lc", "true"],
    cwd: "file:///workspace",
    env: {},
    tty: false,
    pipeStdin: false,
    arg0: null,
  };
}
useIsolatedStateGuard();
afterEach(() => spawnMock.mockReset());
describe("Codex managed workspace process authority", () => {
  it("retains termination-only custody after the guest execution owner is revoked", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    let current = true;
    const terminate = vi.fn(async () => {
      child.emit("close", 137, "SIGKILL");
    });
    const runShellCommand = vi.fn(async () => {
      throw new Error("revoked execution");
    });
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({ argv: ["sandbox-child"], env: {}, stdinMode: "pipe-closed" }),
      runShellCommand,
    });
    sandbox.backend!.prepareProcessCleanup = (env) => {
      if (!current) {
        throw new Error("revoked execution");
      }
      return { env, terminate, interrupt: async () => false };
    };
    const processes = new Map<string, ManagedProcess>();
    const server = createExecServer(sandbox);
    await startProcess(
      server,
      processes,
      vi.fn<ManagedProcess["emitNotification"]>(),
      processStartParams("owned-child"),
    );
    current = false;
    await terminateProcess(processes, { processId: "owned-child" });
    expect(terminate).toHaveBeenCalledOnce();
    expect(runShellCommand).not.toHaveBeenCalled();
    expect(server.children.size).toBe(0);
  });

  it("revalidates a prepared exec spec immediately before spawning the transport", async () => {
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: ["must-not-spawn"],
        env: {},
        stdinMode: "pipe-closed",
        finalizeToken: "retired",
        assertCurrent: () => {
          throw new Error("prepared owner revoked");
        },
      }),
      finalizeExec,
    });
    await expect(
      startProcess(
        createExecServer(sandbox),
        new Map(),
        vi.fn<ManagedProcess["emitNotification"]>(),
        processStartParams("retired"),
      ),
    ).rejects.toThrow("prepared owner revoked");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "failed",
      exitCode: null,
      timedOut: false,
      token: "retired",
    });
  });
});
