import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  requestDeferredPluginInstall,
  resolvePluginInstallTransaction,
  settlePluginInstallTransactions,
} from "./install-transaction.js";
import { createBundleInstallFixtureFactory } from "./test-helpers/install-fixtures.js";

const withExtractedArchiveRootMock = vi.fn();
const afterPackagePublication = vi.fn();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const setupBundleInstallFixture = createBundleInstallFixtureFactory(() =>
  tempDirs.make("openclaw-bundle-cancellation-"),
);

afterEach(() => {
  afterPackagePublication.mockReset();
});

vi.mock("./install.runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("./install.runtime.js")>("./install.runtime.js");
  return {
    ...actual,
    resolveArchiveSourcePath: async () => ({ ok: true, path: "/fake/plugin.tgz" }),
    withExtractedArchiveRoot: (...args: unknown[]) => withExtractedArchiveRootMock(...args),
    installPackageDir: async (...args: Parameters<typeof actual.installPackageDir>) => {
      const result = await actual.installPackageDir(...args);
      if (result.ok) {
        await afterPackagePublication();
      }
      return result;
    },
  };
});

const { installPluginFromArchive, installPluginFromPath } = await import("./install-package.js");

describe("plugin package startup cancellation", () => {
  it("forwards the abort signal into the extracted package install", async () => {
    const controller = new AbortController();
    const reason = new Error("Gateway startup interrupted by SIGTERM");
    // Cancellation lands inside the extraction window: the extracted package
    // install starts there and is the layer that observes the abort.
    withExtractedArchiveRootMock.mockImplementationOnce(
      async (params: { onExtracted: (rootDir: string) => Promise<unknown> }) => {
        controller.abort(reason);
        return await params.onExtracted("/fake/extracted");
      },
    );

    const failure = await installPluginFromArchive({
      archivePath: "/fake/plugin.tgz",
      signal: controller.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    // Without the forwarded signal the extracted package install keeps running
    // and the archive flow fails later on the fake source tree instead.
    expect(failure).toBe(reason);
  });

  it("retains the published bundle transaction for rollback when cancellation arrives after install", async () => {
    const { pluginDir, extensionsDir } = setupBundleInstallFixture({
      bundleFormat: "codex",
      name: "Cancellation Bundle",
    });
    const targetDir = path.join(extensionsDir, "cancellation-bundle");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "marker.txt"), "original bundle");
    await fs.writeFile(path.join(pluginDir, "marker.txt"), "replacement bundle");
    const controller = new AbortController();
    const reason = new Error("Gateway startup interrupted after bundle publication");
    // Publish through the real directory owner before interrupting its caller.
    afterPackagePublication.mockImplementationOnce(() => controller.abort(reason));

    const outcome = await installPluginFromPath(
      requestDeferredPluginInstall({
        path: pluginDir,
        extensionsDir,
        mode: "update",
        signal: controller.signal,
      }),
    ).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );

    expect(controller.signal.reason).toBe(reason);
    expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe(
      "replacement bundle",
    );
    expect(outcome).toHaveProperty("result.ok", true);
    if (!("result" in outcome)) {
      throw outcome.error;
    }
    const transaction = resolvePluginInstallTransaction(outcome.result);
    if (!transaction) {
      throw new Error("expected the published bundle's rollback transaction");
    }
    await settlePluginInstallTransactions([transaction], "rollback");

    expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("original bundle");
    expect(await fs.readdir(path.join(extensionsDir, ".openclaw-install-backups"))).toEqual([]);
  });
});
