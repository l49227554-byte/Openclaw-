import process from "node:process";
import { expect, it, vi, type Mock } from "vitest";
import type { ConfigSnapshotReadOptions } from "../config/io.types.js";

export type ConfigSnapshotStub = {
  exists: boolean;
  hash?: string;
  issues?: Array<{ message: string; path: string }>;
  legacyIssues?: Array<{ message: string; path: string }>;
  path?: string;
  raw?: string | null;
  valid: boolean;
  sourceConfig: Record<string, unknown>;
};

export type GatewayRunCommandHooks = {
  beforeRun?: (opts: { reset?: boolean }) => Promise<void>;
};
export type CliExecutionBootstrapOptions = {
  beforeStateMigrations?: (snapshot?: ConfigSnapshotStub) => Promise<boolean>;
};

type BootstrapFixtures = {
  runCli: typeof import("./run-main.js").runCli;
  readConfigFileSnapshotMock: Mock<
    (options?: ConfigSnapshotReadOptions) => Promise<ConfigSnapshotStub>
  >;
  addGatewayRunCommandMock: Mock<(command: unknown, hooks?: GatewayRunCommandHooks) => unknown>;
  ensureCliExecutionBootstrapMock: Mock<(opts: CliExecutionBootstrapOptions) => Promise<void>>;
};

export function registerGatewayStartupBootstrapTests({
  runCli,
  readConfigFileSnapshotMock,
  addGatewayRunCommandMock,
  ensureCliExecutionBootstrapMock,
}: BootstrapFixtures): void {
  it("configures the gateway foreground fast path with the standard CLI bootstrap", async () => {
    await runCli(["node", "openclaw", "gateway", "--force"]);

    expect(readConfigFileSnapshotMock.mock.calls).toEqual([
      [{ isolateEnv: true, observe: false, pluginValidation: "core-only" }],
    ]);
    const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
      | { beforeRun?: (opts: { reset?: boolean }) => Promise<void> }
      | undefined;
    await hooks?.beforeRun?.({});

    expect(ensureCliExecutionBootstrapMock).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeStateMigrations: expect.any(Function),
        commandPath: ["gateway"],
        loadPlugins: false,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(readConfigFileSnapshotMock.mock.calls).toEqual([
      [{ isolateEnv: true, observe: false, pluginValidation: "core-only" }],
      [{ isolateEnv: true, observe: false, pluginValidation: "core-only" }],
    ]);
    const admissionOrder = readConfigFileSnapshotMock.mock.invocationCallOrder[1] ?? 0;
    const bootstrapOrder = ensureCliExecutionBootstrapMock.mock.invocationCallOrder[0] ?? 0;
    expect(admissionOrder).toBeGreaterThan(0);
    expect(bootstrapOrder).toBeGreaterThan(admissionOrder);
  });

  it("stops suspicious config recovery when Gateway startup is interrupted", async () => {
    const processOnSpy = vi.spyOn(process, "on");
    const previousExitCode = process.exitCode;
    const currentSnapshot = {
      exists: true,
      valid: true,
      sourceConfig: { gateway: { mode: "local" } },
    };
    // Main plans suspicious-config recovery through prepareConfigRecovery after the guarded
    // read instead of the recoverSuspicious callback, so fire the startup SIGTERM from the
    // first guard read that runs after the startup signal owner registered its handler, and
    // expect the bootstrap to refuse before plugin/bootstrap admission.
    let interrupted = false;
    readConfigFileSnapshotMock.mockImplementation(async () => {
      if (!interrupted) {
        const sigtermHandler = processOnSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
        if (typeof sigtermHandler === "function") {
          interrupted = true;
          sigtermHandler();
        }
      }
      return currentSnapshot;
    });

    try {
      await runCli(["node", "openclaw", "gateway"]);
      const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
        | { beforeRun?: (opts: { force?: boolean }) => Promise<void> }
        | undefined;
      await hooks?.beforeRun?.({});

      expect(interrupted).toBe(true);
      expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
      processOnSpy.mockRestore();
    }
  });
}

export function registerGatewayStartupProxyExitTests({
  runCli,
  makeProxyHandle,
  startProxyMock,
  stopProxyMock,
  commanderParseAsyncMock,
  addGatewayRunCommandMock,
  ensureCliExecutionBootstrapMock,
}: Omit<BootstrapFixtures, "readConfigFileSnapshotMock"> & {
  makeProxyHandle: () => unknown;
  startProxyMock: Mock<(config: unknown) => Promise<unknown>>;
  stopProxyMock: Mock<(handle: unknown) => Promise<void>>;
  commanderParseAsyncMock: Mock<() => Promise<void>>;
}): void {
  it("waits for Gateway startup cleanup before the managed proxy exits on SIGTERM", async () => {
    const handle = makeProxyHandle();
    startProxyMock.mockResolvedValueOnce(handle);
    let rejectBootstrap: (reason?: unknown) => void = () => {};
    ensureCliExecutionBootstrapMock.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectBootstrap = reject;
      }),
    );
    commanderParseAsyncMock.mockImplementationOnce(async () => {
      const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
        | { beforeRun?: (opts: { force?: boolean }) => Promise<void> }
        | undefined;
      await hooks?.beforeRun?.({});
    });

    const processOnSpy = vi.spyOn(process, "on");
    const processOnceSpy = vi.spyOn(process, "once");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string) => {
      void code;
      return undefined as never;
    }) as typeof process.exit);
    const previousExitCode = process.exitCode;
    const startupError = new Error("configured-plugin repair aborted");

    try {
      const runPromise = runCli(["node", "openclaw", "gateway", "run"]);
      await vi.waitFor(
        () => {
          expect(startProxyMock).toHaveBeenCalledWith(undefined);
          expect(ensureCliExecutionBootstrapMock).toHaveBeenCalledWith(
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          );
          expect(processOnSpy.mock.calls.some(([event]) => event === "SIGTERM")).toBe(true);
          expect(processOnceSpy.mock.calls.some(([event]) => event === "SIGTERM")).toBe(true);
        },
        { timeout: 5_000 },
      );

      const startupSigtermHandler = processOnSpy.mock.calls.find(
        ([event]) => event === "SIGTERM",
      )?.[1];
      const proxySigtermHandler = processOnceSpy.mock.calls.find(
        ([event]) => event === "SIGTERM",
      )?.[1];
      if (
        typeof startupSigtermHandler !== "function" ||
        typeof proxySigtermHandler !== "function"
      ) {
        throw new Error("Gateway SIGTERM handlers were not registered");
      }
      startupSigtermHandler();
      proxySigtermHandler();

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(exitSpy).not.toHaveBeenCalled();

      rejectBootstrap(startupError);
      await runPromise;
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(143);
      });
      expect(stopProxyMock.mock.invocationCallOrder[0]).toBeLessThan(
        exitSpy.mock.invocationCallOrder[0]!,
      );
    } finally {
      process.exitCode = previousExitCode;
      exitSpy.mockRestore();
      processOnceSpy.mockRestore();
      processOnSpy.mockRestore();
    }
  });
}
