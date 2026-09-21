// Daemon install integration tests cover definition-access refusal without rewriting config.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayServiceInstallArgs } from "../../daemon/service-types.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { captureEnv } from "../../test-utils/env.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";

const { runtimeLogs, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();
const busctl = vi.hoisted(() =>
  vi.fn<typeof import("../../daemon/systemd-exec.js").execBusctlUser>(),
);
vi.mock("../../daemon/systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-exec.js")>()),
  execBusctlUser: busctl,
}));
vi.mock("../../daemon/systemd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-system.js")>()),
  assertNoSystemSystemdOwnership: async () => {},
}));

const serviceMock = vi.hoisted(() => ({
  label: "Gateway",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  stage: vi.fn(async (_opts?: { environment?: Record<string, string | undefined> }) => {}),
  install: vi.fn(async (_opts?: GatewayServiceInstallArgs) => {}),
  uninstall: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  restart: vi.fn(async () => {}),
  isLoaded: vi.fn(async () => false),
  readDefinitionMutationCapability: vi.fn<
    (args?: {
      env?: NodeJS.ProcessEnv;
      environment?: NodeJS.ProcessEnv;
    }) => Promise<import("../../daemon/service-types.js").ServiceDefinitionMutationCapability>
  >(async (_args?: { env?: NodeJS.ProcessEnv; environment?: NodeJS.ProcessEnv }) => ({
    kind: "writable" as const,
  })),
  readCommand: vi.fn<
    typeof import("../../daemon/systemd-service-files.js").readSystemdServiceExecStart
  >(async () => null),
  readRuntime: vi.fn(async () => ({ status: "stopped" as const })),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => serviceMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

const { runDaemonInstall } = await import("./install.js");
const { clearConfigCache, clearRuntimeConfigSnapshot } = await import("../../config/config.js");

describe("runDaemonInstall integration definition access", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let accountHome: string;
  let tempHome: string;
  let configPath: string;

  async function snapshotConfig() {
    const contents = await fs.readFile(configPath);
    const { ino, mode, uid } = await fs.lstat(configPath);
    return { contents, ino, mode, uid, entries: (await fs.readdir(tempHome)).toSorted() };
  }

  beforeAll(async () => {
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
    ]);
    accountHome = await makeTempWorkspace("openclaw-daemon-install-def-");
    tempHome = path.join(accountHome, ".openclaw");
    await fs.mkdir(tempHome);
    configPath = path.join(tempHome, "openclaw.json");
    process.env.HOME = accountHome;
    process.env.OPENCLAW_STATE_DIR = tempHome;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
  });

  afterAll(async () => {
    envSnapshot.restore();
    await fs.rm(accountHome, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSystemAccountHome();
    resetRuntimeCapture();
    clearRuntimeConfigSnapshot();
    // Keep these defined-but-empty so dotenv won't repopulate from local .env.
    process.env.OPENCLAW_GATEWAY_TOKEN = "";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "";
    serviceMock.isLoaded.mockResolvedValue(false);
    serviceMock.install.mockReset();
    serviceMock.install.mockResolvedValue(undefined);
    serviceMock.readDefinitionMutationCapability.mockReset();
    serviceMock.readDefinitionMutationCapability.mockResolvedValue({ kind: "writable" });
    serviceMock.readCommand.mockReset();
    serviceMock.readCommand.mockResolvedValue(null);
    await fs.writeFile(configPath, JSON.stringify({}, null, 2));
    clearConfigCache();
  });

  it("refuses service install when config was written by a newer OpenClaw", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          meta: {
            lastTouchedVersion: "9999.1.1",
          },
          gateway: {
            auth: {
              mode: "token",
            },
          },
        },
        null,
        2,
      ),
    );
    clearConfigCache();

    await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");

    expect(serviceMock.install).not.toHaveBeenCalled();
    expect(runtimeLogs.join("\n")).toContain("Refusing to install or rewrite the gateway service");
  });

  it.each([
    {
      name: "gateway.mode is missing",
      capability: { kind: "sealed" as const, reason: "foreign-owner" as const },
      config: { gateway: { auth: { mode: "token", token: "existing-token" } } },
      marker: "SERVICE_DEFINITION_SEALED",
    },
    {
      name: "the gateway token is missing",
      capability: { kind: "sealed" as const, reason: "foreign-owner" as const },
      config: { gateway: { mode: "local", auth: { mode: "token" } } },
      marker: "SERVICE_DEFINITION_SEALED",
    },
    {
      name: "gateway.mode is missing and definition authority is unknown",
      capability: { kind: "unknown" as const, reason: "inspection-failed" as const },
      config: { gateway: { auth: { mode: "token" } } },
      marker: "SERVICE_DEFINITION_UNKNOWN",
    },
  ])(
    "preserves config bytes and directory entries when definition access is refused and $name",
    async ({ capability, config, marker }) => {
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      clearConfigCache();
      serviceMock.readDefinitionMutationCapability.mockResolvedValueOnce(capability);
      const before = await snapshotConfig();

      await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");

      expect(await snapshotConfig()).toEqual(before);
      expect(serviceMock.install).not.toHaveBeenCalled();
      expect(serviceMock.readCommand).toHaveBeenCalledOnce();
      expect(runtimeLogs.join("\n")).toContain(marker);
      expect(runtimeLogs.join("\n")).toContain(
        capability.kind === "sealed" ? "deployment owner" : "Inspect service definition access",
      );
    },
  );

  it.each([
    { name: "forced fresh install", loaded: false, force: true },
    { name: "loaded auto-refresh", loaded: true, force: false },
    { name: "forced loaded refresh", loaded: true, force: true },
  ])(
    "preserves config, token, and state when $name cannot inspect its command",
    async ({ loaded, force }) => {
      const secret = "service-command-inspection-secret-canary";
      await fs.writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "token" } } }));
      clearConfigCache();
      serviceMock.isLoaded.mockResolvedValue(loaded);
      serviceMock.readCommand.mockRejectedValueOnce(new Error(secret));
      const before = await snapshotConfig();

      await expect(runDaemonInstall({ json: true, force })).rejects.toThrow("__exit__:1");

      expect(await snapshotConfig()).toEqual(before);
      expect(serviceMock.readCommand).toHaveBeenCalledWith(expect.any(Object), {
        requireEffective: true,
      });
      expect(serviceMock.readDefinitionMutationCapability).not.toHaveBeenCalled();
      expect(serviceMock.install).not.toHaveBeenCalled();
      expect(runtimeLogs.join("\n")).toContain("SERVICE_DEFINITION_UNKNOWN");
      expect(runtimeLogs.join("\n")).not.toContain(secret);
    },
  );
});
