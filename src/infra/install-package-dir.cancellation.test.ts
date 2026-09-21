// Regressions for startup-cancellation during staged package-dir installs.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as rootLogger from "../logger.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { pathExists } from "./fs-safe.js";
import { installPackageDir } from "./install-package-dir.js";
import {
  createExistingInstallFixture,
  listMatchingDirs,
} from "./install-package-dir.test-support.js";

vi.mock("./fs-safe.js", async () => {
  const actual = await vi.importActual<typeof import("./fs-safe.js")>("./fs-safe.js");
  return {
    ...actual,
    pathExists: vi.fn(actual.pathExists),
  };
});

async function expectMissingPath(target: string) {
  await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("installPackageDir startup cancellation", () => {
  const fixtureRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-install-package-dir-cancel-",
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixtureRootTracker.cleanup();
  });

  it("does not publish staged files after validation observes cancellation", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("cancelled-install");
    const sourceDir = path.join(fixtureRoot, "source");
    const installBaseDir = path.join(fixtureRoot, "plugins");
    const targetDir = path.join(installBaseDir, "demo");
    const controller = new AbortController();
    const reason = new Error("Gateway startup interrupted by SIGTERM");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "marker.txt"), "new");

    await expect(
      installPackageDir({
        sourceDir,
        targetDir,
        mode: "install",
        timeoutMs: 1_000,
        copyErrorPrefix: "failed to copy plugin",
        hasDeps: false,
        depsLogMessage: "",
        signal: controller.signal,
        afterInstall: async () => {
          controller.abort(reason);
          return { ok: true };
        },
      }),
    ).rejects.toBe(reason);
    await expectMissingPath(targetDir);
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-stage-"),
    ).resolves.toHaveLength(0);
  });

  it("cleans the staged directory when cancellation lands during the update target check", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("cancelled-update-target-check");
    const { installBaseDir, sourceDir, targetDir } =
      await createExistingInstallFixture(fixtureRoot);
    const controller = new AbortController();
    const reason = new Error("Gateway startup interrupted by SIGTERM");

    vi.mocked(pathExists).mockImplementationOnce(async () => {
      controller.abort(reason);
      return true;
    });

    await expect(
      installPackageDir({
        sourceDir,
        targetDir,
        mode: "update",
        timeoutMs: 1_000,
        copyErrorPrefix: "failed to copy plugin",
        hasDeps: false,
        depsLogMessage: "",
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    await expect(fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).resolves.toBe("old");
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-stage-"),
    ).resolves.toHaveLength(0);
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-backups"),
    ).resolves.toHaveLength(0);
  });

  it("does not publish staged files when cancellation lands during final publication preparation", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("cancelled-final-publication");
    const sourceDir = path.join(fixtureRoot, "source");
    const installBaseDir = path.join(fixtureRoot, "plugins");
    const targetDir = path.join(installBaseDir, "demo");
    const controller = new AbortController();
    const reason = new Error("Gateway startup interrupted by SIGTERM");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "marker.txt"), "new");

    await expect(
      installPackageDir({
        sourceDir,
        targetDir,
        mode: "install",
        timeoutMs: 1_000,
        copyErrorPrefix: "failed to copy plugin",
        hasDeps: false,
        depsLogMessage: "",
        signal: controller.signal,
        // The guard runs synchronously before the publication rename; an abort
        // observed there must refuse the move instead of publishing the stage.
        beforePersistentApply() {
          controller.abort(reason);
        },
      }),
    ).rejects.toBe(reason);
    await expectMissingPath(targetDir);
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-stage-"),
    ).resolves.toHaveLength(0);
  });
  it("reports a retained backup when startup cancellation cannot restore the original install", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("cancelled-failed-restore");
    const { installBaseDir, sourceDir, targetDir } =
      await createExistingInstallFixture(fixtureRoot);
    const controller = new AbortController();
    const reason = new Error("Gateway startup interrupted by SIGTERM");
    const restoreError = new Error("restore rename denied");
    const errors = vi.spyOn(rootLogger, "logError").mockImplementation(() => {});
    // Doctor may buffer its optional installer logger, then discard the cancelled result.
    const bufferedWarning = vi.fn();
    const rename = fs.rename.bind(fs);
    let backupDir = "";
    vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      if (controller.signal.aborted) {
        throw restoreError;
      }
      return await rename(...args);
    });
    await expect(
      installPackageDir({
        sourceDir,
        targetDir,
        mode: "update",
        timeoutMs: 1_000,
        copyErrorPrefix: "failed to copy plugin",
        hasDeps: false,
        depsLogMessage: "",
        signal: controller.signal,
        logger: { warn: bufferedWarning },
        afterBackup: async (directory) => {
          backupDir = directory;
          controller.abort(reason);
          return { ok: true };
        },
      }),
    ).rejects.toBe(reason);
    await expectMissingPath(targetDir);
    expect(backupDir).not.toBe("");
    await expect(fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).resolves.toBe("old");
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("could not restore existing install"),
    );
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(restoreError.message));
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining(`backup recovery path: ${backupDir}`),
    );
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-stage-"),
    ).resolves.toHaveLength(0);
  });
});
