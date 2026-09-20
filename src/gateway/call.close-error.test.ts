// The close raise shares the onClose handler with the wrapper deadline: both must
// report an unknown outcome once the request has been dispatched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { captureEnv, deleteTestEnvValue } from "../test-utils/env.js";
import {
  callGateway,
  type CallGatewayCliOptions,
  formatGatewayTransportErrorJson,
} from "./call.js";
import type { GatewayClientOptions } from "./client.js";
import { waitForFast } from "./client.test-support.js";

const fixture = vi.hoisted(() => ({
  clientOptions: null as GatewayClientOptions | null,
  closeOnStart: false,
  requested: [] as string[],
  identity: {
    deviceId: "close-error-test-device",
    publicKeyPem: "test-public-key",
    privateKeyPem: "test-private-key",
  } satisfies DeviceIdentity,
}));

vi.mock("../infra/device-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-identity.js")>()),
  loadOrCreateDeviceIdentity: () => fixture.identity,
  loadDeviceIdentityIfPresent: () => fixture.identity,
}));

vi.mock("./client.js", () => ({
  prepareGatewayClientDeviceAuth: async () => {},
  isGatewayConnectAssemblyError: () => false,
  GatewayClient: class {
    constructor(private readonly options: GatewayClientOptions) {
      fixture.clientOptions = options;
    }
    // A dispatched request never settles here; the close is what rejects the call.
    request = async (method: string) => {
      fixture.requested.push(method);
      return await createDeferred<unknown>().promise;
    };
    start() {
      if (fixture.closeOnStart) {
        this.options.onClose?.(1006, "");
        return;
      }
      this.options.onHelloOk?.({
        type: "hello-ok",
        protocol: PROTOCOL_VERSION,
        server: { version: "test", connId: "close-error-connection" },
        features: { capabilities: [], methods: ["health"], events: [] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
      } satisfies HelloOk);
    }
    stop() {}
    async stopAndWait() {}
  },
}));

vi.mock("../../packages/gateway-client/src/event-loop-ready.js", () => ({
  waitForEventLoopReady: async () => ({
    ready: true,
    elapsedMs: 0,
    maxDriftMs: 0,
    checks: 1,
    aborted: false,
  }),
}));

const authEnvKeys = ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"];
let envSnapshot: ReturnType<typeof captureEnv>;

beforeEach(() => {
  envSnapshot = captureEnv(authEnvKeys);
  for (const key of authEnvKeys) {
    deleteTestEnvValue(key);
  }
  fixture.clientOptions = null;
  fixture.closeOnStart = false;
  fixture.requested = [];
});

afterEach(() => {
  envSnapshot.restore();
});

const localConnection = {
  config: { gateway: { mode: "local", auth: { mode: "token" } } },
  url: "ws://127.0.0.1:18789",
  token: "local-token",
} satisfies Partial<CallGatewayCliOptions>;

describe("gateway close after dispatch", () => {
  it.each([
    { dispatched: false, label: "before dispatch" },
    { dispatched: true, label: "after dispatch" },
  ])("scopes 1006 outcome guidance to dispatch ($label)", async ({ dispatched }) => {
    fixture.closeOnStart = !dispatched;

    const rejection = callGateway({ ...localConnection, method: "health" }).catch(
      (caught: unknown) => caught,
    );
    if (dispatched) {
      await waitForFast(() => expect(fixture.requested).toEqual(["health"]));
      fixture.clientOptions?.onClose?.(1006, "");
    }
    const error = await rejection;

    expect(error).toMatchObject({ name: "GatewayTransportError", kind: "closed", code: 1006 });
    const message = (error as Error).message;
    expect(message).toContain(
      "gateway closed (1006 abnormal closure (no close frame)): no close reason",
    );
    expect(message.includes("outcome is unknown")).toBe(dispatched);
    expect(message.includes("Verify the current state")).toBe(dispatched);
    // The handshake-phase causes and their bare retry advice only fit a close that
    // arrives before the request was sent.
    expect(message.includes("(retry; check network and gateway load)")).toBe(!dispatched);
    expect(message.includes("Gateway not yet ready to accept connections")).toBe(!dispatched);
    expect(message.includes("TLS mismatch")).toBe(!dispatched);
    expect(message).toContain(
      "- Gateway process stopped or became unreachable (confirm it is still running)",
    );
    expect(formatGatewayTransportErrorJson(error)?.error.message).toBe(
      "gateway closed (1006 abnormal closure (no close frame)): no close reason",
    );
  });
});
