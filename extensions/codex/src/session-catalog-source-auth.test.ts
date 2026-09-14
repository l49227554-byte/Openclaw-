import { createHash } from "node:crypto";
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
  it.each(["direct", "pinned"] as const)(
    "rejects an expired configured managed profile through %s",
    async (mode) => {
      const f = await fixture();
      const source = f.factory
        .homesForAgent("beta")
        .find((home) => home.sourceAgentDir === f.dirs.alpha)!;
      auth.stores.set(f.dirs.alpha!, {
        version: 1,
        order: { openai: ["openai:expired"] },
        profiles: {
          "openai:expired": {
            type: "token",
            provider: "openai",
            token: "synthetic-expired",
            expires: Date.now() - 1000,
          },
        },
      });
      const control = f.factory.forRequest("beta", source);
      await expect(
        mode === "pinned"
          ? control.withPinnedConnection((pinned) => pinned.readThread("source-thread"))
          : control.readThread("source-thread"),
      ).rejects.toThrow("no usable managed OpenAI authentication");
      expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
      expect(pinnedConnectionMocks.getClient).not.toHaveBeenCalled();
    },
  );

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

  it.each(["direct", "pinned"] as const)(
    "keeps %s refresh authority valid across OAuth rotation",
    async (mode) => {
      const f = await fixture();
      auth.stores.set(f.dirs.alpha!, {
        version: 1,
        profiles: {
          "openai:alpha": {
            type: "oauth",
            provider: "openai",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() + 3600000,
            accountId: "synthetic-account",
            email: "source@example.invalid",
          },
        },
      });
      const source = f.factory
        .homesForAgent("beta")
        .find((home) => home.sourceAgentDir === f.dirs.alpha)!;
      const control = f.factory.forRequest("beta", source);
      if (mode === "pinned") {
        await control.withPinnedConnection((pinned) => pinned.readThread("thread"));
      } else {
        await control.readThread("thread");
      }
      const options =
        mode === "pinned"
          ? pinnedConnectionMocks.getClient.mock.calls.at(-1)?.[0]
          : commandRpcMocks.codexControlRequest.mock.calls.at(-1)?.[3];
      expect(options.assertAuthSourceCurrent).toBeTypeOf("function");
      const credential = auth.stores.get(f.dirs.alpha!)!.profiles["openai:alpha"]!;
      expect(credential.type).toBe("oauth");
      if (credential.type !== "oauth") {
        throw new Error("expected OAuth fixture");
      }
      credential.access = "synthetic-rotated-access";
      credential.refresh = "synthetic-rotated-refresh";
      credential.expires += 3600000;
      expect(() => options.assertAuthSourceCurrent()).not.toThrow();
      expect(() => options.assertCurrent()).toThrow("authentication changed");
      const marker = (kind: "access" | "refresh") => {
        const digest = createHash("sha256")
          .update(
            JSON.stringify([
              "openclaw.oauth-refresh-generation",
              1,
              "openai:alpha",
              "openai",
              kind,
              credential[kind],
            ]),
          )
          .digest("hex");
        return `openclaw-oauth-refresh-fence:v1:${"a".repeat(32)}:${kind}:${digest}`;
      };
      const pending = {
        ...credential,
        access: marker("access"),
        refresh: marker("refresh"),
        expires: 1,
      };
      const store = auth.stores.get(f.dirs.alpha!)!;
      store.profiles["openai:alpha"] = pending;
      expect(() => options.assertAuthSourceCurrent()).not.toThrow();
      expect(() => options.assertCurrent()).toThrow("authentication changed");
      const previousOrder = store.order;
      store.order = { openai: [] };
      expect(() => options.assertAuthSourceCurrent()).toThrow("authentication changed");
      store.order = previousOrder;
      expect(() => options.assertAuthSourceCurrent()).not.toThrow();
      store.profiles["openai:alpha"] = { ...pending, accountId: "synthetic-other-account" };
      expect(() => options.assertAuthSourceCurrent()).toThrow("authentication changed");
      store.profiles["openai:alpha"] = {
        ...pending,
        access: pending.access.replace(":access:", ":failed:access:"),
        refresh: pending.refresh.replace(":refresh:", ":failed:refresh:"),
      };
      expect(() => options.assertAuthSourceCurrent()).toThrow("authentication changed");
      store.profiles["openai:alpha"] = credential;
      credential.accountId = "synthetic-other-account";
      expect(() => options.assertAuthSourceCurrent()).toThrow("authentication changed");
    },
  );

  it.each([false, true])(
    "rejects token-claim workspace replacement with explicit account=%s",
    async (explicit) => {
      const f = await fixture();
      const token = (accountId: string, nonce: string) =>
        [
          Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
          Buffer.from(
            JSON.stringify({
              "https://api.openai.com/auth": { chatgpt_account_id: accountId },
              nonce,
            }),
          ).toString("base64url"),
          "synthetic-signature",
        ].join(".");
      const credential = {
        type: "oauth" as const,
        provider: "openai",
        access: token("synthetic-account", "first"),
        refresh: "synthetic-refresh",
        expires: Date.now() + 3600000,
        email: "source@example.invalid",
        ...(explicit ? { accountId: "synthetic-account" } : {}),
      };
      auth.stores.set(f.dirs.alpha!, { version: 1, profiles: { "openai:alpha": credential } });
      const source = f.factory
        .homesForAgent("beta")
        .find((home) => home.sourceAgentDir === f.dirs.alpha)!;
      await f.factory.forRequest("beta", source).readThread("thread");
      const options = commandRpcMocks.codexControlRequest.mock.calls.at(-1)?.[3];
      credential.access = token("synthetic-account", "rotated");
      expect(() => options.assertAuthSourceCurrent()).not.toThrow();
      credential.access = token("synthetic-other-account", "replacement");
      expect(() => options.assertAuthSourceCurrent()).toThrow("authentication changed");
    },
  );

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
