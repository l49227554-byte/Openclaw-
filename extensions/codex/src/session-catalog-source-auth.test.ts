import { saveAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeCodexAppServerStartOptions } from "./app-server/auth-bridge.js";
import {
  commandRpcMocks,
  pinnedConnectionMocks,
  createCodexSessionCatalogControlFactory,
  fs,
  os,
  path,
  tempDirs,
  idleThread,
  buildCodexAppServerConnectionFingerprint,
  type OpenClawConfig,
} from "./session-catalog.test-helpers.js";

const auth = vi.hoisted(() => ({
  stores: new Map<string, AuthProfileStore>(),
  readStore: vi.fn(),
  useRealStore: false,
}));
vi.mock("./app-server/auth-profile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app-server/auth-profile.js")>();
  return {
    ...actual,
    resolveCodexAppServerAuthProfileStore: (params: {
      agentDir?: string;
      authProfileStore?: AuthProfileStore;
    }) => {
      if (auth.useRealStore) {
        return actual.resolveCodexAppServerAuthProfileStore(params);
      }
      if (params.authProfileStore) {
        return params.authProfileStore;
      }
      auth.readStore(params.agentDir);
      return auth.stores.get(params.agentDir ?? "") ?? { version: 1, profiles: {} };
    },
  };
});

beforeEach(() => {
  auth.stores.clear();
  auth.readStore.mockClear();
  auth.useRealStore = false;
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "catalog-source-auth-")));
  tempDirs.push(root);
  const dirs = Object.fromEntries(["alpha", "beta"].map((id) => [id, path.join(root, id)]));
  const native = path.join(root, "native");
  const arbitrary = path.join(root, "arbitrary");
  vi.stubEnv("HOME", root);
  vi.stubEnv("CODEX_HOME", native);
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("CODEX_API_KEY", "");
  const homes = [
    native,
    arbitrary,
    ...Object.values(dirs).map((dir) => path.join(dir, "codex-home")),
  ];
  for (const home of homes) {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "auth.json"), "synthetic-stale-native-auth\n");
  }
  for (const [id, dir] of Object.entries(dirs)) {
    auth.stores.set(dir, {
      version: 1,
      profiles: {
        [`openai:${id}`]: { type: "api_key", provider: "openai", key: `synthetic-${id}` },
      },
    });
  }
  let config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      list: Object.entries(dirs).map(([id, agentDir]) => ({ id, agentDir })),
    },
  };
  const factory = createCodexSessionCatalogControlFactory({
    config,
    env: { CODEX_HOME: native, OPENCLAW_STATE_DIR: root },
    getRuntimeConfig: () => config,
    getPluginConfig: () => ({ sessionCatalog: { homes: [arbitrary] } }),
  });
  commandRpcMocks.codexControlRequest.mockResolvedValue({ thread: idleThread() });
  pinnedConnectionMocks.request.mockResolvedValue({ thread: idleThread() });
  return {
    root,
    dirs,
    native,
    arbitrary,
    homes,
    factory,
    setConfig: (next: OpenClawConfig) => {
      config = next;
    },
  };
}

describe("managed catalog source authentication", () => {
  it.each([false, true])("uses real source policy with inherited auth=%s", async (inherited) => {
    const f = await fixture();
    auth.useRealStore = true;
    const store = (key: string): AuthProfileStore => ({
      version: 1,
      profiles: { "openai:catalog": { type: "api_key", provider: "openai", key } },
    });
    const saveOptions = {
      filterExternalAuthProfiles: false,
      sharedStoreWrite: true,
      syncExternalCli: false,
    };
    saveAuthProfileStore(store("synthetic-shared"), undefined, saveOptions);
    saveAuthProfileStore(store("synthetic-route"), f.dirs.beta, saveOptions);
    saveAuthProfileStore(
      inherited ? { version: 1, profiles: {} } : store("synthetic-source"),
      f.dirs.alpha,
      saveOptions,
    );
    const source = f.factory
      .homesForAgent("beta")
      .find((home) => home.sourceAgentDir === f.dirs.alpha)!;
    await f.factory.forRequest("beta", source).readThread("source-thread");
    expect(commandRpcMocks.codexControlRequest.mock.calls.at(-1)?.[3].preparedAuth).toEqual({
      kind: "api-key",
      apiKey: inherited ? "synthetic-shared" : "synthetic-source",
    });
    for (const home of f.homes) {
      expect(await fs.readFile(path.join(home, "auth.json"), "utf8")).toBe(
        "synthetic-stale-native-auth\n",
      );
    }
  });
  it.each(["direct", "pinned"] as const)(
    "uses source alpha, never route beta, through %s requests",
    async (mode) => {
      const f = await fixture();
      const source = f.factory
        .homesForAgent("beta")
        .find((home) => home.sourceAgentDir === f.dirs.alpha)!;
      expect(source.agentDir).toBe(f.dirs.beta);
      const fingerprint = buildCodexAppServerConnectionFingerprint(
        source.appServer,
        source.agentDir,
      );
      const control = f.factory.forUpstream("beta", fingerprint)!;
      expect(control).toBeDefined();
      if (mode === "pinned") {
        await control.withPinnedConnection(async (pinned) => {
          expect(pinned.forkContext?.agentDir).toBe(f.dirs.beta);
          expect(pinned.connectionFingerprint).toBe(fingerprint);
          await pinned.readThread("source-thread", false);
        });
      } else {
        await control.readThread("source-thread", false);
      }
      const options =
        mode === "pinned"
          ? pinnedConnectionMocks.getClient.mock.calls.at(-1)?.[0]
          : commandRpcMocks.codexControlRequest.mock.calls.at(-1)?.[3];
      expect(options).toMatchObject({
        agentDir: f.dirs.alpha,
        preparedAuth: { kind: "api-key", apiKey: "synthetic-alpha" },
        startOptions: {
          homeScope: "agent",
          env: { CODEX_HOME: path.join(f.dirs.alpha!, "codex-home") },
        },
      });
      expect(options.authProfileId).toBeUndefined();
      expect(auth.readStore.mock.calls.length).toBeGreaterThan(0);
      expect(auth.readStore.mock.calls.every(([dir]) => dir === f.dirs.alpha)).toBe(true);
      const bridged = await bridgeCodexAppServerStartOptions(options);
      expect(bridged.args).toContain('cli_auth_credentials_store="ephemeral"');
      expect(bridged.env?.CODEX_HOME).toBe(path.join(f.dirs.alpha!, "codex-home"));
      for (const home of f.homes) {
        expect(await fs.readFile(path.join(home, "auth.json"), "utf8")).toBe(
          "synthetic-stale-native-auth\n",
        );
      }
    },
  );

  it.each(["direct", "pinned"] as const)(
    "preserves native-only source access through %s requests",
    async (mode) => {
      const f = await fixture();
      const source = f.factory
        .homesForAgent("beta")
        .find((home) => home.sourceAgentDir === f.dirs.alpha)!;
      auth.stores.delete(f.dirs.alpha!);
      const control = f.factory.forRequest("beta", source);
      await (mode === "pinned"
        ? control.withPinnedConnection((pinned) => pinned.readThread("source-thread"))
        : control.readThread("source-thread"));
      const options =
        mode === "pinned"
          ? pinnedConnectionMocks.getClient.mock.calls.at(-1)?.[0]
          : commandRpcMocks.codexControlRequest.mock.calls.at(-1)?.[3];
      expect(options.authProfileId).toBeNull();
      expect(options.preparedAuth).toBeUndefined();
      expect(options.startOptions.env.CODEX_HOME).toBe(path.join(f.dirs.alpha!, "codex-home"));
      expect(auth.readStore.mock.calls.length).toBeGreaterThan(0);
      expect(auth.readStore.mock.calls.every(([dir]) => dir === f.dirs.alpha)).toBe(true);
    },
  );

  it.each(["remove", "replace"] as const)(
    "rejects %s of prepared credentials before I/O",
    async (change) => {
      const f = await fixture();
      const source = f.factory
        .homesForAgent("beta")
        .find((home) => home.sourceAgentDir === f.dirs.alpha)!;
      await f.factory.forRequest("beta", source).readThread("source-thread");
      const options = commandRpcMocks.codexControlRequest.mock.calls.at(-1)?.[3];
      expect(options.assertCurrent).toBeTypeOf("function");
      options.assertCurrent();
      if (change === "remove") {
        auth.stores.delete(f.dirs.alpha!);
      } else {
        auth.stores.set(f.dirs.alpha!, {
          version: 1,
          profiles: {
            "openai:alpha": { type: "api_key", provider: "openai", key: "synthetic-replacement" },
          },
        });
      }
      expect(() => options.assertCurrent()).toThrow("authentication changed");
    },
  );

  it("rejects a credential replaced during preparation", async () => {
    const f = await fixture();
    const source = f.factory
      .homesForAgent("beta")
      .find((home) => home.sourceAgentDir === f.dirs.alpha)!;
    auth.readStore.mockImplementationOnce(() => {
      queueMicrotask(() => {
        auth.stores.get(f.dirs.alpha!)!.profiles["openai:alpha"] = {
          type: "api_key",
          provider: "openai",
          key: "synthetic-replacement",
        };
      });
    });
    await expect(f.factory.forRequest("beta", source).readThread("thread")).rejects.toThrow(
      "authentication changed",
    );
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
  });

  it("invalidates native preparation when a managed profile is selected", async () => {
    const f = await fixture();
    const source = f.factory
      .homesForAgent("beta")
      .find((home) => home.sourceAgentDir === f.dirs.alpha)!;
    const saved = auth.stores.get(f.dirs.alpha!)!;
    auth.stores.delete(f.dirs.alpha!);
    await f.factory.forRequest("beta", source).readThread("thread");
    const options = commandRpcMocks.codexControlRequest.mock.calls.at(-1)?.[3];
    auth.stores.set(f.dirs.alpha!, saved);
    expect(() => options.assertCurrent()).toThrow("authentication changed");
  });

  it("keeps native and arbitrary homes native without reading managed credentials", async () => {
    const f = await fixture();
    for (const source of f.factory.homesForAgent("beta").filter((home) => !home.sourceAgentDir)) {
      const control = f.factory.forRequest("beta", source);
      await control.readThread("native-thread");
      await control.withPinnedConnection((pinned) => pinned.readThread("native-thread"));
    }
    expect(auth.readStore).not.toHaveBeenCalled();
    for (const call of commandRpcMocks.codexControlRequest.mock.calls) {
      expect(call[3]).toMatchObject({ authProfileId: null, agentDir: f.dirs.beta });
      expect(call[3].preparedAuth).toBeUndefined();
    }
  });

  it("prepares the current source identity again instead of caching credentials", async () => {
    const f = await fixture();
    const source = f.factory
      .homesForAgent("beta")
      .find((home) => home.sourceAgentDir === f.dirs.alpha)!;
    const control = f.factory.forRequest("beta", source);
    await control.readThread("source-thread");
    auth.stores.set(f.dirs.alpha!, {
      version: 1,
      profiles: {
        "openai:alpha": { type: "api_key", provider: "openai", key: "synthetic-alpha-new" },
      },
    });
    await control.readThread("source-thread");
    expect(commandRpcMocks.codexControlRequest.mock.calls.at(-1)?.[3].preparedAuth).toEqual({
      kind: "api-key",
      apiKey: "synthetic-alpha-new",
    });
  });

  it("rejects a removed source owner before preparing credentials", async () => {
    const f = await fixture();
    const source = f.factory
      .homesForAgent("beta")
      .find((home) => home.sourceAgentDir === f.dirs.alpha)!;
    const control = f.factory.forRequest("beta", source);
    f.setConfig({
      agents: { ownership: "explicit", list: [{ id: "beta", agentDir: f.dirs.beta }] },
    });
    await expect(control.readThread("source-thread")).rejects.toThrow("ownership changed");
    expect(auth.readStore).not.toHaveBeenCalled();
  });

  it("keeps archive actions bound to the source credential owner", async () => {
    const f = await fixture();
    const source = f.factory
      .homesForAgent("beta")
      .find((home) => home.sourceAgentDir === f.dirs.alpha)!;
    await f.factory.forRequest("beta", source).archiveThread("alpha-thread");
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledWith(
      expect.anything(),
      "thread/archive",
      { threadId: "alpha-thread" },
      expect.objectContaining({
        agentDir: f.dirs.alpha,
        preparedAuth: { kind: "api-key", apiKey: "synthetic-alpha" },
      }),
    );
    expect(source.agentDir).toBe(f.dirs.beta);
  });

  it("does not promote native aliases or ambiguous managed aliases", async () => {
    const f = await fixture();
    const aliasAgentDir = path.join(f.root, "alias");
    await fs.mkdir(aliasAgentDir);
    await fs.symlink(f.native, path.join(aliasAgentDir, "codex-home"), "dir");
    f.setConfig({
      agents: {
        ownership: "explicit",
        list: [
          { id: "beta", agentDir: f.dirs.beta },
          { id: "alpha", agentDir: f.dirs.alpha },
          { id: "duplicate", agentDir: f.dirs.alpha },
          { id: "alias", agentDir: aliasAgentDir },
        ],
      },
    });
    const homes = f.factory.homesForAgent("beta");
    expect(homes.filter((home) => home.sourceAgentDir).map((home) => home.sourceAgentDir)).toEqual([
      f.dirs.beta,
    ]);
    expect(homes[0]?.sourceAgentDir).toBeUndefined();
  });
});
