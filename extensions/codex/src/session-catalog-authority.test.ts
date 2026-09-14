import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  commandRpcMocks,
  pinnedConnectionMocks,
  createCodexSessionCatalogControlFactory,
  fs,
  path,
  idleThread,
  type OpenClawConfig,
} from "./session-catalog.test-helpers.js";

const auth = vi.hoisted(() => ({ prepare: vi.fn(), assertCurrent: vi.fn() }));
vi.mock("./session-catalog-auth.js", () => ({
  prepareCodexCatalogClientOptions: auth.prepare,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  auth.assertCurrent.mockReset();
  auth.prepare.mockReset().mockImplementation(async (options) => ({
    ...options,
    assertCurrent: auth.assertCurrent,
  }));
});

async function fixture() {
  const root = tempDirs.make("catalog-authority-");
  const agentDir = path.join(root, "alpha");
  const native = path.join(root, "native");
  await fs.mkdir(path.join(agentDir, "codex-home"), { recursive: true });
  await fs.mkdir(native);
  let config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      list: [
        { id: "alpha", agentDir },
        { id: "beta", agentDir: path.join(root, "beta") },
      ],
    },
  };
  const factory = createCodexSessionCatalogControlFactory({
    config,
    env: { CODEX_HOME: native, OPENCLAW_STATE_DIR: root },
    getRuntimeConfig: () => config,
    getPluginConfig: () => ({}),
  });
  const source = factory.homesForAgent("beta").find((home) => home.sourceAgentDir === agentDir)!;
  expect(source).toBeDefined();
  commandRpcMocks.codexControlRequest.mockImplementation(
    async (_plugin, _method, _params, options) => {
      options.assertCurrent?.();
      return { thread: idleThread() };
    },
  );
  pinnedConnectionMocks.request.mockImplementation(async (options) => {
    options.assertCurrent?.();
    return { thread: idleThread() };
  });
  return {
    control: factory.forRequest("beta", source),
    revoke: () => {
      config = {
        agents: {
          ownership: "explicit",
          list: [{ id: "beta", agentDir: path.join(root, "beta") }],
        },
      };
    },
  };
}

describe("catalog request live authority", () => {
  it.each([false, true])(
    "rejects revocation during auth preparation, pinned=%s",
    async (pinned) => {
      const f = await fixture();
      auth.prepare.mockImplementationOnce(async (options) => {
        f.revoke();
        return { ...options, assertCurrent: auth.assertCurrent };
      });
      const operation = pinned
        ? f.control.withPinnedConnection((control) => control.readThread("thread"))
        : f.control.readThread("thread");
      await expect(operation).rejects.toThrow("source ownership changed");
      expect(pinnedConnectionMocks.getClient).not.toHaveBeenCalled();
      expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
    },
  );

  it("rejects revocation during lease acquisition and releases the lease", async () => {
    const f = await fixture();
    pinnedConnectionMocks.getClient.mockImplementationOnce(async (options) => {
      options.assertCurrent();
      f.revoke();
      return pinnedConnectionMocks.client;
    });
    const run = vi.fn();
    await expect(f.control.withPinnedConnection(run)).rejects.toThrow("source ownership changed");
    expect(run).not.toHaveBeenCalled();
    expect(pinnedConnectionMocks.releaseClient).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "forwards authority to the physical write boundary, pinned=%s",
    async (pinned) => {
      const f = await fixture();
      const written = vi.fn();
      const physicalWrite = (options: { assertCurrent?: () => void }) => {
        f.revoke();
        options.assertCurrent?.();
        written();
      };
      pinnedConnectionMocks.request.mockImplementation(async (options) => physicalWrite(options));
      commandRpcMocks.codexControlRequest.mockImplementation(
        async (_plugin, _method, _params, options) => physicalWrite(options),
      );
      const operation = pinned
        ? f.control.withPinnedConnection((control) => control.archiveThread("thread"))
        : f.control.archiveThread("thread");
      await expect(operation).rejects.toThrow("source ownership changed");
      expect(written).not.toHaveBeenCalled();
    },
  );

  it("rechecks membership on pinned reads, archives, and nested entry", async () => {
    const f = await fixture();
    await f.control.withPinnedConnection(async (pinned) => {
      await pinned.readThread("thread");
      f.revoke();
      await expect(pinned.readThread("thread")).rejects.toThrow("source ownership changed");
      await expect(pinned.archiveThread("thread")).rejects.toThrow("source ownership changed");
      await expect(pinned.withPinnedConnection(async () => undefined)).rejects.toThrow(
        "source ownership changed",
      );
    });
    expect(pinnedConnectionMocks.request).toHaveBeenCalledTimes(1);
    expect(pinnedConnectionMocks.releaseClient).toHaveBeenCalledTimes(1);
  });

  it("retains credential and caller guards at pinned request boundaries", async () => {
    const f = await fixture();
    await f.control.withPinnedConnection(async (pinned) => {
      const caller = vi.fn(() => {
        throw new Error("caller revoked");
      });
      await expect(pinned.archiveThread("thread", caller)).rejects.toThrow("caller revoked");
      expect(caller).toHaveBeenCalled();
      auth.assertCurrent.mockImplementation(() => {
        throw new Error("credentials revoked");
      });
      await expect(pinned.readThread("thread")).rejects.toThrow("credentials revoked");
    });
    expect(pinnedConnectionMocks.request).not.toHaveBeenCalled();
  });
});
