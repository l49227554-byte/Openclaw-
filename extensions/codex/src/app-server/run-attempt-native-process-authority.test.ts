import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { invokeNativeHookRelay } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  createCodexTestHostCapabilities,
  setCodexTestToolFactory,
} from "./host-capability.test-support.js";
import { buildCodexNativeHookRelayId } from "./native-hook-relay.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import {
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
} from "./sandbox-exec-server.js";
import { createSandboxContext, openSocket, rpc } from "./sandbox-exec-server.test-helpers.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

type Actor = "maintainer" | "guest";
type Terminal = {
  actor: Actor;
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  alive: boolean;
  closed: Promise<unknown>;
  settled: Promise<unknown>;
};

async function fixture(options: { failSettlement?: boolean } = {}) {
  const sessionFile = path.join(tempDir, "native-owner-session.jsonl");
  const workspaceDir = path.join(tempDir, "workspace");
  const threadId = "qualification-shared-thread";
  const terminals = new Map<string, Terminal>();
  const terminated: Actor[] = [];
  const settled: Actor[] = [];
  const activeRuns: Array<{ controller: AbortController; run: Promise<unknown> }> = [];
  const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const turns: string[] = [];
  let socket: WebSocket | undefined;
  let registeredUrl: string | undefined;
  let retainedEnvironment: Awaited<ReturnType<typeof ensureCodexSandboxExecServerEnvironment>>;
  const sandbox = createSandboxContext({
    ...(options.failSettlement
      ? {
          finalizeExec: async () => {
            throw new Error("fixture backend settlement failed");
          },
        }
      : {}),
    buildExecSpec: async () => ({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('qualification-ready\\n'); setTimeout(() => process.exit(0), 30000)",
      ],
      // Synthetic task-owned processes receive no inherited secrets or profile state.
      env: {},
      stdinMode: "pipe-closed",
    }),
  });
  Object.assign(sandbox, {
    sessionKey: "agent:main:session-1",
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    runtimeId: `native-terminal-${path.basename(tempDir)}`,
  });
  const harness = createStartedThreadHarness(async (method, raw) => {
    const input = raw as Record<string, unknown>;
    if (method === "environment/add") {
      const url = String(input.execServerUrl);
      if (registeredUrl !== url || socket?.readyState !== 1) {
        socket = await openSocket(url);
        registeredUrl = url;
      }
      return {};
    }
    if (method === "thread/start" || method === "thread/resume") {
      if (method === "thread/resume") {
        expect(input.threadId).toBe(threadId);
      }
      return threadStartResult(threadId, { cwd: "/workspace" });
    }
    if (method === "thread/read") {
      const requestedThreadId = typeof input.threadId === "string" ? input.threadId : threadId;
      return { thread: { ...threadStartResult(requestedThreadId).thread, turns: [] } };
    }
    if (method === "turn/start") {
      expect(input.threadId).toBe(threadId);
      expect(input.environments).toEqual([
        { environmentId: expect.stringMatching(/^openclaw-sandbox-/), cwd: "/workspace" },
      ]);
      const turnId = `qualification-turn-${turns.length + 1}`;
      turns.push(turnId);
      return turnStartResult(turnId);
    }
    if (method === "thread/backgroundTerminals/list") {
      expect(input.threadId).toBe(threadId);
      const data = [...terminals.values()]
        .filter((terminal) => terminal.alive)
        .map(({ itemId, processId, command, cwd }) => ({ itemId, processId, command, cwd }));
      return { data: input.limit ? data.slice(0, Number(input.limit)) : data, nextCursor: null };
    }
    if (method === "thread/backgroundTerminals/terminate") {
      expect(input.threadId).toBe(threadId);
      const terminal = terminals.get(String(input.processId));
      if (!terminal || !terminal.alive || !socket) {
        return { terminated: false };
      }
      await rpc(socket, "process/terminate", { processId: terminal.processId });
      await terminal.closed;
      terminated.push(terminal.actor);
      return { terminated: true };
    }
    return undefined;
  });

  const begin = async (actor: Actor, nativeChild?: { threadId: string; turnId: string }) => {
    const controller = new AbortController();
    const source = new AbortController();
    let completed = false;
    const params = createParams(sessionFile, workspaceDir, {
      runId: `${actor}-run-${turns.length + 1}`,
      prompt: `${actor} qualification turn`,
    });
    params.hostCapabilities = createCodexTestHostCapabilities({
      retainSourceAuthority: () => ({
        assertCurrent: () => source.signal.throwIfAborted(),
        signal: source.signal,
        release: () => {},
      }),
    });
    params.senderId = actor;
    params.onAgentEvent = (event) => {
      events.push(event);
    };
    params.sandbox = sandbox;
    params.abortSignal = controller.signal;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    setCodexTestToolFactory(params, () => []);
    const expectedTurns = turns.length + 1;
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { experimental: { sandboxExecServer: true } } },
    });
    activeRuns.push({ controller, run });
    await harness.waitForMethod("turn/start");
    await vi.waitFor(() => expect(turns).toHaveLength(expectedTurns), { timeout: 5_000 });
    await nextTurn();
    const turnId = turns.at(-1)!;
    const commandThreadId = nativeChild?.threadId ?? threadId;
    const commandTurnId = nativeChild?.turnId ?? turnId;
    if (nativeChild) {
      await harness.notify({
        method: "thread/started",
        params: {
          thread: {
            id: nativeChild.threadId,
            parentThreadId: threadId,
            source: { subAgent: { thread_spawn: { parent_thread_id: threadId, depth: 1 } } },
          },
        },
      });
      // The registered monitor must claim the child from this exact accepted parent turn.
      await harness.notify({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            id: `${actor}-spawn`,
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: threadId,
            receiverThreadIds: [nativeChild.threadId],
          },
        },
      });
      await harness.notify({
        method: "turn/started",
        params: {
          threadId: nativeChild.threadId,
          turn: { id: nativeChild.turnId, status: "inProgress", items: [], error: null },
        },
      });
    }
    const server = await sandboxExecServerRegistry.servers.get(sandbox.runtimeId);
    if (!server || "node" in server || !socket) {
      throw new Error("Expected the real local sandbox exec-server owner");
    }
    const previousChildren = new Set(server.children);
    const processId = actor === "maintainer" ? "1001" : "2001";
    const relay = await invokeNativeHookRelay({
      provider: "codex",
      relayId: buildCodexNativeHookRelayId({
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      }),
      event: "pre_tool_use",
      rawPayload: {
        session_id: threadId,
        ...(nativeChild ? { agent_id: nativeChild.threadId } : {}),
        turn_id: commandTurnId,
        tool_name: "exec_command",
        tool_use_id: `${actor}-command`,
        tool_input: { command: "qualification-task-owned-process" },
      },
    });
    expect(relay.exitCode).toBe(0);
    await rpc(socket, "process/start", {
      processId,
      metadata: { threadId: commandThreadId, toolCallId: `${actor}-command` },
      argv: ["qualification-task-owned-process"],
      cwd: "file:///workspace",
      env: {},
      tty: false,
      pipeStdin: false,
      arg0: null,
    });
    const child = [...server.children].find((candidate) => !previousChildren.has(candidate));
    if (!child) {
      throw new Error("Real sandbox process owner was not admitted");
    }
    const terminal: Terminal = {
      actor,
      itemId: `${actor}-command`,
      processId,
      command: "qualification-task-owned-process",
      cwd: "/workspace",
      alive: true,
      closed: child.closed,
      settled: child.settled,
    };
    terminals.set(processId, terminal);
    void child.closed.then(async () => {
      terminal.alive = false;
      settled.push(actor);
      await harness.notify({
        method: "item/completed",
        params: {
          threadId: commandThreadId,
          turnId: commandTurnId,
          item: {
            id: terminal.itemId,
            type: "commandExecution",
            command: terminal.command,
            cwd: "/workspace",
            processId,
            status: "completed",
            commandActions: [],
            aggregatedOutput: "",
            exitCode: 0,
            durationMs: 1,
          },
        },
      });
    });
    await harness.notify({
      method: "item/started",
      params: {
        threadId: commandThreadId,
        turnId: commandTurnId,
        item: {
          id: terminal.itemId,
          type: "commandExecution",
          command: terminal.command,
          cwd: "/workspace",
          processId,
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: "",
          exitCode: null,
          durationMs: null,
        },
      },
    });
    return {
      terminal,
      turnId,
      controller,
      sourceSignal: source.signal,
      revoke: () => {
        source.abort(new Error("Synthetic original source revoked"));
        if (!completed) {
          controller.abort(source.signal.reason);
        }
      },
      run,
      complete: async () => {
        await harness.completeTurn({ threadId, turnId });
        const result = await run;
        completed = true;
        return result;
      },
    };
  };

  return {
    begin,
    terminated,
    settled,
    events,
    harness,
    sessionFile,
    threadId,
    retainSecondConsumer: async () => {
      // Same production lease operation used by a concurrent /btw turn or another
      // permitted session sharing this sandbox runtime; no fabricated process inventory.
      retainedEnvironment = await ensureCodexSandboxExecServerEnvironment({
        client: harness.client,
        sandbox,
        requireProcessAuthority: true,
      });
    },
    dispose: async () => {
      for (const { controller } of activeRuns) {
        controller.abort(new Error("fixture cleanup"));
      }
      await Promise.allSettled(activeRuns.map(({ run }) => run));
      if (retainedEnvironment) {
        await releaseCodexSandboxExecServerEnvironment(sandbox, retainedEnvironment);
        retainedEnvironment = undefined;
      }
      await sandboxExecServerRegistry.closeAll();
      socket?.terminate();
      harness.close();
    },
  };
}

describe("native background process source authority", () => {
  it("reports failed real-child settlement and preserves its command custody", async () => {
    const f = await fixture({ failSettlement: true });
    try {
      const guest = await f.begin("guest");
      await f.retainSecondConsumer();
      await guest.complete();
      guest.revoke();
      await vi.waitFor(() =>
        expect(f.events).toContainEqual(
          expect.objectContaining({
            stream: "codex_app_server.lifecycle",
            data: expect.objectContaining({ phase: "background_cleanup_failed" }),
          }),
        ),
      );
      expect(guest.terminal.alive).toBe(false);
      await expect(f.begin("guest")).rejects.toThrow("unsettled native command identity");
    } finally {
      await f.dispose();
    }
  });

  it("sole sandbox lease normal completion settles its task-owned process", async () => {
    const f = await fixture();
    try {
      const staff = await f.begin("maintainer");
      expect(staff.terminal.alive).toBe(true);
      expect(readAttemptTerminal(await staff.complete()).aborted).toBe(false);
      await staff.terminal.closed;
      expect(staff.terminal.alive).toBe(false);
      expect(f.terminated).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it("normal completion preserves background work while an independent sandbox consumer remains", async () => {
    const f = await fixture();
    try {
      const staff = await f.begin("maintainer");
      await f.retainSecondConsumer();
      expect(readAttemptTerminal(await staff.complete()).aborted).toBe(false);
      expect(staff.terminal.alive).toBe(true);
      expect(f.terminated).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it("source cancellation interrupts the exact guest foreground turn and joins its process", async () => {
    const f = await fixture();
    try {
      const guest = await f.begin("guest");
      guest.revoke();
      expect(readAttemptTerminal(await guest.run).aborted).toBe(true);
      expect(f.harness.requests).toContainEqual({
        method: "turn/interrupt",
        params: { threadId: f.threadId, turnId: guest.turnId },
      });
      expect(guest.terminal.alive).toBe(false);
      expect(f.settled).toEqual(["guest"]);
      expect(f.terminated).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it("parent cancellation settles its claimed native child's process and preserves independent maintainer work", async () => {
    const f = await fixture();
    try {
      const staff = await f.begin("maintainer");
      await f.retainSecondConsumer();
      await staff.complete();
      expect(staff.terminal.alive).toBe(true);
      const guest = await f.begin("guest", {
        threadId: "guest-native-child",
        turnId: "guest-native-child-turn",
      });
      expect(guest.terminal.alive).toBe(true);
      guest.controller.abort(new Error("Synthetic parent foreground cancelled"));
      expect(readAttemptTerminal(await guest.run).aborted).toBe(true);
      expect(guest.sourceSignal.aborted).toBe(false);
      expect(f.harness.requests).toContainEqual({
        method: "turn/interrupt",
        params: { threadId: f.threadId, turnId: guest.turnId },
      });
      expect(guest.terminal.alive).toBe(false);
      await guest.terminal.settled;
      expect(f.settled).toEqual(["guest"]);
      expect(f.terminated).toEqual([]);
      expect(staff.terminal.alive).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it("preserves the earlier maintainer terminal when the later guest source ends on the reused thread", async () => {
    const f = await fixture();
    try {
      const staff = await f.begin("maintainer");
      await f.retainSecondConsumer();
      await staff.complete();
      expect(staff.terminal.alive).toBe(true);
      const guest = await f.begin("guest");
      expect((await readCodexAppServerBinding(f.sessionFile))?.threadId).toBe(f.threadId);
      expect(f.harness.requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
      expect(staff.terminal.alive).toBe(true);
      guest.revoke();
      expect(readAttemptTerminal(await guest.run).aborted).toBe(true);
      expect(guest.terminal.alive).toBe(false);
      expect(f.settled, "Only guest-authorized background work may terminate").toEqual(["guest"]);
      expect(f.terminated).toEqual([]);
      expect(staff.terminal.alive).toBe(true);
    } finally {
      await f.dispose();
    }
  });
  it("revokes completed guest work while a later maintainer foreground stays live", async () => {
    const f = await fixture();
    try {
      const guest = await f.begin("guest");
      await f.retainSecondConsumer();
      await guest.complete();
      const staff = await f.begin("maintainer");
      guest.revoke();
      await vi.waitFor(() => expect(guest.terminal.alive).toBe(false));
      expect(staff.terminal.alive).toBe(true);
      expect(f.settled).toEqual(["guest"]);
      expect(f.harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
      expect(readAttemptTerminal(await staff.complete()).aborted).toBe(false);
    } finally {
      await f.dispose();
    }
  });
});
