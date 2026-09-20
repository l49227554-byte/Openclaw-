// Wrapper-timeout messaging: a timeout that fires after the request was already
// dispatched must explain the uncertain outcome (#153357); a startup-phase timeout
// (nothing dispatched) keeps the plain deadline message.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { captureEnv, deleteTestEnvValue } from "../test-utils/env.js";
import type { GatewayClientOptions, GatewayClientRequestOptions } from "./client.js";

const gatewayConfigMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  inspectGatewayTlsCertificate: vi.fn(),
  resolveConfigPath: vi.fn(
    (env: NodeJS.ProcessEnv, stateDir: string) =>
      env.OPENCLAW_CONFIG_PATH ?? `${stateDir}/openclaw.json`,
  ),
  resolveGatewayPort: vi.fn(),
  resolveStateDir: vi.fn((env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw"),
}));

const deviceIdentity: DeviceIdentity = {
  deviceId: "test-device-identity",
  publicKeyPem: "test-public-key",
  privateKeyPem: "test-private-key",
};

const clientStubState = vi.hoisted(() => ({
  helloOk: true as boolean,
  requestImpl: null as null | ((method: string) => Promise<unknown>),
  lastClientOptions: null as GatewayClientOptions | null,
}));

function makeStubGatewayHello(): HelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    server: { version: "test", connId: "test-connection" },
    features: { capabilities: [], methods: ["health"], events: [] },
    snapshot: {
      presence: [],
      health: {},
      stateVersion: { presence: 0, health: 0 },
      uptimeMs: 0,
    },
    auth: { role: "operator", scopes: [] },
    policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
  };
}

vi.mock("../config/gateway-dispatch-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/gateway-dispatch-config.js")>();
  return {
    ...actual,
    readGatewayDispatchConfig: () => gatewayConfigMocks.getRuntimeConfig(),
    readGatewayDispatchConfigWithShellEnvFallback: async () =>
      gatewayConfigMocks.getRuntimeConfig(),
  };
});

vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/paths.js")>();
  return {
    ...actual,
    resolveConfigPath: gatewayConfigMocks.resolveConfigPath,
    resolveGatewayPort: gatewayConfigMocks.resolveGatewayPort,
    resolveStateDir: gatewayConfigMocks.resolveStateDir,
  };
});

vi.mock("../infra/device-auth-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-auth-store.js")>();
  const pairedDeviceToken = {
    token: "paired-device-token",
    role: "operator",
    scopes: ["operator.read"],
    updatedAtMs: 123,
  };
  return {
    ...actual,
    loadDeviceAuthToken: vi.fn(() => pairedDeviceToken),
    loadDeviceAuthTokenReadOnly: vi.fn(() => pairedDeviceToken),
    loadOriginDeviceToken: vi.fn(() => null),
    loadOriginDeviceTokenReadOnly: vi.fn(() => null),
  };
});

vi.mock("../infra/device-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-identity.js")>();
  return {
    ...actual,
    loadOrCreateDeviceIdentity: () => deviceIdentity,
    loadDeviceIdentityIfPresent: () => deviceIdentity,
  };
});

vi.mock("../infra/tls/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/tls/gateway.js")>();
  return {
    ...actual,
    inspectGatewayTlsCertificate: gatewayConfigMocks.inspectGatewayTlsCertificate,
  };
});

vi.mock("./client.js", () => ({
  prepareGatewayClientDeviceAuth: vi.fn(async () => {}),
  isGatewayConnectAssemblyError: () => false,
  GatewayClient: class {
    constructor(opts: GatewayClientOptions) {
      clientStubState.lastClientOptions = opts;
    }
    async request(method: string, _params: unknown, _opts?: GatewayClientRequestOptions) {
      if (clientStubState.requestImpl) {
        return await clientStubState.requestImpl(method);
      }
      return { ok: true };
    }
    start() {
      if (clientStubState.helloOk) {
        clientStubState.lastClientOptions?.onHelloOk?.(makeStubGatewayHello());
      }
    }
    stop() {}
    async stopAndWait() {}
  },
}));

vi.mock("../../packages/gateway-client/src/event-loop-ready.js", () => ({
  waitForEventLoopReady: vi.fn(async () => ({
    ready: true,
    elapsedMs: 0,
    maxDriftMs: 0,
    checks: 2,
    aborted: false,
  })),
}));

const { callGateway } = await import("./call.js");

function resetMocks() {
  gatewayConfigMocks.getRuntimeConfig.mockReset().mockReturnValue({
    gateway: { mode: "local", bind: "loopback" },
  });
  gatewayConfigMocks.resolveGatewayPort.mockReset().mockReturnValue(18789);
  gatewayConfigMocks.resolveConfigPath.mockClear();
  gatewayConfigMocks.resolveStateDir.mockClear();
  gatewayConfigMocks.inspectGatewayTlsCertificate
    .mockReset()
    .mockResolvedValue({ ok: false, error: "gateway tls is disabled" });
  clientStubState.helloOk = true;
  clientStubState.requestImpl = null;
  clientStubState.lastClientOptions = null;
}

describe("callGateway wrapper timeout outcome messaging", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_STATE_DIR",
  ]);

  beforeEach(() => {
    resetConfigRuntimeState();
    envSnapshot.restore();
    for (const name of [
      "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_PORT",
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_STATE_DIR",
    ]) {
      deleteTestEnvValue(name);
    }
    resetMocks();
  });

  it("explains the uncertain outcome when the wrapper timeout fires after the request was dispatched", async () => {
    clientStubState.requestImpl = () => new Promise(() => {});

    vi.useFakeTimers();
    let errMessage = "";
    const promise = callGateway({ method: "health", timeoutMs: 5 }).catch((caught: unknown) => {
      errMessage = caught instanceof Error ? caught.message : String(caught);
    });

    await vi.advanceTimersByTimeAsync(5);
    await promise;
    vi.useRealTimers();

    expect(errMessage).toContain("gateway timeout after 5ms");
    expect(errMessage).toContain("Gateway target: ws://127.0.0.1:18789");
    expect(errMessage).toContain("already sent to the gateway");
    expect(errMessage).toContain("outcome is unknown");
    expect(errMessage).toContain("Verify the current state");
  });

  it("keeps the startup timeout message free of dispatched-request guidance", async () => {
    clientStubState.helloOk = false;

    vi.useFakeTimers();
    let errMessage = "";
    const promise = callGateway({ method: "health", timeoutMs: 5 }).catch((caught: unknown) => {
      errMessage = caught instanceof Error ? caught.message : String(caught);
    });

    await vi.advanceTimersByTimeAsync(5);
    await promise;
    vi.useRealTimers();

    expect(errMessage).toContain("gateway timeout after 5ms");
    expect(errMessage).not.toContain("already sent to the gateway");
    expect(errMessage).not.toContain("outcome is unknown");
  });
});
