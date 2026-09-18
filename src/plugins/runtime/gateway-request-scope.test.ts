// Gateway request scope tests cover request-local plugin runtime context propagation.
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../runtime.js";
import type { PluginRuntimeGatewayRequestScope } from "./gateway-request-scope.test-fixtures.js";

const TEST_SCOPE: PluginRuntimeGatewayRequestScope = {
  context: {} as PluginRuntimeGatewayRequestScope["context"],
  isWebchatConnect: (() => false) as PluginRuntimeGatewayRequestScope["isWebchatConnect"],
};

describe("gateway request scope", () => {
  afterEach(() => {
    vi.doUnmock("../current-plugin-metadata-snapshot.js");
    vi.resetModules();
    resetPluginRuntimeStateForTest();
  });
  async function importGatewayRequestScopeModule() {
    return await import("./gateway-request-scope.js");
  }

  async function withTestGatewayScope<T>(
    run: (runtimeScope: Awaited<ReturnType<typeof importGatewayRequestScopeModule>>) => Promise<T>,
  ) {
    const runtimeScope = await importGatewayRequestScopeModule();
    return await runtimeScope.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, async () => {
      return await run(runtimeScope);
    });
  }

  function expectGatewayScope(
    runtimeScope: Awaited<ReturnType<typeof importGatewayRequestScopeModule>>,
    expected: PluginRuntimeGatewayRequestScope,
  ) {
    expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toEqual(expected);
  }

  async function expectPluginIdScopedGatewayScope(pluginId: string) {
    await withPluginIdScope(pluginId, async (runtimeScope) => {
      expectGatewayScope(runtimeScope, {
        ...TEST_SCOPE,
        pluginId,
      });
    });
  }

  async function withPluginIdScope(
    pluginId: string,
    run: (
      runtimeScope: Awaited<ReturnType<typeof importGatewayRequestScopeModule>>,
    ) => Promise<void>,
  ) {
    await withTestGatewayScope(async (runtimeScope) => {
      await runtimeScope.withPluginRuntimePluginIdScope(pluginId, async () => {
        await run(runtimeScope);
      });
    });
  }

  it("does not import the plugin metadata control plane", async () => {
    vi.resetModules();
    vi.doMock("../current-plugin-metadata-snapshot.js", () => {
      throw new Error("gateway request scope must remain lightweight");
    });

    const runtimeScope = await importGatewayRequestScopeModule();

    expect(runtimeScope.withPluginRuntimeGatewayRequestScope).toBeTypeOf("function");
  });

  it("reuses AsyncLocalStorage across reloaded module instances", async () => {
    const first = await importGatewayRequestScopeModule();

    await first.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, async () => {
      vi.resetModules();
      const second = await importGatewayRequestScopeModule();
      expectGatewayScope(second, TEST_SCOPE);
    });
  });

  it("preserves host-issued Gateway resolver bindings across reloaded modules", async () => {
    const first = await importGatewayRequestScopeModule();
    const owner = {};
    const resolver = vi.fn(() => TEST_SCOPE.context!);
    first.bindGatewayContextResolver(owner, resolver);

    vi.resetModules();
    const second = await importGatewayRequestScopeModule();

    expect(second.getGatewayContextResolver(owner)).toBe(resolver);
    expect(second.getSharedGatewayContextResolver([owner])?.()).toBe(TEST_SCOPE.context);
    expect(second.getGatewayContextResolver({})).toBeUndefined();

    second.clearGatewayContextResolver(owner);
    expect(first.getGatewayContextResolver(owner)).toBeUndefined();
  });

  it("attaches plugin id to the active scope", async () => {
    await expectPluginIdScopedGatewayScope("voice-call");
  });

  describe("request lease", () => {
    const client = {} as NonNullable<PluginRuntimeGatewayRequestScope["client"]>;

    it("is live only while the awaited request callback runs", async () => {
      const runtimeScope = await importGatewayRequestScopeModule();
      let insideRequest: boolean | undefined;
      let retained: (() => boolean) | undefined;
      const result = await runtimeScope.withPluginRuntimeGatewayRequestScope(
        { ...TEST_SCOPE, client },
        async () => {
          await Promise.resolve();
          insideRequest = runtimeScope.hasLivePluginRuntimeRequestAuthority();
          const scope = runtimeScope.getPluginRuntimeGatewayRequestScope();
          retained = () => runtimeScope.hasLivePluginRuntimeRequestAuthority(scope);
          return "done";
        },
      );
      expect(result).toBe("done");
      expect(insideRequest).toBe(true);
      // The retained scope object and any continuation armed inside the request lose the
      // lease once the callback settles, even though the Gateway itself is still alive.
      expect(retained?.()).toBe(false);
      expect(runtimeScope.hasLivePluginRuntimeRequestAuthority()).toBe(false);
    });

    it("expires for a continuation that outlives the request callback", async () => {
      const runtimeScope = await importGatewayRequestScopeModule();
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let later!: Promise<boolean>;
      await runtimeScope.withPluginRuntimeGatewayRequestScope(
        { ...TEST_SCOPE, client },
        async () => {
          later = (async () => {
            await barrier;
            return runtimeScope.hasLivePluginRuntimeRequestAuthority();
          })();
        },
      );
      release();
      await expect(later).resolves.toBe(false);
    });

    it("releases synchronously for plain returns and throws", async () => {
      const runtimeScope = await importGatewayRequestScopeModule();
      let scope: PluginRuntimeGatewayRequestScope | undefined;
      const value = runtimeScope.withPluginRuntimeGatewayRequestScope(
        { ...TEST_SCOPE, client },
        () => {
          scope = runtimeScope.getPluginRuntimeGatewayRequestScope();
          expect(runtimeScope.hasLivePluginRuntimeRequestAuthority()).toBe(true);
          return 42;
        },
      );
      expect(value).toBe(42);
      expect(runtimeScope.hasLivePluginRuntimeRequestAuthority(scope)).toBe(false);
      expect(() =>
        runtimeScope.withPluginRuntimeGatewayRequestScope({ ...TEST_SCOPE, client }, () => {
          scope = runtimeScope.getPluginRuntimeGatewayRequestScope();
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(runtimeScope.hasLivePluginRuntimeRequestAuthority(scope)).toBe(false);
      await expect(
        runtimeScope.withPluginRuntimeGatewayRequestScope({ ...TEST_SCOPE, client }, async () => {
          scope = runtimeScope.getPluginRuntimeGatewayRequestScope();
          throw new Error("async boom");
        }),
      ).rejects.toThrow("async boom");
      expect(runtimeScope.hasLivePluginRuntimeRequestAuthority(scope)).toBe(false);
    });

    it("shares a private native owner across source, dist, and reloaded scope modules", async () => {
      const sourceRequire = createRequire(import.meta.url);
      const distRequire = createRequire(new URL("../../../dist/index.js", import.meta.url));
      const sourceOwner = sourceRequire("#plugin-request-authority");
      expect(distRequire("#plugin-request-authority")).toBe(sourceOwner);
      expect(Object.isFrozen(sourceOwner)).toBe(true);
      expect(
        Reflect.get(globalThis, Symbol.for("openclaw.pluginRuntimeRequestLeases")),
      ).toBeUndefined();
      const first = await importGatewayRequestScopeModule();
      let second: typeof first | undefined;
      let nested: PluginRuntimeGatewayRequestScope | undefined;
      await first.withPluginRuntimeGatewayRequestScope({ ...TEST_SCOPE, client }, async () => {
        vi.resetModules();
        second = await importGatewayRequestScopeModule();
        expect(second.hasLivePluginRuntimeRequestAuthority()).toBe(true);
        second.withPluginRuntimePluginIdScope("nested-plugin", () => {
          nested = second!.getPluginRuntimeGatewayRequestScope();
          expect(first.hasLivePluginRuntimeRequestAuthority()).toBe(true);
          expect(second!.hasLivePluginRuntimeRequestAuthority()).toBe(true);
        });
      });
      expect(first.hasLivePluginRuntimeRequestAuthority(nested)).toBe(false);
      expect(second!.hasLivePluginRuntimeRequestAuthority(nested)).toBe(false);
      expect(second!.hasLivePluginRuntimeRequestAuthority({ ...nested!, client })).toBe(false);
    });

    it.each(["getter", "proxy"])("releases when then inspection throws (%s)", async (kind) => {
      const runtimeScope = await importGatewayRequestScopeModule();
      let scope: PluginRuntimeGatewayRequestScope | undefined;
      const fail = () => {
        throw new Error("then inspection failed");
      };
      const result =
        kind === "getter"
          ? Object.defineProperty({}, "then", { get: fail }) // eslint-disable-line unicorn/no-thenable -- Deliberate throwing getter tests request cleanup.
          : new Proxy({}, { has: fail, get: fail });
      expect(() =>
        runtimeScope.withPluginRuntimeGatewayRequestScope({ ...TEST_SCOPE, client }, () => {
          scope = runtimeScope.getPluginRuntimeGatewayRequestScope();
          return result;
        }),
      ).toThrow("then inspection failed");
      expect(runtimeScope.hasLivePluginRuntimeRequestAuthority(scope)).toBe(false);
    });

    it("requires the host-admitted client and ignores client mutation by plugin code", async () => {
      const runtimeScope = await importGatewayRequestScopeModule();
      await runtimeScope.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, async () => {
        expect(runtimeScope.hasLivePluginRuntimeRequestAuthority()).toBe(false);
        const scope = runtimeScope.getPluginRuntimeGatewayRequestScope();
        // The SDK exposes the scope object; writing a client onto it mints no lease.
        scope!.client = client;
        expect(runtimeScope.hasLivePluginRuntimeRequestAuthority()).toBe(false);
        expect(runtimeScope.hasLivePluginRuntimeRequestAuthority(scope)).toBe(false);
      });
      // A fabricated scope object that was never admitted by the host carries no lease.
      expect(runtimeScope.hasLivePluginRuntimeRequestAuthority({ ...TEST_SCOPE, client })).toBe(
        false,
      );
    });

    it("follows the request into nested plugin and registry scopes but not detached work", async () => {
      const runtimeScope = await importGatewayRequestScopeModule();
      const registry = createEmptyPluginRegistry();
      await runtimeScope.withPluginRuntimeGatewayRequestScope(
        { ...TEST_SCOPE, client },
        async () => {
          await runtimeScope.withPluginRuntimePluginIdScope("voice-call", async () => {
            expect(runtimeScope.hasLivePluginRuntimeRequestAuthority()).toBe(true);
            await runtimeScope.withPluginRuntimeRegistryScope(registry, async () => {
              expect(runtimeScope.hasLivePluginRuntimeRequestAuthority()).toBe(true);
            });
          });
          runtimeScope.withPluginRuntimeGatewayContextResolver(undefined, () => {
            expect(runtimeScope.hasLivePluginRuntimeRequestAuthority()).toBe(true);
          });
          runtimeScope.withPluginRuntimeGatewayContextResolver(
            undefined,
            () => {
              expect(runtimeScope.hasLivePluginRuntimeRequestAuthority()).toBe(false);
            },
            { inheritRequestScope: false },
          );
        },
      );
    });
  });

  it("resolves the owned registry while preserving gateway request facts", async () => {
    const activeRegistry = createEmptyPluginRegistry();
    const requestRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(activeRegistry);

    await withTestGatewayScope(async (runtimeScope) => {
      await runtimeScope.withPluginRuntimeRegistryScope(requestRegistry, async () => {
        expect(requireActivePluginRegistry()).toBe(requestRegistry);
        expectGatewayScope(runtimeScope, { ...TEST_SCOPE, pluginRegistry: requestRegistry });
      });
      expect(requireActivePluginRegistry()).toBe(activeRegistry);
    });
  });
});
